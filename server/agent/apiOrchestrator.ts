import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import type { Response } from "express";
import { serverTools, executeServerTool, CORE_TOOL_NAMES, filterCoreTools, type ToolExecutionContext } from "./geminiService.ts";
import { matchSkillsForPrompt } from "./skillsRegistry.ts";
import { autoDeployWebsiteFromText, getNexusSystemInstruction, prepareGeminiHistoryAndLastMessage, type SystemInstructionOptions } from "./websiteDeployer.ts";
import { routeTurnModel, turnReasoningEffort, classifyTask, pickPlanningEffort, planningChain, cheapChain, codingChain, chatOnce, chatChain, type PlanningEffort } from "./llmClient.ts";
import { getRouterApiKey, NO_PROVIDER_KEYS_MESSAGE, NO_PROVIDER_KEYS_CODE } from "../router/keys.ts";
import { decideIntent, CASUAL_SYSTEM } from "./intentGate.ts";
import { matchDirectCommand, matchBrowserWork, getCachedToolResult, setCachedToolResult, applyDirectEdit } from "./directTools.ts";
import { buildCacheKey, getBuildCacheEntry, setBuildCacheEntry, normalizeBuildPrompt, BUILD_CACHE_MAX_HTML_BYTES } from "./buildCache.ts";
import { readUserMemory, saveChatTurn, loadChat, listProjects, listChats } from "./memory.ts";
import { splitHistoryWindow, ensureRollingSummary, summaryTurn } from "./historyWindow.ts";
import { readLessons, recordLesson } from "./lessons.ts";
import { newTurnUsage, addLlmStep, addToolCall, usageTotals, recordTurnUsage, costTierOfModel, estimateTokens, toolsSchemaTokensEstimate, sessionUsageSummary, type TurnUsage } from "./usage.ts";
import { parseSseUsageChunk } from "../router/index.ts";
import { tryRunParallelBuild, clearParallelBuildForSession } from "./parallelBuild.ts";
import { describeImage, asksAboutImage } from "./vision.ts";
import { CODING_SKILLS_REGISTRY } from "./skillsRegistry.ts";
import {
  getChainForTask, nextAfterFailure, noteModelAttempt, recordModelSuccess, recordModelFailure,
  parseRetryAfter, tierOfModel, degradationBetween, handoffNote, isModelLive, isModelExcluded,
  classifyRateLimit, limitLabel, nextMidnightPacificMs, firstOpenRouterFreeModel, type TaskKind, type RateLimitKind,
} from "./modelChain.ts";

export type ApiProviderId = 'gemini' | 'openrouter' | 'groq' | 'cerebras' | 'mistral' | 'grok' | 'custom' | 'freellmapi';

export interface KeyConfig {
  id: string;
  provider: ApiProviderId;
  name: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  isActive: boolean;
  rpmLimit: number;
  status?: 'healthy' | 'cooldown' | 'error';
  lastError?: string | null;
}

interface KeyRuntimeStats {
  timestamps: number[]; // timestamps in last 60s
  cooldownUntil: number;
  totalRequests: number;
  lastError: string | null;
  lastUsedAt: number;
  /** Which budget the last 429 hit: rpm | tpm | rpd (null = no rate limit seen). */
  limitKind?: RateLimitKind | null;
  limitAt?: number;
  /** Midnight-Pacific reset time (ms epoch) when limitKind is rpd. */
  dailyResetAt?: number;
}

const keyStatsMap = new Map<string, KeyRuntimeStats>();

// ---------------------------------------------------------------------------
// Per-turn cancellation (Live Browser tab "Take over" + the Stop button).
// The frontend aborts its fetch AND POSTs /api/gemini/cancel; both land
// here. The agent loops check isTurnCancelled at every round boundary and
// stop issuing tool calls. A fresh turn clears its flag at start, so a
// cancel can never leak into the next turn. A client disconnect (fetch
// abort) marks the turn cancelled the same way — see handleOrchestratedChat.
// ---------------------------------------------------------------------------
const cancelledTurns = new Set<string>();

export function cancelTurn(sessionId: string): void {
  if (sessionId) cancelledTurns.add(sessionId);
}

export function isTurnCancelled(sessionId?: string): boolean {
  return !!sessionId && cancelledTurns.has(sessionId);
}

export function clearTurnCancellation(sessionId?: string): void {
  if (sessionId) cancelledTurns.delete(sessionId);
}

export interface SystemLogEntry {
  id: string;
  timestamp: number;
  level: 'error' | 'warn' | 'info' | 'success';
  category: 'auth' | 'rate_limit' | 'rotation' | 'execution' | 'network';
  keyName?: string;
  provider?: string;
  model?: string;
  message: string;
  details?: string;
}

const systemLogs: SystemLogEntry[] = [];
const MAX_LOGS = 200;

export function addSystemLog(log: Omit<SystemLogEntry, 'id' | 'timestamp'>) {
  const entry: SystemLogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...log
  };
  systemLogs.unshift(entry);
  if (systemLogs.length > MAX_LOGS) {
    systemLogs.pop();
  }
}

export function getSystemLogs(): SystemLogEntry[] {
  return systemLogs;
}

export function clearSystemLogs(): void {
  systemLogs.length = 0;
}

import fsSync from "fs";

// Track last successful responding key persistently so Nexus remembers and prioritizes it across turns & restarts
const STICKY_KEY_FILE = path.resolve(process.cwd(), '.nexus_sticky_key.json');
let lastSuccessfulKeyId: string | null = (() => {
  try {
    const raw = fsSync.readFileSync(STICKY_KEY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.keyId === 'string' ? parsed.keyId : null;
  } catch {
    return null;
  }
})();

export function getLastSuccessfulKeyId(): string | null {
  return lastSuccessfulKeyId;
}

function persistStickyKeyId(keyId: string | null) {
  lastSuccessfulKeyId = keyId;
  fs.writeFile(STICKY_KEY_FILE, JSON.stringify({ keyId, updatedAt: Date.now() }), 'utf-8').catch(() => {});
}

const SECRETS_FILE = path.resolve(process.cwd(), '.secrets.json');

export function getFreeLLMAPIUrl(): string {
  // MERGE: FREE_LLM_API_URL is now an OPTIONAL override for an external
  // FreeLLMAPI. Default is the embedded router on this same service
  // (http://127.0.0.1:<PORT>/v1) — one service, one port, no second deploy.
  const raw = (process.env.FREE_LLM_API_URL || '').trim().replace(/\/+$/, '');
  if (raw) return raw;
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}/v1`;
}

export function getFreeLLMAPIKey(): string {
  const env = (process.env.FREE_LLM_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (env) return env;
  // MERGE: no external key -> the internal router key (env ROUTER_API_KEY
  // when set, else a boot-generated key held in memory only).
  return getRouterApiKey();
}

export function getOpenAICompatibleEndpoint(provider: string, baseUrl?: string): string {
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  if (provider === 'groq') return 'https://api.groq.com/openai/v1/chat/completions';
  if (provider === 'cerebras') return 'https://api.cerebras.ai/v1/chat/completions';
  if (provider === 'mistral') return 'https://api.mistral.ai/v1/chat/completions';
  if (provider === 'grok') return 'https://api.x.ai/v1/chat/completions';
  if (provider === 'freellmapi') {
    // FreeLLMAPI router: OpenAI-compatible /v1/chat/completions with full
    // function calling (tools) support, incl. streaming tool_calls deltas.
    // Base URL comes from the key's baseUrl, else FREE_LLM_API_URL env,
    // else the local default http://localhost:3001/v1 (Termux or local dev).
    const clean = (baseUrl || getFreeLLMAPIUrl()).trim().replace(/\/+$/, '');
    if (clean.endsWith('/chat/completions')) return clean;
    if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
    return `${clean}/v1/chat/completions`;
  }
  const clean = (baseUrl || 'https://models.inference.ai.azure.com').trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export async function fetchLiveProviderModels(
  provider: string,
  apiKey?: string,
  baseUrl?: string
): Promise<Array<{ id: string; label: string; badge: string }>> {
  const curated: Record<string, Array<{ id: string; label: string; badge: string }>> = {
    gemini: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', badge: 'Free · Ultra Fast' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', badge: 'Free · Coding' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', badge: 'Free · 1500 RPD' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', badge: 'Pro · Architecture' },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', badge: 'Deep Reasoning' },
    ],
    openrouter: [
      { id: 'openrouter/free', label: 'OpenRouter Free Auto-Router', badge: 'Free · Auto' },
      { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder 480B (:free)', badge: 'Free · Coding' },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (:free)', badge: 'Free · Reasoning' },
      { id: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek Chat V3 (:free)', badge: 'Free · General' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B Instruct (:free)', badge: 'Free · 70B' },
      { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B (:free)', badge: 'Free · Google' },
      { id: 'mistralai/mistral-small-3.1-24b-instruct:free', label: 'Mistral Small 3.1 24B (:free)', badge: 'Free · Fast' },
    ],
    groq: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', badge: 'Free · Coding' },
      { id: 'qwen/qwen3-32b', label: 'Qwen 3 32B', badge: 'Free · Reasoning' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', badge: 'Free · Instant' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', badge: 'Free · 120B' },
    ],
    cerebras: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', badge: 'Free · Fast' },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', badge: 'Free · Coding' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B', badge: 'Free · Instant' },
    ],
    mistral: [
      { id: 'codestral-latest', label: 'Codestral Latest', badge: 'Free · Coding' },
      { id: 'mistral-small-latest', label: 'Mistral Small Latest', badge: 'Free · Fast' },
      { id: 'devstral-small-latest', label: 'Devstral Small', badge: 'Free · Agents' },
    ],
    grok: [
      { id: 'grok-2-latest', label: 'Grok 2 Latest', badge: 'Default' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', badge: 'Fast' },
    ],
    custom: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', badge: 'Custom' },
      { id: 'deepseek-r1', label: 'deepseek-r1', badge: 'Custom' },
      { id: 'qwen2.5-coder-32b-instruct', label: 'qwen2.5-coder-32b-instruct', badge: 'Custom' },
    ],
    freellmapi: [
      { id: 'auto:balanced', label: 'FreeLLMAPI Auto · Balanced (default)', badge: 'Free · Auto' },
      { id: 'auto:fast', label: 'FreeLLMAPI Auto · Fast', badge: 'Free · Fast' },
      { id: 'auto:smart', label: 'FreeLLMAPI Auto · Smart', badge: 'Free · Smart' },
      { id: 'auto:reliable', label: 'FreeLLMAPI Auto · Reliable', badge: 'Free · Reliable' },
      { id: 'auto:cheap', label: 'FreeLLMAPI Auto · Cheap', badge: 'Free · Cheap' },
    ],
  };

  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const rawModels: any[] = json.data || [];
        const freeModels = rawModels
          .filter(m => String(m.id || '').endsWith(':free') || m.id === 'openrouter/free' || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'))
          .slice(0, 40)
          .map(m => ({
            id: m.id,
            label: m.name || m.id,
            badge: 'Free · Live',
          }));
        if (freeModels.length > 0) {
          const hasAuto = freeModels.some(m => m.id === 'openrouter/free');
          return hasAuto
            ? freeModels
            : [{ id: 'openrouter/free', label: 'OpenRouter Free Auto-Router', badge: 'Free · Auto' }, ...freeModels];
        }
      }
    } else if (provider === 'gemini' && apiKey) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const live = (json.models || [])
          .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m: any) => {
            const id = String(m.name || '').replace(/^models\//, '');
            return { id, label: m.displayName || id, badge: 'Live · Gemini' };
          })
          .filter((m: any) => !m.id.includes('1.0') && !m.id.includes('1.5'));
        // STEP 16 (a): NO cap on the live list. The old `.slice(0, 25)`
        // silently dropped any free model past position 25; the full
        // live list is returned (paid/retired ids are dropped by the
        // caller's exclusion gate, never by position).
        if (live.length > 0) return live;
      }
    } else if (['groq', 'cerebras', 'mistral', 'grok', 'custom', 'freellmapi'].includes(provider) && apiKey) {
      const chatUrl = getOpenAICompatibleEndpoint(provider, baseUrl);
      const modelsUrl = chatUrl.replace(/\/chat\/completions$/, '/models');
      const res = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const list = (json.data || [])
          .map((m: any) => ({ id: m.id, label: m.id, badge: `Live · ${provider}` }))
          .slice(0, 35);
        if (list.length > 0) return list;
      }
    }
  } catch (err) {
    console.warn(`Live model fetch failed for ${provider}:`, err);
  }

  return curated[provider] || curated.custom;
}

// Normalize any model name according to active @google/genai & free provider guidelines
export function normalizeModelName(provider: string, model?: string): string {
  if (provider === 'gemini') {
    if (!model) return 'gemini-3.5-flash-lite';
    const lower = model.toLowerCase().trim();
    // Re-route deprecated 2.5/2.0/1.5 models to gemini-3.5-flash-lite
    if (
      lower.includes('1.5') ||
      lower.includes('2.0') ||
      lower.includes('2.5') ||
      lower.includes('gemini-pro') ||
      lower.includes('flash-latest') ||
      lower === 'gemini-flash'
    ) {
      return 'gemini-3.5-flash-lite';
    }
    const validGeminiModels = [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro',
      'gemini-4-hydrogen',
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-3.1-flash-lite-image',
      'gemini-nano-banana-2.1',
      'gemini-3-pro-image'
    ];
    // Live-discovered Gemini ids are valid as-is: the catalog is the
    // authority for which ids exist today. Without this, any newly
    // discovered id not in the hardcoded list above was silently renamed
    // (and a stored key model rewritten on every loadSecrets).
    if (isModelLive(model)) return model;
    if (validGeminiModels.includes(model)) return model;
    return model.startsWith('gemini-') ? model : 'gemini-3.8-flash';
  }
  if (provider === 'openrouter') {
    if (!model || model.trim() === '' || model.includes('gemini-2.0-flash-lite:free')) {
      return 'openrouter/free';
    }
    return model.trim();
  }
  if (provider === 'groq') {
    if (!model || model.trim() === '') return 'llama-3.3-70b-versatile';
    return model.trim();
  }
  if (provider === 'cerebras') {
    if (!model || model.trim() === '') return 'llama-3.3-70b';
    return model.trim();
  }
  if (provider === 'mistral') {
    if (!model || model.trim() === '') return 'codestral-latest';
    return model.trim();
  }
  if (provider === 'grok') {
    if (!model || model.trim() === '') return 'grok-2-latest';
    return model.trim();
  }
  if (provider === 'freellmapi') {
    // FreeLLMAPI router model strings: auto:<strategy> blends every enabled
    // free model (balanced = default), auto:<profile> uses a named chain,
    // or any explicit provider model id the router knows.
    if (!model || model.trim() === '') return 'auto:balanced';
    return model.trim();
  }
  if (provider === 'custom') {
    return (model || 'gpt-4o-mini').trim();
  }
  return model || '';
}

/**
 * All-keys-429 rule for the Gemini turn loop: drop to the next live Gemini
 * model ONLY when every Gemini key has already 429'd on this model this
 * turn; otherwise rotate keys on the SAME model. Pure function so the rule
 * is unit-testable (scripts/failover-proof.mts).
 */
export function shouldDropGeminiModel(hitKeyIds: Set<string>, allGeminiKeyIds: Set<string>): boolean {
  if (allGeminiKeyIds.size === 0) return false;
  for (const id of allGeminiKeyIds) if (!hitKeyIds.has(id)) return false;
  return true;
}

// STEP 16 (b): the primary model for the orchestrator's Gemini chain,
// gated by the SAME exclusion list the router uses (isModelExcluded).
// A key whose stored model is paid-only / retired (gemini-4-argon,
// gemini-4-carbon, *-pro-preview, media models) returns null, so
// buildGeminiModelChain falls back to the live/default list instead of
// attempting a model that can never succeed without billing. Pure
// function so the gate is unit-testable (scripts/step16-proof.mts).
export function gateGeminiPrimary(primary?: string | null): string | null {
  if (!primary) return null;
  return isModelExcluded(primary) ? null : primary;
}

// STEP 16 (c): the task class for a turn, derived from the user's own
// message — the same derivation the router uses (routeChatCompletion
// derives its task from the user messages instead of hardcoding one).
// The orchestrator's canonical classifier is classifyTask (llmClient):
// 'reasoning' maps to the 'planning' chain, exactly as
// streamOpenAICompatible already does. buildGeminiModelChain uses this
// instead of the hardcoded 'coding' it used to pass to getChainForTask,
// so a chat/reasoning turn now goes down its own quality-ordered chain
// instead of the coding chain. Pure function, unit-testable.
export function orchestratorTurnTask(prompt: string): TaskKind {
  const classified = classifyTask(prompt);
  return classified === 'reasoning' ? 'planning' : classified;
}

// Build the FreeLLMAPI key entry.
// MERGE: this entry ALWAYS exists now. With FREE_LLM_API_URL + FREE_LLM_API_KEY
// set it points at the external FreeLLMAPI; otherwise it points at the
// EMBEDDED router on this same service (internal URL + internal router key).
// FREE_LLM_API_MODEL = router model, default auto:balanced (free-only blend).
export function buildEnvFreeLLMAPIKey(): KeyConfig | null {
  const apiKey = getFreeLLMAPIKey();
  const external = Boolean((process.env.FREE_LLM_API_URL || '').trim() && (process.env.FREE_LLM_API_KEY || '').trim());
  return {
    id: 'env-freellmapi',
    provider: 'freellmapi',
    name: external ? 'FreeLLMAPI (external)' : 'Embedded router (internal)',
    apiKey,
    model: normalizeModelName('freellmapi', process.env.FREE_LLM_API_MODEL || 'auto:balanced'),
    baseUrl: getFreeLLMAPIUrl(),
    isActive: true,
    rpmLimit: 60,
    status: 'healthy',
  };
}

// Build Gemini key entries from the environment list only.
// GEMINI_API_KEYS=<key1>,<key2>,... — one key per Google Cloud project
// (the user has 10, each from its own account). Quotas are PER PROJECT, not
// per key: keys from different projects each carry their own Hydrogen quota,
// so the pool multiplies capacity; keys from one project would share a cap.
// A legacy single GEMINI_API_KEY is merged in if it is not already listed.
// Key VALUES are never logged, never returned by any status endpoint, and
// never persisted to .secrets.json — env vars own them.
export function buildEnvGeminiKeys(): KeyConfig[] {
  const seen = new Set<string>();
  const out: KeyConfig[] = [];
  const push = (raw: string, n: number) => {
    const apiKey = (raw || '').trim().replace(/^["']|["']$/g, '');
    if (!apiKey || seen.has(apiKey)) return;
    seen.add(apiKey);
    out.push({
      id: `env-gemini-${n}`,
      provider: 'gemini',
      name: `Gemini key ${n} (env)`,
      apiKey,
      // Default model for the pool is Hydrogen (coding-first). Per-turn
      // routing overrides the model via buildGeminiModelChain; the key
      // itself is model-agnostic — rotation is per key, not per model.
      model: 'gemini-4-hydrogen',
      isActive: true,
      // No assumed RPM limit: pacing uses the generic 15/min client-side
      // throttle; the real limit is observed via 429s (see recordKeyRateLimit).
      rpmLimit: 0,
      status: 'healthy',
    });
  };
  const list = (process.env.GEMINI_API_KEYS || '').split(',');
  list.forEach((k, i) => push(k, i + 1));
  if (process.env.GEMINI_API_KEY) push(process.env.GEMINI_API_KEY, out.length + 1);
  return out;
}

// Build Groq key entries from the environment list only.
// GROQ_API_KEYS=<key1>,<key2>,... — the user has 11. Groq free caps are PER
// ORGANIZATION, not per key: keys in one org share one allowance (30 RPM /
// 1,000 RPD per chat model, checked 27 Nov 2026), so rotation adds
// availability, not multiplied quota — unlike Gemini project keys. Default
// model is the fast free gpt-oss-20b (Tier 1); the coding chain can route a
// Groq key to gpt-oss-120b when quality matters. Values never logged/shown.
export function buildEnvGroqKeys(): KeyConfig[] {
  const seen = new Set<string>();
  const out: KeyConfig[] = [];
  const list = (process.env.GROQ_API_KEYS || '').split(',');
  list.forEach((raw, i) => {
    const apiKey = (raw || '').trim().replace(/^["']|["']$/g, '');
    if (!apiKey || seen.has(apiKey)) return;
    seen.add(apiKey);
    out.push({
      id: `env-groq-${i + 1}`,
      provider: 'groq',
      name: `Groq key ${i + 1} (env)`,
      apiKey,
      model: 'openai/gpt-oss-20b',
      isActive: true,
      rpmLimit: 30,
      status: 'healthy',
    });
  });
  return out;
}

// Build OpenRouter key entries from the environment list only.
// OPENROUTER_API_KEYS=<key1>,<key2>,... — the user has 8. OpenRouter free is
// 50 requests/day TOTAL across free models (20 RPM, shared pool) — extra keys
// do not multiply it; they add availability. The default model is the first
// live :free model in the catalog (verified at boot/daily refresh), falling
// back to particle-ai/particle-1:free (agentic coding model, verified free on
// OpenRouter 27 Nov 2026) when the catalog is not loaded yet. The live chain
// re-verifies the model on every turn — a stale default is dropped, never used.
export async function buildEnvOpenRouterKeys(): Promise<KeyConfig[]> {
  const liveDefault = (await firstOpenRouterFreeModel()) || 'particle-ai/particle-1:free';
  const seen = new Set<string>();
  const out: KeyConfig[] = [];
  const list = (process.env.OPENROUTER_API_KEYS || '').split(',');
  list.forEach((raw, i) => {
    const apiKey = (raw || '').trim().replace(/^["']|["']$/g, '');
    if (!apiKey || seen.has(apiKey)) return;
    seen.add(apiKey);
    out.push({
      id: `env-openrouter-${i + 1}`,
      provider: 'openrouter',
      name: `OpenRouter key ${i + 1} (env)`,
      apiKey,
      model: liveDefault,
      isActive: true,
      rpmLimit: 20,
      status: 'healthy',
    });
  });
  return out;
}

// Load stored secrets from disk if exists
export async function loadSecrets(): Promise<KeyConfig[]> {
  let parsed: KeyConfig[] = [];
  try {
    const raw = await fs.readFile(SECRETS_FILE, 'utf-8');
    parsed = JSON.parse(raw);
    let modified = false;
    for (const k of parsed) {
      const normalized = normalizeModelName(k.provider, k.model);
      if (normalized !== k.model) {
        k.model = normalized;
        modified = true;
      }
    }
    if (modified) {
      await fs.writeFile(SECRETS_FILE, JSON.stringify(parsed, null, 2), 'utf-8').catch(() => {});
    }
  } catch {
    parsed = [];
  }
  // Env-seeded FreeLLMAPI key always comes first and is never stale:
  // the env var is the source of truth, so drop any persisted copy.
  const withoutEnv = parsed.filter(k => k.id !== 'env-freellmapi' && !k.id.startsWith('env-gemini-') && !k.id.startsWith('env-groq-') && !k.id.startsWith('env-openrouter-'));
  const envKey = buildEnvFreeLLMAPIKey();
  const envGeminiKeys = buildEnvGeminiKeys();
  const envGroqKeys = buildEnvGroqKeys();
  const envOpenRouterKeys = await buildEnvOpenRouterKeys();
  // The embedded-router pseudo-key (env-freellmapi) is NOT a real provider
  // key — with no external FreeLLMAPI key it just carries the internal
  // router key. Including it unconditionally made a keyless server claim
  // "1 live key" in the pool UI and let the agent loop run with no key at
  // all (live QA 2026-11-27). Include it only when at least one REAL
  // provider key exists anywhere (env lists, an external FreeLLMAPI key,
  // or a persisted dashboard key with a real value). With no real key the
  // pool is empty, the agent loop's no-keys early return fires, and the
  // pool UI honestly shows 0 live / 0 keys.
  const hasRealProviderKey =
    envGeminiKeys.length > 0 ||
    envGroqKeys.length > 0 ||
    envOpenRouterKeys.length > 0 ||
    Boolean((process.env.FREE_LLM_API_KEY || '').trim()) ||
    withoutEnv.some((k) => (k.apiKey || '').trim() && k.apiKey !== getRouterApiKey());
  const head = [...(envKey && hasRealProviderKey ? [envKey] : []), ...envGeminiKeys, ...envGroqKeys, ...envOpenRouterKeys];
  return head.length ? [...head, ...withoutEnv] : withoutEnv;
}

// Save secrets to disk
export async function saveSecrets(keys: KeyConfig[]): Promise<void> {
  try {
    // Never persist env-seeded keys: env vars own them (FreeLLMAPI key and
    // the GEMINI_API_KEYS / GROQ_API_KEYS / OPENROUTER_API_KEYS lists).
    // Persisted copies would leak key material.
    const toSave = keys.filter(k => k.id !== 'env-freellmapi' && !k.id.startsWith('env-gemini-') && !k.id.startsWith('env-groq-') && !k.id.startsWith('env-openrouter-'));
    for (const k of toSave) {
      k.model = normalizeModelName(k.provider, k.model);
    }
    await fs.writeFile(SECRETS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error("Failed to save secrets to disk:", err);
  }
}

// Clean old timestamps and return stats
function getOrCreateStats(keyId: string): KeyRuntimeStats {
  let stats = keyStatsMap.get(keyId);
  if (!stats) {
    stats = {
      timestamps: [],
      cooldownUntil: 0,
      totalRequests: 0,
      lastError: null,
      lastUsedAt: 0,
      limitKind: null,
      limitAt: 0,
      dailyResetAt: 0,
    };
    keyStatsMap.set(keyId, stats);
  }
  const now = Date.now();
  stats.timestamps = stats.timestamps.filter(ts => now - ts < 60_000);
  return stats;
}

// Check real-time status of all keys
export function getKeyPoolStatus(keys: KeyConfig[]) {
  const now = Date.now();
  return keys.map(k => {
    const stats = getOrCreateStats(k.id);
    const inCooldown = stats.cooldownUntil > now;
    const cooldownRemainingSec = inCooldown ? Math.ceil((stats.cooldownUntil - now) / 1000) : 0;
    const requestsThisMinute = stats.timestamps.length;
    
    let status: 'healthy' | 'cooldown' | 'error' = 'healthy';
    if (inCooldown) status = 'cooldown';
    else if (stats.lastError && requestsThisMinute === 0) status = 'error';

    // RPM vs RPD, in plain words — never a raw 429 in the UI.
    const limitKind = stats.limitKind || null;
    const retryInSec = limitKind === 'rpm' || limitKind === 'tpm' ? cooldownRemainingSec : 0;
    return {
      id: k.id,
      provider: k.provider,
      name: k.name,
      model: k.model,
      isActive: k.isActive,
      rpmLimit: k.rpmLimit,
      status,
      isPinned: k.id === lastSuccessfulKeyId,
      cooldownUntil: stats.cooldownUntil,
      cooldownRemainingSec,
      requestsThisMinute,
      totalRequests: stats.totalRequests,
      lastError: stats.lastError,
      lastUsedAt: stats.lastUsedAt,
      limitKind,
      limitLabel: limitKind ? limitLabel(limitKind, limitKind === 'rpd' ? undefined : Math.max(1, retryInSec)) : null,
      dailyResetAt: limitKind === 'rpd' && stats.dailyResetAt ? stats.dailyResetAt : null,
      retryInSec,
    };
  });
}

// Select the optimal key from the pool:
// 1) Remembers and prioritizes the previously working sticky key first
// 2) Keeps rotating through EVERY active key in the pool until a working one is found
export function selectBestKey(
  keys: KeyConfig[],
  preferredProvider: string = 'all',
  excludeKeyIds: Set<string> = new Set(),
  clientStickyKeyId?: string | null
): { key: KeyConfig | null; reason?: string } {
  const now = Date.now();
  
  // Active and not yet tried in this request
  let candidates = keys.filter(k => k.isActive && !excludeKeyIds.has(k.id));

  // Filter by provider preference if specified and available
  if (preferredProvider && preferredProvider !== 'all') {
    const filtered = candidates.filter(k => k.provider === preferredProvider);
    if (filtered.length > 0) candidates = filtered;
  }

  if (candidates.length === 0) {
    return { key: null, reason: 'No active keys remaining to try.' };
  }

  // Prefer keys not currently in cooldown; if all remaining keys are in a soft cooldown (not 401-disabled), still allow testing them!
  const readyKeys = candidates.filter(k => {
    const stats = getOrCreateStats(k.id);
    return stats.cooldownUntil <= now;
  });

  const nonPermanentErrorKeys = candidates.filter(k => {
    const stats = getOrCreateStats(k.id);
    return !stats.lastError?.includes('Invalid API key');
  });

  const effectiveReady = readyKeys.length > 0
    ? readyKeys
    : (nonPermanentErrorKeys.length > 0 ? nonPermanentErrorKeys : candidates);

  // Filter out keys that have reached their RPM quota if others have spare RPM
  const underRpmKeys = effectiveReady.filter(k => {
    const stats = getOrCreateStats(k.id);
    return stats.timestamps.length < (k.rpmLimit || 15);
  });

  const pool = underRpmKeys.length > 0 ? underRpmKeys : effectiveReady;

  // 1. Prioritize user-configured keys ahead of fallback studio_primary_key
  const customKeysPool = pool.filter(k => k.id !== 'studio_primary_key');
  const prioritizedPool = customKeysPool.length > 0 ? customKeysPool : pool;

  // 2. Sticky Key: Always try the remembered working key FIRST (unless already failed/excluded in this request)
  const stickyId = lastSuccessfulKeyId || clientStickyKeyId || null;
  if (stickyId && !excludeKeyIds.has(stickyId)) {
    const preferredKey = prioritizedPool.find(k => k.id === stickyId);
    if (preferredKey) {
      return { key: preferredKey, reason: 'পূর্বের সচল কী অগ্রাধিকার পেয়েছে (Remembered Working Key)' };
    }
  }

  // 3. Otherwise pick the key with lowest RPM load (and earliest cooldown expiry if retrying)
  prioritizedPool.sort((a, b) => {
    const statsA = getOrCreateStats(a.id);
    const statsB = getOrCreateStats(b.id);
    if (statsA.cooldownUntil !== statsB.cooldownUntil) {
      return statsA.cooldownUntil - statsB.cooldownUntil;
    }
    return statsA.timestamps.length - statsB.timestamps.length;
  });

  return { key: prioritizedPool[0] };
}

// Smart RPM pacing to protect free models from exhausting per-minute rate limits during multi-step tool loops
async function paceAndTrackKeyRound(
  trackedKey: KeyConfig | undefined,
  round: number,
  sendEvent?: (data: any) => void
): Promise<void> {
  if (!trackedKey) return;
  const stats = getOrCreateStats(trackedKey.id);
  const now = Date.now();
  const rpmLimit = Math.max(3, trackedKey.rpmLimit || 15);

  // If near per-minute limit, pause smoothly until the oldest request in the 60s window expires (max 6s wait)
  if (stats.timestamps.length >= rpmLimit - 1 && stats.timestamps.length > 0) {
    const oldest = stats.timestamps[0];
    const waitMs = Math.min(6000, Math.max(1200, 60_500 - (now - oldest)));
    if (sendEvent) {
      sendEvent({
        type: 'action',
        action: `⏱️ ${trackedKey.name}-এর ফ্রি RPM লিমিট (${stats.timestamps.length}/${rpmLimit}) বাঁচাতে ${(waitMs / 1000).toFixed(1)}s স্মার্ট পেসিং...`
      });
    }
    await new Promise(resolve => setTimeout(resolve, waitMs));
  } else if (round > 0 && trackedKey.id !== 'studio_primary_key') {
    // Gentle anti-burst spacing between consecutive agentic tool rounds on free keys
    await new Promise(resolve => setTimeout(resolve, 650));
  }

  const freshStats = getOrCreateStats(trackedKey.id);
  freshStats.timestamps.push(Date.now());
  freshStats.lastUsedAt = Date.now();
}

// Record successful request on key and remember it persistently
export function recordKeySuccess(keyId: string) {
  persistStickyKeyId(keyId);
  const stats = getOrCreateStats(keyId);
  const now = Date.now();
  stats.timestamps.push(now);
  stats.totalRequests++;
  stats.lastUsedAt = now;
  stats.cooldownUntil = 0;
  stats.lastError = null;
}

// Record error / cooldown on key
export function recordKeyCooldown(keyId: string, durationSec: number = 60, errorMsg?: string) {
  const stats = getOrCreateStats(keyId);
  stats.cooldownUntil = Date.now() + durationSec * 1000;
  stats.lastError = errorMsg || 'Rate limit or failure';
}

/**
 * Record a 429 / quota hit on a key, distinguishing the budget it hit.
 * RPM/TPM: per-minute budget, rolling reset — short cooldown (~65s or the
 * Retry-After value); the request rotates to the next key immediately.
 * RPD: daily wall — cooldown until midnight Pacific; the key is out for the
 * day. The stored lastError is a human label, never a raw 429.
 */
export function recordKeyRateLimit(keyId: string, kind: RateLimitKind, retryAfterSec?: number | null, errorMsg?: string) {
  const stats = getOrCreateStats(keyId);
  const now = Date.now();
  stats.limitKind = kind;
  stats.limitAt = now;
  if (kind === 'rpd') {
    const resetAt = nextMidnightPacificMs(now);
    stats.dailyResetAt = resetAt;
    stats.cooldownUntil = resetAt;
    stats.lastError = 'daily limit — resets midnight Pacific';
  } else {
    const waitSec = Math.max(65, retryAfterSec ?? 65);
    stats.dailyResetAt = 0;
    stats.cooldownUntil = now + waitSec * 1000;
    stats.lastError = limitLabel(kind, waitSec);
  }
  if (errorMsg) {
    // Keep the provider detail in the log only via the caller; the UI shows limitLabel.
    void errorMsg;
  }
}

// Test an API key connectivity
export async function testApiKey(
  provider: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<{ success: boolean; latencyMs: number; message?: string }> {
  const start = Date.now();
  try {
    if (provider === 'gemini') {
      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');
      const targetModel = normalizeModelName('gemini', model);
      try {
        const client = new GoogleGenAI({
          apiKey: cleanKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });
        const res = await client.models.generateContent({
          model: targetModel,
          contents: 'Hi. Reply with only one word: OK'
        });
        const latencyMs = Date.now() - start;
        const text = res.text || '';
        return { success: true, latencyMs, message: `Connected (${targetModel}) in ${latencyMs}ms: ${text.trim().slice(0, 20)}` };
      } catch (geminiErr: any) {
        const rawMsg = geminiErr.message || '';
        // If AQ. key is a Vertex AI Express Mode key, also try vertexai: true before failing
        if (cleanKey.startsWith('AQ.') && /ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid/i.test(rawMsg)) {
          try {
            const vertexClient = new GoogleGenAI({
              vertexai: true,
              apiKey: cleanKey,
              httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
            });
            const vRes = await vertexClient.models.generateContent({
              model: targetModel,
              contents: 'Hi. Reply with only one word: OK'
            });
            const latencyMs = Date.now() - start;
            return { success: true, latencyMs, message: `Connected via Vertex Express (${targetModel}) in ${latencyMs}ms: ${(vRes.text || '').trim().slice(0, 20)}` };
          } catch {
            // Fall through to helpful AQ. error diagnosis below
          }
        }
        const latencyMs = Date.now() - start;
        if (/ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(rawMsg)) {
          return {
            success: false,
            latencyMs,
            message: `Google সার্ভার এই AQ. কী-টি গ্রহণ করেনি (401 ACCESS_TOKEN_TYPE_UNSUPPORTED)। কারণ: (১) Google Cloud Console > Credentials-এ "API restrictions"-এ ভুল করে "Gemini API" দেওয়া থাকলে পরিবর্তন করে "Generative Language API" করুন অথবা "Don't restrict key" রাখুন; অথবা (২) কী-টি বাতিল/সীমাবদ্ধ হলে aistudio.google.com থেকে নতুন প্রজেক্টে নতুন কী তৈরি করুন।`
          };
        }
        return { success: false, latencyMs, message: rawMsg };
      }
    }

    if (['openrouter', 'groq', 'cerebras', 'mistral', 'grok', 'custom', 'freellmapi'].includes(provider)) {
      const targetModel = normalizeModelName(provider, model);
      const endpoint = getOpenAICompatibleEndpoint(provider, baseUrl);
      const extraHeaders: Record<string, string> = provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://nexus-ai.local', 'X-Title': 'Nexus AI' }
        : {};
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'Reply with one word: OK' }],
          max_tokens: 10,
        }),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const rawMsg = errorData.error?.message || `${provider} returned status ${res.status}`;
        if (provider === 'openrouter' && rawMsg.includes('User not found')) {
          return {
            success: false,
            latencyMs,
            message: "User not found: এই OpenRouter কী-টি অকার্যকর বা মেয়াদোত্তীর্ণ।"
          };
        }
        return { success: false, latencyMs, message: rawMsg };
      }
      return { success: true, latencyMs, message: `Connected to ${provider.toUpperCase()} (${targetModel}) in ${latencyMs}ms.` };
    }

    return { success: false, latencyMs: 0, message: `Unknown provider: ${provider}` };
  } catch (err: any) {
    return { success: false, latencyMs: Date.now() - start, message: err.message || 'Connection failed' };
  }
}

// Re-export website, PWA deployer, and chat history sanitizer
export { autoDeployWebsiteFromText, prepareGeminiHistoryAndLastMessage } from "./websiteDeployer.ts";

export type ActionStepKind = 'thought' | 'command' | 'read' | 'edit' | 'build' | 'qc' | 'restart' | 'respond' | 'agent';

export function emitActionStep(
  sendEvent: (data: any) => void,
  kind: ActionStepKind,
  label: string,
  detail?: string,
  options?: {
    id?: string;
    status?: 'running' | 'done' | 'error';
    toolName?: string;
    filePath?: string;
    durationSec?: number;
    isError?: boolean;
  }
): string {
  const stepId = options?.id || `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  sendEvent({
    type: "action_step",
    step: {
      id: stepId,
      kind,
      label,
      detail,
      status: options?.status || 'done',
      toolName: options?.toolName,
      filePath: options?.filePath,
      durationSec: options?.durationSec,
      isError: options?.isError,
      timestamp: Date.now()
    }
  });
  return stepId;
}

