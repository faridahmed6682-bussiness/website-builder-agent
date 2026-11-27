// Step 9 (P1-2) proof — stubs/mocks ONLY, no real API keys, no network
// beyond a localhost stub server.
// Run: npx tsx scripts/step9-omo-proof.mts
// Proves:
//  1. runOmoCoordinate makes EXACTLY ONE planner LLM sub-call (was two:
//     Architect + Executor, each through the turn model's llmInvoker —
//     Hydrogen on coding turns).
//  2. That one call goes to the CHEAP chain (cheapChain() head — never
//     Hydrogen) with the output cap applied (max_tokens = 600).
//  3. The single plan is split into the Architect spec and the Executor
//     file-operations list; the result keeps its 3 phases + consensus shape.
//  4. The old paths are dead: execCtx.llmInvoker is never called, and no
//     request ever goes to a hardcoded model.
//  5. Fail-soft: when the cheap call fails (stub returns 500), the phases
//     fall back to the static templates instead of throwing — still exactly
//     one planner attempt.
import assert from 'node:assert';
import http from 'node:http';

// --- Fake key (obviously not real) / no provider keys at all ---------------
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.FREE_LLM_API_MODEL_CHEAP;
process.env.FREE_LLM_API_KEY = 'stub-fake-key';

// --- Local stub FreeLLMAPI server -------------------------------------------
const requests: Array<{ model: string; max_tokens: number; messages: unknown }> = [];
let failMode = false;
const PLAN_TEXT =
  'ARCHITECTURE: Fake spec — edit src/App.tsx, add a hero route and a call to action, verify with the build.\n' +
  'FILE OPERATIONS: write_to_file src/App.tsx; write_to_file src/components/Hero.tsx.';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    requests.push({ model: parsed.model, max_tokens: parsed.max_tokens, messages: parsed.messages });
    if (failMode) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub failure (simulated cheap-model outage)' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: PLAN_TEXT } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
process.env.FREE_LLM_API_URL = `http://127.0.0.1:${port}`;

// --- Imports AFTER env setup -------------------------------------------------
const { runOmoCoordinate } = await import('../server/agent/geminiService.ts');
const { cheapChain } = await import('../server/agent/llmClient.ts');

// --- 0. The cheap chain itself never contains Hydrogen -----------------------
const chain = cheapChain();
console.log(`Cheap chain: [${chain.join(', ')}]`);
assert.ok(chain.length >= 1, 'cheapChain() must not be empty');
assert.ok(!chain.some((m: string) => /hydrogen/i.test(m)), 'cheapChain() must never contain Hydrogen');

// --- 1-4. One cheap planner call, capped, split across the two phases -------
const llmInvokerCalls: unknown[] = [];
const result = await runOmoCoordinate(
  'Build a small landing page with a hero section',
  'test context',
  ['Architect', 'Executor', 'Reviewer'],
  {
    sessionId: 'step9-proof',
    // Hostile invoker: the old code called this (turn model = Hydrogen).
    // The new code must never touch it.
    llmInvoker: async () => {
      llmInvokerCalls.push(1);
      throw new Error('llmInvoker must not be called (Step 9)');
    },
    onAgentStep: () => {},
  } as any
);

assert.strictEqual(requests.length, 1, `exactly ONE planner sub-call expected, got ${requests.length}`);
assert.strictEqual(requests[0].model, chain[0], `planner call must use the cheap chain head (${chain[0]}), got ${requests[0].model}`);
assert.ok(!/hydrogen/i.test(requests[0].model), `planner call model must not be Hydrogen, got ${requests[0].model}`);
assert.strictEqual(requests[0].max_tokens, 600, `planner call must carry the output cap max_tokens=600, got ${requests[0].max_tokens}`);
console.log(`1. Exactly one planner sub-call (was two) — OK`);
console.log(`2. Model=${requests[0].model} (cheap chain head, not Hydrogen), max_tokens=${requests[0].max_tokens} (cap) — OK`);
assert.strictEqual(llmInvokerCalls.length, 0, 'execCtx.llmInvoker must never be called');
console.log('3. execCtx.llmInvoker never called (old Hydrogen path dead) — OK');

assert.strictEqual(result.consensusStatus, 'consensus_achieved', 'consensus shape must be kept');
assert.strictEqual(result.coordinationPhases.length, 3, 'must keep the 3 phases (Architect/Executor/Reviewer)');
assert.ok(result.coordinationPhases[0].output.includes('Fake spec'), 'Architect phase must carry the ARCHITECTURE section');
assert.ok(!result.coordinationPhases[0].output.includes('FILE OPERATIONS'), 'Architect phase must not include the file-ops section');
assert.ok(result.coordinationPhases[1].output.includes('write_to_file src/App.tsx'), 'Executor phase must carry the FILE OPERATIONS section');
console.log('4. Single plan split across Architect + Executor phases, 3 phases + consensus kept — OK');

// --- 5. Fail-soft: cheap call down -> static templates, still one attempt ----
failMode = true;
const before = requests.length;
const fallback = await runOmoCoordinate('Build a small landing page with a hero section', 'test context');
assert.strictEqual(requests.length, before + 1, 'a failed cheap call must be exactly one attempt (no retry/fan-out)');
assert.ok(fallback.coordinationPhases[0].output.includes('Architectural plan for'), 'Architect phase must fall back to the static template');
assert.ok(fallback.coordinationPhases[1].output.includes('Ready to apply direct workspace edits'), 'Executor phase must fall back to the static template');
assert.strictEqual(fallback.consensusStatus, 'consensus_achieved', 'fallback result must keep its shape');
console.log('5. Cheap call failing -> static templates, no throw, still one attempt — OK');

server.close();
console.log('\nSTEP-9 OMO PROOF: ALL CHECKS PASSED');
process.exit(0);
