// Background / scheduled jobs — "build this by morning".
//
// The user queues a build (Jobs panel, or the agent's queue_job tool when the
// user says "build this by morning"). The job runs in the background, one at
// a time, and the UI shows live status (queued / working / done / failed) and
// the finished preview link. Completion is shown in the Jobs panel (polled)
// and, when the browser allows it, as a Notification.
//
// HONEST LIMIT — Render free sleeps after 15 min idle, so a long background
// job on Render can be paused mid-run when the service sleeps (it resumes
// when the service wakes; a job interrupted by a restart is re-queued).
// Termux on the phone keeps running while the phone is awake
// (termux-wake-lock). For reliable overnight builds, Termux is the better
// host; Render is fine for short jobs while the service is awake.
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

export type JobStatus = 'queued' | 'working' | 'done' | 'failed';

export interface Job {
  id: string;
  prompt: string;
  sessionId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  previewUrl?: string;
  error?: string;
  note?: string;
}

export type JobRunner = (job: Job) => Promise<{ summary: string; previewUrl?: string }>;

let jobs: Job[] = [];
let jobsLoaded = false;
let workerRunning = false;
let runner: JobRunner | null = null;

async function loadJobs(): Promise<void> {
  if (jobsLoaded) return;
  jobsLoaded = true;
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf-8');
    jobs = JSON.parse(raw) as Job[];
    // Jobs stuck in 'working' were interrupted by a restart — re-queue them.
    let changed = false;
    for (const j of jobs) {
      if (j.status === 'working') {
        j.status = 'queued';
        j.note = 'Interrupted by a server restart — re-queued.';
        changed = true;
      }
    }
    if (changed) await saveJobs();
  } catch {
    jobs = [];
  }
}

async function saveJobs(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8').catch(() => {});
}

export async function createJob(prompt: string, sessionId: string): Promise<Job> {
  await loadJobs();
  const job: Job = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    prompt: (prompt || '').trim().slice(0, 2000),
    sessionId: sessionId || `session_${Date.now()}`,
    status: 'queued',
    createdAt: Date.now(),
  };
  jobs.unshift(job);
  if (jobs.length > 50) jobs = jobs.slice(0, 50);
  await saveJobs();
  pump();
  return job;
}

export async function listJobs(): Promise<Job[]> {
  await loadJobs();
  return [...jobs].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id: string): Promise<Job | null> {
  await loadJobs();
  return jobs.find((j) => j.id === id) || null;
}

export async function cancelJob(id: string): Promise<boolean> {
  await loadJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status !== 'queued') return false;
  job.status = 'failed';
  job.error = 'Cancelled by the user.';
  job.finishedAt = Date.now();
  await saveJobs();
  return true;
}

/** Register the turn runner (provided by the orchestrator) and start the pump. */
export function startJobWorker(runTurn: JobRunner): void {
  runner = runTurn;
  pump();
}

async function pump(): Promise<void> {
  if (workerRunning || !runner) return;
  workerRunning = true;
  try {
    await loadJobs();
    while (true) {
      const job = jobs.find((j) => j.status === 'queued');
      if (!job || !runner) break;
      job.status = 'working';
      job.startedAt = Date.now();
      job.note = undefined;
      await saveJobs();
      try {
        const result = await runner(job);
        job.status = 'done';
        job.summary = result.summary;
        job.previewUrl = result.previewUrl;
      } catch (err: any) {
        job.status = 'failed';
        job.error = String(err?.message || err || 'Job failed').slice(0, 500);
      }
      job.finishedAt = Date.now();
      await saveJobs();
    }
  } finally {
    workerRunning = false;
  }
}
