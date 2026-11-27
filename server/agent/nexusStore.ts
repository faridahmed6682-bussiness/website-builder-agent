// Persistent JSON store for the Nexus tools (goals, reminders, vector store,
// scheduled browse watches, Desh API cache). One file, data/nexus-store.json
// — survives restarts on disk, but on Render free the disk is ephemeral, so
// a redeploy may reset it; the tools always degrade gracefully to empty.
// No secrets are ever stored here (tokens live in githubAuth's encrypted store).
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'nexus-store.json');

export interface GoalEntry { title: string; progress: number; createdAt: string; updatedAt: string }
export interface ReminderEntry { id: string; message: string; dueAt: string; fired: boolean; createdAt: string }
export interface WatchEntry {
  id: string; url: string; kind: 'price' | 'offer'; selector: string;
  keyword?: string; targetPrice?: number; intervalMinutes: number;
  lastValue?: string; createdAt: string;
}
export interface VectorEntry { id: string; text: string; embedding: number[]; metadata: Record<string, string> }
export interface DeshCacheEntry { value: any; expiresAt: number }

export interface NexusStoreShape {
  goals: GoalEntry[];
  reminders: ReminderEntry[];
  watches: WatchEntry[];
  vectorStore: VectorEntry[];
  deshCache: Record<string, DeshCacheEntry>;
}

const EMPTY: NexusStoreShape = { goals: [], reminders: [], watches: [], vectorStore: [], deshCache: {} };

let cache: NexusStoreShape | null = null;
let saveTimer: NodeJS.Timeout | null = null;

export async function loadStore(): Promise<NexusStoreShape> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<NexusStoreShape>;
    cache = { ...EMPTY, ...parsed };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

export async function saveStore(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/** Debounced save — call after every mutation; writes at most once per 2 s. */
export function saveStoreSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStore().catch(() => {});
  }, 2000);
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// In-process scheduler (Render free sleeps when idle, so timed jobs only fire
// while the server is awake — documented in the README, never hidden).
// ---------------------------------------------------------------------------

export type ReminderHandler = (reminder: ReminderEntry) => void;
export type WatchHandler = (watch: WatchEntry, hit: string) => void;

const reminderHandlers = new Set<ReminderHandler>();
const watchHandlers = new Set<WatchHandler>();
export function onReminder(handler: ReminderHandler): void { reminderHandlers.add(handler); }
export function onWatchHit(handler: WatchHandler): void { watchHandlers.add(handler); }

let schedulerStarted = false;

export function startNexusScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Every minute: fire due reminders + run due watches.
  setInterval(async () => {
    try {
      const store = await loadStore();
      const now = new Date();
      let changed = false;
      for (const r of store.reminders) {
        if (!r.fired && new Date(r.dueAt) <= now) {
          r.fired = true;
          changed = true;
          for (const h of reminderHandlers) { try { h(r); } catch { /* ignore */ } }
        }
      }
      if (changed) saveStoreSoon();
    } catch { /* scheduler must never crash the server */ }
  }, 60000);
  // Watches run on their own interval (min 15 min, checked every 5 min).
  setInterval(async () => {
    try {
      const store = await loadStore();
      const now = Date.now();
      for (const w of store.watches) {
        const lastRun = (w as any)._lastRun || 0;
        if (now - lastRun < Math.max(15, w.intervalMinutes) * 60 * 1000) continue;
        (w as any)._lastRun = now;
        for (const h of watchHandlers) { try { h(w, ''); } catch { /* ignore */ } }
      }
      saveStoreSoon();
    } catch { /* ignore */ }
  }, 5 * 60 * 1000);
}
