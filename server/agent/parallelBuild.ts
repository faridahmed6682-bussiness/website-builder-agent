// Parallel multi-agent BUILD stage (2026-11-29).
//
// Architecture (confirmed by the user): exactly ONE main agent — the
// Planner/Orchestrator running in the chat loop — is the only agent the user
// talks to. It understands the question, splits the work into parts, assigns
// each part to a background worker, collects and merges their results, and
// gives the final answer. Worker agents are background-only: they never talk
// to the user, never appear as separate chat agents, and only surface as
// background action steps (the same way the Architect / Executor steps do
// today). The main agent stays in charge of the whole turn.
//
// How it works: after omo_coordinate plans a build, the plan's PARTS section
// (or, failing that, its file list) is split into independent parts — each a
// DISJOINT set of files, so no two workers ever write the same file. Up to
// PARALLEL_CODERS_MAX worker coders then run AT THE SAME TIME (Promise.
// allSettled), each on its OWN API key (sticky per-agent for the run — see
// assignDistinctKeys), so parallel workers never share one key and never
// block each other on per-key rate limits (Gemini ~15 RPM per key). A 429
// still rotates that worker to its next key through the router's existing
// failover (the pin only sets the FIRST key tried). A deterministic merge
// then writes each part's files in part order, and the main loop's verify /
// reviewer machinery checks the merged result exactly as it checks files the
// main agent wrote itself (the hook attaches `modifiedFiles` to the
// omo_coordinate tool result, which both loops absorb into mutatedFiles).
//
// Fail-soft everywhere: unparseable plan / <2 parts / <2 keys / every coder
// failing -> the serial path runs unchanged (the main agent builds the files
// itself in its normal rounds). A worker that fails only fails its own
// files; the main agent finishes those. Small tasks (single file / trivial)
// never reach this code at all — splitPlanIntoParts returns null and the
// turn stays serial, with zero extra calls.
//
// Free APIs only: workers run on the CHEAP chain (cheapChain() — never
// Hydrogen; coding turns already reserve Hydrogen for planning/review), and
// models are never hardcoded — the router's live chain decides. No key or
// token value is ever logged (only key ids / provider names).
import { chatOnce, cheapChain } from './llmClient.ts';
import { listRouterKeys, type RouterKey, type RouterProvider } from '../router/keys.ts';
import { executeServerTool, type ToolExecutionContext } from './geminiService.ts';
import { deployHtmlFile } from './websiteDeployer.ts';

/** Parallel coder cap — default 4, tunable via PARALLEL_CODERS_MAX (1..8). */
export const PARALLEL_CODERS_MAX: number = (() => {
  const n = Number.parseInt(process.env.PARALLEL_CODERS_MAX || '4', 10);
  if (!Number.isFinite(n)) return 4;
  return Math.min(8, Math.max(1, n));
})();

/** Per-worker output cap — matches the per-round loop cap (STEP 10). */
export const PARALLEL_CODER_MAX_TOKENS = 8000;
/** Per-worker call timeout — inside chatOnce's 5s..120s clamp. */
export const PARALLEL_CODER_TIMEOUT_MS = 90000;

export interface BuildPart {
  title: string;
  files: string[];
}

export interface ParallelCoderPartResult {
  title: string;
  files: string[];
  keyId: string;
  provider: string;
  model: string;
  status: 'done' | 'failed' | 'skipped';
  durationMs: number;
  startedAt: number;
  endedAt: number;
}

export interface ParallelBuildResult {
  ran: boolean;
  cancelled: boolean;
  parts: ParallelCoderPartResult[];
  writtenFiles: string[];
  failedFiles: string[];
  skippedFiles: string[];
  previewUrl?: string;
  deployedHtml?: string;
  startedAt: number;
  endedAt: number;
}

