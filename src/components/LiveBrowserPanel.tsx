import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Hand, Bot, X, RefreshCw, AlertTriangle, MousePointerClick, Keyboard, Maximize2, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

export interface LiveBrowserSession {
  id: string;
  url?: string;
}

interface LiveBrowserPanelProps {
  /** Agent-started (or user-started) live session; null = no session yet. */
  session: LiveBrowserSession | null;
  onSessionChange: (session: LiveBrowserSession | null) => void;
  /** Called when the user takes over — the parent stops the agent turn. */
  onTakeOver: () => void;
  /** True while an agent turn is running (Send/Stop state). */
  isAgentRunning: boolean;
  /** 'full' = the Browser tab; 'mini' = compact inline panel inside chat. */
  variant?: 'full' | 'mini';
  /** Mini only: open the full Browser tab (same session). */
  onExpand?: () => void;
  /** Mini only: hide the mini panel (the session keeps running). */
  onCollapse?: () => void;
}

type StreamStatus = 'idle' | 'connecting' | 'live' | 'error';

async function postLive(path: string, body: any): Promise<any> {
  const res = await fetch(`/api/browser/live/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Live browser ${path} failed (${res.status})`);
  return json;
}

/**
 * Live Browser tab — a Muse-like screencast of the shared live page.
 * Frames arrive over SSE from /api/browser/live/stream (the server relays
 * the worker's frames); pointer/keyboard input goes back through
 * /api/browser/live/input, scaled to the page viewport. "Take over" pauses
 * the worker session AND stops the agent turn (via onTakeOver); "Give back
 * to agent" resumes the session so the next agent message can drive it.
 */
