// History window + rolling summary (Step 3, P0 audit fix).
//
// AUDIT FINDING: no history trimming or rolling summary anywhere. The client
// sent the entire conversation every turn and the server prepended the full
// stored session, so input tokens grew LINEARLY with session length on
// every round. Stored history was capped only at 500 messages (a file-size
// cap, not a token cap).
//
// FIX: the model sees at most the last N turns (HISTORY_WINDOW_TURNS,
// default 12) plus a short rolling summary (~200-300 tokens) of the older
// turns that fell out of the window. The summary is written by the CHEAP
// model (cheapChain — never Hydrogen, never a hardcoded model ID) and stored
// per session in data/chats/<session>.json, refreshed incrementally: each
// turn only the newly-dropped turns + the previous summary are fed to the
// summarizer, so the summary call itself stays small.
//
// WHERE IT APPLIES (server is authoritative — every model feed goes through
// handleOrchestratedChat):
//   - Gemini loop: windowed in the handler, hard-capped again inside
//     prepareGeminiHistoryAndLastMessage (websiteDeployer.ts).
//   - OpenAI-compatible loop (OpenRouter / Groq): windowed in the handler,
//     hard-capped again inside convertToOpenAIMessages (apiOrchestrator.ts).
//   - Client send path: src/lib/gemini.ts sends only the last N turns.
// A "turn" is one user message plus the model messages that follow it, so
// the window is always turn-aligned (never cuts a user message off from its
// reply). The stored history on disk is NOT trimmed — reopening a chat still
// shows the full conversation; only what the model sees is capped.
import { chatOnce, cheapChain } from './llmClient.ts';
import { loadChat, updateChatSummary } from './memory.ts';

/**
 * Turns of history sent to the model per turn. Env-overridable
 * (HISTORY_WINDOW_TURNS), following the TOOL_RESULT_MAX_CHARS pattern.
 * Default 12 turns (~24 messages). Clamped to 1..50.
 */
export function historyWindowTurns(): number {
  const n = Number(process.env.HISTORY_WINDOW_TURNS || 12);
  if (!Number.isFinite(n)) return 12;
  return Math.min(Math.max(Math.floor(n), 1), 50);
}

export type HistoryRole = 'user' | 'model';

export function historyRoleOf(m: any): HistoryRole {
  return m?.role === 'model' || m?.role === 'assistant' ? 'model' : 'user';
}

/** Extract the text of one history message, whatever shape it is in
 * ({parts:[{text}]}, {content}, or {text}). */
export function historyTextOf(m: any): string {
  if (!m) return '';
  if (Array.isArray(m.parts)) {
    return m.parts
      .map((p: any) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof m.content === 'string') return m.content.trim();
  if (typeof m.text === 'string') return m.text.trim();
  return '';
}

/**
 * Split a message list into the last N turns (recent) and everything older
 * (dropped). Turn-aligned: a turn starts at each user message; model
 * messages attach to the preceding user turn. Pure + synchronous, so the
 * sanitizers can use it as a hard cap without a model call.
 */
export function splitHistoryWindow<T>(
  messages: T[],
  roleOf: (m: T) => HistoryRole = historyRoleOf as (m: T) => HistoryRole
): { recent: T[]; dropped: T[] } {
  const list = Array.isArray(messages) ? messages : [];
  const windowTurns = historyWindowTurns();
  const starts: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (roleOf(list[i]) === 'user') starts.push(i);
  }
  if (starts.length <= windowTurns) return { recent: list, dropped: [] };
  const cut = starts[starts.length - windowTurns];
  return { recent: list.slice(cut), dropped: list.slice(0, cut) };
}

/** The text block prepended (as a user turn) when a summary exists. */
export function formatSummaryBlock(summary: string): string {
  return `[CONVERSATION SUMMARY — condensed from earlier turns no longer shown in full. Use it for context (what was built, decisions made, pending items); do not repeat it back verbatim.\n${summary.trim()}]`;
}

/** A summary as a single user turn, in the shape both loops accept. */
export function summaryTurn(summary: string): { role: 'user'; parts: { text: string }[] } {
  return { role: 'user', parts: [{ text: formatSummaryBlock(summary) }] };
}

const SUMMARY_SYSTEM =
  'You condense a long website-building chat into a short rolling summary, about 200-300 tokens. ' +
  'Keep only what the agent needs to continue: what was built (files, features), key decisions and ' +
  'user preferences, and pending/open items. Drop greetings, small talk and repeated detail. ' +
  'Plain text, short bullet lines, no preamble.';