// ---------------------------------------------------------------------------
// Per-turn guard: the parallel build runs at most once per turn. The exec
// context is rebuilt on key rotation, so a module-level session set (cleared
// at turn start in handleOrchestratedChat) is the durable guard; the
// execCtx flag is the fast path inside one loop invocation.
// ---------------------------------------------------------------------------
const parallelBuildRanSessions = new Set<string>();
export function hasParallelBuildRun(sessionId?: string): boolean {
  return !!sessionId && parallelBuildRanSessions.has(sessionId);
}
export function markParallelBuildDone(sessionId?: string): void {
  if (sessionId) parallelBuildRanSessions.add(sessionId);
}
export function clearParallelBuildForSession(sessionId?: string): void {
  if (sessionId) parallelBuildRanSessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Plan splitting
// ---------------------------------------------------------------------------
const PROTECTED_FILES = new Set(['server.ts', 'vite.config.ts', 'tsconfig.json']);

/** Normalise a planner-mentioned path to a safe workspace-relative file, or null. */
function normalizePlanFile(raw: string): string | null {
  let f = (raw || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^[/\\]+/, '');
  if (!f || f.includes('..')) return null;
  if (PROTECTED_FILES.has(f)) return null;
  // Bare website pages route to projects/ (same rule as resolveSafePath).
  if (f === 'index.html' || (f.endsWith('.html') && !f.startsWith('projects/') && !f.startsWith('src/'))) {
    f = `projects/${f}`;
  }
  if (!(f.startsWith('projects/') || f.startsWith('src/'))) return null;
  return f;
}

/**
 * Split a planner's plan text into independent build parts (disjoint file
 * sets). Prefers the structured PARTS: section the planner prompt asks for;
 * falls back to grouping the FILE OPERATIONS file list (contiguous chunks).
 * Returns null when the build cannot be split (>=2 independent parts with
 * >=1 file each) — the caller then keeps the existing serial path.
 */
export function splitPlanIntoParts(planText: string, maxParts: number = PARALLEL_CODERS_MAX): BuildPart[] | null {
  if (!planText || !planText.trim()) return null;
  const parts: BuildPart[] = [];

  // 1) Structured PARTS: section.
  const partsIdx = planText.search(/^PARTS:\s*$/im);
  if (partsIdx >= 0) {
    const section = planText.slice(partsIdx);
    const lines = section.split('\n').slice(1);
    for (const line of lines) {
      // A new top-level section header ends the PARTS block.
      if (/^[A-Z][A-Z _-]{2,}:\s*$/.test(line)) break;
      if (/^\s*none\s*$/i.test(line)) return null; // planner: cannot be split
      const m = line.match(/^\s*\d+[.)]\s*(.+?)\s*[—–-]\s*files:\s*(.+)$/i);
      if (!m) continue;
      const files = m[2].split(',').map(normalizePlanFile).filter((x): x is string => !!x);
      if (files.length) parts.push({ title: m[1].trim().slice(0, 80), files });
    }
  }

  // 2) Fallback: group the plan's file list into contiguous chunks.
  if (parts.length < 2) {
    const found: string[] = [];
    const seen = new Set<string>();
    const re = /\b((?:projects\/|src\/)[A-Za-z0-9_.\-/]+\.(?:html|css|js|ts|tsx|json))\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(planText))) {
      const f = normalizePlanFile(m[1]);
      if (f && !seen.has(f)) { seen.add(f); found.push(f); }
    }
    if (found.length < 2) return null;
    const perPart = Math.ceil(found.length / maxParts);
    const chunked: BuildPart[] = [];
    for (let i = 0; i < found.length; i += perPart) {
      const files = found.slice(i, i + perPart);
      chunked.push({ title: `Part ${chunked.length + 1}: ${files.join(', ')}`, files });
    }
    return chunked.slice(0, maxParts);
  }

  // Dedupe files across parts (first part wins); drop emptied parts.
  const seenFiles = new Set<string>();
  const deduped: BuildPart[] = [];
  for (const p of parts) {
    const files = p.files.filter((f) => {
      if (seenFiles.has(f)) return false;
      seenFiles.add(f);
      return true;
    });
    if (files.length) deduped.push({ title: p.title, files });
  }
  if (deduped.length < 2) return null;
  // Cap parts: merge extras into the last part so every file stays covered.
  if (deduped.length > maxParts) {
    const kept = deduped.slice(0, maxParts);
    for (const extra of deduped.slice(maxParts)) kept[maxParts - 1].files.push(...extra.files);
    return kept;
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Distinct-key assignment
// ---------------------------------------------------------------------------
/**
 * Assign one DISTINCT router key per part, round-robin across providers
 * (Gemini -> Groq -> OpenRouter -> Gemini ...) so parallel workers spread
 * across providers instead of clustering on one. listRouterKeys sorts ready
 * keys (no cooldown) before cooling-down ones, so each pick prefers a
 * healthy key. Returns fewer keys than parts when the pool is short — the
 * caller caps the parts to the keys (minimum 2, else serial).
 */
export async function assignDistinctKeys(partCount: number): Promise<RouterKey[]> {
  const providers: RouterProvider[] = ['gemini', 'groq', 'openrouter'];
  // SEQUENTIAL awaits, not Promise.all: loadKeys() has a first-load race —
  // concurrent callers before the first load finishes see an empty pool
  // (keysLoaded is set before `keys` is assigned), so the first call must
  // complete before the others read. Production's routeChatCompletion
  // happens to call listRouterKeys sequentially and never hits this.
  const perProvider: RouterKey[][] = [];
  for (const p of providers) {
    perProvider.push(await listRouterKeys(p).catch(() => [] as RouterKey[]));
  }
  const assigned: RouterKey[] = [];
  const seen = new Set<string>();
  let round = 0;
  while (assigned.length < partCount) {
    let progressed = false;
    for (const list of perProvider) {
      if (assigned.length >= partCount) break;
      const k = list[round];
      if (k && !seen.has(k.id)) {
        seen.add(k.id);
        assigned.push(k);
        progressed = true;
      }
    }
    if (!progressed) break;
    round++;
  }
  return assigned;
}

// ---------------------------------------------------------------------------
// Worker coder
// ---------------------------------------------------------------------------
export type CoderFn = (opts: {
  system: string;
  user: string;
  chain: string[];
  pinKeyId?: string;
  maxTokens: number;
  timeoutMs: number;
}) => Promise<{ text: string; model: string }>;

const defaultCoderFn: CoderFn = (opts) =>
  chatOnce({
    system: opts.system,
    user: opts.user,
    chain: opts.chain,
    pinKeyId: opts.pinKeyId,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
  });

const CODER_SYSTEM = [
  'You are a background Coder worker in a parallel multi-agent build. You NEVER talk to the user — the main agent does that.',
  'Write ONLY the files assigned to you below. Output each file exactly in this format, nothing else:',
  '--- FILE: <path> ---',
  '<complete file content>',
  '--- END FILE ---',
  'Rules: output ONLY the file blocks (no explanation, no markdown fences, no code in chat). Write complete, working files — never truncate or summarise. Follow the shared design in the architecture spec so your files match the other parts. Do not write any file outside your assigned list.',
].join('\n');

function coderUserPrompt(task: string, architecture: string, partIndex: number, partCount: number, part: BuildPart): string {
  return [
    `Task: ${task}`,
    '',
    'Architecture (shared design — follow it):',
    architecture || '(no architecture spec — use sensible defaults matching the task)',
    '',
    `YOUR PART (${partIndex + 1} of ${partCount}): ${part.title}`,
    'Files you must write (and nothing else):',
    ...part.files.map((f) => `- ${f}`),
    '',
    'Write the complete content of each file now.',
  ].join('\n');
}

/**
 * Parse a worker's output into { file -> content } for its assigned files
 * only. A block without its closing marker (truncated output) does not
 * match and the file is reported as failed, so the main agent finishes it.
 */
export function parseCoderOutput(text: string, allowedFiles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const allowed = new Set(allowedFiles.map((f) => f.replace(/^[/\\]+/, '')));
  const re = /--- FILE:\s*(.+?)\s*---\s*\n([\s\S]*?)\n--- END FILE ---/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ''))) {
    const f = m[1].trim().replace(/^[/\\]+/, '');
    if (!allowed.has(f)) continue; // a worker never writes outside its part
    if (!out.has(f)) out.set(f, m[2]);
  }
  return out;
}

