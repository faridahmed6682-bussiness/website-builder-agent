// Nexus-ai6 tools, re-implemented in TypeScript for the Node service.
// Port of Nexus-ai6 (Kotlin/Android) tool behaviour — no Kotlin code copied.
// Free-only; no secrets in code (env vars / the encrypted GitHub store only).
// Every tool here is registered in `nexusTools` with a working implementation.
// Tool results are capped by the orchestrator (3000 chars) like Nexus-ai6's
// TOOL_RESULT_MAX_CHARS. Data catalogs live in server/nexusData/ (extracted
// mechanically from the Kotlin sources — see /tmp/extract-nexus-data.py).
import { Type, type FunctionDeclaration } from '@google/genai';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { Octokit } from 'octokit';
import AdmZip from 'adm-zip';
import { pushFilesToGitHub, ensureRepo, getGitHubLogin, resolveGitHubToken, sanitizeRepoPath } from './githubPush.ts';
import { getGitHubConnection } from './githubAuth.ts';
import { runBrowseTask, runBrowseJob, getScreenshot, resumeBrowseJob, isWorkerConfigured, startLiveSession, liveAction, liveInput, getLiveFrame, isPoolFullError } from './browserWorker.ts';
import { chatOnce, codingChain } from './llmClient.ts';
import { verifyLive } from './modelChain.ts';
import { loadStore, saveStoreSoon, newId, startNexusScheduler, onReminder, onWatchHit, type VectorEntry } from './nexusStore.ts';
import * as googleApis from './googleApis.ts';
import { startDeploy, getDeployJob, resolveProjectDir } from './deployService.ts';

// ---------------------------------------------------------------------------
// Bundled data (loaded once; empty arrays on failure — tools degrade cleanly)
// ---------------------------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), 'server/agent/nexusData');
function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, file), 'utf-8')) as T;
  } catch {
    return fallback;
  }
}
interface PublicApiEntry { name: string; url: string; auth: string; category: string; descriptionBn: string; descriptionEn: string }
interface FreeTierEntry { name: string; category: string; freeTierEn: string; freeTierBn: string; needsCard: boolean; url: string }
const PUBLIC_APIS = loadJson<PublicApiEntry[]>('public-apis.json', []);
const FREE_TIERS = loadJson<FreeTierEntry[]>('free-tiers.json', []);
const DESH_DATA = loadJson<any>('desh-data.json', { districtsByDivision: {}, numberWords0_99: [], banglaMonths: [], bijoy: {} });
const RAG_STOPWORDS = loadJson<{ EN_STOPWORDS: string[]; BN_STOPWORDS: string[] }>('rag-stopwords.json', { EN_STOPWORDS: [], BN_STOPWORDS: [] });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const TOOL_TEXT_CAP = 3000;

function cap(text: string, n = TOOL_TEXT_CAP): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n)}… (First ${n} characters — ask for more to continue.)`;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) NexusAI/1.1' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseOwnerRepo(input: string): { owner: string; repo: string } {
  const m = input.trim().replace(/\.git$/, '').match(/(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!m) throw new Error(`Could not parse owner/repo from "${input}". Use owner/repo or a GitHub URL.`);
  return { owner: m[1], repo: m[2] };
}

async function githubClient(): Promise<Octokit> {
  const token = await resolveGitHubToken().catch(() => '');
  return new Octokit(token ? { auth: token } : {});
}

// ---------------------------------------------------------------------------
// local_rag — TF-IDF over the service's own corpus (port of LocalRag.kt)
// ---------------------------------------------------------------------------
const EN_STOP = new Set(RAG_STOPWORDS.EN_STOPWORDS);
const BN_STOP = new Set(RAG_STOPWORDS.BN_STOPWORDS);

function tokenize(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) || []).map((t) => t.toLowerCase());
}

function scoringTokens(text: string): string[] {
  return tokenize(text).filter((t) => !EN_STOP.has(t) && !BN_STOP.has(t));
}

interface Passage { id: string; source: string; text: string }

function chunkText(text: string, maxLen = 800): string[] {
  const chunks: string[] = [];
  const paras = text.split(/\n\s*\n/);
  for (const para of paras) {
    if (para.length <= maxLen) {
      if (para.trim()) chunks.push(para.trim());
      continue;
    }
    const lines = para.split('\n');
    let cur = '';
    for (const line of lines) {
      if ((cur + '\n' + line).length > maxLen && cur) { chunks.push(cur.trim()); cur = line; }
      else cur = cur ? `${cur}\n${line}` : line;
      if (cur.length > maxLen) { chunks.push(cur.slice(0, maxLen)); cur = cur.slice(maxLen); }
    }
    if (cur.trim()) chunks.push(cur.trim());
  }
  return chunks;
}

const SKIP_RAG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'mp4', 'apk', 'zip']);
const SKIP_RAG_DIRS = new Set(['node_modules', 'dist', '.git', 'data']);

async function collectRagPassages(): Promise<Passage[]> {
  const passages: Passage[] = [];
  const store = await loadStore();
  for (const g of store.goals) {
    passages.push({ id: `goal:${g.title}`, source: 'goals', text: `${g.title} — progress ${g.progress}%` });
  }
  // Workspace files: newest 20 by mtime, ≤200 KB, text only.
  const files: Array<{ abs: string; rel: string; mtime: number }> = [];
  async function walk(dir: string, rel: string) {
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_RAG_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        const ext = e.name.split('.').pop()?.toLowerCase() || '';
        if (SKIP_RAG_EXT.has(ext)) continue;
        try {
          const st = await fs.stat(abs);
          if (st.size > 200 * 1024) continue;
          files.push({ abs, rel: r, mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
    }
  }
  await walk(path.resolve(process.cwd(), 'projects'), 'projects');
  for (const f of ['README.md']) {
    try {
      const abs = path.resolve(process.cwd(), f);
      const st = await fs.stat(abs);
      files.push({ abs, rel: f, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let n = 0;
  for (const f of files.slice(0, 20)) {
    try {
      const content = (await fs.readFile(f.abs, 'utf-8')).slice(0, 20000);
      for (const [i, chunk] of chunkText(content).entries()) {
        passages.push({ id: `file:${f.rel}#${i}`, source: f.rel, text: chunk });
      }
      n++;
      if (n >= 20) break;
    } catch { /* skip */ }
  }
  return passages;
}

function rankRag(query: string, passages: Passage[], topK = 5): Array<{ passage: Passage; score: number; snippet: string }> {
  const queryTokens = scoringTokens(query);
  const querySet = new Set(queryTokens);
  if (!queryTokens.length || !passages.length) return [];
  const N = passages.length;
  const df = new Map<string, number>();
  const passageTokens = passages.map((p) => {
    const toks = scoringTokens(p.text);
    const uniq = new Set(toks);
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
    return toks;
  });
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const results: Array<{ passage: Passage; score: number; snippet: string }> = [];
  const queryLower = query.toLowerCase();
  passages.forEach((p, i) => {
    const toks = passageTokens[i];
    if (!toks.length) return;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of querySet) {
      const count = tf.get(t) || 0;
      if (count > 0) score += (1 + Math.log(count)) * idf(t);
    }
    if (score === 0) return;
    score /= Math.sqrt(toks.length);
    if (p.text.toLowerCase().includes(queryLower)) score += 1.5;
    // Snippet ≤300 chars centred on the earliest query-term hit.
    let snippet = p.text.slice(0, 300);
    const lower = p.text.toLowerCase();
    let hit = -1;
    for (const t of querySet) {
      const idx = lower.indexOf(t);
      if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
    }
    if (hit >= 0) {
      const start = Math.max(0, hit - 100);
      snippet = `${start > 0 ? '…' : ''}${p.text.slice(start, start + 300)}${start + 300 < p.text.length ? '…' : ''}`;
    }
    results.push({ passage: p, score, snippet });
  });
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ---------------------------------------------------------------------------
// vector_store — in-memory + JSON persistence, hash embedding (port of
// ObjectBoxVectorStore.kt). Default embedding is a deterministic FNV-1a
// char n-gram hash (128 dims) — lexical similarity, NOT meaning.
// ---------------------------------------------------------------------------
const VECTOR_DIMS = 128;

export function hashEmbed(text: string, dims = VECTOR_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const lower = text.toLowerCase();
  const addGram = (gram: string, weight: number) => {
    let hash = -2128831035; // FNV-1a offset basis as signed int
    for (let i = 0; i < gram.length; i++) {
      hash ^= gram.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dims;
    vec[bucket] += weight;
  };
  for (let i = 0; i + 2 <= lower.length; i++) addGram(lower.slice(i, i + 2), 1.0);
  for (let i = 0; i + 3 <= lower.length; i++) addGram(lower.slice(i, i + 3), 1.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function vectorSearch(queryText: string, topK = 5): Promise<Array<{ entry: VectorEntry; score: number }>> {
  const store = await loadStore();
  if (!store.vectorStore.length) return [];
  const q = hashEmbed(queryText);
  const scored = store.vectorStore
    .filter((e) => e.embedding.length === VECTOR_DIMS)
    .map((e) => ({ entry: e, score: cosine(q, e.embedding) }));
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ---------------------------------------------------------------------------
// desh_api — Bangladesh helpers (port of DeshApiTools.kt).
// Offline parts are pure functions; live parts hit deshapi.riadul.com
// (no key) with a JSON-file cache and never throw.
// ---------------------------------------------------------------------------
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const LATIN_DIGITS = '0123456789';

function toBanglaDigits(text: string): string {
  return [...text].map((ch) => {
    const i = LATIN_DIGITS.indexOf(ch);
    return i >= 0 ? BN_DIGITS[i] : ch;
  }).join('');
}

function toLatinDigits(text: string): string {
  return [...text].map((ch) => {
    const i = BN_DIGITS.indexOf(ch);
    return i >= 0 ? LATIN_DIGITS[i] : ch;
  }).join('');
}

function banglaNumberWords(n: number): string {
  const words: string[] = DESH_DATA.numberWords0_99 || [];
  const w = (x: number): string => words[x] || String(x);
  if (n === 0) return 'শূন্য';
  if (n < 0) return `ঋণাত্মক ${banglaNumberWords(-n)}`;
  if (n < 100) return w(n);
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  if (crore > 0) parts.push(`${banglaNumberWords(crore)} কোটি`);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  if (lakh > 0) parts.push(`${banglaNumberWords(lakh)} লাখ`);
  const thousand = Math.floor((n % 100_000) / 1000);
  if (thousand > 0) parts.push(`${banglaNumberWords(thousand)} হাজার`);
  const hundred = Math.floor((n % 1000) / 100);
  if (hundred > 0) parts.push(`${banglaNumberWords(hundred)}শত`);
  const rest = n % 100;
  if (rest > 0) parts.push(banglaNumberWords(rest));
  return parts.join(' ');
}

function formatDecimal(value: number): string {
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) groups.unshift(rest);
  groups.push(lastThree);
  return groups.join(',');
}

function formatLakhCrore(amount: number): string {
  if (!Number.isFinite(amount)) return '';
  if (amount === 0) return '০';
  const negative = amount < 0;
  const rounded = Math.abs(amount).toFixed(2);
  const [intText, fracRaw] = rounded.split('.');
  const fracText = (fracRaw || '').replace(/0+$/, '');
  const grouped = groupIndianDigits(intText);
  const text = fracText ? `${toBanglaDigits(grouped)}.${toBanglaDigits(fracText)}` : toBanglaDigits(grouped);
  return negative ? `ঋণাত্মক ${text}` : text;
}

function formatLakhCroreWords(amount: number): string {
  if (!Number.isFinite(amount)) return '';
  if (amount === 0) return '০';
  const negative = amount < 0;
  const value = Math.abs(amount);
  if (value < 1000) {
    const text = toBanglaDigits(formatDecimal(value));
    return negative ? `ঋণাত্মক ${text}` : text;
  }
  let scaled: number; let unit: string;
  if (value >= 10_000_000) { scaled = value / 10_000_000; unit = 'কোটি'; }
  else if (value >= 100_000) { scaled = value / 100_000; unit = 'লাখ'; }
  else { scaled = value / 1000; unit = 'হাজার'; }
  const text = `${toBanglaDigits(formatDecimal(scaled))} ${unit}`;
  return negative ? `ঋণাত্মক ${text}` : text;
}

function takaInWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '';
  const rounded = amount.toFixed(2);
  const [takaStr, paisaStr] = rounded.split('.');
  const taka = parseInt(takaStr, 10);
  const paisa = parseInt(paisaStr, 10);
  const takaWords = banglaNumberWords(taka);
  return paisa === 0 ? `${takaWords} টাকা` : `${takaWords} টাকা ${banglaNumberWords(paisa)} পয়সা`;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function toBanglaDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  const pohela = new Date(Date.UTC(year, 3, 14));
  let banglaYear: number; let start: Date;
  if (date >= pohela) { banglaYear = year - 593; start = pohela; }
  else { banglaYear = year - 594; start = new Date(Date.UTC(year - 1, 3, 14)); }
  const falgunLength = isLeapYear(start.getUTCFullYear() + 1) ? 30 : 29;
  const lengths = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, falgunLength, 30];
  let remaining = Math.floor((date.getTime() - start.getTime()) / 86400000);
  let monthIndex = 0;
  while (monthIndex < 11 && remaining >= lengths[monthIndex]) { remaining -= lengths[monthIndex]; monthIndex++; }
  const months: string[] = DESH_DATA.banglaMonths || [];
  return `${toBanglaDigits(String(remaining + 1))} ${months[monthIndex] || ''} ${toBanglaDigits(String(banglaYear))} বঙ্গাব্দ`;
}

function bijoyToUnicode(text: string): string {
  const single: Record<string, string> = DESH_DATA.bijoy?.BIJOY_SINGLE || {};
  const consonants = new Set<string>(DESH_DATA.bijoy?.BIJOY_CONSONANT_KEYS || []);
  if (!text) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('Av', i)) { out += 'আ'; i += 2; continue; }
    const ch = text[i];
    if (ch === 'w' || ch === 'x') {
      const kar = ch === 'w' ? 'ি' : 'ী';
      const next = text[i + 1];
      const mapped = next ? single[next] : undefined;
      if (next && mapped && consonants.has(next)) { out += mapped + kar; i += 2; }
      else { out += kar; i += 1; }
      continue;
    }
    out += single[ch] ?? ch;
    i += 1;
  }
  return out;
}