export const LiveBrowserPanel: React.FC<LiveBrowserPanelProps> = ({
  session,
  onSessionChange,
  onTakeOver,
  isAgentRunning,
  variant = 'full',
  onExpand,
  onCollapse,
}) => {
  const [frame, setFrame] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [typeText, setTypeText] = useState('');
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const hadFrameRef = useRef(false);

  // (Re)connect the screencast stream whenever the session changes.
  useEffect(() => {
    setFrame(null);
    setFrameSize(null);
    hadFrameRef.current = false;
    setTakenOver(false);
    setErrorMsg(null);
    if (!session?.id) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');
    setUrlInput(session.url || '');
    const es = new EventSource(`/api/browser/live/stream?sessionId=${encodeURIComponent(session.id)}`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'frame' && data.image) {
          hadFrameRef.current = true;
          setFrame(data.image);
          if (data.width && data.height) setFrameSize({ w: data.width, h: data.height });
          setStatus('live');
          setErrorMsg(null);
        } else if (data.type === 'error') {
          setStatus('error');
          setErrorMsg(String(data.error || 'Live stream failed.'));
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; only surface an error if no frame
      // ever arrived, otherwise keep showing the last frame.
      if (!hadFrameRef.current) {
        setStatus('error');
        setErrorMsg('Could not connect to the live browser stream. Is the browser worker running?');
      }
    };
    return () => es.close();
  }, [session?.id]);

  const sendInput = useCallback(async (event: Record<string, any>) => {
    if (!session?.id) return;
    try {
      await postLive('input', { sessionId: session.id, ...event });
    } catch (err) {
      console.warn('Live browser input failed:', err);
    }
  }, [session?.id]);

  // While the agent is driving, only Take over unlocks user input — the
  // user's clicks must never race the agent's tool calls on the same page.
  const userInputLocked = !takenOver && isAgentRunning;

  // Scale a click inside the displayed frame to page-viewport coordinates.
  const handleFrameMouseDown = (e: React.MouseEvent) => {
    if (!session?.id || userInputLocked) return;
    const rect = frameWrapRef.current?.getBoundingClientRect();
    const img = imgRef.current;
    if (!rect || !img) return;
    const vw = frameSize?.w || img.naturalWidth || rect.width;
    const vh = frameSize?.h || img.naturalHeight || rect.height;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * vw);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * vh);
    void sendInput({ type: 'click', x, y, button: e.button === 2 ? 'right' : 'left' });
  };

  const handleFrameKeyDown = (e: React.KeyboardEvent) => {
    if (!session?.id || userInputLocked) return;
    // The focused frame is a remote desktop: keys go to the live page.
    e.preventDefault();
    void sendInput({ type: 'key', key: e.key });
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!session?.id || userInputLocked) return;
    // Include the pointer position — the worker wheels at x/y.
    const rect = frameWrapRef.current?.getBoundingClientRect();
    const img = imgRef.current;
    let x = 683;
    let y = 384;
    if (rect && img) {
      const vw = frameSize?.w || img.naturalWidth || rect.width;
      const vh = frameSize?.h || img.naturalHeight || rect.height;
      x = Math.round(((e.clientX - rect.left) / rect.width) * vw);
      y = Math.round(((e.clientY - rect.top) / rect.height) * vh);
    }
    void sendInput({ type: 'scroll', x, y, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
  };

  const handleGo = async () => {
    const url = urlInput.trim();
    if (!url) return;
    setStarting(true);
    setErrorMsg(null);
    try {
      if (session?.id) {
        await postLive('action', { sessionId: session.id, action: 'goto', url });
        onSessionChange({ id: session.id, url });
      } else {
        const started = await postLive('start', { url });
        onSessionChange({ id: started.sessionId, url: started.url || url });
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not open that URL in the live browser.');
    } finally {
      setStarting(false);
    }
  };

  const handleTakeOver = async () => {
    if (!session?.id) return;
    setBusy(true);
    try {
      // Pause the worker session so the agent cannot act on it while the
      // user drives. If the worker does not support pause yet, the agent
      // turn is still stopped below — that is the part that must not fail.
      await postLive('action', { sessionId: session.id, action: 'pause' });
    } catch (err) {
      console.warn('Live browser pause failed (agent turn is still stopped):', err);
    } finally {
      setBusy(false);
    }
    setTakenOver(true);
    onTakeOver();
  };

  const handleGiveBack = async () => {
    if (!session?.id) return;
    setBusy(true);
    try {
      await postLive('action', { sessionId: session.id, action: 'resume' });
    } catch (err) {
      console.warn('Live browser resume failed:', err);
    } finally {
      setBusy(false);
    }
    setTakenOver(false);
  };

  const handleClose = async () => {
    if (!session?.id) return;
    try {
      await postLive('close', { sessionId: session.id });
    } catch {
      /* closing a dead session is fine */
    }
    onSessionChange(null);
  };

  const handleType = async () => {
    if (!typeText || userInputLocked) return;
    await sendInput({ type: 'type', text: typeText });
    setTypeText('');
  };

  // --- MINI variant: compact inline panel inside the chat view. Same
  // session, same SSE stream, same input handlers as the full tab — only
  // the layout is smaller. Only one variant is ever mounted at a time
  // (chat tab renders mini, Browser tab renders full), so the stream is
  // never duplicated and opening the mini panel never starts a second
  // session. Fixed small height so the chat input is never crowded.
  if (variant === 'mini') {
    return (
      <div className="bg-[#0b0e14] border border-slate-800 rounded-2xl overflow-hidden">
        {/* Compact header: status + URL + takeover + expand/collapse/close */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-800">
          <span className={cn(
            "w-1.5 h-1.5 rounded-full flex-shrink-0",
            status === 'live' ? "bg-emerald-400 animate-pulse" :
            status === 'error' ? "bg-rose-400" : "bg-slate-400 animate-pulse"
          )} />
          <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300" title={session?.url}>
            {session?.url || 'Live browser'}
          </span>
          <span className="text-[10px] text-slate-500 flex-shrink-0 hidden sm:inline">
            {status === 'live' ? (takenOver ? 'You are driving' : 'Live')
              : status === 'error' ? 'Stream error' : 'Connecting…'}
          </span>
          {session && !takenOver && (
            <button
              onClick={() => void handleTakeOver()}
              disabled={busy}
              className="px-2 py-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black rounded-md text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer flex-shrink-0"
              title="Pause the agent and drive the browser yourself"
            >
              <Hand className="w-3 h-3" />
              <span className="hidden sm:inline">Take over</span>
            </button>
          )}
          {session && takenOver && (
            <button
              onClick={() => void handleGiveBack()}
              disabled={busy}
              className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-md text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer flex-shrink-0"
              title="Resume the session so the agent can drive it again"
            >
              <Bot className="w-3 h-3" />
              <span className="hidden sm:inline">Give back</span>
            </button>
          )}
          <button
            onClick={() => onExpand?.()}
            className="p-1 text-slate-400 hover:text-white rounded-md transition-colors cursor-pointer flex-shrink-0"
            title="Open the full Browser tab (same session)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onCollapse?.()}
            className="p-1 text-slate-400 hover:text-white rounded-md transition-colors cursor-pointer flex-shrink-0"
            title="Hide the mini browser — the session keeps running, chat stays as is"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {session && (
            <button
              onClick={() => void handleClose()}
              className="p-1 text-slate-400 hover:text-white rounded-md transition-colors cursor-pointer flex-shrink-0"
              title="Close live session"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Compact screencast — fixed small height, same click/key/wheel input */}
        <div
          ref={frameWrapRef}
          tabIndex={0}
          onMouseDown={handleFrameMouseDown}
          onKeyDown={handleFrameKeyDown}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          className="h-44 sm:h-56 flex items-center justify-center overflow-hidden outline-none focus:ring-1 focus:ring-indigo-500/50"
          title={session ? (takenOver ? 'You are driving — click / type to control the page' : 'Agent is driving — click Take over to drive it yourself') : 'No live browser session'}
        >
          {!session && (
            <p className="text-slate-500 text-xs px-4 text-center">No live browser session yet.</p>
          )}
          {session && status === 'connecting' && !frame && (
            <div className="text-center">
              <RefreshCw className="w-5 h-5 text-slate-500 mx-auto mb-1 animate-spin" />
              <p className="text-slate-400 text-[11px]">Connecting…</p>
            </div>
          )}
          {session && status === 'error' && !frame && (
            <div className="text-center px-4">
              <AlertTriangle className="w-6 h-6 text-rose-400 mx-auto mb-1" />
              <p className="text-slate-500 text-[11px]">{errorMsg || 'Live stream unavailable.'}</p>
            </div>
          )}
          {frame && (
            <img
              ref={imgRef}
              src={frame}
              alt="Live browser"
              draggable={false}
              className="max-w-full max-h-full object-contain select-none"
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0b0e14]">
      {/* Toolbar: URL bar + takeover controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 flex-shrink-0 flex-wrap">
        <Globe className="w-4 h-4 text-slate-400 flex-shrink-0" />
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleGo(); }}
          placeholder="https://example.com — open in the live browser"
          spellCheck={false}
          className="flex-1 min-w-[160px] bg-[#131722] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400"
        />
        <button
          onClick={() => void handleGo()}
          disabled={starting || !urlInput.trim()}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer"
        >
          {starting ? 'Opening…' : session ? 'Go' : 'Start browsing'}
        </button>
        {session && !takenOver && (
          <button
            onClick={() => void handleTakeOver()}
            disabled={busy}
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Pause the agent and drive the browser yourself"
          >
            <Hand className="w-3.5 h-3.5" />
            Take over
          </button>
        )}
        {session && takenOver && (
          <button
            onClick={() => void handleGiveBack()}
            disabled={busy}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Resume the session so the agent can drive it again on your next message"
          >
            <Bot className="w-3.5 h-3.5" />
            Give back to agent
          </button>
        )}
        {session && (
          <button
            onClick={() => void handleClose()}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
            title="Close live session"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {session && (
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold",
            status === 'live' ? "bg-emerald-500/10 text-emerald-400" :
            status === 'error' ? "bg-rose-500/10 text-rose-400" :
            "bg-slate-500/10 text-slate-400"
          )}>
            <span className={cn("w-1.5 h-1.5 rounded-full", status === 'live' ? "bg-emerald-400 animate-pulse" : status === 'error' ? "bg-rose-400" : "bg-slate-400 animate-pulse")} />
            {status === 'live' ? (takenOver ? 'You are driving' : 'Live') : status === 'error' ? 'Stream error' : status === 'connecting' ? 'Connecting…' : 'Idle'}
          </span>
        )}
      </div>

      {/* Screencast */}
      <div
        ref={frameWrapRef}
        tabIndex={0}
        onMouseDown={handleFrameMouseDown}
        onKeyDown={handleFrameKeyDown}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
        className="flex-1 min-h-0 flex items-center justify-center overflow-hidden outline-none focus:ring-1 focus:ring-indigo-500/50"
        title={session ? (takenOver ? 'You are driving — click / type to control the page' : 'Agent is driving — click Take over to drive it yourself') : 'Start a live browser session above'}
      >
        {!session && (
          <div className="text-center px-6 max-w-md">
            <MousePointerClick className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-300 text-sm font-semibold mb-1">No live browser session yet</p>
            <p className="text-slate-500 text-xs leading-relaxed">
              Ask the agent to open a page (“open example.com in the browser and click through it”),
              or paste a URL above and start browsing yourself. The agent and you share the same live page.
            </p>
          </div>
        )}
        {session && status === 'connecting' && !frame && (
          <div className="text-center">
            <RefreshCw className="w-6 h-6 text-slate-500 mx-auto mb-2 animate-spin" />
            <p className="text-slate-400 text-xs">Connecting to the live browser…</p>
          </div>
        )}
        {session && status === 'error' && !frame && (
          <div className="text-center px-6 max-w-md">
            <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto mb-2" />
            <p className="text-slate-300 text-sm font-semibold mb-1">Live stream unavailable</p>
            <p className="text-slate-500 text-xs leading-relaxed">{errorMsg || 'The browser worker did not return frames.'}</p>
          </div>
        )}
        {frame && (
          <img
            ref={imgRef}
            src={frame}
            alt="Live browser"
            draggable={false}
            className="max-w-full max-h-full object-contain select-none"
          />
        )}
      </div>

      {/* Bottom bar: type box + hints */}
      {session && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-800 flex-shrink-0 flex-wrap">
          <Keyboard className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <input
            value={typeText}
            onChange={(e) => setTypeText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleType(); }}
            placeholder="Type into the page…"
            spellCheck={false}
            disabled={takenOver === false && isAgentRunning}
            className="flex-1 min-w-[140px] bg-[#131722] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-400 disabled:opacity-50"
          />
          <button
            onClick={() => void handleType()}
            disabled={!typeText || userInputLocked}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            Type
          </button>
          <span className="text-[11px] text-slate-500">
            {takenOver
              ? 'You are driving — click the page, scroll, or use your keyboard (focus the frame first).'
              : isAgentRunning
                ? 'Agent is driving — Take over to click/type yourself.'
                : 'Click the frame to focus it, then type — or Take over to drive.'}
          </span>
        </div>
      )}
    </div>
  );
};
