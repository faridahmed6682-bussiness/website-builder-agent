// Tool-schema proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/tool-schema-proof.mts
// Proves (Step 4, P0):
//  1. The Gemini path offers exactly the 87 core tools (was 104) — the same
//     name set the OpenAI-compatible path sends. The 17 dropped tools are
//     exactly the expected list, and each keeps a live executor (no
//     capability deleted, only the per-call declaration cost removed).
//  2. Tool-schema token size before vs after, on both paths
//     (estimateTokens, ~1 token / 4 chars).
//  3. Behavioural: driving runGeminiAgentLoop with a fake Gemini client,
//     no round's declarations contain any of the 17 dropped tools, the
//     loop never executes a dropped tool, and the final (16th) round is
//     sent with NO tools at all (system instruction preserved).
//  4. No raw `functionDeclarations: serverTools` remains in server/agent.
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
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-schema-proof-'));
process.chdir(tmpDir);
await fs.mkdir(path.join(tmpDir, 'data', 'chats'), { recursive: true });

// Dynamic imports AFTER chdir, so server modules bind to the temp dir.
const { serverTools, CORE_TOOL_NAMES, filterCoreTools } = await import('../server/agent/geminiService.ts');
const { estimateTokens } = await import('../server/agent/usage.ts');
const { toOpenAITools, runGeminiAgentLoop } = await import('../server/agent/apiOrchestrator.ts');

const names = (decls: any[]): string[] => decls.map((d) => d.name).filter(Boolean);
const sorted = (xs: string[]) => [...xs].sort();

// The 17 tools dropped from the Gemini path's native declarations.
const EXPECTED_DROPPED = sorted([
  // Legacy aliases (canonical tool kept)
  'fileRead', 'fileWrite', 'fileEdit', 'bash',
  // Claw harness
  'claw_doctor', 'claw_status', 'claw_acp', 'claw_prompt',
  'omx_protocol', 'clawhip_router', 'lazycodex_runner',
  // Stubs / thin wrappers with a kept canonical tool
  'figma_import', 'focus_mode', 'set_up_oauth', 'remove_oauth',
  'cloudsql_update_schema',
  // Covered by remind + queue_job
  'schedule',
]);

// --- 1. Counts, sets, executors --------------------------------------------
const allNames = names(serverTools);
assert.strictEqual(allNames.length, 104, `serverTools should still declare 104 tools, got ${allNames.length}`);
assert.strictEqual(CORE_TOOL_NAMES.size, 87, `CORE_TOOL_NAMES should hold 87 tools, got ${CORE_TOOL_NAMES.size}`);

const coreDecls = filterCoreTools(serverTools);
assert.strictEqual(coreDecls.length, 87, `filterCoreTools should keep 87, got ${coreDecls.length}`);
assert.deepStrictEqual(sorted(names(coreDecls)), sorted([...CORE_TOOL_NAMES]), 'filtered declarations must equal CORE_TOOL_NAMES');

const dropped = sorted(allNames.filter((n) => !CORE_TOOL_NAMES.has(n)));
assert.deepStrictEqual(dropped, EXPECTED_DROPPED, `dropped set mismatch: ${JSON.stringify(dropped)}`);

// Every dropped tool keeps a live executor in geminiService.executeServerTool.
const geminiSrcReal = await fs.readFile(new URL('../server/agent/geminiService.ts', import.meta.url), 'utf-8');
for (const name of EXPECTED_DROPPED) {
  assert.ok(geminiSrcReal.includes(`case '${name}':`), `dropped tool ${name} lost its executor case`);
}

// No raw (unfiltered) declaration list is sent anywhere in server/agent.
for (const rel of ['server/agent/geminiService.ts', 'server/agent/apiOrchestrator.ts']) {
  const src = await fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf-8');
  assert.ok(!/functionDeclarations:\s*serverTools\b/.test(src), `${rel} still sends raw serverTools`);
}

