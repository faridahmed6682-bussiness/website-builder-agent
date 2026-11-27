// Intent gate — tools / code ONLY when the user's message actually needs it.
// Cheap local check first (keywords/patterns, English + Bengali); only when
// the message is genuinely ambiguous, ONE fast-model call decides. Never a
// full agent run just to decide — that would burn the free-tier quota the
// gate exists to save.
//
// Order in the turn (handleOrchestratedChat):
//   1. Direct-command match (server/directTools.ts) — zero model calls.
//   2. Intent gate here: casual -> one direct fast-model answer, no tools,
//      no code, no agent loop. Task -> full agent loop.
//   3. Unclear -> one fast-model classification call, then (1) or (2).
// A short confirmation ("yes" / "হ্যাঁ" / "go ahead") counts as TASK when the
// session already has tool activity or the agent asked a question — the user
// is continuing the build, not chatting.
import { chatOnce, chatChain } from './llmClient.ts';

export type Intent = 'casual' | 'task' | 'unclear';

const TASK_VERBS =
  /(build|make|create|fix|repair|debug|deploy|publish|search|find|look\s*up|write|edit|change|update|add|remove|delete|open|show|list|read|run|test|check|convert|clone|import|export|push|install|upload|download|generate|design|improve|refactor|move|rename|copy|count|compare|analyse|analyze|explain|plan|review|website|web\s*site|web\s*app|app|page|landing|shop|store|dashboard|portfolio|game|code|coding|html|css|javascript|typescript|react|component|function|api|database|firebase|button|form|layout|clone|repo|github|preview|responsive|pwa|বানাও|বানান|তৈরি\s*করো|তৈরি\s*কর|ঠিক\s*করো|ঠিক\s*কর|খুঁজে|খোঁজো|দেখাও|দেখান|তালিকা|খোলো|খুলো|চালাও|চালু|ডিপ্লয়|আপলোড|ডাউনলোড|যোগ\s*করো|মুছে|সরাও|পরিবর্তন|লিখো|এডিট|সাইট|অ্যাপ|কোড|ওয়েবসাইট|দোকান|গেম|ড্যাশবোর্ড)/i;

const GREETING_RE =
  /^(hi+|hello+|hey+|helo+|yo+|hola|salam|assalamu\s*alaikum|nomoshkar|namaste|good\s*(morning|afternoon|evening|night)|thanks?|thank\s*you|thx|ok|okay|bye|goodbye|হাই|হ্যালো|হেলো|সালাম|আসসালামু\s*আলাইকুম|নমস্কার|কেমন\s*আছো|কেমন\s*আছেন|কি\s*খবর|কী\s*খবর|ভালো\s*আছো|ধন্যবাদ|শুভ\s*(সকাল|দুপুর|সন্ধ্যা|রাত্রি)|ঠিক\s*আছে|ওকে)$/i;

