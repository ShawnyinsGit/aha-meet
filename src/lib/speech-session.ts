import { prepareForSpeech, splitSentences, type SpeechFilterMode } from './speech-format';
import type { Locale } from './speech-format';
import { ensureVoice, loadVoices } from './voice-registry';

interface QueueChunk {
  text: string;
  locale: Locale;
}

// Per-session TTS state. utteranceSeq is the B20 guard — stale onend/onerror
// callbacks from a superseded utterance compare their captured seq against
// the current value and bail rather than advancing the queue past its end.
//
// turnId tags a streaming session with the upstream LLM turn so enqueue can
// distinguish "more chunks for the same turn" (append, don't cancel — that's
// the streaming-by-sentence path) from "different turn entirely" (supersede).
// completed=true means the upstream caller has called markTurnComplete, i.e.
// no further enqueue is coming; once the queue drains, fire onAllDone.
//
// drainHoldTimer is a fallback: if the queue empties before completed flips,
// we wait up to DRAIN_HOLD_FALLBACK_MS for the next sentence before forcing
// onAllDone. This avoids re-arming the mic the instant a sentence finishes,
// then re-muting it 50ms later when the next sentence arrives.
interface SpeakSession {
  cancelled: boolean;
  current: SpeechSynthesisUtterance | null;
  utteranceSeq: number;
  onAllDone?: () => void;
  chunks: QueueChunk[];
  index: number;
  turnId: string | null;
  streaming: boolean;
  completed: boolean;
  awaitingMore: boolean;
  resume?: () => void;
  drainHoldTimer: number | null;
  fedAnyChunk: boolean;
}

type SpeechCallback = () => void;

export interface EnqueueOptions {
  // First sentence in a turn: needs to clear FIRST_SENTENCE_MIN before being
  // flushed. Follow-up sentences use the lower FOLLOW_SENTENCE_MIN bar.
  isFirstChunk?: boolean;
  // markTurnComplete equivalent passed inline: callers can pass the final
  // delta + isFinal=true rather than making a second call.
  isFinal?: boolean;
}

export interface SpeakHandle {
  // Replace anything in flight with this single utterance. Used for fallback
  // synthetic assistant messages (collectFinalBufferedLines, narrateAssistantLine)
  // and for the legacy non-streaming path. onDone fires when playback ends.
  supersede: (text: string, onDone?: SpeechCallback) => void;
  // Stream a delta for the given turnId. If turnId matches the active session,
  // appends to the live queue (never cancels) and starts speaking as soon as
  // the first sentence meets the meaningful-length threshold. If turnId differs
  // (different turn entirely), supersedes silently and begins a new session.
  enqueue: (text: string, turnId: string, opts?: EnqueueOptions, onDone?: SpeechCallback) => void;
  // Flip the active session's completed flag. Once the queue drains the
  // session fires onAllDone and clears. No-op if turnId doesn't match the
  // active session (the turn was already superseded).
  markTurnComplete: (turnId: string) => void;
}

// Thresholds: short fragments like "好的，" sound abrupt as the very first
// chunk after the user finishes speaking, so we wait until we have a
// meaningful clause before kicking the queue. After the first sentence the
// listener already hears continuous speech, so the bar drops.
const FIRST_SENTENCE_MIN = 6;
const FOLLOW_SENTENCE_MIN = 4;
const DRAIN_HOLD_FALLBACK_MS = 5_000;

