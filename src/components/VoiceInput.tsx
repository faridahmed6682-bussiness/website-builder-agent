// Voice input (Bengali-first): push-to-talk in the PWA.
// Speech-to-text via the browser's built-in recognition where available
// (bn-BD), otherwise MediaRecorder -> free Groq Whisper (/api/voice/transcribe).
// The agent replies in text.
import React, { useState, useRef } from 'react';
import { Mic, Loader2, Square } from 'lucide-react';

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export const VoiceInput: React.FC<VoiceInputProps> = ({ onTranscript, disabled }) => {
  const [state, setState] = useState<'idle' | 'listening' | 'transcribing' | 'error'>('idle');
  const [error, setError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recogRef = useRef<any>(null);

  const stopAll = () => {
    try { recogRef.current?.stop(); } catch {}
    try {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    } catch {}
  };

  const transcribeBlob = async (blob: Blob) => {
    setState('transcribing');
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transcription failed');
      if (data.text) onTranscript(data.text);
      else setError('No speech detected.');
      setState(data.text ? 'idle' : 'error');
    } catch (e: any) {
      setError(e.message);
      setState('error');
    }
  };

  const start = async () => {
    if (state === 'listening' || state === 'transcribing') { stopAll(); setState('idle'); return; }
    setError('');
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      try {
        const recog = new SR();
        recogRef.current = recog;
        recog.lang = 'bn-BD';
        recog.interimResults = false;
        recog.maxAlternatives = 1;
        recog.onresult = (ev: any) => {
          const text = ev.results?.[0]?.[0]?.transcript || '';
          setState('idle');
          if (text) onTranscript(text);
        };
        recog.onerror = () => { setState('error'); setError('Speech recognition failed — try again.'); };
        recog.onend = () => { if (state !== 'idle') setState((s) => (s === 'listening' ? 'idle' : s)); };
        recog.start();
        setState('listening');
        return;
      } catch { /* fall through to recorder */ }
    }
    // Fallback: record audio, send to Groq Whisper.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size) transcribeBlob(blob);
        else setState('idle');
      };
      recorder.start();
      setState('listening');
    } catch (e: any) {
      setError('Microphone unavailable: ' + (e.message || 'permission denied'));
      setState('error');
    }
  };

  return (
    <button
      onClick={start}
      disabled={disabled}
      title={state === 'listening' ? 'Tap to stop recording' : 'Voice input (Bengali) — tap and speak'}
      className={`p-2.5 rounded-xl transition-all flex items-center justify-center min-w-[44px] ${
        state === 'listening' ? 'bg-rose-600 hover:bg-rose-500' : 'bg-slate-800 hover:bg-slate-700'
      } disabled:opacity-50`}
    >
      {state === 'transcribing' ? (
        <Loader2 className="w-5 h-5 text-white animate-spin" />
      ) : state === 'listening' ? (
        <Square className="w-5 h-5 text-white" />
      ) : (
        <Mic className="w-5 h-5 text-white" />
      )}
      {error && <span className="sr-only">{error}</span>}
    </button>
  );
};
