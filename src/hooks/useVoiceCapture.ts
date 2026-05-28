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
// Barge-in-during-playback gate: a speech segment that starts while TTS is
// playing must reach this many samples (~480ms @ 16 kHz) before we treat it
// as a real user interruption. Below this we assume it's AEC residue, a
// throat clear, or a cough and drop it silently. 480ms is empirically long
// enough to filter common false positives without making real interruptions
// feel laggy.
const MIN_SAMPLES_FOR_BARGE_IN = 7680;
// Average speech-probability needed across a suppressed segment before we
// accept it as a barge-in. AEC residue and room noise tend to sit around
// 0.45-0.55 (just at VAD's positiveSpeechThreshold); real speech runs
// higher, but the segment also includes ~384ms of low-prob redemption tail
// which drags the average down. 0.55 is a deliberate middle ground that
// accepts real speech and rejects pure-echo blips.
const MIN_AVG_PROB_FOR_BARGE_IN = 0.55;

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
  permissionDenied: boolean;
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
  const [permissionDenied, setPermissionDenied] = useState(false);
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
  // Tracks whether the in-flight speech segment started while suppressed
  // (TTS was playing). Read at speech-end to apply the barge-in duration
  // gate: short segments are treated as echo/throat-clears and dropped,
  // long ones cancel TTS and feed the transcript.
  const segmentSuppressedRef = useRef(false);
  // Running stats for the in-flight segment: count of frames and sum of
  // speech probability. Used at speech-end with segmentSuppressedRef to
  // gate barge-in by average confidence (a single high spike isn't enough).
  const segmentFrameCountRef = useRef(0);
  const segmentProbSumRef = useRef(0);

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
    // When a tap is installed mid-segment (typical for enrollment: user opens
    // the panel and clicks Start while Claude's greeting echo has already
    // tripped VAD with suppressedRef=true → segmentSuppressedRef=true), clear
    // the stale suppression flag so the in-flight segment's eventual
    // onSpeechEnd routes the audio to the tap instead of dropping it.
    if (tapSegment) {
      segmentSuppressedRef.current = false;
    }
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
        // Ask the OS for microphone access via the native system dialog before
        // attempting getUserMedia. On macOS this shows the native permission
        // popup when status is 'not-determined'; returns false immediately if
        // the user previously denied (they must re-enable in System Settings).
        // On non-macOS the IPC handler returns true unconditionally.
        const granted = await window.vibeMeet.requestMicPermission();
        if (!granted) {
          setPermissionDenied(true);
          setLastError('Microphone permission denied — please enable in System Settings');
          setActive(false);
          return;
        }

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
            // Reset per-segment stats regardless of path.
            segmentFrameCountRef.current = 0;
            segmentProbSumRef.current = 0;
            // Remember whether TTS was playing at the moment speech began.
            // The decision to barge in (or drop as echo) is deferred to
            // speech-end so we can gate by duration + average confidence;
            // firing barge-in here would let a single VAD trip from AEC
            // residue cut Claude off mid-sentence.
            segmentSuppressedRef.current = suppressedRef.current && !tapping;
            setListening(true);
            if (!tapping && !segmentSuppressedRef.current) {
              // TTS isn't playing — fire barge-in immediately so the next
              // assistant utterance (if one starts mid-segment) gets cut off
              // without waiting for speech-end.
              onBargeInRef.current?.();
            }
          },
          onSpeechEnd: async (audio: Float32Array) => {
            setListening(false);

            // Enrollment tap takes precedence over everything else, including
            // the suppression flag. The flag may have been set by an
            // onSpeechStart that fired during TTS playback before the user
            // installed the tap (e.g. greeting echo trips VAD, then user opens
            // the panel and clicks Start mid-segment). If we honoured the flag
            // here, the user's enrollment audio would be silently dropped and
            // the panel would hang at "等待麦克风启动…". Route to the tap and
            // clear the flag so the next segment starts clean.
            const tap = tapSegmentRef.current;
            if (tap) {
              segmentSuppressedRef.current = false;
              try { tap(audio); } catch (e) { setLastError(String((e as Error)?.message ?? e)); }
              return;
            }

            if (segmentSuppressedRef.current) {
              segmentSuppressedRef.current = false;
              // Segment started during TTS playback. Apply the barge-in
              // gate: enough audio AND sustained high speech probability →
              // real interrupt; otherwise drop as echo/throat-clear/cough.
              const frames = segmentFrameCountRef.current;
              const avgProb = frames > 0 ? segmentProbSumRef.current / frames : 0;
              segmentFrameCountRef.current = 0;
              segmentProbSumRef.current = 0;
              const longEnough = audio.length >= MIN_SAMPLES_FOR_BARGE_IN;
              const confident = avgProb >= MIN_AVG_PROB_FOR_BARGE_IN;
              console.info('[barge-in] suppressed-segment decision', {
                durationSec: +(audio.length / 16000).toFixed(2),
                minSec: +(MIN_SAMPLES_FOR_BARGE_IN / 16000).toFixed(2),
                avgProb: +avgProb.toFixed(2),
                minAvgProb: MIN_AVG_PROB_FOR_BARGE_IN,
                decision: longEnough && confident ? 'INTERRUPT' : 'DROP',
              });
              if (!longEnough || !confident) {
                return;
              }
              // Real interrupt: cut Claude off now so playback stops before
              // the transcript even finishes. The transcript still flows
              // through the normal voice-lock + send pipeline below.
              onBargeInRef.current?.();
            } else {
              // Reset stats for the next segment.
              segmentFrameCountRef.current = 0;
              segmentProbSumRef.current = 0;
            }

            // Voice-lock gate: drop segments that don't match the enrolled
            // speaker. Skip the gate on very short clips — embeddings on
            // <0.5s of audio are too noisy to act on, and forcing the user to
            // re-say "yes"/"ok" hurts UX more than letting a stray short
            // utterance through.
            const lockOn = voiceLockEnabledRef.current;
            const enrolled = voicePrintEmbeddingRef.current;
            const durationSec = audio.length / 16000;
            if (!lockOn) {
              console.info('[voice-lock] gate=off, passing segment', {
                hasEmbedding: !!enrolled,
                durationSec: +durationSec.toFixed(2),
              });
            } else if (!enrolled) {
              console.info('[voice-lock] gate=on but no enrolled voiceprint, passing');
            } else if (audio.length < MIN_SAMPLES_FOR_GATE) {
              console.info('[voice-lock] segment too short for gate, passing', {
                durationSec: +durationSec.toFixed(2),
                minSec: MIN_SAMPLES_FOR_GATE / 16000,
              });
            } else {
              try {
                const emb = await embedSpeaker(audio);
                if (emb) {
                  const sim = cosineSimilarity(emb, enrolled);
                  const pass = sim >= VOICE_LOCK_THRESHOLD;
                  console.info('[voice-lock] check', {
                    sim: +sim.toFixed(3),
                    threshold: VOICE_LOCK_THRESHOLD,
                    durationSec: +durationSec.toFixed(2),
                    decision: pass ? 'PASS' : 'REJECT',
                    embDim: emb.length,
                    enrolledDim: enrolled.length,
                  });
                  if (!pass) {
                    onVoiceLockRejectRef.current?.();
                    return;
                  }
                } else {
                  console.warn('[voice-lock] embedSpeaker returned null (segment likely too short post-fbank), passing through');
                }
              } catch (e) {
                // Embedding failed — historically we let the segment through so
                // a flaky model load wouldn't silently swallow legitimate
                // speech. But that also masks a misconfigured gate (the user
                // thinks they're protected when they aren't), so log loudly.
                console.error('[voice-lock] embedding failed, passing through — gate is NOT enforcing:', e);
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
            segmentFrameCountRef.current = 0;
            segmentProbSumRef.current = 0;
            setListening(false);
          },
          onFrameProcessed: (probs) => {
            // Cheap UI signal: smoothed speech probability for the mic meter.
            setSpeechLevel((prev) => prev * 0.6 + probs.isSpeech * 0.4);
            // Accumulate per-segment stats used by the barge-in gate at
            // speech-end. The library calls this for every frame, including
            // silence between segments; the running totals are reset in
            // onSpeechStart so only the in-flight segment's frames count.
            segmentFrameCountRef.current += 1;
            segmentProbSumRef.current += probs.isSpeech;
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
        // B18: detect permission denial so the UI can show a targeted guide
        // instead of a generic error string.
        const isPerm = e instanceof DOMException && (
          e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
        );
        setPermissionDenied(isPerm);
        setLastError(isPerm ? 'Microphone permission denied — please enable in System Settings' : `Mic init failed: ${msg}`);
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

  return { active, listening, lastError, permissionDenied, speechLevel, asrAvailable };
}
