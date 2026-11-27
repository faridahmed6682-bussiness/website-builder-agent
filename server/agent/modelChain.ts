// Quality-ordered multi-provider failover chains with LIVE discovery.
//
// The problem this solves: free-model rosters turn over constantly. OpenRouter's
// free list checked 26 Nov 2026 no longer contains DeepSeek R1, Qwen3 Coder
// 480B or Llama 3.3 70B; today's free leaders are NVIDIA Nemotron 3, Gemma 4
// and new agentic coding models. Any model ID from an earlier brief is a
// CANDIDATE ONLY — it enters a chain only after being verified present in a
// live catalog. Nothing here hardcodes the working model list.
//
// Discovery (primary authority: FreeLLMAPI's self-updating catalog via
// GET {FREE_LLM_API_URL}/models; second: OpenRouter GET /v1/models, :free
// filter, public, no key). Refreshed at boot and daily; persisted to
// data/model-catalog.json so a cold boot still has yesterday's list.
//
// Chain rules:
//  - Quality-ordered, not provider-ordered: candidates are ranked by
//    capability for the current task (coding / planning / chat) across ALL
//    providers (Gemini, OpenRouter, Groq, FreeLLMAPI's 87 providers).
//  - On 429 / quota-exhausted / 5xx / timeout -> next entry, same task,
//    same quality tier when possible. Never a weak model first, never stops.
//  - SAME MODEL, NEXT KEY FIRST: for Gemini the primary failover is key
//    rotation, not model switching. Quotas are PER PROJECT, not per key:
//    several keys from one project share one cap, but keys from DIFFERENT
//    projects (the user has 10, each from its own account) each carry their
//    own quota. One key's limit ends -> the next key, SAME model
//    (gemini-4-hydrogen), zero quality loss. Only when EVERY key is out does
//    the chain drop to the next model (3.8 Flash, also key-rotated), then
//    live-discovered OpenRouter/Groq free models. The orchestrator's key
//    pool does the rotation; this file ranks the models.
//  - OBSERVED limits, never assumed: Google publishes NO fixed free-tier
//    numbers for Hydrogen — per-project limits vary and are shown only at
//    aistudio.google.com/rate-limit. So NO Gemini model has an assumed
//    daily/RPM cap in this file (dailyCap/rpmCap return Infinity for
//    gemini-*). Limits are learned from 429 responses: RPM/TPM hits are
//    short (~65s cooldown, rolling per-minute budget) and trigger immediate
//    key rotation; RPD hits park the model until midnight Pacific.
//    OpenRouter free (50 RPD total, 20 RPM) and Groq free (~30 RPM /
//    1,000 RPD per chat model, per organization) keep their published
//    soft budgets.
//  - Cooldowns: on 429 honour Retry-After, mark the model unhealthy ~65s.
//  - Context handoff: when the model switches mid-task, a compact note is
//    added so the new model does not start cold (the full message history
//    already travels with the request; the note says what changed).
//  - Honest degradation: the tier of the model that answers is compared with
//    the tier the turn started at; a drop is surfaced to the UI, never hidden.
import fs from 'fs/promises';
import path from 'path';

export type TaskKind = 'coding' | 'planning' | 'chat';
export type ModelTier = 1 | 2 | 3;

export interface ChainEntry {
  model: string;
  provider: string;
  tier: ModelTier;
  score: number;
}

