import { useEffect, useRef, useState } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { cosineSimilarity, embedSpeaker } from '../lib/speaker-embedding';

// Below this many samples (~0.5s @ 16 kHz) we skip the voice-lock gate
// entirely — embeddings on very short clips are unreliable and we'd rather
// pass through brief responses ("ok", "yes") than reject them.
const MIN_SAMPLES_FOR_GATE = 8000;
// Cosine-similarity threshold the segment must meet against the enrolled
// embedding to be accepted. Tuned empirically; expose to settings later if
// real-world false-reject rate is too high.
const VOICE_LOCK_THRESHOLD = 0.5;

interface UseVoiceCaptureOptions {
  enabled: boolean;
  onTranscript: (text: string) => void;
  onBargeIn?: () => void;
  lang?: 'auto' | 'zh' | 'en';
  // When true, drop any speech segment that starts during this window. Used to
  // ignore the mic while TTS is playing back through the speakers — otherwise
  // the VAD trips on its own output, fires barge-in (cutting Claude off), and
  // transcribes the playback as if the user said it.
  suppressed?: boolean;
  // Voice-lock gate: if enabled and an enrolled embedding is provided, each
  // captured segment is embedded and compared against the enrollment via
  // cosine similarity. Below threshold → dropped before transcription.
  voiceLockEnabled?: boolean;
  voicePrintEmbedding?: Float32Array | null;
  onVoiceLockReject?: () => void;
  // Enrollment tap. When set, every clean speech segment is handed to the tap
  // instead of being transcribed — used by the voice-lock panel to collect
  // samples for enrollment without polluting the chat transcript. The gate is
  // also bypassed in this mode (enrollment runs before we know the voice).
  tapSegment?: (samples: Float32Array) => void;
}

interface UseVoiceCaptureResult {
  active: boolean;
  listening: boolean;
  lastError: string | null;
  speechLevel: number;
  asrAvailable: boolean | null;
}

// Use a document-relative path so it works under both the Vite dev server
// (http://localhost:5173/vad/...) and the packaged app (file:///.../dist/vad/...).
const VAD_ASSET_BASE = new URL('vad/', document.baseURI).href;

