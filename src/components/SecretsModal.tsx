import React, { useState, useEffect } from 'react';
import {
  X,
  Key,
  Plus,
  Trash2,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Cpu,
  Sparkles,
  ShieldCheck
} from 'lucide-react';
import { ApiProviderId, KeyConfig } from '../types/secrets';
import {
  PROVIDER_CATALOG,
  ModelPreset,
  getProviderPreset,
  getLocalKeys,
  addLocalKey,
  updateLocalKey,
  removeLocalKey,
  toggleKeyActive,
  getPreferOnlyCustomKeys,
  setPreferOnlyCustomKeys,
  getLastSuccessfulKeyId,
  setLastSuccessfulKeyId
} from '../lib/secretsManager';

interface SecretsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onKeysUpdated?: () => void;
}

export const SecretsModal: React.FC<SecretsModalProps> = ({ isOpen, onClose, onKeysUpdated }) => {
  const [keys, setKeys] = useState<KeyConfig[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newProvider, setNewProvider] = useState<ApiProviderId>('gemini');
  const [newModel, setNewModel] = useState('gemini-3.8-flash');
  const [useCustomModelInput, setUseCustomModelInput] = useState(false);
  const [customModelId, setCustomModelId] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('https://models.inference.ai.azure.com');
  const [liveModelsByProvider, setLiveModelsByProvider] = useState<Record<string, ModelPreset[]>>({});
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isTesting, setIsTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [preferOnlyFreeKeys, setPreferOnlyFreeKeys] = useState(false);
  const [stickyKeyId, setStickyKeyId] = useState<string | null>(null);
  const [poolRuntimeMap, setPoolRuntimeMap] = useState<Record<string, { status: string; cooldownRemainingSec: number; requestsThisMinute: number; rpmLimit: number; isPinned?: boolean; limitKind?: string | null; limitLabel?: string | null; dailyResetAt?: number | null; retryInSec?: number }>>({});
  // Server-side env key pool (FreeLLMAPI + GEMINI_API_KEYS): names + live
  // status only — key VALUES are never sent to the client or shown here.
  const [poolList, setPoolList] = useState<Array<{ id: string; provider: string; name: string; model: string; status: string; limitKind?: string | null; limitLabel?: string | null; cooldownRemainingSec: number }>>([]);

  // ---- Bulk key entry: paste many keys at once, one per line -------------
  // Provider is auto-detected from the key prefix; unrecognized lines are
  // reported and never stored. Keys are saved through the SAME local path as
  // the single-key form (addLocalKey) — this panel's pool is local browser
  // storage (synced to the server by saveLocalKeys), NOT the server router
  // pool. Each bulk key gets its own provider's default model (the first
  // model of that provider's preset — the same model a provider switch
  // would pick): the server passes a key's model through verbatim, so a
  // cross-provider model (e.g. a Groq key saved with a Gemini model) would
  // fail. Key VALUES are never shown back — results show only provider + a
  // 4-char hint.
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  type BulkResult = { provider: string; hint: string; status: 'added' | 'exists' | 'failed' | 'unrecognized'; message?: string };
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);

  const detectProvider = (line: string): 'gemini' | 'groq' | 'openrouter' | null => {
    if (line.startsWith('AIza') || line.startsWith('AQ.')) return 'gemini';
    if (line.startsWith('gsk_')) return 'groq';
    if (line.startsWith('sk-or-v1-')) return 'openrouter';
    return null;
  };

  const handleAddBulkKeys = () => {
    const lines = bulkText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setBulkBusy(true);
    setBulkResults([]);
    // addLocalKey() does NOT dedupe — check against the existing local pool
    // (plus keys added earlier in this same run) before saving.
    const seen = new Set(getLocalKeys().map((k) => k.apiKey));
    const results: BulkResult[] = [];
    for (const line of lines) {
      const provider = detectProvider(line);
      const hint = `${line.slice(0, 4)}…`;
      if (!provider) {
        results.push({ provider: 'অচেনা', hint, status: 'unrecognized', message: 'প্রোভাইডার চেনা যায়নি — AIza / AQ. / gsk_ / sk-or-v1- দিয়ে শুরু হতে হবে।' });
        continue;
      }
      if (seen.has(line)) {
        results.push({ provider, hint, status: 'exists', message: 'এই key আগেই পুলে আছে।' });
        continue;
      }
      try {
        const model = getProviderPreset(provider).models[0]?.id || 'gemini-3.8-flash';
        addLocalKey({
          name: `${provider.toUpperCase()} (${model.split('/').pop()})`,
          apiKey: line,
          provider,
          model,
          isActive: true,
          rpmLimit: provider === 'gemini' || provider === 'groq' ? 15 : 20,
        });
        seen.add(line);
        results.push({ provider, hint, status: 'added' });
      } catch (e: any) {
        results.push({ provider, hint, status: 'failed', message: e?.message || 'যোগ করা যায়নি' });
      }
    }
    setBulkResults(results);
    setBulkText('');
    setBulkBusy(false);
    loadKeys();
    onKeysUpdated?.();
  };

  const loadKeys = () => {
    const local = getLocalKeys();
    setKeys(local);
    setPreferOnlyFreeKeys(getPreferOnlyCustomKeys());
    setStickyKeyId(getLastSuccessfulKeyId());
    fetch('/api/secrets/pool-status')
      .then(r => r.json())
      .then(data => {
        if (data?.lastSuccessfulKeyId) {
          setStickyKeyId(data.lastSuccessfulKeyId);
          setLastSuccessfulKeyId(data.lastSuccessfulKeyId);
        }
        if (Array.isArray(data?.pool)) {
          const map: Record<string, any> = {};
          for (const item of data.pool) {
            map[item.id] = item;
          }
          setPoolRuntimeMap(map);
          setPoolList(data.pool);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (isOpen) {
      loadKeys();
      setTestResult(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const activePreset = getProviderPreset(newProvider);
  const availableModels: ModelPreset[] = liveModelsByProvider[newProvider] || activePreset.models;

  const handleProviderChange = (prov: ApiProviderId) => {
    setNewProvider(prov);
    const preset = getProviderPreset(prov);
    const list = liveModelsByProvider[prov] || preset.models;
    setNewModel(list[0]?.id || '');
    setUseCustomModelInput(false);
    setCustomModelId('');
    if (preset.defaultBaseUrl) {
      setNewBaseUrl(preset.defaultBaseUrl);
    }
  };

  const handleFetchLiveModels = async (prov: ApiProviderId = newProvider, keyForAuth?: string, baseUrlForAuth?: string) => {
    setIsFetchingModels(true);
    try {
      const res = await fetch('/api/secrets/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: prov,
          apiKey: keyForAuth || newApiKey.trim() || undefined,
          baseUrl: baseUrlForAuth || (prov === 'custom' || prov === 'freellmapi' ? newBaseUrl.trim() : undefined),
        }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.models) && data.models.length > 0) {
        setLiveModelsByProvider(prev => ({ ...prev, [prov]: data.models }));
        if (!useCustomModelInput && prov === newProvider) {
          setNewModel(data.models[0].id);
        }
      }
    } catch {
      // Keep curated preset list if fetch fails
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleAddKey = () => {
    if (!newApiKey.trim()) return;
    const chosenModel = useCustomModelInput ? customModelId.trim() : newModel;
    if (!chosenModel) return;

    addLocalKey({
      name: newKeyName.trim() || `${newProvider.toUpperCase()} (${chosenModel.split('/').pop()})`,
      apiKey: newApiKey.trim(),
      provider: newProvider,
      model: chosenModel,
      baseUrl: newProvider === 'custom' || newProvider === 'freellmapi' ? newBaseUrl.trim() : undefined,
      isActive: true,
      rpmLimit: newProvider === 'gemini' || newProvider === 'groq' ? 15 : 20,
    });
    setNewKeyName('');
    setNewApiKey('');
    setCustomModelId('');
    setUseCustomModelInput(false);
    loadKeys();
    onKeysUpdated?.();
  };

  const handleUpdateKeyModel = (id: string, model: string) => {
    updateLocalKey(id, { model });
    loadKeys();
    onKeysUpdated?.();
  };

  const handleDeleteKey = (id: string) => {
    removeLocalKey(id);
    loadKeys();
    onKeysUpdated?.();
  };

  const handleToggleKey = (id: string) => {
    toggleKeyActive(id);
    loadKeys();
    onKeysUpdated?.();
  };

  const handleTogglePreferOnlyFree = () => {
    const next = !preferOnlyFreeKeys;
    setPreferOnlyCustomKeys(next);
    setPreferOnlyFreeKeys(next);
  };

  const handleTestDraftKey = async () => {
    if (!newApiKey.trim() || isTesting) return;
    const chosenModel = (useCustomModelInput ? customModelId.trim() : newModel) || availableModels[0]?.id;
    setIsTesting('__draft__');
    setTestResult(null);
    try {
      const res = await fetch('/api/secrets/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: newProvider,
          apiKey: newApiKey.trim(),
          model: chosenModel,
          baseUrl: newProvider === 'custom' || newProvider === 'freellmapi' ? newBaseUrl.trim() : undefined,
        }),
      });
      const data = await res.json();
      const ok = Boolean(res.ok && (data.success || data.valid));
      setTestResult({
        id: '__draft__',
        success: ok,
        message: ok
          ? (data.message || `Valid (${chosenModel})!`)
          : (data.message || data.error || 'Failed to authenticate key'),
      });
    } catch (err: any) {
      setTestResult({ id: '__draft__', success: false, message: err.message });
    } finally {
      setIsTesting(null);
    }
  };

  const handleTestKey = async (k: KeyConfig) => {
    setIsTesting(k.id);
    setTestResult(null);
    try {
      const res = await fetch('/api/secrets/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: k.provider,
          apiKey: k.apiKey,
          model: k.model,
          baseUrl: k.baseUrl,
        }),
      });
      const data = await res.json();
      const ok = Boolean(res.ok && (data.success || data.valid));
      setTestResult({
        id: k.id,
        success: ok,
        message: ok
          ? (data.message || `Valid (${k.model})!`)
          : (data.message || data.error || 'Failed to authenticate key'),
      });
    } catch (err: any) {
      setTestResult({ id: k.id, success: false, message: err.message });
    } finally {
      setIsTesting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-2xl bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/30 flex items-center justify-center">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Free API Keys & Model Selection Pool</h3>
              <p className="text-[11px] text-slate-400">
                Gemini Free, OpenRouter (:free), Groq, Cerebras, Mistral বা Custom Free API যুক্ত করে মডেল বেছে নিন
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          {/* Add Key + Model Selection Form */}
          <div className="p-4 bg-slate-900/90 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-white text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-indigo-400" />
                <span>নতুন ফ্রি API কী ও মডেল যুক্ত করুন</span>
              </h4>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                Auto-Rotation Enabled
              </span>
            </div>

            {/* Provider & Label */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10px] text-slate-400 mb-1 block">Free API Provider:</label>
                <select
                  value={newProvider}
                  onChange={(e) => handleProviderChange(e.target.value as ApiProviderId)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                >
                  {PROVIDER_CATALOG.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 mb-1 block">Key Label (ঐচ্ছিক):</label>
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder={`e.g. My ${newProvider.toUpperCase()} Free Key`}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="text-[11px] text-indigo-300/90 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 flex-shrink-0 text-indigo-400" />
              <span>{activePreset.freeTierNote}</span>
            </div>

            {/* Model Selection */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-slate-400 flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-sky-400" />
                  <span>Select Free Model for this Key:</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleFetchLiveModels(newProvider)}
                    disabled={isFetchingModels}
                    className="text-[10px] text-sky-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer"
                    title="Fetch live models from provider API"
                  >
                    <RefreshCw className={`w-3 h-3 ${isFetchingModels ? 'animate-spin' : ''}`} />
                    <span>{isFetchingModels ? 'Fetching...' : 'Refresh Live Models'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseCustomModelInput(!useCustomModelInput)}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                  >
                    {useCustomModelInput ? 'Preset List' : 'Custom Model ID'}
                  </button>
                </div>
              </div>

              {useCustomModelInput ? (
                <input
                  type="text"
                  value={customModelId}
                  onChange={(e) => setCustomModelId(e.target.value)}
                  placeholder="Enter exact model slug (e.g. qwen/qwen3-coder:free)"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
              ) : (
                <select
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                >
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — [{m.badge}] ({m.id})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Base URL for custom provider */}
            {(newProvider === 'custom' || newProvider === 'freellmapi') && (
              <div>
                <label className="text-[10px] text-slate-400 mb-1 block">OpenAI-Compatible Base URL:</label>
                <input
                  type="text"
                  value={newBaseUrl}
                  onChange={(e) => setNewBaseUrl(e.target.value)}
                  placeholder="https://models.inference.ai.azure.com"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}

            {/* API Key Input */}
            <div>
              <label className="text-[10px] text-slate-400 mb-1 block">API Key:</label>
              <input
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder={activePreset.keyPlaceholder}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
              />
            </div>

            {testResult?.id === '__draft__' && (
              <div
                className={`p-2 rounded-lg border text-[11px] flex items-center gap-1.5 ${
                  testResult.success
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                {testResult.success ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                <span className="break-all">{testResult.message}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleTestDraftKey}
                disabled={!newApiKey.trim() || isTesting === '__draft__'}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-lg font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                {isTesting === '__draft__' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />}
                <span>Test Key & Model</span>
              </button>
              <button
                type="button"
                onClick={handleAddKey}
                disabled={!newApiKey.trim() || (useCustomModelInput && !customModelId.trim())}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Save Key to Pool</span>
              </button>
            </div>
          </div>

          {/* Bulk entry — paste all keys at once, one per line */}
          <div className="p-4 bg-slate-900/90 border border-slate-800 rounded-xl space-y-2">
            <p className="font-bold text-white text-[11px] uppercase tracking-wider flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5 text-indigo-400" />
              <span>একসাথে অনেক key বসান (বাল্ক)</span>
            </p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              সব key একসাথে পেস্ট করুন — এক লাইনে একটা key। Gemini (AIza… / AQ.…), Groq (gsk_…) ও OpenRouter (sk-or-v1-…) নিজে থেকেই চেনা হবে। প্রতিটা key-তে তার প্রোভাইডারের ডিফল্ট ফ্রি মডেল বসবে। Key-র মান কোথাও দেখানো হয় না।
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'AIza… / AQ.…\ngsk_…\nsk-or-v1-…'}
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white placeholder:text-slate-500 focus:outline-none font-mono text-xs resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddBulkKeys}
                disabled={!bulkText.trim() || bulkBusy}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                {bulkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} সবগুলো যোগ করুন
              </button>
              {bulkResults.length > 0 && (
                <span className="text-[11px] text-slate-400">
                  {bulkResults.filter((r) => r.status === 'added').length}টি যুক্ত হয়েছে · {bulkResults.filter((r) => r.status === 'exists').length}টি আগে থেকেই ছিল
                </span>
              )}
            </div>
            {bulkResults.length > 0 && (
              <div className="space-y-1.5">
                {bulkResults.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${r.status === 'added' ? 'bg-emerald-400' : r.status === 'exists' ? 'bg-amber-400' : 'bg-rose-400'}`} />
                    <span className="text-white font-medium">{r.provider}</span>
                    <span className="text-slate-500 font-mono">{r.hint}</span>
                    <span className={r.status === 'added' ? 'text-emerald-300' : r.status === 'exists' ? 'text-amber-300' : 'text-rose-300'}>
                      {r.status === 'added' ? 'যুক্ত হয়েছে' : r.status === 'exists' ? 'আগে থেকেই আছে' : r.status === 'unrecognized' ? 'চেনা যায়নি' : 'ব্যর্থ'}
                    </span>
                    {r.message && <span className="text-slate-400 truncate">{r.message}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Server key pool (env vars) — names + live status only, never values.
              GEMINI_API_KEYS: one key per Google Cloud project; quotas are per
              project, so keys from different projects each carry their own
              Hydrogen quota. Limits shown here are OBSERVED (from 429s), never
              assumed numbers. */}
          {poolList.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-bold text-slate-300 text-[11px] uppercase tracking-wider">
                  Server pool (env) — {poolList.filter(p => p.status === 'healthy').length} live / {poolList.length} keys
                </h4>
                <span className="text-[10px] text-slate-500">values never shown • limits observed, not assumed</span>
              </div>
              <div className="space-y-1.5">
                {poolList.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-900/60 border border-slate-800 rounded-lg">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${p.status === 'healthy' ? 'bg-emerald-400' : p.limitKind === 'rpd' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                      <span className="text-xs font-semibold text-slate-200 truncate">{p.name}</span>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">{p.provider}</span>
                      <span className="text-[10px] font-mono text-slate-500 truncate">{p.model}</span>
                    </div>
                    {p.limitLabel ? (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono border shrink-0 ${p.limitKind === 'rpd' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
                        {p.limitLabel}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">live</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Key Pool List */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-bold text-slate-300 text-[11px] uppercase tracking-wider">
                Active Free Keys Pool ({keys.filter(k => k.isActive).length}/{keys.length})
              </h4>

              <button
                type="button"
                onClick={handleTogglePreferOnlyFree}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border flex items-center gap-1.5 cursor-pointer transition-colors ${
                  preferOnlyFreeKeys
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title="When enabled, Nexus strictly runs only using your added API keys and never falls back to built-in server quota."
              >
                {preferOnlyFreeKeys ? <ToggleRight className="w-4 h-4 text-emerald-400" /> : <ToggleLeft className="w-4 h-4" />}
                <span>শুধুমাত্র আমার যুক্ত করা Free API Keys ব্যবহার করো</span>
              </button>
            </div>

            {keys.length === 0 ? (
              <div className="p-4 bg-slate-900/40 border border-dashed border-slate-800 rounded-xl text-center text-slate-500 text-xs">
                এখনো কোনো কাস্টম কী যুক্ত করা হয়নি। উপরে আপনার ফ্রি Gemini / OpenRouter / Groq কী ও মডেল যুক্ত করুন।
              </div>
            ) : (
              keys.map((k) => {
                const presetModels = liveModelsByProvider[k.provider] || getProviderPreset(k.provider).models;
                const hasModelInPreset = presetModels.some(m => m.id === k.model);
                const runtime = poolRuntimeMap[k.id];
                const isPinned = k.id === stickyKeyId || Boolean(runtime?.isPinned);
                const rpmUsed = runtime?.requestsThisMinute ?? 0;
                const rpmCap = runtime?.rpmLimit ?? k.rpmLimit ?? 15;
                const cooldownLeft = runtime?.cooldownRemainingSec ?? 0;
                return (
                  <div
                    key={k.id}
                    className={`p-3 bg-slate-900 rounded-xl space-y-2 border ${
                      isPinned ? 'border-emerald-500/40' : 'border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 flex-1 overflow-hidden">
                        <button
                          onClick={() => handleToggleKey(k.id)}
                          className="text-slate-400 hover:text-white cursor-pointer"
                          title={k.isActive ? 'Deactivate' : 'Activate'}
                        >
                          {k.isActive ? (
                            <ToggleRight className="w-5 h-5 text-emerald-400" />
                          ) : (
                            <ToggleLeft className="w-5 h-5 text-slate-600" />
                          )}
                        </button>
                        <div className="overflow-hidden">
                          <div className="font-bold text-slate-200 truncate flex flex-wrap items-center gap-1.5">
                            <span>{k.name}</span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">
                              {k.provider}
                            </span>
                            {isPinned && k.isActive && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                ★ সচল কী (Pinned)
                              </span>
                            )}
                            {runtime?.limitLabel ? (
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${runtime.limitKind === 'rpd' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
                                {runtime.limitLabel}
                              </span>
                            ) : cooldownLeft > 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                Cooldown {cooldownLeft}s
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-slate-800 text-slate-400 border border-slate-700/70">
                                {rpmUsed}/{rpmCap} RPM
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-slate-500 truncate">
                            {k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}••••${k.apiKey.slice(-4)}` : '••••••••'}
                            {k.baseUrl ? ` • ${k.baseUrl}` : ''}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTestKey(k)}
                          disabled={isTesting === k.id}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[10px] font-semibold cursor-pointer"
                        >
                          {isTesting === k.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Test'}
                        </button>

                        <button
                          onClick={() => handleDeleteKey(k.id)}
                          className="p-1 text-slate-500 hover:text-rose-400 rounded-lg cursor-pointer"
                          title="Delete key"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Inline Model Switcher for each saved key */}
                    <div className="flex flex-wrap items-center gap-2 pl-7">
                      <span className="text-[10px] text-slate-400">Model:</span>
                      <select
                        value={hasModelInPreset ? k.model : '__custom__'}
                        onChange={(e) => {
                          if (e.target.value !== '__custom__') {
                            handleUpdateKeyModel(k.id, e.target.value);
                          }
                        }}
                        className="flex-1 min-w-[200px] bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] font-mono text-sky-300 focus:outline-none focus:border-indigo-500"
                      >
                        {presetModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} ({m.id})
                          </option>
                        ))}
                        {!hasModelInPreset && (
                          <option value="__custom__">Custom: {k.model}</option>
                        )}
                      </select>

                      {testResult?.id === k.id && (
                        <span className={`text-[10px] flex items-center gap-1 ${
                          testResult.success ? 'text-emerald-400' : 'text-rose-400'
                        }`}>
                          {testResult.success ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                          <span className="truncate max-w-[220px]" title={testResult.message}>{testResult.message}</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex justify-between items-center text-[11px] text-slate-400">
          <span>টিপস: চ্যাটে মডেল &quot;Default&quot; রাখলে প্রতিটি API কী তার নিজস্ব সিলেক্ট করা ফ্রি মডেল ব্যবহার করবে।</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-medium cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