function unicodeToBijoy(text: string): string {
  const toCons: Record<string, string> = DESH_DATA.bijoy?.UNICODE_TO_BIJOY_CONSONANT || {};
  const toBijoy: Record<string, string> = DESH_DATA.bijoy?.UNICODE_TO_BIJOY || {};
  if (!text) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const code = toCons[ch];
    if (code) {
      const next = text[i + 1];
      if (next === 'ি') { out += 'w' + code; i += 2; continue; }
      if (next === 'ী') { out += 'x' + code; i += 2; continue; }
      out += code; i += 1; continue;
    }
    out += toBijoy[ch] ?? ch;
    i += 1;
  }
  return out;
}

function isValidNidFormat(nid: string): boolean {
  const digits = toLatinDigits(nid.trim());
  return (digits.length === 10 || digits.length === 17) && /^\d+$/.test(digits);
}

function isValidPlateFormat(plate: string): boolean {
  const normalized = toLatinDigits(plate.trim()).replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-');
  if (!normalized) return false;
  const bnLetter = '[\\u0980-\\u09FF]';
  const bnWord = `${bnLetter}+(?: ${bnLetter}+)*`;
  const latinWord = '[A-Za-z]+(?: [A-Za-z]+)*';
  const patterns = [
    new RegExp(`^${bnWord} মেট্রো[ -]${bnLetter}[ -]\\d{2}-\\d{4}$`),
    new RegExp(`^${bnWord}[ -]${bnLetter}[ -]\\d{2}-\\d{4}$`),
    new RegExp(`^${latinWord} Metro[ -][A-Za-z][ -]\\d{2}-\\d{4}$`, 'i'),
    new RegExp(`^${latinWord}[ -][A-Za-z][ -]\\d{2}-\\d{4}$`, 'i'),
  ];
  return patterns.some((p) => p.test(normalized));
}

const TAX_SLABS: Array<[number, number]> = [
  [350000, 0.0], [450000, 0.05], [750000, 0.10], [1150000, 0.15], [1650000, 0.20],
];
const TAX_TOP_RATE = 0.25;

function incomeTax(monthlyIncome: number): number {
  if (!Number.isFinite(monthlyIncome) || monthlyIncome <= 0) return 0;
  const annual = monthlyIncome * 12;
  let tax = 0; let lower = 0;
  for (const [limit, rate] of TAX_SLABS) {
    if (annual <= lower) break;
    tax += (Math.min(annual, limit) - lower) * rate;
    lower = limit;
  }
  if (annual > lower) tax += (annual - lower) * TAX_TOP_RATE;
  return tax;
}

const DESH_API_BASE = (process.env.DESH_API_BASE_URL || 'https://deshapi.riadul.com').replace(/\/$/, '');

async function deshCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T | null> {
  const store = await loadStore();
  const hit = store.deshCache[key];
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  try {
    const value = await fetcher();
    store.deshCache[key] = { value, expiresAt: Date.now() + ttlMs };
    saveStoreSoon();
    return value;
  } catch {
    return hit ? (hit.value as T) : null;
  }
}