function mapToolToActionStep(toolName: string, args: any): { kind: ActionStepKind; label: string; detail: string; filePath?: string } {
  let kind: ActionStepKind = 'command';
  let label = 'Ran command';

  if (toolName === 'fileRead' || toolName === 'view_file') {
    kind = 'read';
    label = 'Read file';
  } else if (toolName === 'read_skill') {
    kind = 'thought';
    label = 'Loaded coding skill';
  } else if (toolName === 'analyze_project') {
    kind = 'read';
    label = 'Analyzed workspace project';
  } else if (toolName === 'grep_search') {
    kind = 'read';
    label = 'Searched code (grep)';
  } else if (toolName === 'find_by_name') {
    kind = 'read';
    label = 'Found workspace files';
  } else if (toolName === 'list_dir' || toolName === 'listDir') {
    kind = 'read';
    label = 'Listed directory';
  } else if (toolName === 'fileWrite' || toolName === 'write_to_file') {
    kind = 'edit';
    label = 'Wrote file';
  } else if (toolName === 'fileEdit' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
    kind = 'edit';
    label = 'Edited file';
  } else if (toolName === 'delete_file' || toolName === 'fileDelete' || toolName === 'delete_dir' || toolName === 'move' || toolName === 'moveFile') {
    kind = 'edit';
    label = 'Updated workspace files';
  } else if (toolName === 'install_applet_package' || toolName === 'installPackage' || toolName === 'install_applet_dependencies') {
    kind = 'build';
    label = 'Installed dependencies';
  } else if (toolName === 'compileProject' || toolName === 'compile_applet') {
    kind = 'build';
    label = 'Built project';
  } else if (toolName === 'lintProject' || toolName === 'lint_applet' || toolName === 'detect_secrets') {
    kind = 'qc';
    label = toolName === 'detect_secrets' ? 'Scanned for secrets' : 'Ran quality control';
  } else if (toolName === 'restartServer' || toolName === 'restart_dev_server') {
    kind = 'restart';
    label = 'Restarted dev server';
  } else if (toolName === 'manage_task') {
    kind = 'command';
    label = `Managed background task (${args?.Action || 'status'})`;
  } else if (toolName === 'git_status' || toolName === 'git_diff') {
    kind = 'read';
    label = toolName === 'git_status' ? 'Checked git status' : 'Inspected git diff';
  } else if (toolName === 'search_web' || toolName === 'webSearch' || toolName === 'webFetch') {
    kind = 'command';
    label = toolName === 'webFetch' ? 'Fetched webpage' : 'Searched web';
  } else if (toolName === 'generate_image' || toolName === 'generateImage') {
    kind = 'edit';
    label = 'Generated image';
  } else if (toolName === 'code_execution_sandbox') {
    kind = 'command';
    label = `Executed ${args?.Language || 'code'} in Sandbox`;
  } else if (toolName === 'read_multiple_files') {
    kind = 'read';
    label = `Read ${(args?.FilePaths || []).length} files (Multi-File Context)`;
  } else if (toolName === 'compute_file_diff') {
    kind = 'read';
    label = 'Computed file diff';
  } else if (toolName === 'debug_error_analysis') {
    kind = 'qc';
    label = 'Analyzed error & diagnostics';
  } else if (toolName === 'claw_doctor') {
    kind = 'qc';
    label = 'Ran Claw Doctor health check';
  } else if (toolName === 'claw_status') {
    kind = 'thought';
    label = 'Checked Claw harness status';
  } else if (toolName === 'claw_acp') {
    kind = 'thought';
    label = 'Checked Agent Client Protocol';
  } else if (toolName === 'claw_prompt') {
    kind = 'command';
    label = `Dispatched Claw prompt (${args?.role || 'agent'})`;
  } else if (toolName === 'omo_coordinate') {
    kind = 'agent';
    label = 'Orchestrated OmO Multi-Agent coordination';
  } else if (toolName === 'omx_protocol') {
    kind = 'agent';
    label = 'Constructed OmX Execution Protocol';
  } else if (toolName === 'clawhip_router') {
    kind = 'command';
    label = `Routed ClawHip event (${args?.action || 'stream'})`;
  } else if (toolName === 'lazycodex_runner') {
    kind = 'command';
    label = 'Executed LazyCodex autonomous engine';
  } else if (toolName === 'ask_question' || toolName === 'plan') {
    kind = 'thought';
    label = toolName === 'plan' ? 'Created implementation plan' : 'Asked clarifying questions';
  } else if (toolName === 'verify_live_preview') {
    kind = 'qc';
    label = 'Verified live preview';
  } else if (toolName === 'set_up_firebase') {
    kind = 'build';
    label = 'Provisioned Firebase & Firestore';
  } else if (toolName === 'deploy_firebase') {
    kind = 'build';
    label = 'Deployed firestore.rules';
  } else if (toolName === 'set_up_oauth' || toolName === 'remove_oauth') {
    kind = 'command';
    label = toolName === 'remove_oauth' ? 'Removed OAuth scopes' : 'Configured OAuth client & scopes';
  } else if (toolName === 'cloudsql_execute_sql') {
    kind = 'command';
    label = 'Executed SQL query on Cloud SQL';
  } else if (toolName === 'cloudsql_update_schema') {
    kind = 'build';
    label = 'Updated database schema (Drizzle ORM)';
  } else if (toolName === 'figma_import') {
    kind = 'edit';
    label = 'Imported Figma design spec';
  } else if (toolName === 'focus_mode') {
    kind = 'edit';
    label = `Focus Mode edit (${args?.cssSelector || 'target'})`;
  } else if (toolName === 'schedule') {
    kind = 'command';
    label = `Scheduled background timer (${args?.DurationSeconds || 5}s)`;
  } else if (toolName === 'browser_goto') {
    kind = 'command';
    label = 'Opened live browser';
  } else if (toolName === 'browser_click') {
    kind = 'command';
    label = 'Clicked in live browser';
  } else if (toolName === 'browser_type') {
    kind = 'command';
    label = 'Typed in live browser';
  } else if (toolName === 'browser_press_key') {
    kind = 'command';
    label = 'Pressed key in live browser';
  } else if (toolName === 'browser_screenshot') {
    kind = 'command';
    label = 'Captured browser screenshot';
  }

  const filePath =
    args?.TargetFile ||
    args?.AbsolutePath ||
    args?.filePath ||
    args?.DestinationPath ||
    undefined;

  const detail =
    filePath ||
    args?.SkillName ||
    (Array.isArray(args?.FilePaths) ? args.FilePaths.join(', ') : '') ||
    args?.Language ||
    args?.Pattern ||
    args?.CommandLine ||
    args?.command ||
    args?.query ||
    args?.task ||
    args?.goal ||
    args?.prompt ||
    args?.Prompt ||
    args?.message ||
    (Array.isArray(args?.PackageNames) ? args.PackageNames.join(', ') : args?.packageName) ||
    args?.TaskId ||
    args?.url ||
    args?.text ||
    args?.key ||
    '';

  return { kind, label, detail, filePath };
}

