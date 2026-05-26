import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareForSpeech, type Locale, type SpeechFilterMode } from '../lib/speech-format';

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
  const recRef = useRef<SR | null>(null);
  const enabledRef = useRef(enabled);
  const finalRef = useRef(onFinal);
  const interimRef = useRef(onInterim);
  const restartTimer = useRef<number | null>(null);
  const stopAfterCycleRef = useRef(false);
  const idleTimer = useRef<number | null>(null);

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
        markListening(false);
        return;
      }
      if (enabledRef.current) {
        restartTimer.current = window.setTimeout(() => startRec(), 700);
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

  return { listening, supported };
}

// ---------------------------------------------------------------------------
// TTS: per-sentence voice picking, conversational text shaping
// ---------------------------------------------------------------------------

// Only cache REAL voices. Null was the bug — once cached, the first utterance
// would speak with no voice bound (silent on macOS Electron) even after
// onvoiceschanged fired with the real voice list.
const voiceCache: Map<Locale, SpeechSynthesisVoice> = new Map();

// On macOS Electron, getVoices() often returns [] on the very first call and
// only populates after the speechSynthesis engine has warmed up. We expose a
// promise that resolves with a non-empty voice list (or [] after a hard
// timeout) so speakConversational can wait before binding utterances.
let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve([]); return; }
    const synth = window.speechSynthesis;
    const settled = { done: false };
    const finish = (voices: SpeechSynthesisVoice[]) => {
      if (settled.done) return;
      settled.done = true;
      resolve(voices);
    };
    const tryNow = () => {
      const v = synth.getVoices();
      if (v.length > 0) {
        finish(v);
        return true;
      }
      return false;
    };
    if (tryNow()) return;
    const onChanged = () => {
      if (tryNow()) synth.removeEventListener('voiceschanged', onChanged);
    };
    synth.addEventListener('voiceschanged', onChanged);
    // Hard timeout — some platforms never fire voiceschanged. Resolve with
    // whatever we have so speech still attempts to play.
    window.setTimeout(() => finish(synth.getVoices()), 1500);
  });
  return voicesReady;
}

// Kick voice loading at module import — gives the engine a head start so by
// the time the first assistant reply arrives, voices are usually ready.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  // Touching getVoices() is the standard trick to trigger lazy population.
  window.speechSynthesis.getVoices();
  void loadVoices();
  // Re-probe on engine refresh (e.g. system voices installed at runtime).
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    voiceCache.clear();
  });
}

function rankVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  let score = 0;
  if (name.includes('siri')) score += 200;
  if (name.includes('premium')) score += 120;
  if (name.includes('enhanced')) score += 90;
  if (name.includes('neural')) score += 70;
  if (name.includes('samantha')) score += 50;
  if (name.includes('karen')) score += 45;
  if (name.includes('tingting') || name.includes('ting-ting')) score += 60;
  if (name.includes('lili')) score += 55;
  if (name.includes('mei-jia') || name.includes('meijia')) score += 50;
  if (v.localService) score += 8;
  if (name.includes('compact')) score -= 30;
  if (name.includes('eloquence')) score -= 50;
  if (name.includes('novelty')) score -= 80;
  return score;
}

// User's explicit pick from the settings panel. When set and the voice is
// still available, it overrides the rankVoice picker for the matching
// locale (Chinese → user's pick; English still uses ranking). Mutated by
// setSelectedVoiceName() so App.tsx can wire it up without prop drilling
// through the free speakConversational function.
let selectedVoiceName: string | null = null;

export function setSelectedVoiceName(name: string | null): void {
  if (selectedVoiceName === name) return;
  selectedVoiceName = name;
  // Drop the locale cache so the next utterance re-picks against the new
  // preference instead of speaking with the old voice.
  voiceCache.clear();
}

// Same module-level escape hatch for the noise-filter mode — App.tsx pushes
// the persisted value in on mount and on every toggle. Default 'strict'
// because the worker's English thinking + tool noise is what kicked off
// this whole feature; users who want raw output can flip it to 'off'.
let speechFilterMode: SpeechFilterMode = 'strict';

