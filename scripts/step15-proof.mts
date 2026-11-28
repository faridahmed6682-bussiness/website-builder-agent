// Step 15 proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/step15-proof.mts
// Proves (Step 15, P2):
//  (a) Checkpoint resumes across a key rotation: a Gemini turn that writes
//      a file then 429s mid-turn resumes on the next key from a compact
//      brief (no re-write, text + file list preserved, round budget shared).
//  (b) Real tokens on the streaming path: the router parses the SSE usage
//      chunk (OpenAI + Gemini-native shapes) and records real numbers —
//      never (0, 0); the orchestrator ledger uses provider-reported usage
//      when present, and toolsSchemaTokensEstimate() is wired into the
//      estimate path on both loops.
//  (c) The OpenAI-compatible loop's final (16th) round sends NO tools.
//  (d) The reference scrape is capped at REFERENCE_SCRAPE_MAX_CHARS (6,000).
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// --- Fake keys (obviously not real) / no keys at all ------------------------
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;

// --- Isolated data dir (memory.ts resolves data/ from process.cwd()) --------
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step15-proof-'));
process.chdir(tmpDir);
await fs.mkdir(path.join(tmpDir, 'data', 'chats'), { recursive: true });

// Dynamic imports AFTER chdir, so server modules bind to the temp dir.
const { newTurnUsage } = await import('../server/agent/usage.ts');
const { toolsSchemaTokensEstimate, estimateTokens } = await import('../server/agent/usage.ts');
const { parseSseUsageChunk, meterStreamUsage, routerUsageSummary, estimateTokensFromChars } = await import('../server/router/index.ts');
const { runGeminiAgentLoop, streamOpenAICompatible, newTurnCheckpoint, REFERENCE_SCRAPE_MAX_CHARS } = await import('../server/agent/apiOrchestrator.ts');
const { serverTools, filterCoreTools } = await import('../server/agent/geminiService.ts');

const events: any[] = [];
const sendEvent = (data: any) => { events.push(data); };

// --- (d) Scrape cap ---------------------------------------------------------
assert.strictEqual(REFERENCE_SCRAPE_MAX_CHARS, 6000, `scrape cap should be 6000 chars, got ${REFERENCE_SCRAPE_MAX_CHARS}`);
const orchSrc = await fs.readFile(new URL('../server/agent/apiOrchestrator.ts', import.meta.url), 'utf-8');
assert.ok(orchSrc.includes('pageMarkdown.slice(0, REFERENCE_SCRAPE_MAX_CHARS)'), 'scrape must slice with REFERENCE_SCRAPE_MAX_CHARS');
assert.ok(!orchSrc.includes('slice(0, 14000)'), 'old 14,000-char slice must be gone');
console.log(`(d) reference scrape capped at ${REFERENCE_SCRAPE_MAX_CHARS} chars (~1,200 tokens, was 14,000 / ~2,750)`);

// --- (b) Router: SSE usage parsing ------------------------------------------
assert.deepStrictEqual(
  parseSseUsageChunk({ usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }),
  { promptTokens: 123, completionTokens: 45 }, 'OpenAI usage shape');
assert.deepStrictEqual(
  parseSseUsageChunk({ usageMetadata: { promptTokenCount: 77, candidatesTokenCount: 11 } }),
  { promptTokens: 77, completionTokens: 11 }, 'Gemini-native usageMetadata shape');
assert.strictEqual(parseSseUsageChunk({ choices: [{ delta: { content: 'hi' } }] }), null, 'content chunk has no usage');
assert.strictEqual(parseSseUsageChunk(null), null, 'null chunk has no usage');
console.log('(b) parseSseUsageChunk: OpenAI + Gemini-native shapes OK, no-usage -> null');

