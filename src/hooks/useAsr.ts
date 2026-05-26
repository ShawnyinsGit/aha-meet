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
        if (!cancelled) setAsrAvailable(r.ok ? r.available : false);
      })
      .catch(() => {
        if (!cancelled) setAsrAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: AsrMode =
    asrAvailable === null ? 'probing' : asrAvailable ? 'whisper' : 'browser';

  // Both backends mount unconditionally (React hook rules) but only the one
  // matching the chosen mode gets `enabled: true`. During probing both stay
  // off so we don't trigger a mic permission prompt before we know which
  // path we're committing to.
  const whisper = useVoiceCapture({
    enabled: enabled && mode === 'whisper',
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
    enabled: enabled && mode === 'browser',
    onFinal: onTranscript,
    onInterim: (t: string) => {
      if (t.length >= 2) onBargeIn?.();
    },
  });

  // Treat probing as supported so the mic button doesn't flicker disabled
  // on startup. Once probed: whisper considers `active || muted` supported
  // (teardown on mute is normal); browser uses its own `supported` flag.
  const supported =
    mode === 'probing'
      ? true
      : mode === 'whisper'
        ? whisper.active || muted
        : browser.supported;

  const listening = mode === 'browser' ? browser.listening : whisper.listening;
  const speechLevel = mode === 'whisper' ? whisper.speechLevel : 0;
  const lastError = mode === 'whisper' ? whisper.lastError : null;

  return { mode, listening, supported, speechLevel, lastError };
}