export interface DiscoveredModel {
  id: string;
  providers: string[];
  contextLength?: number;
  source: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CATALOG_FILE = path.join(DATA_DIR, 'model-catalog.json');

// ---------------------------------------------------------------------------
// Capability scoring — family patterns only (the live catalog is authoritative
// for WHICH models exist; this table only ranks known families).
// Scores are 0-100 per task. Unknown models score 50 (mid-low, never top tier).
// ---------------------------------------------------------------------------
interface FamilyScore { pattern: RegExp; coding: number; planning: number; chat: number }
const FAMILY_SCORES: FamilyScore[] = [
  // Gemini 4 Hydrogen — free tier, everyday coding + planning (AA Index 51 at
  // high, 54 at xhigh — vendor figures; Terminal-Bench 4.1 57% vs 3.8 Flash
  // 18.2%; FrontierCode 36.3% vs 18.7% — vendor-reported, not verified here).
  { pattern: /gemini-4-hydrogen/i, coding: 95, planning: 95, chat: 90 },
  { pattern: /gemini-3\.8-flash/i, coding: 80, planning: 75, chat: 85 },
  { pattern: /gemini-3\.6-flash/i, coding: 75, planning: 70, chat: 80 },
  { pattern: /gemini-3\.5-flash-lite|gemini-3\.1-flash-lite|gemini-2\.5-flash-lite/i, coding: 60, planning: 55, chat: 70 },
  { pattern: /gemini-2\.5-pro/i, coding: 85, planning: 88, chat: 85 },
  { pattern: /gemini-2\.5-flash/i, coding: 72, planning: 68, chat: 78 },
  // Today's OpenRouter free leaders (checked 27 Nov 2026, live /v1/models):
  // Nemotron 3 family, Gemma 4, Particle-1 (agentic coding), Ling 3.2 Flash,
  // Flint, LFM-3. No R1, no Qwen3-Coder-480B, no Llama 3.3. Ernie 5.5 Flash
  // is listed by OpenRouter but EXCLUDED (see EXCLUDED_MODEL_PATTERNS) —
  // Baidu is not in the user's provider list.
  { pattern: /nemotron-3-ultra/i, coding: 76, planning: 78, chat: 72 },
  { pattern: /nemotron/i, coding: 72, planning: 74, chat: 72 },
  { pattern: /particle-1/i, coding: 82, planning: 76, chat: 70 },
  { pattern: /gemma-4/i, coding: 70, planning: 68, chat: 74 },
  { pattern: /gemma-3-27b/i, coding: 78, planning: 72, chat: 80 },
  { pattern: /gemma-3/i, coding: 68, planning: 62, chat: 72 },
  // Groq free chat models (checked 27 Nov 2026): gpt-oss-120b/20b +
  // qwen3.8-27b, 30 RPM / 1,000 RPD / 8,000 TPM each, PER ORGANIZATION.
  // Llama 3.1-8B / 3.3-70B free access ended 16 Aug 2026.
  { pattern: /gpt-oss-120b/i, coding: 80, planning: 80, chat: 80 },
  { pattern: /gpt-oss-20b/i, coding: 74, planning: 70, chat: 76 },
  { pattern: /qwen3\.8-27b/i, coding: 76, planning: 72, chat: 74 },
  // Earlier free leaders — kept as scoring hints ONLY; they enter a chain
  // only if the live catalog still lists them (they did not, on 26 Nov 2026).
  { pattern: /deepseek-r1|deepseek\/deepseek-r1/i, coding: 82, planning: 92, chat: 70 },
  { pattern: /qwen3-coder|qwen\/qwen3-coder/i, coding: 88, planning: 80, chat: 70 },
  { pattern: /qwen3\.6|qwen3-.*coder/i, coding: 86, planning: 80, chat: 72 },
  { pattern: /llama-3\.3-70b/i, coding: 70, planning: 65, chat: 72 },
  { pattern: /mistral-small/i, coding: 65, planning: 60, chat: 68 },
  { pattern: /devstral/i, coding: 80, planning: 72, chat: 65 },
  { pattern: /llama-3/i, coding: 62, planning: 58, chat: 68 },
  { pattern: /qwen/i, coding: 72, planning: 68, chat: 70 },
  { pattern: /kimi|moonshot/i, coding: 78, planning: 75, chat: 70 },
];

function scoreModel(id: string, task: TaskKind): number {
  for (const f of FAMILY_SCORES) {
    if (f.pattern.test(id)) return f[task];
  }
  return 50;
}

function tierFor(score: number): ModelTier {
  if (score >= 85) return 1;
  if (score >= 70) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// EXCLUDED models — NEVER in any chain. Only FREE-tier models work (no card,
// no billing), so paid-only and retired models are dropped at discovery time,
// before any chain is built. A call to a paid model would fail without
// billing, so the chain must never contain one.
//
// INCLUDED (free, verified live): gemini-4-hydrogen, gemini-3.8-flash,
// gemini-3.6-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite,
// gemini-2.5-pro / gemini-2.5-flash / gemini-2.5-flash-lite (where still
// served), gemma models, plus the live-discovered OpenRouter :free and Groq
// free models.
// EXCLUDED (paid-only): gemini-4-argon, gemini-4-neon, gemini-4-carbon,
// gemini-3.1-pro-preview (any *-pro-preview), Nano Banana image models,
// Veo video, Omni Flash, Lyria, Imagen.
// EXCLUDED (retired): gemini-3.7-flash, gemini-3.5-flash (deprecated
// 8 Oct 2026 — the API routes it to 3.6/3.8 Flash; the -lite stays free).
// Live discovery decides — this list only removes what is known-paid or
// known-retired; everything else still needs a live catalog entry.
// ---------------------------------------------------------------------------
const EXCLUDED_MODEL_PATTERNS: RegExp[] = [
  /gemini-4-argon/i,
  /gemini-4-neon/i,
  /gemini-4-carbon/i,
  /pro-preview/i,
  /nano-banana/i,
  /veo/i,
  /omni-flash/i,
  /lyria/i,
  /imagen/i,
  /flash-image/i,
  /gemini-3\.7-flash/i,
  /gemini-3\.5-flash(?!-lite)/i,
  // Baidu / Ernie: NOT in the user's provider list (Gemini + Groq +
  // OpenRouter only). Never in any chain, never attempted as a fallback —
  // live QA 2026-11-27 caught the chain offering baidu/ernie-5.5-flash
  // to a keyless server and failing with a misleading error.
  /baidu\//i,
  /ernie/i,
];

/** True when a model id is paid-only, media-only, or retired — never chain it. */
export function isModelExcluded(id: string): boolean {
  return EXCLUDED_MODEL_PATTERNS.some((re) => re.test(id));
}

function providerOf(id: string): string {
  if (id.startsWith('google/') || id.startsWith('gemini') || /^gemini-/.test(id)) return 'gemini';
  if (id.startsWith('openrouter/')) return 'openrouter';
  if (id.startsWith('groq/') || /groq/i.test(id)) return 'groq';
  if (id.includes('/')) return id.split('/')[0].toLowerCase();
  return 'freellmapi';
}

// ---------------------------------------------------------------------------
// Quota caps (soft budgets). OBSERVED limits only: Google publishes NO fixed
// free-tier numbers for Hydrogen and per-project quotas vary, so Gemini
// models have NO assumed cap here (Infinity) — a 429 is the signal, and
// recordModelFailure() learns from it (RPM/TPM = short cooldown, RPD = park
// until midnight Pacific). OpenRouter free: 50 RPD TOTAL across free models
// (20 RPM, published). Groq free: ~30 RPM / 1,000 RPD per chat model,
// per organization (published, checked 27 Nov 2026).
// Unknown models: 50/day default.
// ---------------------------------------------------------------------------
export type RateLimitKind = 'rpm' | 'tpm' | 'rpd' | 'unknown';

/**
 * Classify a 429 / quota error by which budget it hit, from the provider's
 * error text. Google's errors name the quota metric, e.g.
 * `generate_requests_per_minute_per_project` (RPM),
 * `generate_tokens_per_minute_per_project` (TPM),
 * `generate_requests_per_day_per_project` (RPD).
 * RPM/TPM reset every minute (rolling) — a seconds-long problem. RPD lasts
 * until midnight Pacific — a daily wall. Unknown 429s are treated as RPM
 * (short-lived) so the chain rotates immediately instead of parking a model.
 */
export function classifyRateLimit(status: number | undefined, message?: string | null): RateLimitKind {
  if (status !== 429 && status !== undefined) return 'unknown';
  const m = (message || '').toLowerCase();
  if (/per_day|per-day|_per_day_|daily|free-models-per-day|requests per day|quota.*day/i.test(m)) return 'rpd';
  if (/tokens_per_minute|tokens per minute|\btpm\b|token.*per minute/i.test(m)) return 'tpm';
  if (/per_minute|per-minute|requests per minute|\brpm\b|rate limit|quota|resource_exhausted|429/i.test(m)) return 'rpm';
  return 'unknown';
}

/** Next midnight in America/Los_Angeles (when Gemini daily quotas reset). */
export function nextMidnightPacificMs(nowMs = Date.now()): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' });
  const p = dtf.formatToParts(new Date(nowMs));
  const y = Number(p.find((x) => x.type === 'year')!.value);
  const mo = Number(p.find((x) => x.type === 'month')!.value);
  const d = Number(p.find((x) => x.type === 'day')!.value);
  // Wall-clock midnight at the start of tomorrow in PT, converted to UTC.
  const wallAsUTC = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = offFmt.formatToParts(new Date(wallAsUTC));
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  const offsetMs = asUTC - wallAsUTC;
  return wallAsUTC - offsetMs;
}

/** Human status text for a limit kind. Never shows a raw 429 to the user. */
export function limitLabel(kind: RateLimitKind, retryInSec?: number): string {
  if (kind === 'rpd') return 'daily limit — resets midnight Pacific';
  if (kind === 'tpm') return `tokens-per-minute limit — retrying in ${Math.max(1, retryInSec ?? 60)}s`;
  if (kind === 'rpm') return `per-minute limit — retrying in ${Math.max(1, retryInSec ?? 60)}s`;
  return 'rate limit — retrying shortly';
}

function dailyCap(id: string): number {
  // Gemini: NO assumed cap — limits are per-project, unpublished for
  // Hydrogen, and observed via 429s (see recordModelFailure).
  if (/gemini/i.test(id)) return Infinity;
  // Groq free (checked 27 Nov 2026): 1,000 RPD per chat model
  // (gpt-oss-120b/20b, qwen3.8-27b). The old 14,400 figure belonged to
  // llama-3.1-8b-instant, whose free access ended 16 Aug 2026. Groq caps
  // are PER ORGANIZATION — extra Groq keys in one org do NOT multiply quota
  // (unlike Gemini project keys). Limits are observed via 429s regardless.
  if (/groq/i.test(id)) return 1000;
  return 50;
}

function rpmCap(id: string): number {
  // Gemini: NO assumed RPM cap — observed via 429s, not guessed.
  if (/gemini/i.test(id)) return Infinity;
  if (/groq/i.test(id)) return 30;
  return 20; // OpenRouter free shared 20 RPM
}

const OPENROUTER_FREE_POOL = '__openrouter_free_pool__';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface ModelUsage {
  dayKey: string;
  dayCount: number;
  minuteStamps: number[];
  cooldownUntil: number;
  dead: boolean;
  /** Parked until this timestamp (RPD: next midnight Pacific); undefined = dead for the day. */
  deadUntil?: number;
  /** Which budget the last 429 hit: rpm | tpm | rpd. */
  lastLimitKind?: RateLimitKind;
  lastLimitAt?: number;
  lastError?: string;
}

const catalog = new Map<string, DiscoveredModel>();
let catalogFetchedAt: number | null = null;
let catalogSources: string[] = [];
const usage = new Map<string, ModelUsage>();
let openRouterPoolDay = { dayKey: '', count: 0 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getUsage(id: string): ModelUsage {
  const u = usage.get(id);
  const day = todayKey();
  if (!u || u.dayKey !== day) {
    const fresh: ModelUsage = { dayKey: day, dayCount: 0, minuteStamps: [], cooldownUntil: 0, dead: false };
    usage.set(id, fresh);
    return fresh;
  }
  return u;
}

function pruneMinuteStamps(u: ModelUsage, now: number): void {
  u.minuteStamps = u.minuteStamps.filter((t) => now - t < 60000);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
async function fetchFreeLLMAPI(): Promise<string[]> {
  const baseUrl = (process.env.FREE_LLM_API_URL || '').replace(/\/$/, '');
  const apiKey = process.env.FREE_LLM_API_KEY || '';
  if (!baseUrl || !apiKey) return [];
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`FreeLLMAPI /v1/models HTTP ${res.status}`);
  const body: any = await res.json();
  const ids: string[] = (body?.data || []).map((m: any) => m?.id).filter(Boolean);
  return ids;
}

async function fetchOpenRouter(): Promise<Array<{ id: string; contextLength?: number }>> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`OpenRouter /v1/models HTTP ${res.status}`);
  const body: any = await res.json();
  const all: any[] = body?.data || [];
  return all
    .filter((m) => typeof m?.id === 'string' && m.id.endsWith(':free'))
    .map((m) => ({ id: m.id, contextLength: m.context_length }));
}