async function deshGet(pathname: string): Promise<any> {
  const res = await fetch(`${DESH_API_BASE}${pathname}`, {
    headers: { 'User-Agent': 'NexusAIStudio/1.0 (Desh API tools; Node)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Desh API HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Tool declarations
// ---------------------------------------------------------------------------
const S = (description: string) => ({ type: Type.STRING, description });
const I = (description: string) => ({ type: Type.INTEGER, description });
const B = (description: string) => ({ type: Type.BOOLEAN, description });

export const nexusTools: FunctionDeclaration[] = [
  {
    name: 'github_push',
    description: 'Push files to a GitHub repo as ONE commit via the Git Data API (no local git). Auth comes from the one-click connected GitHub account or the GITHUB_TOKEN env var — never pass a token. Blocked paths (secrets, keys, .env, .git) are refused. Creates the repo if it does not exist.',
    parameters: { type: Type.OBJECT, properties: {
      owner: S('GitHub owner (user/org). Omit to use the connected account.'),
      repo: S('Repository name (no slashes or spaces).'),
      branch: S('Branch (default main).'),
      message: S('Commit message.'),
      files: { type: Type.ARRAY, description: 'Files to push.', items: { type: Type.OBJECT, properties: {
        repoPath: S('Repo-relative path, e.g. index.html or assets/style.css.'),
        content: S('File content as text (or base64 when isBinary is true).'),
        isBinary: B('True when content is base64.'),
      }, required: ['repoPath', 'content'] } },
      isPrivate: B('Create the repo as private when creating it.'),
    }, required: ['repo', 'message', 'files'] },
  },
  {
    name: 'github_create_repo',
    description: 'Create a GitHub repository for the authenticated user. Note: GitHub App installation tokens cannot create repos — a PAT with repo scope is needed (connect GitHub with a PAT, or set GITHUB_TOKEN).',
    parameters: { type: Type.OBJECT, properties: {
      name: S('Repository name (no slashes or spaces).'),
      description: S('Optional description.'),
      private: B('True for a private repo (default public).'),
    }, required: ['name'] },
  },
  {
    name: 'github_repos',
    description: 'List GitHub repositories — the connected user’s repos (needs a token) or a named user’s public repos.',
    parameters: { type: Type.OBJECT, properties: {
      username: S('Optional GitHub username for public repos. Omit for the connected user.'),
    }, required: [] },
  },
  {
    name: 'github_file',
    description: 'Read one file from a GitHub repo (contents API, base64-decoded, first 3000 chars).',
    parameters: { type: Type.OBJECT, properties: {
      owner: S('Repo owner.'), repo: S('Repo name.'), path: S('File path in the repo, e.g. README.md.'),
    }, required: ['owner', 'repo', 'path'] },
  },
  {
    name: 'github_issues',
    description: 'GitHub issues — bug tracking for built projects. action: "list" (default, max 10 open), "create" (file a bug), "comment" (add a note to an issue). Bug-fix flow: a failed build or found bug is filed as an issue (or logged) before the fix.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('"list", "create" or "comment" (default list).'),
      owner: S('Repo owner.'), repo: S('Repo name.'),
      title: S('Issue title (create).'), body: S('Issue body / comment text (create, comment).'),
      number: S('Issue number (comment).'), labels: S('Comma-separated labels (create).'),
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'github_prs',
    description: 'List open pull requests of a GitHub repo (max 10).',
    parameters: { type: Type.OBJECT, properties: {
      owner: S('Repo owner.'), repo: S('Repo name.'),
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'github_create_issue',
    description: 'Create a GitHub issue.',
    parameters: { type: Type.OBJECT, properties: {
      owner: S('Repo owner.'), repo: S('Repo name.'), title: S('Issue title.'), body: S('Issue body.'),
    }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'github_create_pr',
    description: 'Create a GitHub pull request.',
    parameters: { type: Type.OBJECT, properties: {
      owner: S('Repo owner.'), repo: S('Repo name.'), title: S('PR title.'), body: S('PR body.'),
      head: S('Head branch (with the changes).'), base: S('Base branch (default main).'),
    }, required: ['owner', 'repo', 'title', 'head'] },
  },
  {
    name: 'github_pull_request',
    description: 'Pull requests — create a PR (so code goes through review instead of a direct push) or list open PRs. Bug-fix flow: after fixing a bug, open a PR from the fix branch, then check CI with github_actions before presenting the work as done.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('"create" or "list" (default list).'),
      owner: S('Repo owner.'), repo: S('Repo name.'),
      title: S('PR title (create).'), body: S('PR body (create).'),
      head: S('Head branch with the changes (create).'), base: S('Base branch, default main (create).'),
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'github_actions',
    description: 'GitHub Actions — list recent workflow runs (CI status/conclusion after a push or PR) or trigger a workflow dispatch. Use after a push or PR to confirm CI is green before presenting the work as done.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('"list_runs" (default) or "trigger".'),
      owner: S('Repo owner.'), repo: S('Repo name.'),
      workflow: S('Workflow file or id, e.g. "ci.yml" (trigger).'),
      ref: S('Branch/tag to run on, default main (trigger).'),
      branch: S('Filter runs by branch (list_runs).'),
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'github_release',
    description: 'Publish a built app as a GitHub release with an optional asset (e.g. a ZIP of the built site). Creates the release (tag, name, notes) and uploads the asset file from the workspace when assetPath is given.',
    parameters: { type: Type.OBJECT, properties: {
      owner: S('Repo owner.'), repo: S('Repo name.'),
      tag: S('Tag name, e.g. v1.0.0.'), name: S('Release title (default = tag).'), body: S('Release notes.'),
      assetPath: S('Optional workspace file to attach, e.g. projects/my-shop.zip or a file inside the project folder.'),
      assetName: S('Optional asset filename (default = the file name).'),
    }, required: ['owner', 'repo', 'tag'] },
  },
  {
    name: 'github_code_search',
    description: 'Search code across GitHub for examples (e.g. how others implement a feature). Returns matching files with links. Code search needs a connected GitHub token.',
    parameters: { type: Type.OBJECT, properties: {
      query: S('Code search query, e.g. "useState debounce" or "tailwind navbar".'),
      repo: S('Optional owner/repo to limit the search to one repo.'),
    }, required: ['query'] },
  },
  {
    name: 'github_import',
    description: 'Import a public GitHub repo into the workspace: clones its file tree via the GitHub API (no git CLI), up to 200 files / 200 KB each / 10 MB total, into projects/import_<repo>_<time>/. Then inspect and work on it with the file tools. Works without a token for public repos; a connected token raises rate limits.',
    parameters: { type: Type.OBJECT, properties: {
      repoUrl: S('GitHub repo URL or owner/repo, e.g. https://github.com/facebook/react or tashfeenahmed/freellmapi.'),
    }, required: ['repoUrl'] },
  },
  {
    name: 'build_page',
    description: 'Build ONE complete single-file HTML page from a description: one LLM call (coding model chain, Hydrogen first) writes a full standalone page with inline CSS into projects/page-<time>.html and returns its preview URL. For multi-file apps use write_to_file instead.',
    parameters: { type: Type.OBJECT, properties: {
      description: S('What the page should be, e.g. "a landing page for Munsi Store, a small shop in Rangpur".'),
    }, required: ['description'] },
  },
  {
    name: 'build_site',
    description: 'Build a full site through an external builder (Google AI Studio or Lovable) driven by the browser worker: the worker opens the builder, pastes the prompt, waits for the build (up to ~10 min), downloads the ZIP and imports it into projects/<name>/. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY and a signed-in Google/Lovable session in the worker browser. If the builder shows a login page, the build stops with LOGIN_REQUIRED.',
    parameters: { type: Type.OBJECT, properties: {
      builder: S('Builder to use: "aistudio" or "lovable".'),
      prompt: S('What to build — the full prompt sent to the builder.'),
      projectName: S('Project folder name (default nexus-site).'),
      github: S('Optional GitHub repo name for the builder’s own Publish → Push to GitHub step.'),
    }, required: ['builder', 'prompt'] },
  },
  {
    name: 'deploy_site',
    description: 'One-click deploy of the current built project: build-check → push to GitHub → trigger the Render deploy hook → report the live URL. Needs GitHub connected (or GITHUB_TOKEN). If the Render deploy hook is not configured, the tool reports the exact one-time setup instead of pretending to deploy.',
    parameters: { type: Type.OBJECT, properties: {
      repo: S('GitHub repo: owner/repo or a plain name (uses the connected account).'),
      branch: S('Branch (default main).'),
      sessionId: S('Session project to deploy; omit for the latest built project.'),
    }, required: ['repo'] },
  },
  {
    name: 'web_search',
    description: 'Free web search with no key (DuckDuckGo instant answers). Thin by design — for deep research use browse_task instead.',
    parameters: { type: Type.OBJECT, properties: { query: S('Search query.') }, required: ['query'] },
  },
  {
    name: 'read_page',
    description: 'Fetch a web page and return its readable text (tags stripped, first 3000 chars). No JS rendering — JS-heavy pages need browse_task instead.',
    parameters: { type: Type.OBJECT, properties: { url: S('Page URL.') }, required: ['url'] },
  },
  {
    name: 'generate_image_pollinations',
    description: 'Generate one image with Pollinations (free, no key, Flux model). Saves it under public/generated/ and returns its URL.',
    parameters: { type: Type.OBJECT, properties: {
      prompt: S('Image prompt (trimmed to 300 chars).'),
      width: I('Width in px (default 512).'), height: I('Height in px (default 512).'),
    }, required: ['prompt'] },
  },
  {
    name: 'file_grep',
    description: 'Search the workspace files for lines containing a query (case-insensitive substring, max 20 lines, each filename:lineno: line).',
    parameters: { type: Type.OBJECT, properties: { query: S('Text to search for.') }, required: ['query'] },
  },
  {
    name: 'local_rag',
    description: 'Zero-token retrieval over the user’s own corpus (workspace project files + saved goals): TF-IDF ranking, top 5 passages with snippets. Returns FOUND with passages, or NOT_FOUND (fall through to the LLM — never invent an answer).',
    parameters: { type: Type.OBJECT, properties: {
      query: S('Question to search the local corpus for.'), topK: I('How many passages (default 5).'),
    }, required: ['query'] },
  },
  {
    name: 'vector_store',
    description: 'Small vector store over the local corpus (hash embeddings, 128 dims — lexical similarity, not meaning; persisted to disk). Actions: add (id+text), search (query), list, remove (id), clear. On search, the store is rebuilt from local_rag passages first.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('add | search | list | remove | clear.'),
      id: S('Entry id (add/remove).'), text: S('Text to store (add).'),
      query: S('Query text (search).'), topK: I('How many hits (default 5).'),
    }, required: ['action'] },
  },
  {
    name: 'public_api_discovery',
    description: 'Search a bundled offline snapshot (200 free public APIs, checked Nov 2026) — no key, no network. Blank query lists categories; "nokey" lists no-key APIs; a category name lists that category; otherwise keyword search (max 10 shown).',
    parameters: { type: Type.OBJECT, properties: {
      query: S('Keyword, category name, "nokey", or blank to list categories.'),
    }, required: [] },
  },
  {
    name: 'free_tier_directory',
    description: 'Search a bundled offline snapshot (45 free-tier services across hosting/database/email/storage/monitoring/AI/maps/auth, checked Nov 2026) — no key, no network. Give a need ("host a website", "database") for the best no-card match, or a keyword to search.',
    parameters: { type: Type.OBJECT, properties: {
      query: S('A need (e.g. "host a website") or a keyword (e.g. "postgres").'),
    }, required: [] },
  },
  {
    name: 'desh_api',
    description: 'Bangladesh helpers. Offline (no key): divisions, districts <division>, number <n> (Bengali words), taka <amount> (taka in words / lakh-crore format), date <yyyy-mm-dd> (Bangla calendar), nid <number> (format check only), plate <plate> (format check only), tax <monthly income> (annual tax by slabs), zakat <assets>, bijoy <text> (Bijoy→Unicode), unicode <text> (Unicode→Bijoy). Live (no key, cached): banks, branches <bank-code> [district], gold, unions <upazila-slug>.',
    parameters: { type: Type.OBJECT, properties: {
      command: S('Subcommand, e.g. "districts ঢাকা", "number 1250", "tax 30000", "banks", "gold".'),
    }, required: ['command'] },
  },
  {
    name: 'browse_task',
    description: 'Run a natural-language browser task on the user’s browser worker (POST /api/browse): open pages, search, read, click through. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      task: S('What the browser should do, in plain language.'), url: S('Optional starting URL.'),
    }, required: ['task'] },
  },
  {
    name: 'browse_job',
    description: 'Run a structured browser job on the worker (read/screenshot/fill/download): creates the job and polls up to 10 min. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY. A paused job (CAPTCHA/login) returns its job id — resume it with browse_resume after the user solves the challenge.',
    parameters: { type: Type.OBJECT, properties: {
      type: S('Job type: read | screenshot | fill | download (default read).'),
      url: S('Target URL (required).'),
      selector: S('Optional CSS selector.'),
      submit: B('Submit the form after filling (fill jobs).'),
    }, required: ['url'] },
  },
  {
    name: 'browse_vision',
    description: 'Answer a question about a web page using a screenshot only when the page text cannot answer it (text first, screenshot last resort; screenshot capped at 120 KB). Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      url: S('Page URL.'), question: S('Question about the page.'),
    }, required: ['url', 'question'] },
  },
  {
    name: 'browse_resume',
    description: 'Resume a paused browser job after the user solved its CAPTCHA/login challenge (optionally pass fresh cookies).',
    parameters: { type: Type.OBJECT, properties: {
      jobId: S('Paused job id from browse_job.'),
    }, required: ['jobId'] },
  },
  {
    name: 'browser_goto',
    description: 'Open a URL in the live browser. First call in a turn starts live tab 1; later calls navigate the ACTIVE tab — unless new_tab is true, which opens a NEW tab (max 4 tabs at once; the worker pool holds 4). You drive ONE tab at a time: act on a tab, then the next (round-robin), never two at once. The user watches the same tabs live in the Browser tab, so narrate what you are doing there. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      url: S('URL to open in the live browser (required).'),
      new_tab: B('Open a NEW live tab instead of navigating the current one (default false).'),
    }, required: ['url'] },
  },
  {
    name: 'browser_click',
    description: 'Click in a live browser tab (browser_goto first). Coordinates are CSS pixels in the page viewport; pass a selector instead when the element is easier to name than to point at. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      x: I('Viewport x coordinate in CSS pixels.'),
      y: I('Viewport y coordinate in CSS pixels.'),
      selector: S('Optional CSS selector to click instead of coordinates.'),
      button: S('Mouse button: left (default) | right | middle.'),
      tab: S('Which live tab: its number (1-4, e.g. "2") or its session id. Omit for the active tab.'),
    }, required: [] },
  },
  {
    name: 'browser_type',
    description: 'Type text into a live browser tab (browser_goto first) — focuses the selector first when given, otherwise types into the currently focused field. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      text: S('Text to type.'),
      selector: S('Optional CSS selector of the field to type into.'),
      tab: S('Which live tab: its number (1-4, e.g. "2") or its session id. Omit for the active tab.'),
    }, required: ['text'] },
  },
  {
    name: 'browser_press_key',
    description: 'Press a key in a live browser tab (browser_goto first): Enter, Tab, Escape, ArrowDown, ArrowUp, PageDown, Backspace, etc. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      key: S('Key name, e.g. "Enter", "Tab", "Escape", "ArrowDown".'),
      tab: S('Which live tab: its number (1-4, e.g. "2") or its session id. Omit for the active tab.'),
    }, required: ['key'] },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the current frame of a live browser tab (browser_goto first). The frame is shown to the user in the Browser tab; the result confirms the capture and its size. For a vision answer about a page, use browse_vision instead. Needs BROWSER_WORKER_URL + BROWSER_WORKER_KEY.',
    parameters: { type: Type.OBJECT, properties: {
      tab: S('Which live tab: its number (1-4, e.g. "2") or its session id. Omit for the active tab.'),
    }, required: [] },
  },
  {
    name: 'browser_list_tabs',
    description: 'List the live browser tabs open in this turn (number, URL, which is active). Use it before acting on a tab the user opened in the Browser tab, or when you have lost track of which tabs are open. Max 4 tabs at once.',
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: 'gmail_list',
    description: 'List the newest Gmail messages (subject + sender). Needs Google OAuth env (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).',
    parameters: { type: Type.OBJECT, properties: { maxResults: I('How many (default 5).') }, required: [] },
  },
  {
    name: 'gmail_search',
    description: 'Search Gmail. Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: { query: S('Gmail search query.') }, required: ['query'] },
  },
  {
    name: 'gmail_send',
    description: 'Send an email from the connected Gmail account. Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: {
      to: S('Recipient email.'), subject: S('Subject.'), body: S('Plain-text body.'),
    }, required: ['to', 'subject', 'body'] },
  },
  {
    name: 'gmail_draft',
    description: 'Save a Gmail draft (does not send). Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: {
      to: S('Recipient email.'), subject: S('Subject.'), body: S('Plain-text body.'),
    }, required: ['to', 'subject', 'body'] },
  },
  {
    name: 'calendar_list',
    description: 'List upcoming Google Calendar events. Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: { maxResults: I('How many (default 5).') }, required: [] },
  },
  {
    name: 'calendar_create',
    description: 'Create a Google Calendar event. Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: {
      title: S('Event title.'), start: S('Start ISO datetime, e.g. 2026-12-01T10:00:00+06:00.'),
      end: S('End ISO datetime.'),
    }, required: ['title', 'start', 'end'] },
  },
  {
    name: 'drive_list',
    description: 'List Google Drive files (Drive scope sees only files this app created). Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: { query: S('Optional name filter.') }, required: [] },
  },
  {
    name: 'docs_create',
    description: 'Create a Google Doc with text. Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: {
      title: S('Document title.'), text: S('Body text.'),
    }, required: ['title'] },
  },
  {
    name: 'docs_read',
    description: 'Read a Google Doc by name. Needs Google OAuth env.',
    parameters: { type: Type.OBJECT, properties: { name: S('Document name.') }, required: ['name'] },
  },
  {
    name: 'remind',
    description: 'Reminders: add ("in 30 minutes :: message" or "at 18:30 :: message", Asia/Dhaka), list, or due (fired reminders to surface in chat). The server fires them while awake; on Render free the server sleeps when idle, so a reminder may fire late.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('add | list | due.'), input: S('For add: "in 30 minutes :: message" or "at 18:30 :: message".'),
    }, required: ['action'] },
  },
  {
    name: 'goals',
    description: 'Goals: list, add ("add :: title"), or progress ("progress :: title :: 50"). Stored on the server.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('list | add | progress.'), input: S('For add/progress: "add :: title" or "progress :: title :: 50".'),
    }, required: ['action'] },
  },
  {
    name: 'scheduled_browse',
    description: 'Scheduled browse watches (min interval 15 min): add a price watch ("price", url, target price) or an offer watch ("offer", url, keyword); list watches and their last hits; remove by id. The server checks them while awake.',
    parameters: { type: Type.OBJECT, properties: {
      action: S('add | list | remove.'), url: S('URL to watch (add).'),
      kind: S('price | offer (add).'), keyword: S('Keyword to watch for (offer).'),
      targetPrice: I('Target price in BDT (price).'), intervalMinutes: I('Check interval, min 15 (default 60).'),
      id: S('Watch id (remove).'),
    }, required: ['action'] },
  },
];

