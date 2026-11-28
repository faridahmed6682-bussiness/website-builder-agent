// Embedded router — in-process OpenAI-compatible router.
//
// The agent's LLM calls go through here by default (no external FreeLLMAPI
// service needed). It speaks the same /v1/chat/completions interface, so the
// agent's streaming loop needs no changes — it just points at the internal
// endpoint. An external FreeLLMAPI (FREE_LLM_API_URL) remains an optional
// override; day-to-day work uses this router.
//
// Routing: quality-ordered chain (modelChain) across Gemini / Groq /
// OpenRouter. On 429 / 5xx / timeout -> next model in the chain (same task,
// same quality tier if possible), with per-key rotation inside each provider.
// Limits are OBSERVED (429s + Retry-After), never assumed.
//
// Usage is tracked per model (requests + tokens when the provider reports
// them) for the dashboard Usage tab. Streaming responses report requests
// only — token counts for streams are not visible without reading the stream.
import fs from 'fs/promises';
import path from 'path';
import type { Express, Request, Response as ExpressResponse } from 'express';
import {
  getChainForTask,
  recordModelFailure,
  recordModelSuccess,
  noteModelAttempt,
  modelChainStatus,
  listCatalogIds,
  parseRetryAfter,
  isModelExcluded,
  type TaskKind,
} from '../agent/modelChain.ts';
import { listRouterKeys, recordRouterKeyFailure, recordRouterKeySuccess, routerKeyStatus, getRouterApiKey, hasAnyRouterKey, NO_PROVIDER_KEYS_MESSAGE, NO_PROVIDER_KEYS_CODE, type RouterProvider } from './keys.ts';
import { callProvider, type RouterChatRequest } from './providers.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const USAGE_FILE = path.join(DATA_DIR, 'router-usage.json');

// ---------------------------------------------------------------------------
// Model -> provider
// ---------------------------------------------------------------------------
export function providerOfModel(model: string): RouterProvider {
  const m = model.toLowerCase();
  if (m.endsWith(':free')) return 'openrouter';
  if (m.startsWith('openrouter/')) return 'openrouter';
  if (m.startsWith('openai/gpt-oss') || m.startsWith('qwen/qwen3.8')) return 'groq';
  if (/^(google\/)?gemini/.test(m) || /^gemma/.test(m) || m.startsWith('google/gemma')) return 'gemini';
  if (m.startsWith('nvidia/') || m.startsWith('particle-ai/') || m.startsWith('inclusionai/') || m.startsWith('baidu/') || m.startsWith('liquid/') || m.startsWith('recursive/')) return 'openrouter';
  if (m.startsWith('groq/')) return 'groq';
  return 'gemini'; // bare ids are Gemini models by default
}

function resolveAutoModel(auto: string): string {
  const chain = (task: TaskKind): string[] => getChainForTask(task, undefined, 8).map((e) => e.model);
  const cheap = (): string => {
    const chat = chain('chat');
    return chat.find((id) => /flash-lite|gpt-oss-20b|lfm-3|ling-3\.2-flash/i.test(id)) || chat[chat.length - 1] || 'gemini-3.1-flash-lite';
  };
  switch (auto) {
    case 'auto:smart':
    case 'auto:reliable':
      return chain('coding')[0] || 'gemini-4-hydrogen';
    case 'auto:fast':
    case 'auto:cheap':
      return cheap();
    case 'auto:balanced':
    default:
      return chain('chat')[0] || 'gemini-3.8-flash';
  }
}

// ---------------------------------------------------------------------------
// Usage tracking (dashboard Usage tab)
// ---------------------------------------------------------------------------
interface ModelUsage { requests: number; promptTokens: number; completionTokens: number; }
const usageByModel = new Map<string, ModelUsage>();
let usageLoaded = false;

async function loadUsage(): Promise<void> {
  if (usageLoaded) return;
  usageLoaded = true;
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, ModelUsage>;
    for (const [k, v] of Object.entries(parsed || {})) usageByModel.set(k, v);
  } catch { /* no usage yet */ }
}

let saveTimer: NodeJS.Timeout | null = null;
function saveUsageSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdir(DATA_DIR, { recursive: true })
      .then(() => fs.writeFile(USAGE_FILE, JSON.stringify(Object.fromEntries(usageByModel), null, 2), 'utf-8'))
      .catch(() => {});
  }, 5000);
  saveTimer.unref?.();
}

function recordUsage(model: string, promptTokens: number, completionTokens: number): void {
  const cur = usageByModel.get(model) || { requests: 0, promptTokens: 0, completionTokens: 0 };
  cur.requests++;
  cur.promptTokens += promptTokens;
  cur.completionTokens += completionTokens;
  usageByModel.set(model, cur);
  saveUsageSoon();
}

