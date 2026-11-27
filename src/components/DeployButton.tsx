// One-click Deploy — build → push to GitHub → trigger the Render deploy hook
// → show live status + the final live URL.
//
// Needs: GitHub connected (Connect GitHub button) or GITHUB_TOKEN env, and
// RENDER_DEPLOY_HOOK_URL env (one-time: create the Render static site from
// the repo once, copy its Deploy Hook URL from Settings). If the hook is not
// configured, the button says exactly what setup is still needed instead of
// pretending to deploy.
import React, { useState, useEffect, useRef } from 'react';
import { Rocket, X, Loader2, CheckCircle, AlertCircle, ExternalLink, Copy } from 'lucide-react';

interface DeployStatus {
  githubConnected: boolean;
  deployHookConfigured: boolean;
  renderApiConfigured: boolean;
  serviceUrlConfigured: boolean;
}

interface DeployJob {
  id: string;
  stage: string;
  message: string;
  repoUrl?: string;
  commitUrl?: string;
  liveUrl?: string;
  dashboardUrl?: string;
  setupNeeded?: string[];
  error?: string;
}

const TERMINAL = new Set(['live', 'triggered', 'setup-needed', 'error']);

export const DeployButton: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [repo, setRepo] = useState(() => localStorage.getItem('nexus-deploy-repo') || '');
  const [branch, setBranch] = useState('main');
  const [job, setJob] = useState<DeployJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/deploy/status');
      setStatus(await r.json());
    } catch {}
  };

  useEffect(() => {
    if (open) loadStatus();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [open ]);

  const poll = (jobId: string) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/deploy/${jobId}`);
        const j = await r.json();
        setJob(j);
        if (TERMINAL.has(j.stage)) {
          if (timer.current) clearInterval(timer.current);
        }
      } catch {}
    }, 2000);
  };

  const deploy = async () => {
    if (!repo.trim()) { setError('Repo name is required (e.g. "my-shop").'); return; }
    setLoading(true);
    setError(null);
    setJob(null);
    try {
      localStorage.setItem('nexus-deploy-repo', repo.trim());
      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId || undefined, repo: repo.trim(), branch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deploy failed to start');
      const r = await fetch(`/api/deploy/${data.jobId}`);
      const j = await r.json();
      setJob(j);
      if (!TERMINAL.has(j.stage)) poll(data.jobId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const stageLabel: Record<string, string> = {
    building: 'Building…', pushing: 'Pushing to GitHub…', deploying: 'Triggering Render deploy…',
    live: 'Live', triggered: 'Deploy triggered', 'setup-needed': 'Setup needed', error: 'Failed',
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition-all shadow-lg shadow-emerald-600/20"
        title="Deploy — build, push to GitHub, trigger Render, show the live URL"
      >
        <Rocket className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Deploy</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-bold flex items-center gap-2"><Rocket className="w-5 h-5 text-emerald-400" /> Deploy this project</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>

            {status && (
              <div className="flex flex-wrap gap-1.5 mb-3 text-[11px]">
                <span className={`px-2 py-0.5 rounded-md border ${status.githubConnected ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25' : 'bg-rose-500/10 text-rose-300 border-rose-500/25'}`}>
                  GitHub {status.githubConnected ? 'connected' : 'NOT connected'}
                </span>
                <span className={`px-2 py-0.5 rounded-md border ${status.deployHookConfigured ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25' : 'bg-amber-500/10 text-amber-300 border-amber-500/25'}`}>
                  Render hook {status.deployHookConfigured ? 'set' : 'not set'}
                </span>
                {status.renderApiConfigured && <span className="px-2 py-0.5 rounded-md border bg-sky-500/10 text-sky-300 border-sky-500/25">Live status on</span>}
              </div>
            )}

            <label className="text-xs text-slate-400 block mb-1">GitHub repo (name or owner/repo)</label>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="my-shop"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none mb-2"
            />
            <label className="text-xs text-slate-400 block mb-1">Branch</label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none mb-3"
            />

            <button
              onClick={deploy}
              disabled={loading || !status?.githubConnected}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />} Deploy now
            </button>
            {status && !status.githubConnected && (
              <p className="text-xs text-amber-300 mt-2">Connect GitHub first (header button) or set GITHUB_TOKEN — then one click deploys.</p>
            )}

            {job && (
              <div className="mt-4 border border-slate-700 rounded-xl p-3">
                <p className="text-sm text-white font-semibold flex items-center gap-2">
                  {job.stage === 'live' ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : job.stage === 'error' ? <AlertCircle className="w-4 h-4 text-rose-400" /> : <Loader2 className="w-4 h-4 animate-spin text-sky-400" />}
                  {stageLabel[job.stage] || job.stage}
                </p>
                <p className="text-xs text-slate-400 mt-1">{job.message}</p>
                {job.liveUrl && (
                  <div className="mt-2 flex items-center gap-2">
                    <a href={job.liveUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-300 underline flex items-center gap-1 break-all">
                      {job.liveUrl} <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                    <button
                      onClick={() => { navigator.clipboard.writeText(job.liveUrl!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                      className="p-1 text-slate-400 hover:text-white"
                      title="Copy live URL"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    {copied && <span className="text-[11px] text-emerald-400">Copied</span>}
                  </div>
                )}
                {job.repoUrl && <a href={job.repoUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-300 underline block mt-1">View repo on GitHub</a>}
                {job.stage === 'setup-needed' && job.setupNeeded && (
                  <div className="mt-2">
                    <p className="text-xs text-amber-300 font-semibold mb-1">One-time setup still needed:</p>
                    <ol className="text-xs text-slate-300 list-decimal list-inside space-y-1">
                      {job.setupNeeded.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  </div>
                )}
                {job.error && <p className="text-xs text-rose-400 mt-2">{job.error}</p>}
              </div>
            )}
            {error && <p className="text-xs text-rose-400 mt-3 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {error}</p>}
          </div>
        </div>
      )}
    </>
  );
};