// Configured-provider free models.
//
// The live catalogs (FreeLLMAPI + OpenRouter) never list Gemini models —
// Gemini's free tier is served directly by Google, not through OpenRouter's
// free list. So when the user has configured keys for a provider, that
// provider's DOCUMENTED free models are added to the catalog (source:
// 'configured'). These are the free tiers verified 2026-11-27, not guesses:
// Gemini (free tier, per-project quotas, no billing): hydrogen, 3.8/3.6
// flash, 3.5/3.1 flash-lite, 2.5 pro/flash/flash-lite where served, gemma.
// Groq (free, per-organization caps): gpt-oss-120b/20b, qwen3.8-27b.
// They are scored by the same FAMILY_SCORES, subject to the same paid/
// retired blocklist, and marked unhealthy on 429 like any other model.
// Without a key for a provider, its models never enter the catalog —
// the chain can only route to providers the user actually configured.
const CONFIGURED_FREE_MODELS: Array<{ id: string; providers: string[]; envVar: string }> = [
  { id: 'gemini-4-hydrogen', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-3.8-flash', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-3.6-flash', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-3.5-flash-lite', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-3.1-flash-lite', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-2.5-pro', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-2.5-flash', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemini-2.5-flash-lite', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'gemma-3-27b-it', providers: ['gemini'], envVar: 'GEMINI_API_KEYS' },
  { id: 'openai/gpt-oss-120b', providers: ['groq'], envVar: 'GROQ_API_KEYS' },
  { id: 'openai/gpt-oss-20b', providers: ['groq'], envVar: 'GROQ_API_KEYS' },
  { id: 'qwen/qwen3.8-27b', providers: ['groq'], envVar: 'GROQ_API_KEYS' },
];

function seedConfiguredProviderModels(): number {
  let added = 0;
  const hasGemini = Boolean((process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').trim());
  const hasGroq = Boolean((process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').trim());
  for (const m of CONFIGURED_FREE_MODELS) {
    if (isModelExcluded(m.id)) continue;
    const configured = (m.envVar === 'GEMINI_API_KEYS' && hasGemini) || (m.envVar === 'GROQ_API_KEYS' && hasGroq);
    if (!configured) continue;
    if (!catalog.has(m.id)) {
      catalog.set(m.id, { id: m.id, providers: [...m.providers], source: 'configured' });
      added++;
    } else {
      const prev = catalog.get(m.id)!;
      for (const p of m.providers) if (!prev.providers.includes(p)) prev.providers.push(p);
    }
  }
  return added;
}

export async function refreshCatalog(): Promise<{ freellmapi: number; openrouter: number; total: number }> {
  const counts = { freellmapi: 0, openrouter: 0, total: 0 };
  const sources: string[] = [];
  try {
    const ids = await fetchFreeLLMAPI();
    let excluded = 0;
    for (const id of ids) {
      // Paid-only / retired models never enter the catalog (no billing).
      if (isModelExcluded(id)) { excluded++; continue; }
      const prev = catalog.get(id) || { id, providers: [], source: 'freellmapi' };
      if (!prev.providers.includes('freellmapi')) prev.providers.push('freellmapi');
      prev.source = 'freellmapi';
      catalog.set(id, prev);
    }
    counts.freellmapi = ids.length - excluded;
    if (excluded) console.log(`[model-chain] FreeLLMAPI: dropped ${excluded} paid/retired models (argon/neon/carbon/pro-preview/media/retired)`);
    if (ids.length) sources.push('freellmapi');
  } catch (err: any) {
    console.warn(`[model-chain] FreeLLMAPI catalog fetch failed: ${err?.message || String(err)}`);
  }
  try {
    const models = await fetchOpenRouter();
    let excluded = 0;
    for (const m of models) {
      if (isModelExcluded(m.id)) { excluded++; continue; }
      const prev = catalog.get(m.id) || { id: m.id, providers: [], source: 'openrouter', contextLength: m.contextLength };
      if (!prev.providers.includes('openrouter')) prev.providers.push('openrouter');
      catalog.set(m.id, prev);
    }
    counts.openrouter = models.length - excluded;
    if (excluded) console.log(`[model-chain] OpenRouter: dropped ${excluded} paid/retired models`);
    if (models.length) sources.push('openrouter');
  } catch (err: any) {
    console.warn(`[model-chain] OpenRouter catalog fetch failed: ${err?.message || String(err)}`);
  }
  counts.total = catalog.size;
  // Configured providers' documented free models (Gemini/Groq) are not in
  // any live catalog — add them when keys for that provider are configured.
  const seeded = seedConfiguredProviderModels();
  if (seeded) sources.push('configured');
  counts.total = catalog.size;
  catalogFetchedAt = Date.now();
  catalogSources = sources;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      CATALOG_FILE,
      JSON.stringify({ fetchedAt: catalogFetchedAt, sources, models: [...catalog.values()] }, null, 2),
      'utf-8',
    );
  } catch { /* persistence is best-effort */ }
  console.log(`[model-chain] Catalog refreshed: ${counts.freellmapi} FreeLLMAPI + ${counts.openrouter} OpenRouter-free = ${counts.total} models (${sources.join(', ') || 'no live source — using persisted list'})`);
  return counts;
}

async function loadPersistedCatalog(): Promise<void> {
  try {
    const raw = await fs.readFile(CATALOG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    for (const m of parsed.models || []) {
      // 'configured'-source models are re-seeded from the env on each boot;
      // drop stale ones here so removing a provider's keys removes its models.
      if (typeof m?.id === 'string' && !isModelExcluded(m.id) && m.source !== 'configured') catalog.set(m.id, m);
    }
    catalogFetchedAt = parsed.fetchedAt || null;
    catalogSources = parsed.sources || [];
  } catch { /* no persisted catalog yet */ }
}

let refreshTimer: NodeJS.Timeout | null = null;
export async function initModelChain(): Promise<void> {
  await loadPersistedCatalog();
  await refreshCatalog();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { refreshCatalog().catch(() => {}); }, 24 * 3600 * 1000);
    refreshTimer.unref?.();
  }
}

export function catalogStatus(): { fetchedAt: number | null; sources: string[]; total: number } {
  return { fetchedAt: catalogFetchedAt, sources: catalogSources, total: catalog.size };
}

/** All live-discovered model ids (free + verified only — paid/retired are dropped at ingestion). */
export function listCatalogIds(): string[] {
  return [...catalog.keys()];
}

export interface ModelStatusEntry {
  model: string;
  provider: string;
  healthy: boolean;
  /** Which budget the last 429 hit, if any: rpm | tpm | rpd. */
  limitKind?: RateLimitKind;
  /** Human status text — never a raw 429. */
  limitLabel?: string;
  cooldownRemainingSec: number;
  /** Midnight Pacific reset time (ms epoch) when limitKind is rpd. */
  dailyResetAt?: number;
  lastError?: string;
}

/** Per-model live status for the UI: working / per-minute-limited / daily-limited. */
export function modelChainStatus(): ModelStatusEntry[] {
  const now = Date.now();
  const out: ModelStatusEntry[] = [];
  for (const [id] of catalog) {
    const u = getUsage(id);
    const inCooldown = u.cooldownUntil > now;
    const parked = u.dead && (!u.deadUntil || now < u.deadUntil);
    out.push({
      model: id,
      provider: providerOf(id),
      healthy: isHealthy(id),
      limitKind: u.lastLimitKind,
      limitLabel: u.lastLimitKind ? limitLabel(u.lastLimitKind, inCooldown ? Math.ceil((u.cooldownUntil - now) / 1000) : undefined) : undefined,
      cooldownRemainingSec: inCooldown ? Math.ceil((u.cooldownUntil - now) / 1000) : 0,
      dailyResetAt: parked && u.deadUntil ? u.deadUntil : undefined,
      lastError: u.lastError,
    });
  }
  return out;
}

/** Verify seed candidate IDs against the live catalog — unverified IDs are dropped, never assumed. */
export function verifyLive(ids: string[]): string[] {
  if (!catalog.size) return [];
  return ids.filter((id) => catalog.has(id) && !isModelExcluded(id));
}

export function isModelLive(id: string): boolean {
  return catalog.has(id);
}

/** First live OpenRouter :free model id known right now (in-memory catalog,
 * else the persisted catalog file). Used as the default model for env
 * OpenRouter keys. Returns null when nothing is known yet — the caller falls
 * back to today's verified free default. */
export async function firstOpenRouterFreeModel(): Promise<string | null> {
  for (const [id] of catalog) {
    if (id.endsWith(':free') && !isModelExcluded(id)) return id;
  }
  try {
    const raw = await fs.readFile(CATALOG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    for (const m of parsed.models || []) {
      if (typeof m?.id === 'string' && m.id.endsWith(':free') && !isModelExcluded(m.id)) return m.id;
    }
  } catch { /* no persisted catalog yet */ }
  return null;
}

// ---------------------------------------------------------------------------
// Usage / cooldowns
// ---------------------------------------------------------------------------
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 3600);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(3600, Math.floor((date - Date.now()) / 1000)));
  return null;
}

