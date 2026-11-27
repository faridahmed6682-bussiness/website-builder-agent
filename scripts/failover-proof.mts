// Failover proof tests — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/failover-proof.mts
// Proves:
//  1. Live Gemini discovery feeds the catalog (fetchGeminiModels + refreshCatalog),
//     paid models excluded at ingestion, CONFIGURED ids are fallback-only.
//  2. Router with Gemini+Groq-only keys reaches Gemini (no cap exhaustion on
//     keyless OpenRouter :free skips).
//  3. Router 429 on the first Gemini model with ALL keys -> drops to the next
//     Gemini model, same-model key rotation first (both keys tried on model 1).
//  4. nextAfterFailure returns the entry AFTER the failed model, not the first
//     same-tier entry.
//  5. recordRouterKeyFailure honours an HTTP-date Retry-After (parseRetryAfter,
//     not parseInt -> NaN -> 65 s floor).
//  6. Key-test HTML guard: parseJsonSafe returns null for an HTML body and the
//     Bengali SERVER_WAKING_MESSAGE is shown instead of the raw SyntaxError.
//  7. normalizeModelName accepts a live-discovered Gemini id.
import assert from 'node:assert';

// --- Fake keys (obviously not real) ---------------------------------------
process.env.GEMINI_API_KEYS = 'AIzaFAKEKEYONE,AIzaFAKEKEYTWO';
process.env.GROQ_API_KEYS = 'gsk_FAKEGROQKEY';
// No OpenRouter keys on purpose: the old 5-attempt cap died skipping :free models.
delete process.env.OPENROUTER_API_KEYS;
delete process.env.OPENROUTER_API_KEY;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;

const calls: Array<{ url: string; model?: string; key?: string }> = [];

