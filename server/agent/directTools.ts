// Zero-API-cost tool layer (Tier 0) — mirrors the on-device-tools-first
// design: deterministic commands run as code, never through the model.
//
// 1. RULE-BASED ROUTING: "show file X" -> view_file, "list files" ->
//    list_dir, "git status" -> git_status — a local pattern matcher picks the
//    tool with ZERO API calls. Only ambiguous requests go to the model.
// 2. DIRECT-TO-UI RESULTS: outputs the user just needs to SEE (file contents,
//    search results, file lists) go straight to the UI without being fed back
//    to the model. The model is called only when synthesis/reasoning or a
//    written answer is actually needed.
// 3. CACHE: the same file/search asked twice is served from cache (validated
//    by file mtime), no model call.
// 4. MODEL-FREE OPS: file reads, git status, list/grep, memory/projects
//    lists run as code and report to the UI directly. Writes, builds and
//    deploys stay in the agent loop (they need judgement + confirmation).
//
// Honest limit: API cost can be cut ~80-90% for tool work this way, but not
// to absolute zero — whenever the model must read a tool result to write an
// answer, that call costs tokens. The goal is: no model call unless a model
// is actually needed.
import fs from 'fs/promises';
import path from 'path';

export type DirectKind = 'tool' | 'local';

export interface DirectCommand {
  kind: DirectKind;
  /** serverTools name (kind 'tool') or local handler id (kind 'local'). */
  tool: string;
  args: Record<string, unknown>;
  /** Short label shown in the UI (with the ⚡ zero-cost marker). */
  label: string;
  cacheable: boolean;
}

// Local handlers (no serverTools call — pure code, served from memory.ts /
// usage.ts by the orchestrator).
export const LOCAL_HANDLERS = new Set([
  'list_projects',
  'list_chats',
  'show_memory',
  'show_usage',
  'list_skills',
]);

const FILE_PATH_RE = /([A-Za-z0-9_.\-\/]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|yml|yaml|xml|svg|png|jpg|jpeg|webp))/i;

function cleanPrompt(prompt: string): string {
  return (prompt || '').trim();
}

