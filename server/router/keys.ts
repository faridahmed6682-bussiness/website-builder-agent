// Embedded router — key pool.
//
// MERGE NOTE: FreeLLMAPI + the agent are ONE service now. The router runs in
// the same Node process (same port) — no separate FreeLLMAPI service, no
// FREE_LLM_API_URL to configure. The agent's own LLM calls go through this
// router in-process (or via the internal /v1 HTTP endpoint below); the user
// may still point FREE_LLM_API_URL at an external FreeLLMAPI if one is
// deployed, but day-to-day work needs nothing external.
//
// The router covers the three providers the user has keys for — Gemini,
// Groq, OpenRouter — with the same key-rotation + cooldown behaviour as the
// agent's chain: many keys per provider, round-robin, per-key cooldown on
// 429, limits treated as OBSERVED (never assumed).
//
// Keys come from env lists (GEMINI_API_KEYS / GROQ_API_KEYS /
// OPENROUTER_API_KEYS, comma-separated) and from the unified dashboard
// (stored in data/router-keys.json — gitignored, never in code/logs/chat).
// Key VALUES are never returned by any endpoint — only ids, provider, source
// and live/limited status.
//
// The router's own /v1 HTTP endpoint is protected by an internal API key:
// env ROUTER_API_KEY when set, else a random key generated once at boot
// (in-memory only). The agent uses it to call its own endpoint; anyone else
// needs ROUTER_API_KEY to use the router from outside.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { classifyRateLimit, limitLabel, type RateLimitKind } from '../agent/modelChain.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const KEYS_FILE = path.join(DATA_DIR, 'router-keys.json');

export type RouterProvider = 'gemini' | 'groq' | 'openrouter';

export interface RouterKey {
  id: string;
  provider: RouterProvider;
  name: string;
  key: string;
  source: 'env' | 'dashboard';
  cooldownUntil: number;
  limitKind?: RateLimitKind | null;
  lastError?: string;
  uses: number;
}

export interface RouterKeyStatus {
  id: string;
  provider: RouterProvider;
  name: string;
  source: 'env' | 'dashboard';
  status: 'live' | 'limited' | 'cooldown';
  limitKind?: RateLimitKind | null;
  limitLabel?: string;
  retryInSec?: number;
  uses: number;
}

let keys: RouterKey[] = [];
let keysLoaded = false;
let rrIndex = 0;

// No provider keys at all: the chat must say so in Bengali and point at
// the Keys tab — never rotate through keyless providers and never offer a
// misleading "trying <next model>" error (live QA 2026-11-27: a keyless
// server offered baidu/ernie and failed with a confusing message).
export const NO_PROVIDER_KEYS_MESSAGE =
  'কোনো API key বসানো হয়নি। Keys ট্যাবে Gemini, Groq বা OpenRouter-এর key বসান, তারপর আবার চেষ্টা করুন।';
export const NO_PROVIDER_KEYS_CODE = 'NO_PROVIDER_KEYS';

/** True when at least one real provider key is configured (env or dashboard). */
export async function hasAnyRouterKey(): Promise<boolean> {
  await loadKeys();
  return keys.length > 0;
}

// The router's own API key (protects /v1/*): env override or boot-generated.
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || `router-${crypto.randomBytes(24).toString('hex')}`;
export function getRouterApiKey(): string {
  return ROUTER_API_KEY;
}

function parseEnvList(value: string | undefined): string[] {
  return (value || '').split(',').map((k) => k.trim()).filter(Boolean);
}

async function loadKeys(): Promise<void> {
  if (keysLoaded) return;
  keysLoaded = true;
  const next: RouterKey[] = [];
  const seen = new Set<string>();
  const add = (provider: RouterProvider, key: string, source: 'env' | 'dashboard', id?: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    next.push({
      id: id || `${provider}-${source}-${next.filter((k) => k.provider === provider).length + 1}`,
      provider,
      name: `${provider} key ${next.filter((k) => k.provider === provider).length + 1} (${source})`,
      key,
      source,
      cooldownUntil: 0,
      uses: 0,
    });
  };
  for (const k of parseEnvList(process.env.GEMINI_API_KEYS)) add('gemini', k, 'env');
  if (process.env.GEMINI_API_KEY) add('gemini', process.env.GEMINI_API_KEY, 'env');
  for (const k of parseEnvList(process.env.GROQ_API_KEYS)) add('groq', k, 'env');
  if (process.env.GROQ_API_KEY) add('groq', process.env.GROQ_API_KEY, 'env');
  for (const k of parseEnvList(process.env.OPENROUTER_API_KEYS)) add('openrouter', k, 'env');
  if (process.env.OPENROUTER_API_KEY) add('openrouter', process.env.OPENROUTER_API_KEY, 'env');
  try {
    const raw = await fs.readFile(KEYS_FILE, 'utf-8');
    const stored = JSON.parse(raw) as Array<{ id: string; provider: RouterProvider; key: string }>;
    for (const s of stored || []) {
      if (s?.key && s?.provider) add(s.provider, s.key, 'dashboard', s.id);
    }
  } catch { /* no dashboard keys yet */ }
  keys = next;
}

