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
//    deploys stay in the agent loop (they need judgement + confirmation) —
//    EXCEPT two deterministic edits (Step 14): "change the title to X" and
//    "replace text A with B" are exact string operations on a known file,
//    so they run as code too (kind 'edit', never cached, no model call).
// 5. ZERO-COST TOOL ROUTING (Step 14): requests that map 1:1 onto a
//    zero-cost tool (local_rag, vector_store search, public_api_discovery,
//    free_tier_directory, desh_api) are matched deterministically and run
//    as code — no model call, result served (and cached) like any direct
//    command.
// 6. CACHE PERSISTENCE (Step 14): the tool-result cache is written to
//    data/direct-cache.json (debounced) and reloaded on startup, so a
//    restart does not lose cached results. Entries still expire by TTL and
//    file reads are still validated by mtime+size.
//
// Honest limit: API cost can be cut ~80-90% for tool work this way, but not
// to absolute zero — whenever the model must read a tool result to write an
// answer, that call costs tokens. The goal is: no model call unless a model
// is actually needed.
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export type DirectKind = 'tool' | 'local' | 'edit';

/** Deterministic file edit (kind 'edit'). Never cached — a write. */
export interface DirectEdit {
  /** Exact string op: replace <title>…</title>, or replace one literal string. */
  op: 'set_title' | 'replace_text';
  /** File to edit, resolved inside the workspace (default: this session's index.html). */
  file: string;
  /** Old literal text (replace_text only). */
  oldText?: string;
  /** New title (set_title) or replacement text (replace_text). */
  newText: string;
}

export interface DirectCommand {
  kind: DirectKind;
  /** serverTools name (kind 'tool') or local handler id (kind 'local'). */
  tool: string;
  args: Record<string, unknown>;
  /** Short label shown in the UI (with the ⚡ zero-cost marker). */
  label: string;
  cacheable: boolean;
  /** Present only when kind === 'edit'. */
  edit?: DirectEdit;
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