/** Match a deterministic command. Returns null when the request needs the model. */
export function matchDirectCommand(prompt: string, sessionId?: string): DirectCommand | null {
  const p = cleanPrompt(prompt);
  if (!p) return null;
  const lower = p.toLowerCase();
  const projectDir = sessionId ? `projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : 'projects';

  // --- Lists ---------------------------------------------------------------
  // A specific file path (e.g. "show file README.md") is a read, not a list —
  // the list branch must not swallow it.
  if (/^(list|show|দেখাও|তালিকা|ls)\b.*\b(files?|ফাইল)\b/i.test(p) && !/write|edit|create|make|delete|move/i.test(p) && !FILE_PATH_RE.test(p)) {
    return { kind: 'tool', tool: 'list_dir', args: { DirectoryPath: projectDir }, label: `⚡ Files in this project (direct — no model call)`, cacheable: true };
  }
  if (/^(list|show|what).*\b(skills?|স্কিল)\b/i.test(p)) {
    return { kind: 'local', tool: 'list_skills', args: {}, label: '⚡ Skills list (direct — no model call)', cacheable: true };
  }
  if (/^(list|show|my)\b.*\b(projects?|প্রজেক্ট)\b/i.test(p)) {
    return { kind: 'local', tool: 'list_projects', args: {}, label: '⚡ Projects (direct — no model call)', cacheable: true };
  }
  if (/^(list|show|my)\b.*\b(chats?|conversations?|history|চ্যাট)\b/i.test(p)) {
    return { kind: 'local', tool: 'list_chats', args: {}, label: '⚡ Past chats (direct — no model call)', cacheable: true };
  }
  if (/^(show|what).*\b(memory|মেমরি)\b/i.test(p)) {
    return { kind: 'local', tool: 'show_memory', args: {}, label: '⚡ Memory (direct — no model call)', cacheable: true };
  }
  if (/^(show|what|how much).*\b(usage|cost|খরচ|token)\b/i.test(p)) {
    return { kind: 'local', tool: 'show_usage', args: {}, label: '⚡ Usage (direct — no model call)', cacheable: false };
  }

  // --- Git -----------------------------------------------------------------
  if (/^git\s+status\b/i.test(p)) {
    return { kind: 'tool', tool: 'git_status', args: {}, label: '⚡ Git status (direct — no model call)', cacheable: true };
  }
  if (/^git\s+diff\b/i.test(p)) {
    return { kind: 'tool', tool: 'git_diff', args: {}, label: '⚡ Git diff (direct — no model call)', cacheable: true };
  }

  // --- Read a file ----------------------------------------------------------
  const showFile = /^(show|read|open|view|cat|দেখাও|খোলো|পড়ো|পড়ো)\b/i.test(p) && !/write|edit|create|make|delete/i.test(p);
  if (showFile) {
    const m = FILE_PATH_RE.exec(p);
    if (m) {
      return { kind: 'tool', tool: 'view_file', args: { AbsolutePath: m[1] }, label: `⚡ ${m[1]} (direct — no model call)`, cacheable: true };
    }
  }

  // --- Search / grep --------------------------------------------------------
  const grepM = /^(search|grep|find|খুঁজে|খোঁজো)\b\s+(?:for\s+)?["']?(.+?)["']?\s*(?:in\s+([A-Za-z0-9_.\-\/]+))?\s*$/i.exec(p);
  if (grepM && grepM[2] && grepM[2].length >= 2 && !/^(file|files?)$/i.test(grepM[2])) {
    return {
      kind: 'tool',
      tool: 'grep_search',
      args: { Pattern: grepM[2], ...(grepM[3] ? { SearchPath: grepM[3] } : {}) },
      label: `⚡ Search "${grepM[2]}" (direct — no model call)`,
      cacheable: true,
    };
  }
  const findM = /^(find|locate)\b.*\bfile\b\s+["']?([A-Za-z0-9_*?.\-/]+)["']?\s*$/i.exec(p);
  if (findM) {
    return { kind: 'tool', tool: 'find_by_name', args: { Pattern: findM[2] }, label: `⚡ Find file "${findM[2]}" (direct — no model call)`, cacheable: true };
  }

  // --- Read a skill by name -------------------------------------------------
  const skillM = /^(show|read|load)\b.*\bskill\b\s+["']?([a-z0-9][a-z0-9\-]+)["']?\s*$/i.exec(p);
  if (skillM) {
    return { kind: 'tool', tool: 'read_skill', args: { SkillName: skillM[2] }, label: `⚡ Skill "${skillM[2]}" (direct — no model call)`, cacheable: true };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool-result cache: same file/search twice -> cached result, no model call.
// File reads are validated by mtime+size; everything else has a short TTL.
// ---------------------------------------------------------------------------
interface CacheEntry {
  result: unknown;
  at: number;
  ttlMs: number;
  mtimeMs?: number;
  size?: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 100;
const CACHE_STATS = { hits: 0, misses: 0 };

const CACHEABLE_TOOLS = new Set([
  'view_file', 'fileRead', 'list_dir', 'grep_search', 'find_by_name', 'git_status', 'git_diff',
  'read_skill', 'file_grep', 'local_rag', 'vector_store', 'public_api_discovery',
  'free_tier_directory', 'desh_api', 'list_skills', 'list_projects', 'list_chats', 'show_memory',
]);

function cacheKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(args || {})}`;
}

async function fileFingerprint(args: Record<string, unknown>): Promise<{ mtimeMs: number; size: number } | null> {
  const p = (args.AbsolutePath || args.filePath || args.path) as string | undefined;
  if (!p || typeof p !== 'string') return null;
  const candidates = [p, path.join(process.cwd(), p), path.join(process.cwd(), 'projects', p)];
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isFile()) return { mtimeMs: st.mtimeMs, size: st.size };
    } catch { /* try next */ }
  }
  return null;
}

export async function getCachedToolResult(tool: string, args: Record<string, unknown>): Promise<{ hit: boolean; result?: unknown }> {
  if (!CACHEABLE_TOOLS.has(tool)) return { hit: false };
  const key = cacheKey(tool, args);
  const entry = CACHE.get(key);
  if (!entry) { CACHE_STATS.misses++; return { hit: false }; }
  if (Date.now() - entry.at > entry.ttlMs) { CACHE.delete(key); CACHE_STATS.misses++; return { hit: false }; }
  if (entry.mtimeMs !== undefined) {
    const fp = await fileFingerprint(args);
    if (!fp || fp.mtimeMs !== entry.mtimeMs || fp.size !== entry.size) {
      CACHE.delete(key);
      CACHE_STATS.misses++;
      return { hit: false };
    }
  }
  CACHE_STATS.hits++;
  return { hit: true, result: entry.result };
}

export async function setCachedToolResult(tool: string, args: Record<string, unknown>, result: unknown): Promise<void> {
  if (!CACHEABLE_TOOLS.has(tool)) return;
  const fp = await fileFingerprint(args);
  const ttlMs = tool === 'git_status' || tool === 'git_diff' ? 30_000 : 120_000;
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest) CACHE.delete(oldest);
  }
  CACHE.set(cacheKey(tool, args), {
    result,
    at: Date.now(),
    ttlMs,
    ...(fp ? { mtimeMs: fp.mtimeMs, size: fp.size } : {}),
  });
}

export function directCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits: CACHE_STATS.hits, misses: CACHE_STATS.misses, entries: CACHE.size };
}
