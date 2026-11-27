import React, { useState, useEffect } from 'react';
import { X, Github, CheckCircle, AlertCircle, Loader2, RefreshCw, GitCommit, ExternalLink } from 'lucide-react';

interface GitHubSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const GitHubSyncModal: React.FC<GitHubSyncModalProps> = ({ isOpen, onClose }) => {
  const [token, setToken] = useState('');
  const [user, setUser] = useState<any>(null);
  const [repo, setRepo] = useState('');
  const [commitMessage, setCommitMessage] = useState('feat: update project via Nexus AI');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/github/status')
        .then(res => res.json())
        .then(data => {
          if (data.configured) {
            setUser(data.user);
            setRepo(data.repo || '');
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleVerify = async () => {
    if (!token.trim()) return;
    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const res = await fetch('/api/github/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        setUser(data.user);
        setStatusMessage(`Connected as @${data.user.login}`);
      } else {
        setIsError(true);
        setStatusMessage(data.error || 'Failed to verify token');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSync = async () => {
    if (!repo.trim()) {
      setIsError(true);
      setStatusMessage('Please specify a repository (owner/repo)');
      return;
    }
    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const res = await fetch('/api/github/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim() || undefined,
          repo: repo.trim(),
          message: commitMessage.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage(`Successfully synced with ${repo}!`);
      } else {
        setIsError(true);
        setStatusMessage(data.error || 'Failed to sync with GitHub');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-slate-800 text-white flex items-center justify-center border border-slate-700">
              <Github className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">GitHub Synchronization</h3>
              <p className="text-[11px] text-slate-400">Push, commit, and auto-sync changes to GitHub</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs">
          {user ? (
            <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex items-center gap-3">
              <img src={user.avatar_url} alt={user.login} className="w-10 h-10 rounded-full border border-slate-700" />
              <div className="flex-1">
                <div className="font-bold text-white flex items-center gap-1.5">
                  <span>{user.name || user.login}</span>
                  <span className="text-slate-400 font-normal">(@{user.login})</span>
                </div>
                <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  <span>Authenticated</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-slate-300 font-medium block">Personal Access Token (PAT):</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={handleVerify}
                  disabled={isLoading || !token}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5"
                >
                  {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Connect</span>}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-slate-300 font-medium block">Repository Name (owner/repo):</label>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="username/my-nexus-app"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="space-y-2">
            <label className="text-slate-300 font-medium block">Commit Message:</label>
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
            />
          </div>

          {statusMessage && (
            <div className={`p-3 rounded-xl border flex items-center gap-2 text-[11px] ${
              isError ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            }`}>
              {isError ? <AlertCircle className="w-4 h-4 flex-shrink-0" /> : <CheckCircle className="w-4 h-4 flex-shrink-0" />}
              <span>{statusMessage}</span>
            </div>
          )}

          <div className="pt-2 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium"
            >
              Close
            </button>
            <button
              onClick={handleSync}
              disabled={isLoading || !repo}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5"
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommit className="w-3.5 h-3.5" />}
              <span>Commit & Push</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
