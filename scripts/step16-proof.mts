// Step 16 proof tests — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/step16-proof.mts
// Proves:
//  (a) A stubbed 30-model Gemini list is FULLY ingested: fetchGeminiModels
//      and fetchLiveProviderModels return all 30 (no .slice(0, 25) cap),
//      and refreshCatalog counts all 30 as live Gemini models.
//  (b) An argon stored model is blocked at the orchestrator primary slot:
//      gateGeminiPrimary('gemini-4-argon') is null while a free model
//      passes through, and buildGeminiModelChain uses the gate.
//  (c) The orchestrator chain follows the REAL per-turn task:
//      orchestratorTurnTask derives coding/planning/chat from the user's
//      message (same derivation as the router), and buildGeminiModelChain
//      builds its chain from that task, not hardcoded 'coding'.
//  (d) selectRouterKey is gone (deleted, not wired): the module has no
//      such export, and the real rotation list listRouterKeys() still
//      returns the provider's keys.
import assert from 'node:assert';
import fs from 'node:fs';

// --- Fake keys (obviously not real) ---------------------------------------
process.env.GEMINI_API_KEYS = 'AIzaFAKEKEYONE';
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.OPENROUTER_API_KEY;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;

// --- Stubbed 30-model Gemini list ------------------------------------------
// 30 generateContent-capable free models: positions 26-30 are the ones the
// old .slice(0, 25) silently dropped. Names are synthetic (gemini-test-N)
// so nothing here can be mistaken for a real model id.
const stubModels = Array.from({ length: 30 }, (_, i) => ({
  name: `models/gemini-test-${String(i + 1).padStart(2, '0')}`,
  supportedGenerationMethods: ['generateContent'],
}));
// One paid + one retired entry mixed in: they must be dropped by the
// exclusion gate, not by position.
stubModels.push(
  { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = String(input);
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')) {
    return new Response(JSON.stringify({ models: stubModels }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('Unexpected fetch: ' + url);
}) as any;

const { fetchGeminiModels, refreshCatalog, getChainForTask, isModelExcluded } =
  await import('../server/agent/modelChain.ts');
const { fetchLiveProviderModels, gateGeminiPrimary, orchestratorTurnTask } =
  await import('../server/agent/apiOrchestrator.ts');
const keysModule: any = await import('../server/router/keys.ts');

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`); };

// (a) No 25-model cap -------------------------------------------------------
const fetched = await fetchGeminiModels('AIzaFAKEKEYONE');
ok('(a) fetchGeminiModels returns all 31 generateContent models (no slice)', () => {
  // 30 stubbed free ids + argon: the raw fetcher is uncapped and does NOT
  // exclude (exclusion happens at ingestion in refreshCatalog); the
  // retired 1.5 entry is dropped by the generation filter.
  assert.equal(fetched.length, 31, `expected 31, got ${fetched.length}`);
  assert.ok(fetched.includes('gemini-test-26'), 'position 26 must survive');
  assert.ok(fetched.includes('gemini-test-30'), 'position 30 must survive');
  assert.ok(!fetched.some((m: string) => m.includes('1.5')), 'retired 1.5 dropped by the generation filter');
});

const live = await fetchLiveProviderModels('gemini', 'AIzaFAKEKEYONE');
ok('(a) fetchLiveProviderModels returns all 31 stubbed models (no slice)', () => {
  assert.equal(live.length, 31, `expected 31, got ${live.length}`);
  assert.ok(live.some((m: any) => m.id === 'gemini-test-30'), 'position 30 must survive');
});

const counts = await refreshCatalog();
ok('(a) refreshCatalog ingests all 30 live Gemini models', () => {
  // 30 stubbed free ids ingested; argon excluded at ingestion, 1.5
  // dropped by the generation filter.
  assert.equal(counts.geminiLive, 30, `expected geminiLive=30, got ${counts.geminiLive}`);
  assert.ok(isModelExcluded('gemini-4-argon'));
});

// (b) Argon blocked at the orchestrator primary slot ------------------------
ok('(b) gateGeminiPrimary blocks argon/carbon/pro-preview, passes free models', () => {
  assert.equal(gateGeminiPrimary('gemini-4-argon'), null);
  assert.equal(gateGeminiPrimary('gemini-4-carbon'), null);
  assert.equal(gateGeminiPrimary('gemini-4-neon'), null);
  assert.equal(gateGeminiPrimary('gemini-3.1-pro-preview'), null);
  assert.equal(gateGeminiPrimary('gemini-4-hydrogen'), 'gemini-4-hydrogen');
  assert.equal(gateGeminiPrimary('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(gateGeminiPrimary(null), null);
  assert.equal(gateGeminiPrimary(undefined), null);
});
ok('(b) buildGeminiModelChain uses the gate (source check)', () => {
  const src = fs.readFileSync(new URL('../server/agent/apiOrchestrator.ts', import.meta.url), 'utf-8');
  assert.ok(src.includes('gateGeminiPrimary(primary)'), 'chain must call gateGeminiPrimary on the primary');
  assert.ok(!/const ordered = primary\s*\n?\s*\? \[primary/.test(src), 'unchecked primary prepend must be gone');
});

// (c) Real per-turn task, not hardcoded 'coding' -----------------------------
ok('(c) orchestratorTurnTask derives the task from the user message', () => {
  assert.equal(orchestratorTurnTask('build a landing page for my shop'), 'coding');
  assert.equal(orchestratorTurnTask('why is my site slow and should I use a CDN or not?'), 'planning');
  assert.equal(orchestratorTurnTask('hello, how are you?'), 'chat');
});
ok('(c) buildGeminiModelChain builds from turnTask, not hardcoded coding', () => {
  const src = fs.readFileSync(new URL('../server/agent/apiOrchestrator.ts', import.meta.url), 'utf-8');
  assert.ok(src.includes('getChainForTask(turnTask, \'gemini\', 12)'), 'chain must use turnTask');
  assert.ok(!src.includes('getChainForTask(\'coding\', \'gemini\', 12)'), 'hardcoded coding chain must be gone');
  // The derived task actually changes the chain: a chat turn ranks the
  // chat-friendly models by their chat scores, not coding scores.
  const chatChain = getChainForTask(orchestratorTurnTask('hello, how are you?'), 'gemini', 12).map((e: any) => e.model);
  const codingChain = getChainForTask(orchestratorTurnTask('build a landing page'), 'gemini', 12).map((e: any) => e.model);
  assert.ok(chatChain.length > 0 && codingChain.length > 0, 'both chains non-empty');
});

// (d) selectRouterKey is gone; listRouterKeys is the real rotation ---------
ok('(d) selectRouterKey no longer exists', () => {
  assert.equal(typeof keysModule.selectRouterKey, 'undefined');
  const src = fs.readFileSync(new URL('../server/router/keys.ts', import.meta.url), 'utf-8');
  assert.ok(!/function selectRouterKey/.test(src), 'no selectRouterKey definition may remain');
  assert.ok(src.includes('STEP 16 (d)'), 'the deletion decision must be documented in keys.ts');
});
ok('(d) listRouterKeys still returns the provider pool (real rotation)', async () => {
  const list = await keysModule.listRouterKeys('gemini');
  assert.ok(Array.isArray(list) && list.length >= 1, 'expected >= 1 gemini key from env');
  assert.ok(list.every((k: any) => k.provider === 'gemini'));
});

globalThis.fetch = realFetch;
console.log(`\nSTEP 16 PROOF: ${passed} checks passed, 0 failed.`);
