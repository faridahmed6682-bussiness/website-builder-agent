// GitHub one-click connect — AI Studio-style authorize flow + PAT fallback.
//
// First click starts the GitHub OAuth authorize flow (needs a free GitHub
// OAuth App registered once — see README; env GITHUB_OAUTH_CLIENT_ID /
// GITHUB_OAUTH_CLIENT_SECRET). If no OAuth App is configured, the same button
// offers a one-time PAT paste (fine-grained, repo scope). The token is stored
// encrypted server-side (AES-256-GCM) — never in code, logs or chat — and
// Disconnect actually revokes (OAuth) / deletes (PAT) it.
import React, { useState, useEffect } from 'react';
import { Github, X, Loader2, CheckCircle, AlertCircle, LogOut } from 'lucide-react';

interface Connection {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  source?: 'oauth' | 'pat' | 'env';
}

export const GitHubConnectButton: React.FC = () => {
  const [conn, setConn] = useState<Connection | null>(null);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [open, setOpen] = useState(false);
  const [pat, setPat] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch('/api/github/connection');
      setConn(await r.json());
    } catch {}
    try {
      const r = await fetch('/api/github/oauth/config');
      const d = await r.json();
      setOauthConfigured(Boolean(d.configured));
    } catch {}
  };

  useEffect(() => {
    refresh();
    // OAuth callback lands back here as ?github=connected / ?github=error=...
    const params = new URLSearchParams(window.location.search);
    const gh = params.get('github');
    if (gh) {
      if (gh === 'connected') setNotice('GitHub connected — pushes are now one click.');
      else setNotice(`GitHub connect failed: ${gh.replace(/^error=/, '')}`);
      const url = new URL(window.location.href);
      url.searchParams.delete('github');
      window.history.replaceState({}, '', url.toString());
      refresh();
    }
  }, []);

  const connectPat = async () => {
    if (!pat.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/github/connect-pat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pat.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect');
      setPat('');
      setOpen(false);
      setNotice(`Connected as @${data.login}`);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    setLoading(true);
    try {
      await fetch('/api/github/disconnect', { method: 'POST' });
      setConn({ connected: false });
      setNotice('GitHub disconnected.');
    } catch {}
    setLoading(false);
  };

  if (conn?.connected) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 rounded-xl text-xs text-slate-200 border border-slate-700" title={`Connected via ${conn.source}`}>
          {conn.avatarUrl ? <img src={conn.avatarUrl} className="w-4 h-4 rounded-full" alt="" /> : <Github className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">@{conn.login}</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        </span>
        <button onClick={disconnect} disabled={loading} title="Disconnect GitHub" className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg transition-colors">
          <LogOut className="w-3.5 h-3.5" />
        </button>
        {notice && <span className="hidden" />}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setError(null); }}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition-all border border-slate-700"
        title="Connect GitHub — one click, then every push is one click"
      >
        <Github className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Connect GitHub</span>
      </button>
      {notice && (
        <span className="fixed bottom-4 right-4 z-50 px-3 py-2 bg-emerald-600 text-white text-xs rounded-xl shadow-lg" onClick={() => setNotice(null)}>
          {notice}
        </span>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-bold flex items-center gap-2"><Github className="w-5 h-5" /> Connect GitHub</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-slate-400 mb-4 leading-relaxed">
              One click to connect — after that, every push is one click. The token is stored encrypted on the server, never shown anywhere.
            </p>
            {oauthConfigured ? (
              <button
                onClick={() => { window.location.href = '/api/github/oauth/start'; }}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-semibold mb-3"
              >
                Authorize with GitHub
              </button>
            ) : (
              <>
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-3">
                  No GitHub OAuth App is configured on this server yet. Paste a Personal Access Token once (fine-grained, repo scope) — or set GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET and restart for the one-click authorize flow.
                </p>
                <input
                  type="password"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  placeholder="ghp_… / github_pat_… (repo scope)"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none mb-3"
                />
                <button onClick={connectPat} disabled={loading || !pat.trim()} className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />} Connect with token
                </button>
              </>
            )}
            {error && <p className="text-xs text-rose-400 mt-3 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {error}</p>}
            <p className="text-[11px] text-slate-500 mt-4">
              One-time setup: register a free GitHub OAuth App (github.com/settings/developers → OAuth Apps, callback URL = this service URL + /api/github/oauth/callback) OR paste a PAT once. AI Studio ships Google's own OAuth App pre-registered; this agent needs that one 2-minute step.
            </p>
          </div>
        </div>
      )}
    </>
  );
};
