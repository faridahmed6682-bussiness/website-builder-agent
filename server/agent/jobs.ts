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
  // Stop support (2026-11-29): the user must be able to stop a RUNNING
  // job, not just a queued one. cancelJob() sets this flag on a 'working'
  // job; the job's turn loop also gets the session cancel flag (see the
  // /api/jobs/:id/cancel route), so the loop stops at its next round
  // boundary, and pump() marks the job 'failed' instead of 'done' below.
  cancelRequested?: boolean;
}

export type JobRunner = (job: Job) => Promise<{ summary: string; previewUrl?: string }>;

let jobs: Job[] = [];
let jobsLoaded = false;
let workerRunning = false;
let runner: JobRunner | null = null;
// Stop fix (2026-11-29): loadJobs used to set jobsLoaded = true BEFORE the
// async file read finished, so a concurrent caller (e.g. startJobWorker's
// pump racing a createJob at server startup) proceeded with a stale array
// and the late `jobs = []` reassignment silently discarded the just-created
// job — the job vanished from the list (and could never be stopped or
// tracked). All callers now await one shared load promise.
let jobsLoadPromise: Promise<void> | null = null;

async function loadJobs(): Promise<void> {
  if (jobsLoaded) return;
  if (!jobsLoadPromise) jobsLoadPromise = doLoadJobs();
  await jobsLoadPromise;
}

async function doLoadJobs(): Promise<void> {
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf-8');
    jobs = JSON.parse(raw) as Job[];
    // Jobs stuck in 'working' were interrupted by a restart — re-queue them,
    // unless the user had asked to stop them: a cancelled job stays
    // cancelled instead of silently restarting.
    let changed = false;
    for (const j of jobs) {
      if (j.status === 'working') {
        if (j.cancelRequested) {
          j.status = 'failed';
          j.error = 'Cancelled by the user.';
          j.finishedAt = Date.now();
        } else {
          j.status = 'queued';
          j.note = 'Interrupted by a server restart — re-queued.';
        }
        changed = true;
      }
    }
    if (changed) await saveJobs();
  } catch {
    jobs = [];
  }
  jobsLoaded = true;
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
  if (!job || job.status === 'done' || job.status === 'failed') return false;
  if (job.status === 'queued') {
    job.status = 'failed';
    job.error = 'Cancelled by the user.';
    job.finishedAt = Date.now();
    await saveJobs();
    return true;
  }
  // 'working' jobs used to be un-cancellable (only 'queued' could stop),
  // so a running build had no stop at all. Flag it instead: the cancel
  // route also sets the session cancel flag so the turn loop stops at its
  // next round boundary, and pump() below marks the job 'failed' rather
  // than 'done' once the runner settles.
  job.cancelRequested = true;
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
        if (job.cancelRequested) {
          // The user stopped this job while it ran: it is a cancellation,
          // not a successful finish — even if the runner's turn resolved.
          job.status = 'failed';
          job.error = 'Cancelled by the user.';
          job.summary = undefined;
          job.previewUrl = undefined;
        } else {
          job.status = 'done';
          job.summary = result.summary;
          job.previewUrl = result.previewUrl;
        }
      } catch (err: any) {
        job.status = 'failed';
        job.error = job.cancelRequested
          ? 'Cancelled by the user.'
          : String(err?.message || err || 'Job failed').slice(0, 500);
      }
      job.finishedAt = Date.now();
      await saveJobs();
    }
  } finally {
    workerRunning = false;
  }
}
