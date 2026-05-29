import { useCallback, useEffect, useRef, useState } from 'react';
import { loadVoices } from '../lib/voice-registry';

export { setSelectedVoiceName } from '../lib/voice-registry';
export {
  cancelSpeech,
  isSpeechActive,
  setSpeechFilterMode,
  speak,
  speakConversational,
  enqueueConversational,
  markTurnComplete,
  warmupTTS,
} from '../lib/speech-session';
export type { SpeakHandle, EnqueueOptions } from '../lib/speech-session';

type SR = any;

declare global {
  interface Window {
    webkitSpeechRecognition?: { new (): SR };
    SpeechRecognition?: { new (): SR };
  }
}

interface ContinuousOptions {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  enabled: boolean;
}

// Retained as a fallback path when whisper-cli isn't bundled. The dual-agent
// voice flow uses useVoiceCapture instead; this hook is only the safety net.
export function useContinuousSpeech({ onFinal, onInterim, enabled }: ContinuousOptions) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);
  const enabledRef = useRef(enabled);
  const finalRef = useRef(onFinal);
  const interimRef = useRef(onInterim);
  const restartTimer = useRef<number | null>(null);
  const stopAfterCycleRef = useRef(false);
  const idleTimer = useRef<number | null>(null);
  // B14: backoff + maxRetries to prevent retry storms on permanent failures.
  const consecutiveErrorsRef = useRef(0);
  const MAX_RETRIES = 5;

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { finalRef.current = onFinal; }, [onFinal]);
  useEffect(() => { interimRef.current = onInterim; }, [onInterim]);

  useEffect(() => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!Ctor);
  }, []);

  const markListening = useCallback((value: boolean) => {
    if (value) {
      if (idleTimer.current != null) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      setListening(true);
    } else {
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        idleTimer.current = null;
        setListening(false);
      }, 1500);
    }
  }, []);

  const stopRec = useCallback(() => {
    stopAfterCycleRef.current = true;
    if (restartTimer.current != null) {
      window.clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
    try { recRef.current?.stop(); } catch { /* ignore */ }
    recRef.current = null;
    if (idleTimer.current != null) {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    setListening(false);
  }, []);

  const startRec = useCallback(() => {
    if (!enabledRef.current) return;
    if (recRef.current) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec: SR = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = (r[0]?.transcript ?? '').trim();
        if (!text) continue;
        if (r.isFinal) finalRef.current(text);
        else interimRef.current?.(text);
      }
    };
    rec.onstart = () => {
      stopAfterCycleRef.current = false;
      consecutiveErrorsRef.current = 0; // B14: reset on success
      setError(null);
      markListening(true);
    };
    rec.onend = () => {
      recRef.current = null;
      if (enabledRef.current && !stopAfterCycleRef.current) {
        restartTimer.current = window.setTimeout(() => startRec(), 250);
      } else {
        markListening(false);
      }
    };
    rec.onerror = (ev: any) => {
      const err = String(ev?.error ?? '');
      recRef.current = null;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        // B14/B18: surface permission denial to the user.
        setError('Microphone permission denied');
        markListening(false);
        return;
      }
      // B14: exponential backoff + maxRetries to prevent retry storms.
      consecutiveErrorsRef.current += 1;
      if (consecutiveErrorsRef.current > MAX_RETRIES) {
        setError(`Speech recognition failed after ${MAX_RETRIES} retries: ${err}`);
        markListening(false);
        return;
      }
      if (enabledRef.current) {
        const delay = Math.min(700 * Math.pow(2, consecutiveErrorsRef.current - 1), 10000);
        restartTimer.current = window.setTimeout(() => startRec(), delay);
      } else {
        markListening(false);
      }
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      recRef.current = null;
    }
  }, [markListening]);

  useEffect(() => {
    if (enabled) startRec();
    else stopRec();
    return () => stopRec();
  }, [enabled, startRec, stopRec]);

  return { listening, supported, error };
}

// ---------------------------------------------------------------------------
// useVoices — reactively exposes the synthesis voice list to React.
//
// macOS's voiceschanged event fires when the user installs/removes voices
// at runtime (e.g. they followed our guide and downloaded Voice 4). Using
// this hook in the App means the guide modal closes itself and the picker
// dropdown updates without a relaunch.
// ---------------------------------------------------------------------------

export function useVoices(): { voices: SpeechSynthesisVoice[]; ready: boolean } {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!('speechSynthesis' in window)) {
      setReady(true);
      return;
    }
    const synth = window.speechSynthesis;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const list = synth.getVoices();
      setVoices(list);
      if (list.length > 0 && !ready) setReady(true);
    };
    // Kick the lazy loader and resolve via the module-level loadVoices().
    void loadVoices().then(refresh, refresh);
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    return () => {
      cancelled = true;
      synth.removeEventListener('voiceschanged', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { voices, ready };
}
