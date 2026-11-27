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
  const created = await workerFetch(cfg, base, '/api/job', {
    method: 'POST',
    body: JSON.stringify({ type: input.type || 'read', ...input }),
  }, 30000);
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
  const body = await workerFetch(cfg, cfg.primaryUrl, '/api/screenshot', {
    method: 'POST',
    body: JSON.stringify({ url, ...(selector ? { selector } : {}) }),
  }, 60000);
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