export function useVoiceCapture({
  enabled,
  onTranscript,
  onBargeIn,
  lang = 'auto',
  suppressed = false,
  voiceLockEnabled = false,
  voicePrintEmbedding = null,
  onVoiceLockReject,
  tapSegment,
}: UseVoiceCaptureOptions): UseVoiceCaptureResult {
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [speechLevel, setSpeechLevel] = useState(0);
  const [asrAvailable, setAsrAvailable] = useState<boolean | null>(null);

  const vadRef = useRef<MicVAD | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onBargeInRef = useRef(onBargeIn);
  const onVoiceLockRejectRef = useRef(onVoiceLockReject);
  const tapSegmentRef = useRef(tapSegment);
  // Mirrored to a ref so VAD callbacks see the current value without
  // re-instantiating the VAD on every toggle.
  const suppressedRef = useRef(suppressed);
  const voiceLockEnabledRef = useRef(voiceLockEnabled);
  const voicePrintEmbeddingRef = useRef(voicePrintEmbedding);
  // Mirror lang so swapping zh⇄en⇄auto doesn't tear down MicVAD (which
  // re-downloads the worklet + onnx model and re-prompts for mic on some
  // browsers). The transcribePcm call inside onSpeechEnd reads the ref.
  const langRef = useRef(lang);
  // Tracks whether the in-flight speech segment started while suppressed; if
  // so we drop it at speech-end even if suppression has since cleared.
  const segmentSuppressedRef = useRef(false);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onBargeInRef.current = onBargeIn;
  }, [onBargeIn]);
  useEffect(() => {
    onVoiceLockRejectRef.current = onVoiceLockReject;
  }, [onVoiceLockReject]);
  useEffect(() => {
    tapSegmentRef.current = tapSegment;
  }, [tapSegment]);
  useEffect(() => {
    suppressedRef.current = suppressed;
  }, [suppressed]);
  useEffect(() => {
    voiceLockEnabledRef.current = voiceLockEnabled;
  }, [voiceLockEnabled]);
  useEffect(() => {
    voicePrintEmbeddingRef.current = voicePrintEmbedding;
  }, [voicePrintEmbedding]);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  // Check whisper availability once on mount.
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

  useEffect(() => {
    if (!enabled) {
      // Tear down any existing VAD.
      const v = vadRef.current;
      vadRef.current = null;
      if (v) v.destroy().catch(() => {});
      setActive(false);
      setListening(false);
      return;
    }

    let cancelled = false;
    let createdVad: MicVAD | null = null;

    (async () => {
      try {
        const vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: VAD_ASSET_BASE,
          onnxWASMBasePath: VAD_ASSET_BASE,
          // Explicit AEC/NS/AGC so the speaker→mic loop is dampened. Browsers
          // default these on for `{audio: true}`, but the lib's default
          // getStream doesn't pass them through, and without AEC the VAD
          // trips on Claude's own TTS output coming back through the mic.
          getStream: () =>
            navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            }),
          // Sensitivity: keep defaults moderate; we'd rather miss a few
          // misfires than truncate words.
          positiveSpeechThreshold: 0.55,
          negativeSpeechThreshold: 0.4,
          // Grace period before declaring speech-end ("did they pause or stop?").
          redemptionMs: 384,
          // Drop sub-128ms segments as VAD misfires (clicks, breaths).
          minSpeechMs: 128,
          // Prepend ~256ms of audio so word onsets aren't clipped.
          preSpeechPadMs: 256,
          onSpeechStart: () => {
            // Enrollment is a user-driven capture — never let TTS suppression
            // swallow it, otherwise the panel hangs at "waiting for mic" while
            // Claude is mid-greeting. Barge-in is also pointless here: the
            // user isn't trying to interrupt, they're recording themselves.
            const tapping = tapSegmentRef.current != null;
            if (suppressedRef.current && !tapping) {
              // TTS is playing — treat this as speaker echo, not user speech.
              // Don't barge in (that would cut Claude off mid-sentence) and
              // mark the segment so we drop the transcript at speech-end.
              segmentSuppressedRef.current = true;
              return;
            }
            segmentSuppressedRef.current = false;
            setListening(true);
            if (!tapping) {
              // Barge-in: immediately cut Claude off if he was talking.
              onBargeInRef.current?.();
            }
          },
          onSpeechEnd: async (audio: Float32Array) => {
            if (segmentSuppressedRef.current) {
              segmentSuppressedRef.current = false;
              return;
            }
            setListening(false);

            // Enrollment tap takes precedence: hand the raw segment to the
            // collector and skip both the gate and transcription. Enrollment
            // happens before any voice print exists, so there's no gate to run.
            const tap = tapSegmentRef.current;
            if (tap) {
              try { tap(audio); } catch (e) { setLastError(String((e as Error)?.message ?? e)); }
              return;
            }

            // Voice-lock gate: drop segments that don't match the enrolled
            // speaker. Skip the gate on very short clips — embeddings on
            // <0.5s of audio are too noisy to act on, and forcing the user to
            // re-say "yes"/"ok" hurts UX more than letting a stray short
            // utterance through.
            const lockOn = voiceLockEnabledRef.current;
            const enrolled = voicePrintEmbeddingRef.current;
            if (lockOn && enrolled && audio.length >= MIN_SAMPLES_FOR_GATE) {
              try {
                const emb = await embedSpeaker(audio);
                if (emb) {
                  const sim = cosineSimilarity(emb, enrolled);
                  if (sim < VOICE_LOCK_THRESHOLD) {
                    onVoiceLockRejectRef.current?.();
                    return;
                  }
                }
              } catch (e) {
                // If embedding fails (e.g. model still loading) fall through to
                // transcription rather than silently dropping legitimate speech.
                console.warn('[voice-lock] embedding failed, passing through:', e);
              }
            }

            // No renderer-side overlap guard: the main-process single-flight
            // queue in whisper.ts serializes work and resolves IPC calls in
            // submission order, so rapid-fire segments end up in the user's
            // transcript in the order they were spoken.
            try {
              // ipcRenderer.invoke uses structured clone (not Transferable), so
              // the buffer is *copied* across the bridge — it isn't detached.
              // We still allocate our own copy here because VAD reuses the
              // same Float32Array for the next segment, and structured clone
              // happens after this call returns; without a copy, a fast
              // follow-up segment could mutate the buffer mid-clone.
              const copy = new Float32Array(audio.length);
              copy.set(audio);
              const r = await window.vibeMeet.transcribePcm(copy.buffer, langRef.current);
              if (r.ok && r.text.trim()) {
                onTranscriptRef.current(r.text.trim());
              } else if (!r.ok) {
                setLastError(r.error);
              }
            } catch (e) {
              setLastError(String((e as Error)?.message ?? e));
            }
          },
          onVADMisfire: () => {
            segmentSuppressedRef.current = false;
            setListening(false);
          },
          onFrameProcessed: (probs) => {
            // Cheap UI signal: smoothed speech probability for the mic meter.
            setSpeechLevel((prev) => prev * 0.6 + probs.isSpeech * 0.4);
          },
        });
        if (cancelled) {
          vad.destroy().catch(() => {});
          return;
        }
        createdVad = vad;
        vadRef.current = vad;
        await vad.start();
        setActive(true);
        setLastError(null);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        setLastError(`Mic init failed: ${msg}`);
        setActive(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdVad) {
        createdVad.destroy().catch(() => {});
      }
      if (vadRef.current === createdVad) vadRef.current = null;
      setActive(false);
      setListening(false);
    };
  }, [enabled]);

  return { active, listening, lastError, speechLevel, asrAvailable };
}
