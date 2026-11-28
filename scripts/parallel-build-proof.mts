// Parallel-build proof tests — stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/parallel-build-proof.mts
// Proves:
//  1. splitPlanIntoParts parses a structured PARTS: section into disjoint parts.
//  2. A single-file plan / "PARTS: none" -> null (serial path, zero extra calls).
//  3. No PARTS: section -> the file-list fallback groups files into parts.
//  4. assignDistinctKeys gives one DISTINCT key per part, round-robin across
//     providers (gemini -> groq -> openrouter -> gemini ...).
//  5. runParallelCoders really overlaps in time (all workers alive at once),
//     writes each part's files correctly, never shares a key between workers,
//     and reports a preview URL for the HTML part.
//  6. A worker that fails only fails its own files; the other parts still merge.
//  7. Router key pinning: routeChatCompletion tries the pinned key FIRST.
//  8. parseCoderOutput accepts only assigned files and ignores truncated blocks.
//  9. Cancel before launch -> nothing written, cancelled reported.
// 10. tryRunParallelBuild runs once per turn (second call for the same session
//     is a no-op) and merges via the real hook path.
import assert from 'node:assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// --- Fake keys (obviously not real) ---------------------------------------
process.env.GEMINI_API_KEYS = 'AIzaFAKEGEMINIONE,AIzaFAKEGEMINITWO,AIzaFAKEGEMINITHREE';
process.env.GROQ_API_KEYS = 'gsk_FAKEGROQONE,gsk_FAKEGROQTWO';
process.env.OPENROUTER_API_KEYS = 'sk-or-v1-FAKEORONE,sk-or-v1-FAKEORTWO';
delete process.env.OPENROUTER_API_KEY;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;
delete process.env.PARALLEL_CODERS_MAX; // default cap (4) for these tests

// --- Temp workspace (coders write under <tmp>/projects) --------------------
const tmp = await mkdtemp(path.join(tmpdir(), 'parallel-proof-'));
process.chdir(tmp);

// --- Global fetch stub (catalog discovery + provider calls) -----------------
const calls: Array<{ url: string; model?: string; key?: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const auth = String(init?.headers?.Authorization || init?.headers?.authorization || '');
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  calls.push({ url, model: body?.model, key });
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')) {
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-4-hydrogen', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://openrouter.ai/api/v1/models') {
    return new Response(JSON.stringify({ data: [
      { id: 'google/gemma-4-31b-it:free', context_length: 100000 },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  // Provider chat completions: 200 only for the pinned fake Gemini key TWO,
  // 429 for everything else (proves the pin is tried first).
  if (url.includes('generativelanguage.googleapis.com/v1beta/openai/chat/completions')) {
    if (key === 'AIzaFAKEGEMINITWO') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok from pinned key' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'Quota exceeded', code: 429 } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' } });
  }
  if (url.includes('api.groq.com') || url.includes('openrouter.ai/api/v1/chat/completions')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('Unexpected fetch: ' + url);
}) as any;

const { splitPlanIntoParts, assignDistinctKeys, runParallelCoders, parseCoderOutput, tryRunParallelBuild, clearParallelBuildForSession } =
  await import('../server/agent/parallelBuild.ts');
const { listRouterKeys } = await import('../server/router/keys.ts');
const { routeChatCompletion } = await import('../server/router/index.ts');
const { refreshCatalog } = await import('../server/agent/modelChain.ts');

await refreshCatalog();

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) => {
  const r = (fn as () => any)();
  if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log(`  PASS ${name}`); });
  passed++;
  console.log(`  PASS ${name}`);
};

const PLAN_3_PARTS = [
  'ARCHITECTURE: A three-page shop. Shared design: indigo theme, system font.',
  'FILE OPERATIONS: create projects/index.html, projects/shop.html, projects/styles.css, projects/app.js.',
  'PARTS:',
  '1. Structure — files: projects/index.html, projects/shop.html',
  '2. Styling — files: projects/styles.css',
  '3. Logic — files: projects/app.js',
].join('\n');

