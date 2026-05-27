import { useEffect, useState } from 'react';
import { useVoiceCapture } from './useVoiceCapture';
import { useContinuousSpeech } from './useSpeech';

// Whisper is the primary ASR path; browser webkitSpeechRecognition is the
// fallback when whisper-cli isn't bundled (dev tree without
// `pnpm prebuild:whisper`, or future Windows/Linux builds we haven't shipped
// whisper for yet). This hook hides the routing behind a single interface so
// App doesn't have to manage two parallel ASR sources — and crucially keeps
// `supported: true` while the probe is in flight, so the mic button doesn't
// briefly render as disabled on startup.

type AsrMode = 'whisper' | 'browser' | 'probing';

interface UseAsrOptions {
  enabled: boolean;
  onTranscript: (text: string) => void;
  onBargeIn?: () => void;
  lang?: 'auto' | 'zh' | 'en';
  suppressed?: boolean;
  voiceLockEnabled?: boolean;
  voicePrintEmbedding?: Float32Array | null;
  onVoiceLockReject?: () => void;
  tapSegment?: (samples: Float32Array) => void;
  // When the underlying mic backend is muted by the user we still want the
  // mic button to remain enabled (so they can toggle back). Whisper teardown
  // sets active=false; surface this so `supported` doesn't go false-y.
  muted?: boolean;
}

interface UseAsrResult {
  mode: AsrMode;
  listening: boolean;
  supported: boolean;
  speechLevel: number;
  lastError: string | null;
}

export function useAsr({
  enabled,
  onTranscript,
  onBargeIn,
  lang,
  suppressed,
  voiceLockEnabled,
  voicePrintEmbedding,
  onVoiceLockReject,
  tapSegment,
  muted = false,
}: UseAsrOptions): UseAsrResult {
  const [asrAvailable, setAsrAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.vibeMeet
      .asrAvailable()
      .then((r) => {
        if (cancelled) return;
        const available = r.ok ? r.available : false;
        // One-shot diagnostic so we can confirm which path a packaged build
        // committed to. Without this, a silent fallback to browser mode is
        // invisible — and browser mode has historically broken enrollment.
        console.info('[asr] probe →', { available, raw: r });
        setAsrAvailable(available);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[asr] probe failed, falling back to browser mode:', e);
        setAsrAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: AsrMode =
    asrAvailable === null ? 'probing' : asrAvailable ? 'whisper' : 'browser';

  // Enrollment needs raw PCM segments, which only the VAD-based path produces.
  // webkitSpeechRecognition (browser path) owns its own audio capture and
  // emits transcripts, never raw audio — so it cannot feed the enrollment
  // collector. Whenever a `tapSegment` is requested we mount VAD even in
  // browser mode and silence browser ASR. This (a) makes enrollment work
  // regardless of whether whisper is bundled, and (b) prevents browser ASR
  // from transcribing the user's enrollment audio into the chat transcript.
  const enrollmentActive = !!tapSegment;

  // Both backends mount unconditionally (React hook rules) but only the one
  // matching the chosen mode gets `enabled: true`. During probing both stay
  // off so we don't trigger a mic permission prompt before we know which
  // path we're committing to.
  const whisper = useVoiceCapture({
    enabled: enabled && mode !== 'probing' && (mode === 'whisper' || enrollmentActive),
    onTranscript,
    onBargeIn,
    lang,
    suppressed,
    voiceLockEnabled,
    voicePrintEmbedding,
    onVoiceLockReject,
    tapSegment,
  });

  const browser = useContinuousSpeech({
    enabled: enabled && mode === 'browser' && !enrollmentActive,
    onFinal: onTranscript,
    onInterim: (t: string) => {
      if (t.length >= 2) onBargeIn?.();
    },
  });

  // During enrollment we always run VAD (even in browser mode) so its view of
  // listening/speechLevel/support is the live one. Outside enrollment we fall
  // back to whichever backend is mounted for that mode.
  const usingWhisperPath = mode === 'whisper' || (mode === 'browser' && enrollmentActive);

  // Treat probing as supported so the mic button doesn't flicker disabled
  // on startup. Once probed: whisper considers `active || muted` supported
  // (teardown on mute is normal); browser uses its own `supported` flag.
  const supported =
    mode === 'probing'
      ? true
      : usingWhisperPath
        ? whisper.active || muted
        : browser.supported;

  const listening = usingWhisperPath ? whisper.listening : browser.listening;
  const speechLevel = usingWhisperPath ? whisper.speechLevel : 0;
  const lastError = usingWhisperPath ? whisper.lastError : null;

  return { mode, listening, supported, speechLevel, lastError };
}
