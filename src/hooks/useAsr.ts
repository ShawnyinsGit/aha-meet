import { useEffect, useState } from 'react';
import { useVoiceCapture } from './useVoiceCapture';
import { useContinuousSpeech } from './useSpeech';
import {
  deriveMicrophoneUiState,
  type AsrMode,
  type MicrophoneCaptureStatus,
} from '../lib/microphone-ui-state';

// Whisper is the primary ASR path; browser webkitSpeechRecognition is the
// fallback when whisper-cli isn't bundled (dev tree without
// `pnpm prebuild:whisper`, or future Windows/Linux builds we haven't shipped
// whisper for yet). This hook hides the routing behind a single interface so
// App doesn't have to manage two parallel ASR sources — and crucially keeps
// `supported: true` while the probe is in flight, so the mic button doesn't
// briefly render as disabled on startup.

interface UseAsrOptions {
  enabled: boolean;
  onTranscript: (text: string) => void;
  onBargeIn?: () => void;
  lang?: 'auto' | 'zh' | 'en';
  // When true, VAD stays alive but speech segments are dropped. Used for
  // spacebar mute so the toggle is instant (no VAD destroy/recreate).
  paused?: boolean;
  suppressed?: boolean;
  voiceLockEnabled?: boolean;
  voicePrintEmbedding?: Float32Array | null;
  onVoiceLockReject?: () => void;
  tapSegment?: (samples: Float32Array) => void;
}

interface UseAsrResult {
  mode: AsrMode;
  listening: boolean;
  supported: boolean;
  speechLevel: number;
  lastError: string | null;
  status: MicrophoneCaptureStatus;
  retryable: boolean;
  retry: () => void;
}

export function useAsr({
  enabled,
  onTranscript,
  onBargeIn,
  lang,
  paused,
  suppressed,
  voiceLockEnabled,
  voicePrintEmbedding,
  onVoiceLockReject,
  tapSegment,
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
    paused,
    suppressed,
    voiceLockEnabled,
    voicePrintEmbedding,
    onVoiceLockReject,
    tapSegment,
  });

  const browser = useContinuousSpeech({
    enabled: enabled && mode === 'browser' && !enrollmentActive && !paused,
    onFinal: onTranscript,
    onInterim: (t: string) => {
      if (t.length >= 2) onBargeIn?.();
    },
  });

  // During enrollment we always run VAD (even in browser mode) so its view of
  // listening/speechLevel/support is the live one. Outside enrollment we fall
  // back to whichever backend is mounted for that mode.
  const usingWhisperPath = mode === 'whisper' || (mode === 'browser' && enrollmentActive);

  const uiMode: AsrMode = usingWhisperPath ? 'whisper' : mode;
  const { supported, retryable } = deriveMicrophoneUiState({
    mode: uiMode,
    captureStatus: whisper.status,
    browserSupported: browser.supported,
    browserFailed: browser.error != null,
  });

  const listening = usingWhisperPath ? whisper.listening : browser.listening;
  const speechLevel = usingWhisperPath ? whisper.speechLevel : browser.speechLevel;
  const browserError = browser.error ?? (
    browser.supported === false
      ? 'Speech recognition is unavailable — Whisper is not bundled and Browser Speech Recognition is unsupported'
      : null
  );
  const lastError = usingWhisperPath ? whisper.lastError : browserError;
  const status: MicrophoneCaptureStatus =
    mode === 'probing'
      ? 'initializing'
      : usingWhisperPath
        ? whisper.status
        : browser.supported === null
          ? 'initializing'
          : browser.supported === false
            ? 'unavailable'
            : browserError
              ? 'failed'
              : 'ready';

  const retry = usingWhisperPath ? whisper.retry : browser.retry;

  return { mode, listening, supported, speechLevel, lastError, status, retryable, retry };
}