async function executeToolWithLiveEvents(
  callName: string,
  callArgs: any,
  sendEvent: (data: any) => void,
  execCtx: ToolExecutionContext
): Promise<any> {
  const mapped = mapToolToActionStep(callName, callArgs);
  const stepId = `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();

  // Emit live "running" step immediately before execution
  emitActionStep(sendEvent, mapped.kind, mapped.label, mapped.detail, {
    id: stepId,
    status: 'running',
    toolName: callName,
    filePath: mapped.filePath,
  });

  let toolResult = await executeServerTool(
    callName,
    callArgs,
    (action) => sendEvent({ type: "action", action }),
    execCtx
  );

  // Parallel multi-agent build (2026-11-29): ONE main agent (this loop) is
  // the only agent the user talks to. When it calls omo_coordinate and the
  // planner splits the build into >=2 independent parts, background coder
  // workers run in parallel (each on its own key) and their files are
  // merged here. Workers never talk to the user; the main agent reports the
  // result. Fail-soft — tryRunParallelBuild returns null for single-part /
  // unparseable plans and the serial path runs unchanged.
  // The summary goes FIRST in the tool result: tool results are truncated
  // to 3000 chars from the head, so the "do NOT rewrite these files" note
  // must survive the cut. `modifiedFiles` makes both loops absorb the
  // parallel-written files into mutatedFiles / didMutateFiles, so the
  // verify-then-fix + reviewer gates check the merged result as today; the
  // existing branches below emit file_modified / preview_ready for them.
  if (callName === 'omo_coordinate' && toolResult && !toolResult.error) {
    const phases = (toolResult as any)?.coordinationPhases;
    const planText = Array.isArray(phases)
      ? phases.map((p: any) => String(p?.output || '')).join('\n')
      : '';
    const pb = await tryRunParallelBuild({
      planText,
      task: String(callArgs?.task || ''),
      sessionId: execCtx.sessionId,
      execCtx,
      sendEvent,
      isCancelled: () => isTurnCancelled(execCtx.sessionId),
    });
    if (pb && pb.ran && !pb.cancelled) {
      const summary = {
        ran: true,
        coders: pb.parts.length,
        workers: pb.parts.map((p) => ({ provider: p.provider, model: p.model, status: p.status })),
        writtenFiles: pb.writtenFiles,
        failedFiles: pb.failedFiles,
        note: pb.writtenFiles.length
          ? `Parallel background coders already wrote these files — do NOT rewrite them: ${pb.writtenFiles.join(', ')}. ${pb.failedFiles.length ? `Still to do — write them yourself: ${pb.failedFiles.join(', ')}.` : 'Verify the build (compile_applet / lint_applet), fix any gaps, then summarise.'}`
          : `Parallel background coders could not write any files. Build them yourself with write_to_file as planned (${pb.failedFiles.join(', ') || 'no output'}).`,
      };
      toolResult = {
        parallelBuild: summary,
        ...toolResult,
        modifiedFiles: pb.writtenFiles,
        previewUrl: pb.previewUrl,
        deployedHtml: pb.deployedHtml,
      };
    }
  }

  const durationSec = Math.max(0.1, Number(((Date.now() - startTime) / 1000).toFixed(1)));
  const hasError = Boolean(toolResult?.error || toolResult?.success === false);

  // Update the same step to "done" or "error"
  emitActionStep(
    sendEvent,
    mapped.kind,
    hasError ? `${mapped.label} (failed)` : mapped.label,
    hasError ? String(toolResult?.error || toolResult?.message || mapped.detail).slice(0, 140) : mapped.detail,
    {
      id: stepId,
      status: hasError ? 'error' : 'done',
      toolName: callName,
      filePath: toolResult?.cleanPath || mapped.filePath,
      durationSec,
      isError: hasError,
    }
  );

  // Emit structured real file modification events
  if (!hasError) {
    // Live browser: a browser_* tool opened/used a shared live session —
    // tell the frontend so the Browser tab can show its screencast.
    if (toolResult?.liveSessionId) {
      sendEvent({
        type: 'live_browser',
        sessionId: toolResult.liveSessionId,
        url: toolResult.liveSessionUrl || mapped.detail,
      });
    }
    if (['write_to_file', 'fileWrite', 'replace_file_content', 'fileEdit', 'multi_replace_file_content'].includes(callName)) {
      const fp = (toolResult?.cleanPath || (toolResult?.path || mapped.filePath || '').replace(/^\/+/, '')).trim();
      if (fp) {
        sendEvent({
          type: 'file_modified',
          filePath: fp,
          action: callName.includes('write') || callName.includes('Write') ? 'created' : 'edited',
        });
      }
    } else if (callName === 'delete_file' || callName === 'fileDelete') {
      const fp = (mapped.filePath || '').replace(/^\/+/, '').trim();
      if (fp) sendEvent({ type: 'file_modified', filePath: fp, action: 'deleted' });
    } else if (callName === 'move' || callName === 'moveFile') {
      const fp = (callArgs?.DestinationPath || callArgs?.destinationPath || '').replace(/^\/+/, '').trim();
      if (fp) sendEvent({ type: 'file_modified', filePath: fp, action: 'moved' });
    } else if (Array.isArray(toolResult?.modifiedFiles)) {
      for (const fp of toolResult.modifiedFiles) {
        sendEvent({ type: 'file_modified', filePath: fp, action: 'created' });
      }
    } else if (callName === 'deploy_firebase') {
      sendEvent({ type: 'file_modified', filePath: 'firestore.rules', action: 'edited' });
    } else if (callName === 'cloudsql_update_schema' && toolResult?.schemaPath) {
      const rel = path.relative(process.cwd(), toolResult.schemaPath);
      sendEvent({ type: 'file_modified', filePath: rel || 'src/db/schema.ts', action: 'edited' });
    }

    // If an HTML website/PWA file was written/edited via tool, trigger Live Preview immediately!
    if (toolResult?.previewUrl) {
      sendEvent({
        type: "action",
        action: `✓ Live Preview updated (${toolResult.previewUrl})`,
      });
      sendEvent({
        type: "preview_ready",
        url: toolResult.previewUrl,
        html: toolResult.deployedHtml,
        sessionId: execCtx.sessionId,
        timestamp: Date.now(),
      });
    }
  }

  if ((callName === "generateImage" || callName === "generate_image") && toolResult?.imageUrl) {
    sendEvent({ type: "image", imageUrl: toolResult.imageUrl });
  }

  return toolResult;
}

// STEP 4 (P0): KNOWN_TOOL_NAMES deliberately still covers ALL 104
// serverTools, not just the 87 core tools. It gates the TEXT-JSON fallback
// (extractAndStripTextToolCalls), where the model may name a tool the
// declarations did not offer — the OpenAI path already behaved this way,
// and the 17 non-core tools keep working executors. Only the native
// declarations sent per call are trimmed (filterCoreTools).
const KNOWN_TOOL_NAMES = new Set(
  serverTools.map((t) => t.name).filter((n): n is string => Boolean(n))
);

// STEP 4 (P0): the OpenAI path's tool set is the shared CORE_TOOL_NAMES
// (geminiService.ts) — the Gemini path now sends exactly the same 86.
const OPENAI_CORE_TOOL_NAMES = CORE_TOOL_NAMES;

interface PendingQuestionEntry {
  resolve: (val: { answers: Record<string, string[]>; skipped?: boolean; notes?: string }) => void;
  timer: NodeJS.Timeout;
}

const pendingQuestionResolvers = new Map<string, PendingQuestionEntry>();

export function resolvePendingQuestion(
  questionId: string,
  payload: { answers?: Record<string, string[]>; skipped?: boolean; notes?: string }
): boolean {
  const entry = pendingQuestionResolvers.get(questionId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingQuestionResolvers.delete(questionId);
  entry.resolve({
    answers: payload?.answers || {},
    skipped: Boolean(payload?.skipped),
    notes: payload?.notes || '',
  });
  return true;
}

function extractAndStripTextToolCalls(rawText: string): {
  calls: Array<{ name: string; args: any }>;
  cleanedText: string;
} {
  if (!rawText) return { calls: [], cleanedText: '' };

  const calls: Array<{ name: string; args: any }> = [];
  let cleaned = rawText;

  const pushParsedCall = (item: any) => {
    if (!item || typeof item !== 'object') return;
    const fnName = item.name || item.function?.name || item.tool;
    if (!fnName || !KNOWN_TOOL_NAMES.has(fnName)) return;
    let args = item.arguments ?? item.args ?? item.parameters ?? item.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    calls.push({ name: fnName, args: args && typeof args === 'object' ? args : {} });
  };

  const tryParseToolJsonBlock = (candidate: string): boolean => {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const before = calls.length;
        parsed.forEach(pushParsedCall);
        return calls.length > before;
      }
      if (Array.isArray(parsed.tool_calls)) {
        const before = calls.length;
        parsed.tool_calls.forEach(pushParsedCall);
        return calls.length > before;
      }
      if (parsed.name && KNOWN_TOOL_NAMES.has(parsed.name)) {
        pushParsedCall(parsed);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  // 1. <tool_call>...</tool_call> or <function_call>...</function_call>
  cleaned = cleaned.replace(/<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi, (full, inner) => {
    return tryParseToolJsonBlock(inner) ? '' : full;
  });

  // 2. Fenced ```json ... ``` or ``json ... `` blocks containing tool_calls or single known tool object
  cleaned = cleaned.replace(/`{2,3}(?:json)?\s*([\s\S]*?)`{2,3}/gi, (full, inner) => {
    if (!inner.includes('"tool_calls"') && !inner.includes('"arguments"') && !inner.includes('"name"')) {
      return full;
    }
    return tryParseToolJsonBlock(inner) ? '' : full;
  });

  // 3. Unfenced (or unclosed fenced) {"tool_calls": [...]} JSON object
  const toolCallsMatch = cleaned.match(/`{0,3}(?:json)?\s*\{\s*"tool_calls"\s*:/i);
  if (toolCallsMatch && typeof toolCallsMatch.index === 'number') {
    const startIdx = toolCallsMatch.index;
    const jsonStartIdx = cleaned.indexOf('{', startIdx);
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = -1;
    for (let i = jsonStartIdx; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (!inStr) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }
    if (endIdx !== -1) {
      const slice = cleaned.slice(jsonStartIdx, endIdx);
      if (tryParseToolJsonBlock(slice)) {
        let after = cleaned.slice(endIdx).replace(/^\s*`{1,3}/, '');
        cleaned = (cleaned.slice(0, startIdx) + after).trim();
      }
    } else {
      // Truncated tool_calls JSON at end of stream: try salvaging complete { "name": ... } objects and strip raw JSON noise
      const tail = cleaned.slice(jsonStartIdx);
      const itemMatches = tail.match(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g) || [];
      for (const itemStr of itemMatches) {
        tryParseToolJsonBlock(itemStr);
      }
      cleaned = cleaned.slice(0, startIdx).trim();
    }
  }

  // Clean up stray backtick artifacts left behind when models wrap tool JSON weirdly
  cleaned = cleaned
    .replace(/(?:^|\n)\s*`{1,3}\s*(?=\n|$)/g, '\n')
    .replace(/`{2,3}\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { calls, cleanedText: cleaned };
}

function getSafeStreamableText(rawText: string): string {
  // Prevent partial <tool_call> or ```json { "tool_calls" ... from flashing in UI while streaming
  let safe = rawText;
  const openTagIdx = safe.search(/<(?:tool_call|function_call)/i);
  if (openTagIdx !== -1 && !/<\/(?:tool_call|function_call)>/i.test(safe.slice(openTagIdx))) {
    safe = safe.slice(0, openTagIdx);
  }
  const jsonToolIdx = safe.search(/`{0,3}(?:json)?\s*\{\s*"tool_calls"\s*:/i);
  if (jsonToolIdx !== -1) {
    safe = safe.slice(0, jsonToolIdx);
  }
  const { cleanedText } = extractAndStripTextToolCalls(safe);
  return cleanedText
    .replace(/(?:^|\n)\s*`{1,3}\s*(?=\n|$)/g, '\n')
    .replace(/`{1,3}\s*$/g, '')
    .trimEnd();
}

function isActionOrBuildPrompt(promptText: string): boolean {
  const lower = (promptText || '').toLowerCase();
  return /(বানাও|তৈরি|ফিচার|যুক্ত|এ্যাড|অ্যাড|এডিট|ঠিক কর|ফিক্স|আপডেট|কোড|অ্যাপ|ওয়েবসাইট|ড্যাশবোর্ড|গেম|দেখো|চেক কর|সার্চ|build|create|add|feature|fix|update|implement|modify|edit|design|refactor|upgrade|debug|write|read|inspect|search|run|compile|deploy|clone|import)/i.test(lower);
}

function isCasualOrConversationalOnly(promptText: string): boolean {
  const trimmed = (promptText || '').trim();
  if (!trimmed) return false;
  // Never treat as casual if it contains URLs, file paths, code fences, or build/inspect keywords
  if (/https?:\/\/|```|[a-z0-9_-]+\.(tsx?|jsx?|html|css|json|py|md)\b|[/\\]/i.test(trimmed)) {
    return false;
  }
  if (isActionOrBuildPrompt(trimmed)) {
    return false;
  }
  const clean = trimmed.toLowerCase().replace(/[!?.।,~`'"]+/g, '').trim();
  const greetingPattern = /^(hi+|hello+|hey+|helo+|yo+|hola|salam|assalamu\s*alaikum|nomoshkar|namaste|good\s*(morning|afternoon|evening|night)|thanks?|thank\s*you|thx|ok|okay|bye|goodbye|হাই|হ্যালো|হেলো|সালাম|আসসালামু\s*আলাইকুম|নমস্কার|কেমন\s*আছো|কেমন\s*আছেন|কি\s*খবর|কী\s*খবর|ভালো\s*আছো|ধন্যবাদ|শুভ\s*(সকাল|দুপুর|সন্ধ্যা|রাত্রি)|ঠিক\s*আছে|ওকে)$/i;
  if (greetingPattern.test(clean)) return true;

  // Short casual chat/intro questions (<= 6 words, no coding/workspace intent)
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 6 && /^(who are you|what can you do|how are you|what is your name|তুমি কে|আপনি কে|কি করতে পারো|কী করতে পারো|তুমি কি পারো|পরিচয় দাও)/i.test(clean)) {
    return true;
  }
  return false;
}

function looksLikeUnfinishedNarration(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  return /(শুরু করব|যুক্ত করব|তৈরি করব|করছি|করব\.?$|প্রতিক্ষয়ে|আরেকটি টুল কল|I will now|Let me |Next,? I will|Starting tool)/i.test(trimmed.slice(-220));
}

function convertSchemaToJsonSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const mapType = (t: any): string => {
    if (!t) return 'string';
    const s = String(t).toUpperCase();
    if (s === 'OBJECT' || t === Type.OBJECT) return 'object';
    if (s === 'ARRAY' || t === Type.ARRAY) return 'array';
    if (s === 'INTEGER' || t === Type.INTEGER) return 'integer';
    if (s === 'NUMBER' || t === Type.NUMBER) return 'number';
    if (s === 'BOOLEAN' || t === Type.BOOLEAN) return 'boolean';
    return 'string';
  };
  const out: any = { type: mapType(schema.type) };
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = convertSchemaToJsonSchema(v);
    }
  } else if (out.type === 'object') {
    out.properties = {};
  }
  if (schema.items) {
    out.items = convertSchemaToJsonSchema(schema.items);
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    out.required = schema.required;
  }
  return out;
}

export function toOpenAITools(declarations: FunctionDeclaration[]): any[] {
  return declarations
    .filter((fn) => fn.name && OPENAI_CORE_TOOL_NAMES.has(fn.name))
    .map((fn) => ({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: convertSchemaToJsonSchema(fn.parameters),
      },
    }));
}

// Convert messages to standard OpenAI format for OpenRouter, Groq, Cerebras, Mistral, Grok, Custom
export function convertToOpenAIMessages(
  messages: any[],
  mode: string,
  systemOptions: SystemInstructionOptions = {},
  enrichedLastMessage?: string
): any[] {
  const systemPrompt = getNexusSystemInstruction(mode, systemOptions);

  const safeMessages = Array.isArray(messages) ? messages : [];
  const formatted: any[] = [{ role: 'system', content: systemPrompt }];
  for (let i = 0; i < safeMessages.length; i++) {
    const m = safeMessages[i];
    const isLastUser = i === safeMessages.length - 1 && m.role !== 'model' && m.role !== 'assistant';
    const text = isLastUser && enrichedLastMessage
      ? enrichedLastMessage
      : (m.parts?.[0]?.text || m.content || '');
    if (text) {
      formatted.push({
        role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user',
        content: text
      });
    }
  }
  // STEP 3 (P0): hard cap — system prompt + the last HISTORY_WINDOW_TURNS
  // turns (default 12), so input tokens stop growing linearly with session
  // length. The handler windows the list first and prepends the rolling
  // summary; this cap also covers any other caller.
  const { dropped } = splitHistoryWindow(formatted.slice(1));
  if (dropped.length > 0) formatted.splice(1, dropped.length);
  return formatted;
}

const FILE_WRITE_TOOL_NAMES = new Set([
  'write_to_file',
  'fileWrite',
  'replace_file_content',
  'fileEdit',
  'multi_replace_file_content',
]);

// --- Performance loops: plan-first / verify-then-fix / reviewer / briefs ---
// Plan steps that satisfy the plan-first gate (any one before the first write).
const PLAN_TOOLS = new Set(['omo_coordinate', 'ask_question', 'plan', 'read_skill']);
// Short-brief discipline: tool results are truncated to this many chars
// before entering model context (override with TOOL_RESULT_MAX_CHARS).
const TOOL_RESULT_MAX_CHARS = Number(process.env.TOOL_RESULT_MAX_CHARS || 3000);
// STEP 10 (P1): per-round output cap for the two main agent loops —
// buildPayload (OpenAI-compatible path) sets max_tokens and the Gemini
// loop sets maxOutputTokens. One round must be able to emit a whole
// single-file site (~30 KB of code ≈ 8k tokens), so the default is 8192;
// the 16-round worst case is then bounded at 16 × 8192 ≈ 131k output
// tokens per turn instead of unbounded. Override with
// AGENT_LOOP_MAX_OUTPUT_TOKENS (e.g. lower it for a provider whose free
// models cap completion below 8192).
const _loopMaxOut = Number(process.env.AGENT_LOOP_MAX_OUTPUT_TOKENS || 8192);
const AGENT_LOOP_MAX_OUTPUT_TOKENS = Number.isFinite(_loopMaxOut) && _loopMaxOut > 0 ? Math.floor(_loopMaxOut) : 8192;
// Max repair rounds shared by the verify-then-fix loop and the reviewer pass.
const MAX_REPAIR_ROUNDS = 2;

// STEP 8 (P1) — conditional reviewer. The reviewer pass costs 1 extra model
// call + a ~2,000-token brief, so it runs ONLY when the build warrants a
// second pair of eyes:
//   (a) verification failed and was fixed this turn — a real defect slipped
//       through once, so re-check the repair; or
//   (b) the diff is large; or
//   (c) it is the first build of the session — no prior build to compare
//       against, so establish the quality baseline.
// A small, clean follow-up build (verification passed first try, small
// diff, session already has a build) skips the reviewer entirely.
// Thresholds — calibrated, not guessed:
//   LARGE_DIFF_CHARS = 50,000: ~2.5x the ~21 KB typical single-file build
//     observed in projects/index.html, so ordinary first-pass builds stay
//     under it while genuinely big pages / multi-file rewrites trip it.
//   LARGE_DIFF_FILES = 5: a multi-file app (html + css + js + assets) is
//     worth a review even when each file is small.
export const REVIEWER_LARGE_DIFF_CHARS = 50000;
export const REVIEWER_LARGE_DIFF_FILES = 5;

export interface ReviewerGateState {
  verificationFailedAndFixed: boolean;
  mutatedFileCount: number;
  mutatedChars: number;
  isFirstBuildOfSession: boolean;
}

export function shouldRunReviewerPass(state: ReviewerGateState): { run: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (state.verificationFailedAndFixed) reasons.push('verification failed and was fixed this turn');
  if (state.mutatedChars >= REVIEWER_LARGE_DIFF_CHARS) reasons.push(`large diff: ${state.mutatedChars} chars written (>= ${REVIEWER_LARGE_DIFF_CHARS})`);
  if (state.mutatedFileCount >= REVIEWER_LARGE_DIFF_FILES) reasons.push(`large diff: ${state.mutatedFileCount} files mutated (>= ${REVIEWER_LARGE_DIFF_FILES})`);
  if (state.isFirstBuildOfSession) reasons.push('first build of session');
  return { run: reasons.length > 0, reasons };
}

// Chars actually written by one file-write tool call — the reviewer gate's
// "large diff" signal. Mirrors the executor's arg shapes in geminiService
// (write_to_file/fileWrite: CodeContent|content; replace_file_content/
// fileEdit: ReplacementContent|newText; multi_replace_file_content:
// ReplacementChunks[].ReplacementContent). Unknown shapes count 0.
export function writtenCharsForToolCall(toolName: string, args: any): number {
  if (!args || typeof args !== 'object') return 0;
  if (toolName === 'write_to_file' || toolName === 'fileWrite') {
    const code = args.CodeContent !== undefined ? args.CodeContent : args.content;
    return typeof code === 'string' ? code.length : 0;
  }
  if (toolName === 'replace_file_content' || toolName === 'fileEdit') {
    const rep = args.ReplacementContent !== undefined ? args.ReplacementContent : args.newText;
    return typeof rep === 'string' ? rep.length : 0;
  }
  if (toolName === 'multi_replace_file_content') {
    const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
    return chunks.reduce((n: number, c: any) => n + (typeof c?.ReplacementContent === 'string' ? c.ReplacementContent.length : 0), 0);
  }
  return 0;
}

// STEP 8 (P1): does this session already have a built site? "First build
// of session" = no projects/<session>/index.html on disk when the turn
// starts. Same location the preview target and buildReviewBrief use.
export async function sessionHasPriorBuild(sessionId: string | undefined): Promise<boolean> {
  const dirName = sessionId
    ? `projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : 'projects';
  try {
    await fs.stat(path.resolve(process.cwd(), dirName, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

// STEP 15 (d): reference-website scrape cap — 6,000 chars of Jina Reader
// markdown (~1,200 tokens at ~5 chars/token for markdown, ~1,500 at the
// 1-token-per-4-chars estimate; was 14,000 chars / ~2,750 tokens). Jina
// markdown is front-loaded — navbar, hero, sections, pricing/feature cards
// and footer all sit near the top — so the cap keeps the design signal
// while roughly halving the context cost of a URL turn.
export const REFERENCE_SCRAPE_MAX_CHARS = 6000;

// STEP 15 (a): turn checkpoint — partial progress preserved across an
// outer key rotation, so a late 429 resumes the turn instead of restarting
// it from scratch (re-paying the whole accumulated context and re-running
// every tool call). One checkpoint is created per turn in
// handleOrchestratedChat and passed into whichever loop serves the
// attempt; the loops mutate it in place as rounds complete, so a throw
// mid-turn leaves the progress behind for the next key to pick up.
// Files already written stay on disk; what the checkpoint adds is the
// conversation state (OpenAI messages incl. tool results) and the text /
// file list the next attempt must not redo. roundsCompleted caps TOTAL
// rounds across rotations at 16 — a resumed turn does not get a fresh 16.
export interface TurnCheckpoint {
  /** Total loop rounds already completed this turn, across all keys. */
  roundsCompleted: number;
  /** OpenAI-compatible loop: the accumulated messages (system + turns +
   * tool results). Shared by reference — the loop pushes onto this array. */
  openAiMessages: any[] | null;
  /** Text the model has already produced this turn (both loops). */
  committedText: string;
  /** Files already written this turn (both loops). */
  mutatedFiles: string[];
  didMutateFiles: boolean;
  calledAnyTool: boolean;
  /** Gemini loop: the next payload to send (tool-response array), plus a
   * truncated text form of the last tool results for the resume brief.
   * geminiHasProgress is true only once a tool round actually ran — a
   * first-round failure must resume as a fresh start, not a resume brief. */
  geminiNextPayload: any;
  geminiLastToolResults: string;
  geminiHasProgress: boolean;
}

export function newTurnCheckpoint(): TurnCheckpoint {
  return {
    roundsCompleted: 0,
    openAiMessages: null,
    committedText: '',
    mutatedFiles: [],
    didMutateFiles: false,
    calledAnyTool: false,
    geminiNextPayload: null,
    geminiLastToolResults: '',
    geminiHasProgress: false,
  };
}
// FreeLLMAPI auto strategies to rotate through when the router errors.
const FREELLMAPI_AUTO_STRATEGIES = ['auto:balanced', 'auto:fast', 'auto:reliable', 'auto:smart', 'auto:cheap'];

function truncateToolOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return text.slice(0, TOOL_RESULT_MAX_CHARS) +
    `\n…[truncated: ${text.length - TOOL_RESULT_MAX_CHARS} more chars omitted — use grep_search / view_file on a narrow target instead of dumping whole files]`;
}

// Deterministic build verification: live-preview check of the built site.
async function verifyBuiltSite(
  targetUrl: string,
  sendEvent: (data: any) => void,
  execCtx: ToolExecutionContext
): Promise<{ ok: boolean; brief: string }> {
  try {
    const result: any = await executeToolWithLiveEvents('verify_live_preview', { targetUrl, checkAssets: true }, sendEvent, execCtx);
    if (result?.ok) {
      return { ok: true, brief: `Preview OK (HTTP ${result.status}, ${result.htmlBytes} bytes, ${result.scriptsChecked} inline scripts, ${result.assetsCheckedCount} assets).` };
    }
    const problems: string[] = [];
    if (result?.error) problems.push(`fetch error: ${result.error}`);
    if (result && result.hasDocStructure === false) problems.push('missing HTML document structure (no <!doctype>/<html>/<body>)');
    for (const e of result?.syntaxErrors || []) problems.push(`inline script #${e.scriptIndex} JS syntax error: ${e.error}`);
    for (const b of result?.brokenAssets || []) problems.push(`broken asset: ${b.url} (HTTP ${b.status})`);
    if (result?.status && result.status !== 200) problems.push(`preview HTTP ${result.status}`);
    return { ok: false, brief: problems.length > 0 ? problems.join('\n- ') : 'Live preview verification failed for an unknown reason.' };
  } catch (err: any) {
    return { ok: false, brief: `verification crashed: ${err?.message || err}` };
  }
}

// Compact brief for the reviewer pass: file list + head of the main page.
async function buildReviewBrief(sessionId: string | undefined, rawUserPrompt: string): Promise<string> {
  const dirName = sessionId
    ? `projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : 'projects';
  try {
    const dir = path.resolve(process.cwd(), dirName);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const lines: string[] = [
      `User request: ${rawUserPrompt.slice(0, 500)}`,
      `Built files in ${dirName}:`,
    ];
    for (const f of entries.filter(e => e.isFile()).slice(0, 12)) {
      try {
        const st = await fs.stat(path.join(dir, f.name));
        lines.push(`- ${f.name} (${st.size} bytes)`);
      } catch { /* ignore */ }
    }
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf-8').catch(() => '');
    if (html) lines.push(`\nMain index.html (first 1500 chars):\n${html.slice(0, 1500)}`);
    return lines.join('\n');
  } catch {
    return `User request: ${rawUserPrompt.slice(0, 500)}\n(Built files could not be listed.)`;
  }
}

// Reviewer pass (OmO Reviewer): one short, tool-free call over the same
// endpoint. Returns approved=true when the build is fine (or when the
// reviewer itself is unreachable — never block delivery on reviewer errors).
async function runReviewerPass(
  endpoint: string,
  apiKey: string,
  model: string,
  headers: Record<string, string>,
  reviewBrief: string,
  usageLedger?: TurnUsage
): Promise<{ approved: boolean; findings: string }> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a senior code reviewer. Review the built website described below for completeness and quality. Reply with exactly "APPROVED" if it fully implements the request with no material issues. Otherwise reply with a short bullet list of concrete issues to fix (file + what is wrong). No praise, no filler.' },
          { role: 'user', content: reviewBrief },
        ],
        max_tokens: 700,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { approved: true, findings: '' };
    const json: any = await res.json().catch(() => null);
    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    if (usageLedger && text) {
      const ru = json?.usage;
      addLlmStep(usageLedger, { kind: 'review', model, tier: costTierOfModel(model), promptTokens: ru?.prompt_tokens ?? estimateTokens(reviewBrief), completionTokens: ru?.completion_tokens ?? estimateTokens(text), estimated: !ru, note: 'reviewer pass' });
    }
    if (!text) return { approved: true, findings: '' };
    if (/^approved\b/i.test(text)) return { approved: true, findings: '' };
    return { approved: false, findings: text.slice(0, 2000) };
  } catch {
    return { approved: true, findings: '' };
  }
}

// Stream chat with OpenAI-compatible endpoints (OpenRouter, Groq, Cerebras, Mistral, Grok, Custom) WITH full tool-calling + text-tool fallback loop
// Exported for the keyless proofs (scripts/step10-max-tokens-proof.mts
// and scripts/step15-proof.mts), which drive the loop with a stubbed
// fetch and record the request payloads — same pattern as
// runGeminiAgentLoop below.
export async function streamOpenAICompatible(
  endpoint: string,
  apiKey: string,
  model: string,
  headers: Record<string, string>,
  messages: any[],
  mode: string,
  sendEvent: (data: any) => void,
  systemOptions: SystemInstructionOptions = {},
  execCtx: ToolExecutionContext = {},
  enrichedLastMessage?: string,
  rawUserPrompt: string = '',
  trackedKey?: KeyConfig,
  allowTools: boolean = true,
  planningEffort?: PlanningEffort,
  usageLedger?: TurnUsage,
  checkpoint?: TurnCheckpoint
): Promise<string> {
  // STEP 15 (a): resume from the checkpoint when a previous key already
  // ran rounds this turn — reuse the SAME messages array (shared by
  // reference, so pushes below persist into the checkpoint) instead of
  // rebuilding from `messages` and re-running every tool call.
  const openAiMessages: any[] = checkpoint?.openAiMessages?.length
    ? checkpoint.openAiMessages
    : convertToOpenAIMessages(messages, mode, systemOptions, enrichedLastMessage);
  if (checkpoint && !checkpoint.openAiMessages) checkpoint.openAiMessages = openAiMessages;
  const openAiTools = allowTools ? toOpenAITools(serverTools) : [];
  let targetModel = model;
  let toolsEnabled = allowTools;
  let committedText = checkpoint?.committedText ?? '';
  let didMutateFiles = checkpoint?.didMutateFiles ?? false;
  let calledAnyTool = checkpoint?.calledAnyTool ?? false;
  const mutatedFiles = new Set<string>(checkpoint?.mutatedFiles ?? []);
  // STEP 15 (b): the tool-schema cost, counted once per round below (only
  // on the estimate path — provider-reported usage already includes it).
  const toolsSchemaTokens = toolsSchemaTokensEstimate(JSON.stringify(openAiTools).length);
  const syncCheckpoint = (): void => {
    if (!checkpoint) return;
    checkpoint.committedText = committedText;
    checkpoint.didMutateFiles = didMutateFiles;
    checkpoint.calledAnyTool = calledAnyTool;
    checkpoint.mutatedFiles = [...mutatedFiles];
  };
  let continuationNudges = 0;
  const requiresImplementation = isActionOrBuildPrompt(rawUserPrompt);
  // BROWSER WORK: the model works in the live browser, never in workspace
  // files — so the file-write nudges below must not fire, and the
  // Planner -> Coder -> Reviewer team must not run. requiresImplementation
  // stays true on purpose: the PLAN-FIRST guard remains armed as a
  // backstop, so a stray file-write call is refused instead of executed.
  const browserWorkMode = Boolean(systemOptions.browserWork);

  // Quality-ordered failover state: the turn's task class, the tier it
  // started at, and whether a tier drop has already been surfaced.
  const classified = classifyTask(rawUserPrompt);
  const turnTask: TaskKind = classified === 'reasoning' ? 'planning' : classified;
  const startModel = targetModel;
  const startTier = tierOfModel(startModel, turnTask);
  let degradationNoted = false;

  // Tiered-routing guardrail state: the cheap loop model (Tier 1) is watched
  // for bad tool choices. 3 consecutive tool failures, or the same tool+args
  // 3 times, escalates the turn to Hydrogen (Tier 2) once.
  let consecutiveToolFailures = 0;
  const toolCallCounts = new Map<string, number>();
  // (mutatedFiles is declared above, from the checkpoint — shared so a
  // resumed turn keeps the written-files list.)
  // STEP 8 (P1): total chars written this turn — the reviewer gate's
  // "large diff" signal. Accumulated in noteToolCall (successful writes
  // only); counts the new content, so a 1-line edit to a big file stays
  // small while a full-page write counts in full.
  let mutatedChars = 0;
  let escalatedToHydrogen = false;

  /** Compact handoff brief (~200-300 tokens): what was done, key files, tool
   * counts, last result — never the full tool output. The new model reads
   * only the files it needs. */
  const buildHandoffBrief = (): string => {
    const topCalls = [...toolCallCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, n]) => `${k.split(':')[0]} ×${n}`).join(', ') || 'none yet';
    const files = [...mutatedFiles].slice(0, 10).join(', ') || 'none yet';
    const lastTool = [...openAiMessages].reverse().find((m: any) => m.role === 'tool');
    const lastResult = lastTool ? String(lastTool.content || '').slice(0, 300) : '';
    return `[HANDOFF BRIEF — continue from here; do NOT re-read everything. Files written so far: ${files}. Tool calls this turn: ${topCalls}. Last tool result (truncated): ${lastResult || 'none'}]`;
  };

  /** Switch to another model mid-turn: record the failure, hand off context, and surface a tier drop honestly. */
  const switchModel = (nextModel: string, reason: string) => {
    const prev = targetModel;
    targetModel = nextModel;
    const brief = buildHandoffBrief();
    openAiMessages.push({ role: 'system', content: handoffNote(prev, reason, nextModel) + (brief ? `\n\n${brief}` : '') });
    const deg = degradationBetween(startModel, nextModel, turnTask);
    if (deg.dropped && !degradationNoted) {
      degradationNoted = true;
      sendEvent({
        type: 'action',
        action: `⚠️ Top-tier models hit their limits — continuing with a lighter model (${nextModel}, tier ${deg.toTier}). The build continues; quality may be lower than the top tier.`,
      });
    } else {
      sendEvent({ type: 'action', action: `⚡ Switching model to ${nextModel} (${reason})...` });
    }
  };

  /** Watch one tool call for the escalation guardrail. Call after every tool
   * execution in this loop. Escalates to Hydrogen once when the cheap loop
   * model fails 3 tool calls in a row or repeats the same call 3 times. */
  const noteToolCall = (toolName: string, args: any, toolResult: any): void => {
    if (usageLedger) addToolCall(usageLedger, false);
    const key = `${toolName}:${JSON.stringify(args || {})}`;
    toolCallCounts.set(key, (toolCallCounts.get(key) || 0) + 1);
    const failed = Boolean(toolResult?.error || toolResult?.success === false);
    consecutiveToolFailures = failed ? consecutiveToolFailures + 1 : 0;
    if (['write_to_file', 'fileWrite', 'replace_file_content', 'fileEdit', 'multi_replace_file_content'].includes(toolName)) {
      const fp = toolResult?.cleanPath || args?.path || args?.filePath || args?.file || '';
      if (fp) mutatedFiles.add(String(fp));
      // STEP 8 (P1): only successful writes grow the diff — a refused or
      // failed write changed nothing on disk.
      if (!failed) mutatedChars += writtenCharsForToolCall(toolName, args);
    }
    // Parallel build: files the background coders wrote (attached to the
    // omo_coordinate result as modifiedFiles) count as mutations, so the
    // verify-then-fix + reviewer gates below check the merged result as
    // today. (verificationDone / reviewed are declared just below this
    // closure — they are only read at call time, during rounds, so this is
    // safe.)
    if (Array.isArray(toolResult?.modifiedFiles) && toolResult.modifiedFiles.length) {
      for (const f of toolResult.modifiedFiles) mutatedFiles.add(String(f));
      didMutateFiles = true;
      verificationDone = false;
      reviewed = false;
    }
    if (escalatedToHydrogen) return;
    const isCheapLoop = cheapChain().includes(targetModel) || targetModel.startsWith('auto:');
    if (!isCheapLoop) return;
    const repeated = (toolCallCounts.get(key) || 0) >= 3;
    if (consecutiveToolFailures >= 3 || repeated) {
      escalatedToHydrogen = true;
      const why = repeated
        ? `the cheap loop model repeated the same tool call 3 times (${toolName})`
        : `the cheap loop model failed ${consecutiveToolFailures} tool calls in a row`;
      sendEvent({ type: 'action', action: `⬆️ Escalating to Hydrogen — ${why}. Hydrogen takes over the rest of this turn.` });
      const hydrogen = codingChain()[0] || 'gemini-4-hydrogen';
      switchModel(hydrogen, `escalated to Hydrogen: ${why}`);
    }
  };

  // Performance-loop state (plan-first / verify-then-fix / reviewer)
  // Multi-agent team: Planner -> Coder -> Reviewer -> Tester, sequential,
  // 1 active at a time. Status events drive the TeamStatus UI panel.
  // Disabled for browser-work turns (no build, no team).
  const teamEnabled = allowTools && requiresImplementation && !browserWorkMode;
  let teamPlannerDone = false;
  let teamTesterDone = false;
  let lastFailureForLesson = '';
  if (teamEnabled) {
    sendEvent({ type: 'agent_status', agent: 'planner', status: 'working' });
  }
  let planCompleted = false;
  let verificationDone = false;
  let reviewed = false;
  // STEP 8 (P1): sticky for the turn — set the first time verification
  // fails, never cleared, so a later passing verification still counts as
  // "failed and was fixed" for the reviewer gate.
  let verificationFailedThisTurn = false;
  let repairRounds = 0;
  let lastVerificationBrief = '';

  // STEP 15 (a): total rounds across key rotations are capped at 16 — a
  // resumed turn continues its round budget, it does not get a fresh 16.
  const maxRounds = allowTools ? Math.max(1, 16 - (checkpoint?.roundsCompleted ?? 0)) : 1;
  for (let round = 0; round < maxRounds; round++) {
    if (checkpoint) checkpoint.roundsCompleted++;
    // Take over / Stop: never issue another tool call after the user stopped the turn.
    if (isTurnCancelled(execCtx.sessionId)) {
      sendEvent({ type: 'action', action: '⏹ Turn stopped — you took over the browser.' });
      break;
    }
    await paceAndTrackKeyRound(trackedKey, round, sendEvent);
    noteModelAttempt(targetModel, trackedKey?.id);
    // STEP 15 (c): the final round is the summary round — like the Gemini
    // loop since step 4, it sends NO tools (the full schema is ~8,700–
    // 10,400 tokens). Any tool call made here would be executed blind:
    // the loop exits right after, so its result is discarded. All
    // refetches inside this round use the same flag.
    const isFinalRound = toolsEnabled && round === maxRounds - 1;
    const sendToolsThisRound = toolsEnabled && !isFinalRound;
    const buildPayload = (useModel: string, useTools: boolean) => {
      const payload: any = {
        model: useModel,
        messages: openAiMessages,
        stream: true,
        // STEP 10 (P1): cap per-round output — see AGENT_LOOP_MAX_OUTPUT_TOKENS.
        max_tokens: AGENT_LOOP_MAX_OUTPUT_TOKENS,
      };
      // reasoning_effort is honoured by FreeLLMAPI (translated to the
      // provider's thinking config). Only set for planning turns — execution
      // uses the model default (high knee).
      if (planningEffort) payload.reasoning_effort = planningEffort;
      if (useTools) {
        payload.tools = openAiTools;
        payload.tool_choice = 'auto';
      }
      return JSON.stringify(payload);
    };

    let res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers
      },
      body: buildPayload(targetModel, sendToolsThisRound)
    });

    if (!res.ok) {
      const errorJson = await res.json().catch(() => null);
      const msg = errorJson?.error?.message || `API error ${res.status}: ${res.statusText}`;

      const isToolsUnsupported =
        toolsEnabled &&
        (res.status === 400 || res.status === 422 || res.status === 404) &&
        (msg.toLowerCase().includes('tool') ||
          msg.toLowerCase().includes('function') ||
          msg.toLowerCase().includes('support') ||
          msg.toLowerCase().includes('schema'));

      const slugMatch = msg.match(/use this slug instead:\s*([a-zA-Z0-9_\-\/:]+)/i);
      const isModelUnavailable = msg.includes("unavailable for free") ||
        msg.includes("not available") ||
        msg.includes("No endpoints found") ||
        msg.includes("not found") ||
        msg.includes("not a valid model ID") ||
        msg.includes("not a valid model");

      if (isToolsUnsupported) {
        toolsEnabled = false;
        openAiMessages[0] = {
          role: 'system',
          content: openAiMessages[0].content + `\n\n[FALLBACK TOOL EXECUTION PROTOCOL]:
Native function calling is unavailable on this model. Whenever you need to call a tool (e.g. view_file, write_to_file, replace_file_content, compile_applet, lint_applet, omo_coordinate, set_up_firebase), output ONLY:
<tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>
The server will execute it immediately and send back the result so you can continue.`
        };
        sendEvent({
          type: "action",
          action: `⚡ ${targetModel} switched to structured <tool_call> execution protocol...`
        });
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...headers
          },
          body: buildPayload(targetModel, false)
        });
      } else if (slugMatch && slugMatch[1] && slugMatch[1] !== targetModel) {
        targetModel = slugMatch[1];
        sendEvent({
          type: "action",
          action: `Switching to available model: ${targetModel}...`
        });
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...headers
          },
          body: buildPayload(targetModel, sendToolsThisRound)
        });
      } else if (
        endpoint.includes('openrouter.ai') &&
        !/free-models-per-day/i.test(msg) &&
        (isModelUnavailable || /provider returned error/i.test(msg) || [502, 503].includes(res.status))
      ) {
        // Quality-ordered live chain (OpenRouter provider) — the old hardcoded
        // list (qwen3-coder:free, llama-3.3-70b:free, …) is stale: those
        // models are no longer free on OpenRouter (checked 26 Nov 2026).
        recordModelFailure(targetModel, res.status, res.headers.get('retry-after'), msg);
        const next = nextAfterFailure(targetModel, turnTask, 'openrouter');
        if (next) {
          switchModel(next.model, `OpenRouter provider error (${res.status})`);
          res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              ...headers
            },
            body: buildPayload(targetModel, sendToolsThisRound)
          });
        }
      } else if (
        trackedKey?.provider === 'freellmapi' &&
        (isModelUnavailable || /provider returned error/i.test(msg) || [429, 502, 503].includes(res.status))
      ) {
        // FreeLLMAPI failover: the router already retries other providers
        // internally; if it still errors, walk the quality-ordered live
        // chain first, then rotate the auto strategy as the floor.
        recordModelFailure(targetModel, res.status, res.headers.get('retry-after'), msg);
        const next = nextAfterFailure(targetModel, turnTask);
        if (next) {
          switchModel(next.model, `FreeLLMAPI error (${res.status})`);
          res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              ...headers
            },
            body: buildPayload(targetModel, sendToolsThisRound)
          });
        } else {
          const strategies = FREELLMAPI_AUTO_STRATEGIES.filter(m => m !== targetModel);
          if (strategies.length > 0) {
            switchModel(strategies[round % strategies.length], 'FreeLLMAPI error — rotating auto strategy');
            res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...headers
              },
              body: buildPayload(targetModel, sendToolsThisRound)
            });
          }
        }
      }

      if (!res.ok) {
        const secondError = await res.json().catch(() => null);
        const finalMsg = secondError?.error?.message || msg;
        const err = new Error(finalMsg);
        (err as any).status = res.status;
        throw err;
      }
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response stream available");

    const decoder = new TextDecoder();
    let buffer = '';
    let roundText = '';
    // STEP 15 (b): provider-reported usage for this round, when the final
    // SSE chunk carries it (see parseSseUsageChunk). Null = estimate path.
    let streamUsage: { promptTokens: number; completionTokens: number } | null = null;
    let streamError: { message: string; status: number } | null = null;
    const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          let json: any = null;
          try {
            json = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          if (json?.error) {
            streamError = {
              message: json.error.message || json.error?.metadata?.raw || 'Provider returned error',
              status: Number(json.error.code || 502),
            };
            break;
          }

          // STEP 15 (b): capture the usage chunk BEFORE the delta check —
          // the final usage chunk often carries no delta, so checking the
          // delta first would drop it.
          const sseUsage = parseSseUsageChunk(json);
          if (sseUsage) streamUsage = sseUsage;

          const choiceDelta = json.choices?.[0]?.delta;
          if (!choiceDelta) continue;

          if (typeof choiceDelta.content === 'string' && choiceDelta.content.length > 0) {
            roundText += choiceDelta.content;
            const previewText = (committedText ? committedText + '\n\n' : '') + getSafeStreamableText(roundText);
            if (previewText.trim()) {
              sendEvent({ type: 'text', text: previewText });
            }
          }

          if (Array.isArray(choiceDelta.tool_calls)) {
            for (const tc of choiceDelta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const existing = toolCallsMap.get(idx) || {
                id: tc.id || `call_${round}_${idx}_${Date.now()}`,
                type: 'function' as const,
                function: { name: '', arguments: '' },
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              toolCallsMap.set(idx, existing);
            }
          }
        }
      }
      if (streamError) break;
    }

    if (streamError) {
      const isAccountDailyCap = /free-models-per-day/i.test(streamError.message);
      const isOpenRouterProviderError =
        endpoint.includes('openrouter.ai') &&
        !isAccountDailyCap &&
        !committedText &&
        !calledAnyTool &&
        (/provider returned error/i.test(streamError.message) || [404, 502, 503].includes(streamError.status));

      if (isOpenRouterProviderError) {
        // Quality-ordered live chain (OpenRouter provider) — never the stale
        // hardcoded list (qwen3-coder:free / llama-3.3-70b:free are no longer
        // free on OpenRouter, checked 26 Nov 2026).
        recordModelFailure(targetModel, streamError.status, null, streamError.message);
        const next = nextAfterFailure(targetModel, turnTask, 'openrouter');
        if (round < 4 && next) {
          switchModel(next.model, `OpenRouter provider error (${streamError.status})`);
          continue;
        }
      }

      const isFreeLLMAPIStreamError =
        trackedKey?.provider === 'freellmapi' &&
        !committedText &&
        !calledAnyTool &&
        (/provider returned error/i.test(streamError.message) || [404, 429, 502, 503].includes(streamError.status));
      if (isFreeLLMAPIStreamError) {
        recordModelFailure(targetModel, streamError.status, null, streamError.message);
        const next = nextAfterFailure(targetModel, turnTask);
        if (round < 4 && next) {
          switchModel(next.model, `FreeLLMAPI stream error (${streamError.status})`);
          continue;
        }
        const strategies = FREELLMAPI_AUTO_STRATEGIES.filter(m => m !== targetModel);
        if (round < 4 && strategies.length > 0) {
          switchModel(strategies[round % strategies.length], 'FreeLLMAPI stream error — rotating auto strategy');
          continue;
        }
      }

      const err = new Error(streamError.message);
      (err as any).status = streamError.status;
      throw err;
    }

    const nativeCalls = Array.from(toolCallsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((c) => Boolean(c.function.name));

    // Also detect and strip text-embedded tool calls (e.g. ```json {"tool_calls": [...]} ``` or <tool_call>...</tool_call>)
    const { calls: textParsedCalls, cleanedText: cleanRoundText } = extractAndStripTextToolCalls(roundText);

    if (cleanRoundText) {
      committedText = committedText ? `${committedText}\n\n${cleanRoundText}` : cleanRoundText;
    }
    sendEvent({ type: 'text', text: committedText });

    if (nativeCalls.length > 0) {
      calledAnyTool = true;
      openAiMessages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: nativeCalls,
      });

      for (const tc of nativeCalls) {
        let parsedArgs: any = {};
        try {
          parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parsedArgs = {};
        }
        const toolName = tc.function.name;
        if (PLAN_TOOLS.has(toolName)) planCompleted = true;
        // PLAN-FIRST guard: refuse the first code write until a plan step ran.
        if (requiresImplementation && !planCompleted && FILE_WRITE_TOOL_NAMES.has(toolName)) {
          openAiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: 'PLAN-FIRST: no plan step has run yet. Before writing any code, call omo_coordinate with the task (Architect → Executor → Reviewer) and read_skill for each relevant skill. Only call ask_question if the request is genuinely ambiguous — otherwise plan with sensible defaults and proceed.' }),
          });
          sendEvent({ type: 'action', action: '⛔ Plan-first: write blocked until omo_coordinate / read_skill runs.' });
          continue;
        }
        if (FILE_WRITE_TOOL_NAMES.has(toolName)) {
          didMutateFiles = true;
          verificationDone = false;
          reviewed = false;
        }
        const toolResult = await executeToolWithLiveEvents(toolName, parsedArgs, sendEvent, execCtx);
        noteToolCall(toolName, parsedArgs, toolResult);
        openAiMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: truncateToolOutput(toolResult),
        });
      }
      syncCheckpoint(); // STEP 15 (a): tool results persist for the next key
      continue;
    }

    if (textParsedCalls.length > 0) {
      calledAnyTool = true;
      openAiMessages.push({
        role: 'assistant',
        content: roundText,
      });
      const resultSummaries: any[] = [];
      for (const tc of textParsedCalls) {
        if (PLAN_TOOLS.has(tc.name)) planCompleted = true;
        if (requiresImplementation && !planCompleted && FILE_WRITE_TOOL_NAMES.has(tc.name)) {
          resultSummaries.push({ tool: tc.name, result: { error: 'PLAN-FIRST: call omo_coordinate (and read_skill for relevant skills) before writing any code.' } });
          continue;
        }
        if (FILE_WRITE_TOOL_NAMES.has(tc.name)) {
          didMutateFiles = true;
          verificationDone = false;
          reviewed = false;
        }
        const toolResult = await executeToolWithLiveEvents(tc.name, tc.args, sendEvent, execCtx);
        noteToolCall(tc.name, tc.args, toolResult);
        resultSummaries.push({ tool: tc.name, result: truncateToolOutput(toolResult) });
      }
      openAiMessages.push({
        role: 'user',
        content: browserWorkMode
          ? `[TOOL EXECUTION RESULTS]:\n${JSON.stringify(resultSummaries)}\n\nContinue immediately in the live browser using the browser_* tools (browser_click / browser_type / browser_press_key, or browse_vision to read the page). Do NOT write any files and do NOT call omo_coordinate.`
          : `[TOOL EXECUTION RESULTS]:\n${JSON.stringify(resultSummaries)}\n\nContinue immediately: implement all requested features directly in workspace files using write_to_file or replace_file_content (never output tool_calls JSON or full code in chat), then verify and summarize.`,
      });
      syncCheckpoint(); // STEP 15 (a): tool results persist for the next key
      continue;
    }

    // Usage ledger: one step per model round. STEP 15 (b): use the
    // provider-reported usage when the stream carried it (estimated: false);
    // otherwise estimate — and count the tool-schema cost on the estimate
    // path via toolsSchemaTokensEstimate (the schema is sent as input
    // tokens on every round that offers tools; provider-reported usage
    // already includes it, so it is never added twice).
    if (roundText && usageLedger) {
      const toolsSentThisRound = sendToolsThisRound;
      if (streamUsage) {
        addLlmStep(usageLedger, { kind: 'llm', model: targetModel, provider: trackedKey?.provider, keyName: trackedKey?.name, tier: costTierOfModel(targetModel), promptTokens: streamUsage.promptTokens, completionTokens: streamUsage.completionTokens, estimated: false, note: 'provider-reported stream usage' });
      } else {
        addLlmStep(usageLedger, { kind: 'llm', model: targetModel, provider: trackedKey?.provider, keyName: trackedKey?.name, tier: costTierOfModel(targetModel), promptTokens: estimateTokens(JSON.stringify(openAiMessages).slice(-20000)) + (toolsSentThisRound ? toolsSchemaTokens : 0), completionTokens: estimateTokens(roundText), estimated: true, note: toolsSentThisRound ? `estimate, incl. ~${toolsSchemaTokens} tool-schema tokens` : 'estimate (no usage reported by provider)' });
      }
    }
    syncCheckpoint();
    // Multi-agent team status (sequential: Planner -> Coder -> Reviewer ->
    // Tester). Planner works until the plan-first gate passes, then Coder.
    if (teamEnabled && planCompleted && !teamPlannerDone) {
      teamPlannerDone = true;
      sendEvent({ type: 'agent_status', agent: 'planner', status: 'done' });
      sendEvent({ type: 'agent_status', agent: 'coder', status: 'working' });
    }

    // Auto-continuation guard: if model stopped after only planning/setup or narrated next tool calls without writing files yet
    // Browser-work turns never write files, so the file-write nudge must
    // not fire — a stalled browser turn is nudged back to the browser.
    const shouldNudge =
      continuationNudges < 2 &&
      (browserWorkMode
        ? looksLikeUnfinishedNarration(roundText)
        : ((requiresImplementation && !didMutateFiles && (calledAnyTool || looksLikeUnfinishedNarration(roundText))) ||
          looksLikeUnfinishedNarration(roundText)));

    if (shouldNudge) {
      continuationNudges++;
      openAiMessages.push({
        role: 'assistant',
        content: roundText || 'Proceeding with next step.',
      });
      openAiMessages.push({
        role: 'user',
        content: browserWorkMode
          ? `Do NOT stop or narrate what tool you will call next. Continue working in the live browser — use browser_click / browser_type / browser_press_key to do the next step there (or browse_vision to read the page). Do NOT write any files and do NOT call omo_coordinate.`
          : toolsEnabled
            ? `Do NOT stop or narrate what tool you will call next. Immediately execute the real tool calls now (inspect target file with view_file if needed, write/update features directly in files using write_to_file or replace_file_content, and verify with compile_applet / lint_applet). Never write code or tool_calls JSON in chat.`
            : `Do NOT stop or narrate. Call the next tool immediately using <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call> to inspect/write the actual workspace files and add all requested features.`,
      });
      continue;
    }

    // VERIFY-THEN-FIX + REVIEWER PASS (deterministic, server-side):
    // never present a broken build as done. Verification runs first, then
    // one reviewer pass; findings go back to the model for repair
    // (max MAX_REPAIR_ROUNDS repair rounds in total).
    if (didMutateFiles && repairRounds < MAX_REPAIR_ROUNDS) {
      const previewTarget = systemOptions.sessionId
        ? `/projects/${systemOptions.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
        : '/projects/index.html';
      if (!verificationDone) {
        if (teamEnabled) sendEvent({ type: 'agent_status', agent: 'tester', status: 'working' });
        const verification = await verifyBuiltSite(previewTarget, sendEvent, execCtx);
        if (teamEnabled) sendEvent({ type: 'agent_status', agent: 'tester', status: verification.ok ? 'done' : 'failed' });
        if (!verification.ok) {
          lastVerificationBrief = verification.brief;
          lastFailureForLesson = verification.brief;
          // STEP 8 (P1): condition (a) for the reviewer gate — a real
          // defect slipped through once this turn; the repair deserves a
          // second pair of eyes even if the diff is small.
          verificationFailedThisTurn = true;
          repairRounds++;
          openAiMessages.push({ role: 'assistant', content: roundText || 'Verifying build.' });
          openAiMessages.push({ role: 'user', content: `[BUILD VERIFICATION FAILED — repair round ${repairRounds}/${MAX_REPAIR_ROUNDS}]:\n- ${verification.brief}\nFix every issue above in the workspace files with the file tools, then stop. Do not narrate the fix, just do it.` });
          sendEvent({ type: 'action', action: `🔧 Verification failed — repair round ${repairRounds}...` });
          continue;
        }
        verificationDone = true;
        if (teamEnabled && !teamTesterDone) {
          teamTesterDone = true;
          sendEvent({ type: 'agent_status', agent: 'tester', status: 'done' });
        }
        // Learning from mistakes: a repair round fixed a real failure — record it.
        if (lastFailureForLesson && repairRounds > 0) {
          recordLesson(lastFailureForLesson, 'Fixed in a verify-then-fix repair round — the repaired files now pass the live-preview check.', rawUserPrompt).catch(() => {});
          lastFailureForLesson = '';
        }
      }
      if (!reviewed) {
        reviewed = true;
        // STEP 8 (P1): conditional reviewer — run ONLY when the build
        // warrants it (verification failed-and-was-fixed, large diff, or
        // first build of session). A small clean build skips the 1 call +
        // ~2,000-token brief; the skip is logged so the activity feed
        // shows the decision. `reviewed` stays true for this pass, but a
        // later write resets it (see the write branches above) and the
        // gate re-evaluates with the grown diff / new failure state.
        const gate = shouldRunReviewerPass({
          verificationFailedAndFixed: verificationFailedThisTurn,
          mutatedFileCount: mutatedFiles.size,
          mutatedChars,
          isFirstBuildOfSession: systemOptions.isFirstBuildOfSession ?? false,
        });
        if (!gate.run) {
          sendEvent({ type: 'action', action: `⏭️ Reviewer skipped — small clean build (${mutatedChars} chars in ${mutatedFiles.size} file(s), verification passed first try).` });
        } else {
          if (teamEnabled) sendEvent({ type: 'agent_status', agent: 'reviewer', status: 'working' });
          const brief = await buildReviewBrief(systemOptions.sessionId, rawUserPrompt);
          const review = await runReviewerPass(endpoint, apiKey, targetModel, headers, brief, usageLedger);
          if (teamEnabled) sendEvent({ type: 'agent_status', agent: 'reviewer', status: review.approved ? 'done' : 'failed' });
          if (!review.approved) {
            lastFailureForLesson = `Reviewer: ${review.findings.slice(0, 300)}`;
            repairRounds++;
            openAiMessages.push({ role: 'assistant', content: roundText || 'Reviewing build.' });
            openAiMessages.push({ role: 'user', content: `[REVIEWER PASS — repair round ${repairRounds}/${MAX_REPAIR_ROUNDS}]:\n${review.findings}\nFix every issue above in the workspace files with the file tools, then stop.` });
            sendEvent({ type: 'action', action: `🔍 Reviewer found issues — repair round ${repairRounds}...` });
            continue;
          }
        }
      }
    }

    break;
  }

  // Final check when rounds ran out before the hook above could run.
  if (didMutateFiles && !verificationDone) {
    const previewTarget = systemOptions.sessionId
      ? `/projects/${systemOptions.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
      : '/projects/index.html';
    const verification = await verifyBuiltSite(previewTarget, sendEvent, execCtx);
    if (verification.ok) {
      verificationDone = true;
    } else {
      lastVerificationBrief = verification.brief;
    }
  }
  if (didMutateFiles && !verificationDone && lastVerificationBrief) {
    committedText += `\n\n[⚠️ Note: live preview verification still failing after ${MAX_REPAIR_ROUNDS} repair rounds — ${lastVerificationBrief}]`;
  }

  // FIX (2026-11-27): an empty model reply used to be returned as success,
  // and the outer key loop then sent `done` with an empty fullText — the
  // user saw an empty reply with no error. An empty reply is a failure:
  // throw so the outer loop rotates to the next key/model and, when the
  // whole chain is exhausted, the friendly `!succeeded` error is sent.
  if (!committedText.trim()) {
    // A stop is not a failure: the user took over, so return a short note
    // instead of throwing (which would rotate keys and retry the turn).
    if (isTurnCancelled(execCtx.sessionId)) return '⏹ Turn stopped — you took over the browser.';
    throw new Error('The model returned an empty response (no text produced).');
  }
  recordModelSuccess(targetModel);
  return committedText;
}

// Exported for the keyless proof (scripts/tool-schema-proof.mts), which
// drives the loop with a fake Gemini client and records the tools offered
// per round.
export async function runGeminiAgentLoop(
  client: GoogleGenAI,
  targetModel: string,
  mode: string,
  systemOptions: SystemInstructionOptions,
  history: any[],
  lastMessage: string,
  rawUserPrompt: string,
  sendEvent: (data: any) => void,
  execCtx: ToolExecutionContext,
  trackedKey?: KeyConfig,
  allowTools: boolean = true,
  usageLedger?: TurnUsage,
  checkpoint?: TurnCheckpoint
): Promise<string> {
  // Hoisted so the last-round tool-free request (below) carries the exact
  // same system instruction the chat was created with — a per-request
  // config replaces the chat config wholesale, it does not inherit it.
  const systemInstruction = getNexusSystemInstruction(mode, systemOptions);
  const chat = client.chats.create({
    model: targetModel,
    config: {
      systemInstruction,
      // STEP 10 (P1): cap per-round output — see AGENT_LOOP_MAX_OUTPUT_TOKENS.
      maxOutputTokens: AGENT_LOOP_MAX_OUTPUT_TOKENS,
      // STEP 4 (P0): offer only the 87 core tools, never all 104
      // serverTools — same set the OpenAI-compatible loop sends.
      ...(allowTools ? { tools: [{ functionDeclarations: filterCoreTools(serverTools) }] } : {}),
    },
    history
  });

  // STEP 15 (a): resume from the checkpoint when a previous key already
  // ran rounds this turn. A fresh chat cannot replay the previous
  // attempt's function calls, so the resume is a compact brief, not the
  // raw functionResponse array: what was written, what text exists, and
  // the last tool results — the next key continues from there instead of
  // re-doing the work. Files already written stay on disk either way.
  const mutatedFiles = new Set<string>(checkpoint?.mutatedFiles ?? []);
  let nextPayload: any = lastMessage;
  let committedText = checkpoint?.committedText ?? '';
  let didMutateFiles = checkpoint?.didMutateFiles ?? false;
  let calledAnyTool = checkpoint?.calledAnyTool ?? false;
  let geminiHasProgress = checkpoint?.geminiHasProgress ?? false;
  if (checkpoint && (geminiHasProgress || checkpoint.committedText)) {
    const files = [...mutatedFiles].join(', ') || 'none';
    nextPayload = `[RESUMED AFTER KEY ROTATION — the previous key hit its limit mid-turn. Progress is preserved; do NOT redo completed work. Text produced so far: ${committedText || '(none)'}. Files already written: ${files}. Last tool results: ${checkpoint.geminiLastToolResults || 'none'}. Continue from here.]`;
  }
  // STEP 15 (b): provider-reported usage from the stream chunks'
  // usageMetadata (last non-null wins — it is a turn total, never summed).
  let geminiUsage: { promptTokens: number; completionTokens: number } | null = null;
  const syncCheckpoint = (): void => {
    if (!checkpoint) return;
    checkpoint.committedText = committedText;
    checkpoint.didMutateFiles = didMutateFiles;
    checkpoint.calledAnyTool = calledAnyTool;
    checkpoint.mutatedFiles = [...mutatedFiles];
    checkpoint.geminiNextPayload = nextPayload;
    checkpoint.geminiHasProgress = geminiHasProgress;
  };
  let continuationNudges = 0;
  const requiresImplementation = isActionOrBuildPrompt(rawUserPrompt);
  // BROWSER WORK: the model works in the live browser, never in workspace
  // files — so the file-write nudges below must not fire. (The Gemini
  // loop has no server-side plan-first guard, so the browser-work system
  // instruction is the guard here — it forbids omo_coordinate and all
  // file writes for this turn.)
  const browserWorkMode = Boolean(systemOptions.browserWork);
  // STEP 15 (a): total rounds across key rotations are capped at 16.
  const maxRounds = allowTools ? Math.max(1, 16 - (checkpoint?.roundsCompleted ?? 0)) : 1;

  for (let round = 0; round < maxRounds; round++) {
    if (checkpoint) checkpoint.roundsCompleted++;
    // Take over / Stop: never issue another tool call after the user stopped the turn.
    if (isTurnCancelled(execCtx.sessionId)) {
      sendEvent({ type: 'action', action: '⏹ Turn stopped — you took over the browser.' });
      break;
    }
    await paceAndTrackKeyRound(trackedKey, round, sendEvent);
    // STEP 4 (P0): the final round is the summary round — the model only
    // writes its closing text, and any tool call it made here would be
    // executed blind (its result is discarded when the loop exits), so no
    // tools are offered on it at all. A per-request config replaces the
    // chat config, hence systemInstruction is carried over explicitly.
    // (No per-phase subset on earlier rounds: the loop has no distinct
    // planning phase, and restricting round 0 to read/planning tools
    // would block turns that legitimately write on round 0.)
    const isFinalRound = allowTools && round === maxRounds - 1;
    const currentResult = isFinalRound
      // STEP 10 (P1): a per-request config replaces the chat config
      // wholesale, so the output cap must be repeated here or the final
      // round would be uncapped.
      ? await chat.sendMessageStream({ message: nextPayload, config: { systemInstruction, maxOutputTokens: AGENT_LOOP_MAX_OUTPUT_TOKENS } })
      : await chat.sendMessageStream({ message: nextPayload });
    let roundText = '';
    const functionCalls: any[] = [];

    for await (const chunk of currentResult) {
      // STEP 15 (b): capture provider-reported usage when the SDK reports
      // it (usageMetadata on the final chunk). Last non-null wins.
      const usageMeta: any = (chunk as any)?.usageMetadata;
      if (usageMeta && typeof usageMeta.promptTokenCount === 'number') {
        geminiUsage = { promptTokens: usageMeta.promptTokenCount, completionTokens: typeof usageMeta.candidatesTokenCount === 'number' ? usageMeta.candidatesTokenCount : 0 };
      }
      if (chunk.text) {
        roundText += chunk.text;
        const previewText = (committedText ? committedText + '\n\n' : '') + getSafeStreamableText(roundText);
        if (previewText.trim()) {
          sendEvent({ type: 'text', text: previewText });
        }
      }
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        functionCalls.push(...chunk.functionCalls);
      }
    }

    const { calls: textParsedCalls, cleanedText: cleanRoundText } = extractAndStripTextToolCalls(roundText);
    if (cleanRoundText) {
      committedText = committedText ? `${committedText}\n\n${cleanRoundText}` : cleanRoundText;
    }
    sendEvent({ type: 'text', text: committedText });
    syncCheckpoint(); // STEP 15 (a): text produced so far persists

    if (functionCalls.length > 0) {
      calledAnyTool = true;
      const toolResponses = await Promise.all(
        functionCalls.map(async (call) => {
          if (!call.name) return null;
          if (FILE_WRITE_TOOL_NAMES.has(call.name)) didMutateFiles = true;
          const toolResult = await executeToolWithLiveEvents(call.name, call.args, sendEvent, execCtx);
          const fp = (toolResult as any)?.cleanPath || call.args?.TargetFile || call.args?.filePath || call.args?.path || '';
          if (fp) mutatedFiles.add(String(fp));
          // Parallel build: files the background coders wrote (attached to
          // the omo_coordinate result as modifiedFiles) count as mutations
          // for the checkpoint, so verify / reviewer see the merged result.
          const pbFiles = (toolResult as any)?.modifiedFiles;
          if (Array.isArray(pbFiles) && pbFiles.length) {
            didMutateFiles = true;
            for (const f of pbFiles) mutatedFiles.add(String(f));
          }
          return {
            functionResponse: {
              name: call.name,
              response: { output: truncateToolOutput(toolResult) }
            }
          };
        })
      );
      const validResponses = toolResponses.filter(Boolean);
      if (validResponses.length === 0) break;
      nextPayload = validResponses;
      geminiHasProgress = true;
      if (checkpoint) checkpoint.geminiLastToolResults = JSON.stringify(validResponses).slice(0, 1000);
      syncCheckpoint(); // STEP 15 (a): progress persists for the next key
      continue;
    }

    if (textParsedCalls.length > 0) {
      calledAnyTool = true;
      const results: any[] = [];
      for (const tc of textParsedCalls) {
        if (FILE_WRITE_TOOL_NAMES.has(tc.name)) didMutateFiles = true;
        const toolResult = await executeToolWithLiveEvents(tc.name, tc.args, sendEvent, execCtx);
        const fp = (toolResult as any)?.cleanPath || tc.args?.TargetFile || tc.args?.filePath || tc.args?.path || '';
        if (fp) mutatedFiles.add(String(fp));
        // Parallel build: see the functionCalls branch above.
        const pbFiles = (toolResult as any)?.modifiedFiles;
        if (Array.isArray(pbFiles) && pbFiles.length) {
          didMutateFiles = true;
          for (const f of pbFiles) mutatedFiles.add(String(f));
        }
        results.push({ tool: tc.name, result: truncateToolOutput(toolResult) });
      }
      nextPayload = browserWorkMode
        ? `[TOOL EXECUTION RESULTS]:\n${JSON.stringify(results)}\n\nContinue immediately in the live browser using the browser_* tools (browser_click / browser_type / browser_press_key). Do NOT write any files and do NOT call omo_coordinate.`
        : `[TOOL EXECUTION RESULTS]:\n${JSON.stringify(results)}\n\nContinue immediately using real function calls (write_to_file / replace_file_content) to write all requested code into workspace files. Do NOT output tool_calls JSON in chat.`;
      geminiHasProgress = true;
      if (checkpoint) checkpoint.geminiLastToolResults = JSON.stringify(results).slice(0, 1000);
      syncCheckpoint(); // STEP 15 (a): progress persists for the next key
      continue;
    }

    // Browser-work turns never write files, so the file-write nudge must
    // not fire — a stalled browser turn is nudged back to the browser.
    const shouldNudge =
      continuationNudges < 2 &&
      (browserWorkMode
        ? looksLikeUnfinishedNarration(roundText)
        : ((requiresImplementation && !didMutateFiles && (calledAnyTool || looksLikeUnfinishedNarration(roundText))) ||
          looksLikeUnfinishedNarration(roundText)));

    if (shouldNudge) {
      continuationNudges++;
      nextPayload = browserWorkMode
        ? `Do NOT stop or narrate next steps. Continue working in the live browser — use browser_click / browser_type / browser_press_key to do the next step there (or browse_vision to read the page). Do NOT write any files and do NOT call omo_coordinate.`
        : `Do NOT stop or narrate next steps. Call write_to_file or replace_file_content NOW to write/update the actual files with all requested features, then verify with compile_applet and lint_applet. Never write code or tool_calls JSON in chat.`;
      continue;
    }

    break;
  }

  // Usage ledger (aggregate for the direct-Gemini loop). STEP 15 (b):
  // provider-reported usage when the stream carried usageMetadata
  // (estimated: false); otherwise an estimate that COUNTS the tool-schema
  // cost via toolsSchemaTokensEstimate (the 87 core declarations are sent
  // as input tokens on every round that offers tools).
  if (usageLedger && committedText) {
    const schemaTokens = toolsSchemaTokensEstimate(JSON.stringify(filterCoreTools(serverTools)).length);
    if (geminiUsage) {
      addLlmStep(usageLedger, { kind: 'llm', model: targetModel, tier: costTierOfModel(targetModel), promptTokens: geminiUsage.promptTokens, completionTokens: geminiUsage.completionTokens, estimated: false, note: 'direct Gemini loop (aggregate, provider-reported)' });
    } else {
      addLlmStep(usageLedger, { kind: 'llm', model: targetModel, tier: costTierOfModel(targetModel), promptTokens: estimateTokens(JSON.stringify(history).slice(-20000) + lastMessage) + (allowTools ? schemaTokens : 0), completionTokens: estimateTokens(committedText), estimated: true, note: `direct Gemini loop (aggregate estimate, incl. ~${schemaTokens} tool-schema tokens)` });
    }
  }
  // FIX (2026-11-27): see the same guard in streamOpenAICompatible — an
  // empty reply is a failure, not a success. Throw so the outer loop
  // rotates to the next key/model instead of sending an empty `done`.
  if (!committedText.trim()) {
    // A stop is not a failure: the user took over, so return a short note
    // instead of throwing (which would rotate keys and retry the turn).
    if (isTurnCancelled(execCtx.sessionId)) return '⏹ Turn stopped — you took over the browser.';
    throw new Error('The model returned an empty response (no text produced).');
  }
  recordModelSuccess(targetModel);
  return committedText;
}

// Orchestrated Chat Execution with Multi-Key Failover and Smart Rotation
// --- Tier 0 direct-command handlers (zero model calls) ---------------------
async function runLocalDirectCommand(tool: string, sessionId?: string): Promise<string> {
  switch (tool) {
    case 'list_projects': {
      const ps = await listProjects();
      if (!ps.length) return 'No projects yet. Build a site first — it will appear here.';
      return 'Your projects:\n' + ps.map((p) => `- ${p.title} (${p.files} files, ${Math.round(p.sizeBytes / 1024)} KB) — ${p.url}`).join('\n');
    }
    case 'list_chats': {
      const cs = await listChats();
      if (!cs.length) return 'No past chats yet.';
      return 'Past chats:\n' + cs.map((c) => `- ${c.title} (${c.messageCount} messages${c.hasProject ? ', has project' : ''})`).join('\n');
    }
    case 'show_memory':
      return readUserMemory();
    case 'show_usage': {
      const s = sessionUsageSummary(sessionId || 'default');
      if (!s) return 'No usage recorded yet this session.';
      return `Usage this session (${s.turns} turns): ${s.requests} requests, ${s.totalTokens} tokens, ${s.toolCalls} tool calls (${s.toolCacheHits} served from cache), ${s.directTurns} direct (zero-cost) turns.`;
    }
    case 'list_skills':
      return `Skills (${CODING_SKILLS_REGISTRY.length}):\n` + CODING_SKILLS_REGISTRY.map((sk) => `- ${sk.name}: ${sk.description}`).join('\n');
    default:
      return `Unknown direct command: ${tool}`;
  }
}

function formatDirectResult(tool: string, result: any): string {
  if (typeof result === 'string') return result.slice(0, 8000);
  if (result && typeof result.content === 'string') return result.content.slice(0, 8000);
  if (result && typeof result.message === 'string' && result.error) return result.message.slice(0, 2000);
  const text = JSON.stringify(result, null, 2) || '';
  return text.slice(0, 8000);
}

// Transport/network failures (fetch failed, ECONNRESET, socket hang up,
// "network error") are TRANSIENT: the provider/model/key is fine, the
// connection broke. They must rotate like 429/5xx/timeout — next model,
// next key, at least one retry — never a hard stop (live bug 2026-11-27: a
// build died on "network error" with no failover and an empty Preview).
export const NETWORK_ERROR_RE =
  /fetch failed|network error|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang ?up|connection (reset|aborted|closed)|TLS|SSL|undici|request aborted|terminated|timed? ?out|AbortError/i;
export function isNetworkErrorMessage(msg: string): boolean {
  return NETWORK_ERROR_RE.test(msg || '');
}

export async function handleOrchestratedChat(
  req: { 
    messages: any[]; 
    mode?: string; 
    userKeys?: KeyConfig[]; 
    keys?: KeyConfig[];
    preferredProvider?: string; 
    safePacing?: boolean;
    sessionId?: string;
    /** Page origin the user is on (sent by the frontend) — used to resolve
     * a bare "open the site" request to the current project's preview URL.
     * Falls back to RENDER_EXTERNAL_URL server-side. */
    origin?: string;
    selectedModel?: string;
    developerPersona?: string;
    customSystemInstruction?: string;
    outputFormat?: 'auto' | 'markdown' | 'json';
    multiAgent?: boolean;
    preferOnlyCustomKeys?: boolean;
    stickyKeyId?: string | null;
    imageBase64?: string;
    imageMime?: string;
    /** STEP 13 (P1): "rebuild anyway" — skip the build-cache lookup for this turn. */
    bypassCache?: boolean;
    /** Live browser tabs the user has open in the Browser tab (max 4).
     * Seeded into the turn's execCtx so the agent can drive tabs the user
     * opened — not only ones it opened itself this turn. */
    liveTabs?: Array<{ id: string; url?: string }>;
    /** Which of liveTabs is the active (visible) one in the Browser tab. */
    activeLiveTabId?: string;
  },
  res: Response
) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // SSE keepalive: the agent loop's first big model call can go ~60-90s
  // without emitting an event (time-to-first-token), and proxies kill a
  // silent stream — the client then sees a bare "network error" and the turn
  // dies (live bug 2026-11-27: build stopped at 1m20s). A comment line every
  // 15s keeps the stream alive; the frontend's parser ignores non-data
  // lines. Cleared when the response finishes or the client disconnects.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* client gone — 'close' clears below */ }
  }, 15000);
  heartbeat.unref?.();
  // Take over / Stop: if the client disconnects mid-turn (the frontend
  // aborts its fetch when the user hits Stop / Take over), the turn is
  // cancelled so the loops stop issuing tool calls at the next round
  // boundary. 'finish' fires on a normal res.end() first, so a completed
  // turn is never marked cancelled by its own 'close'.
  let responseFinished = false;
  res.on('finish', () => { responseFinished = true; clearInterval(heartbeat); });
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!responseFinished) cancelTurn((req as any)?.sessionId || '');
  });

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const {
    messages: rawMessages,
    mode = "general",
    userKeys: reqUserKeys,
    keys: reqKeys,
    preferredProvider = 'all',
    sessionId,
    selectedModel,
    developerPersona,
    customSystemInstruction,
    outputFormat = 'auto',
    multiAgent = true,
    preferOnlyCustomKeys = false,
    stickyKeyId: reqStickyKeyId = null,
    imageBase64,
    imageMime,
    bypassCache = false
  } = req;
  // A fresh turn starts un-cancelled — a previous turn's stop must never
  // leak into this one.
  clearTurnCancellation(sessionId);
  // Same for the parallel build: a fresh turn may run its parallel coders
  // once, even if a previous turn already did.
  clearParallelBuildForSession(sessionId);
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  if (messages.length === 0) {
    sendEvent({
      type: "error",
      error: "অনুগ্রহ করে একটি বৈধ প্রম্পট বা মেসেজ পাঠান (messages array is empty or missing)।"
    });
    res.end();
    return;
  }
  // Per-turn usage ledger (token/request transparency) + the final assistant
  // text (saved to server chat history before res.end()).
  const usageLedger = newTurnUsage(sessionId || 'default');
  let finalAssistantText = '';
  const userKeys = reqUserKeys || reqKeys || [];
  const systemOptions: SystemInstructionOptions = {
    developerPersona,
    customSystemInstruction,
    outputFormat,
    multiAgent,
    sessionId,
  };
  // STEP 8 (P1): snapshot ONCE per turn, before any key attempt writes
  // files, whether this session already has a built site. Snapshotted
  // here — not inside the agent loop — so a key retry after a failed
  // attempt does not mistake this turn's own writes for a prior build.
  // The reviewer gate reads it as "first build of session".
  systemOptions.isFirstBuildOfSession = !(await sessionHasPriorBuild(sessionId));
  const explicitGeminiModel = selectedModel && selectedModel !== 'Default' && selectedModel !== 'auto'
    ? normalizeModelName('gemini', selectedModel)
    : null;

  const sessionPreviewTarget = sessionId
    ? `projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
    : 'projects/index.html';
  
  // Merge server-stored chat history (memory): if the client sent only the
  // new message, prepend the stored conversation so the agent continues where
  // it stopped. The stored shape ({role, text}) is accepted by the sanitizer.
  let messagesForHistory = messages;
  if (messages.length <= 1 && sessionId) {
    try {
      const stored = await loadChat(sessionId);
      if (stored && stored.messages.length > 0) {
        messagesForHistory = [...stored.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })), ...messages];
      }
    } catch { /* stored history unavailable — continue with client history */ }
  }

  // STEP 3 (P0): cap the history the model sees to the last
  // HISTORY_WINDOW_TURNS turns (default 12) — the client sends the whole
  // conversation every turn and the stored session is only capped at 500
  // messages, so without this input tokens grew LINEARLY with session
  // length on every round. `recentMessages` feeds BOTH loops below (the
  // Gemini loop via `history`, the OpenAI-compatible loop via
  // `messagesForModel`); the sanitizer / converter hard-cap again as a
  // second line of defence. The rolling summary of the dropped turns is
  // prepended after the intent gate (only turns that reach a model loop
  // pay for a summary call — casual turns send no history at all).
  const { recent: recentMessages, dropped: droppedMessages } = splitHistoryWindow(messagesForHistory);
  let messagesForModel: any[] = recentMessages;

  // Extract and sanitize messages once
  let { history, lastMessage: initialLastMessage } = prepareGeminiHistoryAndLastMessage(messagesForModel);
  let lastMessage = initialLastMessage;

  // (STEP 17: vision moved below — after the intent gate — so casual and
  // direct-command turns with an image never pay for a description.)
  // --- Tier 0: rule-based direct commands (zero model calls) ---------------
  // Deterministic commands (show file / list files / git status / search)
  // run as code and go straight to the UI — the model is never involved.
  const direct = matchDirectCommand(initialLastMessage, sessionId, req.origin);
  if (direct) {
    try {
      let resultText = '';
      let servedFromCache = false;
      if (direct.kind === 'local') {
        resultText = await runLocalDirectCommand(direct.tool, sessionId);
      } else if (direct.kind === 'edit') {
        // Deterministic file edit (Step 14): exact string op on a known
        // file — no model call, never cached (it is a write).
        resultText = await applyDirectEdit(direct);
      } else if (direct.kind === 'browser') {
        // Direct "open in browser": start a live session + goto, nothing
        // else — no model call, no omo_coordinate, no file edits, no
        // rebuild. The live_browser event tells the frontend to switch to
        // the Browser tab (same event the agent loop emits for browser_*
        // tools). The reply is a short confirmation in the user's language.
        const browserExecCtx: ToolExecutionContext = { sessionId };
        const browserResult = await executeServerTool('browser_goto', direct.args, (a) => sendEvent({ type: 'action', action: a }), browserExecCtx);
        const isBn = /[\u0980-\u09FF]/.test(initialLastMessage);
        const targetUrl = String((direct.args as any)?.url || '');
        if (browserResult && typeof browserResult === 'object' && (browserResult as any).liveSessionId) {
          sendEvent({ type: 'live_browser', sessionId: (browserResult as any).liveSessionId, url: (browserResult as any).liveSessionUrl || targetUrl });
        }
        if (browserResult && typeof browserResult === 'object' && (browserResult as any).error) {
          resultText = isBn
            ? `⚠️ ব্রাউজারে খুলতে পারিনি: ${String((browserResult as any).error).slice(0, 300)}`
            : `⚠️ Could not open in the browser: ${String((browserResult as any).error).slice(0, 300)}`;
        } else {
          resultText = isBn
            ? `✅ ব্রাউজার ট্যাবে খোলা হয়েছে: ${targetUrl}`
            : `✅ Opened in the Browser tab: ${targetUrl}`;
        }
      } else {
        const cached = await getCachedToolResult(direct.tool, direct.args);
        if (cached.hit) {
          servedFromCache = true;
          resultText = formatDirectResult(direct.tool, cached.result);
        } else {
          const result = await executeServerTool(direct.tool, direct.args, (a) => sendEvent({ type: 'action', action: a }), { sessionId });
          await setCachedToolResult(direct.tool, direct.args, result);
          resultText = formatDirectResult(direct.tool, result);
        }
      }
      usageLedger.directServed = true;
      addToolCall(usageLedger, servedFromCache);
      sendEvent({ type: 'action', action: direct.label + (servedFromCache ? ' (cached)' : '') });
      sendEvent({ type: 'text', text: resultText });
      finalAssistantText = resultText;
      sendEvent({ type: 'done', fullText: resultText, direct: true, apiCalls: 0, model: null });
    } catch (err: any) {
      sendEvent({ type: 'error', error: `Direct command failed: ${String(err?.message || err).slice(0, 200)}` });
    }
    await saveChatTurn(sessionId || 'default', initialLastMessage, finalAssistantText || '(direct command)').catch(() => {});
    const totals = usageTotals(usageLedger);
    recordTurnUsage(sessionId || 'default', totals);
    sendEvent({ type: 'usage_summary', usage: totals });
    res.end();
    return;
  }

  // BROWSER WORK — "open the browser and use site X to do Y" (e.g.
  // "ব্রাউজার খুলে গুগল এআই স্টুডিওকে প্রম্পট দিয়ে ওয়েবসাইট বানাও"):
  // the work happens IN the browser, not in Nexus's own build pipeline.
  // The browser is opened FIRST (deterministically, before any model
  // call), then the turn runs the normal agent loop with a browser-work
  // system instruction (no omo_coordinate, no file writes). Pure
  // navigation is already handled by the Tier-0 direct path above, and
  // plain build requests never match matchBrowserWork, so they are
  // unaffected. A failed browser open ends the turn with a plain-words
  // error — it must NOT fall through to the build pipeline, which would
  // silently do the wrong thing.
  const browserWork = matchBrowserWork(initialLastMessage);
  let browserWorkLiveSessionId: string | undefined;
  if (browserWork) {
    const isBn = /[\u0980-\u09FF]/.test(initialLastMessage);
    try {
      const bwCtx: ToolExecutionContext = { sessionId };
      const gotoResult: any = await executeServerTool('browser_goto', { url: browserWork.url }, (a) => sendEvent({ type: 'action', action: a }), bwCtx);
      if (!gotoResult || gotoResult.error || !gotoResult.liveSessionId) {
        throw new Error(String(gotoResult?.error || 'live browser session could not be started'));
      }
      browserWorkLiveSessionId = gotoResult.liveSessionId as string;
      sendEvent({ type: 'live_browser', sessionId: browserWorkLiveSessionId, url: gotoResult.liveSessionUrl || browserWork.url });
      sendEvent({ type: 'action', action: isBn ? `🌐 ব্রাউজার খোলা হয়েছে: ${browserWork.site} — সেখানেই কাজ করছি।` : `🌐 Live browser opened: ${browserWork.site} — working there now.` });
      systemOptions.browserWork = { site: browserWork.site, url: browserWork.url, task: browserWork.action };
      lastMessage += `\n\n[BROWSER-WORK TURN — the live browser is ALREADY OPEN at ${browserWork.url} (${browserWork.site}). Do the requested work IN that browser with the browser_* tools. Do NOT call omo_coordinate and do NOT write any workspace files.]`;
    } catch (err: any) {
      const why = String(err?.message || err).slice(0, 300);
      const errText = isBn
        ? `⚠️ ব্রাউজার খুলতে পারিনি: ${why}`
        : `⚠️ Could not open the browser: ${why}`;
      sendEvent({ type: 'text', text: errText });
      finalAssistantText = errText;
      sendEvent({ type: 'done', fullText: errText, direct: true, apiCalls: 0 });
      await saveChatTurn(sessionId || 'default', initialLastMessage, errText).catch(() => {});
      const totals = usageTotals(usageLedger);
      recordTurnUsage(sessionId || 'default', totals);
      sendEvent({ type: 'usage_summary', usage: totals });
      res.end();
      return;
    }
  }

  // STEP 13 (P1): prompt/build response cache — an exact repeat of a build
  // prompt serves the stored build with ZERO model calls: this lookup runs
  // BEFORE the intent gate and the router, so a hit never reaches either.
  // Key = normalised prompt + requested model + task ('coding'). Image
  // builds are excluded (the vision brief changes the effective prompt but
  // is not part of the key), and `bypassCache` ("rebuild anyway") skips
  // the lookup while still storing the fresh build afterwards.
  // A browser-work turn must never serve a cached workspace build — the
  // user asked for the work to happen in the browser.
  const isBuildTurn = isActionOrBuildPrompt(initialLastMessage);
  const cacheModelKey = explicitGeminiModel ?? 'auto';
  const buildCacheKeyValue = isBuildTurn && !imageBase64 && !browserWork
    ? buildCacheKey(initialLastMessage, cacheModelKey, 'coding')
    : null;
  if (buildCacheKeyValue && !bypassCache) {
    const hit = await getBuildCacheEntry(buildCacheKeyValue);
    if (hit) {
      // Restore the stored HTML to this session's preview file so the
      // Live Preview iframe shows the cached build.
      try {
        const absPreview = path.resolve(process.cwd(), sessionPreviewTarget);
        await fs.mkdir(path.dirname(absPreview), { recursive: true });
        await fs.writeFile(absPreview, hit.html, 'utf-8');
      } catch { /* preview restore failed — client still gets HTML via preview_ready */ }
      const cachedPreviewUrl = hit.previewUrl || `/${sessionPreviewTarget}`;
      sendEvent({ type: 'action', action: '⚡ Cached build — আগের তৈরি সাইটটি ক্যাশ থেকে দেওয়া হচ্ছে, কোনো মডেল কল হয়নি।' });
      sendEvent({ type: 'text', text: hit.reply });
      finalAssistantText = hit.reply;
      sendEvent({ type: 'file_modified', filePath: sessionPreviewTarget, action: 'created' });
      sendEvent({ type: 'preview_ready', url: cachedPreviewUrl, sessionId, html: hit.html, timestamp: Date.now(), cached: true });
      sendEvent({ type: 'done', fullText: hit.reply, model: hit.builtByModel || hit.model, cached: true, cacheHits: hit.hits, apiCalls: 0 });
      await saveChatTurn(sessionId || 'default', initialLastMessage, hit.reply).catch(() => {});
      const totals = usageTotals(usageLedger);
      recordTurnUsage(sessionId || 'default', totals);
      sendEvent({ type: 'usage_summary', usage: totals });
      res.end();
      return;
    }
  }

  // Memory + lessons: read at session start (the model is stateless — this
  // is the agent's memory). Injected into the system prompt.
  try {
    systemOptions.memory = await readUserMemory();
    systemOptions.lessons = await readLessons();
  } catch { /* memory/lessons unavailable — continue without them */ }

  // Intent gate: tools/code ONLY when the message actually needs them.
  // Local check first, then the cheap gate. Casual messages get ONE direct
  // fast-model answer — no tools, no code, no agent loop.
  // Browser-work turns are tasks by construction — no classification call.
  let isConversationalPrompt = browserWork ? false : isCasualOrConversationalOnly(initialLastMessage);
  if (!isConversationalPrompt && !browserWork) {
    const intent = await decideIntent(initialLastMessage, history);
    isConversationalPrompt = intent === 'casual';
  }

  // STEP 17 (P2/F6): vision AFTER the intent gate, not before. describeImage
  // runs on the planning (Hydrogen) chain, so describing the image before
  // classification burned a Hydrogen vision call on EVERY turn with an image
  // — including a plain "hi", where the brief was then ignored (the casual
  // answer uses the user's text, not the brief). Classify intent first
  // (cheap/local) and only describe the image when the turn actually needs
  // it: a task turn (build from the design), or a casual turn that asks
  // about the image itself ("what's in this image?", "describe this
  // image"). Direct commands already returned above, so they never pay
  // for vision either. A failure here still falls back to the user's text.
  if (imageBase64 && (!isConversationalPrompt || asksAboutImage(initialLastMessage))) {
    try {
      sendEvent({ type: 'action', action: '🖼️ Image received — describing the design...' });
      const { brief, model } = await describeImage(imageBase64, imageMime || 'image/jpeg');
      lastMessage += `\n\n[IMAGE DESIGN BRIEF — the user uploaded a design image. Build a site matching this design:\n${brief}]`;
      addLlmStep(usageLedger, { kind: 'vision', model, tier: costTierOfModel(model), promptTokens: 1000, completionTokens: estimateTokens(brief), estimated: true, note: 'vision description (image tokens estimated)' });
    } catch (err: any) {
      sendEvent({ type: 'action', action: `⚠️ Could not describe the uploaded image (${String(err?.message || err).slice(0, 120)}). Building from your text instead.` });
    }
  }
  if (isConversationalPrompt) {
    try {
      const mem = (systemOptions.memory || '').slice(0, 1500);
      // STEP 17 (P2/F6): answer from `lastMessage`, not the raw user text —
      // when this casual turn asked about an uploaded image, the vision
      // brief was appended to `lastMessage` above and the cheap model needs
      // it to answer (it cannot see the image). With no image the two are
      // identical, so plain casual turns are unchanged.
      const { text, model, usage } = await chatOnce({
        system: CASUAL_SYSTEM + (mem ? `\n\nUSER MEMORY (durable facts):\n${mem}` : ''),
        user: lastMessage,
        chain: chatChain(),
        maxTokens: 800,
        timeoutMs: 60000,
      });
      // FIX (2026-11-27): an empty direct answer used to be sent as `done`
      // with an empty fullText — the user saw an empty reply with no error.
      // Treat it as a failure: send the plain-words error and end.
      if (!text.trim()) {
        sendEvent({ type: 'error', error: '⚠️ কোনো মডেল সাড়া দেয়নি (খালি উত্তর)। Keys ট্যাবে Gemini / Groq / OpenRouter কী-র স্থিতি চেক করুন, অথবা env vars সেট করুন (GEMINI_API_KEYS / GROQ_API_KEYS / OPENROUTER_API_KEYS)।' });
        res.end();
        return;
      }
      addLlmStep(usageLedger, { kind: 'llm', model, tier: costTierOfModel(model), promptTokens: usage?.prompt_tokens ?? estimateTokens(initialLastMessage), completionTokens: usage?.completion_tokens ?? estimateTokens(text), estimated: !usage });
      sendEvent({ type: 'text', text });
      finalAssistantText = text;
      sendEvent({ type: 'done', fullText: text, model, direct: false, apiCalls: 1 });
      await saveChatTurn(sessionId || 'default', initialLastMessage, text).catch(() => {});
      const totals = usageTotals(usageLedger);
      recordTurnUsage(sessionId || 'default', totals);
      sendEvent({ type: 'usage_summary', usage: totals });
      res.end();
      return;
    } catch (err: any) {
      // No provider keys at all: answer in Bengali and stop — do NOT fall
      // through to the agent loop (it would fail the same way, and the user
      // would see a misleading rotation error instead of the real cause).
      const msg = String(err?.message || '');
      if (err?.code === NO_PROVIDER_KEYS_CODE || msg.includes('কোনো API key বসানো হয়নি')) {
        sendEvent({ type: 'text', text: NO_PROVIDER_KEYS_MESSAGE });
        finalAssistantText = NO_PROVIDER_KEYS_MESSAGE;
        sendEvent({ type: 'done', fullText: NO_PROVIDER_KEYS_MESSAGE, direct: true, apiCalls: 0 });
        await saveChatTurn(sessionId || 'default', initialLastMessage, NO_PROVIDER_KEYS_MESSAGE).catch(() => {});
        const totals = usageTotals(usageLedger);
        recordTurnUsage(sessionId || 'default', totals);
        sendEvent({ type: 'usage_summary', usage: totals });
        res.end();
        return;
      }
      // STEP 6 (P0): any other casual failure ALSO stops here — do NOT fall
      // through to the agent loop. chatOnce already walks the whole cheap
      // chain (and the embedded router does its own failover), so every
      // cheap model has been tried by the time we are here. Falling through
      // would re-run the full retry loop (maxAttempts = pool*2, plus the
      // 12-model studio fallback) on Hydrogen for a plain "hi". Answer
      // with a short friendly error and end instead.
      const casualFailureMessage = '⚠️ দুঃখিত, এখন উত্তর দিতে পারছি না — প্রোভাইডার সাময়িকভাবে সাড়া দিচ্ছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন। সমস্যা চলতে থাকলে Keys ট্যাবে Gemini / Groq / OpenRouter কী-র স্থিতি চেক করুন।';
      addSystemLog({
        level: 'error',
        category: 'execution',
        message: `Casual direct answer failed: ${msg.slice(0, 180)}`,
      });
      sendEvent({ type: 'error', error: casualFailureMessage });
      finalAssistantText = casualFailureMessage;
      await saveChatTurn(sessionId || 'default', initialLastMessage, casualFailureMessage).catch(() => {});
      const totals = usageTotals(usageLedger);
      recordTurnUsage(sessionId || 'default', totals);
      sendEvent({ type: 'usage_summary', usage: totals });
      res.end();
      return;
    }
  }
  const allowTools = !isConversationalPrompt;
  systemOptions.conversational = isConversationalPrompt;

  // STEP 3 (P0, continued): this turn reaches a model loop, so refresh the
  // rolling summary from the server-stored history (one cheap-model call,
  // ~200-300 tokens) and prepend it when older turns exist beyond the
  // window — either dropped from this turn's history or known to the server
  // (the client now sends only the last N turns, so the server may hold
  // turns the client no longer sends). Only `history` is rebuilt here:
  // prepending cannot change the last turn, and `lastMessage` may already
  // carry the vision brief appended above — it must survive untouched.
  if (sessionId) {
    const rolling = await ensureRollingSummary(sessionId);
    if (rolling.summary && (droppedMessages.length > 0 || rolling.coversBeyondWindow)) {
      messagesForModel = [summaryTurn(rolling.summary), ...recentMessages];
      history = prepareGeminiHistoryAndLastMessage(messagesForModel).history;
    }
  }

  // Skill trigger matching (deterministic, from the registry `triggers` field):
  // if the user's request matches any of the registered skills, preload
  // their full instructions into the system prompt so the model follows them
  // without having to call read_skill first. read_skill stays available for
  // fetching any skill by name at any time. Browser-work turns need no
  // Nexus build skills — the work happens in the browser, not the workspace.
  if (!isConversationalPrompt && !browserWork) {
    const matchedSkills = matchSkillsForPrompt(initialLastMessage, 3);
    if (matchedSkills.length > 0) {
      systemOptions.matchedSkills = matchedSkills
        .map(s => `### ${s.name}\n${s.instructions}`)
        .join('\n\n');
      sendEvent({
        type: "action",
        action: `📚 Skills loaded: ${matchedSkills.map(s => s.name).join(', ')}`
      });
    }
  }

  // Inject active workspace & session preview context ONLY for non-casual prompts (saves tokens and prevents tools on "Hi"). Browser-work turns
  // must not see it — it tells the model to inspect/modify workspace files.
  if (!isConversationalPrompt && !browserWork) {
    try {
      const contextNotes: string[] = [];
      for (const candidate of Array.from(new Set([sessionPreviewTarget, 'projects/index.html']))) {
        const absCandidate = path.resolve(process.cwd(), candidate);
        try {
          const stat = await fs.stat(absCandidate);
          if (stat.isFile() && stat.size > 40) {
            const previewHead = await fs.readFile(absCandidate, 'utf-8').then(c => c.slice(0, 600)).catch(() => '');
            const titleMatch = previewHead.match(/<title>([^<]+)<\/title>/i);
            contextNotes.push(`- ${candidate} exists (${stat.size} bytes${titleMatch ? `, title: "${titleMatch[1].trim()}"` : ''})`);
          }
        } catch {}
      }
      if (contextNotes.length > 0) {
        lastMessage += `\n\n[ACTIVE SESSION WORKSPACE CONTEXT]:
Existing live preview file(s):
${contextNotes.join('\n')}
When modifying or adding features to the current session app, FIRST inspect the existing file with view_file, then update it directly using write_to_file or replace_file_content.`;
      }
    } catch {}
  }

  // Auto-detect reference website URLs and scrape their structure, layout & copy.
  // Skipped for browser-work turns: the URL there is the site to WORK IN,
  // not a reference to build a similar site from.
  const urlRegex = /(https?:\/\/[^\s<>'"]+)/gi;
  const foundUrls = initialLastMessage.match(urlRegex);
  if (foundUrls && foundUrls.length > 0 && !browserWork) {
    const rawTargetUrl = foundUrls[0].replace(/[),.]+$/, '');
    sendEvent({
      type: "action",
      action: `🔍 Analyzing reference website: ${rawTargetUrl}...`
    });

    try {
      // 1. Try Jina Reader for clean, high-fidelity markdown layout extraction
      const jinaRes = await fetch(`https://r.jina.ai/${rawTargetUrl}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/plain,text/markdown,*/*',
        },
        signal: AbortSignal.timeout(9000),
      });

      if (jinaRes.ok) {
        const pageMarkdown = await jinaRes.text();
        if (pageMarkdown && pageMarkdown.length > 80) {
          sendEvent({
            type: "action",
            action: `✓ Scraped reference structure from ${rawTargetUrl}! Synthesizing matching design...`
          });
          lastMessage += `\n\n[REFERENCE WEBSITE CONTENT - SCRAPED FROM ${rawTargetUrl}]:
---
${pageMarkdown.slice(0, REFERENCE_SCRAPE_MAX_CHARS)}
---
BUILD A SIMILAR SITE (INSPIRED-BY, NEVER A COPY):
1. The user wants a website LIKE ${rawTargetUrl} — similar layout, sections and style, with FRESH, original content written by you.
2. Observe its real navbar links, brand title/logo, hero tagline, buttons, content sections, pricing/feature cards, and footer — then build the same KINDS of sections with your own words and design.
3. NEVER copy its copyrighted text, images, logos or branding. NEVER claim to copy its private source code — only the public rendered page is visible.
4. Make all elements interactive (nav buttons, tabs, modal dialogs, search filters).
5. Write the complete production HTML/CSS/JS directly to ${sessionPreviewTarget} using write_to_file (NEVER dump code into chat).`;
        }
      }
    } catch (scrapeErr) {
      console.warn("Auto-scrape failed:", scrapeErr);
      lastMessage += `\n\n[SYSTEM DIRECTIVE: The user linked reference website ${rawTargetUrl}. Call webFetch with this URL or webSearch to inspect its actual features and layout before writing code.]`;
    }
  }

  // Merge user keys with any server-persisted secrets
  const diskSecrets = await loadSecrets();
  const allKeysMap = new Map<string, KeyConfig>();
  for (const k of diskSecrets) {
    k.model = normalizeModelName(k.provider, k.model);
    allKeysMap.set(k.id, k);
  }
  for (const k of userKeys) {
    k.model = normalizeModelName(k.provider, k.model);
    allKeysMap.set(k.id, k);
  }
  const activePool = Array.from(allKeysMap.values()).filter(k => 
    Boolean(k.isActive && k.apiKey)
  );

  if (process.env.GEMINI_API_KEY && !preferOnlyCustomKeys) {
    const hasStudio = activePool.some(k => k.id === 'studio_primary_key');
    if (!hasStudio) {
      activePool.push({
        id: 'studio_primary_key',
        name: 'Primary Studio Engine',
        provider: 'gemini',
        apiKey: process.env.GEMINI_API_KEY,
        model: 'gemini-3.1-flash-lite',
        isActive: true,
        rpmLimit: 60,
        status: 'healthy'
      });
    }
  }

  if (activePool.length === 0) {
    addSystemLog({
      level: 'error',
      category: 'auth',
      message: 'রিকোয়েস্ট বাতিল: কোনো সচল সিক্রেট কী পাওয়া যায়নি। প্রাইমারি ইঞ্জিন নিষ্ক্রিয় রাখা হয়েছে।'
    });
    sendEvent({
      type: "error",
      error: "⚠️ কোনো সচল প্রোভাইডার কী পাওয়া যায়নি! Keys ট্যাবে Gemini / Groq / OpenRouter কী যুক্ত করুন, অথবা env vars সেট করুন (GEMINI_API_KEYS / GROQ_API_KEYS / OPENROUTER_API_KEYS — দেখুন README)।",
      isAuthError: true
    });
    res.end();
    return;
  }

  const excludedKeyIds = new Set<string>();
  // Two full passes over the pool, not one: after every key has been tried
  // once, selectBestKey returns null and the loop reaches the "no key left"
  // branch, where the per-minute rollover retry and the network retry live.
  // With maxAttempts === pool length the loop exited exactly when the pool
  // was exhausted, so those retries were unreachable dead code (a network
  // blip on the last key ended the turn with no second chance). The retry
  // passes each fire at most once and reset attempts, so the loop still
  // terminates; mixed failures break out at the first "no key left".
  // STEP 13: mtime of the session preview BEFORE this turn — the store step
  // only caches when the turn actually (re)wrote the preview file, so a
  // turn that only talked never caches the previous turn's site.
  let previewMtimeBefore: number | null = null;
  try {
    previewMtimeBefore = (await fs.stat(path.resolve(process.cwd(), sessionPreviewTarget))).mtimeMs;
  } catch { /* no preview yet — any file afterwards is this turn's work */ }
  // STEP 13: model that actually produced this turn's build (for the cache entry).
  let lastUsedModel: string | null = null;

  const maxAttempts = activePool.length * 2;
  let attempts = 0;
  // STEP 15 (a): one checkpoint for the whole turn — every key attempt
  // resumes from it, so a late 429 does not restart the turn from scratch.
  // It also survives the per-minute-rollover and network retries below
  // (they reset `attempts`, not the checkpoint).
  const turnCheckpoint = newTurnCheckpoint();
  let succeeded = false;
  let sawDailyFreeLimit = false;
  let sawRateLimit = false;
  let sawProviderOverload = false;
  let sawAuthError = false;
  let sawNetworkError = false;
  // Per-minute-limit tracking for the all-keys-RPM wait-and-retry: RPM/TPM
  // budgets roll over every minute, so if every key failed only on RPM/TPM
  // (never daily, never auth), the turn waits once and retries the pool.
  let sawRpmLimit = false;
  let lastRetryAfterSec = 60;
  let didMinuteRolloverRetry = false;
  let didNetworkRetry = false;
  let lastFailureMessage = '';
  const failedGeminiModels = new Set<string>();
  // Turn-scoped (model -> keyIds) map of pairs that already 429'd this
  // turn. A 429 rotates keys on the SAME model; only when EVERY Gemini key
  // has 429'd on that model does the turn drop to the next live model.
  const gemini429ByModel = new Map<string, Set<string>>();
  const geminiKeyIds = new Set(activePool.filter((k) => k.provider === 'gemini').map((k) => k.id));

  // The task this turn is really doing, derived from the user's own
  // message — the same derivation the router uses (routeChatCompletion
  // derives its task from the user messages instead of hardcoding one).
  // The orchestrator's canonical classifier is classifyTask (llmClient):
  // 'reasoning' maps to the 'planning' chain, exactly as
  // streamOpenAICompatible already does above. The old code hardcoded
  // 'coding' here, so a chat/reasoning turn was sent down the coding
  // chain (Hydrogen first) instead of its own quality-ordered chain.
  const turnTask = orchestratorTurnTask(initialLastMessage);

  const buildGeminiModelChain = (primary?: string | null) => {
    // Live-discovered Gemini-only chain (quality-ordered for THIS turn's
    // task, healthy only; Hydrogen already scores 95 so it stays first
    // when live). The hardcoded list below is the cold-boot fallback when
    // the catalog is empty — never the authority.
    const live = getChainForTask(turnTask, 'gemini', 12).map((e) => e.model);
    const defaults = [
      'gemini-4-hydrogen',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.1-flash-lite',
    ];
    const base = live.length ? live : defaults;
    // STEP 16 (b): the primary model comes from the key's STORED model
    // (or the explicit override) and used to be prepended unchecked — a
    // key whose stored model is paid-only (gemini-4-argon/carbon etc.)
    // was attempted here even though the router blocks those ids. The
    // same exclusion gate the router uses (gateGeminiPrimary, built on
    // isModelExcluded) now applies: an excluded primary is dropped and
    // the chain falls back to the live/default list instead of
    // attempting a paid model.
    const usablePrimary = gateGeminiPrimary(primary);
    if (primary && !usablePrimary) {
      console.warn(`[orchestrator] Stored primary model ${primary} is paid-only/retired — excluded from the Gemini chain.`);
    }
    const ordered = usablePrimary
      ? [usablePrimary, ...base.filter(m => m !== usablePrimary)]
      : base;
    return ordered.filter(m => !failedGeminiModels.has(m));
  };

  while (attempts < maxAttempts && !succeeded) {
    attempts++;
    
    // Select the best key: prioritizes remembered working key, otherwise rotates through every remaining active key
    const { key, reason: selectionReason } = selectBestKey(activePool, preferredProvider, excludedKeyIds, reqStickyKeyId);

    if (key) {
      excludedKeyIds.add(key.id);
      if (selectionReason) {
        sendEvent({ type: "action", action: `🔑 ${selectionReason}: ${key.name}` });
      }
      const activeModel = key.provider === 'gemini'
        ? (explicitGeminiModel || normalizeModelName('gemini', key.model))
        : (key.model || 'default');
      sendEvent({
        type: "key_active",
        keyId: key.id,
        keyName: key.name,
        provider: key.provider,
        model: activeModel,
        isCustomKey: key.id !== 'studio_primary_key'
      });
      sendEvent({
        type: "action",
        action: `Routing via ${key.name} (${key.provider.toUpperCase()} • ${activeModel})...`
      });
      emitActionStep(
        sendEvent,
        'command',
        `Connected ${key.name} (${activeModel})`,
        `${key.provider.toUpperCase()} • ${activeModel}`,
        { status: 'done' }
      );

      const buildExecCtx = (invoker: (sys: string, usr: string) => Promise<string>): ToolExecutionContext => {
        // Multi-tab: seed the turn's live tabs from the Browser tab so the
        // agent can drive tabs the user opened (not only its own). The
        // active tab is the one the user is looking at (else the first).
        const seededTabs = Array.isArray((req as any).liveTabs)
          ? (req as any).liveTabs.filter((t: any) => t && typeof t.id === 'string').slice(0, 4)
              .map((t: any) => ({ id: t.id, url: typeof t.url === 'string' ? t.url : undefined }))
          : [];
        // BROWSER WORK: the browser was opened before the loop — every
        // browser_* tool call in this turn reuses that same session, so
        // the model never starts a second one (and never sees "no live
        // browser session yet"). It becomes the active tab (prepended to
        // the seeded list when not already there).
        const liveSessions = browserWorkLiveSessionId
          ? (seededTabs.some((t: any) => t.id === browserWorkLiveSessionId)
              ? seededTabs
              : [{ id: browserWorkLiveSessionId, url: browserWork?.url }, ...seededTabs].slice(0, 4))
          : seededTabs;
        const seededActive = liveSessions.find((t: any) => t.id === (req as any).activeLiveTabId) || liveSessions[0];
        const activeTab = browserWorkLiveSessionId
          ? { id: browserWorkLiveSessionId, url: browserWork?.url }
          : seededActive;
        return {
          sessionId,
          liveSessions,
          liveSessionId: activeTab?.id,
          liveSessionUrl: activeTab?.url,
          llmInvoker: invoker,
          onAskQuestion: (questions) => {
            const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                if (pendingQuestionResolvers.delete(questionId)) {
                  resolve({ answers: {}, skipped: true, notes: 'Timed out waiting for response.' });
                }
              }, 120000);
              pendingQuestionResolvers.set(questionId, { resolve, timer });
              res.once('close', () => {
                if (pendingQuestionResolvers.delete(questionId)) {
                  clearTimeout(timer);
                  resolve({ answers: {}, skipped: true, notes: 'Client disconnected.' });
                }
              });
              sendEvent({
                type: 'ask_question',
                questionId,
                questions,
              });
            });
          },
          onAgentStep: (agentStep) => {
            emitActionStep(sendEvent, agentStep.kind, agentStep.label, agentStep.detail, {
              id: agentStep.id,
              status: agentStep.status,
              durationSec: agentStep.durationSec,
              isError: agentStep.status === 'error',
            });
          },
        };
      };

      try {
        if (key.provider === 'gemini') {
          const cleanGeminiKey = key.apiKey.trim().replace(/^["']|["']$/g, '');
          let client = new GoogleGenAI({
            apiKey: cleanGeminiKey,
            httpOptions: {
              headers: {
                "User-Agent": "aistudio-build"
              }
            }
          });
          const geminiChain = buildGeminiModelChain(explicitGeminiModel || normalizeModelName('gemini', key.model));
          // FIX (2026-11-27): when every model in the chain was already
          // marked failed this turn, geminiChain is EMPTY and the candidate
          // loop below runs zero times — fullText stays '' and the code
          // fell through to `done` with an empty reply (silent success).
          // An empty chain is a failure, not a success.
          if (geminiChain.length === 0) {
            throw new Error('All Gemini models in this turn\u2019s chain were already tried and failed — rotating to the next key.');
          }
          let fullText = '';
          let usedModel = geminiChain[0];
          let geminiChainErr: any = null;
          let triedVertexExpress = false;

          for (const candidateModel of geminiChain) {
            usedModel = candidateModel;
            try {
              const execCtx = buildExecCtx(async (sys, usr) => {
                const subRes = await client.models.generateContent({
                  model: candidateModel,
                  contents: usr,
                  config: { systemInstruction: sys },
                });
                return subRes.text || '';
              });

              fullText = await runGeminiAgentLoop(
                client,
                candidateModel,
                mode,
                systemOptions,
                history,
                lastMessage,
                initialLastMessage,
                sendEvent,
                execCtx,
                key,
                allowTools,
                usageLedger,
                turnCheckpoint
              );
              geminiChainErr = null;
              break;
            } catch (mErr: any) {
              geminiChainErr = mErr;
              const mMsg = mErr?.message || '';
              if (!triedVertexExpress && cleanGeminiKey.startsWith('AQ.') && /ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid/i.test(mMsg)) {
                triedVertexExpress = true;
                try {
                  client = new GoogleGenAI({
                    vertexai: true,
                    apiKey: cleanGeminiKey,
                    httpOptions: { headers: { "User-Agent": "aistudio-build" } }
                  });
                  const vExecCtx = buildExecCtx(async (sys, usr) => {
                    const subRes = await client.models.generateContent({
                      model: candidateModel,
                      contents: usr,
                      config: { systemInstruction: sys },
                    });
                    return subRes.text || '';
                  });
                  fullText = await runGeminiAgentLoop(
                    client,
                    candidateModel,
                    mode,
                    systemOptions,
                    history,
                    lastMessage,
                    initialLastMessage,
                    sendEvent,
                    vExecCtx,
                    key,
                    allowTools,
                    usageLedger,
                    turnCheckpoint
                  );
                  geminiChainErr = null;
                  break;
                } catch (vErr: any) {
                  geminiChainErr = vErr;
                }
              }
              // 429 / quota is a PER-KEY limit, not a model problem: do NOT
              // mark the model failed and do NOT drop to a weaker model on
              // this key. Break out so the outer loop rotates to the NEXT
              // KEY with the SAME model (zero quality loss). Only 404/503
              // (model unavailable for this key/project) fall through to the
              // next model on the same key.
              const isQuota = mErr?.status === 429 || /429|quota|resource_exhausted|rate limit|free-models-per-day/i.test(mMsg);
              if (isQuota) {
                // Record this (model, key) pair as 429'd this turn. Rotate
                // keys on the SAME model first; drop to the next live model
                // ONLY when every Gemini key has 429'd on this model.
                let hitKeys = gemini429ByModel.get(candidateModel);
                if (!hitKeys) { hitKeys = new Set(); gemini429ByModel.set(candidateModel, hitKeys); }
                hitKeys.add(key.id);
                const allKeysHit = shouldDropGeminiModel(hitKeys, geminiKeyIds);
                if (allKeysHit) {
                  failedGeminiModels.add(candidateModel);
                  sendEvent({
                    type: "action",
                    action: `⚡ ${candidateModel}: সব কী-তে লিমিট — পরের Gemini মডেলে যাওয়া হচ্ছে...`
                  });
                  continue;
                }
                sendEvent({
                  type: "action",
                  action: `⚡ ${candidateModel}: this key hit its limit — rotating to the next key, same model...`
                });
                break;
              }
              // FIX (2026-11-27): a 401/auth failure is a PER-KEY problem,
              // not a model problem — the model is fine for other keys. The
              // old code added the model to failedGeminiModels on ANY
              // failure, so four keys with bad keys burned all four models
              // and the next key got an empty chain (silent empty reply).
              // Only 404/503 (model unavailable) blacklists the model.
              const isAuth = mErr?.status === 401 || /401|API key not valid|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|User not found/i.test(mMsg);
              // Network/transport errors are RETRYABLE like 503/404: the
              // model is fine, the connection broke — try the next model on
              // this key (fresh connection), then the outer loop rotates to
              // the next key. The old code threw here, short-circuiting the
              // whole model chain on the first network blip.
              const isNetwork = isNetworkErrorMessage(mMsg);
              const isModelRetryable =
                mErr?.status === 503 ||
                mErr?.status === 404 ||
                isNetwork ||
                /503|404|high demand|UNAVAILABLE|not found|not supported/i.test(mMsg);
              if (isAuth || !isModelRetryable) throw geminiChainErr;
              if (isNetwork) {
                // The model itself is fine — do NOT blacklist it for the
                // turn (the next key gets the full chain again).
                sendEvent({
                  type: "action",
                  action: `⚠️ নেটওয়ার্ক সমস্যায় ${candidateModel} সাড়া দেয়নি — পরের Gemini মডেল দিয়ে আবার চেষ্টা করা হচ্ছে...`
                });
              } else {
                failedGeminiModels.add(candidateModel);
                sendEvent({
                  type: "action",
                  action: `⚡ ${candidateModel} unavailable, switching to backup Gemini model...`
                });
              }
            }
          }

          if (geminiChainErr) throw geminiChainErr;

          recordKeySuccess(key.id);
          lastUsedModel = usedModel;
          addSystemLog({
            level: 'success',
            category: 'execution',
            keyName: key.name,
            provider: key.provider,
            model: usedModel,
            message: `✓ Success: ${key.name} responded successfully (${usedModel}). Saved as sticky key for next turn.`
          });
          const deployed = await autoDeployWebsiteFromText(fullText, sessionId);
          if (deployed.success) {
            const previewUrl = deployed.url || "/projects/index.html";
            sendEvent({ type: "action", action: `✓ Website deployed to ${previewUrl}! Live Preview ready.` });
            sendEvent({ type: "file_modified", filePath: deployed.path || 'projects/index.html', action: 'created' });
            emitActionStep(sendEvent, 'build', 'Deployed PWA preview', previewUrl, { status: 'done' });
            sendEvent({ 
              type: "preview_ready", 
              url: previewUrl, 
              sessionId,
              html: deployed.html,
              timestamp: Date.now() 
            });
          }
          emitActionStep(sendEvent, 'respond', 'Responded', undefined, { status: 'done' });
          finalAssistantText = fullText;
          sendEvent({ 
            type: "done", 
            fullText, 
            activeKeyId: key.id,
            keyName: key.name,
            provider: key.provider,
            model: usedModel,
            isCustomKey: key.id !== 'studio_primary_key'
          });
          succeeded = true;
          break;
        } 
        else if (['openrouter', 'groq', 'cerebras', 'mistral', 'grok', 'custom', 'freellmapi'].includes(key.provider)) {
          // Quality-ordered routing: the turn's first model comes from the
          // live chain for its task (coding → Hydrogen first when live;
          // planning → strongest free reasoner; chat → fastest). The
          // configured model is the fallback when discovery has no data.
          const configuredModel = normalizeModelName(key.provider, key.model);
          const targetModel = routeTurnModel(initialLastMessage, configuredModel);
          const turnEffort = turnReasoningEffort(initialLastMessage);
          const endpoint = getOpenAICompatibleEndpoint(key.provider, key.baseUrl);
          const extraHeaders: Record<string, string> = key.provider === 'openrouter'
            ? { 'HTTP-Referer': 'https://nexus-ai.local', 'X-Title': 'Nexus AI' }
            : {};

          // Planner sub-calls (Architect / Reviewer / debug analysis) run on
          // the planning chain — strongest free reasoner, high effort by
          // default, xhigh only for hard plans — with the same endpoint/key.
          const execCtx = buildExecCtx(async (sys, usr) => {
            const effort = pickPlanningEffort(usr);
            const chain = planningChain();
            let lastErr = '';
            for (const model of chain) {
              try {
                noteModelAttempt(model, key.id);
                const subRes = await fetch(endpoint, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${key.apiKey}`,
                    'Content-Type': 'application/json',
                    ...extraHeaders,
                  },
                  body: JSON.stringify({
                    model,
                    messages: [
                      { role: 'system', content: sys },
                      { role: 'user', content: usr },
                    ],
                    reasoning_effort: effort,
                    stream: false,
                  }),
                });
                const j = await subRes.json().catch(() => null);
                const content = j?.choices?.[0]?.message?.content || '';
                if (subRes.ok && content) {
                  recordModelSuccess(model);
                  const pu = j?.usage;
                  addLlmStep(usageLedger, { kind: 'plan', model, tier: costTierOfModel(model), promptTokens: pu?.prompt_tokens ?? estimateTokens(sys + usr), completionTokens: pu?.completion_tokens ?? estimateTokens(content), estimated: !pu, note: 'planner sub-call' });
                  return content;
                }
                recordModelFailure(model, subRes.status, subRes.headers.get('retry-after'));
                lastErr = j?.error?.message || `HTTP ${subRes.status}`;
              } catch (e: any) {
                lastErr = e?.message || String(e);
              }
            }
            console.warn(`[planner] All planning models failed: ${lastErr}`);
            return '';
          });

          const fullText = await streamOpenAICompatible(
            endpoint,
            key.apiKey,
            targetModel,
            extraHeaders,
            messagesForModel, // STEP 3: windowed history (+ rolling summary), not the raw full history
            mode,
            sendEvent,
            systemOptions,
            execCtx,
            lastMessage,
            initialLastMessage,
            key,
            allowTools,
            turnEffort,
            usageLedger,
            turnCheckpoint
          );

          recordKeySuccess(key.id);
          lastUsedModel = targetModel;
          addSystemLog({
            level: 'success',
            category: 'execution',
            keyName: key.name,
            provider: key.provider,
            model: targetModel,
            message: `✓ Success: ${key.name} (${key.provider.toUpperCase()} · ${targetModel}) responded successfully. Saved as sticky key for next turn.`
          });
          const deployed = await autoDeployWebsiteFromText(fullText, sessionId);
          if (deployed.success) {
            const previewUrl = deployed.url || "/projects/index.html";
            sendEvent({ type: "action", action: `✓ Website deployed to ${previewUrl}! Live Preview ready.` });
            sendEvent({ type: "file_modified", filePath: deployed.path || 'projects/index.html', action: 'created' });
            emitActionStep(sendEvent, 'build', 'Deployed PWA preview', previewUrl, { status: 'done' });
            sendEvent({ 
              type: "preview_ready", 
              url: previewUrl, 
              sessionId,
              html: deployed.html,
              timestamp: Date.now() 
            });
          }
          emitActionStep(sendEvent, 'respond', 'Responded', undefined, { status: 'done' });
          finalAssistantText = fullText;
          sendEvent({ 
            type: "done", 
            fullText, 
            activeKeyId: key.id,
            keyName: key.name,
            provider: key.provider,
            model: targetModel,
            isCustomKey: true
          });
          succeeded = true;
          break;
        }
      } catch (err: any) {
        const errMsg = String(err?.message || err || 'Unknown error');
        lastFailureMessage = errMsg;
        const isDailyFreeLimit = /free-models-per-day/i.test(errMsg);
        const is429 = err.status === 429 || errMsg.includes("429") || /quota|rate limit|free-models-per-day/i.test(errMsg);
        const is503 = err.status === 503 || err.status === 502 || /503|502|high demand|provider returned error|unavailable/i.test(errMsg);
        const is404Model = err.status === 404 || /not found|not supported for generateContent/i.test(errMsg);
        const isQuotaExceeded = is429 || /quota exceeded|resource_exhausted/i.test(errMsg);
        const isAuthError = err.status === 401 || err.code === 401 || /401|API key not valid|UNAUTHENTICATED|User not found|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(errMsg);
        const isNetworkError = isNetworkErrorMessage(errMsg);

        // Which budget did this 429 hit? RPM/TPM = per-minute (seconds-long,
        // rolling reset); RPD = daily (until midnight Pacific). Parsed from
        // the provider's error text — never assumed. Retry-After is read from
        // the message when present ("retry after 42s" / "retry in 42 seconds").
        const limitKind: RateLimitKind | null = is429 ? classifyRateLimit(err.status === 429 ? 429 : undefined, errMsg) : null;
        // A Gemini RPD 429 sets sawRateLimit but never matched
        // /free-models-per-day/, so it landed in the per-minute message.
        // classifyRateLimit knows the budget from the error text — trust it.
        if (limitKind === 'rpd') sawDailyFreeLimit = true;
        const retryAfterMatch = /retry[- ]after\s*[:=]?\s*(\d+)|retry in\s+(\d+)\s*s/i.exec(errMsg);
        const retryAfterSec = retryAfterMatch ? Number(retryAfterMatch[1] || retryAfterMatch[2]) : parseRetryAfter(null);
        if (limitKind === 'rpm' || limitKind === 'tpm') {
          sawRpmLimit = true;
          lastRetryAfterSec = Math.max(1, Math.min(60, retryAfterSec ?? 60));
        }

        if (isDailyFreeLimit) sawDailyFreeLimit = true;
        if (isQuotaExceeded) sawRateLimit = true;
        if (is503) sawProviderOverload = true;
        if (isAuthError) sawAuthError = true;
        if (isNetworkError) sawNetworkError = true;

        if (isAuthError) {
          addSystemLog({
            level: 'error',
            category: 'auth',
            keyName: key.name,
            provider: key.provider,
            model: key.model,
            message: `❌ ${key.name}: Invalid API Key (401 Unauthorized / Access Token Unsupported). Key disabled.`,
            details: errMsg
          });
          key.isActive = false;
          loadSecrets().then((allSecrets) => {
            const existing = allSecrets.find(k => k.id === key.id);
            if (existing) {
              existing.isActive = false;
              existing.status = 'error';
              existing.lastError = 'Invalid API key format or unauthorized';
              saveSecrets(allSecrets).catch(() => {});
            }
          }).catch(() => {});
          recordKeyCooldown(key.id, 86400, "Invalid API key");
          sendEvent({
            type: "action",
            action: `❌ ${key.name}: Invalid API Key (Unauthorized). Key has been disabled.`
          });
        } else {
          // Auto-heal ONLY when the model itself is unavailable (404/503).
          // A quota 429 must NEVER rewrite the key's model to Flash-Lite:
          // rotation to the next key keeps the SAME model (Hydrogen-first).
          if ((is404Model || is503) && key.provider === 'gemini' && key.model !== 'gemini-3.1-flash-lite') {
            const oldModel = key.model;
            key.model = 'gemini-3.1-flash-lite';
            loadSecrets().then((allSecrets) => {
              const existing = allSecrets.find(k => k.id === key.id);
              if (existing) {
                existing.model = 'gemini-3.1-flash-lite';
                saveSecrets(allSecrets).catch(() => {});
              }
            }).catch(() => {});
            addSystemLog({
              level: 'warn',
              category: 'rotation',
              keyName: key.name,
              provider: key.provider,
              message: `⚡ Auto-healed ${key.name} from ${oldModel} to Gemini 3.1 Flash Lite.`
            });
          }

          // Cooldown by budget kind. RPM/TPM: short (~65s or Retry-After) —
          // the next key has a fresh per-minute budget, so the request goes
          // through with no wait. RPD: parked until midnight Pacific.
          // The UI never sees a raw 429 — only the plain-words label.
          const kind = limitKind ?? (isDailyFreeLimit ? 'rpd' as RateLimitKind : null);
          let cooldownSec: number;
          if (kind) {
            recordKeyRateLimit(key.id, kind, kind === 'rpd' ? null : lastRetryAfterSec, errMsg);
            cooldownSec = kind === 'rpd'
              ? Math.ceil((nextMidnightPacificMs() - Date.now()) / 1000)
              : Math.max(65, lastRetryAfterSec);
          } else {
            cooldownSec = isQuotaExceeded ? 60 : 15;
            recordKeyCooldown(key.id, cooldownSec, errMsg);
          }
          const friendly = kind
            ? limitLabel(kind, kind === 'rpd' ? undefined : cooldownSec)
            : (isNetworkError ? 'network error — retrying with the next key' : (is429 ? 'rate limit — retrying shortly' : 'provider error'));
          addSystemLog({
            level: 'warn',
            category: isQuotaExceeded ? 'rate_limit' : 'execution',
            keyName: key.name,
            provider: key.provider,
            message: `⚠️ ${key.name} rotated (${friendly}).`,
            details: errMsg
          });
          sendEvent({
            type: "action",
            action: `⚠️ ${key.name}: ${friendly}. Auto-rotating to next healthy API key...`
          });
          sendEvent({
            type: "key_cooldown",
            keyId: key.id,
            reason: friendly,
            cooldownSec,
            limitKind: kind
          });
        }
      }
    } else {
      // No key left to try. If EVERY failure this turn was a per-minute
      // (RPM/TPM) limit — never daily, never auth — the budgets roll over
      // every minute, so wait once (Retry-After, max 60s) and retry the pool
      // with fresh per-minute budgets instead of failing the turn.
      if (!succeeded && sawRpmLimit && !sawDailyFreeLimit && !sawAuthError && !didMinuteRolloverRetry) {
        didMinuteRolloverRetry = true;
        const waitSec = Math.max(1, Math.min(60, lastRetryAfterSec || 60));
        addSystemLog({
          level: 'info',
          category: 'rate_limit',
          message: `⏱️ All keys hit per-minute limits — waiting ${waitSec}s for the minute to roll over, then retrying the pool.`
        });
        sendEvent({ type: 'action', action: `⏱️ সব কী-তে per-minute limit — ${waitSec}s অপেক্ষা করে আবার চেষ্টা করা হচ্ছে...` });
        sendEvent({ type: 'rate_limit_wait', kind: 'rpm', waitSec });
        await new Promise(r => setTimeout(r, waitSec * 1000));
        // The minute rolled over: clear per-minute cooldowns and retry every key once.
        for (const k of activePool) {
          const st = getOrCreateStats(k.id);
          if (st.limitKind === 'rpm' || st.limitKind === 'tpm') st.cooldownUntil = 0;
        }
        excludedKeyIds.clear();
        attempts = 0;
        sawRpmLimit = false;
        continue;
      }
      // Every failure this turn was a NETWORK error (never quota, never
      // auth): the connection blipped, not the keys. Wait briefly and retry
      // the pool once with fresh connections — same pattern as the per-minute
      // rollover retry above — instead of failing the turn outright.
      if (!succeeded && sawNetworkError && !sawDailyFreeLimit && !sawAuthError && !sawRateLimit && !sawProviderOverload && !didNetworkRetry) {
        didNetworkRetry = true;
        const waitSec = 5;
        addSystemLog({
          level: 'info',
          category: 'execution',
          message: `🌐 সব চেষ্টা নেটওয়ার্ক সমস্যায় ব্যর্থ — ${waitSec}s অপেক্ষা করে পুল আবার চেষ্টা করা হচ্ছে...`
        });
        sendEvent({ type: 'action', action: `🌐 নেটওয়ার্ক সমস্যা — ${waitSec}s অপেক্ষা করে আবার চেষ্টা করা হচ্ছে...` });
        await new Promise(r => setTimeout(r, waitSec * 1000));
        // Clear only the cooldowns this turn's network errors set, so the
        // retry re-tries exactly the keys that failed on the network.
        for (const k of activePool) {
          const st = getOrCreateStats(k.id);
          if (st.lastError && isNetworkErrorMessage(st.lastError)) st.cooldownUntil = 0;
        }
        excludedKeyIds.clear();
        attempts = 0;
        sawNetworkError = false;
        continue;
      }
      addSystemLog({
        level: 'warn',
        category: 'rotation',
        message: 'পুল থেকে আর কোনো সক্রিয় ও প্রস্তুত সিক্রেট কী পাওয়া যায়নি।'
      });
      break;
    }
  }

  // Seamless Fallback: If custom keys hit errors or rate limits, auto-fallback across resilient Gemini Studio models
  if (!succeeded && !preferOnlyCustomKeys && process.env.GEMINI_API_KEY) {
    const client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });
    const fallbackChain = buildGeminiModelChain(explicitGeminiModel);

    for (const fallbackModel of fallbackChain) {
      try {
        addSystemLog({
          level: 'info',
          category: 'rotation',
          message: `স্বয়ংক্রিয় ব্যাকআপ হিসেবে প্রাইমারি স্টুডিও ইঞ্জিন (${fallbackModel}) চেষ্টা করা হচ্ছে...`
        });
        sendEvent({
          type: "key_active",
          keyId: "studio_primary",
          keyName: "Primary Studio Engine",
          provider: "gemini",
          model: fallbackModel,
          isCustomKey: false
        });
        sendEvent({
          type: "action",
          action: `⚡ প্রাইমারি স্টুডিও ইঞ্জিন (${fallbackModel}) সক্রিয় করা হয়েছে...`
        });

        const fbExecCtx: ToolExecutionContext = {
          sessionId,
          llmInvoker: async (sys, usr) => {
            const subRes = await client.models.generateContent({
              model: fallbackModel,
              contents: usr,
              config: { systemInstruction: sys },
            });
            return subRes.text || '';
          },
          onAgentStep: (agentStep) => {
            emitActionStep(sendEvent, agentStep.kind, agentStep.label, agentStep.detail, {
              id: agentStep.id,
              status: agentStep.status,
              durationSec: agentStep.durationSec,
              isError: agentStep.status === 'error',
            });
          },
        };

        const fullText = await runGeminiAgentLoop(
          client,
          fallbackModel,
          mode,
          systemOptions,
          history,
          lastMessage,
          initialLastMessage,
          sendEvent,
          fbExecCtx,
          undefined,
          allowTools,
          usageLedger,
          turnCheckpoint
        );

        succeeded = true;
        lastUsedModel = fallbackModel;
        persistStickyKeyId("studio_primary");

        const deployed = await autoDeployWebsiteFromText(fullText, sessionId);
        if (deployed.success) {
          const previewUrl = deployed.url || "/projects/index.html";
          sendEvent({ type: "action", action: `✓ Website deployed to ${previewUrl}! Live Preview ready.` });
          sendEvent({ type: "file_modified", filePath: deployed.path || 'projects/index.html', action: 'created' });
          emitActionStep(sendEvent, 'build', 'Deployed PWA preview', previewUrl, { status: 'done' });
          sendEvent({ type: "preview_ready", url: previewUrl, html: deployed.html, sessionId: sessionId || undefined });
        }

        emitActionStep(sendEvent, 'respond', 'Responded', undefined, { status: 'done' });
        sendEvent({ type: "done", keyId: "studio_primary", model: fallbackModel });
        break;
      } catch (fbErr: any) {
        const fbMsg = String(fbErr?.message || fbErr || '');
        lastFailureMessage = fbMsg;
        if (/503|high demand|UNAVAILABLE/i.test(fbMsg)) sawProviderOverload = true;
        if (/429|quota|rate limit/i.test(fbMsg)) sawRateLimit = true;
        addSystemLog({
          level: 'warn',
          category: 'rotation',
          provider: 'gemini',
          model: fallbackModel,
          message: `প্রাইমারি ব্যাকআপ মডেল (${fallbackModel}) ব্যস্ত/ব্যর্থ: ${fbMsg.slice(0, 120)}`
        });
      }
    }
  }

  if (!succeeded) {
    let finalUserError = "⚠️ প্রোভাইডার সাময়িকভাবে সাড়া দিচ্ছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।";
    let finalIsAuthError = false;

    // No provider keys at all (the router had nothing to call): say so in
    // Bengali and point at the Keys tab — never wrap the raw rotation error
    // ("No openrouter key is configured; trying ...") in the reply.
    // FIX (2026-11-27): the old check also matched /No .* key is
    // configured/ — but that text comes from a ROUTER sub-call (the embedded
    // router, or the planner's chatOnce) when ONE provider has no key, while
    // this turn's pool may hold keys for other providers. Matching it here
    // reported "no key at all" when keys existed (repro: a pool holding only
    // a custom key ended with the no-key message). The genuine keyless case
    // never reaches this block: it is handled by the activePool.length === 0
    // early return above and by the casual path's NO_PROVIDER_KEYS_CODE
    // check — so only the exact no-keys message/code counts here.
    if (/কোনো API key বসানো হয়নি|NO_PROVIDER_KEYS/i.test(lastFailureMessage)) {
      finalUserError = NO_PROVIDER_KEYS_MESSAGE;
      finalIsAuthError = true;
    } else if (sawDailyFreeLimit) {
      finalUserError = "⚠️ আপনার ফ্রি কী-গুলোর দৈনিক লিমিট শেষ হয়ে গেছে (দৈনিক কোটা পূর্ণ)। চালু রাখতে 🔑 API Keys মেনুতে নতুন একটি Gemini / Groq / OpenRouter কী যুক্ত করুন, অথবা মধ্যরাত (Pacific) পর্যন্ত অপেক্ষা করুন।";
    } else if (sawRateLimit && !sawAuthError) {
      finalUserError = "⚠️ বর্তমান API কী-গুলোর per-minute রেট লিমিট পূর্ণ হয়েছে। অনুগ্রহ করে ৩০-৬০ সেকেন্ড অপেক্ষা করুন অথবা 🔑 মেনুতে বিকল্প কী যুক্ত করুন।";
    } else if (sawProviderOverload && !sawAuthError) {
      finalUserError = "⚠️ এআই মডেল প্রোভাইডার সাময়িকভাবে অতিরিক্ত ব্যস্ত (503 High Demand / Provider Error)। অনুগ্রহ করে কয়েক সেকেন্ড পর আবার চেষ্টা করুন।";
    } else if (sawAuthError) {
      finalUserError = "⚠️ আপনার যুক্ত করা সিক্রেট কীগুলোতে অনুমোদন সমস্যা রয়েছে (401 Unauthorized / Invalid Key)। অনুগ্রহ করে 🔑 মেনু থেকে কীগুলোর স্থিতি চেক করুন।";
      finalIsAuthError = true;
    } else if (sawNetworkError) {
      finalUserError = "⚠️ নেটওয়ার্ক সমস্যায় মডেল সাড়া দেয়নি — সব কী ও মডেল ঘুরিয়ে চেষ্টা করা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।";
    } else if (lastFailureMessage) {
      finalUserError = `⚠️ রিকোয়েস্ট সম্পন্ন করা যায়নি: ${lastFailureMessage.slice(0, 180)}`;
    }

    addSystemLog({
      level: 'error',
      category: finalIsAuthError ? 'auth' : sawRateLimit ? 'rate_limit' : 'execution',
      message: finalUserError
    });
    sendEvent({
      type: "error",
      error: finalUserError,
      isAuthError: finalIsAuthError
    });
  }

  // STEP 13 (P1): store a successful build in the response cache so an
  // exact repeat serves from cache with zero model calls. Only when this
  // turn actually (re)wrote the session preview file (mtime guard above)
  // and the HTML is within the size bound — a rebuild-anyway turn also
  // stores, refreshing the entry with the fresh build.
  if (succeeded && isBuildTurn && finalAssistantText && buildCacheKeyValue) {
    try {
      const absPreview = path.resolve(process.cwd(), sessionPreviewTarget);
      const st = await fs.stat(absPreview);
      const rewrotePreview = previewMtimeBefore === null || st.mtimeMs > previewMtimeBefore;
      if (rewrotePreview && st.size > 40 && st.size <= BUILD_CACHE_MAX_HTML_BYTES) {
        const html = await fs.readFile(absPreview, 'utf-8');
        await setBuildCacheEntry({
          key: buildCacheKeyValue,
          prompt: normalizeBuildPrompt(initialLastMessage),
          model: cacheModelKey,
          task: 'coding',
          builtByModel: lastUsedModel || undefined,
          reply: finalAssistantText,
          html,
          previewUrl: `/${sessionPreviewTarget}`,
          createdAt: Date.now(),
          lastServedAt: Date.now(),
          hits: 0,
        });
      }
    } catch { /* preview unreadable — skip caching this turn */ }
  }

  // Save the turn to server chat history + record usage for the UI.
  if (finalAssistantText) {
    await saveChatTurn(sessionId || 'default', initialLastMessage, finalAssistantText).catch(() => {});
  }
  const totals = usageTotals(usageLedger);
  recordTurnUsage(sessionId || 'default', totals);
  sendEvent({ type: 'usage_summary', usage: totals });

  res.end();
}