export function noteModelAttempt(model: string, keyId?: string): void {
  const u = getUsage(model);
  const now = Date.now();
  pruneMinuteStamps(u, now);
  u.minuteStamps.push(now);
  u.dayCount++;
  if (providerOf(model) === 'openrouter' || model.endsWith(':free')) {
    const day = todayKey();
    if (openRouterPoolDay.dayKey !== day) openRouterPoolDay = { dayKey: day, count: 0 };
    openRouterPoolDay.count++;
  }
  void keyId; // per-key rotation is tracked by the orchestrator's key pool
}

export function recordModelSuccess(model: string): void {
  const u = getUsage(model);
  u.cooldownUntil = 0;
  u.lastError = undefined;
}

export function recordModelFailure(model: string, status?: number, retryAfter?: string | null, message?: string | null): void {
  const u = getUsage(model);
  const now = Date.now();
  if (status === 429) {
    const ra = parseRetryAfter(retryAfter);
    const kind = classifyRateLimit(status, message ?? u.lastError);
    u.lastLimitKind = kind;
    u.lastLimitAt = now;
    if (kind === 'rpd') {
      // Daily wall: park until midnight Pacific, not forever. The model
      // re-enters the chain automatically after the reset.
      u.dead = true;
      u.deadUntil = nextMidnightPacificMs(now);
      u.cooldownUntil = 0;
      u.lastError = 'daily limit — resets midnight Pacific';
    } else {
      // RPM/TPM: per-minute budget, rolling reset. Short cooldown; the
      // chain rotates to the next key/model immediately.
      const waitSec = Math.max(65, ra ?? 65);
      u.cooldownUntil = now + waitSec * 1000;
      u.lastError = `${limitLabel(kind, waitSec)}${ra ? ` (Retry-After ${ra}s)` : ''}`;
    }
  } else if (status === 404 || status === 400) {
    // Model not found / not valid — dead for the day (dropped from chains).
    u.dead = true;
    u.deadUntil = undefined;
    u.lastError = `HTTP ${status} — model unavailable`;
  } else {
    u.cooldownUntil = now + 60 * 1000;
    u.lastError = status ? `HTTP ${status}` : 'request failed';
  }
}

