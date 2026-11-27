// Token discipline + transparency — the user asked whether tool calling
// costs API usage. Yes, it does, and the UI must say so honestly.
//
// Tool calling costs LLM API usage in three ways:
//   (a) Tool DEFINITIONS (all tool schemas) are sent as input tokens on
//       EVERY model call. The full tool list is large — its estimated token
//       cost per call is shown in the usage summary.
//   (b) Each tool ROUND-TRIP is an extra request against RPM/RPD: the model
//       calls a tool, the result comes back, the model is called again.
//   (c) Tool RESULTS come back as input tokens on the next call.
// The tool's own execution (file read, grep, deploy trigger) costs NO LLM
// tokens — only the model conversation does.
//
// Mitigations (kept): truncate tool outputs, short-brief discipline,
// plan-first (fewer wasted calls), intent gate (casual chat uses no tools),
// Tier 0 direct routing (zero model calls), Tier 1 cheap loop model.
//
// Usage shown per task, live: requests used, input/output tokens, which
// model served each step (and which cost tier), plus per-key headroom where
// known — from OBSERVED 429s only, never from assumed numbers. Token counts
// are REAL when the provider returns usage; otherwise they are estimates
// (~1 token per 4 characters) and are labelled as estimates.

export type CostTier = 0 | 1 | 2;

const CHEAP_MODEL_RE =
  /flash-lite|auto:fast|gpt-oss-20b|lfm-3|ling-3\.2-flash|ernie.*flash|nemotron-3\.5-lightning|gemma-4-26b/i;

/** Cost tier of a model: 0 = no model (direct / Tier 0), 1 = cheap loop
 * model (Tier 1), 2 = quality model — Hydrogen / planning / coding (Tier 2/3). */
export function costTierOfModel(model: string): CostTier {
  if (!model) return 0;
  if (CHEAP_MODEL_RE.test(model)) return 1;
  return 2;
}

/** Rough token estimate: ~1 token per 4 characters. Labelled as estimate. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface UsageStep {
  kind: 'llm' | 'tool' | 'plan' | 'review' | 'vision' | 'direct';
  model?: string;
  provider?: string;
  keyName?: string;
  tier: CostTier;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** True when the token numbers are estimates, not provider-reported usage. */
  estimated: boolean;
  note?: string;
}

export interface TurnUsage {
  sessionId: string;
  startedAt: number;
  steps: UsageStep[];
  toolCalls: number;
  toolCacheHits: number;
  directServed: boolean;
}

export function newTurnUsage(sessionId: string): TurnUsage {
  return { sessionId, startedAt: Date.now(), steps: [], toolCalls: 0, toolCacheHits: 0, directServed: false };
}

export function addLlmStep(
  u: TurnUsage,
  step: Omit<UsageStep, 'requests'> & { requests?: number },
): void {
  u.steps.push({ requests: 1, ...step });
}

export function addToolCall(u: TurnUsage, cached: boolean): void {
  u.toolCalls++;
  if (cached) u.toolCacheHits++;
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  toolCalls: number;
  toolCacheHits: number;
  directServed: boolean;
  byTier: Record<CostTier, { requests: number; tokens: number }>;
  steps: UsageStep[];
}

export function usageTotals(u: TurnUsage): UsageTotals {
  const byTier: Record<CostTier, { requests: number; tokens: number }> = {
    0: { requests: 0, tokens: 0 },
    1: { requests: 0, tokens: 0 },
    2: { requests: 0, tokens: 0 },
  };
  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estimated = false;
  for (const s of u.steps) {
    requests += s.requests;
    promptTokens += s.promptTokens;
    completionTokens += s.completionTokens;
    if (s.estimated) estimated = true;
    byTier[s.tier].requests += s.requests;
    byTier[s.tier].tokens += s.promptTokens + s.completionTokens;
  }
  return {
    requests,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated,
    toolCalls: u.toolCalls,
    toolCacheHits: u.toolCacheHits,
    directServed: u.directServed,
    byTier,
    steps: u.steps,
  };
}

/** Estimated input-token cost of sending the tool definitions on one call. */
export function toolsSchemaTokensEstimate(toolsPayloadChars: number): number {
  return estimateTokens(' '.repeat(toolsPayloadChars));
}

// ---------------------------------------------------------------------------
// Per-session usage history (for "show usage" — direct, no model call).
// In-memory only, last 20 turns per session. Survives while the server runs.
// ---------------------------------------------------------------------------
const sessionTurns = new Map<string, UsageTotals[]>();

export function recordTurnUsage(sessionId: string, totals: UsageTotals): void {
  if (!sessionId) return;
  const list = sessionTurns.get(sessionId) || [];
  list.push(totals);
  if (list.length > 20) list.splice(0, list.length - 20);
  sessionTurns.set(sessionId, list);
}

export function sessionUsageSummary(sessionId: string): {
  turns: number;
  requests: number;
  totalTokens: number;
  toolCalls: number;
  toolCacheHits: number;
  directTurns: number;
  byTier: Record<CostTier, { requests: number; tokens: number }>;
} | null {
  const list = sessionTurns.get(sessionId);
  if (!list || !list.length) return null;
  const byTier: Record<CostTier, { requests: number; tokens: number }> = {
    0: { requests: 0, tokens: 0 },
    1: { requests: 0, tokens: 0 },
    2: { requests: 0, tokens: 0 },
  };
  let requests = 0;
  let totalTokens = 0;
  let toolCalls = 0;
  let toolCacheHits = 0;
  let directTurns = 0;
  for (const t of list) {
    requests += t.requests;
    totalTokens += t.totalTokens;
    toolCalls += t.toolCalls;
    toolCacheHits += t.toolCacheHits;
    if (t.directServed) directTurns++;
    (Object.keys(byTier) as unknown as CostTier[]).forEach((k) => {
      byTier[k].requests += t.byTier[k].requests;
      byTier[k].tokens += t.byTier[k].tokens;
    });
  }
  return { turns: list.length, requests, totalTokens, toolCalls, toolCacheHits, directTurns, byTier };
}
