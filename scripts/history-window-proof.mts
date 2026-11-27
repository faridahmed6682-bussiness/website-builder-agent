// History-window proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/history-window-proof.mts
// Proves (Step 3, P0):
//  1. A long fake session (40 turns / 80 messages) is trimmed to the last
//     HISTORY_WINDOW_TURNS turns (default 12) on every path that feeds the
//     model: splitHistoryWindow, prepareGeminiHistoryAndLastMessage (Gemini
//     loop) and convertToOpenAIMessages (OpenAI-compatible loop).
//  2. The rolling summary is produced (stub summarizer stands in for the
//     cheap model — no key needed) and persisted per session; the next turn
//     refreshes it incrementally from ONLY the newly-dropped turns +
//     the previous summary.
//  3. A failing summarizer (no keys / cheap model down) fails SOFT: the
//     turn still proceeds with the window alone, no throw.
//  4. The client send path (trimMessagesToWindow) sends only the last N turns.
//  5. HISTORY_WINDOW_TURNS env override is honoured.
//  6. Token counts before/after (estimateTokens, ~1 token / 4 chars).
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// --- Fake keys (obviously not real) / no keys at all ------------------------
// The summary path is exercised with a STUB summarizer; the default
// (cheap-model) path is never called here, so no provider key is needed.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;
delete process.env.HISTORY_WINDOW_TURNS;

// --- Fake 40-turn session ----------------------------------------------------
const USER_PAD = 'please add a hero section with a headline and a call to action button. ';
const MODEL_PAD = 'Done — I added the hero section to index.html with the headline, subtext and button, then verified the build. ';
const fakeSession: any[] = [];
for (let i = 1; i <= 40; i++) {
  fakeSession.push({ role: 'user', parts: [{ text: `User request #${i}: ${USER_PAD}` }] });
  fakeSession.push({ role: 'model', parts: [{ text: `Assistant reply #${i}: ${MODEL_PAD}` }] });
}
const textOf = (m: any) => m.parts?.[0]?.text || '';
const allText = fakeSession.map(textOf).join('\n');

// --- Isolated data dir (memory.ts resolves data/ from process.cwd()) --------
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-window-proof-'));
process.chdir(tmpDir);
await fs.mkdir(path.join(tmpDir, 'data', 'chats'), { recursive: true });

// Dynamic imports AFTER chdir, so memory.ts binds DATA_DIR to the temp dir.
const {
  splitHistoryWindow,
  historyWindowTurns,
  ensureRollingSummary,
  summaryTurn,
} = await import('../server/agent/historyWindow.ts');
const { estimateTokens } = await import('../server/agent/usage.ts');
const { prepareGeminiHistoryAndLastMessage } = await import('../server/agent/websiteDeployer.ts');
const { convertToOpenAIMessages } = await import('../server/agent/apiOrchestrator.ts');
const { trimMessagesToWindow } = await import('../src/lib/gemini.ts');

const tokensBefore = estimateTokens(allText);
console.log(`Window turns (default): ${historyWindowTurns()}`);
console.log(`Fake session: 40 turns / ${fakeSession.length} messages, ~${tokensBefore} tokens`);

// --- 1. Pure window split ----------------------------------------------------
const { recent, dropped } = splitHistoryWindow(fakeSession);
assert.strictEqual(recent.length, 24, 'recent must be the last 12 turns (24 messages)');
assert.strictEqual(dropped.length, 56, 'dropped must be the older 28 turns (56 messages)');
assert.ok(textOf(recent[0]).includes('#29'), 'window must start at turn #29');
assert.ok(textOf(recent[recent.length - 1]).includes('#40'), 'window must end at turn #40');
console.log(`1. splitHistoryWindow: recent=${recent.length} msgs, dropped=${dropped.length} msgs — OK`);

// --- 2. Gemini sanitizer hard cap --------------------------------------------
const sanitized = prepareGeminiHistoryAndLastMessage(fakeSession);
assert.ok(sanitized.history.length <= 24, `Gemini history must be capped, got ${sanitized.history.length}`);
assert.ok(sanitized.lastMessage.includes('#40'), 'lastMessage must be the newest user turn');
assert.ok(!JSON.stringify(sanitized.history).includes('#1:'), 'Gemini history must not contain turn #1');
console.log(`2. prepareGeminiHistoryAndLastMessage: history=${sanitized.history.length} entries, lastMessage=turn #40 — OK`);

// --- 3. OpenAI converter hard cap --------------------------------------------
const openAi = convertToOpenAIMessages(fakeSession, 'general');
assert.strictEqual(openAi[0].role, 'system', 'first entry stays the system prompt');
assert.ok(openAi.length <= 25, `OpenAI messages must be system + <=24 turns, got ${openAi.length}`);
assert.ok(!JSON.stringify(openAi).includes('User request #1'), 'OpenAI messages must not contain turn #1');
assert.ok(JSON.stringify(openAi).includes('User request #40'), 'OpenAI messages must contain turn #40');
console.log(`3. convertToOpenAIMessages: ${openAi.length} entries (system + ${openAi.length - 1} turns) — OK`);

// --- 4. Client send trim -------------------------------------------------------
const sent = trimMessagesToWindow(fakeSession);
assert.strictEqual(sent.length, 24, 'client must send only the last 12 turns');
assert.ok(textOf(sent[0]).includes('#29'), 'client window must start at turn #29');
console.log(`4. trimMessagesToWindow (client): sends ${sent.length} of ${fakeSession.length} messages — OK`);