export function markModelExhausted(model: string): void {
  const u = getUsage(model);
  u.dayCount = dailyCap(model);
}

function isHealthy(id: string): boolean {
  const u = getUsage(id);
  // An RPD park expires at midnight Pacific; after that the model is live again.
  if (u.dead && u.deadUntil && Date.now() >= u.deadUntil) {
    u.dead = false;
    u.deadUntil = undefined;
    u.lastLimitKind = undefined;
  }
  if (u.dead) return false;
  if (u.cooldownUntil > Date.now()) return false;
  pruneMinuteStamps(u, Date.now());
  if (u.minuteStamps.length >= rpmCap(id)) return false;
  if (u.dayCount >= dailyCap(id)) return false;
  if ((providerOf(id) === 'openrouter' || id.endsWith(':free')) && openRouterPoolDay.dayKey === todayKey() && openRouterPoolDay.count >= 50) {
    return false; // OpenRouter free 50/day shared pool exhausted
  }
  return true;
}

// ---------------------------------------------------------------------------
// Chain building
// ---------------------------------------------------------------------------
const ROUTER_CHAINS: Record<TaskKind, string[]> = {
  coding: ['auto:smart', 'auto:balanced', 'auto:fast'],
  planning: ['auto:smart', 'auto:balanced'],
  chat: ['auto:fast', 'auto:balanced'],
};

