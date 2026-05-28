import { prepareForSpeech, type SpeechFilterMode } from './speech-format';
import { ensureVoice, loadVoices } from './voice-registry';

// Per-queue state. The utteranceSeq lets onend/onerror callbacks tell whether
// they belong to the still-active utterance or one that's been superseded by
// cancel() — that's the B20 guard. Without it, a stale onend from a canceled
// utterance can re-enter speakNext and either advance the queue past its end
// (firing onAllDone late) or clobber the in-flight session.
interface SpeakSession {
  cancelled: boolean;
  current: SpeechSynthesisUtterance | null;
  utteranceSeq: number;
  onAllDone?: () => void;
}

type SpeechCallback = () => void;

// All TTS state previously lived as module-level globals (activeSession,
// speechFilterMode). That made cross-instance contamination possible whenever
// a second React tree / window / test harness imported the same module — the
// B10 hazard. Wrapping the state in a class makes the global path explicit
// (the singleton below preserves the existing named-export API for callers)
// while leaving the door open for isolated instances when isolation matters.
export class SpeechController {
  private filterMode: SpeechFilterMode = 'strict';
  private activeSession: SpeakSession | null = null;

  setFilterMode(mode: SpeechFilterMode): void {
    this.filterMode = mode;
  }

  // `silent` — when true, suppress the active session's onAllDone callback.
  // Used by speakConversational's internal supersede path so the OLD session's
  // onDone doesn't race-clear flags the NEW session is about to set.
  // External callers (barge-in, leave, enrollment start) leave silent=false so
  // their onAllDone fires and downstream state (aiSpeaking, mic suppression)
  // can reset — without that fire, cancel left aiSpeaking pinned true forever
  // and every subsequent narration was silently dropped.
  cancel(silent = false): void {
    if (!('speechSynthesis' in window)) return;
    const session = this.activeSession;
    if (session) {
      session.cancelled = true;
      session.current = null;
    }
    try { window.speechSynthesis.cancel(); } catch (err) {
      console.warn('[speech] window.speechSynthesis.cancel threw:', err);
    }
    this.activeSession = null;
    if (session && !silent && session.onAllDone) {
      try { session.onAllDone(); } catch (err) {
        console.warn('[speech] onAllDone (after cancel) threw:', err);
      }
    }
  }

  /** True when an utterance is queued or in flight. Safety-net consumers use
   *  this to detect "speak state thinks AI is talking but the controller is
   *  actually idle" (cancel never fired onAllDone, watchdog missed, etc.). */
  isActive(): boolean {
    return this.activeSession !== null;
  }

  speakConversational(raw: string, onDone?: SpeechCallback): void {
    if (!('speechSynthesis' in window)) { onDone?.(); return; }
    const chunks = prepareForSpeech(raw, this.filterMode);
    if (chunks.length === 0) { onDone?.(); return; }

    // Silent supersede: the previous session's onAllDone must NOT fire here,
    // or it'd reset aiSpeaking=false right before the new session sets it true.
    this.cancel(true);

    const session: SpeakSession = {
      cancelled: false,
      current: null,
      utteranceSeq: 0,
      onAllDone: onDone,
    };
    this.activeSession = session;

    const start = () => {
      if (session.cancelled || this.activeSession !== session) return;
      let i = 0;
      const speakNext = () => {
        if (session.cancelled || this.activeSession !== session) return;
        if (i >= chunks.length) {
          if (this.activeSession === session) this.activeSession = null;
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
        const myId = ++session.utteranceSeq;
        // B30 watchdog: on macOS Electron the speech engine can wedge such
        // that speak(u) is silently dropped — neither onend nor onerror ever
        // fires, freezing the queue forever. That leaves aiSpeaking stuck
        // true, the mic suppressed, and every subsequent narration broken
        // (because cancel() in the supersede path doesn't fire onAllDone
        // either). The watchdog forces advance() if no callback fires within
        // a generous text-length budget. A late real onend/onerror is then a
        // safe no-op thanks to the B20 utteranceSeq guard.
        let watchdog: number | null = null;
        const clearWatchdog = () => {
          if (watchdog !== null) {
            window.clearTimeout(watchdog);
            watchdog = null;
          }
        };
        const advance = () => {
          clearWatchdog();
          // B20: only the most recent utterance for this session may advance
          // the queue. cancel() bumps the session out of activeSession; a
          // superseding speakConversational creates a new session. Either way
          // a stale onend lands here with myId !== session.utteranceSeq (or
          // a different session pointer) and is dropped.
          if (session.cancelled || this.activeSession !== session) return;
          if (myId !== session.utteranceSeq) return;
          session.current = null;
          window.setTimeout(speakNext, 40);
        };
        u.onend = advance;
        u.onerror = advance;
        session.current = u;
        try {
          // resume() is a no-op when not paused, but on macOS Electron the
          // queue can wedge in a "paused" state after cancel(); calling it
          // before speak() unblocks the first utterance.
          window.speechSynthesis.resume();
          window.speechSynthesis.speak(u);
          // ~120ms per char + 3s floor + 6s slack covers Siri zh at rate=1.05.
          // Capped at 30s so a single chunk can't pin the queue indefinitely.
          const budgetMs = Math.min(30_000, 3_000 + text.length * 120 + 6_000);
          watchdog = window.setTimeout(advance, budgetMs);
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

  speak(text: string, onDone?: SpeechCallback): void {
    this.speakConversational(text, onDone);
  }
}

// Default singleton — preserves the original named-export API so callers
// (App.tsx, useSpeech.ts) don't have to change. Anything that needs a
// genuinely isolated instance (tests, secondary renderers) can `new
// SpeechController()` directly instead.
const defaultController = new SpeechController();

export function setSpeechFilterMode(mode: SpeechFilterMode): void {
  defaultController.setFilterMode(mode);
}

export function cancelSpeech(silent = false): void {
  defaultController.cancel(silent);
}

export function isSpeechActive(): boolean {
  return defaultController.isActive();
}

export function speakConversational(raw: string, onDone?: SpeechCallback): void {
  defaultController.speakConversational(raw, onDone);
}

// Back-compat wrapper: callers using the old robotic `speak` still work,
// just now they get the conversational pipeline.
export function speak(text: string, onDone?: SpeechCallback): void {
  defaultController.speak(text, onDone);
}