// 1-3. Plan splitting --------------------------------------------------------
ok('structured PARTS: parses into 3 disjoint parts', () => {
  const parts = splitPlanIntoParts(PLAN_3_PARTS);
  assert.ok(parts && parts.length === 3, `expected 3 parts, got ${parts?.length}`);
  const allFiles = parts.flatMap((p: any) => p.files);
  assert.equal(allFiles.length, new Set(allFiles).size, 'files must be disjoint across parts');
  assert.deepEqual(parts[0].files, ['projects/index.html', 'projects/shop.html']);
  assert.deepEqual(parts[1].files, ['projects/styles.css']);
  assert.deepEqual(parts[2].files, ['projects/app.js']);
});
ok('single-file plan -> null (serial path, no extra calls)', () => {
  assert.equal(splitPlanIntoParts('ARCHITECTURE: one page.\nFILE OPERATIONS: create projects/index.html.\nPARTS:\n1. Page — files: projects/index.html'), null);
});
ok('"PARTS: none" -> null (planner says it cannot be split)', () => {
  assert.equal(splitPlanIntoParts('ARCHITECTURE: one page.\nFILE OPERATIONS: create projects/index.html.\nPARTS: none'), null);
});
ok('no PARTS: section -> file-list fallback groups files', () => {
  const parts = splitPlanIntoParts('ARCHITECTURE: shop.\nFILE OPERATIONS: create projects/index.html, projects/styles.css, projects/app.js.');
  assert.ok(parts && parts.length >= 2, `expected >=2 parts, got ${parts?.length}`);
  const allFiles = parts.flatMap((p: any) => p.files);
  assert.equal(allFiles.length, 3);
  assert.equal(new Set(allFiles).size, 3);
});

// 4. Distinct-key assignment --------------------------------------------------
const assigned = await assignDistinctKeys(4);
ok('assignDistinctKeys(4) -> 4 distinct keys, round-robin across providers', () => {
  assert.equal(assigned.length, 4, `expected 4 keys, got ${assigned.length}`);
  assert.equal(new Set(assigned.map((k: any) => k.id)).size, 4, 'key ids must be distinct');
  assert.deepEqual(assigned.map((k: any) => k.provider), ['gemini', 'groq', 'openrouter', 'gemini']);
  console.log('  assigned keys:', assigned.map((k: any) => `${k.provider}:${k.id}`).join(' | '));
});

// 5-6. Parallel run with stub coders ------------------------------------------
const execCtx: any = { sessionId: 'parallel-proof', onAgentStep: () => {} };
const parts = splitPlanIntoParts(PLAN_3_PARTS)!;
const keys = await assignDistinctKeys(parts.length);

const coderCalls: Array<{ pinKeyId?: string; startedAt: number; endedAt: number }> = [];
const stubCoder = async (o: any) => {
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
  const endedAt = Date.now();
  coderCalls.push({ pinKeyId: o.pinKeyId, startedAt, endedAt });
  const files = [...o.user.matchAll(/^- (projects\/\S+)$/gm)].map((m: any) => m[1]);
  const text = files.map((f: string) =>
    f.endsWith('.html')
      ? `--- FILE: ${f} ---\n<!DOCTYPE html><html><head><title>T</title></head><body>MARKER-${f}</body></html>\n--- END FILE ---`
      : `--- FILE: ${f} ---\n/* MARKER-${f} */\n--- END FILE ---`).join('\n');
  return { text, model: 'stub-model' };
};

const result = await runParallelCoders({
  task: 'Build a three-page shop',
  architecture: 'Shared design: indigo theme.',
  parts,
  keys,
  sessionId: 'parallel-proof',
  execCtx,
  coderFn: stubCoder,
});
ok('all 3 workers overlap in time (not serial)', () => {
  const maxStart = Math.max(...coderCalls.map((c) => c.startedAt));
  const minEnd = Math.min(...coderCalls.map((c) => c.endedAt));
  console.log(`  coder windows: ${coderCalls.map((c) => `${c.endedAt - c.startedAt}ms`).join(', ')} | wall ${result.endedAt - result.startedAt}ms`);
  assert.ok(maxStart < minEnd, `expected overlap: latest start ${maxStart} must be before earliest end ${minEnd}`);
  const sumDurations = coderCalls.reduce((a, c) => a + (c.endedAt - c.startedAt), 0);
  assert.ok((result.endedAt - result.startedAt) < sumDurations, 'wall time must be less than the sum of worker times');
});
ok('no two workers share a key', () => {
  const usedKeys = coderCalls.map((c) => c.pinKeyId);
  assert.equal(new Set(usedKeys).size, usedKeys.length, `keys must be distinct, got ${usedKeys.join(', ')}`);
  // coderCalls record COMPLETION order (random sleeps) — compare as sets.
  assert.deepEqual([...result.parts.map((p: any) => p.keyId)].sort(), [...usedKeys].sort());
});
ok('merge writes every part file with the right content + preview URL', async () => {
  assert.deepEqual([...result.writtenFiles].sort(), ['projects/app.js', 'projects/index.html', 'projects/shop.html', 'projects/styles.css']);
  assert.deepEqual(result.failedFiles, []);
  for (const f of ['projects/index.html', 'projects/shop.html', 'projects/styles.css', 'projects/app.js']) {
    const content = await readFile(path.join(tmp, f), 'utf-8');
    assert.ok(content.includes(`MARKER-${f}`), `${f} must contain its marker`);
  }
  assert.ok(result.previewUrl, 'expected a preview URL from the HTML write');
  console.log('  previewUrl:', result.previewUrl);
});

