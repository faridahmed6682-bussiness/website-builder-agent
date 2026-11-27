// Memory system — the model itself is stateless, so memory comes from the
// system (like Muse's MEMORY.md), NOT from the model. AI Studio has no
// memory; this agent does.
//
// 1. PROJECTS persist: built sites stay in projects/<session>/ and are listed
//    (GET /api/projects) — reopen, continue, edit, redeploy. Never lost when
//    the chat closes.
// 2. CHAT HISTORY persists per session as JSON (data/chats/<session>.json):
//    reopening a past chat restores the full conversation (GET /api/chats,
//    GET /api/chats/:id); the agent continues where it stopped.
// 3. USER MEMORY FILE: data/memory.md — plain text the user can inspect.
//    Facts, preferences, decisions. Read at the start of every session and
//    updated (via the save_memory tool) when the user states a durable fact.
//    Seeded once from the user's own stated facts; the user can edit it.
//
// HONEST LIMIT: memory lives on the SERVER. On Render it persists across
// devices; on Termux it lives on the phone only. Render free has ephemeral
// disk — a redeploy wipes data/ unless it is backed up. Export any time with
// GET /api/backup (zip of memory.md + chats + projects).
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const MEMORY_FILE = path.join(DATA_DIR, 'memory.md');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const PROJECTS_DIR = path.resolve(process.cwd(), 'projects');

const DEFAULT_MEMORY = `# User memory — durable facts about the user (plain text, editable).
# The agent reads this at the start of every session. Update it when the user
# states a durable fact (via the save_memory tool or by editing this file).

- Name: Mehedi Hasan, 22, from Rangpur City, Bangladesh.
- Language: Bengali first (Bangla). He said he does not understand spoken English — reply in Bengali unless he writes in English.
- Business: small businessman / entrepreneur (Munsi Store, crochet export, razors).
- Money rule: free-only, no payment card. No paid API anywhere — Gemini / Groq / OpenRouter free tiers only.
- Phone: Samsung Galaxy A07, 4 GB RAM. Runs the agent in Termux or Render free.
- API keys: 10 Google AI Studio keys (separate accounts/projects), 11 Groq keys, 8 OpenRouter keys. Key values are NEVER asked for in chat and NEVER stored anywhere except env vars / the FreeLLMAPI dashboard, entered by the user himself.
- Routing: tools/code ONLY when the message actually needs it. Casual chat is answered directly, no tools, no code.
- BACKEND RULE (user, 2026-11-27 06:30): default builds are FRONTEND-ONLY (HTML/CSS/JS/React). NEVER do backend/Firebase work unless the user explicitly asks for backend or Firebase work. Firebase is the DEFAULT backend whenever backend work IS asked for (Firebase-direct: browser → Auth + Firestore + Storage + Hosting, no Express). If a request implies backend needs (login, saving user data, orders) but the user did not say backend/Firebase, ASK ONCE whether to add Firebase, then proceed only on yes. EXPRESS RULE (user, 2026-11-27 06:31): NEVER add an Express server to a built app unless the user explicitly says the word "Express" (or asks for a custom Node/Express server). If server logic is needed and the user did not ask for Express, prefer Firebase Cloud Functions first, and ASK before adding any server.
- Hydrogen-saving: the tool loop runs on the cheap model (Flash-Lite / auto:fast); Hydrogen is for planning, coding, debugging and review. The cheap model hands Hydrogen only a short brief, never full tool output.
- Quality: plan first, verify-then-fix (never present a broken build as done), reviewer pass, memory + lessons.
`;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// User memory file
// ---------------------------------------------------------------------------
export async function readUserMemory(): Promise<string> {
  try {
    return await fs.readFile(MEMORY_FILE, 'utf-8');
  } catch {
    await ensureDataDir();
    await fs.writeFile(MEMORY_FILE, DEFAULT_MEMORY, 'utf-8').catch(() => {});
    return DEFAULT_MEMORY;
  }
}

export async function appendUserMemory(line: string): Promise<void> {
  const clean = (line || '').trim();
  if (!clean) return;
  const current = await readUserMemory();
  if (current.includes(clean)) return; // already recorded
  await fs.appendFile(MEMORY_FILE, `\n- ${clean}\n`, 'utf-8');
}

export async function setUserMemory(content: string): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(MEMORY_FILE, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Chat history (per session JSON)
// ---------------------------------------------------------------------------
export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  at: number;
  image?: string;
}

export interface StoredChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

