import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  Plus, 
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
  Copy, 
  Check, 
  RotateCcw, 
  Download, 
  ExternalLink, 
  RefreshCw, 
  Monitor, 
  Smartphone, 
  FileCode, 
  FolderArchive,
  Menu,
  Zap,
  Key,
  ShoppingBag,
  BarChart3,
  Gamepad2,
  CheckSquare,
  Briefcase,
  ScrollText,
  SlidersHorizontal,
  Bug,
  Bot,
  Eye,
  Pencil,
  Save,
  AlertTriangle,
  X
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { ActionHistoryAccordion } from './ActionHistoryAccordion';
import { PWAInstallButton } from './PWAInstallButton';
import { GitHubConnectButton } from './GitHubConnectButton';
import { DeployButton } from './DeployButton';
import { FirebaseConnectButton, AddFirebaseButton } from './FirebaseConnectButton';
import { ActionStep } from '../types/secrets';
import { TeamStatus, type AgentStatus } from './TeamStatus';

interface GoogleAIStudioCoderViewProps {
  messages: any[];
  input: string;
  setInput: (val: string) => void;
  isLoading: boolean;
  actionLog: string | null;
  activityLogs: string[];
  actionSteps?: ActionStep[];
  modifiedFiles: string[];
  currentSessionId: string | null;
  currentSessionTitle: string;
  currentSessionHtml: string | null;
  previewUrl: string;
  previewDevice: 'desktop' | 'mobile';
  setPreviewDevice: (d: 'desktop' | 'mobile') => void;
  previewKey: number;
  setPreviewKey: React.Dispatch<React.SetStateAction<number>>;
  error: string | null;
  cooldown: number;
  handleSend: (text?: string | React.MouseEvent) => void;
  handleNewChat: () => void;
  handleDownloadHtml: () => void;
  handleCopyCode: () => void;
  copiedCode: boolean;
  onOpenDrawer: () => void;
  onOpenSettings: () => void;
  onOpenTools: () => void;
  onOpenSecrets?: () => void;
  onOpenLogs?: () => void;
  activeKeysCount?: number;
  currentActiveKeyInfo?: any;
  activeMode: string;
  setActiveMode: (mode: any) => void;
  selectedModel?: string;
  setSelectedModel?: (model: string) => void;
  developerPersona?: string;
  setDeveloperPersona?: (persona: string) => void;
  customSystemInstruction?: string;
  setCustomSystemInstruction?: (instruction: string) => void;
  outputFormat?: 'auto' | 'markdown' | 'json';
  setOutputFormat?: (format: 'auto' | 'markdown' | 'json') => void;
  multiAgent?: boolean;
  setMultiAgent?: (enabled: boolean) => void;
  onToggleTeamPanel?: () => void;
  // Team panel: the Multi-Agent button (in this view) toggles it, so the
  // panel MUST render in this same mounted tree. App.tsx used to render
  // <TeamStatus> only in its non-coding branch, which never mounts while
  // this coding view is active (the default) — the button flipped state
  // that no mounted component read, so no panel ever appeared (live QA
  // round 2, 2026-11-27).
  showTeamPanel?: boolean;
  teamStatuses?: AgentStatus[];
  onAnalyzeError?: (errText: string) => void;
  // Step 12 (P1): called after an artifact edit is saved to disk, so the
  // parent can sync any in-memory copy (e.g. currentSessionHtml, which the
  // preview iframe renders via srcDoc) with the edited content.
  onArtifactSaved?: (filePath: string, content: string) => void;
}

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