// --- Global fetch stub -----------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const auth = String(init?.headers?.Authorization || init?.headers?.authorization || '');
  const key = auth.replace(/^Bearer /, '');
  calls.push({ url, model: body?.model, key: key.slice(0, 12) });

  // Catalog discovery
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')) {
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-4-hydrogen', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://openrouter.ai/api/v1/models') {
    return new Response(JSON.stringify({ data: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', context_length: 100000 },
      { id: 'google/gemma-4-31b-it:free', context_length: 100000 },
      { id: 'baidu/ernie-5.5-flash:free', context_length: 100000 },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Provider chat completions (router path): 429 for gemini-4-hydrogen on
  // BOTH fake keys, success on gemini-3.8-flash.
  if (url.includes('generativelanguage.googleapis.com/v1beta/openai/chat/completions')) {
    if (body?.model === 'gemini-4-hydrogen') {
      return new Response(JSON.stringify({ error: { message: 'Quota exceeded for quota metric generate_requests_per_minute_per_project', code: 429 } }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok from ' + body?.model } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('api.groq.com')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'groq ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('openrouter.ai/api/v1/chat/completions')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'or ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('Unexpected fetch: ' + url);
}) as any;

const { refreshCatalog, getChainForTask, nextAfterFailure, isModelExcluded } =
  await import('../server/agent/modelChain.ts');
const { routeChatCompletion } = await import('../server/router/index.ts');
const { recordRouterKeyFailure, selectRouterKey, routerKeyStatus } =
  await import('../server/router/keys.ts');
const { parseJsonSafe, SERVER_WAKING_MESSAGE } =
  await import('../src/components/SecretsModal.tsx');
const { normalizeModelName, shouldDropGeminiModel } = await import('../server/agent/apiOrchestrator.ts');

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`); };

// 1. Live Gemini discovery --------------------------------------------------
const counts = await refreshCatalog();
console.log('catalog counts:', JSON.stringify(counts));
ok('live Gemini fetch ingested (geminiLive=3, argon/1.5/embedding dropped)', () => {
  assert.equal(counts.geminiLive, 3);
  assert.equal(isModelExcluded('gemini-4-argon'), true);
});
ok('catalog has live Gemini ids, no argon, no ernie', () => {
  const coding = getChainForTask('coding', 'gemini', 12).map((e) => e.model);
  console.log('  gemini coding chain:', coding.join(', '));
  assert.ok(coding.includes('gemini-4-hydrogen'));
  assert.ok(coding.includes('gemini-3.8-flash'));
  assert.ok(!coding.some((m) => /argon|ernie|1\.5/.test(m)));
  assert.equal(coding[0], 'gemini-4-hydrogen'); // Hydrogen still first (score 95)
});
ok('CONFIGURED ids are fallback-only when live fetch succeeds', () => {
  // gemini-2.5-pro is in CONFIGURED_FREE_MODELS but NOT in the live stub list.
  const ids = getChainForTask('coding', 'gemini', 20).map((e) => e.model);
  assert.ok(!ids.includes('gemini-2.5-pro'), '2.5-pro must not seed when live list exists');
});

// 4. nextAfterFailure --------------------------------------------------------
ok('nextAfterFailure returns the entry AFTER the failed model', () => {
  const chain = getChainForTask('coding', undefined, 12);
  const first = chain[0].model;
  const next = nextAfterFailure(first, 'coding');
  assert.ok(next && next.model !== first, `next after ${first} must differ, got ${next?.model}`);
  const idx = chain.findIndex((e) => e.model === first);
  const nextIdx = chain.findIndex((e) => e.model === next!.model);
  assert.ok(nextIdx > idx, `next (${nextIdx}) must come after failed (${idx}) in chain`);
});

// 2+3. Router failover -------------------------------------------------------
calls.length = 0;
const result = await routeChatCompletion({
  model: 'auto:smart',
  messages: [{ role: 'user', content: 'build a landing page' }],
  stream: false,
});
const servedText = await result.response.text();
console.log('  served model:', result.model, '| provider:', result.provider, '| key:', result.keyName);
console.log('  provider calls:', calls.filter((c) => c.model).map((c) => `${c.model}@${c.key}`).join(' | '));
ok('router reaches Gemini despite keyless OpenRouter :free models in catalog', () => {
  assert.equal(result.provider, 'gemini');
  assert.ok(!result.model.endsWith(':free'));
});
ok('all keys tried on model 1 before dropping to model 2 (same-model rotation)', () => {
  const hydrogenCalls = calls.filter((c) => c.model === 'gemini-4-hydrogen');
  assert.equal(hydrogenCalls.length, 2, `expected 2 keys tried on hydrogen, got ${hydrogenCalls.length}`);
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.ok(servedText.includes('gemini-3.8-flash'));
});

// 5. HTTP-date Retry-After ----------------------------------------------------
const key = await selectRouterKey('gemini');
assert.ok(key, 'expected a gemini key');
const httpDate = new Date(Date.now() + 300_000).toUTCString(); // 300 s out
await recordRouterKeyFailure(key.id, 429, httpDate, 'rate limit');
const status = (await routerKeyStatus()).find((k) => k.id === key!.id)!;
console.log('  key cooldown retryInSec for HTTP-date Retry-After (300s):', status.retryInSec);
ok('HTTP-date Retry-After honoured (~300 s, not the 65 s floor)', () => {
  assert.ok(status.retryInSec! > 200 && status.retryInSec! <= 300,
    `expected ~300 s, got ${status.retryInSec}`);
});

// 6. Key-test HTML guard -------------------------------------------------------
{
  const html = new Response('<!DOCTYPE html><html><body>waking up</body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await parseJsonSafe(html), null);
  const json = new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await parseJsonSafe(json), { success: true });
  passed++; console.log('  PASS parseJsonSafe returns null for an HTML wake-up page');
}
ok('Bengali waking message says the key was NOT checked', () => {
  assert.ok(SERVER_WAKING_MESSAGE.includes('এখনো যাচাই হয়নি'));
  assert.ok(!/Unexpected token|DOCTYPE/i.test(SERVER_WAKING_MESSAGE));
});

// 7. normalizeModelName ---------------------------------------------------------
ok('normalizeModelName accepts a live-discovered Gemini id', () => {
  assert.equal(normalizeModelName('gemini', 'gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(normalizeModelName('gemini', 'gemini-4-hydrogen'), 'gemini-4-hydrogen');
});

// 8. Orchestrator all-keys-429 rule -------------------------------------------
ok('shouldDropGeminiModel: false until every key 429s, true once all have', () => {
  const all = new Set(['k1', 'k2', 'k3']);
  assert.equal(shouldDropGeminiModel(new Set(['k1']), all), false);
  assert.equal(shouldDropGeminiModel(new Set(['k1', 'k2']), all), false);
  assert.equal(shouldDropGeminiModel(new Set(['k1', 'k2', 'k3']), all), true);
  assert.equal(shouldDropGeminiModel(new Set(), new Set()), false);
});

globalThis.fetch = realFetch;
console.log(`\nFAILOVER PROOF: ${passed} checks passed, 0 failed.`);
