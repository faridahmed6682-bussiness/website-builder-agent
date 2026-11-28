// Browser-worker client — calls the user's existing Nexus browser worker
// (Railway primary + optional secondary). Port of Nexus-ai6
// BrowserWorkerClient.kt (simplified: no Android tab bookkeeping, no FCM).
// Auth: `x-api-key: <BROWSER_WORKER_KEY>` on every call.
// Env: BROWSER_WORKER_URL (primary), BROWSER_WORKER_URL2 (secondary, optional),
// BROWSER_WORKER_KEY. All functions return clean errors when unconfigured.
export interface WorkerConfig {
  primaryUrl: string;
  secondaryUrl: string;
  apiKey: string;
}

export function getWorkerConfig(): WorkerConfig | null {
  const primaryUrl = (process.env.BROWSER_WORKER_URL || '').replace(/\/$/, '');
  const apiKey = process.env.BROWSER_WORKER_KEY || '';
  if (!primaryUrl || !apiKey) return null;
  return {
    primaryUrl,
    secondaryUrl: (process.env.BROWSER_WORKER_URL2 || '').replace(/\/$/, ''),
    apiKey,
  };
}

export function isWorkerConfigured(): boolean {
  return getWorkerConfig() !== null;
}

async function workerFetch(
  cfg: WorkerConfig,
  baseUrl: string,
  path: string,
  opts: RequestInit = {},
  timeoutMs = 30000,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // plain-text response
    }
    if (!res.ok) {
      const err: any = new Error(`Browser worker HTTP ${res.status}: ${String(text).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Binary fetch for endpoints that return raw bytes (live frame JPEG). */
async function workerFetchBinary(
  cfg: WorkerConfig,
  baseUrl: string,
  path: string,
  timeoutMs = 15000,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { 'x-api-key': cfg.apiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`Browser worker HTTP ${res.status}: ${String(text).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** The worker pool holds 4 browser contexts total. When it is full, the
 * worker refuses with 429 + a BN+EN message ("4 browsers already running").
 * That message reaches the site through workerFetch (err.status = 429). */
export function isPoolFullError(err: any): boolean {
  const msg = String(err?.message || '');
  return err?.status === 429 && /4 browsers already running|already running/i.test(msg);
}

/** Pool-full errors get one actionable line appended: the 4-context pool is
 * full because live browser tabs are open — close one first, then retry. */
export function withPoolFullHint(err: any): Error {
  if (!isPoolFullError(err)) return err instanceof Error ? err : new Error(String(err));
  const e: any = new Error(`${err.message} — the 4-context pool is full because live browser tabs are open; close a live tab in the Browser tab first, then retry.`);
  e.status = err.status;
  return e;
}

/** POST /api/browse {task, url?} — returns the worker's summary/result text. */
export async function runBrowseTask(task: string, url?: string): Promise<string> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  const body = await workerFetch(cfg, cfg.primaryUrl, '/api/browse', {
    method: 'POST',
    body: JSON.stringify({ task, ...(url ? { url } : {}) }),
  }, 180000);
  const text = body?.result || body?.summary || body?.text || (typeof body === 'string' ? body : '');
  return String(text || '').slice(0, 6000);
}

export interface BrowseJobInput {
  type?: string;
  url: string;
  selector?: string;
  clip?: { x: number; y: number; width: number; height: number };
  fields?: Array<{ selector: string; value: string }>;
  submit?: boolean;
  allowPassword?: boolean;
  checkoutApproved?: boolean;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
}

export interface BrowseJobResult {
  jobId: string;
  workerUrl: string;
  status: string;
  result?: string;
  error?: string;
}

const TERMINAL_OK = new Set(['done', 'completed', 'success']);
const TERMINAL_FAIL = new Set(['failed', 'error', 'cancelled']);
const NEEDS_USER = new Set(['paused', 'paused-needs-user', 'needs-user', 'waiting-user', 'challenge']);

/**
 * Create a job on the worker and poll it (5 s interval, up to 10 min).
 * Heavy/long jobs prefer the secondary worker when one is configured;
 * a job is always polled on the worker that created it.
 */
export async function runBrowseJob(input: BrowseJobInput, opts?: { preferSecondary?: boolean }): Promise<BrowseJobResult> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  if (!input.url) throw new Error('browse_job requires a url.');
  const base = opts?.preferSecondary && cfg.secondaryUrl ? cfg.secondaryUrl : cfg.primaryUrl;
  // Flat top-level JSON body — never wrapped in `params`.
  let created: any;
  try {
    created = await workerFetch(cfg, base, '/api/job', {
      method: 'POST',
      body: JSON.stringify({ type: input.type || 'read', ...input }),
    }, 30000);
  } catch (err: any) {
    // Pool full (4 live tabs open): surface the close-a-tab guidance
    // instead of a bare worker 429 — the job needs a free context.
    throw withPoolFullHint(err);
  }
  const jobId = created?.jobId || created?.id || '';
  if (!jobId) throw new Error('Browser worker did not return a job id.');
  const deadline = Date.now() + 10 * 60 * 1000;
  let last: any = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      last = await workerFetch(cfg, base, `/api/job/${encodeURIComponent(jobId)}`, {}, 30000);
    } catch (err: any) {
      // Transport error: keep polling until the deadline.
      continue;
    }
    const status = String(last?.status || '').toLowerCase();
    if (TERMINAL_OK.has(status)) {
      const result = last?.result;
      return { jobId, workerUrl: base, status, result: typeof result === 'string' ? result.slice(0, 4000) : JSON.stringify(result ?? '').slice(0, 4000) };
    }
    if (TERMINAL_FAIL.has(status)) {
      return { jobId, workerUrl: base, status, error: String(last?.error || 'Job failed').slice(0, 300) };
    }
    if (NEEDS_USER.has(status)) {
      return {
        jobId,
        workerUrl: base,
        status,
        error: 'Job paused — it needs you (CAPTCHA / login). Solve the challenge in your browser, then resume the job.',
      };
    }
  }
  return { jobId, workerUrl: base, status: 'timeout', error: 'Job did not finish within 10 minutes.' };
}