// --- 5. Rolling summary: produced, persisted, refreshed incrementally --------
const sessionId = 'proof-session';
const storedPath = path.join(tmpDir, 'data', 'chats', `${sessionId}.json`);
await fs.writeFile(
  storedPath,
  JSON.stringify({
    id: sessionId,
    title: 'proof',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: fakeSession.map((m) => ({ role: m.role, text: textOf(m), at: Date.now() })),
  }),
  'utf-8'
);

const summaryCalls: string[] = [];
const stubSummarizer = async (opts: { system: string; user: string; maxTokens: number }) => {
  summaryCalls.push(opts.user);
  return 'FAKE SUMMARY: hero section built, headline + CTA decided, pending: footer links.';
};

const first = await ensureRollingSummary(sessionId, stubSummarizer);
assert.ok(first.summary.includes('FAKE SUMMARY'), 'summary must be produced');
assert.strictEqual(first.summaryUpTo, 56, 'summary must cover the 56 dropped messages');
assert.strictEqual(first.refreshed, true, 'first call must refresh');
assert.strictEqual(first.coversBeyondWindow, true, 'stored session must extend beyond the window');
assert.strictEqual(summaryCalls.length, 1, 'exactly one summary call on the first turn');
assert.ok(summaryCalls[0].includes('User request #1'), 'first summary input must include the oldest dropped turn');
const persisted = JSON.parse(await fs.readFile(storedPath, 'utf-8'));
assert.strictEqual(persisted.summary, first.summary, 'summary must be persisted to the stored chat');
assert.strictEqual(persisted.summaryUpTo, 56, 'summaryUpTo must be persisted');
console.log(`5a. ensureRollingSummary: summary produced + persisted (summaryUpTo=${first.summaryUpTo}) — OK`);

// Simulate the next turn: one more user+model turn lands in stored history.
const stored2 = JSON.parse(await fs.readFile(storedPath, 'utf-8'));
stored2.messages.push(
  { role: 'user', text: 'User request #41: add a footer with links.', at: Date.now() },
  { role: 'model', text: 'Assistant reply #41: footer added.', at: Date.now() }
);
await fs.writeFile(storedPath, JSON.stringify(stored2), 'utf-8');
const second = await ensureRollingSummary(sessionId, stubSummarizer);
assert.strictEqual(second.refreshed, true, 'second turn must refresh (2 more turns dropped)');
assert.strictEqual(second.summaryUpTo, 58, 'summaryUpTo must advance to 58');
assert.strictEqual(summaryCalls.length, 2, 'exactly one more summary call');
assert.ok(summaryCalls[1].includes('FAKE SUMMARY'), 'refresh input must carry the previous summary');
assert.ok(summaryCalls[1].includes('User request #29'), 'refresh input must include ONLY the newly-dropped turn #29');
assert.ok(!summaryCalls[1].includes('User request #1'), 'refresh input must NOT re-send already-summarized turn #1');
console.log(`5b. Rolling summary refresh is incremental (newly-dropped turns only, prev summary carried) — OK`);

// The summary turn the model actually sees:
const withSummary = [summaryTurn(second.summary), ...splitHistoryWindow(fakeSession).recent];
const tokensAfter = estimateTokens(withSummary.map((m: any) => m.parts?.[0]?.text || '').join('\n'));
console.log(`5c. Tokens per turn: before ~${tokensBefore} -> after ~${tokensAfter} (window + summary), ` +
  `-${Math.round((1 - tokensAfter / tokensBefore) * 100)}% — and FLAT as the session grows`);

// --- 6. Fail-soft: summarizer throws (no keys / cheap model down) -------------
const failing = await ensureRollingSummary(sessionId, async () => {
  throw new Error('NO_PROVIDER_KEYS (simulated)');
});
// Stored summary already exists from 5b, so the state keeps it; the key
// point is no throw and the turn can proceed with the window alone.
assert.ok(failing.summary.length >= 0, 'fail-soft must not throw');
const freshId = 'proof-session-fresh';
await fs.writeFile(
  path.join(tmpDir, 'data', 'chats', `${freshId}.json`),
  JSON.stringify({
    id: freshId, title: 'proof', createdAt: Date.now(), updatedAt: Date.now(),
    messages: fakeSession.map((m) => ({ role: m.role, text: textOf(m), at: Date.now() })),
  }),
  'utf-8'
);
const freshFail = await ensureRollingSummary(freshId, async () => {
  throw new Error('NO_PROVIDER_KEYS (simulated)');
});
assert.strictEqual(freshFail.summary, '', 'fresh session + failing summarizer must yield empty summary, not a throw');
assert.strictEqual(freshFail.refreshed, false, 'failed summary must not be marked refreshed');
console.log('6. Failing summarizer fails soft (empty summary, no throw) — OK');

// --- 7. Env override ------------------------------------------------------------
process.env.HISTORY_WINDOW_TURNS = '5';
const small = splitHistoryWindow(fakeSession);
assert.strictEqual(small.recent.length, 10, 'HISTORY_WINDOW_TURNS=5 must keep 5 turns (10 messages)');
delete process.env.HISTORY_WINDOW_TURNS;
assert.strictEqual(historyWindowTurns(), 12, 'default window must be 12 turns again');
console.log('7. HISTORY_WINDOW_TURNS=5 -> 10 messages; default restored to 12 — OK');

// --- Cleanup ------------------------------------------------------------------
await fs.rm(tmpDir, { recursive: true, force: true });
console.log('\nHISTORY-WINDOW PROOF: ALL CHECKS PASSED');
process.exit(0);
