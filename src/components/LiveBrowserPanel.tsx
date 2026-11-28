import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Hand, Bot, X, RefreshCw, AlertTriangle, MousePointerClick, Keyboard, Maximize2, ChevronDown, Plus } from 'lucide-react';
import { cn } from '../lib/utils';

export interface LiveBrowserSession {
  id: string;
  url?: string;
}

/** The worker pool holds 4 browser contexts — a 5th live tab has none. */
export const MAX_LIVE_TABS = 4;

const POOL_FULL_MSG = 'The live browser already has 4 tabs open — close a tab first, then try again.';

interface LiveBrowserPanelProps {
  /** Live tabs open in the panel (max 4); [] = no session yet. */
  tabs: LiveBrowserSession[];
  /** Which tab is visible. */
  activeTabId: string | null;
  onTabsChange: (tabs: LiveBrowserSession[]) => void;
  onActiveTabChange: (id: string | null) => void;
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

/** Short tab label: the site's hostname, else "Tab N". */
function tabTitle(tab: LiveBrowserSession, index: number): string {
  try {
    const host = new URL(tab.url || '').hostname.replace(/^www\./, '');
    if (host) return host;
  } catch { /* fall through */ }
  return tab.url ? tab.url.slice(0, 18) : `Tab ${index + 1}`;
}

/**
 * Live Browser tab — a Muse-like screencast of the shared live pages, now
 * with up to 4 tabs. Only the ACTIVE tab streams frames (one EventSource
 * at a time, same load as the old single tab); switching tabs reconnects
 * the stream and the first frame arrives immediately. Each tab keeps its
 * own session, URL and Take over state; closing a tab closes its worker
 * session. "Take over" pauses the active tab's worker session AND stops
 * the agent turn (via onTakeOver); "Give back to agent" resumes it so the
 * next agent message can drive it. The agent drives ONE tab at a time —
 * it acts on a tab, then the next (round-robin), never two at once.
 */
export const LiveBrowserPanel: React.FC<LiveBrowserPanelProps> = ({
  tabs,
  activeTabId,
  onTabsChange,
  onActiveTabChange,
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
  // Take over is per tab — the worker pauses sessions individually.
  const [takenOverById, setTakenOverById] = useState<Record<string, boolean>>({});
  const [urlInput, setUrlInput] = useState('');
  const [typeText, setTypeText] = useState('');
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const frameWrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const hadFrameRef = useRef(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const takenOver = activeTabId ? Boolean(takenOverById[activeTabId]) : false;

  // Keep the URL bar in step with the active tab (agent navigations too).
  const activeTabUrl = activeTab?.url || '';
  useEffect(() => {
    setUrlInput(activeTabUrl);
  }, [activeTabId, activeTabUrl]);

  // (Re)connect the screencast stream for the ACTIVE tab only, whenever it
  // changes. Inactive tabs fetch no frames.
  useEffect(() => {
    setFrame(null);
    setFrameSize(null);
    hadFrameRef.current = false;
    setErrorMsg(null);
    if (!activeTabId) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(`/api/browser/live/stream?sessionId=${encodeURIComponent(activeTabId)}`);
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
  }, [activeTabId]);

  const sendInput = useCallback(async (event: Record<string, any>) => {
    if (!activeTabId) return;
    try {
      await postLive('input', { sessionId: activeTabId, ...event });
    } catch (err) {
      console.warn('Live browser input failed:', err);
    }
  }, [activeTabId]);

  // While the agent is driving, only Take over unlocks user input — the
  // user's clicks must never race the agent's tool calls on the same page.
  const userInputLocked = !takenOver && isAgentRunning;

  // Scale a click inside the displayed frame to page-viewport coordinates.
  const handleFrameMouseDown = (e: React.MouseEvent) => {
    if (!activeTabId || userInputLocked) return;
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
    if (!activeTabId || userInputLocked) return;
    // The focused frame is a remote desktop: keys go to the live page.
    e.preventDefault();
    void sendInput({ type: 'key', key: e.key });
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!activeTabId || userInputLocked) return;
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
      if (activeTab) {
        await postLive('action', { sessionId: activeTab.id, action: 'goto', url });
        onTabsChange(tabs.map((t) => (t.id === activeTab.id ? { ...t, url } : t)));
      } else {
        const started = await postLive('start', { url });
        const tab = { id: started.sessionId, url: started.url || url };
        onTabsChange([...tabs, tab]);
        onActiveTabChange(tab.id);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not open that URL in the live browser.');
    } finally {
      setStarting(false);
    }
  };

  const handleNewTab = async () => {
    // Refuse the 5th tab up front — the worker pool holds 4 contexts.
    if (tabs.length >= MAX_LIVE_TABS) {
      setErrorMsg(POOL_FULL_MSG);
      return;
    }
    setStarting(true);
    setErrorMsg(null);
    try {
      const url = urlInput.trim() || undefined;
      const started = await postLive('start', { ...(url ? { url } : {}) });
      const tab = { id: started.sessionId, url: started.url || url };
      onTabsChange([...tabs, tab]);
      onActiveTabChange(tab.id);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not open a new live tab.');
    } finally {
      setStarting(false);
    }
  };

  const handleTakeOver = async () => {
    if (!activeTabId) return;
    setBusy(true);
    try {
      // Pause the worker session so the agent cannot act on it while the
      // user drives. If the worker does not support pause yet, the agent
      // turn is still stopped below — that is the part that must not fail.
      await postLive('action', { sessionId: activeTabId, action: 'pause' });
    } catch (err) {
      console.warn('Live browser pause failed (agent turn is still stopped):', err);
    } finally {
      setBusy(false);
    }
    setTakenOverById((prev) => ({ ...prev, [activeTabId]: true }));
    onTakeOver();
  };

  const handleGiveBack = async () => {
    if (!activeTabId) return;
    setBusy(true);
    try {
      await postLive('action', { sessionId: activeTabId, action: 'resume' });
    } catch (err) {
      console.warn('Live browser resume failed:', err);
    } finally {
      setBusy(false);
    }
    setTakenOverById((prev) => ({ ...prev, [activeTabId]: false }));
  };

  const handleCloseTab = async (id: string) => {
    try {
      await postLive('close', { sessionId: id });
    } catch {
      /* closing a dead session is fine */
    }
    const remaining = tabs.filter((t) => t.id !== id);
    setTakenOverById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    onTabsChange(remaining);
    if (activeTabId === id) {
      // Activate the tab to the left, else the new first tab, else none.
      const idx = tabs.findIndex((t) => t.id === id);
      const nextActive = remaining[Math.max(0, idx - 1)] || null;
      onActiveTabChange(nextActive ? nextActive.id : null);
    }
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
          <span className="flex-1 min-w-0 truncate text-[11px] text-slate-300" title={activeTab?.url}>
            {activeTab?.url || 'Live browser'}
          </span>
          <span className="text-[10px] text-slate-500 flex-shrink-0 hidden sm:inline">
            {status === 'live' ? (takenOver ? 'You are driving' : 'Live')
              : status === 'error' ? 'Stream error' : 'Connecting…'}
          </span>
          {activeTab && !takenOver && (
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
          {activeTab && takenOver && (
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
          {activeTab && (
            <button
              onClick={() => { if (activeTab) void handleCloseTab(activeTab.id); }}
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
          title={activeTab ? (takenOver ? 'You are driving — click / type to control the page' : 'Agent is driving — click Take over to drive it yourself') : 'No live browser session'}
        >
          {!activeTab && (
            <p className="text-slate-500 text-xs px-4 text-center">No live browser session yet.</p>
          )}
          {activeTab && status === 'connecting' && !frame && (
            <div className="text-center">
              <RefreshCw className="w-5 h-5 text-slate-500 mx-auto mb-1 animate-spin" />
              <p className="text-slate-400 text-[11px]">Connecting…</p>
            </div>
          )}
          {activeTab && status === 'error' && !frame && (
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
      {/* Tab strip: one chip per live tab + new-tab button (max 4). */}
      <div className="flex items-center gap-1 px-2 pt-2 flex-shrink-0 overflow-x-auto">
        {tabs.map((tab, i) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onActiveTabChange(tab.id)}
              className={cn(
                "flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-t-lg text-xs cursor-pointer border border-b-0 flex-shrink-0",
                isActive ? "bg-[#131722] text-white border-slate-700" : "text-slate-400 hover:text-slate-200 border-transparent"
              )}
              title={tab.url || `Tab ${i + 1}`}
            >
              <Globe className="w-3 h-3 flex-shrink-0" />
              <span className="max-w-[110px] truncate">{tabTitle(tab, i)}</span>
              {takenOverById[tab.id] && <Hand className="w-3 h-3 text-amber-400 flex-shrink-0" />}
              <button
                onClick={(e) => { e.stopPropagation(); void handleCloseTab(tab.id); }}
                className="p-0.5 text-slate-500 hover:text-white rounded transition-colors cursor-pointer"
                title="Close this tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
        <button
          onClick={() => void handleNewTab()}
          disabled={starting || tabs.length >= MAX_LIVE_TABS}
          className="p-1.5 text-slate-400 hover:text-white disabled:opacity-40 rounded-lg transition-colors cursor-pointer flex-shrink-0"
          title={tabs.length >= MAX_LIVE_TABS ? POOL_FULL_MSG : 'Open a new live tab'}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        {tabs.length >= MAX_LIVE_TABS && (
          <span className="text-[11px] text-slate-500 ml-1 flex-shrink-0">4 tabs max — close one to open another</span>
        )}
      </div>

      {/* Toolbar: URL bar + takeover controls (for the active tab) */}
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
          {starting ? 'Opening…' : activeTab ? 'Go' : 'Start browsing'}
        </button>
        {activeTab && !takenOver && (
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
        {activeTab && takenOver && (
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
        {activeTab && (
          <button
            onClick={() => void handleCloseTab(activeTab.id)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
            title="Close this live tab"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {activeTab && (
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

      {/* Screencast (active tab only) */}
      <div
        ref={frameWrapRef}
        tabIndex={0}
        onMouseDown={handleFrameMouseDown}
        onKeyDown={handleFrameKeyDown}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
        className="flex-1 min-h-0 flex items-center justify-center overflow-hidden outline-none focus:ring-1 focus:ring-indigo-500/50"
        title={activeTab ? (takenOver ? 'You are driving — click / type to control the page' : 'Agent is driving — click Take over to drive it yourself') : 'Start a live browser session above'}
      >
        {!activeTab && (
          <div className="text-center px-6 max-w-md">
            <MousePointerClick className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-300 text-sm font-semibold mb-1">No live browser tab yet</p>
            <p className="text-slate-500 text-xs leading-relaxed">
              Ask the agent to open pages (“open example.com and wikipedia.org in the browser”),
              or paste a URL above and start browsing yourself. The agent and you share the same live tabs — up to 4 at once.
              The agent works one tab at a time and switches between your open tabs as you ask it to.
            </p>
          </div>
        )}
        {activeTab && status === 'connecting' && !frame && (
          <div className="text-center">
            <RefreshCw className="w-6 h-6 text-slate-500 mx-auto mb-2 animate-spin" />
            <p className="text-slate-400 text-xs">Connecting to the live browser…</p>
          </div>
        )}
        {activeTab && status === 'error' && !frame && (
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
      {activeTab && (
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