/** POST /api/screenshot {url, selector?, clip?} → {jpegBase64, width, height}. */
export async function getScreenshot(url: string, selector?: string): Promise<{ jpegBase64: string; width?: number; height?: number }> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  let body: any;
  try {
    body = await workerFetch(cfg, cfg.primaryUrl, '/api/screenshot', {
      method: 'POST',
      body: JSON.stringify({ url, ...(selector ? { selector } : {}) }),
    }, 60000);
  } catch (err: any) {
    // Pool full (4 live tabs open): the screenshot needs a free context —
    // tell the caller to close a live tab first.
    throw withPoolFullHint(err);
  }
  const jpegBase64 = body?.jpegBase64 || body?.jpeg || body?.image || '';
  if (!jpegBase64) throw new Error('Browser worker returned no screenshot (the worker may not expose /api/screenshot).');
  return { jpegBase64, width: body?.width, height: body?.height };
}

/** POST /api/job/:id/resume {cookies} — resume a paused job after the user solved a challenge. */
export async function resumeBrowseJob(jobId: string, cookies: Array<{ name: string; value: string; domain?: string }>): Promise<boolean> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  await workerFetch(cfg, cfg.primaryUrl, `/api/job/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ cookies }),
  }, 30000);
  return true;
}

/** GET /health — wake/keep-alive ping. */
export async function pingWorker(): Promise<boolean> {
  const cfg = getWorkerConfig();
  if (!cfg) return false;
  try {
    await workerFetch(cfg, cfg.primaryUrl, '/health', {}, 10000);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Live browser sessions (Muse-like Browser tab) — the worker half exposes:
//   POST /api/live/start, POST /api/live/:id/action, POST /api/live/:id/input,
//   POST /api/live/:id/close, GET /api/live/:id/frame (+ screencast stream).
// The worker key stays server-side: these functions are never called from
// the frontend — the frontend talks to /api/browser/live/* on this server,
// which proxies here. A session is one live page shared by the agent's
// browser_* tools (via execCtx.liveSessionId) and the user's Browser tab.
// ---------------------------------------------------------------------------

export interface LiveSessionInfo {
  id: string;
  url?: string;
  width?: number;
  height?: number;
  paused?: boolean;
}

/** POST /api/live/start {url?, width?, height?} — open a live page. */
export async function startLiveSession(
  url?: string,
  opts?: { width?: number; height?: number },
): Promise<LiveSessionInfo> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  let body: any;
  try {
    body = await workerFetch(cfg, cfg.primaryUrl, '/api/live/start', {
      method: 'POST',
      body: JSON.stringify({
        ...(url ? { url } : {}),
        ...(opts?.width ? { width: opts.width } : {}),
        ...(opts?.height ? { height: opts.height } : {}),
      }),
    }, 30000);
  } catch (err: any) {
    // Pool full: a 5th tab has no context — the caller turns this into
    // the "close a tab first" message for the user/agent.
    throw withPoolFullHint(err);
  }
  const id = body?.sessionId || body?.id || '';
  if (!id) throw new Error('Browser worker did not return a live session id.');
  return { id, url: body?.url || url, width: body?.width, height: body?.height, paused: Boolean(body?.paused) };
}

/** POST /api/live/:id/action {action, ...payload} — goto / pause / resume / etc. */
export async function liveAction(
  sessionId: string,
  action: string,
  payload?: Record<string, any>,
): Promise<any> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  if (!sessionId) throw new Error('liveAction needs a session id.');
  return workerFetch(cfg, cfg.primaryUrl, `/api/live/${encodeURIComponent(sessionId)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action, ...(payload || {}) }),
  }, 30000);
}