  // --- Zero-cost tool routing (Step 14) ------------------------------------
  // These tools cost no API calls (offline snapshots / local corpus /
  // deterministic helpers), so a request that maps 1:1 onto one runs as
  // code. Patterns are deliberately narrow — anything ambiguous falls
  // through to the model below.
  // vector_store search: "search my vector store for X"
  const vsM = /^search\b.*\b(vector\s+store|memory\s+store)\b.*\bfor\b\s+(.+?)\s*$/i.exec(p);
  if (vsM && vsM[2] && vsM[2].length >= 2) {
    return { kind: 'tool', tool: 'vector_store', args: { action: 'search', query: vsM[2] }, label: `⚡ Vector store: "${vsM[2]}" (direct — no model call)`, cacheable: true };
  }
  // local_rag: "search my notes/corpus for X", "what do my notes say about X"
  const ragM = /^(search|ask|find|what)\b.*\b(my|local|corpus|notes?|projects?)\b.*\b(about|for|say)\b\s+(.+?)\s*$/i.exec(p);
  if (ragM && ragM[4] && ragM[4].length >= 2) {
    return { kind: 'tool', tool: 'local_rag', args: { query: ragM[4] }, label: `⚡ Local notes: "${ragM[4]}" (direct — no model call)`, cacheable: true };
  }
  // public_api_discovery: "find a free api for weather", "free apis for maps"
  const apiM = /^(find|search|show|list|give)\b.*\b(free\s+)?(public\s+)?apis?\b.*\bfor\b\s+(.+?)\s*$/i.exec(p);
  if (apiM && apiM[4] && apiM[4].length >= 2) {
    return { kind: 'tool', tool: 'public_api_discovery', args: { query: apiM[4] }, label: `⚡ Free APIs for "${apiM[4]}" (direct — no model call)`, cacheable: true };
  }
  // free_tier_directory: "free hosting for a website", "what free tier database can I use"
  const ftM = /^(?:(?:find|show|search|what|which|list|give)\b.*)?\bfree\b.*\b(tier|hosting|database|host|storage|email)\b(?:\s+for\s+(.+))?.*$/i.exec(p);
  if (ftM) {
    const need = (ftM[3] || ftM[2] || '').trim();
    return { kind: 'tool', tool: 'free_tier_directory', args: { query: need }, label: `⚡ Free tier: "${need || ftM[2]}" (direct — no model call)`, cacheable: true };
  }
  // desh_api: deterministic Bangladesh helpers — subcommand is the whole prompt.
  const deshM = /^(divisions|districts?(\s+of)?\s+\S+|banks|gold|branches\s+\S+|unions\s+\S+|number\s+\S+|taka\s+\S+|tax\s+\S+|zakat\s+\S+|date\s+\S+|nid\s+\S+|plate\s+\S+|bijoy\s+\S+|unicode\s+\S+)\s*$/i.exec(p);
  if (deshM) {
    return { kind: 'tool', tool: 'desh_api', args: { command: p }, label: `⚡ ${p} (direct — no model call)`, cacheable: true };
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

  // --- Deterministic edits (Step 14) ---------------------------------------
  // "change the title to X" / "set the title to X" [in <file>] — exact
  // <title> replacement in the session's index.html (or the named file).
  // No model call: the old title is read from the file, not guessed.
  const titleM = /^(change|set|update)\b.*\btitle\b.*\bto\b\s+["']?(.+?)["']?\s*(?:in\s+([A-Za-z0-9_.\-\/]+))?\s*$/i.exec(p);
  if (titleM && titleM[2] && titleM[2].length >= 1 && !/^(file|files?)$/i.test(titleM[2])) {
    const file = resolveEditFile(titleM[3], projectDir);
    if (!file) return null;
    return {
      kind: 'edit', tool: 'direct_edit', args: {},
      label: `⚡ Title → "${titleM[2]}" (direct — no model call)`,
      cacheable: false,
      edit: { op: 'set_title', file, newText: titleM[2] },
    };
  }
  // "replace text A with B" / "replace "A" with "B"" [in <file>] — literal
  // first-occurrence replacement. Quotes around A and B are required so the
  // match is exact, never a guess at word boundaries.
  const replaceM = /^replace\b(?:\s+text)?\s+["'](.+?)["']\s+with\s+["'](.*?)["']\s*(?:in\s+([A-Za-z0-9_.\-\/]+))?\s*$/i.exec(p);
  if (replaceM && replaceM[1]) {
    const file = resolveEditFile(replaceM[3], projectDir);
    if (!file) return null;
    return {
      kind: 'edit', tool: 'direct_edit', args: {},
      label: `⚡ Replace "${replaceM[1]}" → "${replaceM[2]}" (direct — no model call)`,
      cacheable: false,
      edit: { op: 'replace_text', file, oldText: replaceM[1], newText: replaceM[2] },
    };
  }

  return null;
}

/** Resolve an edit target: named file (project dir first, then workspace
 * root) or the session's index.html. Returns null when the path would
 * escape the workspace. When the named file exists nowhere, the
 * project-dir path is returned so the error names the file the user meant. */
export function resolveEditFile(named: string | undefined, projectDir: string): string | null {
  const cwd = process.cwd();
  const rel = named ? named : 'index.html';
  const inProject = path.resolve(cwd, projectDir, rel);
  const inWorkspace = path.resolve(cwd, rel);
  if (!inProject.startsWith(cwd + path.sep) || !inWorkspace.startsWith(cwd + path.sep)) return null;
  if (named) {
    if (fsSync.existsSync(inProject)) return inProject;
    if (fsSync.existsSync(inWorkspace)) return inWorkspace;
  }
  return inProject;
}

/** Execute a deterministic edit (kind 'edit'). Reads the file, applies one
 * exact string operation, writes it back. No model call, no network. */
export async function applyDirectEdit(cmd: DirectCommand): Promise<string> {
  const edit = cmd.edit;
  if (!edit) throw new Error('Direct edit has no edit spec.');
  const abs = path.resolve(edit.file);
  if (!abs.startsWith(process.cwd())) throw new Error('Edit target is outside the workspace.');
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf-8');
  } catch {
    throw new Error(`File not found: ${path.relative(process.cwd(), abs)} — build a project first, or name a file that exists.`);
  }
  if (edit.op === 'set_title') {
    const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(content);
    if (m) {
      const next = content.replace(m[0], `<title>${edit.newText}</title>`);
      await fs.writeFile(abs, next, 'utf-8');
      return `✅ Title changed to "${edit.newText}" in ${path.relative(process.cwd(), abs)} (was "${m[1]}"). No model call used.`;
    }
    const headM = /<head[^>]*>/i.exec(content);
    if (headM) {
      const next = content.replace(headM[0], `${headM[0]}\n<title>${edit.newText}</title>`);
      await fs.writeFile(abs, next, 'utf-8');
      return `✅ Title set to "${edit.newText}" in ${path.relative(process.cwd(), abs)} (no <title> tag existed — one was added). No model call used.`;
    }
    throw new Error(`No <title> tag and no <head> in ${path.relative(process.cwd(), abs)} — cannot set a title.`);
  }
  // replace_text
  const oldText = edit.oldText || '';
  if (!oldText) throw new Error('Replace needs the text to replace.');
  if (!content.includes(oldText)) {
    throw new Error(`"${oldText}" not found in ${path.relative(process.cwd(), abs)} — nothing changed.`);
  }
  await fs.writeFile(abs, content.replace(oldText, edit.newText), 'utf-8');
  return `✅ Replaced "${oldText}" with "${edit.newText}" in ${path.relative(process.cwd(), abs)} (first occurrence). No model call used.`;
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

// --- Cache persistence (Step 14) -------------------------------------------
// In-memory cache is mirrored to data/direct-cache.json (debounced write)
// and reloaded on startup, so cached tool results survive a server restart.
// data/ is gitignored runtime state (same as chats/memory). Entries still
// expire by TTL on load, and file reads are still validated by mtime+size
// on hit, so a stale persisted entry can never serve a changed file.
const CACHE_FILE = path.join(process.cwd(), 'data', 'direct-cache.json');
const CACHE_FILE_MAX_BYTES = 1024 * 1024;
let cacheLoaded = false;
let cacheLoadPromise: Promise<void> | null = null;
let cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
let cacheSaveChain: Promise<void> = Promise.resolve();

interface PersistedCacheEntry extends CacheEntry {
  key: string;
}

async function loadPersistedCache(): Promise<void> {
  if (cacheLoaded) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const raw = await fs.readFile(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedCacheEntry[];
        if (!Array.isArray(parsed)) return;
        const now = Date.now();
        for (const e of parsed) {
          if (!e || typeof e.key !== 'string' || !e.result || typeof e.at !== 'number' || typeof e.ttlMs !== 'number') continue;
          if (now - e.at > e.ttlMs) continue; // expired while the server was down
          if (CACHE.size >= CACHE_MAX) break;
          CACHE.set(e.key, { result: e.result, at: e.at, ttlMs: e.ttlMs, ...(e.mtimeMs !== undefined ? { mtimeMs: e.mtimeMs } : {}), ...(e.size !== undefined ? { size: e.size } : {}) });
        }
      } catch { /* no cache file yet, or corrupt — start empty */ }
      cacheLoaded = true;
    })();
  }
  await cacheLoadPromise;
}