export const NEXUS_TOOL_NAMES = new Set(nexusTools.map((t) => t.name));

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------
function stripCodeFences(text: string): string {
  let t = text.trim();
  t = t.replace(/^```(?:html|xml)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return t.trim();
}

async function execGithubPush(args: any): Promise<any> {
  const filesInput = args.files;
  if (!Array.isArray(filesInput) || !filesInput.length) {
    return { error: 'github_push needs files: [{repoPath, content}].' };
  }
  const files = filesInput.map((f: any) => ({
    repoPath: String(f.repoPath || ''),
    content: String(f.content ?? ''),
    isBinary: Boolean(f.isBinary),
  }));
  try {
    const result = await pushFilesToGitHub({
      owner: args.owner || undefined,
      repo: String(args.repo || ''),
      branch: args.branch || 'main',
      message: String(args.message || 'Update from Nexus AI Studio'),
      files,
      isPrivate: Boolean(args.isPrivate),
    });
    return { success: true, message: `Pushed ${result.filesPushed} file(s): ${result.commitUrl}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubCreateRepo(args: any): Promise<any> {
  const name = String(args.name || '').trim();
  if (!name || /[/\s]/.test(name)) return { error: 'Repository name must not contain "/" or spaces.' };
  try {
    const token = await resolveGitHubToken();
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.repos.createForAuthenticatedUser({
      name,
      description: args.description || 'Built with Nexus AI Studio',
      private: Boolean(args.private),
      auto_init: false,
    });
    return { success: true, message: `Created repository ${data.full_name}: ${data.html_url}` };
  } catch (err: any) {
    if (err?.status === 403 || err?.status === 404) {
      return { error: 'GitHub App installation tokens cannot create repos — use a PAT with repo scope (connect GitHub with a PAT, or set GITHUB_TOKEN).' };
    }
    return { error: err.message || String(err) };
  }
}

async function execGithubRepos(args: any): Promise<any> {
  try {
    const octokit = await githubClient();
    if (args.username) {
      const { data } = await octokit.rest.repos.listForUser({ username: String(args.username), per_page: 30, sort: 'updated' });
      if (!data.length) return { success: true, message: `No public repos for ${args.username}.` };
      return { success: true, message: data.map((r: any) => `• ${r.full_name} — ${r.description || ''}`).join('\n') };
    }
    const token = await resolveGitHubToken().catch(() => '');
    if (!token) return { error: 'GitHub is not connected. Connect GitHub once in the UI or set GITHUB_TOKEN.' };
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({ per_page: 30, sort: 'updated' });
    if (!data.length) return { success: true, message: 'No repos yet.' };
    return { success: true, message: data.map((r: any) => `• ${r.full_name} — ${r.description || ''}`).join('\n') };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubFile(args: any): Promise<any> {
  try {
    const octokit = await githubClient();
    const { data } = await octokit.rest.repos.getContent({
      owner: String(args.owner), repo: String(args.repo), path: String(args.path),
    });
    if (Array.isArray(data) || data.type !== 'file') return { error: 'That path is not a file.' };
    const content = Buffer.from((data as any).content.replace(/\n/g, ''), 'base64').toString('utf-8');
    return { success: true, message: cap(content) };
  } catch (err: any) {
    return { error: err.status === 404 ? 'File not found.' : err.message || String(err) };
  }
}

async function execGithubIssues(args: any, kind: 'issues' | 'prs'): Promise<any> {
  try {
    const octokit = await githubClient();
    const path = kind === 'issues' ? octokit.rest.issues.listForRepo : octokit.rest.pulls.list;
    const { data } = await path({ owner: String(args.owner), repo: String(args.repo), state: 'open', per_page: 10 });
    if (!data.length) return { success: true, message: `No open ${kind}.` };
    return { success: true, message: data.map((i: any) => `• #${i.number} ${i.title}`).join('\n') };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubCreateIssue(args: any): Promise<any> {
  try {
    const token = await resolveGitHubToken();
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.issues.create({
      owner: String(args.owner), repo: String(args.repo),
      title: String(args.title), body: args.body ? String(args.body) : undefined,
    });
    return { success: true, message: `Issue created: #${data.number} — ${data.html_url}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubCreatePr(args: any): Promise<any> {
  try {
    const token = await resolveGitHubToken();
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.rest.pulls.create({
      owner: String(args.owner), repo: String(args.repo),
      title: String(args.title), body: args.body ? String(args.body) : undefined,
      head: String(args.head), base: String(args.base || 'main'),
    });
    return { success: true, message: `Created pull request: ${data.html_url}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubPullRequest(args: any): Promise<any> {
  try {
    const action = String(args.action || 'list');
    const octokit = action === 'list' ? await githubClient() : new Octokit({ auth: await resolveGitHubToken() });
    const owner = String(args.owner);
    const repo = String(args.repo);
    if (action === 'create') {
      const { data } = await octokit.rest.pulls.create({
        owner, repo,
        title: String(args.title), body: args.body ? String(args.body) : undefined,
        head: String(args.head), base: String(args.base || 'main'),
      });
      return { success: true, message: `Created pull request: ${data.html_url}` };
    }
    const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: 10 });
    if (!data.length) return { success: true, message: 'No open pull requests.' };
    return { success: true, message: data.map((p: any) => `• #${p.number} ${p.title} (${p.head.ref} → ${p.base.ref})`).join('\n') };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubIssuesUnified(args: any): Promise<any> {
  const action = String(args.action || 'list');
  try {
    if (action === 'create') return execGithubCreateIssue(args);
    if (action === 'comment') {
      const token = await resolveGitHubToken();
      const octokit = new Octokit({ auth: token });
      if (!args.number) return { error: 'number is required to comment on an issue.' };
      if (!args.body) return { error: 'body is required for a comment.' };
      const { data } = await octokit.rest.issues.createComment({
        owner: String(args.owner), repo: String(args.repo),
        issue_number: Number(args.number), body: String(args.body),
      });
      return { success: true, message: `Comment added: ${data.html_url}` };
    }
    return execGithubIssues(args, 'issues');
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubActions(args: any): Promise<any> {
  try {
    const action = String(args.action || 'list_runs');
    const owner = String(args.owner);
    const repo = String(args.repo);
    if (action === 'trigger') {
      const workflow = String(args.workflow || '');
      if (!workflow) return { error: 'workflow is required to trigger a run (e.g. "ci.yml").' };
      const token = await resolveGitHubToken();
      const octokit = new Octokit({ auth: token });
      await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: workflow, ref: String(args.ref || 'main') });
      return { success: true, message: `Triggered workflow ${workflow} on ${args.ref || 'main'}. Check github_actions list_runs in a minute for the result.` };
    }
    const octokit = await githubClient();
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner, repo, per_page: 5,
      ...(args.branch ? { branch: String(args.branch) } : {}),
    });
    if (!data.workflow_runs.length) return { success: true, message: 'No workflow runs found.' };
    return { success: true, message: data.workflow_runs.map((r: any) => `• ${r.name} #${r.run_number} — ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''} (${r.head_branch}) ${r.html_url}`).join('\n') };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubRelease(args: any): Promise<any> {
  try {
    const token = await resolveGitHubToken();
    const octokit = new Octokit({ auth: token });
    const owner = String(args.owner);
    const repo = String(args.repo);
    const tag = String(args.tag);
    const { data: rel } = await octokit.rest.repos.createRelease({
      owner, repo, tag_name: tag,
      name: args.name ? String(args.name) : tag,
      body: args.body ? String(args.body) : undefined,
    });
    let assetMsg = '';
    if (args.assetPath) {
      const filePath = path.resolve(process.cwd(), String(args.assetPath));
      if (!filePath.startsWith(path.resolve(process.cwd()))) return { error: 'assetPath must be inside the workspace.' };
      const buf = await fs.readFile(filePath);
      if (buf.length > 100 * 1024 * 1024) return { error: 'Asset is too large (100 MB cap for uploads through this tool).' };
      const assetName = String(args.assetName || path.basename(filePath));
      const up = await octokit.rest.repos.uploadReleaseAsset({
        owner, repo, release_id: rel.id,
        name: assetName,
        data: buf as any,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) },
      });
      assetMsg = ` Asset uploaded: ${up.data?.browser_download_url || assetName}`;
    }
    return { success: true, message: `Release published: ${rel.html_url}${assetMsg}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubCodeSearch(args: any): Promise<any> {
  try {
    const octokit = await githubClient();
    let q = String(args.query || '').trim();
    if (!q) return { error: 'query is required.' };
    if (args.repo) q += ` repo:${String(args.repo)}`;
    const { data } = await octokit.rest.search.code({ q, per_page: 5 });
    if (!data.items.length) return { success: true, message: 'No code matches found.' };
    return { success: true, message: data.items.map((i: any) => `• ${i.repository.full_name} — ${i.path}\n  ${i.html_url}`).join('\n') };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGithubImport(args: any, execCtx?: { sessionId?: string }): Promise<any> {
  const repoUrl = String(args.repoUrl || '');
  let owner: string, repo: string;
  try { ({ owner, repo } = parseOwnerRepo(repoUrl)); } catch (err: any) { return { error: err.message }; }
  try {
    const octokit = await githubClient();
    const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
    const branch = repoInfo.default_branch || 'main';
    const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: 'true' });
    const entries = (tree.tree || []).filter((e: any) => e.type === 'blob');
    const destDir = path.resolve(process.cwd(), 'projects', `import_${repo}_${Date.now().toString(36)}`);
    await fs.mkdir(destDir, { recursive: true });
    const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'mp3', 'mp4', 'wav', 'ttf', 'otf', 'woff', 'woff2']);
    let imported = 0; let totalBytes = 0; const skipped: string[] = []; const importedFiles: string[] = [];
    for (const entry of entries.slice(0, 200)) {
      const p = entry.path || '';
      if (p.startsWith('.git/') || p.includes('node_modules/')) { skipped.push(p); continue; }
      if ((entry.size || 0) > 200 * 1024) { skipped.push(`${p} (>200 KB)`); continue; }
      if (totalBytes > 10 * 1024 * 1024) { skipped.push(`${p} (10 MB cap)`); continue; }
      const clean = sanitizeRepoPath(p);
      if (!clean) { skipped.push(p); continue; }
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: p, ref: branch });
        if (Array.isArray(data) || data.type !== 'file' || !(data as any).content) { skipped.push(p); continue; }
        const ext = p.split('.').pop()?.toLowerCase() || '';
        const buf = Buffer.from((data as any).content.replace(/\n/g, ''), 'base64');
        const abs = path.join(destDir, clean);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, buf);
        totalBytes += buf.length;
        imported++;
        importedFiles.push(clean);
      } catch {
        skipped.push(p);
      }
    }
    const interesting = importedFiles.filter((f) => /^(README|package\.json|index\.html|src\/index|main\.|app\.|vite\.config|tsconfig)/i.test(f)).slice(0, 10);
    return {
      success: true,
      message: `Imported ${owner}/${repo} (@${branch}, ${imported} file(s)) into ${path.relative(process.cwd(), destDir)}/. ` +
        (interesting.length ? `Entry points: ${interesting.join(', ')}. ` : '') +
        (skipped.length ? `Skipped ${skipped.length} file(s) (binary/large/git). ` : '') +
        `Work on it with the file tools (read_file / write_to_file / replace_file_content).`,
    };
  } catch (err: any) {
    return { error: err.status === 404 ? `Repo ${owner}/${repo} not found (or private).` : err.message || String(err) };
  }
}

async function execBuildPage(args: any): Promise<any> {
  const description = String(args.description || '').trim();
  if (!description) return { error: 'build_page needs a description.' };
  try {
    const { text, model } = await chatOnce({
      system: 'You are a web designer. Output ONLY a complete single-file HTML page (inline CSS, no external files) for the request below. No markdown fences, no explanation.',
      user: description,
      chain: codingChain(),
      maxTokens: 8000,
      timeoutMs: 120000,
    });
    const html = stripCodeFences(text);
    if (!/<html/i.test(html)) return { error: `The model did not return a complete HTML page (model: ${model}). Try again with a clearer description.` };
    const fileName = `page-${Date.now()}.html`;
    const abs = path.resolve(process.cwd(), 'projects', fileName);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, html, 'utf-8');
    return { success: true, message: `Page built with ${model}: /projects/${fileName} — preview it at /projects/${fileName} and download from the preview.` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBuildSite(args: any): Promise<any> {
  if (!isWorkerConfigured()) {
    return { error: 'build_site needs the browser worker (BROWSER_WORKER_URL + BROWSER_WORKER_KEY).' };
  }
  const builder = String(args.builder || '').toLowerCase();
  if (builder !== 'aistudio' && builder !== 'lovable') {
    return { error: 'build_site builder must be "aistudio" or "lovable".' };
  }
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { error: 'build_site needs a prompt.' };
  const projectName = (String(args.projectName || 'nexus-site') || 'nexus-site').replace(/[^A-Za-z0-9-_]/g, '-');
  const siteUrl = builder === 'aistudio' ? 'https://aistudio.google.com/' : 'https://lovable.dev';
  const task = builder === 'aistudio'
    ? `Open ${siteUrl}. If a Google sign-in page appears and nobody is signed in, stop and reply exactly LOGIN_REQUIRED. Create a new app build named "${projectName}" with this prompt: ${prompt}. Wait for the build to finish (up to 10 minutes). If a free-quota or limit error appears, reply exactly LIMIT_REACHED. When the build is done, download the project ZIP. End your summary with DOWNLOAD: <download URL or file path, or NONE> and FILES: <number of files>.`
    : `Open ${siteUrl}. If a sign-in page appears and nobody is signed in, stop and reply exactly LOGIN_REQUIRED. Create a new project named "${projectName}" with this prompt: ${prompt}. Wait for the build to finish (up to 10 minutes). If a limit error appears, reply exactly LIMIT_REACHED. When the build is done, download the project ZIP. End your summary with DOWNLOAD: <download URL or file path, or NONE> and FILES: <number of files>.`;
  try {
    const summary = await runBrowseTask(task, siteUrl);
    if (/LOGIN_REQUIRED/.test(summary)) {
      return { error: 'The builder needs a signed-in Google/Lovable session in the worker browser (LOGIN_REQUIRED). Sign in once in the worker browser, then try again.' };
    }
    if (/LIMIT_REACHED/.test(summary)) {
      return { error: 'The builder hit its free-quota limit (LIMIT_REACHED). Wait for the quota to reset or switch builders.' };
    }
    const dlMatch = summary.match(/DOWNLOAD:\s*(\S+)/);
    const filesMatch = summary.match(/FILES:\s*(\d+)/);
    if (!dlMatch || dlMatch[1] === 'NONE' || !/^https?:\/\//.test(dlMatch[1])) {
      return { success: true, message: `Builder finished but no ZIP download was returned. ${summary.slice(0, 800)}` };
    }
    // Download the ZIP through the worker (≤8 MB) and import it.
    const job = await runBrowseJob({ type: 'download', url: dlMatch[1] });
    let payload: any = null;
    try { payload = JSON.parse(job.result || ''); } catch { /* not JSON */ }
    const b64 = payload?.base64;
    if (!b64) return { success: true, message: `Build done (${filesMatch?.[1] || '?'} files) but the ZIP download failed: ${job.error || 'no file returned'}. Download URL was: ${dlMatch[1]}` };
    const zip = new AdmZip(Buffer.from(b64, 'base64'));
    const destDir = path.resolve(process.cwd(), 'projects', projectName);
    await fs.mkdir(destDir, { recursive: true });
    zip.extractAllTo(destDir, true);
    const entries = zip.getEntries().map((e) => e.entryName).slice(0, 20);
    return { success: true, message: `Site built: ${path.relative(process.cwd(), destDir)}/ (${filesMatch?.[1] || entries.length} file(s)). Files: ${entries.join(', ')}. Preview it at /projects/${projectName}/index.html.` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execDeploySite(args: any): Promise<any> {
  const repo = String(args.repo || '').trim();
  if (!repo) return { error: 'deploy_site needs a repo (owner/repo or a plain name).' };
  const job = await startDeploy({
    sessionId: args.sessionId ? String(args.sessionId) : undefined,
    repo,
    branch: args.branch ? String(args.branch) : 'main',
    commitMessage: 'Deploy site from Nexus AI Studio',
  });
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const current = getDeployJob(job.id);
    if (!current) break;
    if (['live', 'triggered', 'setup-needed', 'error'].includes(current.stage)) {
      const base = `${current.message}${current.repoUrl ? ` Repo: ${current.repoUrl}.` : ''}${current.liveUrl ? ` Live: ${current.liveUrl}.` : ''}${current.dashboardUrl ? ` Dashboard: ${current.dashboardUrl}.` : ''}`;
      const setup = current.setupNeeded ? `\nSetup still needed:\n${current.setupNeeded.join('\n')}` : '';
      const err = current.error ? `\nError: ${current.error}` : '';
      return { success: current.stage !== 'error', message: base + setup + err };
    }
  }
  return { success: true, message: `Deploy started (job ${job.id}) and is still running — check the Deploy button in the UI for live status.` };
}

async function execWebSearch(args: any): Promise<any> {
  const q = String(args.query || '').trim();
  if (!q) return { error: 'web_search needs a query.' };
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': 'NexusAI/1.1' },
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await res.json();
    const lines: string[] = [`Search: ${q}`];
    if (data.AbstractText) lines.push(`${data.AbstractText}${data.AbstractSource ? ` (${data.AbstractSource})` : ''}`);
    const topics: any[] = data.RelatedTopics || [];
    for (const t of topics.slice(0, 5)) {
      if (t.Text) lines.push(`• ${t.Text}${t.FirstURL?.URL ? ` (${t.FirstURL.URL})` : ''}`);
    }
    if (lines.length === 1) return { success: true, message: `No instant answer found for "${q}". Try opening the page in the Browser tab.` };
    return { success: true, message: lines.join('\n') };
  } catch (err: any) {
    return { error: `Web search failed: ${err.message || String(err)}` };
  }
}

async function execReadPage(args: any): Promise<any> {
  const url = String(args.url || '').trim();
  if (!url) return { error: 'read_page needs a url.' };
  try {
    const html = await fetchText(url);
    const text = stripHtmlToText(html);
    if (!text) return { success: true, message: '(Page returned no readable text — it may be JS-rendered; use browse_task instead.)' };
    return { success: true, message: cap(text) };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execGenerateImage(args: any): Promise<any> {
  const prompt = String(args.prompt || '').trim().slice(0, 300);
  if (!prompt) return { error: 'generate_image_pollinations needs a prompt.' };
  const width = Math.min(Math.max(Number(args.width) || 512, 64), 1024);
  const height = Math.min(Math.max(Number(args.height) || 512, 64), 1024);
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=flux&nologo=true`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NexusAI/1.1' },
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return { error: 'Pollinations returned an empty image. Try a different prompt.' };
    const fileName = `image-${Date.now()}.png`;
    const dir = path.resolve(process.cwd(), 'public/generated');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), buf);
    return { success: true, message: `Image generated: /generated/${fileName} (Pollinations, free, no key).` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execFileGrep(args: any): Promise<any> {
  const query = String(args.query || '').toLowerCase();
  if (!query) return { error: 'file_grep needs a query.' };
  const skipDirs = new Set(['node_modules', 'dist', '.git', 'data']);
  const hits: string[] = [];
  async function walk(dir: string, rel: string) {
    if (hits.length >= 20) return;
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= 20) return;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        const ext = e.name.split('.').pop()?.toLowerCase() || '';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'mp3', 'mp4', 'zip', 'apk'].includes(ext)) continue;
        try {
          const st = await fs.stat(path.join(dir, e.name));
          if (st.size > 200 * 1024) continue;
          const content = await fs.readFile(path.join(dir, e.name), 'utf-8');
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (hits.length < 20 && line.toLowerCase().includes(query)) {
              hits.push(`${rel ? `${rel}/` : ''}${e.name}:${i + 1}: ${line.trim().slice(0, 120)}`);
            }
          });
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(process.cwd(), '');
  if (!hits.length) return { success: true, message: `No matches for "${args.query}".` };
  return { success: true, message: hits.join('\n') };
}

async function execLocalRag(args: any): Promise<any> {
  const query = String(args.query || '').trim();
  if (!query) return { error: 'local_rag needs a query.' };
  const passages = await collectRagPassages();
  if (!passages.length) return { success: true, message: 'EMPTY_INDEX — the local corpus is empty (no project files or goals yet).' };
  const ranked = rankRag(query, passages, Math.min(Math.max(Number(args.topK) || 5, 1), 10));
  if (!ranked.length) return { success: true, message: `NOT_FOUND — nothing in the local corpus matches "${query}".` };
  const lines = ranked.map((r, i) => `${i + 1}. [${r.score.toFixed(2)}] [${r.passage.source}]\n   ${r.snippet}`);
  return { success: true, message: `FOUND:\n${lines.join('\n')}` };
}

async function execVectorStore(args: any): Promise<any> {
  const action = String(args.action || '').toLowerCase();
  const store = await loadStore();
  if (action === 'add') {
    const id = String(args.id || '').trim();
    const text = String(args.text || '').trim();
    if (!id || !text) return { error: 'vector_store add needs id + text.' };
    const embedding = hashEmbed(text);
    const idx = store.vectorStore.findIndex((e) => e.id === id);
    const entry: VectorEntry = { id, text, embedding, metadata: {} };
    if (idx >= 0) store.vectorStore[idx] = entry;
    else store.vectorStore.push(entry);
    saveStoreSoon();
    return { success: true, message: `Stored "${id}" (${idx >= 0 ? 'replaced' : 'new'}). Store size: ${store.vectorStore.length}.` };
  }
  if (action === 'search') {
    const query = String(args.query || '').trim();
    if (!query) return { error: 'vector_store search needs a query.' };
    // Rebuild from local_rag passages first (Nexus-ai6 behaviour).
    const passages = await collectRagPassages();
    for (const [i, p] of passages.entries()) {
      const id = `rag:${i}`;
      if (!store.vectorStore.some((e) => e.id === id)) {
        store.vectorStore.push({ id, text: p.text, embedding: hashEmbed(p.text), metadata: { source: p.source } });
      }
    }
    saveStoreSoon();
    if (!store.vectorStore.length) return { success: true, message: 'Vector store is empty.' };
    const hits = await vectorSearch(query, Math.min(Math.max(Number(args.topK) || 5, 1), 10));
    if (!hits.length) return { success: true, message: 'No hits.' };
    return { success: true, message: hits.map((h, i) => `${i + 1}. [${h.score.toFixed(2)}] [${h.entry.metadata.source || h.entry.id}]\n   ${h.entry.text.slice(0, 300)}`).join('\n') };
  }
  if (action === 'list') {
    if (!store.vectorStore.length) return { success: true, message: 'Vector store is empty.' };
    return { success: true, message: `${store.vectorStore.length} entries:\n${store.vectorStore.slice(0, 20).map((e) => `• ${e.id} — ${e.text.slice(0, 80)}`).join('\n')}` };
  }
  if (action === 'remove') {
    const id = String(args.id || '').trim();
    const before = store.vectorStore.length;
    store.vectorStore = store.vectorStore.filter((e) => e.id !== id);
    saveStoreSoon();
    return { success: true, message: before === store.vectorStore.length ? `No entry "${id}".` : `Removed "${id}".` };
  }
  if (action === 'clear') {
    store.vectorStore = [];
    saveStoreSoon();
    return { success: true, message: 'Vector store cleared.' };
  }
  return { error: 'vector_store action must be add | search | list | remove | clear.' };
}

function authLabel(auth: string): string {
  if (auth === 'none') return 'No key';
  if (auth === 'api_key') return 'API key';
  return 'OAuth';
}

async function execPublicApiDiscovery(args: any): Promise<any> {
  const q = String(args.query || '').trim();
  const categories = [...new Set(PUBLIC_APIS.map((a) => a.category))].sort();
  if (!q) return { success: true, message: `API categories (${categories.length}): ${categories.join(', ')}. Give a category or a keyword to search.` };
  if (q.toLowerCase() === 'nokey') {
    const list = PUBLIC_APIS.filter((a) => a.auth === 'none').slice(0, 10);
    return { success: true, message: `No-key APIs (${PUBLIC_APIS.filter((a) => a.auth === 'none').length} total, showing ${list.length}):\n${list.map((a) => `• ${a.name} — ${a.category} • No key\n  ${a.descriptionBn}\n  ${a.url}`).join('\n')}` };
  }
  const catMatch = categories.find((c) => c.toLowerCase() === q.toLowerCase());
  let results: PublicApiEntry[] = [];
  if (catMatch) results = PUBLIC_APIS.filter((a) => a.category === catMatch);
  else {
    const lq = q.toLowerCase();
    results = PUBLIC_APIS.filter((a) =>
      a.name.toLowerCase().includes(lq) || a.category.toLowerCase().includes(lq) ||
      a.descriptionBn.includes(q) || a.descriptionEn.toLowerCase().includes(lq));
  }
  if (!results.length) return { success: true, message: `No APIs found for "${q}".` };
  const shown = results.slice(0, 10);
  return { success: true, message: `${results.length} result(s)${results.length > 10 ? ` (showing 10)` : ''}:\n${shown.map((a) => `• ${a.name} — ${a.category} • ${authLabel(a.auth)}\n  ${a.descriptionBn}\n  ${a.url}`).join('\n')}\nSnapshot checked Nov 2026 — verify the live API before using it.` };
}

const NEED_TO_CATEGORY: Array<[RegExp, string]> = [
  [/host|deploy|website|site|static/i, 'hosting'],
  [/db|database|sql|postgres|mongo|mysql/i, 'database'],
  [/mail|smtp|email/i, 'email'],
  [/storage|file|upload|cdn/i, 'storage'],
  [/monitor|uptime|sentry|log/i, 'monitoring'],
  [/ai|llm|gemini|groq|model/i, 'ai'],
  [/map|geo|location/i, 'maps'],
  [/auth|login|sign|user/i, 'auth'],
];

async function execFreeTierDirectory(args: any): Promise<any> {
  const q = String(args.query || '').trim();
  const note = 'Snapshot checked Nov 2026 — free tiers change; verify the current tier on the provider’s pricing page before choosing.';
  if (!q) {
    const cats = [...new Set(FREE_TIERS.map((s) => s.category))].sort();
    return { success: true, message: `Free-tier categories: ${cats.join(', ')}. Describe a need (e.g. "host a website") or a keyword.` };
  }
  const catHit = NEED_TO_CATEGORY.find(([re]) => re.test(q));
  let results: FreeTierEntry[] = [];
  if (catHit) results = FREE_TIERS.filter((s) => s.category === catHit[1] && !s.needsCard);
  if (!results.length) {
    const lq = q.toLowerCase();
    results = FREE_TIERS.filter((s) =>
      s.name.toLowerCase().includes(lq) || s.category.toLowerCase().includes(lq) ||
      s.freeTierEn.toLowerCase().includes(lq) || s.freeTierBn.includes(q) || s.url.toLowerCase().includes(lq));
  }
  if (!results.length) return { success: true, message: `No free-tier services found for "${q}".` };
  const shown = results.slice(0, 8);
  return { success: true, message: `${results.length} result(s)${results.length > 8 ? ' (showing 8)' : ''}:\n${shown.map((s) => `• ${s.name} — ${s.freeTierEn} ${s.needsCard ? 'A card is required.' : 'No card needed.'}\n  ${s.url}`).join('\n')}\n${note}` };
}

async function execDeshApi(args: any): Promise<any> {
  const raw = String(args.command || '').trim();
  if (!raw) return { error: 'desh_api needs a command, e.g. "divisions", "districts ঢাকা", "number 1250", "tax 30000", "banks", "gold".' };
  const [head, ...rest] = raw.split(/\s+/);
  const tail = rest.join(' ');
  const cmd = head.toLowerCase();
  const districts: Record<string, string[]> = DESH_DATA.districtsByDivision || {};
  switch (cmd) {
    case 'divisions': {
      const divs = Object.keys(districts);
      return { success: true, message: `Divisions (8): ${divs.join(', ')}. Districts: 64, upazilas: 495, unions: 4540, banks: 61, branches: 11533.` };
    }
    case 'districts': {
      const div = tail || raw;
      const list = districts[div] || Object.entries(districts).find(([k]) => k.includes(div) || div.includes(k))?.[1];
      if (!list) return { success: true, message: `Unknown division "${div}". Try: ${Object.keys(districts).join(', ')}.` };
      return { success: true, message: `Districts of ${div} (${list.length}): ${list.join(', ')}` };
    }
    case 'number': {
      const n = parseInt(toLatinDigits(tail), 10);
      if (!Number.isFinite(n)) return { error: `"number" needs an integer, e.g. "number 1250".` };
      return { success: true, message: `${n} = ${banglaNumberWords(n)}` };
    }
    case 'taka': {
      const amount = parseFloat(toLatinDigits(tail).replace(/,/g, ''));
      if (!Number.isFinite(amount)) return { error: `"taka" needs an amount, e.g. "taka 1250.50".` };
      return { success: true, message: `${formatLakhCrore(amount)} (${formatLakhCroreWords(amount)}) — ${takaInWords(amount)}` };
    }
    case 'date': {
      const m = tail.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) return { error: `"date" needs yyyy-mm-dd, e.g. "date 2026-12-16".` };
      const out = toBanglaDate(Number(m[1]), Number(m[2]), Number(m[3]));
      return out ? { success: true, message: `${tail} = ${out}` } : { error: 'Invalid date.' };
    }
    case 'nid': {
      const ok = isValidNidFormat(tail);
      return { success: true, message: ok ? 'Valid NID format (10 or 17 digits). Format only — nothing is looked up.' : 'Not a valid NID format (needs 10 or 17 digits).' };
    }
    case 'plate': {
      const ok = isValidPlateFormat(tail);
      return { success: true, message: ok ? 'Looks like a valid Bangladeshi plate format. Format only — nothing is looked up.' : 'Not a recognised Bangladeshi plate format (e.g. "ঢাকা মেট্রো-গ ১২-৩৪৫৬").' };
    }
    case 'tax': {
      const monthly = parseFloat(toLatinDigits(tail).replace(/,/g, ''));
      if (!Number.isFinite(monthly)) return { error: `"tax" needs a monthly income, e.g. "tax 30000".` };
      const annual = monthly * 12;
      const tax = incomeTax(monthly);
      return { success: true, message: `Monthly ৳${monthly.toLocaleString('en-US')} → annual ৳${annual.toLocaleString('en-US')}, estimated income tax ৳${Math.round(tax).toLocaleString('en-US')} per year (slabs 0%/5%/10%/15%/20%/25%; no exemption/rebate/minimum tax applied).` };
    }
    case 'zakat': {
      const assets = parseFloat(toLatinDigits(tail).replace(/,/g, ''));
      if (!Number.isFinite(assets)) return { error: `"zakat" needs an asset amount, e.g. "zakat 500000".` };
      return { success: true, message: `Zakat at 2.5% on ৳${assets.toLocaleString('en-US')} = ৳${(assets * 0.025).toLocaleString('en-US')} (check the assets reach nisab first — 87.48 g gold or 612.36 g silver).` };
    }
    case 'bijoy': {
      return { success: true, message: bijoyToUnicode(tail) };
    }
    case 'unicode': {
      return { success: true, message: unicodeToBijoy(tail) };
    }
    case 'banks': {
      const banks = await deshCached<any[]>('banks', 7 * 24 * 3600 * 1000, () => deshGet('/v1/banks'));
      if (!banks) return { success: true, message: 'Bank list is unavailable offline right now (no cached data and the Desh API could not be reached).' };
      return { success: true, message: `${banks.length} banks:\n${banks.slice(0, 20).map((b: any) => `• ${b.nameBn || b.name} (${b.code || ''})`).join('\n')}${banks.length > 20 ? `\n…${banks.length - 20} more` : ''}` };
    }
    case 'branches': {
      const [bankCode, district] = tail.split(/\s+/);
      if (!bankCode) return { error: `"branches" needs a bank code, e.g. "branches dbbl".` };
      const key = `branches:${bankCode}:${district || ''}`;
      const branches = await deshCached<any[]>(key, 7 * 24 * 3600 * 1000, () =>
        deshGet(`/v1/banks/${encodeURIComponent(bankCode)}/branches${district ? `?district=${encodeURIComponent(district)}` : ''}`));
      if (!branches) return { success: true, message: 'Branch list is unavailable offline right now.' };
      return { success: true, message: `${branches.length} branches:\n${branches.slice(0, 15).map((b: any) => `• ${b.nameBn || b.name} — ${b.district || ''}${b.routingNumber ? ` (routing ${b.routingNumber})` : ''}`).join('\n')}${branches.length > 15 ? `\n…${branches.length - 15} more` : ''}` };
    }
    case 'gold': {
      const gold = await deshCached<any>('gold', 24 * 3600 * 1000, () => deshGet('/v1/gold/prices'));
      if (!gold) return { success: true, message: 'Gold price is unavailable offline right now (no cached data and the Desh API could not be reached).' };
      return { success: true, message: `Gold (BAJUS 22k): ৳${Number(gold.perVoriBdt || 0).toLocaleString('en-US')} per vori, ৳${Number(gold.perGramBdt || 0).toLocaleString('en-US')} per gram${gold.updatedAt ? ` (updated ${gold.updatedAt})` : ''}.` };
    }
    case 'unions': {
      const upazila = tail.trim();
      if (!upazila) return { error: `"unions" needs an upazila slug, e.g. "unions palashbari".` };
      const unions = await deshCached<any[]>(`unions:${upazila}`, 7 * 24 * 3600 * 1000, () => deshGet(`/v1/unions?upazila=${encodeURIComponent(upazila)}`));
      if (!unions) return { success: true, message: 'Union list is unavailable offline right now.' };
      const names = unions.map((u: any) => (typeof u === 'string' ? u : u.nameBn || u.name)).filter(Boolean);
      return { success: true, message: `Unions of ${upazila} (${names.length}): ${names.join(', ')}` };
    }
    default: {
      // Bare text falls back to a district search, then number words.
      const list = Object.entries(districts).find(([k, v]) => v.includes(raw) || k === raw);
      if (list) return { success: true, message: `${raw} is a district of ${list[0]} division.` };
      const n = parseInt(toLatinDigits(raw), 10);
      if (Number.isFinite(n) && String(n) === toLatinDigits(raw).trim()) {
        return { success: true, message: `${n} = ${banglaNumberWords(n)}` };
      }
      return { error: `Unknown desh_api command "${head}". Try: divisions, districts <division>, number <n>, taka <amount>, date <yyyy-mm-dd>, nid <n>, plate <plate>, tax <monthly>, zakat <assets>, bijoy <text>, unicode <text>, banks, branches <code>, gold, unions <upazila>.` };
    }
  }
}

async function execBrowseTask(args: any): Promise<any> {
  try {
    const text = await runBrowseTask(String(args.task || ''), args.url ? String(args.url) : undefined);
    return { success: true, message: text || '(The browser worker returned no text.)' };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBrowseJob(args: any): Promise<any> {
  try {
    const result = await runBrowseJob({
      type: args.type ? String(args.type) : 'read',
      url: String(args.url || ''),
      selector: args.selector ? String(args.selector) : undefined,
      submit: Boolean(args.submit),
    });
    if (['done', 'completed', 'success'].includes(result.status)) {
      return { success: true, message: result.result || '(Job finished with no result text.)' };
    }
    if (['paused', 'paused-needs-user', 'needs-user', 'waiting-user', 'challenge'].includes(result.status)) {
      return { success: true, message: `Job ${result.jobId} is paused and needs you (CAPTCHA / login). Solve the challenge in your browser, then call browse_resume with jobId ${result.jobId}.` };
    }
    return { error: `Browse job ${result.status}: ${result.error || 'failed'}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBrowseVision(args: any): Promise<any> {
  const url = String(args.url || '').trim();
  const question = String(args.question || '').trim();
  if (!url || !question) return { error: 'browse_vision needs url + question.' };
  // 1. Text first.
  let pageText = '';
  try { pageText = stripHtmlToText(await fetchText(url)); } catch { /* fall through to vision */ }
  const questionWords = question.toLowerCase().split(/[\s,?.!]+/).filter((w) => w.length >= 3);
  if (pageText && questionWords.some((w) => pageText.toLowerCase().includes(w))) {
    return { success: true, message: `Answered from the page text (no screenshot needed):\n${cap(pageText)}` };
  }
  // 2. Screenshot (last resort), capped at 120 KB.
  try {
    const shot = await getScreenshot(url);
    const byteLen = Math.floor(shot.jpegBase64.length * 0.75);
    if (byteLen > 120 * 1024) {
      return { success: true, message: `The screenshot is too large for vision (${Math.round(byteLen / 1024)} KB > 120 KB cap), so here is the page text instead:\n${cap(pageText || '(no readable text)')}` };
    }
    const visionChain = [...verifyLive(['gemini-3.8-flash', 'gemini-4-hydrogen']), 'auto:smart'];
    const { text, model } = await chatOnce({
      system: 'You are a vision assistant. Answer the question using ONLY what is visible in the screenshot. If it cannot be answered from the image, say so — never invent an answer.',
      user: question,
      imageBase64: shot.jpegBase64,
      imageMime: 'image/jpeg',
      chain: visionChain,
      maxTokens: 2000,
    });
    return { success: true, message: text || '(The vision model returned no answer.)' };
  } catch (err: any) {
    return { success: true, message: `Vision failed (${err.message || String(err)}). Page text instead:\n${cap(pageText || '(no readable text)')}` };
  }
}

async function execBrowseResume(args: any): Promise<any> {
  try {
    await resumeBrowseJob(String(args.jobId || ''), []);
    return { success: true, message: `Resume requested for job ${args.jobId}. Poll its status with browse_job if needed.` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Live browser tools — up to 4 live tabs per turn (execCtx.liveSessions),
// one per worker context (the pool cap). The same sessions are what the
// user's Browser tab watches; the frontend learns session ids from the
// tool results (liveSessionId) via the orchestrator's `live_browser` SSE
// event. The agent drives ONE tab at a time — it acts on a tab, then the
// next (round-robin), never literally two at once.
// ---------------------------------------------------------------------------
/** The worker pool holds 4 browser contexts — a 5th live tab has none. */
export const MAX_LIVE_TABS = 4;

type LiveTab = { id: string; url?: string };
type LiveExecCtx = { sessionId?: string; liveSessionId?: string; liveSessionUrl?: string; liveSessions?: LiveTab[] };

/** The turn's tab list, kept in sync with the legacy single-session fields
 * (liveSessionId/liveSessionUrl = the ACTIVE tab, for back-compat). */
function liveTabList(execCtx?: LiveExecCtx): LiveTab[] {
  if (!execCtx) return [];
  if (!Array.isArray(execCtx.liveSessions)) execCtx.liveSessions = [];
  if (execCtx.liveSessionId && !execCtx.liveSessions.some((t) => t.id === execCtx.liveSessionId)) {
    execCtx.liveSessions.push({ id: execCtx.liveSessionId, url: execCtx.liveSessionUrl });
  }
  return execCtx.liveSessions;
}

function setActiveLiveTab(execCtx: LiveExecCtx | undefined, tab: LiveTab): void {
  if (!execCtx) return;
  execCtx.liveSessionId = tab.id;
  execCtx.liveSessionUrl = tab.url;
}

function liveTabNumber(execCtx: LiveExecCtx | undefined, tab: LiveTab): number {
  return Math.max(1, liveTabList(execCtx).indexOf(tab) + 1);
}

/** Resolve a `tab` argument: 1-based tab number, or a session id. No arg
 * means the active tab. Returns the tab or a clear error naming the open tabs. */
function resolveLiveTab(execCtx: LiveExecCtx | undefined, tabArg: any): { tab?: LiveTab; error?: string } {
  const tabs = liveTabList(execCtx);
  if (tabs.length === 0) return { error: 'No live browser session yet — call browser_goto with a url first.' };
  if (tabArg === undefined || tabArg === null || tabArg === '') {
    return { tab: tabs.find((t) => t.id === execCtx?.liveSessionId) || tabs[0] };
  }
  const n = Number(tabArg);
  if (Number.isInteger(n)) {
    if (n >= 1 && n <= tabs.length) return { tab: tabs[n - 1] };
    return { error: `There is no live browser tab ${n} — ${tabs.length} tab(s) open (${tabs.map((t, i) => `${i + 1}: ${t.url || t.id}`).join(', ')}). Use browser_list_tabs to see them.` };
  }
  const byId = tabs.find((t) => t.id === String(tabArg));
  if (byId) return { tab: byId };
  return { error: `No live browser tab "${String(tabArg)}" — ${tabs.length} tab(s) open. Use browser_list_tabs to see them.` };
}

/** Refusing a 5th tab: the pool is full, so the only way forward is for
 * the user to close a tab in the Browser tab first. */
const POOL_FULL_ERROR = 'The live browser already has 4 tabs open — close a tab in the Browser tab first, then try again.';

async function execBrowserGoto(args: any, execCtx?: LiveExecCtx): Promise<any> {
  const url = String(args.url || '').trim();
  if (!url) return { error: 'browser_goto needs a url.' };
  const newTab = Boolean(args.new_tab);
  try {
    const tabs = liveTabList(execCtx);
    const active = tabs.find((t) => t.id === execCtx?.liveSessionId);
    if (active && !newTab) {
      // Existing behaviour: navigate the active tab in place.
      await liveAction(active.id, 'goto', { url });
      active.url = url;
      if (execCtx) execCtx.liveSessionUrl = url;
      const n = tabs.indexOf(active) + 1;
      return { success: true, message: `Navigated live browser tab ${n} to ${url}.`, liveSessionId: active.id, liveSessionUrl: url, liveTab: n, liveTabCount: tabs.length };
    }
    // A new tab (first tab, or new_tab=true): the worker pool holds 4.
    if (tabs.length >= MAX_LIVE_TABS) return { error: POOL_FULL_ERROR };
    const session = await startLiveSession(url);
    const tab: LiveTab = { id: session.id, url };
    tabs.push(tab);
    setActiveLiveTab(execCtx, tab);
    return { success: true, message: `Opened ${url} in the live browser (tab ${tabs.length} of ${tabs.length}, session ${session.id}). The user can watch it in the Browser tab — narrate what you do there.`, liveSessionId: session.id, liveSessionUrl: url, liveTab: tabs.length, liveTabCount: tabs.length };
  } catch (err: any) {
    if (isPoolFullError(err)) return { error: POOL_FULL_ERROR };
    return { error: err.message || String(err) };
  }
}

async function execBrowserClick(args: any, execCtx?: LiveExecCtx): Promise<any> {
  const { tab, error } = resolveLiveTab(execCtx, args.tab);
  if (!tab) return { error };
  const id = tab.id;
  try {
    if (args.selector) {
      // Selector clicks must go through the worker's /action endpoint
      // (page.click(selector)); liveInput drops the selector and would
      // click (0,0) instead.
      await liveAction(id, 'click', { selector: String(args.selector), button: String(args.button || 'left') });
      return { success: true, message: `Clicked ${args.selector} in live browser tab ${liveTabNumber(execCtx, tab)}.`, liveSessionId: id };
    }
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'browser_click needs x + y viewport coordinates (or a selector).' };
    await liveInput(id, { type: 'click', x, y, button: String(args.button || 'left') });
    return { success: true, message: `Clicked (${x}, ${y}) in live browser tab ${liveTabNumber(execCtx, tab)}.`, liveSessionId: id };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBrowserType(args: any, execCtx?: LiveExecCtx): Promise<any> {
  const { tab, error } = resolveLiveTab(execCtx, args.tab);
  if (!tab) return { error };
  const id = tab.id;
  const text = String(args.text ?? '');
  if (!text) return { error: 'browser_type needs text.' };
  try {
    if (args.selector) {
      // Selector typing must go through /action (page.fill(selector));
      // liveInput drops the selector and would type into whatever is
      // focused (or nothing).
      await liveAction(id, 'type', { selector: String(args.selector), text });
    } else {
      await liveInput(id, { type: 'type', text });
    }
    return { success: true, message: `Typed ${text.length} chars in live browser tab ${liveTabNumber(execCtx, tab)}.`, liveSessionId: id };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBrowserPressKey(args: any, execCtx?: LiveExecCtx): Promise<any> {
  const { tab, error } = resolveLiveTab(execCtx, args.tab);
  if (!tab) return { error };
  const id = tab.id;
  const key = String(args.key || '').trim();
  if (!key) return { error: 'browser_press_key needs a key (e.g. "Enter").' };
  try {
    await liveInput(id, { type: 'key', key });
    return { success: true, message: `Pressed ${key} in live browser tab ${liveTabNumber(execCtx, tab)}.`, liveSessionId: id };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBrowserScreenshot(args: any, execCtx?: LiveExecCtx): Promise<any> {
  const { tab, error } = resolveLiveTab(execCtx, args.tab);
  if (!tab) return { error };
  const id = tab.id;
  try {
    const frame = await getLiveFrame(id);
    const size = frame.width && frame.height ? ` (${frame.width}x${frame.height})` : '';
    return { success: true, message: `Captured the current frame of live browser tab ${liveTabNumber(execCtx, tab)}${size} — it is visible in the Browser tab.`, liveSessionId: id };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

async function execBrowserListTabs(_args: any, execCtx?: LiveExecCtx): Promise<any> {
  const tabs = liveTabList(execCtx);
  if (tabs.length === 0) return { success: true, message: 'No live browser tabs open yet — call browser_goto with a url to open the first tab (up to 4 tabs at once).' };
  const lines = tabs.map((t, i) => `${i + 1}. ${t.url || '(blank page)'}${t.id === execCtx?.liveSessionId ? ' [active]' : ''} (session ${t.id})`);
  return { success: true, message: `Live browser tabs (${tabs.length}/4):\n${lines.join('\n')}\nYou drive one tab at a time — pass tab: <number> to any browser_* tool, or browser_goto with new_tab: true to open another.` };
}

async function execGoogle(args: any, kind: string): Promise<any> {
  try {
    switch (kind) {
      case 'gmail_list': return { success: true, message: await googleApis.gmailList(Number(args.maxResults) || 5) };
      case 'gmail_search': return { success: true, message: await googleApis.gmailSearch(String(args.query || '')) };
      case 'gmail_send': return { success: true, message: await googleApis.gmailSend(String(args.to || ''), String(args.subject || ''), String(args.body || '')) };
      case 'gmail_draft': return { success: true, message: await googleApis.gmailDraft(String(args.to || ''), String(args.subject || ''), String(args.body || '')) };
      case 'calendar_list': return { success: true, message: await googleApis.calendarList(Number(args.maxResults) || 5) };
      case 'calendar_create': return { success: true, message: await googleApis.calendarCreate(String(args.title || ''), String(args.start || ''), String(args.end || '')) };
      case 'drive_list': return { success: true, message: await googleApis.driveList(String(args.query || '')) };
      case 'docs_create': return { success: true, message: await googleApis.docsCreate(String(args.title || ''), String(args.text || '')) };
      case 'docs_read': return { success: true, message: await googleApis.docsRead(String(args.name || '')) };
      default: return { error: `Unknown Google tool ${kind}.` };
    }
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

// Dhaka "now" parts via Intl (server TZ is UTC; reminders are Asia/Dhaka).
function dhakaNow(): { date: Date; y: number; m: number; d: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { date: new Date(), y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute') };
}

function parseReminderInput(input: string): { dueAt: Date; message: string } | { error: string } {
  const text = input.trim();
  const inMatch = text.match(/^in\s+(\d+)\s*(minute|minutes|hour|hours)\s*(?:::?\s*(.*))?$/i);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const ms = /hour/i.test(inMatch[2]) ? n * 3600 * 1000 : n * 60 * 1000;
    return { dueAt: new Date(Date.now() + ms), message: (inMatch[3] || 'Reminder').trim() || 'Reminder' };
  }
  const atMatch = text.match(/^at\s+(\d{1,2}):(\d{2})\s*(?:::?\s*(.*))?$/i);
  if (atMatch) {
    const hh = Number(atMatch[1]); const mm = Number(atMatch[2]);
    if (hh > 23 || mm > 59) return { error: 'Invalid time — use HH:MM (24h).' };
    const now = dhakaNow();
    // Build the target in Dhaka wall time: compute the UTC instant that
    // reads hh:mm in Dhaka by offsetting from the Dhaka "now" reading.
    const nowDhakaMs = Date.UTC(now.y, now.m - 1, now.d, now.hh, now.mm);
    let targetDhakaMs = Date.UTC(now.y, now.m - 1, now.d, hh, mm);
    if (targetDhakaMs <= nowDhakaMs) targetDhakaMs += 24 * 3600 * 1000;
    const deltaMs = targetDhakaMs - nowDhakaMs;
    return { dueAt: new Date(Date.now() + deltaMs), message: (atMatch[3] || 'Reminder').trim() || 'Reminder' };
  }
  return { error: 'Use "in 30 minutes :: message" or "at 18:30 :: message".' };
}

async function execRemind(args: any): Promise<any> {
  const action = String(args.action || '').toLowerCase();
  const store = await loadStore();
  if (action === 'add') {
    const parsed = parseReminderInput(String(args.input || ''));
    if ('error' in parsed) return { error: parsed.error };
    const entry = { id: newId('rem'), message: parsed.message, dueAt: parsed.dueAt.toISOString(), fired: false, createdAt: new Date().toISOString() };
    store.reminders.push(entry);
    saveStoreSoon();
    return { success: true, message: `Reminder set for ${parsed.dueAt.toISOString()} (Asia/Dhaka): ${parsed.message}` };
  }
  if (action === 'list') {
    const pending = store.reminders.filter((r) => !r.fired);
    if (!pending.length) return { success: true, message: 'No pending reminders.' };
    return { success: true, message: pending.map((r) => `• ${r.dueAt} — ${r.message}`).join('\n') };
  }
  if (action === 'due') {
    const due = store.reminders.filter((r) => r.fired);
    if (!due.length) return { success: true, message: 'No fired reminders to surface.' };
    return { success: true, message: due.map((r) => `• ${r.dueAt} — ${r.message}`).join('\n') };
  }
  return { error: 'remind action must be add | list | due.' };
}

async function execGoals(args: any): Promise<any> {
  const action = String(args.action || '').toLowerCase();
  const input = String(args.input || '').trim();
  const store = await loadStore();
  if (action === 'list') {
    if (!store.goals.length) return { success: true, message: 'No goals yet. Add one with: goals add :: <title>.' };
    return { success: true, message: store.goals.map((g) => `• ${g.title} — ${g.progress}%`).join('\n') };
  }
  if (action === 'add') {
    const title = input.replace(/^add\s*::\s*/i, '').trim();
    if (!title) return { error: 'goals add needs a title: "add :: <title>".' };
    if (store.goals.some((g) => g.title.toLowerCase() === title.toLowerCase())) {
      return { success: true, message: `Goal "${title}" already exists.` };
    }
    store.goals.push({ title, progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    saveStoreSoon();
    return { success: true, message: `Goal added: "${title}".` };
  }
  if (action === 'progress') {
    const m = input.match(/^progress\s*::\s*(.+?)\s*::\s*(\d+)\s*%?$/i);
    if (!m) return { error: 'Use: "progress :: <title> :: <0-100>".' };
    const goal = store.goals.find((g) => g.title.toLowerCase() === m[1].trim().toLowerCase());
    if (!goal) return { error: `No goal named "${m[1].trim()}".` };
    goal.progress = Math.min(100, Math.max(0, Number(m[2])));
    goal.updatedAt = new Date().toISOString();
    saveStoreSoon();
    return { success: true, message: `Goal "${goal.title}" is now ${goal.progress}%.` };
  }
  return { error: 'goals action must be list | add | progress.' };
}

function extractPrice(text: string): number | null {
  const m = text.match(/(?:৳|Tk|BDT|\$|price|Price|দাম)\s*:?\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

export async function checkWatchNow(watchId: string): Promise<string> {
  const store = await loadStore();
  const w = store.watches.find((x) => x.id === watchId);
  if (!w) return `No watch ${watchId}.`;
  try {
    const text = stripHtmlToText(await fetchText(w.url));
    if (w.kind === 'offer') {
      const hit = w.keyword ? text.toLowerCase().includes(w.keyword.toLowerCase()) : false;
      w.lastValue = hit ? `keyword "${w.keyword}" found` : 'keyword not found';
      if (hit) (w as any).lastHit = new Date().toISOString();
      saveStoreSoon();
      return hit ? `Offer watch HIT: "${w.keyword}" appeared on ${w.url}.` : `Offer watch: "${w.keyword}" not found on ${w.url} yet.`;
    }
    const price = extractPrice(text);
    w.lastValue = price !== null ? `৳${price}` : 'no price found';
    if (price !== null && w.targetPrice !== undefined && price <= w.targetPrice) {
      (w as any).lastHit = new Date().toISOString();
      saveStoreSoon();
      return `Price watch HIT: ${w.url} is now ৳${price} (target ≤ ৳${w.targetPrice}).`;
    }
    saveStoreSoon();
    return price !== null ? `Price watch: ${w.url} is ৳${price} (target ≤ ৳${w.targetPrice}).` : `Price watch: no price found on ${w.url}.`;
  } catch (err: any) {
    return `Watch check failed: ${err.message || String(err)}`;
  }
}

async function execScheduledBrowse(args: any): Promise<any> {
  const action = String(args.action || '').toLowerCase();
  const store = await loadStore();
  if (action === 'add') {
    const url = String(args.url || '').trim();
    const kind = (String(args.kind || 'offer').toLowerCase() === 'price' ? 'price' : 'offer') as 'price' | 'offer';
    if (!url) return { error: 'scheduled_browse add needs a url.' };
    const interval = Math.max(15, Number(args.intervalMinutes) || 60);
    if (kind === 'price' && args.targetPrice === undefined) return { error: 'A price watch needs targetPrice.' };
    if (kind === 'offer' && !args.keyword) return { error: 'An offer watch needs a keyword.' };
    const watch = {
      id: newId('watch'), url, kind,
      selector: 'body',
      keyword: args.keyword ? String(args.keyword) : undefined,
      targetPrice: args.targetPrice !== undefined ? Number(args.targetPrice) : undefined,
      intervalMinutes: interval, createdAt: new Date().toISOString(),
    };
    store.watches.push(watch);
    saveStoreSoon();
    return { success: true, message: `Watch added (${watch.id}): ${kind} on ${url}, every ${interval} min (minimum 15).` };
  }
  if (action === 'list') {
    if (!store.watches.length) return { success: true, message: 'No browse watches. Add one with: scheduled_browse add.' };
    return {
      success: true,
      message: store.watches.map((w) => `• ${w.id} — ${w.kind} ${w.url} (every ${w.intervalMinutes} min)${w.lastValue ? ` — last: ${w.lastValue}` : ''}${(w as any).lastHit ? ` — HIT at ${(w as any).lastHit}` : ''}`).join('\n'),
    };
  }
  if (action === 'remove') {
    const id = String(args.id || '').trim();
    const before = store.watches.length;
    store.watches = store.watches.filter((w) => w.id !== id);
    saveStoreSoon();
    return { success: true, message: before === store.watches.length ? `No watch ${id}.` : `Removed watch ${id}.` };
  }
  return { error: 'scheduled_browse action must be add | list | remove.' };
}

// ---------------------------------------------------------------------------
// Scheduler wiring (registered once at module load; server must stay awake
// for timed jobs to fire — Render free sleeps when idle, documented).
// ---------------------------------------------------------------------------
let schedulerWired = false;
export function wireNexusScheduler(): void {
  if (schedulerWired) return;
  schedulerWired = true;
  startNexusScheduler();
  onReminder((r) => {
    console.log(`[nexus-reminder] ${r.dueAt} — ${r.message}`);
  });
  onWatchHit((w) => {
    checkWatchNow(w.id)
      .then((msg) => console.log(`[nexus-watch] ${w.id}: ${msg}`))
      .catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export async function executeNexusTool(
  name: string,
  args: any,
  execCtx?: LiveExecCtx,
): Promise<any> {
  try {
    switch (name) {
      case 'github_push': return execGithubPush(args);
      case 'github_create_repo': return execGithubCreateRepo(args);
      case 'github_repos': return execGithubRepos(args);
      case 'github_file': return execGithubFile(args);
      case 'github_issues': return execGithubIssuesUnified(args);
      case 'github_prs': return execGithubIssues(args, 'prs');
      case 'github_create_issue': return execGithubCreateIssue(args);
      case 'github_create_pr': return execGithubCreatePr(args);
      case 'github_pull_request': return execGithubPullRequest(args);
      case 'github_actions': return execGithubActions(args);
      case 'github_release': return execGithubRelease(args);
      case 'github_code_search': return execGithubCodeSearch(args);
      case 'github_import': return execGithubImport(args, execCtx);
      case 'build_page': return execBuildPage(args);
      case 'build_site': return execBuildSite(args);
      case 'deploy_site': return execDeploySite(args);
      case 'web_search': return execWebSearch(args);
      case 'read_page': return execReadPage(args);
      case 'generate_image_pollinations': return execGenerateImage(args);
      case 'file_grep': return execFileGrep(args);
      case 'local_rag': return execLocalRag(args);
      case 'vector_store': return execVectorStore(args);
      case 'public_api_discovery': return execPublicApiDiscovery(args);
      case 'free_tier_directory': return execFreeTierDirectory(args);
      case 'desh_api': return execDeshApi(args);
      case 'browse_task': return execBrowseTask(args);
      case 'browse_job': return execBrowseJob(args);
      case 'browse_vision': return execBrowseVision(args);
      case 'browse_resume': return execBrowseResume(args);
      case 'browser_goto': return execBrowserGoto(args, execCtx);
      case 'browser_click': return execBrowserClick(args, execCtx);
      case 'browser_type': return execBrowserType(args, execCtx);
      case 'browser_press_key': return execBrowserPressKey(args, execCtx);
      case 'browser_screenshot': return execBrowserScreenshot(args, execCtx);
      case 'browser_list_tabs': return execBrowserListTabs(args, execCtx);
      case 'gmail_list': case 'gmail_search': case 'gmail_send': case 'gmail_draft':
      case 'calendar_list': case 'calendar_create':
      case 'drive_list': case 'docs_create': case 'docs_read':
        return execGoogle(args, name);
      case 'remind': return execRemind(args);
      case 'goals': return execGoals(args);
      case 'scheduled_browse': return execScheduledBrowse(args);
      default: return { error: `Unknown Nexus tool: ${name}` };
    }
  } catch (err: any) {
    return { error: err.message || `Error executing tool ${name}` };
  }
}