/** POST /api/live/:id/input — pointer/keyboard/type events for a live page.
 * Translates the Browser tab's event shapes to the worker's input shapes:
 *   click  {x,y,button}        -> {type:'mouse', kind:'click', x, y, button}
 *   scroll {x?,y?,deltaX,deltaY} -> {type:'mouse', kind:'wheel', x, y, deltaX, deltaY}
 *   key    {key, kind?}        -> {type:'key', key, kind}
 *   type   {text}              -> {type:'type', text} (keyboard.type on the
 *                                   focused element; worker input supports it)
 *   mouse  {...}               -> passed through as-is.
 * Scroll without a point defaults to the viewport centre (683, 384). */
export async function liveInput(
  sessionId: string,
  event: Record<string, any>,
): Promise<any> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  if (!sessionId) throw new Error('liveInput needs a session id.');
  const ev = event || {};
  let out: Record<string, any>;
  if (ev.type === 'click') {
    out = { type: 'mouse', kind: 'click', x: Number(ev.x) || 0, y: Number(ev.y) || 0, button: ev.button || 'left', ...(ev.clickCount ? { clickCount: ev.clickCount } : {}) };
  } else if (ev.type === 'scroll') {
    out = { type: 'mouse', kind: 'wheel', x: Number(ev.x) || 683, y: Number(ev.y) || 384, deltaX: Number(ev.deltaX) || 0, deltaY: Number(ev.deltaY) || 0 };
  } else if (ev.type === 'key') {
    out = { type: 'key', key: ev.key, ...(ev.kind ? { kind: ev.kind } : {}) };
  } else if (ev.type === 'type') {
    out = { type: 'type', text: ev.text || '' };
  } else if (ev.type === 'move') {
    out = { type: 'mouse', kind: 'move', x: Number(ev.x) || 0, y: Number(ev.y) || 0 };
  } else {
    out = ev; // 'mouse'/'key' already in worker shape — pass through.
  }
  return workerFetch(cfg, cfg.primaryUrl, `/api/live/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    body: JSON.stringify(out),
  }, 30000);
}

/** POST /api/live/:id/close — end a live session. */
export async function closeLiveSession(sessionId: string): Promise<boolean> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  if (!sessionId) throw new Error('closeLiveSession needs a session id.');
  await workerFetch(cfg, cfg.primaryUrl, `/api/live/${encodeURIComponent(sessionId)}/close`, {
    method: 'POST',
    body: JSON.stringify({}),
  }, 30000);
  return true;
}

/** Pause/resume a live session (Take over / Give back to agent).
 * Uses the worker's dedicated pause endpoint — the worker's /action
 * switch does NOT accept 'pause'/'resume'. */
export async function setLiveSessionPaused(sessionId: string, paused: boolean): Promise<any> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  if (!sessionId) throw new Error('setLiveSessionPaused needs a session id.');
  return workerFetch(cfg, cfg.primaryUrl, `/api/live/${encodeURIComponent(sessionId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ paused }),
  }, 30000);
}

/** GET /api/live/:id/frame — one screencast frame (base64 JPEG).
 * The worker returns raw binary JPEG, so this fetches bytes (not JSON)
 * and base64-encodes them here. */
export async function getLiveFrame(sessionId: string): Promise<{ image: string; width?: number; height?: number }> {
  const cfg = getWorkerConfig();
  if (!cfg) throw new Error('Browser worker is not configured (set BROWSER_WORKER_URL + BROWSER_WORKER_KEY).');
  if (!sessionId) throw new Error('getLiveFrame needs a session id.');
  const buf = await workerFetchBinary(cfg, cfg.primaryUrl, `/api/live/${encodeURIComponent(sessionId)}/frame`, 15000);
  if (!buf.length) throw new Error('Browser worker returned no live frame.');
  return { image: `data:image/jpeg;base64,${buf.toString('base64')}` };
}