// STEP 15 (b): real token counts on the streaming path. Streaming SSE
// chunks carry the provider's usage in the final chunk — OpenAI shape
// (`usage: { prompt_tokens, completion_tokens }`, sent when
// stream_options.include_usage is requested) or Gemini native shape
// (`usageMetadata: { promptTokenCount, candidatesTokenCount }`). Returns
// null when the chunk carries no usage. The usage chunk is the LAST chunk,
// so the last non-null value wins (never summed — it is a turn total).
export function parseSseUsageChunk(json: any): { promptTokens: number; completionTokens: number } | null {
  const u = json?.usage;
  if (u && typeof u.prompt_tokens === 'number') {
    return { promptTokens: u.prompt_tokens, completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0 };
  }
  const m = json?.usageMetadata ?? json?.usage_metadata;
  if (m && typeof m.promptTokenCount === 'number') {
    return { promptTokens: m.promptTokenCount, completionTokens: typeof m.candidatesTokenCount === 'number' ? m.candidatesTokenCount : 0 };
  }
  return null;
}

/** Rough token estimate (~1 token per 4 chars) — only the fallback when a
 * provider sends no usage at all. Never record (0, 0) for a served reply. */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

// STEP 15 (b): wrap an upstream SSE response so its bytes pass through
// unchanged while the final usage chunk is captured. Exactly one
// recordUsage call happens per stream: the provider-reported numbers when
// a usage chunk arrived, otherwise an estimate from the streamed content
// (completion) and the request messages + tools (prompt). The wrapper is
// transparent to the relay in mountRouter (it just reads response.body).
export function meterStreamUsage(model: string, req: RouterChatRequest, upstream: Response): Response {
  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    recordUsage(model, estimateTokensFromChars(JSON.stringify(req.messages ?? []).length + JSON.stringify(req.tools ?? []).length), 0);
    return upstream;
  }
  const promptChars = JSON.stringify(req.messages ?? []).length + JSON.stringify(req.tools ?? []).length;
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let completionChars = 0;
  let recorded = false;
  const recordOnce = (): void => {
    if (recorded) return;
    recorded = true;
    if (usage) recordUsage(model, usage.promptTokens, usage.completionTokens);
    else recordUsage(model, estimateTokensFromChars(promptChars), estimateTokensFromChars(completionChars));
  };
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
            try {
              const json = JSON.parse(trimmed.slice(5).trim());
              const u = parseSseUsageChunk(json);
              if (u) usage = u;
              const content = json?.choices?.[0]?.delta?.content;
              if (typeof content === 'string') completionChars += content.length;
            } catch { /* not a JSON SSE data line — ignore */ }
          }
        }
        const tail = decoder.decode();
        if (tail) {
          buffer += tail;
          for (const line of buffer.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
            try {
              const u = parseSseUsageChunk(JSON.parse(trimmed.slice(5).trim()));
              if (u) usage = u;
            } catch { /* ignore */ }
          }
        }
      } catch { /* upstream read failed — still record what we have */ }
      finally {
        recordOnce();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      recordOnce();
      reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, { status: upstream.status, headers: upstream.headers });
}