/**
 * Quality-ordered chain for a task. Verified live models first (best score,
 * same tier grouped), then the router's own named chains as the floor.
 * `providerFilter` restricts to one provider's models (e.g. 'openrouter').
 */
export function getChainForTask(task: TaskKind, providerFilter?: string, limit = 8): ChainEntry[] {
  const entries: ChainEntry[] = [];
  for (const [id] of catalog) {
    if (providerFilter && providerOf(id) !== providerFilter) continue;
    // Paid-only / retired models never enter a chain (belt & braces — the
    // catalog filter above already drops them at ingestion).
    if (isModelExcluded(id)) continue;
    // Skip router pseudo-models and non-free OpenRouter entries in the chain;
    // the router chains are added as the floor below.
    if (id.startsWith('auto:')) continue;
    if (!isHealthy(id)) continue;
    const score = scoreModel(id, task);
    entries.push({ model: id, provider: providerOf(id), tier: tierFor(score), score });
  }
  entries.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  const seen = new Set<string>();
  const chain: ChainEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.model)) continue;
    seen.add(e.model);
    chain.push(e);
    if (chain.length >= limit) break;
  }
  // Floor: the router's own live-ranked chains (never a hardcoded model ID).
  for (const m of ROUTER_CHAINS[task]) {
    chain.push({ model: m, provider: 'freellmapi', tier: 3, score: 40 });
  }
  return chain;
}