export function setSpeechFilterMode(mode: SpeechFilterMode): void {
  speechFilterMode = mode;
}

function pickVoiceForLocale(locale: Locale): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null;
  const all = window.speechSynthesis.getVoices();
  if (all.length === 0) return null;
  // Mandarin only — explicitly exclude Cantonese voices (yue, zh-HK, zh-yue,
  // e.g. macOS "Sin-ji"), otherwise the bare 'zh' prefix below would let them
  // through and rankVoice() doesn't penalise them.
  const wanted = locale === 'zh' ? ['zh', 'cmn'] : ['en'];
  const isCantonese = (lang: string) =>
    lang.startsWith('yue') || lang.includes('-hk') || lang.includes('-yue');
  const matches = all.filter((v) => {
    const lang = v.lang?.toLowerCase() ?? '';
    if (locale === 'zh' && isCantonese(lang)) return false;
    return wanted.some((p) => lang.startsWith(p));
  });
  // User-selected voice only overrides for Chinese — the selector only lists
  // Mandarin voices, so applying it to English would silently break English
  // utterances.
  if (locale === 'zh' && selectedVoiceName) {
    const pick = matches.find((v) => v.name === selectedVoiceName);
    if (pick) return pick;
    // Selected voice no longer installed — fall through to ranking rather
    // than returning null (which would force the browser default).
  }
  const pool = matches.length > 0 ? matches : all;
  return pool
    .map((v) => ({ v, score: rankVoice(v) }))
    .sort((a, b) => b.score - a.score)[0]?.v ?? null;
}

function ensureVoice(locale: Locale): SpeechSynthesisVoice | null {
  const cached = voiceCache.get(locale);
  if (cached) return cached;
  const v = pickVoiceForLocale(locale);
  if (v) voiceCache.set(locale, v);
  return v;
}

// Track the active queue so cancelSpeech() really does stop everything,
// including any sentences that haven't started yet.
interface SpeakSession {
  cancelled: boolean;
  current: SpeechSynthesisUtterance | null;
  onAllDone?: () => void;
}

let activeSession: SpeakSession | null = null;

export function cancelSpeech() {
  if (!('speechSynthesis' in window)) return;
  if (activeSession) {
    activeSession.cancelled = true;
    activeSession.current = null;
  }
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  activeSession = null;
}

export function speakConversational(raw: string, onDone?: () => void) {
  if (!('speechSynthesis' in window)) { onDone?.(); return; }
  const chunks = prepareForSpeech(raw, speechFilterMode);
  if (chunks.length === 0) { onDone?.(); return; }

  // Cancel any in-flight speech before queuing new chunks.
  cancelSpeech();

  const session: SpeakSession = { cancelled: false, current: null, onAllDone: onDone };
  activeSession = session;

  const start = () => {
    if (session.cancelled) return;
    let i = 0;
    const speakNext = () => {
      if (session.cancelled) return;
      if (i >= chunks.length) {
        if (activeSession === session) activeSession = null;
        session.onAllDone?.();
        return;
      }
      const { text, locale } = chunks[i++];
      const voice = ensureVoice(locale);
      const u = new SpeechSynthesisUtterance(text);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
      }
      u.rate = locale === 'zh' ? 1.05 : 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      u.onend = () => {
        session.current = null;
        window.setTimeout(speakNext, 40);
      };
      u.onerror = () => {
        session.current = null;
        window.setTimeout(speakNext, 40);
      };
      session.current = u;
      try {
        // resume() is a no-op when not paused, but on macOS Electron the
        // queue can wedge in a "paused" state after cancel(); calling it
        // before speak() unblocks the first utterance.
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(u);
      } catch {
        window.setTimeout(speakNext, 40);
      }
    };
    speakNext();
  };

  // Wait for voices to load so we don't bind the first utterance to a null
  // voice (which is the documented cause of silent TTS on macOS Electron).
  loadVoices().then(start, start);
}

// Back-compat wrapper: callers using the old robotic `speak` still work,
// just now they get the conversational pipeline.
export function speak(text: string, onDone?: () => void) {
  speakConversational(text, onDone);
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
