// One-off LLM calls through the FreeLLMAPI router (no streaming).
// Used by tools that need a sub-call (build_page, browse_vision) — the main
// agent loop lives in apiOrchestrator.ts; this is a thin client for tools.
// (Reads env directly and imports nothing from apiOrchestrator, so the
// orchestrator can import the routing helpers here without a cycle.)
//
// MODEL CHAINS ARE LIVE-DISCOVERED (see server/modelChain.ts). The lists
// below are SEED CANDIDATES ONLY — an ID enters a chain only after being
// verified present in the live catalog (FreeLLMAPI /v1/models or OpenRouter
// /v1/models). Earlier briefs' IDs (qwen3-coder-480b:free, deepseek-r1:free)
// are NOT assumed free: OpenRouter's roster turned over (checked 26 Nov
// 2026) and those models are no longer free there; if the live catalog does
// not list them, they are dropped automatically. When discovery has no data,
// the chains fall back to the router's own named chains (auto:smart /
// auto:balanced / auto:fast) — never to a hardcoded model ID.
// Coding chain puts Gemini 4 Hydrogen first when live (free tier, everyday
// coding; vendor-reported Terminal-Bench 4.1 57% vs Gemini 3.8 Flash 18.2%,
// FrontierCode 36.3% vs 18.7%, Artificial Analysis index 51 vs 31 — vendor
// figures, not independently verified).
// Quotas are PER PROJECT, not per key, and OBSERVED, not assumed: Google
// publishes NO fixed free-tier numbers for Hydrogen — per-project limits
// vary (see aistudio.google.com/rate-limit). Flash-Lite's published
// reference is 500 RPD (the biggest free daily quota), but the agent never
// relies on assumed numbers: a 429 is the signal, and the chain rotates.
// NEVER route to paid models: Argon, 3.1 Pro Preview, Neon, Carbon.
//
// TIERED ROUTING (Hydrogen-saving): the tool loop runs on the CHEAP model
// (Flash-Lite / auto:fast, Tier 1); Hydrogen (Tier 2) is called ONLY where
// its quality matters — the plan step, debugging, and the final review.
// The cheap model hands Hydrogen a SHORT BRIEF (~200-300 tokens), never the
// full tool output. If the cheap model makes bad tool choices, the guardrail
// escalates that turn to Hydrogen (see apiOrchestrator.ts).
import { getChainForTask, verifyLive, noteModelAttempt, recordModelSuccess, recordModelFailure, type TaskKind } from './modelChain.ts';

// Seed candidates (verified live before use — see modelChain.verifyLive).
export const CODING_SEED = [
  // Tier 3 (coding): Hydrogen across the 10 Gemini keys first, then 3.8 Flash,
  // then LIVE-discovered OpenRouter free coding models (verified 27 Nov 2026:
  // particle-1, nemotron-3-ultra, gemma-4-31b), then Groq free coding models
  // (gpt-oss-120b/20b). Every non-auto ID is verified live before use.
  'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.6-flash',
  'gemini-3.1-flash-lite', 'particle-ai/particle-1:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free',
  'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'auto:smart',
];
export const PLANNING_SEED = [
  // Tier 2 (planning): Hydrogen xhigh (hard) / high (normal) first; free
  // reasoning alternatives are verified live — DeepSeek R1's free status
  // changes often and it is NOT free on OpenRouter as of 27 Nov 2026, so it
  // is a candidate only and is dropped when the catalog lacks it. Nemotron 3
  // Ultra (free, reasoning) is the live alternative.
  'gemini-4-hydrogen', 'deepseek/deepseek-r1:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free', 'gemini-3.8-flash',
  'qwen/qwen3.6-plus:free', 'auto:smart',
];
/** Legacy seed (router profiles only). chatChain() no longer uses the
 * quality-ordered 'chat' chain — casual answers run on the cheap chain
 * (see chatChain), so this stays only for backwards-compatible exports. */
export const CHAT_SEED = ['auto:fast', 'auto:balanced'];

/** Cheapest capable free models for the TOOL LOOP (Tier 1). Flash-Lite has
 * the biggest free daily quota (published reference: 500 RPD per project —
 * 10 projects ≈ 5,000/day; observed limits apply); Groq gpt-oss-20b is the
 * fast Groq free model (30 RPM / 1,000 RPD per org). auto:fast is the
 * router's fast profile (blends fast models across providers). Verified live
 * before use; if no cheap model is live, the chain is just ['auto:fast']. */