function schedulePersistCache(): void {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    cacheSaveChain = cacheSaveChain.then(persistCacheNow).catch(() => {});
  }, 300);
}

async function persistCacheNow(): Promise<void> {
  try {
    let entries: PersistedCacheEntry[] = [];
    for (const [key, e] of CACHE) {
      try {
        JSON.stringify(e.result); // skip results that cannot be stored as JSON
        entries.push({ key, result: e.result, at: e.at, ttlMs: e.ttlMs, ...(e.mtimeMs !== undefined ? { mtimeMs: e.mtimeMs } : {}), ...(e.size !== undefined ? { size: e.size } : {}) });
      } catch { /* unserializable result — keep it in memory only */ }
    }
    // Keep the file small: newest entries first, cap at ~1 MB.
    entries = entries.slice(-CACHE_MAX);
    let json = JSON.stringify(entries);
    while (json.length > CACHE_FILE_MAX_BYTES && entries.length > 1) {
      entries = entries.slice(Math.floor(entries.length / 2));
      json = JSON.stringify(entries);
    }
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, json, 'utf-8');
  } catch { /* persistence is best-effort — the in-memory cache still works */ }
}

/** Test/ops helper: flush any pending persisted-cache write now. */
export async function flushDirectCache(): Promise<void> {
  if (cacheSaveTimer) { clearTimeout(cacheSaveTimer); cacheSaveTimer = null; }
  cacheSaveChain = cacheSaveChain.then(persistCacheNow).catch(() => {});
  await cacheSaveChain;
}

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
  await loadPersistedCache();
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
  await loadPersistedCache();
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
  schedulePersistCache();
}

export function directCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits: CACHE_STATS.hits, misses: CACHE_STATS.misses, entries: CACHE.size };
}