/**
 * Run the workers for all parts AT THE SAME TIME and merge their files
 * deterministically (part order; each file written exactly once, by its
 * owning part only). Returns the merge result; `ran` is false only when the
 * run was cancelled before launch.
 */
export async function runParallelCoders(opts: {
  task: string;
  architecture: string;
  parts: BuildPart[];
  keys: RouterKey[];
  sessionId?: string;
  execCtx: ToolExecutionContext;
  sendEvent?: (data: any) => void;
  isCancelled?: () => boolean;
  coderFn?: CoderFn;
}): Promise<ParallelBuildResult> {
  const startedAt = Date.now();
  const empty: ParallelBuildResult = {
    ran: false, cancelled: false, parts: [], writtenFiles: [], failedFiles: [], skippedFiles: [],
    startedAt, endedAt: startedAt,
  };
  const n = Math.min(opts.parts.length, opts.keys.length);
  if (n < 2) return empty;
  const parts = opts.parts.slice(0, n);
  const keys = opts.keys.slice(0, n);
  if (opts.isCancelled?.()) return { ...empty, cancelled: true, skippedFiles: parts.flatMap((p) => p.files) };

  const coderFn = opts.coderFn ?? defaultCoderFn;
  const onAgentStep = opts.execCtx.onAgentStep;

  // Background status only — workers never talk to the user.
  parts.forEach((part, i) => {
    onAgentStep?.({
      id: `parallel_coder_${i}_${Date.now()}`,
      kind: 'agent',
      label: `Parallel coder ${i + 1}/${n} — ${part.title}`,
      detail: part.files.join(', '),
      status: 'running',
    });
  });

  // Launch ALL workers together — this is the parallelism (not serial rounds).
  const settled = await Promise.allSettled(
    parts.map(async (part, i) => {
      const s = Date.now();
      const { text, model } = await coderFn({
        system: CODER_SYSTEM,
        user: coderUserPrompt(opts.task, opts.architecture, i, n, part),
        chain: cheapChain(),
        pinKeyId: keys[i].id,
        maxTokens: PARALLEL_CODER_MAX_TOKENS,
        timeoutMs: PARALLEL_CODER_TIMEOUT_MS,
      });
      return { text, model, startedAt: s, endedAt: Date.now() };
    }),
  );

  // Stop: never write files after the user stopped the turn (same
  // round-boundary semantics as the main loops — in-flight calls finish,
  // but their output is discarded, never merged).
  if (opts.isCancelled?.()) {
    return {
      ...empty,
      cancelled: true,
      skippedFiles: parts.flatMap((p) => p.files),
      endedAt: Date.now(),
      parts: parts.map((part, i) => ({
        title: part.title, files: part.files, keyId: keys[i].id, provider: keys[i].provider,
        model: settled[i].status === 'fulfilled' ? (settled[i] as any).value.model : 'unknown',
        status: 'skipped' as const, durationMs: 0, startedAt, endedAt: Date.now(),
      })),
    };
  }

  // Deterministic merge, part order, each file exactly once.
  const writtenFiles: string[] = [];
  const failedFiles: string[] = [];
  const partResults: ParallelCoderPartResult[] = [];
  let previewUrl: string | undefined;
  let deployedHtml: string | undefined;
  // The index page's own content, as written (not re-read from disk — a
  // later .html part overwrites the deployed index.html, see below).
  let indexContent: string | undefined;

  for (let i = 0; i < n; i++) {
    const part = parts[i];
    const key = keys[i];
    const s = settled[i];
    const durationMs = s.status === 'fulfilled'
      ? (s as any).value.endedAt - (s as any).value.startedAt
      : 0;
    const base: ParallelCoderPartResult = {
      title: part.title, files: part.files, keyId: key.id, provider: key.provider,
      model: s.status === 'fulfilled' ? (s as any).value.model : 'unknown',
      status: 'failed', durationMs,
      startedAt: s.status === 'fulfilled' ? (s as any).value.startedAt : startedAt,
      endedAt: s.status === 'fulfilled' ? (s as any).value.endedAt : Date.now(),
    };
    if (s.status === 'rejected') {
      failedFiles.push(...part.files);
      partResults.push(base);
      onAgentStep?.({
        id: `parallel_coder_${i}_${Date.now()}`,
        kind: 'agent',
        label: `Parallel coder ${i + 1}/${n} failed — ${part.title}`,
        detail: String((s as any).reason?.message || (s as any).reason || 'coder call failed').slice(0, 120),
        status: 'error',
        durationSec: Math.max(0.1, durationMs / 1000),
      });
      continue;
    }
    const parsed = parseCoderOutput((s as any).value.text, part.files);
    let wroteAny = false;
    for (const f of part.files) {
      const content = parsed.get(f);
      if (content === undefined) {
        failedFiles.push(f);
        continue;
      }
      try {
        const res: any = await executeServerTool(
          'write_to_file',
          { TargetFile: f, CodeContent: content },
          (a) => opts.sendEvent?.({ type: 'action', action: a }),
          opts.execCtx,
        );
        if (res?.error || res?.success === false) {
          failedFiles.push(f);
        } else {
          wroteAny = true;
          writtenFiles.push(res.cleanPath || f);
          if (/(^|\/)index\.html$/.test(f)) indexContent = content;
          if (res.previewUrl && !previewUrl) {
            previewUrl = res.previewUrl;
            deployedHtml = res.deployedHtml;
          }
        }
      } catch {
        failedFiles.push(f);
      }
    }
    partResults.push({ ...base, status: wroteAny ? 'done' : 'failed' });
    onAgentStep?.({
      id: `parallel_coder_${i}_${Date.now()}`,
      kind: 'agent',
      label: wroteAny
        ? `Parallel coder ${i + 1}/${n} wrote ${part.files.filter((f) => !failedFiles.includes(f)).length}/${part.files.length} file(s)`
        : `Parallel coder ${i + 1}/${n} wrote nothing — ${part.title}`,
      detail: part.files.join(', '),
      status: wroteAny ? 'done' : 'error',
      durationSec: Math.max(0.1, durationMs / 1000),
    });
  }

  // Preview fix: every .html write calls deployHtmlFile(), which always
  // overwrites the global + session index.html with THAT file's content —
  // so the last HTML part written would hijack the live preview (e.g.
  // shop.html's content served as index.html). After the merge, re-deploy
  // the real index page's own content (kept from the merge, not re-read
  // from disk — the disk copy was already overwritten) so the preview shows
  // the site's entry point. Best-effort: the files on disk are already correct.
  if (indexContent !== undefined && !opts.isCancelled?.()) {
    try {
      const redeployed = await deployHtmlFile(indexContent, opts.sessionId);
      if (redeployed.success && redeployed.url) {
        previewUrl = redeployed.url;
        deployedHtml = redeployed.html;
      }
    } catch { /* ignore — preview only */ }
  }

  return {
    ran: true,
    cancelled: false,
    parts: partResults,
    writtenFiles,
    failedFiles,
    skippedFiles: [],
    previewUrl,
    deployedHtml,
    startedAt,
    endedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Hook entry point (called from executeToolWithLiveEvents after a successful
// omo_coordinate). Returns null when the build stays serial.
// ---------------------------------------------------------------------------
export async function tryRunParallelBuild(opts: {
  planText: string;
  task: string;
  architecture?: string;
  sessionId?: string;
  execCtx: ToolExecutionContext;
  sendEvent?: (data: any) => void;
  isCancelled?: () => boolean;
  coderFn?: CoderFn;
}): Promise<ParallelBuildResult | null> {
  if (!opts.planText || hasParallelBuildRun(opts.sessionId) || opts.execCtx.parallelBuildRan) return null;
  const parts = splitPlanIntoParts(opts.planText);
  if (!parts || parts.length < 2) return null;
  const keys = await assignDistinctKeys(parts.length);
  if (keys.length < 2) return null;
  // Fewer keys than parts: trim the parts, folding dropped parts' files
  // into the last kept part so every planned file stays covered.
  const useParts = parts.slice(0, keys.length);
  if (parts.length > keys.length) {
    for (const extra of parts.slice(keys.length)) useParts[useParts.length - 1].files.push(...extra.files);
  }
  const result = await runParallelCoders({
    task: opts.task,
    architecture: opts.architecture || opts.planText.slice(0, 3000),
    parts: useParts,
    keys,
    sessionId: opts.sessionId,
    execCtx: opts.execCtx,
    sendEvent: opts.sendEvent,
    isCancelled: opts.isCancelled,
    coderFn: opts.coderFn,
  });
  if (result.ran && !result.cancelled) {
    markParallelBuildDone(opts.sessionId);
    opts.execCtx.parallelBuildRan = true;
  }
  return result;
}