function safeSessionId(sessionId: string): string {
  return (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function chatPath(sessionId: string): string {
  return path.join(CHATS_DIR, `${safeSessionId(sessionId)}.json`);
}

export async function loadChat(sessionId: string): Promise<StoredChat | null> {
  try {
    const raw = await fs.readFile(chatPath(sessionId), 'utf-8');
    return JSON.parse(raw) as StoredChat;
  } catch {
    return null;
  }
}

function titleFrom(text: string): string {
  const t = (text || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return t || 'Untitled chat';
}

/** Append one turn (user + assistant) to the session's stored history. */
export async function saveChatTurn(sessionId: string, userText: string, assistantText: string, image?: string): Promise<void> {
  if (!sessionId) return;
  await fs.mkdir(CHATS_DIR, { recursive: true });
  const now = Date.now();
  const existing = await loadChat(sessionId);
  const chat: StoredChat = existing || {
    id: safeSessionId(sessionId),
    title: titleFrom(userText),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const last = chat.messages[chat.messages.length - 1];
  const push = (m: ChatMessage) => {
    const prev = chat.messages[chat.messages.length - 1];
    if (prev && prev.role === m.role && prev.text === m.text) return; // dedupe retries
    chat.messages.push(m);
  };
  push({ role: 'user', text: userText, at: now, ...(image ? { image } : {}) });
  push({ role: 'model', text: assistantText, at: now });
  void last;
  // Cap history at 500 messages (oldest dropped) so the file stays small.
  if (chat.messages.length > 500) chat.messages = chat.messages.slice(-500);
  chat.updatedAt = now;
  await fs.writeFile(chatPath(sessionId), JSON.stringify(chat, null, 2), 'utf-8').catch(() => {});
}

export async function listChats(): Promise<Array<{ id: string; title: string; updatedAt: number; messageCount: number; hasProject: boolean }>> {
  try {
    const files = await fs.readdir(CHATS_DIR);
    const out: Array<{ id: string; title: string; updatedAt: number; messageCount: number; hasProject: boolean }> = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const chat = JSON.parse(await fs.readFile(path.join(CHATS_DIR, f), 'utf-8')) as StoredChat;
        let hasProject = false;
        try {
          await fs.stat(path.join(PROJECTS_DIR, chat.id, 'index.html'));
          hasProject = true;
        } catch { /* no project for this session */ }
        out.push({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messageCount: chat.messages.length, hasProject });
      } catch { /* skip corrupt files */ }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export async function listProjects(): Promise<Array<{ sessionId: string; title: string; updatedAt: number; files: number; sizeBytes: number; url: string }>> {
  const out: Array<{ sessionId: string; title: string; updatedAt: number; files: number; sizeBytes: number; url: string }> = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = path.join(PROJECTS_DIR, name);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      await fs.stat(path.join(dir, 'index.html'));
      const files = await fs.readdir(dir);
      let sizeBytes = 0;
      for (const f of files) {
        try {
          sizeBytes += (await fs.stat(path.join(dir, f))).size;
        } catch { /* ignore */ }
      }
      const chat = await loadChat(name);
      out.push({
        sessionId: name,
        title: chat?.title || name,
        updatedAt: Math.max(st.mtimeMs, chat?.updatedAt || 0),
        files: files.length,
        sizeBytes,
        url: `/projects/${name}/index.html`,
      });
    } catch { /* not a project dir (no index.html) */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// ---------------------------------------------------------------------------
// Backup / export (zip: memory.md + chats + projects)
// ---------------------------------------------------------------------------
export async function exportBackup(): Promise<Buffer> {
  const zip = new AdmZip();
  const memory = await readUserMemory();
  zip.addFile('memory.md', Buffer.from(memory, 'utf-8'));
  try {
    const chats = await fs.readdir(CHATS_DIR);
    for (const f of chats) {
      if (!f.endsWith('.json')) continue;
      try {
        zip.addFile(`chats/${f}`, await fs.readFile(path.join(CHATS_DIR, f)));
      } catch { /* skip */ }
    }
  } catch { /* no chats yet */ }
  const projects = await listProjects();
  for (const p of projects) {
    const dir = path.join(PROJECTS_DIR, p.sessionId);
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        const fp = path.join(dir, f);
        try {
          const st = await fs.stat(fp);
          if (st.isFile() && st.size <= 5 * 1024 * 1024) {
            zip.addFile(`projects/${p.sessionId}/${f}`, await fs.readFile(fp));
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return zip.toBuffer();
}
