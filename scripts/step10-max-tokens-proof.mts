// Max-output-tokens proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/step10-max-tokens-proof.mts
//      AGENT_LOOP_MAX_OUTPUT_TOKENS=4096 npx tsx scripts/step10-max-tokens-proof.mts
// Proves (Step 10, P1):
//  1. Both main loops cap per-round output: the OpenAI-compatible loop's
//     buildPayload sends max_tokens and the Gemini loop sends
//     maxOutputTokens — on the chat-level config AND on the final round's
//     per-request config (which replaces the chat config wholesale, so a
//     missing cap there would leave the final round uncapped).
//  2. The cap value is AGENT_LOOP_MAX_OUTPUT_TOKENS (default 8192) —
//     enough for one round to emit a whole single-file site (~30 KB of
//     code ≈ 8k tokens), bounding the 16-round worst case at
//     16 × 8192 ≈ 131k output tokens per turn instead of unbounded.
//  3. Behavioural, keyless: driving streamOpenAICompatible with a stubbed
//     fetch and runGeminiAgentLoop with a fake Gemini client, the cap is
//     present in every request payload actually sent.
// Fake keys (obviously not real) / no keys at all.
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

// Expected cap: env override if set, else the 8192 default — mirroring the
// module's own fallback (non-numeric / non-positive env -> 8192). The
// proof is run three ways (default, AGENT_LOOP_MAX_OUTPUT_TOKENS=4096,
// AGENT_LOOP_MAX_OUTPUT_TOKENS=banana) to prove the override path, the
// default, and the bad-value fallback.
const _envCap = Number(process.env.AGENT_LOOP_MAX_OUTPUT_TOKENS || 8192);
const EXPECTED = Number.isFinite(_envCap) && _envCap > 0 ? Math.floor(_envCap) : 8192;

// --- Isolated data dir (memory.ts resolves data/ from process.cwd()) --------
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step10-max-tokens-proof-'));
process.chdir(tmpDir);
await fs.mkdir(path.join(tmpDir, 'data', 'chats'), { recursive: true });

// Dynamic imports AFTER chdir, so server modules bind to the temp dir.
const { runGeminiAgentLoop, streamOpenAICompatible } = await import('../server/agent/apiOrchestrator.ts');

// --- 1. Source: the caps are wired to the shared constant -------------------
const src = await fs.readFile(new URL('../server/agent/apiOrchestrator.ts', import.meta.url), 'utf-8');
assert.ok(src.includes('max_tokens: AGENT_LOOP_MAX_OUTPUT_TOKENS'), 'buildPayload must set max_tokens from AGENT_LOOP_MAX_OUTPUT_TOKENS');
const geminiCapUses = src.match(/maxOutputTokens: AGENT_LOOP_MAX_OUTPUT_TOKENS/g) || [];
assert.strictEqual(geminiCapUses.length, 2, `Gemini loop must set maxOutputTokens in BOTH the chat config and the final-round per-request config, found ${geminiCapUses.length}`);
assert.ok(/AGENT_LOOP_MAX_OUTPUT_TOKENS = Number\.isFinite\(_loopMaxOut\)/.test(src), 'cap must fall back to the default on a bad env value');
console.log(`Source: buildPayload max_tokens + Gemini maxOutputTokens (chat + final round) all use AGENT_LOOP_MAX_OUTPUT_TOKENS; expected cap ${EXPECTED}`);

// --- 2. Behavioural, OpenAI-compatible path: stubbed fetch ------------------
const capturedBodies: any[] = [];
const sseBody =
  'data: {"choices":[{"delta":{"content":"Done — test build summary."}}]}\n\n' +
  'data: [DONE]\n\n';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, init: any) => {
  capturedBodies.push(JSON.parse(String(init?.body || '{}')));
  return new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}) as any;

const events: any[] = [];
const sendEvent = (data: any) => { events.push(data); };