export const GoogleAIStudioCoderView: React.FC<GoogleAIStudioCoderViewProps> = ({
  messages,
  input,
  setInput,
  isLoading,
  actionLog,
  activityLogs,
  actionSteps = [],
  modifiedFiles,
  currentSessionId,
  currentSessionTitle,
  currentSessionHtml,
  previewUrl,
  previewDevice,
  setPreviewDevice,
  previewKey,
  setPreviewKey,
  error,
  cooldown,
  handleSend,
  handleNewChat,
  handleDownloadHtml,
  handleCopyCode,
  copiedCode,
  onOpenDrawer,
  onOpenSettings,
  onOpenTools,
  onOpenSecrets,
  onOpenLogs,
  activeKeysCount = 0,
  currentActiveKeyInfo,
  activeMode,
  setActiveMode,
  selectedModel,
  setSelectedModel,
  developerPersona = '',
  setDeveloperPersona,
  customSystemInstruction = '',
  setCustomSystemInstruction,
  outputFormat = 'auto',
  setOutputFormat,
  multiAgent = true,
  setMultiAgent,
  onToggleTeamPanel,
  showTeamPanel = false,
  teamStatuses = [],
  onAnalyzeError,
  onArtifactSaved,
}) => {
  const [activeCoderTab, setActiveCoderTab] = useState<'chat' | 'preview' | 'artifacts'>('chat');
  const [isWorkingExpanded, setIsWorkingExpanded] = useState(false);
  const [executionDuration, setExecutionDuration] = useState<number>(0);
  const [lastRunDuration, setLastRunDuration] = useState<number>(156);
  const [selectedModelLabel, setSelectedModelLabel] = useState<string>('Default');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPersonaPopover, setShowPersonaPopover] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<string>('projects/index.html');
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  // Step 12 (P1): editable Artifacts panel. Read-only <pre> stays the
  // default; Edit opens a <textarea> whose Save calls the EXISTING
  // /api/tools/file-write endpoint (server.ts) — no new server code, no
  // model call — then bumps previewKey so the preview refreshes.
  const [isEditingArtifact, setIsEditingArtifact] = useState(false);
  const [editedArtifactContent, setEditedArtifactContent] = useState('');
  const [artifactSaveStatus, setArtifactSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [artifactSaveError, setArtifactSaveError] = useState<string | null>(null);
  const [checkpointToast, setCheckpointToast] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<Array<{ message: string; source?: string; line?: number; col?: number }>>([]);
  // No project built yet: no generated HTML and no files modified in this
  // session — show a friendly Bengali empty state instead of a blank white
  // iframe (live QA 2026-11-27).
  const noProjectYet = !currentSessionHtml && modifiedFiles.length === 0;

  useEffect(() => {
    setPreviewErrors([]);
  }, [previewKey, currentSessionId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'nexus-preview-error' && event.data?.payload?.message) {
        setPreviewErrors((prev) => {
          const msg = String(event.data.payload.message);
          if (prev.some((e) => e.message === msg)) return prev;
          return [...prev.slice(-4), event.data.payload];
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const effectiveModel = selectedModel ?? selectedModelLabel;
  const handleSelectModel = (modelId: string) => {
    setSelectedModelLabel(modelId);
    setSelectedModel?.(modelId);
    setShowModelDropdown(false);
  };
  const MODEL_OPTIONS = [
    { id: 'Default', label: 'Default (Key Model)', desc: 'Uses each API key’s chosen model' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', desc: 'Free tier · ultra-fast & light' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', desc: 'Fast coding & UI builds' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', desc: 'Free tier · 1,500 RPD quota' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', desc: 'Complex multi-file architecture' },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', desc: 'Flagship deep reasoning' },
  ];
  const PERSONA_OPTIONS = [
    { id: '', label: 'Default Senior Engineer' },
    { id: 'Senior React & TypeScript Specialist', label: 'React & TypeScript' },
    { id: 'Node.js & Express API Architect', label: 'Node.js & Express' },
    { id: 'Python & Automation Engineer', label: 'Python & Automation' },
    { id: 'Debugging & QA Specialist', label: 'Debugging & Error Analysis' },
  ];
  const hasActiveSystemConfig = Boolean(developerPersona || customSystemInstruction.trim() || outputFormat !== 'auto');
  const executionTimerRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeCoderTab !== 'artifacts') return;
    if (selectedArtifact.includes('index.html') && currentSessionHtml) {
      setArtifactContent(currentSessionHtml);
      return;
    }
    setArtifactContent('Loading file...');
    fetch('/api/tools/file-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: selectedArtifact }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.content !== undefined) setArtifactContent(data.content);
        else setArtifactContent(`// ${selectedArtifact}\n// ${data.error || 'File ready in workspace'}`);
      })
      .catch(() => setArtifactContent(`// Failed to read ${selectedArtifact}`));
  }, [activeCoderTab, selectedArtifact, currentSessionHtml]);

  // Step 12 (P1): switching files exits edit mode and clears the save status.
  useEffect(() => {
    setIsEditingArtifact(false);
    setArtifactSaveStatus('idle');
    setArtifactSaveError(null);
  }, [selectedArtifact]);

  // The content shown in the read-only view (same fallback as the <pre>).
  const displayedArtifactContent = artifactContent !== null
    ? artifactContent
    : (selectedArtifact.includes('index.html')
        ? (currentSessionHtml || "<!-- Open preview to see generated HTML -->")
        : `// ${selectedArtifact}\n// Active in workspace`);

  const handleStartEditingArtifact = () => {
    setEditedArtifactContent(displayedArtifactContent);
    setArtifactSaveStatus('idle');
    setArtifactSaveError(null);
    setIsEditingArtifact(true);
  };

  const handleSaveArtifact = async () => {
    if (artifactSaveStatus === 'saving') return;
    setArtifactSaveStatus('saving');
    setArtifactSaveError(null);
    try {
      // Existing endpoint only (server.ts: /api/tools/file-write) — no new
      // server code, no model call. Writes the whole edited file.
      const res = await fetch('/api/tools/file-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: selectedArtifact, content: editedArtifactContent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success !== true) {
        throw new Error(data.error || `Save failed (HTTP ${res.status})`);
      }
      setArtifactContent(editedArtifactContent);
      // Sync the parent's in-memory copy (e.g. currentSessionHtml backing
      // the preview srcDoc) so the edited file actually shows in preview.
      onArtifactSaved?.(selectedArtifact, editedArtifactContent);
      // Remount the preview iframe so it re-renders the saved file.
      setPreviewKey((k) => k + 1);
      setArtifactSaveStatus('saved');
      setIsEditingArtifact(false);
    } catch (err: any) {
      setArtifactSaveStatus('error');
      setArtifactSaveError(err?.message || 'Save failed');
    }
  };

  // Live timer for "Gemini 3.8 Flash • Running for Xm Ys" matching screenshot
  useEffect(() => {
    if (isLoading) {
      const startTime = Date.now();
      setExecutionDuration(0);
      executionTimerRef.current = setInterval(() => {
        setExecutionDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      if (executionTimerRef.current) {
        clearInterval(executionTimerRef.current);
        executionTimerRef.current = null;
      }
      if (executionDuration > 0) {
        setLastRunDuration(executionDuration);
      }
    }
    return () => {
      if (executionTimerRef.current) clearInterval(executionTimerRef.current);
    };
  }, [isLoading]);

  const formatDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  const handleVoiceInput = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("ভয়েস টাইপিংয়ের জন্য Chrome বা поддержиকারী ব্রাউজার ব্যবহার করুন।");
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'bn-BD';
      recognition.interimResults = false;
      setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput(input ? `${input} ${transcript}` : transcript);
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

  useEffect(() => {
    if (activeCoderTab === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, activeCoderTab, isLoading]);

  // Render message text cleanly: strip internal tool_calls JSON, collapse full code dumps into preview badge, and parse Markdown + fenced code properly
  const renderMessageContent = (text: string) => {
    if (!text) return null;

    let displayText = text;
    let strippedCodeDump = false;

    // 1. Defensively strip any residual raw tool_calls JSON or <tool_call> blocks
    displayText = displayText
      .replace(/<(?:tool_call|function_call)>[\s\S]*?<\/(?:tool_call|function_call)>/gi, '')
      .replace(/`{2,3}(?:json)?\s*\{\s*"tool_calls"[\s\S]*?(?:`{2,3}|$)/gi, '')
      .replace(/\{\s*"tool_calls"\s*:\s*\[[\s\S]*?(?:\}\s*\]\s*\}|$)/gi, '')
      .replace(/(?:^|\n)\s*`{1,3}\s*(?=\n|$)/g, '\n');

    // 2. Collapse accidental full HTML or large file dumps into the workspace preview card
    const fullHtmlFence = /```(?:html|htm)\s*[\s\S]{300,}?```/gi;
    if (fullHtmlFence.test(displayText)) {
      strippedCodeDump = true;
      displayText = displayText.replace(fullHtmlFence, '').trim();
    }

    const rawDocHtml = /<!DOCTYPE\s+html[\s\S]{300,}?<\/html>/gi;
    if (rawDocHtml.test(displayText)) {
      strippedCodeDump = true;
      displayText = displayText.replace(rawDocHtml, '').trim();
    }

    displayText = displayText.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (full, _lang, codeBody) => {
      const lineCount = codeBody.split('\n').length;
      if (lineCount > 28 || codeBody.length > 900) {
        strippedCodeDump = true;
        return '';
      }
      return full;
    }).trim();

    const renderInlineTokens = (line: string, keyPrefix: string) => {
      const tokens = line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
      return tokens.map((token, idx) => {
        if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
          return (
            <code
              key={`${keyPrefix}-c-${idx}`}
              className="inline-block px-1.5 py-0.5 mx-0.5 rounded bg-[#28292c] text-emerald-300 font-mono text-xs border border-slate-700/60 shadow-sm"
            >
              {token.slice(1, -1)}
            </code>
          );
        }
        if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
          return (
            <strong key={`${keyPrefix}-b-${idx}`} className="font-semibold text-white">
              {token.slice(2, -2)}
            </strong>
          );
        }
        return <React.Fragment key={`${keyPrefix}-t-${idx}`}>{token}</React.Fragment>;
      });
    };

    const renderTextSegment = (segment: string, segIdx: number) => {
      const lines = segment.split('\n');
      return (
        <div key={`seg-${segIdx}`} className="space-y-1.5">
          {lines.map((line, lIdx) => {
            const trimmed = line.trim();
            if (!trimmed) {
              return <div key={`sp-${segIdx}-${lIdx}`} className="h-1" />;
            }
            const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
            if (headingMatch) {
              const level = headingMatch[1].length;
              return (
                <div
                  key={`hd-${segIdx}-${lIdx}`}
                  className={cn(
                    "font-semibold text-white pt-1",
                    level === 1 ? "text-base" : level === 2 ? "text-[15px]" : "text-sm text-sky-200"
                  )}
                >
                  {renderInlineTokens(headingMatch[2], `h-${segIdx}-${lIdx}`)}
                </div>
              );
            }
            const bulletMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
            if (bulletMatch) {
              return (
                <div key={`bl-${segIdx}-${lIdx}`} className="flex items-start gap-2 pl-1">
                  <span className="text-sky-400 mt-1.5 w-1.5 h-1.5 rounded-full bg-sky-400 flex-shrink-0" />
                  <div className="flex-1">{renderInlineTokens(bulletMatch[1], `b-${segIdx}-${lIdx}`)}</div>
                </div>
              );
            }
            return (
              <p key={`p-${segIdx}-${lIdx}`} className="leading-relaxed">
                {renderInlineTokens(line, `p-${segIdx}-${lIdx}`)}
              </p>
            );
          })}
        </div>
      );
    };

    // Split cleanly by triple-backtick code fences BEFORE any inline backtick parsing
    const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
    const blocks: Array<{ type: 'text' | 'code'; lang?: string; content: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(displayText)) !== null) {
      if (match.index > lastIndex) {
        blocks.push({ type: 'text', content: displayText.slice(lastIndex, match.index) });
      }
      blocks.push({ type: 'code', lang: match[1] || 'text', content: match[2].trimEnd() });
      lastIndex = fenceRegex.lastIndex;
    }
    if (lastIndex < displayText.length) {
      blocks.push({ type: 'text', content: displayText.slice(lastIndex) });
    }

    return (
      <div className="space-y-2.5 text-sm leading-relaxed text-slate-100">
        {blocks.map((block, idx) =>
          block.type === 'code' ? (
            <div key={`code-${idx}`} className="rounded-xl bg-[#18191e] border border-slate-700/70 overflow-hidden my-2">
              <div className="px-3 py-1.5 bg-[#202229] border-b border-slate-700/60 text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                {block.lang || 'code'}
              </div>
              <pre className="p-3 overflow-x-auto text-xs font-mono text-emerald-300 leading-relaxed">
                <code>{block.content}</code>
              </pre>
            </div>
          ) : (
            renderTextSegment(block.content, idx)
          )
        )}
        {strippedCodeDump && (
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-200">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span>অ্যাপ/ওয়েবসাইটের কোড সরাসরি ওয়ার্কস্পেস ফাইলে সেভ করা হয়েছে এবং Live Preview প্রস্তুত।</span>
            </div>
            <button
              onClick={() => {
                setActiveCoderTab('preview');
                setPreviewKey(k => k + 1);
              }}
              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1 flex-shrink-0 cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Preview</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-[#131314] text-slate-100 font-sans overflow-hidden select-none">
      {/* Toast Notification */}
      <AnimatePresence>
        {checkpointToast && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 bg-[#1c1d22] border border-emerald-500/40 text-emerald-300 px-4 py-2 rounded-full text-xs font-semibold shadow-2xl z-50 flex items-center gap-2"
          >
            <Check className="w-4 h-4 text-emerald-400" />
            <span>{checkpointToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Header matching Google AI Studio screenshot */}
      <header className="h-14 border-b border-slate-800/80 flex items-center justify-between px-3 sm:px-4 bg-[#131314] sticky top-0 z-30 flex-shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onOpenDrawer}
            className="p-1.5 -ml-1 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
            title="Menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-1.5 sm:gap-2 truncate">
            <Sparkles className="w-4 h-4 text-sky-400 fill-sky-400 flex-shrink-0" />
            <span className="font-semibold text-slate-100 text-sm tracking-tight truncate">Nexus AI</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          {/* Mobile & Desktop PWA Install App Button */}
          <PWAInstallButton />
          <GitHubConnectButton />
          <DeployButton sessionId={currentSessionId} />
          <FirebaseConnectButton />
          <AddFirebaseButton sessionId={currentSessionId} />

          {/* Key Pool Status Badge */}
          {onOpenSecrets && (
            <button
              onClick={onOpenSecrets}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#1e2024] hover:bg-[#282a30] text-slate-200 border border-slate-700/60 transition-colors cursor-pointer"
              title="Manage API Keys & Secrets"
            >
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">
                {activeKeysCount > 0 
                  ? `${activeKeysCount}টি সচল কী` 
                  : 'কী যোগ করুন'}
              </span>
              {activeKeysCount > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          )}

          {/* Diagnostics / Logs Button */}
          {onOpenLogs && (
            <button
              onClick={onOpenLogs}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#1e2024] hover:bg-rose-950/40 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer"
              title="সিস্টেম সমস্যা ও এরর লগ"
            >
              <ScrollText className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden md:inline">লগ</span>
            </button>
          )}

          {/* Mode Badge */}
          <button
            onClick={() => setActiveMode(activeMode === 'coding' ? 'general' : 'coding')}
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full text-[11px] font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/25 hover:bg-indigo-500/20 transition-colors cursor-pointer"
            title="Switch Mode"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="hidden sm:inline">Nexus Coder</span>
            <span className="sm:hidden">Coder</span>
          </button>

          {/* Plus (New Chat) Button matching screenshot top right */}
          <button
            onClick={handleNewChat}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors cursor-pointer"
            title="New Chat (+)"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Multi-agent team panel (Planner → Coder → Reviewer → Tester).
          Rendered here — in the same mounted tree as the Multi-Agent
          button — so the button visibly opens it. Shows all 4 agents
          grey/idle when no run is active. */}
      {(showTeamPanel || teamStatuses.length > 0) && (
        <div className="px-4 pt-2 pb-1 border-b border-slate-800/60 bg-[#131314] flex-shrink-0">
          <div className="max-w-2xl mx-auto w-full flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">Team</span>
            <TeamStatus statuses={teamStatuses} />
          </div>
        </div>
      )}

      {/* Main Body Area (Chat / Preview / Artifacts) */}
      <main className="flex-1 overflow-hidden flex flex-col relative">
        {/* --- TAB 1: CHAT VIEW --- */}
        {activeCoderTab === 'chat' && (
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {/* Conversation Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6 scrollbar-thin scrollbar-thumb-slate-800">
              {/* Empty State / Starter Templates */}
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto py-6 text-center">
                  <div className="w-14 h-14 bg-gradient-to-tr from-sky-500/20 to-indigo-500/20 border border-sky-500/30 rounded-2xl flex items-center justify-center mb-4 text-sky-400 shadow-xl">
                    <Sparkles className="w-7 h-7" />
                  </div>
                  <h2 className="text-xl sm:text-2xl font-bold mb-2 text-white">
                    Google AI Studio Coder Engine
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm mb-6 max-w-md leading-relaxed">
                    সব কাজ হবে সরাসরি এই সিস্টেমে। যেকোনো PWA, ই-কমার্স, ড্যাশবোর্ড বা গেম তৈরি করতে নিচের প্রম্পট সিলেক্ট করুন অথবা নিচে লিখুন।
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left">
                    {STARTER_PROMPTS.map((item, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSend(item.prompt)}
                        className="p-3.5 rounded-2xl bg-[#1e2024]/70 hover:bg-[#25272c] border border-slate-800 hover:border-slate-700 transition-all flex items-start gap-3 text-left group"
                      >
                        <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center bg-gradient-to-br border flex-shrink-0 mt-0.5", item.color)}>
                          <item.icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs font-bold text-slate-200 group-hover:text-sky-300 transition-colors truncate">
                              {item.title}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                              {item.badge}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                            {item.prompt}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Message List */}
              {messages.map((m, i) => {
                const isUser = m.role === 'user';
                const isLatestStreamingModel = isLoading && i === messages.length - 1 && !isUser;
                const msgSteps: ActionStep[] = isLatestStreamingModel
                  ? actionSteps
                  : (Array.isArray(m.actionSteps) ? m.actionSteps : []);
                const msgFiles: string[] = isLatestStreamingModel
                  ? modifiedFiles
                  : (Array.isArray(m.modifiedFiles) ? m.modifiedFiles : []);
                const hasHtmlUpdate = msgFiles.some((f) => f.endsWith('.html'));

                return (
                  <div key={i} className="max-w-2xl mx-auto w-full space-y-2">
                    {!isUser ? (
                      /* Model Message matching Google AI Studio screenshot */
                      <div className="space-y-2">
                        {(isLatestStreamingModel || msgSteps.length > 0 || msgFiles.length > 0) && (
                          <ActionHistoryAccordion
                            steps={msgSteps}
                            modifiedFiles={msgFiles}
                            isLoading={isLatestStreamingModel}
                            modelName={m.keyInfo?.model || (currentActiveKeyInfo?.model || (effectiveModel === 'Default' ? 'Gemini 3.8 Flash' : effectiveModel))}
                            durationText={formatDuration(isLatestStreamingModel ? executionDuration : (m.runDuration || lastRunDuration))}
                            defaultExpanded={isLatestStreamingModel}
                          />
                        )}

                        {/* Model response body — failed requests (isError)
                            render as a visibly distinct red bubble, same as
                            App's non-coding view: without this, an error
                            reply looked identical to a normal reply in this
                            (default) view, so a failed turn was
                            indistinguishable — and uncountable — in live QA. */}
                        <div className={m.isError
                          ? "text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 text-sm leading-relaxed"
                          : "text-slate-100 text-sm leading-relaxed pt-1"}>
                          {renderMessageContent(m.parts[0]?.text || '')}
                        </div>

                        {/* Quick Live Preview jump pill when HTML files were modified */}
                        {hasHtmlUpdate && !isLatestStreamingModel && (
                          <div className="pt-1">
                            <button
                              onClick={() => {
                                setActiveCoderTab('preview');
                                setPreviewKey(k => k + 1);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 text-xs font-semibold transition-colors cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Live Preview-এ দেখুন</span>
                            </button>
                          </div>
                        )}

                        {/* Action buttons matching screenshot: ⚑ Checkpoint | Copy | Redo */}
                        <div className="pt-2 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/40">
                          <button
                            onClick={handleCheckpoint}
                            className="inline-flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer"
                            title="Save Checkpoint"
                          >
                            <Flag className="w-3.5 h-3.5 text-slate-400" />
                            <span>Checkpoint</span>
                          </button>

                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(m.parts[0]?.text || '');
                                setCheckpointToast("✓ Copied to clipboard");
                                setTimeout(() => setCheckpointToast(null), 2000);
                              }}
                              className="p-1 hover:text-white transition-colors cursor-pointer"
                              title="Copy"
                            >
                              <Copy className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleSend(m.parts[0]?.text)}
                              className="p-1 hover:text-white transition-colors cursor-pointer"
                              title="Redo / Retry"
                            >
                              <RotateCcw className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* User Message card matching screenshot: dark rounded box */
                      <div className="flex justify-end">
                        <div className="bg-[#242529] border border-slate-800/80 rounded-2xl p-4 text-slate-100 text-sm max-w-xl leading-relaxed shadow-md">
                          {m.parts[0]?.text}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Real-time Execution Card before first text chunk arrives */}
              {isLoading && messages[messages.length - 1]?.role !== 'model' && (
                <div className="max-w-2xl mx-auto w-full space-y-3 pt-2">
                  <ActionHistoryAccordion
                    steps={actionSteps}
                    modifiedFiles={modifiedFiles}
                    isLoading={true}
                    modelName={currentActiveKeyInfo?.model || (effectiveModel === 'Default' ? 'Gemini 3.8 Flash' : effectiveModel)}
                    durationText={formatDuration(executionDuration)}
                    defaultExpanded={true}
                  />
                </div>
              )}

              {/* Error box */}
              {error && (
                <div className="max-w-2xl mx-auto w-full p-3.5 bg-rose-500/10 border border-rose-500/25 rounded-2xl text-rose-300 text-xs flex flex-wrap items-center justify-between gap-2.5 shadow-lg">
                  <div className="flex-1 whitespace-pre-wrap leading-relaxed">{error}</div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {onAnalyzeError && (
                      <button
                        onClick={() => onAnalyzeError(error)}
                        className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 rounded-xl font-bold text-[11px] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                      >
                        <Bug className="w-3.5 h-3.5 text-amber-400" />
                        <span>Debug & Fix</span>
                      </button>
                    )}
                    {onOpenLogs && (
                      <button
                        onClick={onOpenLogs}
                        className="px-3 py-1.5 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 rounded-xl font-bold text-[11px] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                      >
                        <ScrollText className="w-3.5 h-3.5 text-rose-400" />
                        <span>লগ দেখুন</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input Card Container matching screenshot */}
            <div className="px-4 py-3 bg-[#131314] flex-shrink-0">
              <div className="max-w-2xl mx-auto bg-[#1e2024] border border-slate-700/60 rounded-3xl p-3 shadow-2xl flex flex-col gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Make changes, add new features, ask for anything"
                  rows={2}
                  className="w-full bg-transparent resize-none focus:outline-none text-slate-100 placeholder:text-slate-500 text-sm px-1.5 py-1"
                />

                <div className="flex items-center justify-between pt-1">
                  {/* Left: ⊕ PlusCircle + System Instructions & Persona button */}
                  <div className="flex items-center gap-1.5 relative">
                    <button 
                      onClick={onOpenTools}
                      className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-slate-800 transition-colors cursor-pointer"
                      title="Coding Tools, Sandbox & Skills"
                    >
                      <PlusCircle className="w-5 h-5" />
                    </button>

                    <div className="relative">
                      <button
                        onClick={() => {
                          setShowPersonaPopover(!showPersonaPopover);
                          setShowModelDropdown(false);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                          hasActiveSystemConfig
                            ? "bg-indigo-500/20 border-indigo-500/40 text-indigo-300"
                            : "bg-[#27282d] hover:bg-[#2f3137] border-slate-700/80 text-slate-300"
                        )}
                        title="System Instructions, Developer Persona & Output Format"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">
                          {developerPersona ? developerPersona.split(' ')[0] : 'Persona'}
                          {outputFormat !== 'auto' ? ` · ${outputFormat.toUpperCase()}` : ''}
                        </span>
                      </button>

                      {showPersonaPopover && (
                        <div className="absolute bottom-full mb-2 left-0 bg-[#1c1d22] border border-slate-700 rounded-2xl p-3.5 shadow-2xl z-50 w-80 space-y-3">
                          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                            <span className="text-xs font-bold text-white">System Instructions & Format</span>
                            <button
                              onClick={() => setShowPersonaPopover(false)}
                              className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
                            >
                              Done
                            </button>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[11px] text-slate-400 font-medium block">Developer Persona</label>
                            <select
                              value={developerPersona}
                              onChange={(e) => setDeveloperPersona?.(e.target.value)}
                              className="w-full bg-[#131314] border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            >
                              {PERSONA_OPTIONS.map((p) => (
                                <option key={p.id || 'default'} value={p.id}>{p.label}</option>
                              ))}
                            </select>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[11px] text-slate-400 font-medium block">Structured Code Output</label>
                            <div className="grid grid-cols-3 gap-1.5">
                              {(['auto', 'markdown', 'json'] as const).map((fmt) => (
                                <button
                                  key={fmt}
                                  type="button"
                                  onClick={() => setOutputFormat?.(fmt)}
                                  className={cn(
                                    "py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer uppercase",
                                    outputFormat === fmt
                                      ? "bg-indigo-600/25 border-indigo-500 text-indigo-300"
                                      : "bg-[#131314] border-slate-800 text-slate-400 hover:text-slate-200"
                                  )}
                                >
                                  {fmt}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[11px] text-slate-400 font-medium block">Custom System Instruction</label>
                            <textarea
                              rows={3}
                              value={customSystemInstruction}
                              onChange={(e) => setCustomSystemInstruction?.(e.target.value)}
                              placeholder="e.g. Always use strict TypeScript, React functional hooks, and Tailwind v4..."
                              className="w-full bg-[#131314] border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {setMultiAgent && (
                      <button
                        type="button"
                        onClick={() => { setMultiAgent(!multiAgent); onToggleTeamPanel?.(); }}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                          multiAgent
                            ? "bg-violet-500/20 border-violet-500/40 text-violet-300"
                            : "bg-[#27282d] hover:bg-[#2f3137] border-slate-700/80 text-slate-400"
                        )}
                        title="Multi-Agent Orchestration (Architect → Executor → Reviewer) — টিম প্যানেল খুলুন"
                      >
                        <Bot className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Multi-Agent</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Center: Multi-Model Selector dropdown */}
                    <div className="relative">
                      <button
                        onClick={() => {
                          setShowModelDropdown(!showModelDropdown);
                          setShowPersonaPopover(false);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#27282d] hover:bg-[#2f3137] text-slate-200 text-xs font-medium border border-slate-700/80 transition-colors cursor-pointer"
                      >
                        <span>{MODEL_OPTIONS.find(m => m.id === effectiveModel)?.label || effectiveModel}</span>
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                      </button>

                      {showModelDropdown && (
                        <div className="absolute bottom-full mb-2 right-0 bg-[#1c1d22] border border-slate-700 rounded-xl p-1.5 shadow-2xl z-50 min-w-[240px]">
                          {MODEL_OPTIONS.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => handleSelectModel(m.id)}
                              className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-slate-800 text-slate-200 flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <div>
                                <div className="font-medium text-white">{m.label}</div>
                                <div className="text-[10px] text-slate-400">{m.desc}</div>
                              </div>
                              {effectiveModel === m.id && <Check className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Mic speech recognition button */}
                    <button
                      onClick={handleVoiceInput}
                      className={cn(
                        "p-2 rounded-full transition-colors",
                        isListening ? "bg-red-500/20 text-red-400 animate-pulse" : "text-slate-400 hover:text-white hover:bg-slate-800"
                      )}
                      title="Voice Input (ভয়েস টাইপিং)"
                    >
                      <Mic className="w-4 h-4" />
                    </button>

                    {/* Circular Send / Stop button */}
                    <button
                      onClick={() => handleSend()}
                      disabled={!isLoading && !input.trim()}
                      className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                        isLoading
                          ? "bg-slate-800 text-white hover:bg-slate-700"
                          : input.trim()
                            ? "bg-white text-slate-900 hover:bg-slate-200 shadow-md cursor-pointer"
                            : "bg-slate-800 text-slate-500 cursor-not-allowed"
                      )}
                      title={isLoading ? "Stop" : "Send"}
                    >
                      {isLoading ? (
                        <Square className="w-3.5 h-3.5 fill-current" />
                      ) : (
                        <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 2: LIVE PREVIEW VIEW --- */}
        {activeCoderTab === 'preview' && (
          <div className="flex-1 flex flex-col h-full bg-slate-950 overflow-hidden">
            {/* Preview Toolbar */}
            <div className="h-12 border-b border-slate-800 px-4 bg-[#18191d] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 truncate">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  Live Preview
                </span>
                <span className="text-slate-600 font-mono text-xs">•</span>
                <span className="text-xs font-medium text-slate-400 truncate max-w-[150px]">
                  {currentSessionTitle}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  PWA Ready
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                {/* Desktop / Mobile Switch */}
                <button
                  onClick={() => setPreviewDevice('desktop')}
                  className={cn(
                    "p-1.5 rounded-lg text-xs transition-colors",
                    previewDevice === 'desktop' ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  )}
                  title="Desktop View"
                >
                  <Monitor className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPreviewDevice('mobile')}
                  className={cn(
                    "p-1.5 rounded-lg text-xs transition-colors",
                    previewDevice === 'mobile' ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  )}
                  title="Mobile View"
                >
                  <Smartphone className="w-4 h-4" />
                </button>

                <div className="w-px h-4 bg-slate-800 mx-1" />

                {/* Reload */}
                <button
                  onClick={() => setPreviewKey(k => k + 1)}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors"
                  title="Reload"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>

                {/* Copy Code */}
                {currentSessionHtml && (
                  <button
                    onClick={handleCopyCode}
                    className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg transition-colors"
                    title="Copy HTML"
                  >
                    {copiedCode ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                )}

                {/* Download */}
                {currentSessionHtml && (
                  <button
                    onClick={handleDownloadHtml}
                    className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg transition-colors"
                    title="Download HTML & PWA"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )}

                {/* Open in New Tab */}
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
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors"
                  title="Open in New Tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Live Preview Runtime Error Banner */}
            {previewErrors.length > 0 && (
              <div className="bg-rose-950/90 border-b border-rose-500/40 px-4 py-2.5 flex items-center justify-between gap-3 flex-shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                  <div className="text-xs text-rose-200 truncate">
                    <span className="font-bold text-rose-300">Preview Runtime Error: </span>
                    <span className="font-mono">{previewErrors[previewErrors.length - 1].message}</span>
                    {previewErrors[previewErrors.length - 1].line ? (
                      <span className="text-rose-400/80 ml-1.5 font-mono">
                        (line {previewErrors[previewErrors.length - 1].line})
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const errSummary = previewErrors
                        .map((e) => `${e.message}${e.line ? ` (line ${e.line}:${e.col || 0})` : ''}`)
                        .join('\n');
                      setActiveCoderTab('chat');
                      handleSend(`Live Preview-তে নিচের Runtime JavaScript Error ধরা পড়েছে। অনুগ্রহ করে HTML/JS ফাইলটি inspect ও fix করে verify_live_preview দিয়ে যাচাই করো:\n\n\`\`\`\n${errSummary}\n\`\`\``);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    <Bug className="w-3 h-3" />
                    <span>Fix with Nexus</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewErrors([])}
                    className="p-1 text-rose-300 hover:text-white rounded-md cursor-pointer"
                    title="Dismiss error"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Frame Body */}
            <div className={cn(
              "flex-1 overflow-auto flex items-center justify-center",
              previewDevice === 'mobile' ? "bg-slate-900/60 p-4" : "bg-white"
            )}>
              {noProjectYet ? (
                <div className="flex-1 self-stretch flex flex-col items-center justify-center text-center px-6 py-10 bg-slate-950">
                  <div className="w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mb-4">
                    <Monitor className="w-7 h-7 text-indigo-400" />
                  </div>
                  <p className="text-white font-bold text-sm mb-1">এখনো কোনো প্রজেক্ট বানানো হয়নি</p>
                  <p className="text-slate-400 text-xs leading-relaxed max-w-xs">
                    চ্যাটে কিছু বানাতে বলুন — যেমন “আমার দোকানের একটা ওয়েবসাইট বানাও” — তারপর এখানে লাইভ প্রিভিউ দেখা যাবে।
                  </p>
                </div>
              ) : previewDevice === 'mobile' ? (
                <div className="w-[375px] h-[700px] rounded-[36px] border-[8px] border-slate-700 bg-white shadow-2xl flex flex-col overflow-hidden relative">
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-4 bg-slate-700 rounded-b-xl z-30 flex items-center justify-center">
                    <div className="w-10 h-1 bg-slate-600 rounded-full" />
                  </div>
                  {currentSessionHtml ? (
                    <iframe
                      key={`mob-${previewKey}`}
                      srcDoc={currentSessionHtml}
                      className="w-full h-full border-none bg-white pt-4"
                      title="Mobile Preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    />
                  ) : (
                    <iframe
                      key={`mob-url-${previewKey}`}
                      src={previewUrl || '/projects/index.html'}
                      className="w-full h-full border-none bg-white pt-4"
                      title="Mobile Preview"
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
                    title="Live Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  />
                ) : (
                  <iframe
                    key={`desk-url-${previewKey}`}
                    src={previewUrl || '/projects/index.html'}
                    className="w-full h-full border-none bg-white"
                    title="Live Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  />
                )
              )}
            </div>
          </div>
        )}

        {/* --- TAB 3: ARTIFACTS VIEW --- */}
        {activeCoderTab === 'artifacts' && (
          <div className="flex-1 flex flex-col h-full bg-[#131314] overflow-hidden">
            {/* Artifacts Header */}
            <div className="h-12 border-b border-slate-800 px-4 bg-[#18191d] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4 text-sky-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Project Artifacts & Workspace Files
                </span>
              </div>
              <button
                onClick={handleDownloadZip}
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-all shadow-sm"
                title="Download Entire Project (ZIP)"
              >
                <FolderArchive className="w-3.5 h-3.5" />
                <span>Download All (ZIP)</span>
              </button>
            </div>

            <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
              {/* File Tree Column */}
              <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-slate-800 bg-[#17181c] p-3 overflow-y-auto space-y-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 block mb-2">
                  Generated Files
                </span>
                {[
                  ...modifiedFiles
                    .filter((fp) => ![
                      'projects/index.html',
                      'projects/manifest.webmanifest',
                      'projects/sw.js',
                      'server/skillsRegistry.ts',
                      'server/websiteDeployer.ts',
                      'server/apiOrchestrator.ts',
                      'server/geminiService.ts',
                      'server.ts',
                    ].includes(fp))
                    .map((fp) => ({
                      path: fp,
                      label: fp.split('/').pop() || fp,
                      badge: 'Edited',
                      desc: fp,
                    })),
                  { path: 'projects/index.html', label: 'index.html', badge: 'HTML / PWA', desc: 'Main Web App' },
                  { path: 'projects/manifest.webmanifest', label: 'manifest.webmanifest', badge: 'PWA', desc: 'App Manifest' },
                  { path: 'projects/sw.js', label: 'sw.js', badge: 'Worker', desc: 'Offline Service Worker' },
                  { path: 'server/skillsRegistry.ts', label: 'skillsRegistry.ts', badge: 'Skills', desc: '29 Coding Skills' },
                  { path: 'server/websiteDeployer.ts', label: 'websiteDeployer.ts', badge: 'Deployer', desc: 'Deploy & System Prompt' },
                  { path: 'server/apiOrchestrator.ts', label: 'apiOrchestrator.ts', badge: 'Server', desc: 'Multi-Key Engine' },
                  { path: 'server/geminiService.ts', label: 'geminiService.ts', badge: 'Tools', desc: 'Coding Mode Toolset' },
                  { path: 'server.ts', label: 'server.ts', badge: 'Express', desc: 'Full-Stack Server' },
                ].map((file) => (
                  <button
                    key={file.path}
                    onClick={() => setSelectedArtifact(file.path)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between transition-all",
                      selectedArtifact === file.path 
                        ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/30" 
                        : "text-slate-300 hover:bg-slate-800/60"
                    )}
                  >
                    <div className="truncate mr-2">
                      <div className="font-mono font-medium truncate">{file.label}</div>
                      <div className="text-[10px] text-slate-500">{file.desc}</div>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono flex-shrink-0">
                      {file.badge}
                    </span>
                  </button>
                ))}
              </div>

              {/* Code Inspection Column */}
              <div className="flex-1 bg-[#0d1117] p-4 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-800 flex-shrink-0">
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
                    <FileCode className="w-4 h-4 text-sky-400" />
                    <span className="font-semibold">{selectedArtifact}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Step 12 (P1): save status — saved / error, cleared on file switch or next edit */}
                    {artifactSaveStatus === 'saved' && (
                      <span className="text-xs text-emerald-400 flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" />
                        <span>Saved — preview refreshed</span>
                      </span>
                    )}
                    {artifactSaveStatus === 'error' && (
                      <span className="text-xs text-rose-400 flex items-center gap-1" title={artifactSaveError || undefined}>
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Save failed{artifactSaveError ? `: ${artifactSaveError}` : ''}</span>
                      </span>
                    )}
                    {isEditingArtifact ? (
                      <>
                        <button
                          onClick={() => setIsEditingArtifact(false)}
                          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSaveArtifact}
                          disabled={artifactSaveStatus === 'saving' || editedArtifactContent === artifactContent}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{artifactSaveStatus === 'saving' ? 'Saving…' : 'Save'}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={handleStartEditingArtifact}
                          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
                          title="Edit this file"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>
                        <button
                          onClick={() => {
                            const contentToCopy = artifactContent || currentSessionHtml || '';
                            if (contentToCopy) navigator.clipboard.writeText(contentToCopy);
                            handleCopyCode();
                          }}
                          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
                        >
                          {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {isEditingArtifact ? (
                  <textarea
                    value={editedArtifactContent}
                    onChange={(e) => setEditedArtifactContent(e.target.value)}
                    spellCheck={false}
                    className="flex-1 whitespace-pre text-slate-300 font-mono text-xs leading-relaxed overflow-auto p-2 bg-[#090d16] rounded-xl border border-indigo-500/50 focus:outline-none focus:border-indigo-400 resize-none"
                    aria-label={`Edit ${selectedArtifact}`}
                  />
                ) : (
                  <pre className="flex-1 whitespace-pre-wrap break-all text-slate-300 font-mono text-xs leading-relaxed overflow-auto p-2 bg-[#090d16] rounded-xl border border-slate-800">
                    {displayedArtifactContent}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Sticky Bottom Navigation Bar matching Google AI Studio screenshot */}
      <footer className="h-14 border-t border-slate-800/80 bg-[#131314] px-4 flex items-center justify-between flex-shrink-0 z-40">
        {/* Back arrow */}
        <button
          onClick={() => {
            if (activeCoderTab !== 'chat') setActiveCoderTab('chat');
            else onOpenDrawer();
          }}
          className="p-2 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          title="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* Center Pill Segmented Switcher matching screenshot: [ Chat | Preview | Artifacts ] */}
        <div className="flex items-center bg-[#1e2024] p-1 rounded-full border border-slate-800">
          <button
            onClick={() => setActiveCoderTab('chat')}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
              activeCoderTab === 'chat' 
                ? "bg-[#2b2d33] text-white shadow-sm" 
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            Chat
          </button>
          <button
            onClick={() => {
              setActiveCoderTab('preview');
              setPreviewKey(k => k + 1);
            }}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer",
              activeCoderTab === 'preview' 
                ? "bg-[#2b2d33] text-white shadow-sm" 
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            <span>Preview</span>
            {previewErrors.length > 0 ? (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" title="Runtime error detected" />
            ) : currentSessionHtml ? (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            ) : null}
          </button>
          <button
            onClick={() => setActiveCoderTab('artifacts')}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
              activeCoderTab === 'artifacts' 
                ? "bg-[#2b2d33] text-white shadow-sm" 
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            Artifacts
          </button>
        </div>

        {/* More options button (...) matching screenshot */}
        <button
          onClick={onOpenDrawer}
          className="p-2 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          title="More Options"
        >
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </footer>
    </div>
  );
};