// Count meaningful (non-whitespace, non-punctuation) characters. CJK + Latin
// only — symbols, spaces, and quotes don't contribute.
function meaningfulLen(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) n++;
  }
  return n;
}

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
  // Used by the internal supersede path so the OLD session's onDone doesn't
  // race-clear flags the NEW session is about to set. External callers
  // (barge-in, leave, enrollment start) leave silent=false so their onAllDone
  // fires and downstream state (aiSpeaking, mic suppression) can reset.
  cancel(silent = false): void {
    if (!('speechSynthesis' in window)) return;
    const session = this.activeSession;
    // Short-circuit when idle: every speakConversational() used to fire this
    // unconditionally as a supersede no-op, but the engine round-trip is
    // 5–50ms on macOS Electron and occasionally delays the next utterance's
    // first audible character. If nothing is queued or in flight, there's
    // nothing to cancel — skip the engine call entirely.
    if (!session) return;
    session.cancelled = true;
    session.current = null;
    session.chunks.length = 0;
    session.index = 0;
    if (session.drainHoldTimer !== null) {
      window.clearTimeout(session.drainHoldTimer);
      session.drainHoldTimer = null;
    }
    try { window.speechSynthesis.cancel(); } catch (err) {
      console.warn('[speech] window.speechSynthesis.cancel threw:', err);
    }
    this.activeSession = null;
    if (!silent && session.onAllDone) {
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

  // One-shot supersede path. Cancels any in-flight session silently and plays
  // `raw` as a fresh non-streaming session. onDone fires when the queue drains.
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
      chunks: chunks.slice(),
      index: 0,
      turnId: null,
      streaming: false,
      completed: true,
      awaitingMore: false,
      drainHoldTimer: null,
      fedAnyChunk: false,
    };
    this.activeSession = session;
    this.bootstrap(session);
  }

  // Streaming append. Called once per emitted sentence by the meeting store's
  // stream_event handler. The store accumulates LLM delta text, splits it into
  // sentences, applies thresholds, and calls this for each sentence ready to
  // play. We never call prepareForSpeech here — the store has already done
  // markdown stripping / summarize / scrub on the buffer before splitting.
  enqueueConversational(
    raw: string,
    turnId: string,
    opts: EnqueueOptions = {},
    onDone?: SpeechCallback,
  ): void {
    if (!('speechSynthesis' in window)) {
      if (opts.isFinal) onDone?.();
      return;
    }

    const active = this.activeSession;
    const sameTurn = active && active.streaming && active.turnId === turnId && !active.completed;

    // Apply threshold against the raw sentence string. The store has already
    // filtered out below-threshold fragments by holding them in its buffer,
    // but we double-check here so a misbehaving caller can't sneak a "OK, "
    // utterance through.
    const minLen = opts.isFinal
      ? 0
      : (sameTurn && active.fedAnyChunk ? FOLLOW_SENTENCE_MIN : FIRST_SENTENCE_MIN);
    const passesThreshold = meaningfulLen(raw) >= minLen;

    // Even on the same-turn path: if the chunk fails the threshold AND it's
    // not the final flush, drop it. The store should have held it.
    const splitChunks = passesThreshold || sameTurn === false
      ? splitSentences(raw)
      : [];

    if (sameTurn) {
      if (splitChunks.length > 0) {
        active.chunks.push(...splitChunks);
        active.fedAnyChunk = true;
        // New chunks invalidate the drain-hold timer — we have more to say.
        if (active.drainHoldTimer !== null) {
          window.clearTimeout(active.drainHoldTimer);
          active.drainHoldTimer = null;
        }
      }
      if (onDone) active.onAllDone = onDone;
      if (opts.isFinal) active.completed = true;
      // Re-prime the pump if it parked at awaitingMore.
      if (active.awaitingMore) {
        active.awaitingMore = false;
        const r = active.resume;
        active.resume = undefined;
        r?.();
      } else if (opts.isFinal && active.chunks.length === active.index && !active.current) {
        // Completed mid-park edge case: no more chunks coming, queue empty,
        // nothing in flight. finalize right away.
        this.finalizeSession(active);
      }
      return;
    }

    // Different turn (or no streaming session) — supersede silently.
    this.cancel(true);
    if (splitChunks.length === 0) {
      if (opts.isFinal) onDone?.();
      return;
    }
    const session: SpeakSession = {
      cancelled: false,
      current: null,
      utteranceSeq: 0,
      onAllDone: onDone,
      chunks: splitChunks.slice(),
      index: 0,
      turnId,
      streaming: true,
      completed: opts.isFinal === true,
      awaitingMore: false,
      drainHoldTimer: null,
      fedAnyChunk: true,
    };
    this.activeSession = session;
    this.bootstrap(session);
  }

  // Caller signals "no more chunks for this turn". The active session, if it
  // matches turnId, flips completed=true. The pump then either drains and
  // fires onAllDone, or — if parked at awaitingMore — exits the park.
  markTurnComplete(turnId: string): void {
    const session = this.activeSession;
    if (!session || !session.streaming || session.turnId !== turnId) return;
    session.completed = true;
    if (session.awaitingMore) {
      session.awaitingMore = false;
      const r = session.resume;
      session.resume = undefined;
      r?.();
    } else if (session.chunks.length === session.index && !session.current) {
      this.finalizeSession(session);
    } else if (session.drainHoldTimer !== null) {
      // Drain-hold timer was armed but completion arrived first — cancel the
      // fallback and let the natural drain path finalize.
      window.clearTimeout(session.drainHoldTimer);
      session.drainHoldTimer = null;
    }
  }

  speak(text: string, onDone?: SpeechCallback): void {
    this.speakConversational(text, onDone);
  }

  private bootstrap(session: SpeakSession): void {
    const start = () => {
      if (session.cancelled || this.activeSession !== session) return;
      this.pumpNext(session);
    };
    // Wait for voices to load so we don't bind the first utterance to a null
    // voice (the documented cause of silent TTS on macOS Electron).
    loadVoices().then(start, start);
  }

  private finalizeSession(session: SpeakSession): void {
    if (this.activeSession !== session) return;
    if (session.drainHoldTimer !== null) {
      window.clearTimeout(session.drainHoldTimer);
      session.drainHoldTimer = null;
    }
    this.activeSession = null;
    session.onAllDone?.();
  }

  private pumpNext(session: SpeakSession): void {
    if (session.cancelled || this.activeSession !== session) return;
    const next = session.index < session.chunks.length
      ? session.chunks[session.index++]
      : undefined;
    if (!next) {
      if (session.completed) {
        this.finalizeSession(session);
        return;
      }
      // Streaming, more chunks expected. Park AND arm the fallback drain-hold:
      // if no chunk arrives within DRAIN_HOLD_FALLBACK_MS we force finalize so
      // a stuck upstream can't pin aiSpeaking=true forever.
      session.awaitingMore = true;
      session.resume = () => {
        if (session.cancelled || this.activeSession !== session) return;
        this.pumpNext(session);
      };
      if (session.drainHoldTimer === null) {
        session.drainHoldTimer = window.setTimeout(() => {
          session.drainHoldTimer = null;
          if (session.cancelled || this.activeSession !== session) return;
          if (session.index < session.chunks.length || session.current) return;
          // Treat as completion: nothing arrived in 5s, release the mic.
          session.completed = true;
          this.finalizeSession(session);
        }, DRAIN_HOLD_FALLBACK_MS);
      }
      return;
    }

    const { text, locale } = next;
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
    // B30 watchdog: on macOS Electron the speech engine can wedge such that
    // speak(u) is silently dropped — neither onend nor onerror ever fires,
    // freezing the queue forever. The watchdog forces advance() if no callback
    // fires within a generous text-length budget. A late real onend/onerror is
    // then a safe no-op thanks to the B20 utteranceSeq guard.
    let watchdog: number | null = null;
    const clearWatchdog = () => {
      if (watchdog !== null) {
        window.clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const advance = () => {
      clearWatchdog();
      // B20: only the most recent utterance for this session may advance the
      // queue. cancel() bumps the session out of activeSession; a superseding
      // call creates a new session. Either way a stale onend lands here with
      // myId !== session.utteranceSeq (or a different session pointer) and is
      // dropped.
      if (session.cancelled || this.activeSession !== session) return;
      if (myId !== session.utteranceSeq) return;
      session.current = null;
      window.setTimeout(() => this.pumpNext(session), 40);
    };
    u.onend = advance;
    u.onerror = advance;
    session.current = u;
    session.fedAnyChunk = true;
    try {
      // resume() is a no-op when not paused, but on macOS Electron the queue
      // can wedge in a "paused" state after cancel(); calling it before
      // speak() unblocks the first utterance.
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(u);
      // ~120ms per char + 3s floor + 6s slack covers Siri zh at rate=1.05.
      // Capped at 30s so a single chunk can't pin the queue indefinitely.
      const budgetMs = Math.min(30_000, 3_000 + text.length * 120 + 6_000);
      watchdog = window.setTimeout(advance, budgetMs);
    } catch {
      window.setTimeout(() => this.pumpNext(session), 40);
    }
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

export function enqueueConversational(
  raw: string,
  turnId: string,
  opts?: EnqueueOptions,
  onDone?: SpeechCallback,
): void {
  defaultController.enqueueConversational(raw, turnId, opts, onDone);
}

export function markTurnComplete(turnId: string): void {
  defaultController.markTurnComplete(turnId);
}

// Back-compat wrapper: callers using the old robotic `speak` still work,
// just now they get the conversational pipeline.
export function speak(text: string, onDone?: SpeechCallback): void {
  defaultController.speak(text, onDone);
}

// Cold-start the macOS Electron speech engine. First real `speak()` after
// app launch costs an extra 80–300ms while the engine spins up; pushing a
// zero-volume, single-character utterance during idle time pays that cost
// up front so the user's first actual reply hits a warm engine. Idempotent:
// after the first call the engine stays warm for the session, so repeated
// invocations are cheap (~5ms) but harmless. Safe to call before voices
// load — we don't bind a voice, so the engine picks a default and discards.
let warmupDone = false;
export function warmupTTS(): void {
  if (warmupDone) return;
  if (!('speechSynthesis' in window)) return;
  warmupDone = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.rate = 1;
    u.onend = () => { /* engine warm */ };
    u.onerror = () => { warmupDone = false; };
    window.speechSynthesis.speak(u);
  } catch {
    warmupDone = false;
  }
}