/** Bound the summarizer's input: keep the head + tail of very long dropped text. */
function capDroppedText(text: string): string {
  const MAX = 12000;
  if (text.length <= MAX) return text;
  const half = MAX / 2;
  return (
    text.slice(0, half) +
    '\n\n[... middle of older turns omitted for length ...]\n\n' +
    text.slice(-half)
  );
}

export type Summarizer = (opts: {
  system: string;
  user: string;
  maxTokens: number;
}) => Promise<string>;

/** Default summarizer: one cheap-model call (cheapChain — never Hydrogen). */
async function defaultSummarizer(opts: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const { text } = await chatOnce({
    system: opts.system,
    user: opts.user,
    chain: cheapChain(),
    maxTokens: opts.maxTokens,
    timeoutMs: 60000,
  });
  return text;
}

/**
 * Fold dropped turns into the rolling summary. Fail-soft: on any error
 * (e.g. no keys / cheap model unavailable) returns '' and the caller just
 * proceeds with the window alone — a missing summary never blocks a turn.
 */
export async function buildRollingSummary(
  previousSummary: string,
  droppedTurns: any[],
  summarizer: Summarizer = defaultSummarizer
): Promise<string> {
  const droppedText = droppedTurns
    .map((m) => `${historyRoleOf(m) === 'model' ? 'Assistant' : 'User'}: ${historyTextOf(m)}`)
    .join('\n')
    .trim();
  if (!droppedText && !previousSummary) return '';
  const user = [
    previousSummary
      ? `PREVIOUS SUMMARY (already condensed — keep its key points):\n${previousSummary}`
      : '',
    droppedText ? `OLDER TURNS TO FOLD IN (oldest first):\n${capDroppedText(droppedText)}` : '',
    'Write the updated rolling summary (about 200-300 tokens).',
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const out = (await summarizer({ system: SUMMARY_SYSTEM, user, maxTokens: 400 })).trim();
    return out.slice(0, 2000); // hard cap ~500 tokens
  } catch (err: any) {
    console.warn(
      '[history] Rolling summary failed (cheap model unavailable) — continuing with the window only:',
      err?.message || err
    );
    return '';
  }
}

export interface RollingSummaryState {
  /** Current rolling summary text ('' when no turns have dropped yet). */
  summary: string;
  /** Stored messages covered by the summary (count from the start of the stored array). */
  summaryUpTo: number;
  /** True when the stored session has turns beyond the current window. */
  coversBeyondWindow: boolean;
  /** True when this call wrote a refreshed summary. */
  refreshed: boolean;
}

/**
 * Refresh the session's rolling summary from the SERVER-stored history
 * (the canonical full history — saveChatTurn persists every turn) and
 * return it. Only newly-dropped turns are summarized each time, so the
 * summary call stays small. `summaryUpTo` is counted against the stored
 * array, which grows monotonically (the 500-message file cap may shift it
 * by a turn or two after very long sessions — harmless: the summary is
 * condensed context, not an exact index, and a turn is at most
 * re-summarized once).
 */
export async function ensureRollingSummary(
  sessionId: string | undefined,
  summarizer?: Summarizer
): Promise<RollingSummaryState> {
  const empty: RollingSummaryState = {
    summary: '',
    summaryUpTo: 0,
    coversBeyondWindow: false,
    refreshed: false,
  };
  if (!sessionId) return empty;
  let stored = null;
  try {
    stored = await loadChat(sessionId);
  } catch {
    return empty;
  }
  if (!stored || stored.messages.length === 0) return empty;
  const { dropped } = splitHistoryWindow(stored.messages);
  const prevSummary = stored.summary || '';
  const prevUpTo = stored.summaryUpTo || 0;
  let summary = prevSummary;
  let summaryUpTo = prevUpTo;
  let refreshed = false;
  if (dropped.length > prevUpTo) {
    const newlyDropped = dropped.slice(prevUpTo);
    const next = await buildRollingSummary(prevSummary, newlyDropped, summarizer);
    if (next) {
      summary = next;
      summaryUpTo = dropped.length;
      refreshed = true;
      await updateChatSummary(sessionId, summary, summaryUpTo).catch(() => {});
    }
  }
  return { summary, summaryUpTo, coversBeyondWindow: dropped.length > 0, refreshed };
}