try {
  const fullText = await streamOpenAICompatible(
    'https://fake-provider.example/v1/chat/completions',
    'fake-key-for-proof',
    'fake-model-for-proof',
    {},
    [{ role: 'user', content: 'build a test landing page' }],
    'general',
    sendEvent,
    { sessionId: 'proof-session' },
    {},
    'build a test landing page',
    'build a test landing page',
    undefined, // trackedKey
    false, // allowTools: one tool-free round, no tool execution
    undefined, // planningEffort
    undefined, // usageLedger
  );
  assert.ok(fullText.includes('test build summary'), `loop should return the stubbed text, got: ${fullText.slice(0, 200)}`);
} finally {
  globalThis.fetch = realFetch;
}
assert.strictEqual(capturedBodies.length, 1, `expected exactly 1 provider request, got ${capturedBodies.length}`);
assert.strictEqual(capturedBodies[0].max_tokens, EXPECTED, `OpenAI payload max_tokens should be ${EXPECTED}, got ${capturedBodies[0].max_tokens}`);
assert.strictEqual(capturedBodies[0].stream, true, 'OpenAI payload must still stream');
assert.strictEqual(capturedBodies[0].model, 'fake-model-for-proof', 'OpenAI payload model must pass through');
console.log(`OpenAI-compatible path: 1 request, max_tokens=${capturedBodies[0].max_tokens} (expected ${EXPECTED})`);

// --- 3. Behavioural, Gemini path: fake client --------------------------------
const sentConfigs: any[] = [];
const sentChatConfigs: any[] = [];
const executedToolNames: string[] = [];
const geminiSendEvent = (data: any) => {
  if (data?.step?.toolName) executedToolNames.push(data.step.toolName);
};

let roundIdx = 0;
const fakeChat = {
  async sendMessageStream(params: any) {
    sentConfigs.push(params.config);
    const i = roundIdx++;
    async function* gen() {
      if (i < 15) {
        // Tool rounds: call a KEPT tool with harmless args (missing file -> error result, no side effects).
        yield { functionCalls: [{ name: 'view_file', args: { AbsolutePath: '/nonexistent-proof-file-xyz.html' } }] };
      } else {
        yield { text: 'Done — test build summary.' };
      }
    }
    return gen();
  },
};
const fakeClient: any = {
  chats: {
    create: (opts: any) => {
      sentChatConfigs.push(opts.config);
      return fakeChat;
    },
  },
};

const geminiText = await runGeminiAgentLoop(
  fakeClient,
  'fake-model-for-proof',
  'general',
  { sessionId: 'proof-session' },
  [],
  'build a test landing page',
  'build a test landing page',
  geminiSendEvent,
  {},
  undefined,
  true,
  undefined,
);
assert.ok(geminiText.includes('test build summary'), `loop should return the final summary text, got: ${geminiText.slice(0, 200)}`);
assert.strictEqual(sentConfigs.length, 16, `loop should run all 16 rounds, got ${sentConfigs.length}`);
assert.strictEqual(sentChatConfigs.length, 1, 'one chat should be created');
// Chat-level config: the cap applies to rounds 0-14 (no per-request config).
assert.strictEqual(sentChatConfigs[0]?.maxOutputTokens, EXPECTED,
  `chat config maxOutputTokens should be ${EXPECTED}, got ${sentChatConfigs[0]?.maxOutputTokens}`);
for (let r = 0; r < 15; r++) {
  assert.strictEqual(sentConfigs[r], undefined, `round ${r} should use chat-level config, got per-request config`);
}
// Final round: explicit per-request config must repeat the cap (it
// replaces the chat config wholesale) and preserve the system instruction.
const finalConfig = sentConfigs[15];
assert.ok(finalConfig && typeof finalConfig === 'object', 'final round must pass a per-request config');
assert.strictEqual(finalConfig.maxOutputTokens, EXPECTED,
  `final-round maxOutputTokens should be ${EXPECTED}, got ${finalConfig.maxOutputTokens}`);
assert.ok(typeof finalConfig.systemInstruction === 'string' && finalConfig.systemInstruction.length > 0,
  'final round must preserve the system instruction');
assert.strictEqual(finalConfig.systemInstruction, sentChatConfigs[0].systemInstruction,
  'final-round system instruction must equal the chat-level one');
console.log(`Gemini path: 16 rounds; chat maxOutputTokens=${sentChatConfigs[0].maxOutputTokens}, final-round maxOutputTokens=${finalConfig.maxOutputTokens} (expected ${EXPECTED})`);

console.log('step10-max-tokens proof: PASS');
