import type { Locale } from './speech-format';

// ---------------------------------------------------------------------------
// VoiceRegistry — encapsulates all voice-picking state that was previously
// module-level mutable globals (voiceCache, voicesReady, selectedVoiceName).
// Mirrors the SpeechController pattern from speech-session.ts: a default
// singleton preserves the existing named-export API, while tests or secondary
// renderers can `new VoiceRegistry()` for isolation.
// ---------------------------------------------------------------------------

export class VoiceRegistry {
  private voiceCache: Map<Locale, SpeechSynthesisVoice> = new Map();
  private voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;
  private selectedVoiceName: string | null = null;
  private voicesChangedListener: (() => void) | null = null;

  constructor() {
    // Kick voice loading at construction — gives the engine a head start so
    // by the time the first assistant reply arrives, voices are usually ready.
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      // Touching getVoices() is the standard trick to trigger lazy population.
      window.speechSynthesis.getVoices();
      void this.loadVoices();
      // Re-probe on engine refresh (e.g. system voices installed at runtime).
      this.voicesChangedListener = () => { this.voiceCache.clear(); };
      window.speechSynthesis.addEventListener('voiceschanged', this.voicesChangedListener);
    }
  }

  /** Tear down event listeners. Call when the registry is no longer needed. */
  dispose(): void {
    if (this.voicesChangedListener && 'speechSynthesis' in window) {
      window.speechSynthesis.removeEventListener('voiceschanged', this.voicesChangedListener);
      this.voicesChangedListener = null;
    }
  }

  loadVoices(): Promise<SpeechSynthesisVoice[]> {
    if (this.voicesReady) return this.voicesReady;
    this.voicesReady = new Promise((resolve) => {
      if (!('speechSynthesis' in window)) { resolve([]); return; }
      const synth = window.speechSynthesis;
      const settled = { done: false };
      // B4: the timeout path used to resolve without detaching onChanged,
      // leaving a dangling 'voiceschanged' subscription if voices arrived
      // late. Centralise removal in finish() so every exit path cleans up.
      let onChanged: (() => void) | null = null;
      const finish = (voices: SpeechSynthesisVoice[]) => {
        if (settled.done) return;
        settled.done = true;
        if (onChanged) {
          synth.removeEventListener('voiceschanged', onChanged);
          onChanged = null;
        }
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
      onChanged = () => { tryNow(); };
      synth.addEventListener('voiceschanged', onChanged);
      // Hard timeout — some platforms never fire voiceschanged. Resolve with
      // whatever we have so speech still attempts to play.
      window.setTimeout(() => finish(synth.getVoices()), 1500);
    });
    return this.voicesReady;
  }

  setSelectedVoiceName(name: string | null): void {
    if (this.selectedVoiceName === name) return;
    this.selectedVoiceName = name;
    // Drop the locale cache so the next utterance re-picks against the new
    // preference instead of speaking with the old voice.
    this.voiceCache.clear();
  }

  getSelectedVoiceName(): string | null {
    return this.selectedVoiceName;
  }

  pickVoiceForLocale(locale: Locale): SpeechSynthesisVoice | null {
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
    if (locale === 'zh' && this.selectedVoiceName) {
      const pick = matches.find((v) => v.name === this.selectedVoiceName);
      if (pick) return pick;
      // Selected voice no longer installed — fall through to ranking rather
      // than returning null (which would force the browser default).
    }
    const pool = matches.length > 0 ? matches : all;
    return pool
      .map((v) => ({ v, score: rankVoice(v) }))
      .sort((a, b) => b.score - a.score)[0]?.v ?? null;
  }

  ensureVoice(locale: Locale): SpeechSynthesisVoice | null {
    const cached = this.voiceCache.get(locale);
    if (cached) return cached;
    const v = this.pickVoiceForLocale(locale);
    if (v) this.voiceCache.set(locale, v);
    return v;
  }
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

// Default singleton — preserves the original named-export API so callers
// (speech-session.ts, useSpeech.ts, App.tsx) don't have to change.
const defaultRegistry = new VoiceRegistry();

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return defaultRegistry.loadVoices();
}

export function setSelectedVoiceName(name: string | null): void {
  defaultRegistry.setSelectedVoiceName(name);
}

export function pickVoiceForLocale(locale: Locale): SpeechSynthesisVoice | null {
  return defaultRegistry.pickVoiceForLocale(locale);
}

export function ensureVoice(locale: Locale): SpeechSynthesisVoice | null {
  return defaultRegistry.ensureVoice(locale);
}
