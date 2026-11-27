// Prompt/build response cache (STEP 13, P1).
//
// Audit finding (Q4 #3): repeat builds re-paid the full model cost — there
// was no response cache. This module stores a finished build (generated
// HTML + assistant reply) keyed by normalised prompt + requested model +
// task, in a server-side JSON file (same pattern as the router usage file
// in server/router/index.ts: data/<file>.json, lazy load, debounced save).
// Server-side file cache, not IndexedDB: the build flow is server-side
// (the agent loop runs in handleOrchestratedChat), so the cache must live
// where the loop runs — the client never sees the router at all on a hit.
//
// Bounds (so the cache cannot grow forever):
//   BUILD_CACHE_MAX_ENTRIES   = 50 entries; oldest-by-last-served evicted first (LRU).
//   BUILD_CACHE_MAX_AGE_MS    = 7 days; entries older than this are dropped on load.
//   BUILD_CACHE_MAX_HTML_BYTES = 2 MiB per entry; larger builds are not stored.
// The file itself is runtime data under data/ (gitignored) and holds only
// generated HTML + reply text — never API keys.
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'build-cache.json');

export const BUILD_CACHE_MAX_ENTRIES = 50;
export const BUILD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const BUILD_CACHE_MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MiB

export interface BuildCacheEntry {
  key: string;
  /** Normalised prompt (lowercased, whitespace-collapsed) — for debugging. */
  prompt: string;
  /** Requested model key component: the selected model, or 'auto'. */
  model: string;
  /** Task kind the build ran under — always 'coding' for cached builds. */
  task: string;
  /** Model that actually produced the build (may differ from `model` on failover). */
  builtByModel?: string;
  /** Assistant reply text served with the build. */
  reply: string;
  /** Generated site HTML (restored to the session preview on a hit). */
  html: string;
  previewUrl: string;
  createdAt: number;
  lastServedAt: number;
  hits: number;
}

const entries = new Map<string, BuildCacheEntry>();
let cacheLoaded = false;
const CACHE_STATS = { hits: 0, misses: 0 };

/** Normalise a build prompt so trivial rephrasings hit the same entry. */
export function normalizeBuildPrompt(prompt: string): string {
  return (prompt || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[।!?.]+$/g, '')
    .trim();
}

/** Cache key: sha256 over normalised prompt + model + task. */
export function buildCacheKey(prompt: string, model: string, task: string): string {
  const normalized = normalizeBuildPrompt(prompt);
  return createHash('sha256')
    .update(`build-cache-v1\n${task}\n${model}\n${normalized}`, 'utf-8')
    .digest('hex');
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, BuildCacheEntry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed || {})) {
      if (!v || typeof v.html !== 'string' || typeof v.reply !== 'string') continue;
      if (now - (v.createdAt || 0) > BUILD_CACHE_MAX_AGE_MS) continue; // expired
      entries.set(k, v);
    }
    // Enforce the entry bound on load (oldest-served first out).
    trimToMaxEntries();
  } catch { /* no cache yet */ }
}

function trimToMaxEntries(): void {
  if (entries.size <= BUILD_CACHE_MAX_ENTRIES) return;
  const sorted = [...entries.values()].sort((a, b) => (a.lastServedAt || a.createdAt || 0) - (b.lastServedAt || b.createdAt || 0));
  for (const victim of sorted.slice(0, entries.size - BUILD_CACHE_MAX_ENTRIES)) {
    entries.delete(victim.key);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function saveCacheSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdir(DATA_DIR, { recursive: true })
      .then(() => fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf-8'))
      .catch(() => {});
  }, 5000);
  saveTimer.unref?.();
}

/** Exact hit: returns the entry (bumping hits / lastServedAt) or null. */
export async function getBuildCacheEntry(key: string): Promise<BuildCacheEntry | null> {
  await loadCache();
  const entry = entries.get(key);
  if (!entry) { CACHE_STATS.misses++; return null; }
  if (Date.now() - entry.createdAt > BUILD_CACHE_MAX_AGE_MS) {
    entries.delete(key);
    saveCacheSoon();
    CACHE_STATS.misses++;
    return null;
  }
  entry.hits++;
  entry.lastServedAt = Date.now();
  CACHE_STATS.hits++;
  saveCacheSoon();
  return entry;
}

/** Store (or refresh) a finished build. Oversized HTML is refused. */
export async function setBuildCacheEntry(entry: BuildCacheEntry): Promise<boolean> {
  await loadCache();
  if (Buffer.byteLength(entry.html || '', 'utf-8') > BUILD_CACHE_MAX_HTML_BYTES) return false;
  if (!entry.html || !entry.reply) return false;
  trimToMaxEntries();
  if (!entries.has(entry.key) && entries.size >= BUILD_CACHE_MAX_ENTRIES) {
    // trimToMaxEntries only shrinks when over the bound; make room first.
    const oldest = [...entries.values()].sort((a, b) => (a.lastServedAt || a.createdAt || 0) - (b.lastServedAt || b.createdAt || 0))[0];
    if (oldest) entries.delete(oldest.key);
  }
  const prev = entries.get(entry.key);
  entries.set(entry.key, {
    ...entry,
    createdAt: prev?.createdAt ?? entry.createdAt,
    hits: prev?.hits ?? 0,
    lastServedAt: Date.now(),
  });
  saveCacheSoon();
  return true;
}

export function buildCacheStats(): { hits: number; misses: number; entries: number; maxEntries: number; maxAgeDays: number; maxHtmlBytes: number } {
  return {
    hits: CACHE_STATS.hits,
    misses: CACHE_STATS.misses,
    entries: entries.size,
    maxEntries: BUILD_CACHE_MAX_ENTRIES,
    maxAgeDays: BUILD_CACHE_MAX_AGE_MS / (24 * 60 * 60 * 1000),
    maxHtmlBytes: BUILD_CACHE_MAX_HTML_BYTES,
  };
}