const CASUAL_QUESTION_RE =
  /^(who are you|what can you do|how are you|what is your name|what'?s up|তুমি কে|আপনি কে|কি করতে পারো|কী করতে পারো|তুমি কি পারো|পরিচয় দাও|তুমি কেমন আছো)/i;

const CONFIRM_RE = /^(yes|yeah|yep|sure|go ahead|continue|do it|ok|okay|হ্যাঁ|হ্যা|হুম|ঠিক আছে|এগিয়ে যাও|এগিয়ে যাও|করো|চালিয়ে যাও|হ্যাঁ করো)[!?.।\s]*$/i;

const URL_OR_CODE_RE = /https?:\/\/|```|[a-z0-9_-]+\.(tsx?|jsx?|html|css|json|py|md)\b|[/\\][\w.-]+/i;

type HistoryTurn = { role?: string; parts?: Array<{ text?: string } | string>; text?: string; content?: string };

function historyText(h: HistoryTurn[]): string {
  return h
    .map((m) => {
      if (typeof m?.text === 'string') return m.text;
      if (typeof m?.content === 'string') return m.content;
      if (Array.isArray(m?.parts)) {
        return m.parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
      }
      return '';
    })
    .join('\n');
}

function historyHasToolActivity(h: HistoryTurn[]): boolean {
  const t = historyText(h);
  // Tool calls, file writes, or the agent asking a question / proposing a plan.
  return /tool_call|write_to_file|replace_file_content|\[TOOL EXECUTION RESULTS\]|ask_question|plan[:\-]|ধাপ|পরিকল্পনা/i.test(t);
}

function historyEndsWithQuestion(h: HistoryTurn[]): boolean {
  const turns = h.filter((m) => historyText([m]).trim());
  if (!turns.length) return false;
  const last = historyText([turns[turns.length - 1]]);
  return /\?\s*$|কি\?\s*$|কী\?\s*$|চান\?\s*$|করব\?\s*$/.test(last.trim()) || /ask_question/i.test(last);
}

/** Local-only classification. No model call, no network. */
export function classifyIntentLocal(prompt: string, history: HistoryTurn[] = []): Intent {
  const trimmed = (prompt || '').trim();
  if (!trimmed) return 'unclear';
  // Never casual: URLs, code fences, file paths, or a task verb anywhere.
  if (URL_OR_CODE_RE.test(trimmed)) return 'task';
  if (TASK_VERBS.test(trimmed)) return 'task';

  const clean = trimmed.toLowerCase().replace(/[!?.।,~`'"]+/g, '').trim();
  if (GREETING_RE.test(clean)) return 'casual';
  // Combined greeting, e.g. "আসসালামু আলাইকুম, কেমন আছো?" — a greeting
  // followed by another greeting / casual question. Split on commas first
  // (before the punctuation strip above removes them).
  const segments = trimmed.split(/[,،;]+/).map((s) => s.toLowerCase().replace(/[!?.।~`'"]+/g, '').trim()).filter(Boolean);
  if (segments.length > 1 && segments.every((seg) => GREETING_RE.test(seg) || CASUAL_QUESTION_RE.test(seg))) return 'casual';
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 8 && CASUAL_QUESTION_RE.test(clean)) return 'casual';

  // Short confirmations continue the build when the session is mid-task.
  if (CONFIRM_RE.test(trimmed) && (historyHasToolActivity(history) || historyEndsWithQuestion(history))) {
    return 'task';
  }
  if (CONFIRM_RE.test(trimmed)) return 'unclear';

  // Short messages with no task verb and no greeting pattern are ambiguous.
  if (wordCount <= 3) return 'unclear';
  // Longer messages without any task verb are usually questions/explanations.
  if (wordCount > 3 && /^(what|why|how|when|where|is|are|can|could|should|do|does|কি|কী|কেন|কীভাবে|কখন|কোথায়|কোন)/i.test(clean)) {
    return 'casual';
  }
  return 'unclear';
}

/** One fast-model classification call (chat chain, ~10 tokens out). Only used
 * when the local check is unclear. Any failure -> 'task' (safe default: run
 * the loop rather than refuse a task). */
async function classifyWithFastModel(prompt: string): Promise<'casual' | 'task'> {
  try {
    const chain = chatChain();
    const { text } = await chatOnce({
      system:
        'Classify the user message. Reply with exactly ONE word: CASUAL (greeting, thanks, small talk, a general question with no work requested) or TASK (anything that needs building, fixing, searching, files, code, deploy, or a tool). No other words.',
      user: prompt,
      chain,
      maxTokens: 10,
      timeoutMs: 15000,
    });
    const first = (text || '').trim().toLowerCase();
    if (first.startsWith('casual')) return 'casual';
    if (first.startsWith('task')) return 'task';
    return 'task';
  } catch {
    return 'task';
  }
}

/** Full decision: local first, fast-model call only when unclear. */
export async function decideIntent(prompt: string, history: HistoryTurn[] = []): Promise<'casual' | 'task'> {
  const local = classifyIntentLocal(prompt, history);
  if (local !== 'unclear') return local;
  return classifyWithFastModel(prompt);
}

/** System prompt for the casual direct answer: one fast-model call, no tools. */
export const CASUAL_SYSTEM =
  'You are Nexus AI, a friendly assistant. Answer the user directly and briefly in the language they wrote in (Bengali if they wrote in Bengali, otherwise English). Do not call tools, do not write code, do not plan — just answer the question or reply to the greeting.';