async function saveDashboardKeys(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stored = keys.filter((k) => k.source === 'dashboard').map((k) => ({ id: k.id, provider: k.provider, key: k.key }));
  await fs.writeFile(KEYS_FILE, JSON.stringify(stored, null, 2), 'utf-8').catch(() => {});
}

/** Add a provider key from the dashboard. Returns the key id (never the value). */
export async function addRouterKey(provider: RouterProvider, key: string): Promise<{ id: string }> {
  await loadKeys();
  const clean = (key || '').trim();
  if (!clean) throw new Error('Key is empty.');
  if (keys.some((k) => k.key === clean)) throw new Error('This key is already in the pool.');
  const id = `dashboard-${provider}-${Date.now().toString(36)}`;
  keys.push({ id, provider, name: `${provider} key (dashboard)`, key: clean, source: 'dashboard', cooldownUntil: 0, uses: 0 });
  await saveDashboardKeys();
  return { id };
}

/** Remove a dashboard key (env keys cannot be removed here — unset the env var). */
export async function removeRouterKey(id: string): Promise<boolean> {
  await loadKeys();
  const idx = keys.findIndex((k) => k.id === id && k.source === 'dashboard');
  if (idx === -1) return false;
  keys.splice(idx, 1);
  await saveDashboardKeys();
  return true;
}

/** Round-robin pick of a healthy key for a provider (skips cooldowns). */
export async function selectRouterKey(provider: RouterProvider): Promise<RouterKey | null> {
  await loadKeys();
  const now = Date.now();
  const pool = keys.filter((k) => k.provider === provider);
  if (!pool.length) return null;
  const healthy = pool.filter((k) => k.cooldownUntil <= now);
  const candidates = healthy.length ? healthy : pool;
  // Prefer the least-used healthy key, then round-robin.
  candidates.sort((a, b) => a.uses - b.uses || a.id.localeCompare(b.id));
  const pick = candidates[rrIndex++ % candidates.length];
  pick.uses++;
  return pick;
}

export async function recordRouterKeyFailure(keyId: string, status?: number, retryAfter?: string | null, message?: string | null): Promise<void> {
  await loadKeys();
  const k = keys.find((x) => x.id === keyId);
  if (!k) return;
  if (status === 429) {
    const kind = classifyRateLimit(status, message);
    const ra = retryAfter ? parseInt(retryAfter, 10) : NaN;
    k.limitKind = kind;
    if (kind === 'rpd') {
      // Daily limit — park until midnight Pacific (same rule as the chain).
      const now = new Date();
      const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const msToMidnight = (24 * 60 * 60 * 1000) - ((pt.getHours() * 3600 + pt.getMinutes() * 60 + pt.getSeconds()) * 1000 + pt.getMilliseconds());
      k.cooldownUntil = Date.now() + Math.max(msToMidnight, 60_000);
    } else {
      k.cooldownUntil = Date.now() + Math.max(65, Number.isFinite(ra) ? ra : 0) * 1000;
    }
    k.lastError = limitLabel(kind, Number.isFinite(ra) ? ra : undefined);
  } else {
    k.cooldownUntil = Date.now() + 60_000;
    k.lastError = message ? String(message).slice(0, 120) : `HTTP ${status || 'error'}`;
  }
}

export async function recordRouterKeySuccess(keyId: string): Promise<void> {
  await loadKeys();
  const k = keys.find((x) => x.id === keyId);
  if (!k) return;
  k.cooldownUntil = 0;
  k.limitKind = null;
  k.lastError = undefined;
}

export async function routerKeyStatus(): Promise<RouterKeyStatus[]> {
  await loadKeys();
  const now = Date.now();
  return keys.map((k) => {
    const retryInSec = k.cooldownUntil > now ? Math.ceil((k.cooldownUntil - now) / 1000) : 0;
    return {
      id: k.id,
      provider: k.provider,
      name: k.name,
      source: k.source,
      status: k.cooldownUntil > now ? (k.limitKind === 'rpd' ? 'limited' : 'cooldown') : 'live',
      limitKind: k.limitKind || null,
      limitLabel: k.lastError || undefined,
      retryInSec: retryInSec || undefined,
      uses: k.uses,
    };
  });
}

export async function routerKeyCounts(): Promise<Record<RouterProvider, { total: number; live: number }>> {
  const list = await routerKeyStatus();
  const out: Record<RouterProvider, { total: number; live: number }> = {
    gemini: { total: 0, live: 0 },
    groq: { total: 0, live: 0 },
    openrouter: { total: 0, live: 0 },
  };
  for (const k of list) {
    out[k.provider].total++;
    if (k.status === 'live') out[k.provider].live++;
  }
  return out;
}