export function tierOfModel(model: string, task: TaskKind): ModelTier {
  return tierFor(scoreModel(model, task));
}

/** Next healthy entry after `failedModel` in the task chain (same tier first). */
export function nextAfterFailure(failedModel: string, task: TaskKind, providerFilter?: string): ChainEntry | null {
  const chain = getChainForTask(task, providerFilter, 12);
  const failedTier = tierOfModel(failedModel, task);
  const sameTier = chain.find((e) => e.model !== failedModel && e.tier === failedTier);
  if (sameTier) return sameTier;
  return chain.find((e) => e.model !== failedModel) || null;
}

// ---------------------------------------------------------------------------
// Context handoff + degradation
// ---------------------------------------------------------------------------
export function handoffNote(prevModel: string, reason: string, nextModel: string): string {
  return `[Context handoff: the previous model (${prevModel}) stopped (${reason}). Continue from the conversation and tool results above — do NOT restart the task or re-ask what is already known. You are ${nextModel}; the plan and progress so far are in the history.]`;
}

export interface Degradation {
  dropped: boolean;
  fromTier: ModelTier;
  toTier: ModelTier;
  fromModel: string;
  toModel: string;
}

export function degradationBetween(startModel: string, currentModel: string, task: TaskKind): Degradation {
  const fromTier = tierOfModel(startModel, task);
  const toTier = tierOfModel(currentModel, task);
  return { dropped: toTier > fromTier, fromTier, toTier, fromModel: startModel, toModel: currentModel };
}
