/**
 * Nexus AI - Intelligent Builder & Orchestrator
 */
import { useState, useEffect, useRef } from 'react';
import { 
  Send, 
  Bot, 
  User, 
  Globe, 
  RotateCcw, 
  Layout, 
  X,
  Zap,
  Plus,
  Sparkles,
  Code,
  Image as ImageIcon,
  Search,
  Terminal,
  Wrench,
  Github,
  Flame,
  Settings,
  Key,
  Menu,
  PanelLeft,
  RefreshCw,
  Download,
  Monitor,
  Smartphone,
  ExternalLink,
  Copy,
  Check,
  FileCode,
  ShoppingBag,
  BarChart3,
  Gamepad2,
  CheckSquare,
  Briefcase,
  ArrowLeft,
  MoreHorizontal,
  Mic,
  PlusCircle,
  ChevronDown,
  ChevronRight,
  Square,
  ArrowUp,
  CheckCircle2,
  Flag,
  Share2,
  FolderArchive,
  ScrollText,
  ImagePlus,
  LayoutDashboard
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { chatWithAI, KeyMetadata } from './lib/gemini';
import { cn } from './lib/utils';
import { PWAInstallButton } from './components/PWAInstallButton';
import { GitHubConnectButton } from './components/GitHubConnectButton';
import { DeployButton } from './components/DeployButton';
import { FirebaseConnectButton, AddFirebaseButton } from './components/FirebaseConnectButton';
import { Dashboard } from './components/Dashboard';
import { VoiceInput } from './components/VoiceInput';
import { TeamStatus, type AgentStatus } from './components/TeamStatus';
import { OfflineIndicator } from './components/OfflineIndicator';
import { ToolsModal } from './components/ToolsModal';
import { GitHubSyncModal } from './components/GitHubSyncModal';
import { FirebaseModal } from './components/FirebaseModal';
import { SettingsModal } from './components/SettingsModal';
import { SecretsModal } from './components/SecretsModal';
import { LogsModal } from './components/LogsModal';
import { AskQuestionModal, PendingQuestionPrompt } from './components/AskQuestionModal';
import { SidebarDrawer } from './components/SidebarDrawer';
import { GoogleAIStudioCoderView } from './components/GoogleAIStudioCoderView';
import { getLocalKeys, restoreServerKeysFromLocal } from './lib/secretsManager';
import { isStopRequest } from './lib/stopRequest';
import { STATIC_TEMPLATES, type StaticTemplate } from './lib/templates';
import { ActionStep } from './types/secrets';
import { 
  getAllSessions, 
  getSession, 
  saveSession, 
  generateSessionTitle,
  extractHtmlFromChatMessages,
  ChatSession
} from './lib/db';

const STARTER_PROMPTS = [
  {
    icon: Smartphone,
    title: "PWA টাস্ক ও নোটস অ্যাপ",
    badge: "PWA Offline",
    color: "from-indigo-500/20 to-purple-500/20 border-indigo-500/30 text-indigo-300",
    prompt: "একটি পূর্ণাঙ্গ প্রগ্রেসিভ ওয়েব অ্যাপ (PWA) টাস্ক ও নোটস ম্যানেজার বানাও যাতে অফলাইন ক্যাশ, ইনস্টল বাটন (beforeinstallprompt), ফিল্টারিং ও লোকালস্টোরেজ পারসিসটেন্স থাকে।"
  },
  {
    icon: ShoppingBag,
    title: "ই-কমার্স শপিং স্টোর",
    badge: "E-Commerce",
    color: "from-emerald-500/20 to-teal-500/20 border-emerald-500/30 text-emerald-300",
    prompt: "একটি আধুনিক গ্যাজেট ও ফ্যাশন ই-কমার্স স্টোর ওয়েবসাইট তৈরি করো যাতে প্রোডাক্ট ফিল্টারিং, ইন্টারেক্টিভ কার্ট ড্রয়ার, কোড ভ্যালিডেশন ও চেকআউট মডাল থাকে।"
  },
  {
    icon: BarChart3,
    title: "SaaS এনালিটিক্স ড্যাশবোর্ড",
    badge: "Dashboard",
    color: "from-blue-500/20 to-cyan-500/20 border-blue-500/30 text-blue-300",
    prompt: "একটি প্রফেশনাল SaaS বিজনেস অ্যানালিটিক্স ড্যাশবোর্ড তৈরি করো যাতে ইন্টারঅ্যাক্টিভ চার্ট, মেট্রিক কেপিআই কার্ড, ডেটা টেবিল ও ডার্ক থিম থাকে।"
  },
  {
    icon: Gamepad2,
    title: "2D ক্যানভাস স্নেক গেম PWA",
    badge: "Game PWA",
    color: "from-amber-500/20 to-orange-500/20 border-amber-500/30 text-amber-300",
    prompt: "একটি রেট্রো স্নেক / আর্কেড গেম PWA তৈরি করো যাতে স্কোরবোর্ড, হাই-স্কোর লোকালস্টোরেজে সেভ, সাউন্ড ইফেক্ট এবং মোবাইল টাচ কন্ট্রোল থাকে।"
  },
  {
    icon: Briefcase,
    title: "ক্রিয়েটিভ পোর্টফোলিও",
    badge: "Portfolio",
    color: "from-fuchsia-500/20 to-pink-500/20 border-fuchsia-500/30 text-fuchsia-300",
    prompt: "একটি আকর্ষণীয় গ্লাসফর্মিজম ডার্ক পোর্টফোলিও ওয়েবসাইট তৈরি করো যাতে প্রোজেক্ট ফিল্টারিং, স্কিল বার, টেস্টিমোনিয়াল ও রিয়েল-টাইম কন্টাক্ট ফর্ম থাকে।"
  },
  {
    icon: CheckSquare,
    title: "ড্র্যাগ & ড্রপ কানবান বোর্ড",
    badge: "Productivity",
    color: "from-rose-500/20 to-red-500/20 border-rose-500/30 text-rose-300",
    prompt: "একটি ইন্টারঅ্যাক্টিভ ড্র্যাগ-অ্যান্ড-ড্রপ কানবান প্রজেক্ট ম্যানেজমেন্ট ওয়েব অ্যাপ বানাও (To Do, In Progress, Done) যাতে লোকালস্টোরেজে টাস্ক সেভ থাকে।"
  }
];

export default function App() {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Background job running under the current session (Jobs panel, or the
  // agent's queue_job tool). The chat turn's isLoading is FALSE while a job
  // runs, so without this the Send button shows ↑ with no way to stop the
  // work still running on the server (live bug 2026-11-29: the Reviewer
  // step kept spinning while the button showed Send). Polled like the
  // Dashboard's Jobs tab (5 s); filtered to this session only, so another
  // session's job never blocks this chat.
  const [runningJob, setRunningJob] = useState<{ id: string; sessionId: string; status: string } | null>(null);
  const runningJobRef = useRef<{ id: string; sessionId: string; status: string } | null>(null);
  // Step 11: applying a static template never calls a model — it only
  // POSTs the bundled template HTML to /api/tools/file-write.
  const [isApplyingTemplate, setIsApplyingTemplate] = useState(false);
  const [actionLog, setActionLog] = useState<string | null>(null);
  const [activityLogs, setActivityLogs] = useState<string[]>([]);
  const [actionSteps, setActionSteps] = useState<ActionStep[]>([]);
  const [modifiedFiles, setModifiedFiles] = useState<string[]>([]);
  const [showCodePreview, setShowCodePreview] = useState(false);
  const [showToolsModal, setShowToolsModal] = useState(false);
  const [showGitHubModal, setShowGitHubModal] = useState(false);
  const [showFirebaseModal, setShowFirebaseModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSecretsModal, setShowSecretsModal] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [activeKeysCount, setActiveKeysCount] = useState(0);
  const [currentActiveKeyInfo, setCurrentActiveKeyInfo] = useState<KeyMetadata | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // Vision (build from image), team status, usage display, unified dashboard.
  const [attachedImage, setAttachedImage] = useState<{ dataUrl: string; base64: string; mime: string } | null>(null);
  const [teamStatuses, setTeamStatuses] = useState<AgentStatus[]>([]);
  // Team panel visibility: the Multi-Agent button opens it (it stays open
  // during a run, and shows the 4 agents idle when no run is active).
  const [showTeamPanel, setShowTeamPanel] = useState(false);
  const [lastUsage, setLastUsage] = useState<any>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [currentSessionTitle, setCurrentSessionTitle] = useState('Live Canvas');
  const [currentSessionHtml, setCurrentSessionHtml] = useState<string | null>(null);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [previewTab, setPreviewTab] = useState<'canvas' | 'code'>('canvas');
  const [copiedCode, setCopiedCode] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [previewUrl, setPreviewUrl] = useState('/projects/index.html');
  // STEP 13 (P1): set when the last build was served from the build cache
  // (no model call) — shows the "cached build" label + "rebuild anyway".
  const [cachedBuild, setCachedBuild] = useState<{ model?: string; cacheHits?: number } | null>(null);
  const [activeMode, setActiveMode] = useState<'general' | 'coding' | 'image' | 'search'>('coding');
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [activeCoderTab, setActiveCoderTab] = useState<'chat' | 'preview' | 'artifacts'>('chat');
  const [isWorkingExpanded, setIsWorkingExpanded] = useState(false);
  const [executionDuration, setExecutionDuration] = useState<number>(0);
  const [lastRunDuration, setLastRunDuration] = useState<number>(156);
  const [selectedModelLabel, setSelectedModelLabel] = useState<string>('Default');
  const [selectedModel, setSelectedModel] = useState<string>('Default');
  const [developerPersona, setDeveloperPersona] = useState<string>('');
  const [customSystemInstruction, setCustomSystemInstruction] = useState<string>('');
  const [outputFormat, setOutputFormat] = useState<'auto' | 'markdown' | 'json'>('auto');
  const [multiAgent, setMultiAgent] = useState<boolean>(true);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<string>('projects/index.html');
  const [checkpointToast, setCheckpointToast] = useState<string | null>(null);
  const executionTimerRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // In-flight send guard (ref, not state): handleSend's `isLoading` check
  // reads a render closure, so two rapid sends (Enter + Send click, or a
  // browser automation double-trigger) can both pass it in the same tick
  // and run two concurrent chatWithAI streams — their onText upserts then
  // race and collapse two turns into ONE model bubble. A ref flips
  // synchronously, so the second call is always refused (live QA round 2:
  // 3 user messages, only 2 assistant bubbles).
  const isSendingRef = useRef(false);
  // AbortController for the in-flight chat stream — the Send button turns
  // into Stop while a turn runs, and the Browser tab's "Take over" aborts
  // through the same controller (see stopCurrentTurn).
  const chatAbortRef = useRef<AbortController | null>(null);
  // Live browser tabs (agent tools + Browser tab share up to 4 live pages).
  const [liveBrowserTabs, setLiveBrowserTabs] = useState<Array<{ id: string; url?: string }>>([]);
  const [activeLiveBrowserTabId, setActiveLiveBrowserTabId] = useState<string | null>(null);
  const actionStepsRef = useRef<ActionStep[]>([]);
  const modifiedFilesRef = useRef<string[]>([]);
  const executionDurationRef = useRef<number>(0);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestionPrompt | null>(null);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);

  const handleSubmitQuestionAnswers = async (answers: Record<string, string[]>, notes: string) => {
    if (!pendingQuestion) return;
    setIsSubmittingAnswer(true);
    try {
      await fetch('/api/gemini/answer-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: pendingQuestion.questionId,
          answers,
          notes,
          skipped: false,
        }),
      });
    } catch (err) {
      console.warn('Failed to submit answer-question response:', err);
    } finally {
      setIsSubmittingAnswer(false);
      setPendingQuestion(null);
    }
  };

  const handleSkipQuestion = async () => {
    if (!pendingQuestion) return;
    setIsSubmittingAnswer(true);
    try {
      await fetch('/api/gemini/answer-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: pendingQuestion.questionId,
          answers: {},
          skipped: true,
        }),
      });
    } catch (err) {
      console.warn('Failed to skip question:', err);
    } finally {
      setIsSubmittingAnswer(false);
      setPendingQuestion(null);
    }
  };

  // Load latest chat session from IndexedDB on startup
  useEffect(() => {
    getAllSessions().then(sessions => {
      if (sessions.length > 0) {
        const latest = sessions[0];
        setCurrentSessionId(latest.id);
        setCurrentSessionTitle(latest.title || 'Live Canvas');
        setMessages(latest.messages || []);
        setActiveMode((latest.mode as any) || 'general');

        // Extract or load this session's specific generated website
        const html = latest.generatedHtml || extractHtmlFromChatMessages(latest.messages || []);
        if (html) {
          setCurrentSessionHtml(html);
        }
        setPreviewUrl(`${window.location.origin}/projects/${latest.id}/index.html`);
      } else {
        setPreviewUrl(`${window.location.origin}/projects/index.html`);
      }
    }).catch(err => console.warn("Failed to load initial session from IndexedDB:", err));
  }, []);

  // Self-heal after a server redeploy wiped .secrets.json: if this browser
  // still holds API keys locally but the server's synced pool is empty,
  // re-send them (same endpoint the save path uses). Silent — chat just
  // works on first load after a deploy, with no key re-entry.
  useEffect(() => {
    restoreServerKeysFromLocal().catch(() => {});
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const keys = getLocalKeys();
    setActiveKeysCount(keys.filter(k => k.isActive).length);
  }, [showSecretsModal, showSettingsModal]);

  useEffect(() => {
    let timer: any;
    if (cooldown > 0) {
      timer = setInterval(() => {
        setCooldown(prev => prev - 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    if (isLoading) {
      const startTime = Date.now();
      setExecutionDuration(0);
      executionDurationRef.current = 0;
      executionTimerRef.current = setInterval(() => {
        const secs = Math.floor((Date.now() - startTime) / 1000);
        executionDurationRef.current = secs;
        setExecutionDuration(secs);
      }, 1000);
    } else {
      if (executionTimerRef.current) {
        clearInterval(executionTimerRef.current);
        executionTimerRef.current = null;
      }
      if (executionDurationRef.current > 0) {
        setLastRunDuration(executionDurationRef.current);
      }
    }
    return () => {
      if (executionTimerRef.current) clearInterval(executionTimerRef.current);
    };
  }, [isLoading]);

  // Keep runningJob in sync for closures (stopCurrentTurn / handleSend read
  // the ref so a stale render closure can never miss a running job).
  useEffect(() => {
    runningJobRef.current = runningJob;
  }, [runningJob]);

  // Poll the background-job list for a job running under the current
  // session. Runs only while a session exists; a job is 'running' until
  // the server reports it done/failed, so the Stop button stays a Stop
  // button until the work has actually stopped (no optimistic clear —
  // clearing early would let a new turn start while the old job still
  // runs and clear its session cancel flag before the loop sees it).
  useEffect(() => {
    if (!currentSessionId) {
      setRunningJob(null);
      return;
    }
    let stopped = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/jobs');
        const d = await r.json();
        if (stopped) return;
        const job = (d.jobs || []).find(
          (j: any) =>
            j.sessionId === currentSessionId &&
            (j.status === 'queued' || j.status === 'working')
        );
        setRunningJob(
          job ? { id: job.id, sessionId: job.sessionId, status: job.status } : null
        );
      } catch {
        // Network blip: keep the last known state; the next poll retries.
      }
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [currentSessionId]);

  const formatDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  const handleVoiceInput = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("ভয়েস টাইপিংয়ের জন্য Chrome ব্রাউজার ব্যবহার করুন।");
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'bn-BD';
      recognition.interimResults = false;
      setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput(prev => prev ? `${prev} ${transcript}` : transcript);
        setIsListening(false);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  const handleCheckpoint = () => {
    setCheckpointToast("✓ Checkpoint saved at this step");
    setTimeout(() => setCheckpointToast(null), 3000);
  };

  const handleDownloadZip = () => {
    window.location.href = '/api/project/download';
  };

  const handleCopyCode = () => {
    if (!currentSessionHtml) return;
    navigator.clipboard.writeText(currentSessionHtml);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2500);
  };

  // Stop the running turn (Send button becomes Stop while loading; the
  // Browser tab's "Take over" calls this too). Aborts the SSE fetch AND
  // tells the server to cancel the turn, so the agent loop stops issuing
  // tool calls at the next round boundary instead of running on. Also
  // cancels a background job running under this session — a job keeps
  // running after the chat stream ends, so stopping the turn alone would
  // leave it working with no way to stop it.
  const stopCurrentTurn = () => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    if (currentSessionId) {
      fetch('/api/gemini/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId }),
      }).catch(() => {});
    }
    const job = runningJobRef.current;
    if (job) {
      fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {});
      // Do NOT clear runningJob here: the poll clears it only once the
      // server reports the job done/failed, so the Stop button stays a
      // Stop button (and no new turn starts) until the work has actually
      // stopped.
    }
    setActionLog('⏹ Stopped — you took over.');
  };

  // True while ANY work is running for this session: a chat turn
  // (isLoading) or a background job (runningJob). The Send button shows
  // Stop and handleSend refuses new turns while this is true.
  const isWorkRunning = isLoading || runningJob !== null;

  // Stop intent in a chat message (Bengali + English) — see
  // src/lib/stopRequest.ts. While work is running, a stop message cancels
  // the work instead of starting a new turn.

  // Append the stopped confirmation in the existing "⏹ Turn stopped."
  // model-message style (same text the AbortError path uses), once only.
  const appendStoppedNote = () => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (
        last?.role === 'model' &&
        last.parts?.[0]?.text === '⏹ Turn stopped.'
      ) {
        return prev;
      }
      return [...prev, { role: 'model', parts: [{ text: '⏹ Turn stopped.' }], isFinished: true }];
    });
  };

  const handleSend = async (overrideText?: string | React.MouseEvent, options?: { bypassCache?: boolean }) => {
    const textToSend = typeof overrideText === 'string' ? overrideText : input;
    const trimmed = (textToSend || '').trim();
    // While work is running, a stop message is accepted and cancels the
    // work instead of starting a new turn. A bare Send click also stops
    // the work. Anything else is ignored — no parallel turn ever starts.
    if (isLoading || isSendingRef.current || runningJobRef.current) {
      if (isStopRequest(trimmed)) {
        setInput('');
        stopCurrentTurn();
        appendStoppedNote();
        return;
      }
      if (typeof overrideText !== 'string') stopCurrentTurn();
      return;
    }
    if (!trimmed || cooldown > 0) return;
    isSendingRef.current = true;

    const userMessage: any = { role: 'user', parts: [{ text: textToSend }] };
    const imageForThisTurn = attachedImage;
    if (imageForThisTurn) userMessage.imageUrl = imageForThisTurn.dataUrl;
    setTeamStatuses([]);
    setLastUsage(null);
    // STEP 13 (P1): a fresh turn clears the cached-build label until the
    // server says this turn was served from cache.
    setCachedBuild(null);
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setAttachedImage(null);
    setIsLoading(true);
    setError(null);
    setActionLog("Nexus AI: এজেন্ট পাইপলাইন ও টুলস প্রস্তুত হচ্ছে...");
    setActivityLogs([]);
    actionStepsRef.current = [];
    modifiedFilesRef.current = [];
    setActionSteps([]);
    setModifiedFiles([]);

    // Determine or create session in IndexedDB
    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = `session_${Date.now()}`;
      const title = generateSessionTitle(textToSend);
      setCurrentSessionId(sessionId);
      setCurrentSessionTitle(title);
      saveSession({
        id: sessionId,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: newMessages,
        mode: activeMode,
      }).catch(err => console.warn("IndexedDB save error:", err));
    } else {
      getSession(sessionId).then(sess => {
        if (sess) {
          saveSession({ ...sess, messages: newMessages, updatedAt: Date.now() });
        }
      }).catch(() => {});
    }

    const upsertActionStep = (step: ActionStep) => {
      const current = actionStepsRef.current;
      const idx = current.findIndex(s => s.id === step.id);
      const next = idx >= 0
        ? current.map((s, i) => (i === idx ? { ...s, ...step } : s))
        : [...current, step];
      actionStepsRef.current = next;
      setActionSteps(next);
    };

    const recordModifiedFile = (filePath: string) => {
      const clean = filePath.replace(/^\/+/, '').trim();
      if (!clean) return;
      if (!modifiedFilesRef.current.includes(clean)) {
        const next = [...modifiedFilesRef.current, clean];
        modifiedFilesRef.current = next;
        setModifiedFiles(next);
      }
    };

    try {
      const chatController = new AbortController();
      chatAbortRef.current = chatController;
      await chatWithAI(
        newMessages,
        (text, imageUrl) => {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            let updated;
            if (last?.role === 'model') {
              updated = [...prev.slice(0, -1), { 
                ...last, 
                parts: [{ text }], 
                imageUrl: imageUrl || last.imageUrl,
                actionSteps: actionStepsRef.current,
                modifiedFiles: modifiedFilesRef.current,
              }];
            } else {
              updated = [...prev, { 
                role: 'model', 
                parts: [{ text }], 
                imageUrl,
                actionSteps: actionStepsRef.current,
                modifiedFiles: modifiedFilesRef.current,
              }];
            }
            // Real-time update to IndexedDB
            if (sessionId) {
              getSession(sessionId).then(sess => {
                if (sess) {
                  saveSession({ ...sess, messages: updated, updatedAt: Date.now() });
                }
              }).catch(() => {});
            }
            return updated;
          });
        },
        (action) => {
          setActionLog(action);
          setActivityLogs(prev => [...prev, action]);
        },
        activeMode,
        (keyId, cooldownSec) => {
          setActionLog(`Rate limit detected on key. Auto-rotated to backup key (${cooldownSec}s cooldown).`);
        },
        (url, html, sessId) => {
          if (html) {
            setCurrentSessionHtml(html);
          }
          const targetUrl = url.startsWith('/') ? url : `/${url}`;
          setPreviewUrl(`${window.location.origin}${targetUrl}?t=${Date.now()}`);
          recordModifiedFile(targetUrl);
          setShowCodePreview(true);
          setPreviewKey(k => k + 1);

          const sid = sessId || sessionId;
          if (sid) {
            getSession(sid).then(sess => {
              if (sess) {
                saveSession({
                  ...sess,
                  generatedHtml: html || sess.generatedHtml,
                  previewUrl: targetUrl,
                  updatedAt: Date.now()
                }).catch(() => {});
              }
            });
          }
        },
        sessionId,
        (keyInfo) => {
          setCurrentActiveKeyInfo(keyInfo);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'model') {
              return [...prev.slice(0, -1), { ...last, keyInfo }];
            }
            return prev;
          });
        },
        (step: ActionStep) => {
          upsertActionStep(step);
        },
        {
          selectedModel,
          developerPersona,
          customSystemInstruction,
          outputFormat,
          multiAgent,
          imageBase64: imageForThisTurn?.base64,
          imageMime: imageForThisTurn?.mime,
          // STEP 13 (P1): "rebuild anyway" bypasses the build cache.
          bypassCache: options?.bypassCache,
          onCachedBuild: (info) => setCachedBuild(info),
          onUsage: (u) => setLastUsage(u),
          onAgentStatus: (st) => {
            setTeamStatuses((prev) => {
              const idx = prev.findIndex((x) => x.role === st.agent);
              const next = { role: st.agent as AgentStatus['role'], status: st.status as AgentStatus['status'], detail: st.detail };
              return idx >= 0 ? prev.map((x, i) => (i === idx ? next : x)) : [...prev, next];
            });
          },
          // Live Browser tab: stoppable stream + agent live-session events.
          signal: chatController.signal,
          // Live browser tabs (max 4): the agent learns a tab the moment it
          // opens/uses one — upsert by session id, activate it. A 5th tab
          // cannot exist (the worker pool holds 4); guard anyway.
          onLiveBrowser: (info) => {
            const tab = { id: info.sessionId, url: info.url };
            setLiveBrowserTabs((prev) => {
              if (prev.some((t) => t.id === tab.id)) return prev.map((t) => (t.id === tab.id ? tab : t));
              return prev.length >= 4 ? prev : [...prev, tab];
            });
            setActiveLiveBrowserTabId(tab.id);
          },
          // Seed the turn with the tabs already open in the Browser tab so
          // the agent can drive tabs the user opened.
          liveTabs: liveBrowserTabs,
          activeLiveTabId: activeLiveBrowserTabId ?? undefined,
        },
        ({ filePath }) => {
          recordModifiedFile(filePath);
        },
        (questionPayload) => {
          setPendingQuestion(questionPayload);
        }
      );
    } catch (err: any) {
      // Stopped by the user (Stop button / Browser-tab Take over): not an
      // error — no banner, no cooldown, no error bubble. If the turn was
      // stopped before any model text streamed, leave a short note so the
      // turn does not end in silence.
      if (err?.name === 'AbortError' || /aborted|AbortError/i.test(err?.message || '')) {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'model') return prev;
          return [...prev, { role: 'model', parts: [{ text: '⏹ Turn stopped.' }], isFinished: true }];
        });
      } else {
      const errMsg = err?.message || String(err) || '';
      const isRateLimit = errMsg.includes('429') || /rate limit|free-models-per-day|quota/i.test(errMsg);
      const isAuthFailure = Boolean(err?.isAuthError) && !isRateLimit;

      // One reply bubble per request: a failed request gets its OWN model
      // bubble (isError), appended — never merged into the previous reply
      // and never swallowed by the single error banner (live QA 2026-11-27:
      // two failed requests collapsed into one display).
      let replyText: string;
      if (isRateLimit) {
        replyText = errMsg || "ফ্রি মডেলের দৈনিক লিমিট (Rate Limit) পূর্ণ হয়েছে। অনুগ্রহ করে একটু অপেক্ষা করুন অথবা 🔑 মেনুতে নতুন API কী যুক্ত করুন।";
        setError(replyText);
        setCooldown(30);
      } else if (isAuthFailure || errMsg.includes('কার্যকর API Key') || errMsg.includes('UNAUTHENTICATED')) {
        replyText = errMsg || "বৈধ API Key প্রয়োজন। অনুগ্রহ করে 🔑 API Keys মেনুতে আপনার Google AI Studio বা OpenRouter API Key যুক্ত করুন।";
        setError(replyText);
        setShowSecretsModal(true);
      } else {
        replyText = errMsg || "একটি সাময়িক সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।";
        setError(replyText);
      }
      setMessages(prev => [...prev, {
        role: 'model',
        parts: [{ text: replyText }],
        isError: true,
        isFinished: true,
      }]);
      }
    } finally {
      chatAbortRef.current = null;
      isSendingRef.current = false;
      setIsLoading(false);
      setPendingQuestion(null);
      setActionLog(null);
      const finalSteps = actionStepsRef.current;
      const finalFiles = modifiedFilesRef.current;
      const finalDuration = executionDurationRef.current || 1;
      // Persist real completed steps, modified files, and duration onto the model message
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'model') {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              actionSteps: finalSteps,
              modifiedFiles: finalFiles,
              runDuration: finalDuration,
              isFinished: true
            }
          ];
        }
        return prev;
      });
      // Final sync to IndexedDB & HTML auto-extraction check
      if (sessionId) {
        setMessages(finalMsgs => {
          const extractedHtml = extractHtmlFromChatMessages(finalMsgs);
          if (extractedHtml) {
            setCurrentSessionHtml(extractedHtml);
          }
          getSession(sessionId!).then(sess => {
            if (sess) {
              saveSession({ 
                ...sess, 
                messages: finalMsgs, 
                generatedHtml: extractedHtml || sess.generatedHtml,
                updatedAt: Date.now() 
              });
            }
          }).catch(() => {});
          return finalMsgs;
        });
      }
    }
  };

  /**
   * Step 11 — "Use template": apply a bundled static template with ZERO
   * model calls. The template HTML is copied through the existing
   * POST /api/tools/file-write path (server runs the deployHtmlFile PWA
   * path for projects/*.html: manifest + service worker + session copy),
   * then the local preview is shown. No chatWithAI, no /api/gemini/*,
   * no provider (Gemini/Groq/OpenRouter) request happens here at all, so
   * this works with no API key. If the server is unreachable (e.g. static
   * preview build), fall back to a local blob-URL preview of the same HTML.
   */
  const handleUseTemplate = async (template: StaticTemplate) => {
    // Also blocked while a background job runs: applying a template
    // writes files, and a running job may be writing the same project.
    if (isLoading || isApplyingTemplate || runningJobRef.current) return;
    setIsApplyingTemplate(true);
    setError(null);

    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = `session_${Date.now()}`;
      setCurrentSessionId(sessionId);
      setCurrentSessionTitle(template.title);
    }
    const targetPath = `projects/${sessionId}/index.html`;

    const userMessage: any = { role: 'user', parts: [{ text: `টেমপ্লেট ব্যবহার করুন: ${template.title}` }] };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);

    let html = template.html;
    let previewTarget = `${window.location.origin}/${targetPath}`;
    let savedToDisk = false;
    try {
      const res = await fetch('/api/tools/file-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: targetPath, content: template.html, sessionId }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({} as any));
        if (data?.success) {
          savedToDisk = true;
          if (typeof data.deployedHtml === 'string' && data.deployedHtml) html = data.deployedHtml;
          if (typeof data.previewUrl === 'string' && data.previewUrl) {
            previewTarget = data.previewUrl.startsWith('http')
              ? data.previewUrl
              : `${window.location.origin}${data.previewUrl.startsWith('/') ? '' : '/'}${data.previewUrl}`;
          }
        }
      }
    } catch (err) {
      console.warn('Template file-write unreachable, using local preview:', err);
    }
    if (!savedToDisk) {
      // Local-only fallback: same template, same preview — just not on disk.
      try {
        const blob = new Blob([template.html], { type: 'text/html;charset=utf-8' });
        previewTarget = URL.createObjectURL(blob);
      } catch {
        previewTarget = `${window.location.origin}/${targetPath}`;
      }
    }

    const modelMessage: any = {
      role: 'model',
      parts: [{ text: savedToDisk
        ? `✅ "${template.title}" টেমপ্লেটটি তৈরি — কোনো AI কল ছাড়াই! ফাইলটি ${targetPath} এ সংরক্ষিত হয়েছে (PWA ম্যানিফেস্ট ও সার্ভিস ওয়ার্কারসহ) এবং নিচের প্রিভিউতে দেখা যাচ্ছে। এডিট করতে চাইলে চ্যাটে বলুন — যেমন "হেডারে দোকানের নাম বদলে দাও"।`
        : `✅ "${template.title}" টেমপ্লেটটি প্রিভিউতে দেখা যাচ্ছে — কোনো AI কল ছাড়াই! (সার্ভারে সংরক্ষণ করা যায়নি, তাই পেজ রিলোড করলে এটি হারিয়ে যাবে — সংরক্ষণ করতে Download বাটন ব্যবহার করুন।)` }],
    };
    const finalMessages = [...newMessages, modelMessage];
    setMessages(finalMessages);
    setCurrentSessionHtml(html);
    // Cache-bust http(s) previews only — a blob: URL must stay untouched.
    setPreviewUrl(previewTarget.startsWith('blob:')
      ? previewTarget
      : `${previewTarget}${previewTarget.includes('?') ? '&' : '?'}t=${Date.now()}`);
    setModifiedFiles(prev => prev.includes(targetPath) ? prev : [...prev, targetPath]);
    setShowCodePreview(true);
    setPreviewKey(k => k + 1);
    try {
      const sess = await getSession(sessionId).catch(() => null);
      await saveSession({
        ...(sess || { id: sessionId, title: template.title, createdAt: Date.now(), mode: activeMode }),
        messages: finalMessages,
        generatedHtml: html,
        previewUrl: `/${targetPath}`,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.warn('Template session save failed:', err);
    } finally {
      setIsApplyingTemplate(false);
    }
  };

  // STEP 13 (P1): "Rebuild anyway" — resend the last user prompt with the
  // build cache bypassed, so the model builds fresh instead of serving the
  // cached site.
  const handleRebuildAnyway = () => {
    if (isLoading || isSendingRef.current) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i];
      if (m?.role === 'user') {
        const text = m?.parts?.map((p: any) => p?.text || '').join(' ').trim()
          || (typeof m?.text === 'string' ? m.text : '');
        if (text) {
          setActionLog('🔄 ক্যাশ বাইপাস করে নতুন করে বানানো হচ্ছে...');
          handleSend(text, { bypassCache: true });
        }
        return;
      }
    }
  };

  const handleNewChat = () => {
    setCurrentSessionId(null);
    setCurrentSessionTitle('New Canvas');
    setCurrentSessionHtml(null);
    setCachedBuild(null);
    setPreviewUrl(`${window.location.origin}/projects/index.html?t=${Date.now()}`);
    setMessages([]);
    setError(null);
    setActivityLogs([]);
    setActionSteps([]);
    setModifiedFiles([]);
    setPreviewKey(k => k + 1);
  };

  const handleSelectSession = async (id: string) => {
    try {
      const session = await getSession(id);
      if (session) {
        setCurrentSessionId(session.id);
        setCurrentSessionTitle(session.title || 'Live Canvas');
        setMessages(session.messages || []);
        setActiveMode((session.mode as any) || 'coding');
        setError(null);
        setCachedBuild(null);
        setActivityLogs([]);
        setActionSteps([]);
        setModifiedFiles([]);

        // Extract or load this session's specific generated website
        let html = session.generatedHtml;
        if (!html && session.messages?.length) {
          html = extractHtmlFromChatMessages(session.messages) || undefined;
          if (html) {
            saveSession({ ...session, generatedHtml: html, updatedAt: Date.now() }).catch(() => {});
          }
        }
        setCurrentSessionHtml(html || null);
        const sessionUrl = session.previewUrl || `/projects/${session.id}/index.html`;
        setPreviewUrl(`${window.location.origin}${sessionUrl}?t=${Date.now()}`);
        setPreviewKey(k => k + 1);
      }
    } catch (err) {
      console.warn("Failed to switch session:", err);
    }
  };

  const handleDownloadHtml = () => {
    const html = currentSessionHtml;
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(currentSessionTitle || 'nexus-website').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleAnalyzeError = (errText: string) => {
    const promptText = `নিচের এরর/বাগটি debug_error_analysis ও read_skill('debugging-error-analysis') ব্যবহার করে বিশ্লেষণ করো, রুট-কজ বের করো এবং ফিক্সড কোড দাও:\n\n\`\`\`\n${errText}\n\`\`\``;
    handleSend(promptText);
  };

  // GENERAL ASSISTANT (2026-11-29): general mode uses the same full
  // CoderView (Chat / Preview / Artifacts / Browser tabs, mini browser,
  // Stop) as coding mode — the old fallback chat view had no Browser tab
  // and no live-browser UI at all, so General Assistant could never open
  // or drive the browser. Image / search modes keep the fallback view.
  if (activeMode === 'coding' || activeMode === 'general') {
    return (
      <>
        <GoogleAIStudioCoderView
          messages={messages}
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          actionLog={actionLog}
          activityLogs={activityLogs}
          actionSteps={actionSteps}
          modifiedFiles={modifiedFiles}
          currentSessionId={currentSessionId}
          currentSessionTitle={currentSessionTitle}
          currentSessionHtml={currentSessionHtml}
          previewUrl={previewUrl}
          previewDevice={previewDevice}
          setPreviewDevice={setPreviewDevice}
          previewKey={previewKey}
          setPreviewKey={setPreviewKey}
          error={error}
          cooldown={cooldown}
          handleSend={handleSend}
          handleNewChat={handleNewChat}
          handleDownloadHtml={handleDownloadHtml}
          handleCopyCode={handleCopyCode}
          copiedCode={copiedCode}
          onOpenDrawer={() => setIsDrawerOpen(true)}
          onOpenSettings={() => setShowSettingsModal(true)}
          onOpenTools={() => setShowToolsModal(true)}
          onOpenSecrets={() => setShowSecretsModal(true)}
          onOpenLogs={() => setShowLogsModal(true)}
          activeKeysCount={activeKeysCount}
          currentActiveKeyInfo={currentActiveKeyInfo}
          activeMode={activeMode}
          setActiveMode={setActiveMode}
          selectedModel={selectedModel}
          setSelectedModel={(m: string) => {
            setSelectedModel(m);
            setSelectedModelLabel(m);
          }}
          developerPersona={developerPersona}
          setDeveloperPersona={setDeveloperPersona}
          customSystemInstruction={customSystemInstruction}
          setCustomSystemInstruction={setCustomSystemInstruction}
          outputFormat={outputFormat}
          setOutputFormat={setOutputFormat}
          multiAgent={multiAgent}
          setMultiAgent={setMultiAgent}
          onToggleTeamPanel={() => setShowTeamPanel(v => !v)}
          showTeamPanel={showTeamPanel}
          teamStatuses={teamStatuses}
          onAnalyzeError={handleAnalyzeError}
          liveBrowserTabs={liveBrowserTabs}
          activeLiveBrowserTabId={activeLiveBrowserTabId}
          onLiveBrowserTabsChange={setLiveBrowserTabs}
          onActiveLiveBrowserTabChange={setActiveLiveBrowserTabId}
          onStopTurn={stopCurrentTurn}
          isBackgroundJobRunning={runningJob !== null}
          // Step 12 (P1): the preview iframe renders currentSessionHtml via
          // srcDoc, so a disk-only save would never show in preview — sync
          // the in-memory copy when the edited artifact is projects/index.html.
          onArtifactSaved={(filePath, content) => {
            if (filePath === 'projects/index.html') setCurrentSessionHtml(content);
          }}
        />

        <SidebarDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          onOpenSettings={() => setShowSettingsModal(true)}
          onOpenSecrets={() => setShowSecretsModal(true)}
          onOpenGitHub={() => setShowGitHubModal(true)}
          onOpenFirebase={() => setShowFirebaseModal(true)}
          onOpenTools={() => setShowToolsModal(true)}
          onOpenLogs={() => setShowLogsModal(true)}
          onTogglePreview={() => setShowCodePreview(!showCodePreview)}
          activeKeysCount={activeKeysCount}
        />

        <ToolsModal 
          isOpen={showToolsModal} 
          onClose={() => setShowToolsModal(false)} 
        />

        <GitHubSyncModal 
          isOpen={showGitHubModal} 
          onClose={() => setShowGitHubModal(false)} 
        />

        <FirebaseModal
          isOpen={showFirebaseModal}
          onClose={() => setShowFirebaseModal(false)}
        />

        <SettingsModal
          isOpen={showSettingsModal}
          onClose={() => setShowSettingsModal(false)}
          onOpenSecrets={() => setShowSecretsModal(true)}
          onOpenGitHub={() => setShowGitHubModal(true)}
          onOpenFirebase={() => setShowFirebaseModal(true)}
        />

        <SecretsModal
          isOpen={showSecretsModal}
          onClose={() => setShowSecretsModal(false)}
          onKeysUpdated={() => {
            const keys = getLocalKeys();
            setActiveKeysCount(keys.filter(k => k.isActive).length);
          }}
        />

        <LogsModal
          isOpen={showLogsModal}
          onClose={() => setShowLogsModal(false)}
          onOpenSecrets={() => setShowSecretsModal(true)}
        />

        <AskQuestionModal
          pendingQuestion={pendingQuestion}
          isSubmitting={isSubmittingAnswer}
          onSubmit={handleSubmitQuestionAnswers}
          onSkip={handleSkipQuestion}
        />

        <OfflineIndicator />
      </>
    );
  }

  return (
    <div className="flex h-screen bg-[#020617] text-slate-200 font-sans overflow-hidden">
      {/* Main Chat Area */}
      <div className={cn(
        "flex flex-col flex-1 transition-all duration-500",
        showCodePreview ? "w-1/2" : "w-full"
      )}>
        {/* Header */}
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-4 sm:px-6 bg-[#020617]/90 backdrop-blur-md sticky top-0 z-40">
          <div className="flex items-center gap-3">
            {/* Left Hamburger Button matching screenshot */}
            <button
              onClick={() => setIsDrawerOpen(true)}
              className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 flex items-center justify-center transition-all shadow-sm focus:outline-none"
              title="Open Navigation Menu (মেনু খুলুন)"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/20">
                <Zap className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="font-bold text-slate-100 tracking-tight text-sm sm:text-base leading-none">
                  Nexus AI
                </h1>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                  <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                    IndexedDB Offline Ready
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Quick New Chat Button */}
            <button
              onClick={handleNewChat}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-all border border-slate-800"
              title="Start New Chat Session"
            >
              <Plus className="w-3.5 h-3.5 text-indigo-400" />
              <span>New Chat</span>
            </button>

            {/* Settings button */}
            <button 
              onClick={() => setShowSettingsModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-100 bg-slate-900 hover:bg-slate-800 rounded-lg transition-all border border-indigo-500/40 hover:border-indigo-500 shadow-sm"
              title="Settings (সেটিংস: এপিআই সিক্রেটস ও গিটহাব)"
            >
              <Settings className="w-3.5 h-3.5 text-indigo-400" />
              <span className="hidden xs:inline">সেটিংস</span>
              {activeKeysCount > 0 && (
                <span className="flex items-center gap-1 ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {activeKeysCount}
                </span>
              )}
            </button>

            {/* Logs Button */}
            <button 
              onClick={() => setShowLogsModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-300 bg-slate-900 hover:bg-rose-950/40 rounded-lg transition-all border border-rose-500/30 hover:border-rose-500/60 shadow-sm"
              title="সিস্টেম সমস্যা ও এরর লগ"
            >
              <ScrollText className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden xs:inline">লগ</span>
            </button>

            {/* Preview Toggle */}
            <button 
              onClick={() => setShowCodePreview(!showCodePreview)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition-all shadow-lg shadow-indigo-600/20"
              title="Toggle Live Website Canvas Preview"
            >
              <Layout className="w-3.5 h-3.5" />
              <span>{showCodePreview ? 'Hide' : 'Preview'}</span>
            </button>
            <PWAInstallButton />
            <GitHubConnectButton />
            <DeployButton sessionId={currentSessionId} />
            <FirebaseConnectButton />
            <AddFirebaseButton sessionId={currentSessionId} />
            <button
              onClick={() => setDashboardOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition-all border border-slate-700"
              title="Dashboard — Keys, Usage, Chain, Projects, Jobs"
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Dashboard</span>
            </button>
          </div>
        </header>

        {/* Multi-agent team status (Planner → Coder → Reviewer → Tester) */}
        {(showTeamPanel || teamStatuses.length > 0) && (
          <div className="px-6 pt-3">
            <TeamStatus statuses={teamStatuses} />
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-slate-800">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center max-w-4xl mx-auto py-8">
              <div className="w-16 h-16 bg-gradient-to-tr from-indigo-600 to-violet-500 rounded-3xl flex items-center justify-center mb-4 shadow-xl shadow-indigo-600/30">
                <Zap className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-2xl sm:text-3xl font-extrabold mb-2 text-white tracking-tight text-center">
                Nexus AI Studio • PWA ও ফুল-স্ট্যাক ওয়েবসাইট বিল্ডার
              </h2>
              <p className="text-slate-400 text-xs sm:text-sm mb-8 text-center max-w-xl leading-relaxed">
                Google AI Studio-এর মতো যেকোনো PWA মোবাইল অ্যাপ, ই-কমার্স, ড্যাশবোর্ড, পোর্টফোলিও বা আর্কেড গেম এক ক্লিকে তৈরি করুন।
              </p>

              {/* Starter Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
                {STARTER_PROMPTS.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(item.prompt)}
                    className="p-4 rounded-2xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/50 text-left transition-all group shadow-lg flex flex-col justify-between cursor-pointer"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br border", item.color)}>
                          <item.icon className="w-5 h-5" />
                        </div>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                          {item.badge}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-white group-hover:text-indigo-300 transition-colors mb-1">
                        {item.title}
                      </h3>
                      <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                        {item.prompt}
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-indigo-400 opacity-80 group-hover:opacity-100 transition-opacity">
                      <span>তৈরি করুন (Build Now)</span>
                      <span>→</span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Step 11 — Real static templates: zero model calls, instant. */}
              <div className="w-full mt-8">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-bold text-white">⚡ ফ্রি টেমপ্লেট — এখনই ব্যবহার করুন</h3>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    কোনো AI কল নয় • কোনো কী লাগে না
                  </span>
                </div>
                <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                  তৈরি করা ডিজাইন এক ক্লিকে বসিয়ে নিন — মডেলের জন্য অপেক্ষা নেই, কোটা খরচ নেই। পরে চ্যাটে বললেই এডিট করা যাবে।
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
                  {STATIC_TEMPLATES.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleUseTemplate(item)}
                      disabled={isLoading || isApplyingTemplate}
                      className="p-4 rounded-2xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800 hover:border-emerald-500/50 text-left transition-all group shadow-lg flex flex-col justify-between cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br border", item.color)}>
                            <item.icon className="w-5 h-5" />
                          </div>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                            {item.badge}
                          </span>
                        </div>
                        <h3 className="text-sm font-bold text-white group-hover:text-emerald-300 transition-colors mb-1">
                          {item.title}
                        </h3>
                        <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                          {item.description}
                        </p>
                      </div>
                      <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 opacity-80 group-hover:opacity-100 transition-opacity">
                        <span>{isApplyingTemplate ? 'বসানো হচ্ছে…' : 'টেমপ্লেট ব্যবহার করুন'}</span>
                        <span>→</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cn(
              "flex gap-4 max-w-4xl mx-auto w-full",
              m.role === 'user' ? "flex-row-reverse" : "flex-row"
            )}>
              <div className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
                m.role === 'user' ? "bg-slate-700" : "bg-indigo-600"
              )}>
                {m.role === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
              </div>
              <div className={cn(
                "flex flex-col gap-2 max-w-[80%]",
                m.role === 'user' ? "items-end" : "items-start"
              )}>
                {m.role === 'model' && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 mb-0.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-300 font-medium border border-sky-500/25">
                      🔑 {m.keyInfo?.keyName || (m.keyInfo?.isCustomKey ? 'Custom Secret Key' : 'Primary Studio Engine')}
                    </span>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 font-mono border border-slate-700/60">
                      ⚡ {m.keyInfo?.model || 'gemini-3.1-flash-lite'}
                    </span>
                    {m.keyInfo?.isCustomKey && (
                      <span className="text-emerald-400 font-medium text-[10px] flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        কাস্টম কী
                      </span>
                    )}
                  </div>
                )}
                <div className={cn(
                  "px-4 py-3 rounded-2xl text-sm leading-relaxed",
                  m.role === 'user' ? "bg-slate-800 text-white rounded-tr-none" : m.isError ? "bg-rose-500/10 border border-rose-500/30 text-rose-200 rounded-tl-none" : "bg-slate-900 border border-slate-800 rounded-tl-none"
                )}>
                  {m.parts[0].text}
                </div>
                {m.imageUrl && (
                  <img src={m.imageUrl} className="rounded-xl w-full max-w-sm border border-slate-800 shadow-2xl" alt="Generated" />
                )}
                {/* Instant Live Preview Button inside message when website code is generated */}
                {m.role === 'model' && (m.parts[0].text.includes('```html') || m.parts[0].text.includes('<!DOCTYPE') || m.parts[0].text.includes('projects/index.html')) && (
                  <button
                    onClick={() => {
                      const extracted = extractHtmlFromChatMessages([m]);
                      if (extracted) {
                        setCurrentSessionHtml(extracted);
                      }
                      if (currentSessionId) {
                        setPreviewUrl(`${window.location.origin}/projects/${currentSessionId}/index.html?t=${Date.now()}`);
                      } else {
                        setPreviewUrl(`${window.location.origin}/projects/index.html?t=${Date.now()}`);
                      }
                      setShowCodePreview(true);
                      setPreviewKey(k => k + 1);
                    }}
                    className="inline-flex items-center gap-2 px-3 py-1.5 mt-1 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-xl text-xs font-semibold transition-all shadow-sm group w-fit cursor-pointer"
                  >
                    <Layout className="w-3.5 h-3.5 text-indigo-400 group-hover:scale-110 transition-transform" />
                    <span>এই চ্যাটের ওয়েবসাইট প্রিভিউ দেখুন (Open Live Preview)</span>
                  </button>
                )}
              </div>
            </div>
          ))}
          {/* Error Message */}
          {error && (
            <div className="max-w-4xl mx-auto w-full px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 text-sm animate-shake">
              <X className="w-4 h-4" />
              <span>{error}</span>
            </div>
          )}

          {isLoading && (
            <div className="flex gap-4 max-w-4xl mx-auto w-full">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center animate-pulse flex-shrink-0">
                <Bot className="w-5 h-5" />
              </div>
              <div className="flex flex-col gap-3 flex-1">
                {/* Dynamic Tool and Action Status Bar replacing generic Processing... */}
                <div className="bg-[#0f172a] border border-indigo-500/40 px-4 py-2.5 rounded-2xl rounded-tl-none inline-flex items-center gap-3 shadow-lg shadow-indigo-600/15 max-w-xl">
                  <div className="flex gap-1.5 items-center flex-shrink-0">
                    <span className="w-2 h-2 bg-indigo-500 rounded-full animate-ping" />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                  </div>
                  <div className="w-px h-4 bg-slate-800 flex-shrink-0" />
                  <div className="flex items-center gap-2 overflow-hidden text-xs font-mono">
                    <Zap className="w-3.5 h-3.5 text-amber-400 animate-pulse flex-shrink-0" />
                    <span className="font-semibold text-slate-100 truncate">
                      {actionLog || "Thinking & Executing Tools..."}
                    </span>
                  </div>
                </div>
                
                {/* Real-time Activity and Tool Call Log */}
                <motion.div 
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-slate-900/70 border border-slate-800/70 rounded-2xl p-4 max-w-xl shadow-xl backdrop-blur-sm"
                >
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                        Live Tool & Task Execution
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-indigo-400 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20">
                      Active Orchestration
                    </span>
                  </div>
                  
                  <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-none font-mono text-xs">
                    {activityLogs.map((log, idx) => (
                      <div key={idx} className="flex items-start gap-2.5 text-slate-400">
                        <span className="text-indigo-400 mt-0.5 text-[11px] font-bold flex-shrink-0">[{idx + 1}]</span>
                        <span className="leading-relaxed">{log}</span>
                      </div>
                    ))}
                    {actionLog && (
                      <div className="flex items-start gap-2.5 text-indigo-300 font-semibold bg-indigo-950/40 p-2 rounded-xl border border-indigo-500/30 animate-pulse">
                        <span className="text-amber-400 mt-0.5 flex-shrink-0">▶</span>
                        <span className="leading-relaxed">{actionLog}</span>
                      </div>
                    )}
                  </div>

                  {modifiedFiles.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Code className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Modified Files:
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {modifiedFiles.map((file, idx) => (
                          <div key={idx} className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-md text-[11px] text-emerald-400 font-mono">
                            <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                            <span>{file}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </motion.div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="px-6 -mb-2 max-w-4xl mx-auto w-full">
            <div className="p-3 bg-rose-500/10 border border-rose-500/25 rounded-2xl text-rose-300 text-xs flex items-center justify-between gap-3 shadow-lg">
              <div className="flex-1 whitespace-pre-wrap">{error}</div>
              <button
                onClick={() => setShowLogsModal(true)}
                className="px-2.5 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 rounded-lg font-bold text-[11px] flex-shrink-0 flex items-center gap-1.5 transition-all cursor-pointer"
              >
                <ScrollText className="w-3.5 h-3.5 text-rose-400" />
                <span>লগ দেখুন</span>
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <div className="p-6 bg-gradient-to-t from-[#020617] via-[#020617] to-transparent">
          <div className="max-w-4xl mx-auto relative flex flex-col gap-2">
            <div className="relative flex items-center bg-slate-900/80 border border-slate-800 rounded-2xl focus-within:border-indigo-500 transition-all shadow-xl">
              <div className="flex items-center gap-1 px-3 py-2 border-r border-slate-800">
                <button 
                  className="p-2 text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10 rounded-xl transition-all group/upload"
                  title="Upload File"
                >
                  <Plus className="w-5 h-5 group-hover/upload:scale-110 transition-transform" />
                </button>
                
                <div className="relative">
                  <button 
                    onClick={() => setShowModeMenu(!showModeMenu)}
                    className={cn(
                      "p-2 rounded-xl transition-all flex items-center gap-2",
                      (activeMode as string) === 'general' 
                        ? "text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10" 
                        : "bg-indigo-600/20 text-indigo-400"
                    )}
                    title="Select Mode"
                  >
                    {(activeMode as string) === 'coding' && <Code className="w-5 h-5" />}
                    {activeMode === 'image' && <ImageIcon className="w-5 h-5" />}
                    {activeMode === 'search' && <Search className="w-5 h-5" />}
                    {(activeMode as string) === 'general' && <Sparkles className="w-5 h-5" />}
                    <span className="text-xs font-bold hidden sm:block capitalize">{activeMode}</span>
                  </button>
                  
                  <AnimatePresence>
                    {showModeMenu && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.98 }}
                        className="absolute bottom-full left-0 mb-3 w-56 bg-[#0f172a] border border-slate-800 rounded-2xl p-2 shadow-2xl z-50"
                      >
                        <div className="px-3 py-2 mb-1 border-b border-slate-800">
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Select Agent Mode</span>
                        </div>
                        {[
                          { id: 'coding', icon: Code, label: 'PWA & Web Builder', desc: 'PWAs, Stores, Dashboards & Games' },
                          { id: 'general', icon: Sparkles, label: 'General Assistant', desc: 'Chat & guidance' },
                          { id: 'image', icon: ImageIcon, label: 'Image Artist', desc: 'Generate visuals' },
                          { id: 'search', icon: Search, label: 'Web Explorer', desc: 'Live search' },
                        ].map((mode) => (
                          <button
                            key={mode.id}
                            onClick={() => {
                              setActiveMode(mode.id as any);
                              setShowModeMenu(false);
                            }}
                            className={cn(
                              "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all group/item",
                              (activeMode as string) === mode.id 
                                ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" 
                                : "text-slate-400 hover:bg-slate-800/50 hover:text-white"
                            )}
                          >
                            <div className={cn(
                              "p-1.5 rounded-lg",
                              (activeMode as string) === mode.id ? "bg-white/20" : "bg-slate-800 group-hover/item:bg-slate-700"
                            )}>
                              <mode.icon className="w-4 h-4" />
                            </div>
                            <div className="flex flex-col items-start">
                              <span className="font-medium">{mode.label}</span>
                              <span className="text-[10px] opacity-60">{mode.desc}</span>
                            </div>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              
              <input 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder={
                  (activeMode as string) === 'coding' ? "যেকোনো ওয়েবসাইটের লিংক (URL) অথবা অ্যাপের আইডিয়া লিখুন..." :
                  activeMode === 'image' ? "ছবির বিস্তারিত ডেসক্রিপশন লিখুন..." :
                  activeMode === 'search' ? "ওয়েব বা ডকস সার্চ করতে লিখুন..." :
                  "ওয়েবসাইট লিংক, বার্তা বা প্রম্পট লিখুন..."
                }
                className="flex-1 bg-transparent px-4 py-4 focus:outline-none text-slate-200 placeholder:text-slate-500"
              />
              
              {attachedImage && (
                <div className="relative shrink-0">
                  <img src={attachedImage.dataUrl} className="w-11 h-11 rounded-xl object-cover border border-slate-700" alt="Attached design" />
                  <button
                    onClick={() => setAttachedImage(null)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-rose-600 rounded-full flex items-center justify-center text-white"
                    title="Remove image"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const img = new Image();
                    img.onload = () => {
                      const maxSide = 1024;
                      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                      const canvas = document.createElement('canvas');
                      canvas.width = Math.round(img.width * scale);
                      canvas.height = Math.round(img.height * scale);
                      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
                      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                      setAttachedImage({ dataUrl, base64: dataUrl.split(',')[1], mime: 'image/jpeg' });
                    };
                    img.src = String(reader.result);
                  };
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => imageInputRef.current?.click()}
                className="p-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl transition-all flex items-center justify-center min-w-[44px]"
                title="Upload a design/screenshot — the agent builds a site matching it"
              >
                <ImagePlus className="w-5 h-5 text-white" />
              </button>
              <VoiceInput
                disabled={isLoading || cooldown > 0}
                onTranscript={(text) => setInput((prev) => (prev ? prev + ' ' + text : text))}
              />
              <div className="px-3">
                {/* Same Stop behaviour as the coding view: while ANY work
                    runs (chat turn or background job) this is a Stop
                    button — clicking it stops the work and never sends
                    the input text. It used to be merely disabled while
                    loading, so a running job had no stop at all here. */}
                <button
                  onClick={() => handleSend()}
                  disabled={(!isWorkRunning && !input.trim()) || cooldown > 0}
                  className="p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 rounded-xl transition-all shadow-lg shadow-indigo-600/20 flex items-center justify-center min-w-[44px]"
                  title={isWorkRunning ? "Stop" : "Send"}
                >
                  {cooldown > 0 ? (
                    <span className="text-xs font-bold text-white">{cooldown}s</span>
                  ) : isWorkRunning ? (
                    <Square className="w-5 h-5 text-white fill-current" />
                  ) : (
                    <Send className="w-5 h-5 text-white" />
                  )}
                </button>
              </div>
            </div>
            {lastUsage && (
              <div className="flex justify-center">
                <span className="text-[10px] text-slate-500">
                  This turn: {lastUsage.requests ?? 0} requests · {(lastUsage.inputTokens ?? 0).toLocaleString()} in / {(lastUsage.outputTokens ?? 0).toLocaleString()} out tokens · ${'{'}0.00{'}'} — free tiers only
                </span>
              </div>
            )}
            <div className="flex justify-center">
              <span className="text-[10px] text-slate-600 uppercase tracking-widest font-bold">
                Nexus AI v4 • {activeMode} mode
              </span>
            </div>
            <Dashboard
              open={dashboardOpen}
              onClose={() => setDashboardOpen(false)}
              onSelectProject={(sid) => {
                setCurrentSessionId(sid);
                setPreviewUrl(`${window.location.origin}/projects/${sid}/index.html?t=${Date.now()}`);
                setShowCodePreview(true);
              }}
            />
          </div>
        </div>
      </div>

      {/* Preview Panel - Dynamic Per-Chat Website Rendering */}
      <AnimatePresence>
        {showCodePreview && (
          <motion.div 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="w-1/2 border-l border-slate-800 bg-slate-950 flex flex-col z-20 shadow-2xl"
          >
            {/* Live Preview Header */}
            <div className="h-16 border-b border-slate-800 flex items-center justify-between px-4 sm:px-6 bg-slate-900/80 backdrop-blur-md flex-shrink-0">
              <div className="flex items-center gap-2.5 overflow-hidden mr-2">
                <Globe className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                <div className="flex items-center gap-2 truncate">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Live Preview
                  </span>
                  <span className="text-slate-600 font-mono text-xs">•</span>
                  <span className="text-xs font-medium text-slate-400 truncate max-w-[150px]" title={currentSessionTitle}>
                    {currentSessionTitle}
                  </span>
                </div>
                <span className="hidden xl:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  চ্যাট নির্দিষ্ট লাইভ
                </span>
              </div>

              {/* Viewport & Action Controls */}
              <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
                {/* STEP 13 (P1): cached-build label + "rebuild anyway" — shown
                    only when the last build was served from the build cache
                    (zero model calls). */}
                {cachedBuild && (
                  <>
                    <span
                      className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/30 flex-shrink-0"
                      title={cachedBuild.model ? `Cached build (built by ${cachedBuild.model})${cachedBuild.cacheHits ? ` · served from cache ${cachedBuild.cacheHits}×` : ''}` : 'Cached build — served from cache, no model call'}
                    >
                      ⚡ Cached build
                    </span>
                    <button
                      onClick={handleRebuildAnyway}
                      disabled={isLoading}
                      className="px-2 py-1 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[11px] font-semibold hover:bg-amber-500/20 disabled:opacity-50 transition-colors flex-shrink-0"
                      title="ক্যাশ বাইপাস করে মডেল দিয়ে নতুন করে বানান"
                    >
                      Rebuild anyway
                    </button>
                  </>
                )}
                {/* Canvas vs Code View Mode Toggle */}
                <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-[11px] font-semibold">
                  <button
                    onClick={() => setPreviewTab('canvas')}
                    className={cn(
                      "px-2.5 py-1 rounded-md transition-all",
                      previewTab === 'canvas' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                  >
                    ক্যানভাস
                  </button>
                  <button
                    onClick={() => setPreviewTab('code')}
                    className={cn(
                      "px-2.5 py-1 rounded-md transition-all flex items-center gap-1",
                      previewTab === 'code' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-white"
                    )}
                  >
                    <FileCode className="w-3 h-3" />
                    <span>কোড</span>
                  </button>
                </div>

                <div className="w-px h-4 bg-slate-800 mx-0.5" />

                {/* Desktop Viewport Button */}
                <button
                  onClick={() => {
                    setPreviewDevice('desktop');
                    setPreviewTab('canvas');
                  }}
                  className={cn(
                    "p-1.5 rounded-lg text-xs transition-all",
                    previewDevice === 'desktop' && previewTab === 'canvas'
                      ? "bg-indigo-600 text-white shadow-sm" 
                      : "text-slate-400 hover:text-white hover:bg-slate-800"
                  )}
                  title="Desktop View (ডেস্কটপ ভিউ)"
                >
                  <Monitor className="w-4 h-4" />
                </button>

                {/* Mobile Viewport Button */}
                <button
                  onClick={() => {
                    setPreviewDevice('mobile');
                    setPreviewTab('canvas');
                  }}
                  className={cn(
                    "p-1.5 rounded-lg text-xs transition-all",
                    previewDevice === 'mobile' && previewTab === 'canvas'
                      ? "bg-indigo-600 text-white shadow-sm" 
                      : "text-slate-400 hover:text-white hover:bg-slate-800"
                  )}
                  title="Mobile View (মোবাইল ভিউ)"
                >
                  <Smartphone className="w-4 h-4" />
                </button>

                <div className="w-px h-4 bg-slate-800 mx-0.5" />

                {/* Copy Code Button */}
                {currentSessionHtml && (
                  <button
                    onClick={handleCopyCode}
                    className={cn(
                      "p-1.5 rounded-lg text-xs transition-all flex items-center gap-1",
                      copiedCode 
                        ? "bg-emerald-600/20 text-emerald-400 border border-emerald-500/30" 
                        : "text-slate-400 hover:text-white hover:bg-slate-800"
                    )}
                    title="Copy Source Code (কোড কপি)"
                  >
                    {copiedCode ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                )}

                {/* Reload Preview Button */}
                <button
                  onClick={() => setPreviewKey(k => k + 1)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
                  title="Reload Website Preview (রিফ্রেশ)"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>

                {/* Download HTML Button */}
                {currentSessionHtml && (
                  <button
                    onClick={handleDownloadHtml}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-slate-800 transition-all"
                    title="Download this Website HTML & PWA (ডাউনলোড)"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )}

                {/* Open in New Tab Button */}
                <button
                  onClick={() => {
                    if (currentSessionHtml) {
                      const newWin = window.open('about:blank', '_blank');
                      if (newWin) {
                        newWin.document.write(currentSessionHtml);
                        newWin.document.close();
                      }
                    } else {
                      window.open(previewUrl || '/projects/index.html', '_blank');
                    }
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
                  title="Open Website in New Tab (নতুন ট্যাবে খুলুন)"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>

                {/* Close Preview */}
                <button 
                  onClick={() => setShowCodePreview(false)} 
                  className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-all ml-1"
                  title="Close Preview (প্রিভিউ বন্ধ করুন)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Preview Frame Body */}
            <div className={cn(
              "flex-1 overflow-auto flex items-center justify-center transition-all",
              previewTab === 'code' ? "bg-[#0d1117] p-4" : previewDevice === 'mobile' ? "bg-slate-900/60 p-6" : "bg-white"
            )}>
              {previewTab === 'code' ? (
                <div className="w-full h-full bg-[#0b0f19] border border-slate-800/80 rounded-2xl p-4 font-mono text-xs overflow-auto select-text shadow-inner flex flex-col">
                  <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800 flex-shrink-0">
                    <div className="flex items-center gap-2">
                      <FileCode className="w-4 h-4 text-indigo-400" />
                      <span className="font-bold text-slate-200">
                        {currentSessionTitle}.html (PWA Standalone)
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                        PWA Ready
                      </span>
                    </div>
                    <button
                      onClick={handleCopyCode}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm"
                    >
                      {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedCode ? 'কপি হয়েছে!' : 'কোড কপি করুন'}</span>
                    </button>
                  </div>
                  <pre className="flex-1 whitespace-pre-wrap break-all text-slate-300 leading-relaxed font-mono overflow-auto">
                    {currentSessionHtml || "<!-- এখনো কোনো ওয়েবসাইট বা PWA কোড জেনারেট হয়নি -->"}
                  </pre>
                </div>
              ) : previewDevice === 'mobile' ? (
                <div className="w-[375px] h-[720px] rounded-[38px] border-[8px] border-slate-700 bg-white shadow-2xl flex flex-col overflow-hidden relative">
                  {/* Phone Speaker Notch */}
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-5 bg-slate-700 rounded-b-xl z-30 flex items-center justify-center">
                    <div className="w-12 h-1 bg-slate-600 rounded-full" />
                  </div>
                  {currentSessionHtml ? (
                    <iframe 
                      key={`mob-${previewKey}`}
                      srcDoc={currentSessionHtml} 
                      className="w-full h-full border-none bg-white pt-5" 
                      title={`Mobile Preview - ${currentSessionTitle}`}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    />
                  ) : (
                    <iframe 
                      key={`mob-url-${previewKey}`}
                      src={previewUrl || '/projects/index.html'} 
                      className="w-full h-full border-none bg-white pt-5" 
                      title={`Mobile Preview - ${currentSessionTitle}`}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    />
                  )}
                </div>
              ) : (
                currentSessionHtml ? (
                  <iframe 
                    key={`desk-${previewKey}`}
                    srcDoc={currentSessionHtml} 
                    className="w-full h-full border-none bg-white" 
                    title={`Live Preview - ${currentSessionTitle}`}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  />
                ) : (
                  <iframe 
                    key={`desk-url-${previewKey}`}
                    src={previewUrl || '/projects/index.html'} 
                    className="w-full h-full border-none bg-white" 
                    title={`Live Preview - ${currentSessionTitle}`}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  />
                )
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Left-side Hamburger Drawer matching Google AI Studio screenshot */}
      <SidebarDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onOpenSettings={() => setShowSettingsModal(true)}
        onOpenSecrets={() => setShowSecretsModal(true)}
        onOpenGitHub={() => setShowGitHubModal(true)}
        onOpenFirebase={() => setShowFirebaseModal(true)}
        onOpenTools={() => setShowToolsModal(true)}
        onOpenLogs={() => setShowLogsModal(true)}
        onTogglePreview={() => setShowCodePreview(!showCodePreview)}
        activeKeysCount={activeKeysCount}
      />

      <ToolsModal 
        isOpen={showToolsModal} 
        onClose={() => setShowToolsModal(false)} 
      />

      <GitHubSyncModal 
        isOpen={showGitHubModal} 
        onClose={() => setShowGitHubModal(false)} 
      />

      <FirebaseModal
        isOpen={showFirebaseModal}
        onClose={() => setShowFirebaseModal(false)}
      />

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        onOpenSecrets={() => setShowSecretsModal(true)}
        onOpenGitHub={() => setShowGitHubModal(true)}
        onOpenFirebase={() => setShowFirebaseModal(true)}
      />

      <SecretsModal
        isOpen={showSecretsModal}
        onClose={() => setShowSecretsModal(false)}
        onKeysUpdated={() => {
          const keys = getLocalKeys();
          setActiveKeysCount(keys.filter(k => k.isActive).length);
        }}
      />

      <LogsModal
        isOpen={showLogsModal}
        onClose={() => setShowLogsModal(false)}
        onOpenSecrets={() => setShowSecretsModal(true)}
      />

      <AskQuestionModal
        pendingQuestion={pendingQuestion}
        isSubmitting={isSubmittingAnswer}
        onSubmit={handleSubmitQuestionAnswers}
        onSkip={handleSkipQuestion}
      />

      <OfflineIndicator />
    </div>
  );
}
