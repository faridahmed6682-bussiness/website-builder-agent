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
  nextAfterFailure,
  recordModelFailure,
  recordModelSuccess,
  noteModelAttempt,
  modelChainStatus,
  listCatalogIds,
  parseRetryAfter,
  isModelExcluded,
  type TaskKind,
} from '../agent/modelChain.ts';
import { selectRouterKey, recordRouterKeyFailure, recordRouterKeySuccess, routerKeyStatus, getRouterApiKey, hasAnyRouterKey, NO_PROVIDER_KEYS_MESSAGE, NO_PROVIDER_KEYS_CODE, type RouterProvider } from './keys.ts';
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
  let model = req.model || 'auto:balanced';
  if (model.startsWith('auto:')) model = resolveAutoModel(model);
  let lastErr = new Error('No provider key is configured. Add Gemini / Groq / OpenRouter keys in the Keys tab or as env vars (GEMINI_API_KEYS / GROQ_API_KEYS / OPENROUTER_API_KEYS).');
  for (let attempt = 0; attempt < 5; attempt++) {
    // Excluded models (paid-only, retired, Baidu/Ernie) are NEVER attempted
    // — skip to the next chain entry without calling any provider.
    if (isModelExcluded(model)) {
      const next = nextAfterFailure(model, 'coding');
      if (!next) break;
      model = next.model;
      continue;
    }
    const provider = providerOfModel(model);
    const key = await selectRouterKey(provider);
    if (!key) {
      // No key for this provider — try the next model in the chain.
      const next = nextAfterFailure(model, 'coding');
      if (!next) break;
      model = next.model;
      lastErr = new Error(`No ${provider} key is configured; trying ${model}.`);
      continue;
    }
    noteModelAttempt(model, key.id);
    try {
      const res = await callProvider(provider, model, req, key.key);
      if (res.ok) {
        recordModelSuccess(model);
        await recordRouterKeySuccess(key.id);
        if (!req.stream) {
          // Non-stream: read the JSON, record real usage, return a fresh Response.
          const text = await res.text();
          try {
            const body = JSON.parse(text);
            const u = body?.usage;
            if (u && typeof u.prompt_tokens === 'number') {
              recordUsage(model, u.prompt_tokens, u.completion_tokens || 0);
            } else {
              recordUsage(model, 0, 0);
            }
          } catch { recordUsage(model, 0, 0); }
          return { response: new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } }), model, provider, keyName: key.name };
        }
        recordUsage(model, 0, 0);
        return { response: res, model, provider, keyName: key.name };
      }
      const errText = await res.text().catch(() => '');
      const retryAfter = res.headers.get('retry-after');
      recordModelFailure(model, res.status, retryAfter, errText);
      await recordRouterKeyFailure(key.id, res.status, retryAfter, errText);
      lastErr = new Error(`Model ${model} failed (HTTP ${res.status}): ${errText.slice(0, 200)}`);
      const next = nextAfterFailure(model, 'coding');
      if (!next) break;
      model = next.model;
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      recordModelFailure(model, isTimeout ? 408 : undefined, null, err?.message || '');
      await recordRouterKeyFailure(key.id, isTimeout ? 408 : undefined, null, err?.message || '');
      lastErr = err;
      const next = nextAfterFailure(model, 'coding');
      if (!next) break;
      model = next.model;
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
