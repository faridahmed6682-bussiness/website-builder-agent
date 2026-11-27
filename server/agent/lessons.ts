// Learning from mistakes — a server-side lessons file (lessons.md), same
// pattern as a developer's own lessons file. Every time a build fails and
// gets fixed, the error + the fix are recorded. The agent reads lessons.md
// at the start of every session and checks it before writing similar code,
// so the same mistake is not repeated.
//
// Recording is automatic: the verify-then-fix loop records a lesson whenever
// a repair round fixes a verification failure, and the reviewer pass records
// one whenever it finds + fixes an issue. The agent can also record one via
// the save_lesson tool. The file is plain text — the user can read and edit it.
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const LESSONS_FILE = path.join(DATA_DIR, 'lessons.md');

const DEFAULT_LESSONS = `# Lessons — mistakes this agent has made and fixed (plain text, editable).
# The agent reads this at the start of every session and checks it before
# writing similar code. New lessons are appended automatically when a build
# fails and gets fixed. Format: one dated entry per lesson (error + fix).

## 2026-11-27 — Never present a broken build as done
- Error: the agent finished a build and said "done" while the live preview was still failing (blank page / JS error).
- Fix: after writing files, always run verify_live_preview (HTTP 200, HTML structure, inline-JS syntax, asset links). On failure, feed the error back and repair (max 2 rounds). If still failing, say so honestly in the final message — never claim success.

## 2026-11-27 — Model IDs must be verified live, never assumed
- Error: the chain used hardcoded free-model IDs (qwen3-coder-480b:free, deepseek-r1:free, llama-3.3-70b:free) that OpenRouter no longer serves free — calls failed with 404/model-not-found.
- Fix: fetch the live free list at boot and daily (FreeLLMAPI /v1/models + OpenRouter /v1/models :free). An ID enters a chain only after being verified present. Paid-only models (Argon, Neon, Carbon, Pro Preview) and retired models (3.7 Flash, 3.5 Flash) are blocklisted at discovery.

## 2026-11-27 — Tool outputs must be truncated, never dumped raw
- Error: full tool outputs (long file reads, search results) were fed back into the model, wasting context and hitting per-minute token limits.
- Fix: truncate every tool result to ~3000 chars (TOOL_RESULT_MAX_CHARS) and pass the model a short brief instead of raw dumps. The model reads only the files it needs.
`;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readLessons(): Promise<string> {
  try {
    return await fs.readFile(LESSONS_FILE, 'utf-8');
  } catch {
    await ensureDataDir();
    await fs.writeFile(LESSONS_FILE, DEFAULT_LESSONS, 'utf-8').catch(() => {});
    return DEFAULT_LESSONS;
  }
}

/** Append one lesson. Keeps the file bounded (~64 KB) by trimming the oldest entries. */
export async function recordLesson(error: string, fix: string, context?: string): Promise<void> {
  const e = (error || '').trim().slice(0, 500);
  const f = (fix || '').trim().slice(0, 500);
  if (!e || !f) return;
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const entry = `\n## ${stamp}${context ? ` — ${context.slice(0, 80)}` : ''}\n- Error: ${e}\n- Fix: ${f}\n`;
  const current = await readLessons();
  if (current.includes(e.slice(0, 120))) return; // same lesson already recorded
  let next = current + entry;
  if (next.length > 64 * 1024) {
    // Trim oldest lesson entries, keeping the header.
    const lines = next.split('\n');
    const headerEnd = lines.findIndex((l) => l.startsWith('## '));
    const body = lines.slice(headerEnd);
    while (body.join('\n').length > 56 * 1024 && body.length > 3) {
      const nextHeader = body.findIndex((l, i) => i > 0 && l.startsWith('## '));
      if (nextHeader === -1) break;
      body.splice(0, nextHeader);
    }
    next = [...lines.slice(0, headerEnd), ...body].join('\n');
  }
  await fs.writeFile(LESSONS_FILE, next, 'utf-8').catch(() => {});
}