export async function routerUsageSummary(): Promise<{
  byModel: Array<{ model: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
  totalRequests: number;
  totalTokens: number;
  costUsd: 0;
}> {
  await loadUsage();
  const byModel = [...usageByModel.entries()]
    .map(([model, u]) => ({ model, requests: u.requests, promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.promptTokens + u.completionTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    byModel,
    totalRequests: byModel.reduce((n, m) => n + m.requests, 0),
    totalTokens: byModel.reduce((n, m) => n + m.totalTokens, 0),
    costUsd: 0, // free tiers only — cost is always $0
  };
}

// ---------------------------------------------------------------------------
// Core routing
// ---------------------------------------------------------------------------
export interface RoutedResult {
  response: Response;
  model: string;
  provider: RouterProvider;
  keyName: string;
}

/** The task this turn is really doing, derived from the user messages —
 * the chain is quality-ordered per task, so a hardcoded 'coding' sent chat
 * turns down the coding chain and vice versa. */
function taskOfRequest(req: RouterChatRequest): TaskKind {
  const text = (req.messages || [])
    .filter((m: any) => m?.role === 'user')
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .join('\n')
    .toLowerCase();
  if (/(build|make|create|website|web ?site|web ?app|app|page|landing|shop|store|dashboard|portfolio|game|code|coding|fix|bug|error|debug|deploy|html|css|javascript|typescript|react|component|function|api|database|firebase|button|form|layout|design|clone|repo|github|preview|edit|change|update|add|remove|style|responsive|pwa|install)/.test(text)) return 'coding';
  if (/(why|explain|compare|versus|analyse|analyze|reason|think|plan|decide|which is better|pros and cons|trade-?off|proof|calculate|math|research|strategy|should i|what if|evaluate|review)/.test(text)) return 'planning';
  return 'chat';
}

export async function routeChatCompletion(req: RouterChatRequest): Promise<RoutedResult> {
  await loadUsage();
  // NO KEYS AT ALL: answer immediately in Bengali and point at the Keys
  // tab. Never rotate through keyless providers and never surface a
  // misleading "trying <next model>" error (live QA 2026-11-27).
  if (!(await hasAnyRouterKey())) {
    const err: any = new Error(NO_PROVIDER_KEYS_MESSAGE);
    err.code = NO_PROVIDER_KEYS_CODE;
    throw err;
  }
  const task = taskOfRequest(req);
  let model = req.model || 'auto:balanced';
  if (model.startsWith('auto:')) model = resolveAutoModel(model);
  let lastErr = new Error('No provider key is configured. Add Gemini / Groq / OpenRouter keys in the Keys tab or as env vars (GEMINI_API_KEYS / GROQ_API_KEYS / OPENROUTER_API_KEYS).');

  // Chain for this turn, built ONCE (not re-derived per failure):
  // Gemini first — the user's 10 Gemini keys are the deepest free pool, and
  // the old quality-ordered chain starved Gemini behind OpenRouter :free
  // models — then the full cross-provider chain, de-duplicated. Bound by
  // chain length (40), not a 5-attempt cap: keyless/excluded models are
  // pre-filtered OUT, so they can no longer burn attempts.
  const keyedProviders = new Set<RouterProvider>();
  for (const p of ['gemini', 'groq', 'openrouter'] as RouterProvider[]) {
    if ((await listRouterKeys(p)).length) keyedProviders.add(p);
  }
  const ordered: string[] = [];
  const seenModels = new Set<string>();
  const pushChain = (entries: Array<{ model: string }>) => {
    for (const e of entries) {
      if (e.model.startsWith('auto:')) continue; // router pseudo-models, not callable models
      if (seenModels.has(e.model) || isModelExcluded(e.model)) continue;
      if (!keyedProviders.has(providerOfModel(e.model))) continue;
      seenModels.add(e.model);
      ordered.push(e.model);
    }
  };
  pushChain(getChainForTask(task, 'gemini', 12));
  pushChain(getChainForTask(task, undefined, 40));
  // The explicitly requested model goes first when it is keyed and live.
  if (!isModelExcluded(model) && keyedProviders.has(providerOfModel(model)) && !seenModels.has(model)) {
    ordered.unshift(model);
  } else if (seenModels.has(model)) {
    ordered.splice(ordered.indexOf(model), 1);
    ordered.unshift(model);
  }
  if (!ordered.length) {
    throw new Error('No keyed provider has a live model for this request. Add a key for Gemini, Groq or OpenRouter in the Keys tab.');
  }

  // Walk the chain. Per model, iterate ALL keys for its provider (inner key
  // loop): a 429 rotates to the next key, SAME model — only when every key
  // for the model is exhausted (or the model itself is unavailable, 404/400)
  // does the loop drop to the next model. No attempt counter is burned by
  // skips: the chain was pre-filtered, so every entry here is attempted.
  for (const chainModel of ordered) {
    model = chainModel;
    const provider = providerOfModel(model);
    const keysForModel = await listRouterKeys(provider);
    if (!keysForModel.length) continue;
    // Parallel-build key pin: a worker's sticky key is tried FIRST for
    // models of its provider, then the rest in normal order (deduped).
    // Failover below is untouched — a 429 on the pinned key rotates to the
    // next key, same model.
    const pinKeyId = req.pinKeyId;
    const orderedKeys = pinKeyId && keysForModel.some((k) => k.id === pinKeyId)
      ? [keysForModel.find((k) => k.id === pinKeyId)!, ...keysForModel.filter((k) => k.id !== pinKeyId)]
      : keysForModel;
    let modelUnavailable = false;
    for (const key of orderedKeys) {
      noteModelAttempt(model, key.id);
      try {
        const res = await callProvider(provider, model, req, key.key);
        if (res.ok) {
          recordModelSuccess(model);
          await recordRouterKeySuccess(key.id);
          if (!req.stream) {
            const text = await res.text();
            try {
              const body = JSON.parse(text);
              const u = body?.usage;
              if (u && typeof u.prompt_tokens === 'number') {
                recordUsage(model, u.prompt_tokens, u.completion_tokens || 0);
              } else {
                // No usage in the body: estimate from request + reply text
                // rather than recording (0, 0) (STEP 15 (b)).
                recordUsage(model, estimateTokensFromChars(JSON.stringify(req.messages ?? []).length + JSON.stringify(req.tools ?? []).length), estimateTokensFromChars(text.length));
              }
            } catch { recordUsage(model, estimateTokensFromChars(JSON.stringify(req.messages ?? []).length), estimateTokensFromChars(text.length)); }
            return { response: new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } }), model, provider, keyName: key.name };
          }
          // Streaming: meter the SSE (usage chunk when the provider sends
          // one, estimates otherwise) — never recordUsage(model, 0, 0).
          return { response: meterStreamUsage(model, req, res), model, provider, keyName: key.name };
        }
        const errText = await res.text().catch(() => '');
        const retryAfter = res.headers.get('retry-after');
        recordModelFailure(model, res.status, retryAfter, errText);
        await recordRouterKeyFailure(key.id, res.status, retryAfter, errText);
        lastErr = new Error(`Model ${model} failed (HTTP ${res.status}): ${errText.slice(0, 200)}`);
        // Model unavailable for every key — stop burning keys on it.
        if (res.status === 404 || res.status === 400) { modelUnavailable = true; break; }
        // 429 / 5xx / other: try the next key, SAME model.
      } catch (err: any) {
        const isTimeout = err?.name === 'AbortError';
        recordModelFailure(model, isTimeout ? 408 : undefined, null, err?.message || '');
        await recordRouterKeyFailure(key.id, isTimeout ? 408 : undefined, null, err?.message || '');
        lastErr = err;
      }
      void modelUnavailable;
    }
  }
  throw lastErr;
}

