// Connect Firebase (one-time) + Add Firebase to this project (one click).
//
// HONEST SETUP: the agent cannot create a Firebase project inside the user's
// Google account by itself. First time, the user connects once — paste the
// Firebase web config JSON or a google-services.json (stored encrypted,
// never in code/logs, never shown). The config is validated and the key is
// tested (Identity Toolkit probe) before it is stored. After that single
// connect, every project gets Firebase in one click (SDK + Auth + Firestore
// wired into the built app). Free Spark plan, no card needed.
import React, { useState, useEffect } from 'react';
import { Flame, X, Loader2, AlertCircle, CheckCircle, LogOut, CloudUpload } from 'lucide-react';

export const FirebaseConnectButton: React.FC = () => {
  const [conn, setConn] = useState<{ connected: boolean; projectId?: string; authDomain?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch('/api/firebase/connection');
      setConn(await r.json());
    } catch {}
  };

  useEffect(() => { refresh(); }, []);

  const connect = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      let payload: any = null;
      const parsed = JSON.parse(text.trim());
      if (parsed.project_info || parsed.client) payload = { googleServices: parsed };
      else payload = { config: parsed };
      const res = await fetch('/api/firebase/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to connect');
      setOpen(false);
      setText('');
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
      await fetch('/api/firebase/disconnect', { method: 'POST' });
      setConn({ connected: false });
    } catch {}
    setLoading(false);
  };

  if (conn?.connected) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 rounded-xl text-xs text-slate-200 border border-slate-700" title="Firebase connected">
          <Flame className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden sm:inline">{conn.projectId}</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        </span>
        <button onClick={disconnect} disabled={loading} title="Disconnect Firebase" className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg transition-colors">
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setError(null); }}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition-all border border-slate-700"
        title="Connect Firebase — one time, then every project gets Firebase in one click"
      >
        <Flame className="w-3.5 h-3.5 text-amber-400" />
        <span className="hidden sm:inline">Connect Firebase</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-bold flex items-center gap-2"><Flame className="w-5 h-5 text-amber-400" /> Connect Firebase</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              Paste your Firebase web config (Project settings → Your apps → Web app → firebaseConfig) or the whole google-services.json. It is validated + tested, then stored encrypted on the server. The API key is never shown or logged.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{"apiKey": "AIza…", "authDomain": "…", "projectId": "…"}'
              rows={7}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none font-mono mb-3"
            />
            <button onClick={connect} disabled={loading || !text.trim()} className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
              {loading && <Loader2 className="w-4 h-4 animate-spin" />} Validate &amp; connect
            </button>
            {error && <p className="text-xs text-rose-400 mt-3 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {error}</p>}
            <p className="text-[11px] text-slate-500 mt-4">
              The agent cannot create a Firebase project inside your Google account — create it once at console.firebase.google.com (free Spark plan, no card), then connect here. After that, “Add Firebase” works in one click per project.
            </p>
          </div>
        </div>
      )}
    </>
  );
};

export const AddFirebaseButton: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [hosting, setHosting] = useState<'idle' | 'working' | 'done' | 'setup-needed' | 'error'>('idle');
  const [hostingMsg, setHostingMsg] = useState('');

  const add = async () => {
    setState('working');
    setMsg('');
    try {
      const res = await fetch('/api/firebase/add-to-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add Firebase');
      setState('done');
      setMsg(`Firebase wired into this project (${(data.files || []).join(', ')}).${data.needsInstall ? ' Run npm install in the project to install the Firebase SDK.' : ''}`);
    } catch (e: any) {
      setState('error');
      setMsg(e.message);
    }
  };

  const deployHosting = async () => {
    setHosting('working');
    setHostingMsg('');
    try {
      const res = await fetch('/api/firebase/deploy-hosting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId || undefined }),
      });
      const data = await res.json();
      if (data.status === 'setup-needed') {
        setHosting('setup-needed');
        setHostingMsg((data.steps || []).join(' '));
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Hosting deploy failed');
      setHosting('done');
      setHostingMsg(data.liveUrl ? `Live on Firebase Hosting: ${data.liveUrl}` : 'Deployed to Firebase Hosting.');
    } catch (e: any) {
      setHosting('error');
      setHostingMsg(e.message);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={add}
        disabled={state === 'working' || !sessionId}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 rounded-xl text-xs font-semibold transition-all border border-amber-500/30 disabled:opacity-50"
        title="Wire Firebase (Auth + Firestore) into the current project"
      >
        <Flame className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Add Firebase</span>
      </button>
      {state === 'done' && (
        <button onClick={deployHosting} disabled={hosting === 'working'} className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-sky-300 hover:text-sky-200">
          <CloudUpload className="w-3 h-3" /> Deploy to Firebase Hosting
        </button>
      )}
      {msg && (
        <span className={`text-[11px] ${state === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>{msg}</span>
      )}
      {hostingMsg && (
        <span className={`text-[11px] ${hosting === 'error' || hosting === 'setup-needed' ? 'text-amber-300' : 'text-emerald-400'}`}>{hostingMsg}</span>
      )}
    </div>
  );
};
