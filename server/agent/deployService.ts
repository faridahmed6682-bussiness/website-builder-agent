// One-click deploy: build-check the current project → push to GitHub
// (Git Data API, no local git) → trigger the Render deploy hook → poll the
// Render API for live status when RENDER_API_KEY is set.
// Used by POST /api/deploy (Deploy button) and the deploy_site agent tool.
// Env: GITHUB_TOKEN (or the one-click connected token), RENDER_DEPLOY_HOOK_URL,
// RENDER_API_KEY (optional, for live status + live URL), RENDER_SERVICE_URL
// (optional fallback live URL), RENDER_SERVICE_ID (optional).
// Nothing here pretends: when the hook is not configured the job ends in
// `setup-needed` with the exact one-time steps instead of a fake success.
import fs from 'fs/promises';
import path from 'path';
import { pushFilesToGitHub, collectProjectDir } from './githubPush.ts';

export type DeployStage =
  | 'building'
  | 'pushing'
  | 'deploying'
  | 'live'
  | 'triggered'
  | 'setup-needed'
  | 'error';

export interface DeployJob {
  id: string;
  stage: DeployStage;
  message: string;
  repo?: string;
  repoUrl?: string;
  commitUrl?: string;
  liveUrl?: string;
  dashboardUrl?: string;
  setupNeeded?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const jobs = new Map<string, DeployJob>();

export function getDeployJob(id: string): DeployJob | undefined {
  return jobs.get(id);
}

export function deployStatus(): {
  githubConnected: boolean;
  deployHookConfigured: boolean;
  renderApiConfigured: boolean;
  serviceUrlConfigured: boolean;
} {
  return {
    githubConnected: Boolean(process.env.GITHUB_TOKEN),
    deployHookConfigured: Boolean(process.env.RENDER_DEPLOY_HOOK_URL),
    renderApiConfigured: Boolean(process.env.RENDER_API_KEY),
    serviceUrlConfigured: Boolean(process.env.RENDER_SERVICE_URL),
  };
}

const RENDER_YAML = (name: string) => `services:
  - type: web
    name: ${name}
    env: static
    buildCommand: echo 'static site - nothing to build'
    staticPublishPath: .
`;

const VERCEL_JSON = JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', cleanUrls: true }, null, 2) + '\n';

function parseServiceIdFromHook(hookUrl: string): string | null {
  const m = hookUrl.match(/srv-[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

async function triggerRenderHook(hookUrl: string): Promise<{ deployId?: string }> {
  const res = await fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const text = await res.text();
  if (!res.ok) throw new Error(`Render deploy hook failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* ignore */ }
  return { deployId: body?.deploy?.id || body?.id || undefined };
}

async function pollRenderDeploy(serviceId: string, deployId: string, apiKey: string): Promise<'live' | 'failed' | 'timeout'> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys/${deployId}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const body: any = await res.json();
      const status = body?.deploy?.status || body?.status || '';
      if (status === 'live') return 'live';
      if (['build_failed', 'update_failed', 'deactivated'].includes(status)) return 'failed';
    } catch {
      // keep polling
    }
  }
  return 'timeout';
}

async function fetchRenderServiceUrl(serviceId: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.render.com/v1/services/${serviceId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return body?.service?.serviceDetails?.url || null;
  } catch {
    return null;
  }
}

export function resolveProjectDir(sessionId?: string): string {
  const projectsDir = path.resolve(process.cwd(), 'projects');
  if (sessionId) {
    return path.join(projectsDir, sessionId);
  }
  return projectsDir;
}

export async function startDeploy(opts: {
  sessionId?: string;
  repo: string;
  branch?: string;
  isPrivate?: boolean;
  commitMessage?: string;
}): Promise<DeployJob> {
  const job: DeployJob = {
    id: `deploy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    stage: 'building',
    message: 'Starting deploy…',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  if (jobs.size > 50) {
    const first = jobs.keys().next().value;
    if (first) jobs.delete(first);
  }

  const update = (patch: Partial<DeployJob>) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  };

  (async () => {
    try {
      // ---- 1. Build check -------------------------------------------------
      const repoInput = (opts.repo || '').trim();
      if (!repoInput) throw new Error('A GitHub repo is required (owner/repo or just a name).');
      const [ownerPart, repoPart] = repoInput.includes('/') ? repoInput.split('/', 2) : ['', repoInput];
      const repoName = (repoPart || ownerPart).trim();
      if (!repoName || /[\s]/.test(repoName)) throw new Error(`Invalid repo name: "${repoInput}". Use owner/repo or a plain repo name.`);
      const branch = opts.branch || 'main';

      let projectDir = resolveProjectDir(opts.sessionId);
      let hasIndex = false;
      try {
        const stat = await fs.stat(path.join(projectDir, 'index.html'));
        hasIndex = stat.isFile();
      } catch { /* try fallback */ }
      if (!hasIndex) {
        const fallback = path.resolve(process.cwd(), 'projects');
        try {
          const stat = await fs.stat(path.join(fallback, 'index.html'));
          if (stat.isFile()) { projectDir = fallback; hasIndex = true; }
        } catch { /* no build */ }
      }
      if (!hasIndex) {
        throw new Error('No built project found yet — ask the agent to build the site first, then deploy.');
      }
      update({ stage: 'building', message: `Build check passed (${path.basename(projectDir)}). Writing deploy configs…` });

      // One-click deploy configs (only if the project doesn't define its own).
      try { await fs.access(path.join(projectDir, 'render.yaml')); } catch {
        await fs.writeFile(path.join(projectDir, 'render.yaml'), RENDER_YAML(repoName.replace(/[^a-zA-Z0-9-]/g, '-')), 'utf-8');
      }
      try { await fs.access(path.join(projectDir, 'vercel.json')); } catch {
        await fs.writeFile(path.join(projectDir, 'vercel.json'), VERCEL_JSON, 'utf-8');
      }

      // ---- 2. Push to GitHub ----------------------------------------------
      update({ stage: 'pushing', message: `Pushing to GitHub (${ownerPart || 'your account'}/${repoName}@${branch})…` });
      const { files, skipped } = await collectProjectDir(projectDir);
      if (!files.length) throw new Error('Project folder is empty — nothing to deploy.');
      const push = await pushFilesToGitHub({
        owner: ownerPart || undefined,
        repo: repoName,
        branch,
        message: opts.commitMessage || `Deploy site from Nexus AI Studio (${new Date().toISOString().slice(0, 10)})`,
        files,
        isPrivate: opts.isPrivate,
      });
      update({
        repo: `${push.repoUrl.split('github.com/')[1] || repoName}`,
        repoUrl: push.repoUrl,
        commitUrl: push.commitUrl,
        message: `Pushed ${push.filesPushed} file(s) to GitHub.${skipped.length ? ` Skipped ${skipped.length} large file(s).` : ''}`,
      });

      // ---- 3. Render deploy ------------------------------------------------
      const hookUrl = process.env.RENDER_DEPLOY_HOOK_URL || '';
      const apiKey = process.env.RENDER_API_KEY || '';
      const serviceId = process.env.RENDER_SERVICE_ID || (hookUrl ? parseServiceIdFromHook(hookUrl) : null);
      const dashboardUrl = serviceId ? `https://dashboard.render.com/web/${serviceId}` : 'https://dashboard.render.com/';
      update({ dashboardUrl });
      if (!hookUrl) {
        update({
          stage: 'setup-needed',
          message: 'Pushed to GitHub. Render deploy is not wired up yet — one-time setup needed (see steps).',
          setupNeeded: [
            '1. Open Render → New → Static Site (or Web Service) → pick the repo you just pushed to.',
            '2. Render deploys it once from the repo (render.yaml is already in the project).',
            '3. In the Render dashboard open the service → Settings → Deploy Hook → copy the hook URL.',
            '4. Set RENDER_DEPLOY_HOOK_URL to that URL in the service env vars (Render dashboard → this service → Environment) and redeploy this service once.',
            'After that single setup, the Deploy button deploys in one click. (Optional: also set RENDER_API_KEY to see live deploy status + the live URL here.)',
          ],
        });
        return;
      }
      update({ stage: 'deploying', message: 'Triggering Render deploy…' });
      const { deployId } = await triggerRenderHook(hookUrl);
      const liveUrl = process.env.RENDER_SERVICE_URL || '';
      if (!apiKey || !serviceId || !deployId) {
        update({
          stage: 'triggered',
          message: 'Render deploy triggered. Live status tracking needs RENDER_API_KEY — check the Render dashboard for progress.',
          liveUrl: liveUrl || undefined,
        });
        return;
      }
      const outcome = await pollRenderDeploy(serviceId, deployId, apiKey);
      if (outcome === 'live') {
        const url = liveUrl || (await fetchRenderServiceUrl(serviceId, apiKey)) || undefined;
        update({ stage: 'live', message: 'Deployed — the site is live.', liveUrl: url });
      } else if (outcome === 'failed') {
        update({ stage: 'error', message: 'Render deploy failed — see the Render dashboard logs.', error: 'Render reported build_failed / update_failed. Open the dashboard link for the build log.' });
      } else {
        update({
          stage: 'triggered',
          message: 'Deploy is still running after 5 minutes of polling — it may still go live; check the Render dashboard.',
          liveUrl: liveUrl || undefined,
        });
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/GitHub is not connected/.test(msg)) {
        update({
          stage: 'setup-needed',
          message: 'GitHub is not connected yet.',
          setupNeeded: [
            'Connect GitHub once with the "Connect GitHub" button (OAuth App or a one-time PAT), or set the GITHUB_TOKEN env var on this service.',
            'Then press Deploy again — the push + Render deploy run in one click.',
          ],
          error: msg,
        });
      } else {
        update({ stage: 'error', message: 'Deploy failed.', error: msg.slice(0, 500) });
      }
    }
  })();

  return job;
}