// --- (b) Router: metered stream records REAL numbers, never (0, 0) ---------
const sseWithUsage = [
  'data: {"choices":[{"delta":{"content":"Hello "}}]}',
  'data: {"choices":[{"delta":{"content":"world"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":123,"completion_tokens":45}}',
  'data: [DONE]',
  '',
].join('\n');
const metered = meterStreamUsage('probe-model-step15', { model: 'probe-model-step15', messages: [{ role: 'user', content: 'hi' }] } as any,
  new Response(sseWithUsage, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
const relayed = await metered.text();
assert.ok(relayed.includes('Hello '), 'metered stream must pass content through unchanged');
assert.ok(relayed.includes('"prompt_tokens":123'), 'metered stream must pass the usage chunk through unchanged');
let summary = await routerUsageSummary();
let row = summary.byModel.find((m: any) => m.model === 'probe-model-step15');
assert.ok(row, 'metered model must appear in router usage');
assert.strictEqual(row.requests, 1, 'one streamed request recorded');
assert.strictEqual(row.promptTokens, 123, `real prompt tokens recorded, got ${row.promptTokens}`);
assert.strictEqual(row.completionTokens, 45, `real completion tokens recorded, got ${row.completionTokens}`);
console.log(`(b) metered stream with usage chunk: recorded 123 prompt / 45 completion (was 0, 0)`);

// Fallback when the provider sends NO usage chunk: estimates, still not (0, 0).
const sseNoUsage = [
  'data: {"choices":[{"delta":{"content":"hello world"}}]}',
  'data: [DONE]',
  '',
].join('\n');
const metered2 = meterStreamUsage('probe-model-step15-est', { model: 'probe-model-step15-est', messages: [{ role: 'user', content: 'hello there, this is a longer prompt' }] } as any,
  new Response(sseNoUsage, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
await metered2.text();
summary = await routerUsageSummary();
row = summary.byModel.find((m: any) => m.model === 'probe-model-step15-est');
assert.ok(row && row.promptTokens > 0 && row.completionTokens > 0,
  `no-usage fallback must record estimates > 0, got ${JSON.stringify(row)}`);
assert.strictEqual(row.completionTokens, estimateTokensFromChars('hello world'.length), 'completion estimate = streamed chars / 4');
console.log(`(b) metered stream without usage chunk: estimated ${row.promptTokens} prompt / ${row.completionTokens} completion (never 0, 0)`);

// --- (b) toolsSchemaTokensEstimate is wired, not dead ------------------------
const schemaTokens = toolsSchemaTokensEstimate(JSON.stringify(filterCoreTools(serverTools)).length);
assert.ok(schemaTokens > 0, 'schema estimate must be > 0');
assert.strictEqual(schemaTokens, estimateTokens(' '.repeat(JSON.stringify(filterCoreTools(serverTools)).length)),
  'schema estimate must match the chars/4 rule');
assert.ok(orchSrc.includes('toolsSchemaTokensEstimate('), 'orchestrator must call toolsSchemaTokensEstimate');
const schemaUses = (orchSrc.match(/toolsSchemaTokensEstimate\(/g) || []).length;
assert.ok(schemaUses >= 2, `schema estimate must be wired on both loops, found ${schemaUses} call sites`);
const routerSrc = await fs.readFile(new URL('../server/router/index.ts', import.meta.url), 'utf-8');
assert.ok(!/^\s*recordUsage\(model, 0, 0\);/m.test(routerSrc), 'router must no longer record (model, 0, 0)');
console.log(`(b) toolsSchemaTokensEstimate wired on both loops: 86 core tools = ~${schemaTokens} tokens/round`);

// --- (a) Checkpoint: Gemini turn writes a file, 429s, resumes --------------
const checkpoint = newTurnCheckpoint();
const writtenRel = 'projects/proof-checkpoint.html';

let attempt1Rounds = 0;
const fakeChat1 = {
  async sendMessageStream(params: any) {
    const i = attempt1Rounds++;
    if (i === 0) {
      async function* gen() {
        yield {
          text: 'Wrote the hero section.',
          functionCalls: [{ name: 'write_to_file', args: { TargetFile: writtenRel, CodeContent: '<h1>proof</h1>' } }],
        };
      }
      return gen();
    }
    throw new Error('429 quota exceeded for this key');
  },
};
const fakeClient1: any = { chats: { create: () => fakeChat1 } };

let threw429 = false;
try {
  await runGeminiAgentLoop(fakeClient1, 'fake-model-for-proof', 'general',
    { sessionId: 'proof-session' }, [], 'build a test landing page', 'build a test landing page',
    sendEvent, {}, undefined, true, undefined, checkpoint);
} catch (err: any) {
  threw429 = /429/.test(String(err?.message || ''));
}
assert.ok(threw429, 'attempt 1 must throw the stubbed 429');
assert.strictEqual(checkpoint.roundsCompleted, 2, `checkpoint must count both rounds, got ${checkpoint.roundsCompleted}`);
assert.ok(checkpoint.committedText.includes('Wrote the hero section.'), 'checkpoint must keep text produced before the 429');
assert.ok(checkpoint.didMutateFiles, 'checkpoint must record the file write');
assert.ok(checkpoint.mutatedFiles.includes(writtenRel), `checkpoint file list must include ${writtenRel}, got ${checkpoint.mutatedFiles}`);
assert.ok(checkpoint.geminiHasProgress, 'checkpoint must flag real progress');
const written = await fs.readFile(path.join(tmpDir, writtenRel), 'utf-8');
assert.ok(written.includes('<h1>proof</h1>'), 'attempt 1 must actually have written the file');
// Sentinel: if the resumed attempt re-ran the write, the file would be
// overwritten back to the original content and the sentinel would vanish.
await fs.appendFile(path.join(tmpDir, writtenRel), '\n<!-- SENTINEL-NOT-REWRITTEN -->');

const resumeMessages: any[] = [];
let attempt2Rounds = 0;
const fakeChat2 = {
  async sendMessageStream(params: any) {
    resumeMessages.push(params.message);
    attempt2Rounds++;
    async function* gen() { yield { text: 'Resumed and done.' }; }
    return gen();
  },
};
const fakeClient2: any = { chats: { create: () => fakeChat2 } };
const resumedText = await runGeminiAgentLoop(fakeClient2, 'fake-model-for-proof', 'general',
  { sessionId: 'proof-session' }, [], 'build a test landing page', 'build a test landing page',
  sendEvent, {}, undefined, true, undefined, checkpoint);
assert.strictEqual(attempt2Rounds, 1, 'resumed attempt should finish in one round');
const brief = String(resumeMessages[0] ?? '');
assert.ok(brief.includes('RESUMED AFTER KEY ROTATION'), 'resumed attempt must start with the resume brief');
assert.ok(brief.includes(writtenRel), 'resume brief must name the file already written');
assert.ok(brief.includes('Wrote the hero section.'), 'resume brief must carry the text produced so far');
assert.ok(brief.includes('do NOT redo'), 'resume brief must tell the model not to redo completed work');
assert.ok(resumedText.includes('Wrote the hero section.') && resumedText.includes('Resumed and done.'),
  `resumed turn must keep prior text + new text, got: ${resumedText.slice(0, 200)}`);
assert.strictEqual(checkpoint.roundsCompleted, 3, 'round budget is shared across rotations (2 + 1), not reset to 16');
const afterResume = await fs.readFile(path.join(tmpDir, writtenRel), 'utf-8');
assert.ok(afterResume.includes('SENTINEL-NOT-REWRITTEN'), 'resumed attempt must NOT have re-executed the file write');
console.log(`(a) checkpoint resume: 429 after round 1 (file written, text kept) -> resumed on next key in 1 round, write not repeated, rounds 2 + 1 = 3`);

// --- (b)+(c) OpenAI loop: final round sends NO tools, ledger is REAL ------
const fetchBodies: any[] = [];
const origFetch = globalThis.fetch;
let fetchCalls = 0;
const sseToolRound = (usagePrompt: number) => [
  'data: {"choices":[{"delta":{"content":"Working on it."}}]}',
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"view_file","arguments":"{\\"AbsolutePath\\":\\"/nonexistent-proof-file-xyz.html\\"}"}}]}}]}`,
  `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":${usagePrompt},"completion_tokens":10}}`,
  'data: [DONE]',
  '',
].join('\n');
const sseTextRound = (usagePrompt: number) => [
  'data: {"choices":[{"delta":{"content":"Final summary text."}}]}',
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":${usagePrompt},"completion_tokens":10}}`,
  'data: [DONE]',
  '',
].join('\n');
(globalThis as any).fetch = async (_url: any, init: any) => {
  const i = fetchCalls++;
  fetchBodies.push(JSON.parse(String(init?.body || '{}')));
  const body = i < 15 ? sseToolRound(100 + i) : sseTextRound(200);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
const oaLedger = newTurnUsage('proof-session');
const oaCheckpoint = newTurnCheckpoint();
let oaText = '';
try {
  oaText = await streamOpenAICompatible(
    'https://fake-endpoint-step15/v1/chat/completions',
    'fake-key-for-proof',
    'probe-model-step15',
    {},
    [{ role: 'user', content: 'build a test landing page' }],
    'general',
    sendEvent,
    { sessionId: 'proof-session' },
    {},
    'build a test landing page',
    'build a test landing page',
    undefined,
    true,
    undefined,
    oaLedger,
    oaCheckpoint,
  );
} finally {
  (globalThis as any).fetch = origFetch;
}
assert.ok(oaText.includes('Final summary text.'), `OA loop must return the final text, got: ${oaText.slice(0, 200)}`);
assert.strictEqual(fetchCalls, 16, `OA loop must run 16 rounds, got ${fetchCalls}`);
for (let r = 0; r < 15; r++) {
  assert.ok(Array.isArray(fetchBodies[r].tools) && fetchBodies[r].tools.length === 86,
    `round ${r} must send the 86 tools, got ${fetchBodies[r].tools?.length}`);
}
assert.ok(!('tools' in fetchBodies[15]), `final round must send NO tools, got keys: ${Object.keys(fetchBodies[15]).join(', ')}`);
assert.ok(!('tool_choice' in fetchBodies[15]), 'final round must not set tool_choice either');
assert.strictEqual(oaCheckpoint.roundsCompleted, 16, 'OA checkpoint must count all 16 rounds');
assert.ok(oaCheckpoint.openAiMessages && oaCheckpoint.openAiMessages.length > 10,
  `OA checkpoint must keep the accumulated messages, got ${oaCheckpoint.openAiMessages?.length}`);
assert.ok(oaCheckpoint.calledAnyTool, 'OA checkpoint must record tool calls');
// Ledger: only the final text round records a step (tool rounds continue
// before the ledger) — and it must be REAL provider usage, not an estimate.
assert.strictEqual(oaLedger.steps.length, 1, `OA ledger should hold the final-round step, got ${oaLedger.steps.length}`);
const step = oaLedger.steps[0];
assert.strictEqual(step.estimated, false, 'final-round ledger step must be provider-reported, not estimated');
assert.strictEqual(step.promptTokens, 200, `final-round prompt tokens must be the real 200, got ${step.promptTokens}`);
assert.strictEqual(step.completionTokens, 10, `final-round completion tokens must be the real 10, got ${step.completionTokens}`);
console.log(`(c) OA loop: rounds 0-14 sent 86 tools, final round 15 sent NO tools; (b) ledger step is real usage 200/10, estimated=false`);

// --- (a) OA checkpoint resume: a second drive reuses the messages --------
const resumeBodies: any[] = [];
let resumeFetchCalls = 0;
(globalThis as any).fetch = async (_url: any, init: any) => {
  resumeFetchCalls++;
  resumeBodies.push(JSON.parse(String(init?.body || '{}')));
  return new Response(sseTextRound(300), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
try {
  await streamOpenAICompatible(
    'https://fake-endpoint-step15/v1/chat/completions',
    'fake-key-for-proof',
    'probe-model-step15',
    {},
    [{ role: 'user', content: 'build a test landing page' }],
    'general',
    sendEvent,
    { sessionId: 'proof-session' },
    {},
    'build a test landing page',
    'build a test landing page',
    undefined,
    true,
    undefined,
    newTurnUsage('proof-session'),
    oaCheckpoint,
  );
} finally {
  (globalThis as any).fetch = origFetch;
}
assert.strictEqual(resumeFetchCalls, 1, `resumed OA turn gets a 1-round budget (16 already used), got ${resumeFetchCalls} fetches`);
assert.ok(resumeBodies[0].messages.length > 10,
  `resumed OA turn must reuse the accumulated messages, got ${resumeBodies[0].messages.length} (a restart would send 2)`);
assert.strictEqual(oaCheckpoint.roundsCompleted, 17, 'resumed OA turn shares the round budget (16 + 1)');
console.log(`(a) OA checkpoint resume: second drive reused ${resumeBodies[0].messages.length} accumulated messages in 1 round (budget 16 + 1 = 17)`);

console.log('step15 proof: PASS');