export async function routerStatus(): Promise<{
  keys: Awaited<ReturnType<typeof routerKeyStatus>>;
  models: ReturnType<typeof modelChainStatus>;
  usage: Awaited<ReturnType<typeof routerUsageSummary>>;
  catalogTotal: number;
}> {
  return {
    keys: await routerKeyStatus(),
    models: modelChainStatus(),
    usage: await routerUsageSummary(),
    catalogTotal: listCatalogIds().length,
  };
}

// ---------------------------------------------------------------------------
// HTTP mount (same Express app, same port — one service)
// ---------------------------------------------------------------------------
export function mountRouter(app: Express): void {
  const requireRouterKey = (req: Request, res: ExpressResponse, next: () => void): void => {
    const auth = String(req.headers.authorization || '');
    if (auth === `Bearer ${getRouterApiKey()}`) return next();
    res.status(401).json({ error: { message: 'Invalid router API key. Set ROUTER_API_KEY env (or use the agent itself, which calls this endpoint internally).', type: 'invalid_request_error' } });
  };

  app.post('/v1/chat/completions', requireRouterKey, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.model || !Array.isArray(body.messages)) {
        return res.status(400).json({ error: { message: 'model and messages are required.', type: 'invalid_request_error' } });
      }
      const { response, model, provider, keyName } = await routeChatCompletion({
        model: String(body.model),
        messages: body.messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
        stream: Boolean(body.stream),
        max_tokens: body.max_tokens,
        reasoning_effort: body.reasoning_effort,
      });
      res.setHeader('X-Served-Model', model);
      res.setHeader('X-Served-Provider', provider);
      res.setHeader('X-Served-Key', keyName);
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        const reader = (response.body as any)?.getReader?.();
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
          } finally {
            reader.releaseLock?.();
          }
          return res.end();
        }
        // Fallback: pipe the web stream.
        const nodeStream = (Response as any).prototype;
        void nodeStream;
        res.status(502).json({ error: { message: 'Upstream stream could not be relayed.', type: 'server_error' } });
        return;
      }
      const text = await response.text();
      res.setHeader('Content-Type', 'application/json');
      res.status(response.status).send(text);
    } catch (err: any) {
      const msg = String(err?.message || err || 'Router failed');
      const status = err?.code === NO_PROVIDER_KEYS_CODE || /No .* key is configured/i.test(msg) ? 400 : 502;
      res.status(status).json({ error: { message: msg.slice(0, 500), type: 'server_error' } });
    }
  });

  app.get('/v1/models', requireRouterKey, (_req, res) => {
    const ids = listCatalogIds();
    res.json({
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: providerOfModel(id) })),
    });
  });

  app.get('/v1/router/status', requireRouterKey, async (_req, res) => {
    res.json(await routerStatus());
  });
}

// Re-export for callers that only need the retry parser.
export { parseRetryAfter };
