import React, { useState, useEffect } from 'react';
import { X, Flame, Shield, CheckCircle, AlertCircle, Loader2, Save, Send } from 'lucide-react';

interface FirebaseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FirebaseModal: React.FC<FirebaseModalProps> = ({ isOpen, onClose }) => {
  const [projectId, setProjectId] = useState('');
  const [rules, setRules] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/firebase/status')
        .then(res => res.json())
        .then(data => {
          if (data.projectId) setProjectId(data.projectId);
        })
        .catch(() => {});

      fetch('/api/firebase/rules')
        .then(res => res.json())
        .then(data => {
          if (data.rules) setRules(data.rules);
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSaveRules = async () => {
    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const res = await fetch('/api/firebase/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage('Firestore security rules updated successfully.');
      } else {
        setIsError(true);
        setStatusMessage(data.error || 'Failed to update rules');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSetup = async () => {
    if (!projectId.trim()) {
      setIsError(true);
      setStatusMessage('Please enter a Firebase Project ID');
      return;
    }
    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const res = await fetch('/api/firebase/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectId.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage(`Firebase initialized for project: ${projectId}`);
      } else {
        setIsError(true);
        setStatusMessage(data.error || 'Failed to initialize Firebase');
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
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
              <Flame className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Firebase & Firestore Integration</h3>
              <p className="text-[11px] text-slate-400">Database persistence, auth rules, and configuration</p>
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
          <div className="space-y-2">
            <label className="text-slate-300 font-medium block">Firebase Project ID:</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="my-firebase-project"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
              />
              <button
                onClick={handleSetup}
                disabled={isLoading || !projectId}
                className="px-3.5 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5"
              >
                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Connect</span>}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-slate-300 font-medium flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-amber-400" />
                <span>firestore.rules:</span>
              </label>
              <button
                onClick={handleSaveRules}
                disabled={isLoading}
                className="text-amber-400 hover:text-amber-300 flex items-center gap-1 text-[11px] font-semibold"
              >
                <Save className="w-3 h-3" />
                <span>Deploy Rules</span>
              </button>
            </div>
            <textarea
              rows={8}
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              placeholder="rules_version = '2'; service cloud.firestore { ... }"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-[11px] focus:outline-none focus:border-amber-500 resize-none leading-relaxed"
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

          <div className="pt-2 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