// --- 2. Token size before vs after, both paths ------------------------------
const geminiBefore = estimateTokens(JSON.stringify(serverTools));
const geminiAfter = estimateTokens(JSON.stringify(coreDecls));
const openAiTools = toOpenAITools(serverTools);
const openAiTokens = estimateTokens(JSON.stringify(openAiTools));
assert.strictEqual(openAiTools.length, 87, `OpenAI path should send 87 tools, got ${openAiTools.length}`);
assert.deepStrictEqual(sorted(openAiTools.map((t: any) => t.function.name)), sorted(names(coreDecls)),
  'Gemini-after and OpenAI name sets must be identical');
assert.ok(geminiAfter < geminiBefore, 'Gemini schema tokens must drop');
assert.ok(geminiBefore - geminiAfter > 1000, `expected >1000 tokens saved, got ${geminiBefore - geminiAfter}`);
console.log(`Gemini path: ${allNames.length} tools, ${geminiBefore} tokens  ->  ${coreDecls.length} tools, ${geminiAfter} tokens  (saved ${geminiBefore - geminiAfter}, -${((1 - geminiAfter / geminiBefore) * 100).toFixed(1)}%)`);
console.log(`OpenAI path: ${openAiTools.length} tools, ${openAiTokens} tokens (unchanged — already filtered; name set now identical to Gemini)`);

// --- 3. Behavioural: fake Gemini client drives the real loop ----------------
const sentConfigs: any[] = [];
const sentChatConfigs: any[] = [];
const executedToolNames: string[] = [];
const events: any[] = [];
const sendEvent = (data: any) => {
  events.push(data);
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

const fullText = await runGeminiAgentLoop(
  fakeClient,
  'fake-model-for-proof',
  'general',
  { sessionId: 'proof-session' },
  [],
  'build a test landing page',
  'build a test landing page',
  sendEvent,
  {},
  undefined,
  true,
  undefined,
);
assert.ok(fullText.includes('test build summary'), `loop should return the final summary text, got: ${fullText.slice(0, 200)}`);
assert.strictEqual(sentConfigs.length, 16, `loop should run all 16 rounds, got ${sentConfigs.length}`);
assert.strictEqual(sentChatConfigs.length, 1, 'one chat should be created');

// Chat-level declarations: exactly the 87 core tools, none dropped.
const chatDecls = sentChatConfigs[0]?.tools?.[0]?.functionDeclarations ?? [];
assert.strictEqual(chatDecls.length, 87, `chat should be created with 87 tools, got ${chatDecls.length}`);
for (const d of chatDecls) {
  assert.ok(CORE_TOOL_NAMES.has(d.name), `chat offered non-core tool ${d.name}`);
  assert.ok(!EXPECTED_DROPPED.includes(d.name), `chat offered dropped tool ${d.name}`);
}
// Rounds 0-14 use the chat-level config (no per-request override).
for (let r = 0; r < 15; r++) {
  assert.strictEqual(sentConfigs[r], undefined, `round ${r} should use chat-level tools, got per-request config`);
}
// Final round: explicit tool-free config, system instruction preserved.
const finalConfig = sentConfigs[15];
assert.ok(finalConfig && typeof finalConfig === 'object', 'final round must pass a per-request config');
assert.ok(!('tools' in finalConfig), `final round must send NO tools, got keys: ${Object.keys(finalConfig).join(', ')}`);
assert.ok(typeof finalConfig.systemInstruction === 'string' && finalConfig.systemInstruction.length > 0,
  'final round must preserve the system instruction');
assert.strictEqual(finalConfig.systemInstruction, sentChatConfigs[0].systemInstruction,
  'final-round system instruction must equal the chat-level one');
// The loop never executed a dropped tool (it was only ever offered view_file).
assert.ok(executedToolNames.length > 0, 'expected at least one tool execution to observe');
for (const t of executedToolNames) {
  assert.ok(!EXPECTED_DROPPED.includes(t), `loop executed dropped tool ${t}`);
  assert.ok(CORE_TOOL_NAMES.has(t), `loop executed non-core tool ${t}`);
}
console.log(`Behavioural: ${sentConfigs.length} rounds; offered tools/round: 87 (rounds 0-14), 0 (final round 15); executed tools: ${[...new Set(executedToolNames)].join(', ')} (no dropped tool offered or executed)`);

console.log('tool-schema proof: PASS');