// 6. A failing worker only fails its own files --------------------------------
coderCalls.length = 0;
const failingCoder = async (o: any) => {
  if (o.user.includes('projects/styles.css')) throw new Error('stub coder boom');
  return stubCoder(o);
};
const result2 = await runParallelCoders({
  task: 'Build a three-page shop',
  architecture: 'Shared design: indigo theme.',
  parts,
  keys,
  sessionId: 'parallel-proof-2',
  execCtx: { sessionId: 'parallel-proof-2', onAgentStep: () => {} },
  coderFn: failingCoder,
});
ok('failing worker -> only its files fail, other parts still merge', () => {
  assert.deepEqual(result2.failedFiles, ['projects/styles.css']);
  assert.ok(result2.writtenFiles.includes('projects/index.html'));
  assert.ok(result2.writtenFiles.includes('projects/app.js'));
  assert.equal(result2.parts.find((p: any) => p.title.startsWith('Styling'))?.status, 'failed');
});

// 7. Router key pinning ---------------------------------------------------------
const geminiKeys = await listRouterKeys('gemini');
const pinned = geminiKeys.find((k: any) => k.key === 'AIzaFAKEGEMINITWO');
assert.ok(pinned, 'expected the second fake Gemini key in the pool');
calls.length = 0;
const routed = await routeChatCompletion({
  model: 'auto:smart',
  messages: [{ role: 'user', content: 'build a landing page' }],
  stream: false,
  pinKeyId: pinned.id,
});
const routedText = await routed.response.text();
ok('routeChatCompletion tries the pinned key FIRST', () => {
  assert.ok(calls.length > 0, 'expected provider calls');
  assert.equal(calls[0].key, 'AIzaFAKEGEMINITWO', `first call must use the pinned key, got ${calls[0].key}`);
  assert.ok(routedText.includes('pinned key'), 'pinned key must answer the call');
  console.log('  provider calls:', calls.map((c) => `${c.model}@${(c.key || '').slice(0, 14)}`).join(' | '));
});

// 8. Coder-output parsing --------------------------------------------------------
ok('parseCoderOutput accepts only assigned files, ignores truncated blocks', () => {
  const parsed = parseCoderOutput(
    '--- FILE: projects/index.html ---\nFULL\n--- END FILE ---\n--- FILE: projects/evil.js ---\nNOPE\n--- END FILE ---\n--- FILE: projects/app.js ---\nTRUNCATED (no end marker)',
    ['projects/index.html', 'projects/app.js'],
  );
  assert.equal(parsed.size, 1);
  assert.equal(parsed.get('projects/index.html'), 'FULL');
});

// 9. Cancel before launch ---------------------------------------------------------
const cancelCalls: any[] = [];
const cancelResult = await runParallelCoders({
  task: 'Build a three-page shop',
  architecture: 'x',
  parts,
  keys,
  sessionId: 'parallel-proof-cancel',
  execCtx: { sessionId: 'parallel-proof-cancel', onAgentStep: () => {} },
  isCancelled: () => true,
  coderFn: async (o: any) => { cancelCalls.push(o); return { text: '', model: 'stub' }; },
});
ok('cancelled run writes nothing and reports cancelled', () => {
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.ran, false);
  assert.equal(cancelCalls.length, 0, 'no worker may be launched after a stop');
  assert.deepEqual(cancelResult.writtenFiles, []);
});

// 10. tryRunParallelBuild: once per turn -------------------------------------------
const hookResult = await tryRunParallelBuild({
  planText: PLAN_3_PARTS,
  task: 'Build a three-page shop',
  sessionId: 'parallel-proof-hook',
  execCtx: { sessionId: 'parallel-proof-hook', onAgentStep: () => {} },
  coderFn: stubCoder,
});
ok('tryRunParallelBuild merges via the hook path', async () => {
  assert.ok(hookResult && hookResult.ran, 'expected the hook to run the parallel build');
  assert.deepEqual([...(hookResult?.writtenFiles || [])].sort(), ['projects/app.js', 'projects/index.html', 'projects/shop.html', 'projects/styles.css']);
});
const hookAgain = await tryRunParallelBuild({
  planText: PLAN_3_PARTS,
  task: 'Build a three-page shop',
  sessionId: 'parallel-proof-hook',
  execCtx: { sessionId: 'parallel-proof-hook', onAgentStep: () => {} },
  coderFn: stubCoder,
});
ok('second call in the same turn is a no-op (once-per-turn guard)', () => {
  assert.equal(hookAgain, null);
});
clearParallelBuildForSession('parallel-proof-hook');

globalThis.fetch = realFetch;
console.log(`\nparallel-build-proof: ${passed} passed`);