export const CHEAP_SEED = [
  'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'openai/gpt-oss-20b', 'auto:fast',
];

function envChain(varName: string): string[] {
  return (process.env[varName] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Env override chain: the env list verified live (unverified IDs dropped
 * with a warning), auto: entries always kept (router profiles, not model
 * IDs). Returns null when the env var is empty or nothing survives.
 */
function verifiedEnvChain(varName: string): string[] | null {
  const override = envChain(varName);
  if (!override.length) return null;
  const verified = verifyLive(override);
  const dropped = override.filter((m) => !verified.includes(m) && !m.startsWith('auto:'));
  if (dropped.length) console.warn(`[llm] Env ${varName} models not in the live catalog, dropped: ${dropped.join(', ')}`);
  const kept = [...verified, ...override.filter((m) => m.startsWith('auto:'))];
  return kept.length ? kept : null;
}

/**
 * Live chain for a task: env override (verified live, unverified IDs dropped
 * with a warning) else the discovered quality-ordered chain. Never returns
 * an unverified hardcoded model ID — the floor is the router's named chains.
 */
export function liveChain(task: TaskKind, envVar: string, seed: string[]): string[] {
  const override = verifiedEnvChain(envVar);
  if (override) return override;
  const chain = getChainForTask(task, undefined, 8).map((e) => e.model);
  if (chain.length) return chain;
  return seed.filter((m) => m.startsWith('auto:'));
}

export function codingChain(): string[] { return liveChain('coding', 'FREE_LLM_API_MODEL_CODING', CODING_SEED); }
export function planningChain(): string[] { return liveChain('planning', 'FREE_LLM_API_MODEL_PLANNING', PLANNING_SEED); }
/**
 * Casual/chat answers run on the CHEAP model (Tier 1) — never Hydrogen.
 * The old implementation used liveChain('chat'), whose quality-ordered
 * chain scores Hydrogen highest for chat (90, modelChain.ts), so a plain
 * "hi" burned Hydrogen quota — contradicting the cheap-model rule (cheap
 * model for tools/casual chat; Hydrogen ONLY for planning/coding/debugging/
 * review) and the intent gate's "one fast-model call" comment. Env
 * override FREE_LLM_API_MODEL_CHAT (verified live) wins; otherwise the
 * cheap chain: live-verified Flash-Lite / gpt-oss-20b, auto:fast floor.
 * This also covers the intent gate's classification call and chatOnce's
 * default chain (both call chatChain()).
 */
export function chatChain(): string[] {
  return verifiedEnvChain('FREE_LLM_API_MODEL_CHAT') ?? cheapChain();
}

/**
 * Cheap-model chain for the tool loop (Tier 1). Unlike liveChain() this does
 * NOT take the discovered quality-ordered chain — that would put Hydrogen /
 * 3.8 Flash first. It takes only the cheap seeds verified live, in order,
 * with auto:fast as the floor, so the loop never burns Hydrogen quota.
 */
export function cheapChain(): string[] {
  const override = verifiedEnvChain('FREE_LLM_API_MODEL_CHEAP');
  if (override) return override;
  const verified = verifyLive(CHEAP_SEED.filter((m) => !m.startsWith('auto:')));
  return [...verified, 'auto:fast'];
}

// Backwards-compatible names (now dynamic — call the getters for fresh chains).
export const CODING_MODEL_CHAIN = CODING_SEED;
export const REASONING_MODEL_CHAIN = PLANNING_SEED;
export const CHAT_MODEL_CHAIN = CHAT_SEED;
export const PLANNING_MODEL_CHAIN = PLANNING_SEED;
/** The execution chain is the CHEAP chain: the tool loop runs on Flash-Lite /
 * auto:fast (Tier 1). Hydrogen (coding chain) is reserved for planning,
 * debugging and review — see routeTurnModel. */
export const EXECUTION_MODEL_CHAIN = CHEAP_SEED;

export type PlanningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** xhigh only for hard plans (long/complex briefs); high is the default knee. */
export function pickPlanningEffort(prompt: string): PlanningEffort {
  const p = (prompt || '').toLowerCase();
  if (p.length > 1500) return 'xhigh';
  if (/(full[ -]stack|full app|complete (app|website|system)|e-?commerce|dashboard|multi-?file|architecture|complex|step-?by-?step|decision tree|migrate|refactor)/.test(p)) {
    return 'xhigh';
  }
  return 'high';
}

function isModelError(status: number, text: string): boolean {
  if (status === 404 || status === 400) return true;
  return /model (not found|not available|unsupported|does not exist)/i.test(text || '');
}

export interface ChatOnceOptions {
  system?: string;
  user: string;
  /** Base64 JPEG + question for vision calls. */
  imageBase64?: string;
  imageMime?: string;
  chain?: string[];
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Parallel multi-agent build (2026-11-29): the router tries this key id
   * FIRST for models of its provider (see RouterChatRequest.pinKeyId). The
   * external FreeLLMAPI path ignores it — pinning only applies to the
   * embedded router. Never a key value, only the key id.
   */
  pinKeyId?: string;
  /**
   * FreeLLMAPI translates `reasoning_effort` into the provider's thinking
   * config (Gemini thinking_level). 'high' is the default knee; 'xhigh'
   * only for hard plans. If the router rejects the value (HTTP 400), the
   * call is retried once without it before moving to the next model.
   */
  reasoningEffort?: PlanningEffort;
}

/** Single non-streaming chat completion; tries each model in the chain in order. */
export async function chatOnce(opts: ChatOnceOptions): Promise<{ text: string; model: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const baseUrl = (process.env.FREE_LLM_API_URL || '').replace(/\/$/, '');
  const apiKey = process.env.FREE_LLM_API_KEY || '';
  // MERGE: no external FreeLLMAPI URL/key -> the embedded in-process router
  // (server/router/) serves the request. The router does its own
  // quality-ordered failover, so one call here walks the whole chain.
  const useEmbeddedRouter = !baseUrl || !apiKey;
  const chain = opts.chain?.length ? opts.chain : chatChain();
  const timeoutMs = Math.min(Math.max(opts.timeoutMs || 60000, 5000), 120000);
  const userContent: any = opts.imageBase64
    ? [
        { type: 'text', text: opts.user },
        {
          type: 'image_url',
          image_url: { url: `data:${opts.imageMime || 'image/jpeg'};base64,${opts.imageBase64}` },
        },
      ]
    : opts.user;
  const messages = [
    ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
    { role: 'user', content: userContent },
  ];
  if (useEmbeddedRouter) {
    const { routeChatCompletion } = await import('../router/index.ts');
    const { response, model: usedModel } = await routeChatCompletion({
      model: chain[0],
      messages,
      max_tokens: opts.maxTokens || 4000,
      reasoning_effort: opts.reasoningEffort,
      stream: false,
      pinKeyId: opts.pinKeyId,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Embedded router failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    const body = JSON.parse(text);
    const content = body?.choices?.[0]?.message?.content;
    const out = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map((p: any) => p?.text || '').join('')
      : '';
    const u = body?.usage;
    const usage = u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
      ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens ?? (u.prompt_tokens + u.completion_tokens) }
      : undefined;
    return { text: out, model: usedModel, usage };
  }
  let lastErr = new Error('No model in the chain answered.');
  for (const model of chain) {
    // One attempt with reasoning_effort, plus one retry without it if the
    // router rejects the value (HTTP 400) — never burn the chain on it.
    const effortAttempts = opts.reasoningEffort ? [opts.reasoningEffort, undefined] : [undefined];
    for (const effort of effortAttempts) {
      try {
        noteModelAttempt(model);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              max_tokens: opts.maxTokens || 4000,
              ...(effort ? { reasoning_effort: effort } : {}),
              stream: false,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const text = await res.text();
        if (!res.ok) {
          if (res.status === 400 && effort) {
            lastErr = new Error(`Model ${model} rejected reasoning_effort=${effort}; retrying without it.`);
            continue; // retry same model without the effort flag
          }
          if (isModelError(res.status, text)) {
            recordModelFailure(model, res.status, null, text);
            lastErr = new Error(`Model ${model} unavailable (${res.status}); trying next in chain.`);
            break; // next model
          }
          if (res.status === 429) {
            recordModelFailure(model, 429, res.headers.get('retry-after'), text);
            lastErr = new Error(`Model ${model} rate-limited (429); trying next in chain.`);
            break;
          }
          throw new Error(`LLM request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
        const body = JSON.parse(text);
        const content = body?.choices?.[0]?.message?.content;
        const out = typeof content === 'string' ? content : Array.isArray(content)
          ? content.map((p: any) => p?.text || '').join('')
          : '';
        recordModelSuccess(model);
        // Provider-reported usage when present (real numbers for the UI);
        // callers fall back to estimates when it is absent.
        const u = body?.usage;
        const usage = u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
          ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens ?? (u.prompt_tokens + u.completion_tokens) }
          : undefined;
        return { text: out, model, usage };
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          recordModelFailure(model, 408);
          lastErr = new Error(`Model ${model} timed out after ${timeoutMs}ms; trying next in chain.`);
          break; // next model (don't retry a timeout with/without effort)
        }
        lastErr = err;
        // Transport errors: try the next model once, then give up.
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err?.message || '')) break;
        throw err;
      }
    }
  }
  throw lastErr;
}

/** Classify a user prompt into a routing profile: 'coding' | 'reasoning' | 'chat'. */
export function classifyTask(prompt: string): 'coding' | 'reasoning' | 'chat' {
  const p = (prompt || '').toLowerCase();
  const codingRe =
    /(build|make|create|website|web ?site|web ?app|app|page|landing|shop|store|dashboard|portfolio|game|code|coding|fix|bug|error|debug|deploy|html|css|javascript|typescript|react|component|function|api|database|firebase|button|form|layout|design|clone|import|repo|github|preview|edit|change|update|add|remove|style|responsive|pwa|install)/;
  const reasoningRe =
    /(why|compare|versus|vs\.?|analyse|analyze|reason|think|plan|decide|which is better|pros and cons|trade-?off|proof|calculate|math|research|strategy|should i|what if|evaluate|review my)/;
  // NOTE (STEP 7, P1/F4): "explain" is deliberately NOT here. Pure
  // explanations are routed to one direct cheap-model answer by the intent
  // gate; if one ever reaches the loop, it is 'chat' (cheap chain), not
  // 'reasoning' (Hydrogen, high effort). Coding nouns above still win
  // first, so "explain and fix this code" stays coding.
  if (codingRe.test(p)) return 'coding';
  if (reasoningRe.test(p)) return 'reasoning';
  return 'chat';
}

export function chainForTask(task: 'coding' | 'reasoning' | 'chat'): string[] {
  if (task === 'coding') return codingChain();
  if (task === 'reasoning') return planningChain();
  return chatChain();
}

/**
 * Turn-level routing: the first model tried for a turn, from the task class.
 * TIERED (Hydrogen-saving): the tool loop runs on the CHEAP model (Tier 1)
 * for coding AND chat turns — Hydrogen is reserved for the plan step (via
 * the planning invoker), debugging and the final review pass. Reasoning
 * turns ARE the thinking work, so they run on the planner (Hydrogen) directly.
 * The orchestrator's existing failover (strategy rotation / fallback models)
 * still applies after this first choice, so a routed model that is out of
 * quota falls through to the next free model instead of failing the turn.
 * `configuredDefault` is the user's configured model (env / key pool) and is
 * used when routing is disabled via FREE_LLM_API_ROUTING=off.
 */
export function routeTurnModel(prompt: string, configuredDefault: string): string {
  if ((process.env.FREE_LLM_API_ROUTING || '').toLowerCase() === 'off') return configuredDefault;
  const task = classifyTask(prompt);
  if (task === 'reasoning') {
    const chain = planningChain();
    return chain[0] || configuredDefault;
  }
  return cheapChain()[0] || configuredDefault;
}

/** reasoning_effort for the turn's streaming call: 'high' for reasoning turns, unset otherwise (model default). */
export function turnReasoningEffort(prompt: string): PlanningEffort | undefined {
  if ((process.env.FREE_LLM_API_ROUTING || '').toLowerCase() === 'off') return undefined;
  return classifyTask(prompt) === 'reasoning' ? 'high' : undefined;
}
