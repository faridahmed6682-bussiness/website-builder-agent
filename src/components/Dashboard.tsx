// ONE UNIFIED DASHBOARD — Build/Chat is the main view; this panel is the
// rest: Keys (add/remove Gemini/Groq/OpenRouter provider keys, per-key
// live/limited status) + Usage (requests/tokens per model, cost $0) + Chain
// status (which model/key is serving, failover state) + Projects (reopen,
// continue, edit, redeploy) + Jobs (background jobs).
// The FreeLLMAPI standalone dashboard is not needed day-to-day.
import React, { useState, useEffect, useCallback } from 'react';
import { X, Key, BarChart3, Link2, FolderOpen, Clock, Plus, Trash2, Play, ExternalLink, Loader2 } from 'lucide-react';
import { DeployButton } from './DeployButton';

type Tab = 'keys' | 'usage' | 'chain' | 'projects' | 'jobs';

interface DashboardProps {
  open: boolean;
  onClose: () => void;
  onSelectProject: (sessionId: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ open, onClose, onSelectProject }) => {
  const [tab, setTab] = useState<Tab>('keys');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [keys, setKeys] = useState<any[]>([]);
  const [newProvider, setNewProvider] = useState('gemini');
  const [newKey, setNewKey] = useState('');
  const [usage, setUsage] = useState<any>(null);
  const [chainTask, setChainTask] = useState('coding');
  const [chain, setChain] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobPrompt, setJobPrompt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'keys') {
        const r = await fetch('/api/router/keys');
        const d = await r.json();
        setKeys(d.keys || []);
      } else if (tab === 'usage') {
        const r = await fetch('/api/router/usage');
        setUsage(await r.json());
      } else if (tab === 'chain') {
        const r = await fetch(`/api/models/chain?task=${chainTask}`);
        setChain(await r.json());
      } else if (tab === 'projects') {
        const r = await fetch('/api/projects');
        const d = await r.json();
        setProjects(d.projects || []);
      } else if (tab === 'jobs') {
        const r = await fetch('/api/jobs');
        const d = await r.json();
        setJobs(d.jobs || []);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tab, chainTask]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open || tab !== 'jobs') return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, tab, load]);

  const addKey = async () => {
    if (!newKey.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/router/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: newProvider, key: newKey.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to add key');
      setNewKey('');
      load();
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };

  const removeKey = async (id: string) => {
    await fetch(`/api/router/keys/${id}`, { method: 'DELETE' });
    load();
  };

  const createJob = async () => {
    if (!jobPrompt.trim()) return;
    await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: jobPrompt.trim() }),
    });
    setJobPrompt('');
    load();
  };

  const cancelJob = async (id: string) => {
    await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
    load();
  };

  if (!open) return null;

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'keys', label: 'Keys', icon: <Key className="w-3.5 h-3.5" /> },
    { id: 'usage', label: 'Usage', icon: <BarChart3 className="w-3.5 h-3.5" /> },
    { id: 'chain', label: 'Chain', icon: <Link2 className="w-3.5 h-3.5" /> },
    { id: 'projects', label: 'Projects', icon: <FolderOpen className="w-3.5 h-3.5" /> },
    { id: 'jobs', label: 'Jobs', icon: <Clock className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-white font-bold">Dashboard</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex gap-1 px-5 pt-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === t.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {error && <p className="text-xs text-rose-400 mb-3">{error}</p>}
          {loading && <p className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>}

          {tab === 'keys' && (
            <div>
              <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                Provider keys for the embedded router. Key values are never shown. Env keys (GEMINI_API_KEYS / GROQ_API_KEYS / OPENROUTER_API_KEYS) are read-only here — unset the env var to remove one. Limits are observed (429s), never assumed.
              </p>
              <div className="space-y-2 mb-4">
                {keys.length === 0 && <p className="text-xs text-slate-500">No provider keys yet — add one below or set the env vars.</p>}
                {keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between bg-slate-800 border border-slate-700 rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`w-2 h-2 rounded-full ${k.status === 'live' ? 'bg-emerald-400' : k.status === 'limited' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                      <span className="text-white font-medium">{k.name}</span>
                      <span className="text-slate-400">· {k.provider} · {k.source}</span>
                      <span className="text-slate-400">{k.status === 'live' ? 'live' : k.limitLabel || k.status}{k.retryInSec ? ` (${k.retryInSec}s)` : ''}</span>
                      <span className="text-slate-500">· {k.uses} uses</span>
                    </div>
                    {k.source === 'dashboard' && (
                      <button onClick={() => removeKey(k.id)} className="p-1 text-slate-400 hover:text-rose-400" title="Remove key">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <select value={newProvider} onChange={(e) => setNewProvider(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-xl px-2 py-2 text-xs text-white">
                  <option value="gemini">Gemini</option>
                  <option value="groq">Groq</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
                <input
                  type="password"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="Paste a provider API key…"
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                />
                <button onClick={addKey} disabled={!newKey.trim()} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
            </div>
          )}

          {tab === 'usage' && usage && (
            <div>
              <div className="flex gap-4 text-xs text-slate-300 mb-3">
                <span>Requests: <b className="text-white">{usage.totalRequests}</b></span>
                <span>Total tokens: <b className="text-white">{usage.totalTokens.toLocaleString()}</b></span>
                <span>Cost: <b className="text-emerald-400">$0.00</b> (free tiers only)</span>
              </div>
              {usage.byModel.length === 0 && <p className="text-xs text-slate-500">No LLM usage yet — send a message and it appears here, per model and per step.</p>}
              <div className="space-y-2">
                {usage.byModel.map((m: any) => (
                  <div key={m.model} className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs flex justify-between">
                    <span className="text-white font-mono">{m.model}</span>
                    <span className="text-slate-400">{m.requests} req · {m.promptTokens.toLocaleString()} in / {m.completionTokens.toLocaleString()} out</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-3">Token counts come from the provider when reported; streaming steps report requests only. Per-turn usage (which model served each step) is shown under each chat reply.</p>
            </div>
          )}

          {tab === 'chain' && chain && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-slate-400">Task:</span>
                {['coding', 'planning', 'chat'].map((t) => (
                  <button key={t} onClick={() => setChainTask(t)} className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${chainTask === t ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{t}</button>
                ))}
                <span className="text-xs text-slate-500 ml-2">Catalog: {chain.catalog?.total || 0} live models ({(chain.catalog?.sources || []).join(', ')})</span>
              </div>
              <div className="space-y-2">
                {(chain.chain || []).map((e: any, i: number) => (
                  <div key={e.model} className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs flex justify-between items-center">
                    <span className="text-white font-mono">#{i + 1} {e.model}</span>
                    <span className="text-slate-400">{e.provider} · tier {e.tier} · {e.healthy ? 'healthy' : `limited (${e.limitLabel || e.limitKind || ''})`}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-3">Quality-ordered failover: on 429 / 5xx / timeout the request moves to the next entry, same task, same tier if possible. Hydrogen is first for coding, rotated across all 10 Gemini keys before any fallback.</p>
            </div>
          )}

          {tab === 'projects' && (
            <div>
              {projects.length === 0 && <p className="text-xs text-slate-500">No built projects yet — ask the agent to build a website and it appears here. Projects persist on the server and survive closing the chat.</p>}
              <div className="space-y-2">
                {projects.map((p: any) => (
                  <div key={p.sessionId} className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 flex items-center justify-between gap-2">
                    <div className="text-xs min-w-0">
                      <p className="text-white font-medium truncate">{p.sessionId}</p>
                      <p className="text-slate-400">{p.files} files · updated {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '—'}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => { onSelectProject(p.sessionId); onClose(); }}
                        className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
                      >
                        <Play className="w-3 h-3" /> Open
                      </button>
                      <DeployButton sessionId={p.sessionId} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'jobs' && (
            <div>
              <div className="flex gap-2 mb-4">
                <input
                  value={jobPrompt}
                  onChange={(e) => setJobPrompt(e.target.value)}
                  placeholder='e.g. "Build me a shop website by morning"'
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none"
                />
                <button onClick={createJob} disabled={!jobPrompt.trim()} className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold">Queue job</button>
              </div>
              <p className="text-[11px] text-slate-500 mb-3">Jobs run in the background; the agent works while you do other things. On Render free the service sleeps after 15 min idle, so long jobs need a keep-alive or Termux — see README.</p>
              {jobs.length === 0 && <p className="text-xs text-slate-500">No background jobs yet.</p>}
              <div className="space-y-2">
                {jobs.map((j: any) => (
                  <div key={j.id} className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-white font-medium truncate">{j.prompt}</span>
                      <span className={`shrink-0 px-2 py-0.5 rounded-md ${j.status === 'done' ? 'bg-emerald-500/10 text-emerald-300' : j.status === 'failed' ? 'bg-rose-500/10 text-rose-300' : j.status === 'working' ? 'bg-sky-500/10 text-sky-300' : 'bg-slate-700 text-slate-300'}`}>{j.status}</span>
                    </div>
                    {j.summary && <p className="text-slate-400 mt-1 line-clamp-2">{j.summary}</p>}
                    {j.previewUrl && (
                      <a href={j.previewUrl} target="_blank" rel="noreferrer" className="text-sky-300 underline inline-flex items-center gap-1 mt-1">
                        Preview <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {j.error && <p className="text-rose-400 mt-1">{j.error}</p>}
                    {j.status === 'queued' && (
                      <button onClick={() => cancelJob(j.id)} className="text-slate-400 hover:text-rose-400 mt-1 block">Cancel</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
