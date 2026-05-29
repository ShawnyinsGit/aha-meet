import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClaude } from './hooks/useClaude';
import { useWorkers } from './hooks/useWorkers';
import { useTabs } from './hooks/useTabs';
import { useScreenShare } from './hooks/useScreenShare';
import { useElapsedSeconds } from './hooks/useTimer';
import { cancelSpeech, enqueueConversational, isSpeechActive, markTurnComplete, setSelectedVoiceName, setSpeechFilterMode, speakConversational, useVoices, warmupTTS } from './hooks/useSpeech';
import type { SpeakHandle } from './hooks/useSpeech';
import type { SpeechFilterMode } from './lib/speech-format';
import { useAsr } from './hooks/useAsr';
import { meetingStore } from './lib/meeting-store';
import { Lobby } from './components/Lobby';
import { TabStrip } from './components/TabStrip';
import { MeetingHeader } from './components/MeetingHeader';
import { ParticipantTile } from './components/ParticipantTile';
import { ScreenStage } from './components/ScreenStage';
import { SourcePicker } from './components/SourcePicker';
import { BottomToolbar } from './components/BottomToolbar';
import { SideDrawer } from './components/SideDrawer';
import { SettingsMenu } from './components/SettingsMenu';
import { VoiceLockPanel, type EnrollmentToast } from './components/VoiceLockPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { VoiceSelector } from './components/VoiceSelector';
import { VoiceGuideModal } from './components/VoiceGuideModal';
import { ParticipantPanel } from './components/ParticipantPanel';
import { hasPremiumChineseVoice, listChineseVoices } from './lib/voice-quality';
import {
  averageEmbeddings,
  embedSpeaker,
  prewarmSpeakerModel,
  SPEAKER_MODEL_ID,
} from './lib/speaker-embedding';
import type { AutoApproveScope, DesktopSource, VoicePrint } from './types';

// Target seconds of clean speech (not wall time) to collect for enrollment.
// 6-8s of speech consistently produces a stable embedding for CAM++ in
// quiet rooms; raise this if real-world false-rejects show up.
const ENROLLMENT_TARGET_SECONDS = 8;
const SAMPLE_RATE = 16000;
// Minimum usable speech (in samples) to finalize an enrollment when the user
// hits "stop" before the target. Below this we treat stop as a true cancel.
const ENROLLMENT_MIN_FINALIZE_SAMPLES = SAMPLE_RATE * 2;

interface EnrollmentState {
  embeddings: Float32Array[];
  capturedSamples: number;
}

export function App() {
  const { state, restartSession, sendText, sendImage, sendAttachments, publishDroppedFiles, onDroppedFiles, resolvePermission, interrupt, setSpeakCallback } = useClaude();
  const workers = useWorkers();
  const tabs = useTabs();
  const { state: share, start: startShare, stop: stopShare, captureFrame, videoRef } = useScreenShare();

  // Derived UI predicates:
  //   hasTabs       — any open tab (live or placeholder); drives Lobby vs Shell branch
  //   hasLiveTab    — an active tab with a running Orchestrator; gates mic/send
  //   activeOpenedAt — the active tab's openedAt, used for the elapsed timer.
  //                    Switches as the user flips tabs so the timer reflects the
  //                    currently-focused meeting, not a stale single-session start.
  const activeTab = useMemo(() => tabs.find((t) => t.isActive) ?? null, [tabs]);
  const hasTabs = tabs.length > 0;
  const hasLiveTab = !!(activeTab && !activeTab.placeholder);
  const activeOpenedAt = activeTab?.openedAt ?? null;

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [ttsOn, setTtsOn] = useState(true);
  const [muted, setMuted] = useState(false);
  const [autoApproveScope, setAutoApproveScope] = useState<AutoApproveScope>('off');
  const [multiAgent, setMultiAgent] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const elapsed = useElapsedSeconds(activeOpenedAt);

  // Voice lock state. `voicePrint` is the full persisted struct (for UI:
  // enrolledAt timestamp, model id), while `voicePrintEmbedding` is the
  // Float32 form the gate actually compares against. We keep them in sync.
  const [voiceLockEnabled, setVoiceLockEnabled] = useState(false);
  const [voicePrint, setVoicePrint] = useState<VoicePrint | null>(null);
  const [voicePrintEmbedding, setVoicePrintEmbedding] = useState<Float32Array | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [recentlyRejected, setRecentlyRejected] = useState(false);
  const rejectTimerRef = useRef<number | null>(null);
  // Transient feedback after an enrollment run ends. Auto-clears so the
  // panel doesn't get stuck wearing yesterday's status.
  const [enrollmentToast, setEnrollmentToast] = useState<EnrollmentToast>(null);
  const enrollmentToastTimerRef = useRef<number | null>(null);

  // TTS voice picker state. selectedVoiceName mirrors what's persisted in
  // settings.json and is also pushed into useSpeech's module-level override
  // via setSelectedVoiceName() so speakConversational picks it up without
  // prop drilling. guidanceDismissed is the user's "don't show again" flag.
  const [selectedVoiceName, setSelectedVoiceNameState] = useState<string | null>(null);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // Session-level flag: user clicked "Maybe later" — don't re-open this session
  // even if voiceschanged fires again (e.g. a voice download completes).
  const [guidanceClosedThisSession, setGuidanceClosedThisSession] = useState(false);
  const [filterMode, setFilterModeState] = useState<SpeechFilterMode>('strict');

  // Whether to surface subagents in the participant panel. Independent of the
  // multi-agent send mode toggle in the header.
  const showSubagents = true;

  const { voices, ready: voicesReady } = useVoices();
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  const speakingRef = useRef(false);

  // Cold start: pull the persisted tab layout + recent cwds from main and
  // hydrate the store. Placeholders for previously-open tabs land in the tab
  // strip; clicking one resumes its Orchestrator. Cheap (just metadata).
  useEffect(() => {
    void meetingStore.hydrateRestore();
  }, []);

  // Hydrate voice-lock state from disk on mount. We only restore the
  // embedding ref if the saved model id matches what we currently bundle —
  // otherwise the gate would be comparing apples to oranges and we want the
  // panel to show "re-enrollment required" instead. Prewarm the ONNX model
  // in the background so the first enrollment segment isn't paying for the
  // model load.
  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getVoiceConfig().then(({ enabled, voicePrint: vp }) => {
      if (cancelled) return;
      setVoiceLockEnabled(enabled);
      if (vp) {
        setVoicePrint(vp);
        if (vp.model === SPEAKER_MODEL_ID) {
          setVoicePrintEmbedding(new Float32Array(vp.embedding));
        }
      }
    }).catch(() => { /* settings file may not exist yet */ });
    void prewarmSpeakerModel().catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Clear the "ignored other voice" toast timer on unmount so the late
  // setState doesn't fire against a dead component.
  useEffect(() => () => {
    if (rejectTimerRef.current != null) window.clearTimeout(rejectTimerRef.current);
    if (enrollmentToastTimerRef.current != null) window.clearTimeout(enrollmentToastTimerRef.current);
  }, []);

  // Show a transient enrollment-result toast in the voice-lock panel.
  // 3.5s window is long enough to read but short enough not to linger after
  // the user moves on. Re-firing resets the clock, so back-to-back attempts
  // don't compound.
  const showEnrollmentToast = useCallback((kind: Exclude<EnrollmentToast, null>) => {
    setEnrollmentToast(kind);
    if (enrollmentToastTimerRef.current != null) window.clearTimeout(enrollmentToastTimerRef.current);
    enrollmentToastTimerRef.current = window.setTimeout(() => {
      setEnrollmentToast(null);
      enrollmentToastTimerRef.current = null;
    }, 3500);
  }, []);

  // Load TTS voice preference once on mount and push the selected name into
  // useSpeech's module-level override so the very first utterance honours it.
  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getVoicePref().then((pref) => {
      if (cancelled) return;
      setSelectedVoiceNameState(pref.selectedVoiceName);
      setGuidanceDismissed(pref.guidanceDismissed);
      setFilterModeState(pref.speechFilterMode);
      setSelectedVoiceName(pref.selectedVoiceName);
      setSpeechFilterMode(pref.speechFilterMode);
    }).catch(() => { /* settings file may not exist yet */ });
    return () => { cancelled = true; };
  }, []);

  // Warm the macOS Electron speech-synthesis engine as soon as voices are
  // available. The first real speak() otherwise pays an 80–300ms cold-start
  // tax (engine spin-up) on top of the model latency, which lands right when
  // the user is waiting for the AI's first reply. Pushing a zero-volume
  // utterance during idle UI time amortizes that cost.
  useEffect(() => {
    if (!voicesReady) return;
    warmupTTS();
  }, [voicesReady]);

  // One-shot guide trigger: only on macOS, only once voices have populated,
  // only when no premium Chinese voice is detected and the user hasn't
  // permanently dismissed. Auto-closes if a premium voice appears later
  // (e.g. user finished downloading mid-session) — listChineseVoices is
  // re-checked every time the voiceschanged event fires.
  useEffect(() => {
    if (!isMac || !voicesReady) return;
    const chineseAny = listChineseVoices(voices).length > 0;
    const hasPremium = hasPremiumChineseVoice(voices);
    if (hasPremium) {
      setGuideOpen(false);
      return;
    }
    if (!guidanceDismissed && chineseAny) {
      setGuideOpen(true);
    }
  }, [isMac, voicesReady, voices, guidanceDismissed]);

  const handleVoiceChange = useCallback((name: string | null) => {
    setSelectedVoiceNameState(name);
    setSelectedVoiceName(name);
    void window.vibeMeet.setVoicePref({ selectedVoiceName: name });
  }, []);

  const handleFilterModeChange = useCallback((mode: SpeechFilterMode) => {
    setFilterModeState(mode);
    setSpeechFilterMode(mode);
    void window.vibeMeet.setVoicePref({ speechFilterMode: mode });
  }, []);

  const handleOpenGuide = useCallback(() => setGuideOpen(true), []);
  const handleGuideClose = useCallback(() => {
    setGuideOpen(false);
    setGuidanceClosedThisSession(true);
  }, []);
  const handleDismissForever = useCallback(() => {
    setGuidanceDismissed(true);
    setGuidanceClosedThisSession(true);
    setGuideOpen(false);
    void window.vibeMeet.setVoicePref({ guidanceDismissed: true });
  }, []);

  const handleVoiceLockReject = useCallback(() => {
    setRecentlyRejected(true);
    if (rejectTimerRef.current != null) window.clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = window.setTimeout(() => {
      setRecentlyRejected(false);
      rejectTimerRef.current = null;
    }, 2500);
  }, []);

  // Enrollment tap. Each clean VAD segment ≥0.5s gets embedded and pushed
  // into the running buffer. When we hit the target seconds we average the
  // embeddings, persist, and flip the gate on — the user just trained it,
  // they almost certainly want it active.
  const handleEnrollmentSegment = useCallback((samples: Float32Array) => {
    if (samples.length < 8000) return;
    void (async () => {
      try {
        const emb = await embedSpeaker(samples);
        if (!emb) return;
        setEnrollment((prev) => {
          if (!prev) return prev;
          const embeddings = [...prev.embeddings, emb];
          const capturedSamples = prev.capturedSamples + samples.length;
          const targetSamples = ENROLLMENT_TARGET_SECONDS * SAMPLE_RATE;
          if (capturedSamples < targetSamples) {
            return { embeddings, capturedSamples };
          }
          const mean = averageEmbeddings(embeddings);
          if (mean) {
            const vp: VoicePrint = {
              embedding: Array.from(mean),
              model: SPEAKER_MODEL_ID,
              secondsCaptured: capturedSamples / SAMPLE_RATE,
              enrolledAt: Date.now(),
            };
            setVoicePrint(vp);
            setVoicePrintEmbedding(mean);
            setVoiceLockEnabled(true);
            void window.vibeMeet.setVoicePrint(vp);
            void window.vibeMeet.setVoiceLockEnabled(true);
            showEnrollmentToast('saved');
          } else {
            // averageEmbeddings only returns null on degenerate input (all
            // zero-norm vectors) — surface it instead of silently bailing.
            showEnrollmentToast('tooShort');
          }
          // Enrollment completed — restore prior mute state outside this updater.
          setTimeout(() => {
            if (prevMutedRef.current !== null) {
              const restore = prevMutedRef.current;
              prevMutedRef.current = null;
              if (restore) setMuted(true);
            }
          }, 0);
          return null;
        });
      } catch (e) {
        console.warn('[voice-lock] enrollment embedding failed:', e);
      }
    })();
  }, [showEnrollmentToast]);

  const handleToggleVoiceLock = useCallback(() => {
    setVoiceLockEnabled((prev) => {
      const next = !prev;
      void window.vibeMeet.setVoiceLockEnabled(next);
      return next;
    });
  }, []);

  // Remember mute state at enrollment start so we can restore it after.
  // Enrollment needs the mic on; if the user was muted we silently unmute
  // for the duration, then put them back where they were.
  const prevMutedRef = useRef<boolean | null>(null);

  const handleStartEnrollment = useCallback(() => {
    // Cut Claude off if he's mid-greeting — otherwise his TTS bleeds into
    // the user's own speakers and contaminates the enrollment sample.
    // cancelSpeech() (silent=false) now fires onAllDone synchronously, which
    // resets aiSpeaking via the speakConversational closure. The explicit
    // reset below is belt-and-braces in case the active session's onAllDone
    // isn't wired (e.g. setSpeakCallback was just nulled) — cheap insurance
    // so suppressed=false propagates to useAsr before the next VAD segment.
    cancelSpeech();
    speakingRef.current = false;
    setAiSpeaking(false);
    if (prevMutedRef.current === null) {
      prevMutedRef.current = muted;
    }
    if (muted) setMuted(false);
    // Clear any stale toast from a previous run so the panel header is clean
    // when the user starts fresh.
    setEnrollmentToast(null);
    if (enrollmentToastTimerRef.current != null) {
      window.clearTimeout(enrollmentToastTimerRef.current);
      enrollmentToastTimerRef.current = null;
    }
    setEnrollment({ embeddings: [], capturedSamples: 0 });
  }, [muted]);

  // "Stop" semantically means "I'm done speaking" — not "throw it away".
  // If we collected enough clean speech to form a stable embedding, finalize
  // it now (same logic as the auto-finalize path in handleEnrollmentSegment).
  // Only fall back to a true cancel when there's effectively no usable audio.
  // Without this, users who stop before the 8s target wall got no voiceprint
  // saved, which in turn left the gate toggle disabled forever.
  const handleCancelEnrollment = useCallback(() => {
    setEnrollment((prev) => {
      // Three outcomes worth distinguishing in the UI:
      //   saved     — enough clean speech to finalize a voice print
      //   tooShort  — some samples but below the 2s minimum (user spoke briefly)
      //   cancelled — no usable samples at all (user never spoke)
      if (prev && prev.embeddings.length > 0 && prev.capturedSamples >= ENROLLMENT_MIN_FINALIZE_SAMPLES) {
        const mean = averageEmbeddings(prev.embeddings);
        if (mean) {
          const vp: VoicePrint = {
            embedding: Array.from(mean),
            model: SPEAKER_MODEL_ID,
            secondsCaptured: prev.capturedSamples / SAMPLE_RATE,
            enrolledAt: Date.now(),
          };
          setVoicePrint(vp);
          setVoicePrintEmbedding(mean);
          setVoiceLockEnabled(true);
          void window.vibeMeet.setVoicePrint(vp);
          void window.vibeMeet.setVoiceLockEnabled(true);
          showEnrollmentToast('saved');
        } else {
          showEnrollmentToast('tooShort');
        }
      } else if (prev && prev.embeddings.length > 0) {
        showEnrollmentToast('tooShort');
      } else {
        showEnrollmentToast('cancelled');
      }
      return null;
    });
    if (prevMutedRef.current !== null) {
      const restore = prevMutedRef.current;
      prevMutedRef.current = null;
      if (restore) setMuted(true);
    }
  }, [showEnrollmentToast]);

  const handleClearEnrollment = useCallback(() => {
    setVoicePrint(null);
    setVoicePrintEmbedding(null);
    setVoiceLockEnabled(false);
    void window.vibeMeet.setVoicePrint(null);
    void window.vibeMeet.setVoiceLockEnabled(false);
  }, []);

  // Mic follows the active tab (per user's design choice B). Background tabs
  // never capture audio — their transcript fills from text the Talker emits.
  // Voice-print enrollment runs from the settings panel even with no tab open,
  // so we keep the mic on whenever an enrollment is in flight.
  const micEnabled = (!muted && hasLiveTab) || enrollment != null;

  const onVoiceFinal = useCallback((text: string) => {
    // Read the active id fresh inside the callback. Closing over hasLiveTab at
    // render time races with rapid tab close: if the user speaks the instant
    // a tab tears down, the captured value can be stale and either drop a
    // legitimate utterance or route it through after the slot is gone.
    const id = meetingStore.getActiveId();
    if (!id) {
      console.warn('[voice] dropped — no active session');
      return;
    }
    sendText(text);
  }, [sendText]);

  // Barge-in: any time the VAD says we've started speaking, cut Claude off.
  // markBargeIn() tags the active streaming turn so subsequent stream events
  // and the eventual full-message terminal don't re-arm the speech queue.
  const onBargeIn = useCallback(() => {
    if (speakingRef.current) {
      cancelSpeech();
      meetingStore.markBargeIn();
      speakingRef.current = false;
      setAiSpeaking(false);
    }
  }, []);

  const {
    mode: asrMode,
    listening: effectiveListening,
    supported: micSupported,
    speechLevel,
    lastError: micError,
  } = useAsr({
    enabled: micEnabled,
    onTranscript: onVoiceFinal,
    onBargeIn,
    // Suppress mic input while TTS is playing so the speaker→mic loop doesn't
    // get transcribed as if the user said it (and doesn't fire barge-in on
    // Claude's own voice).
    suppressed: aiSpeaking,
    voiceLockEnabled,
    voicePrintEmbedding,
    onVoiceLockReject: handleVoiceLockReject,
    // Divert raw segments to the enrollment collector instead of
    // transcribing them — only active while the user is recording a sample.
    tapSegment: enrollment ? handleEnrollmentSegment : undefined,
    // While muted the whisper VAD is torn down. Keep the mic button
    // clickable so the user can unmute — otherwise the toggle is one-way.
    muted,
  });

  // Wire TTS to assistant messages, with a "speaking" flag so we mute the mic.
  // The SpeakHandle is a single sink with three modes:
  //   supersede(text)               — one-shot replace (used by full-message
  //                                   path, pending-tab replay, and synthetic
  //                                   talker narrations). aiSpeaking resets
  //                                   when its onDone fires.
  //   enqueue(chunk, turnId, opts)  — sentence-streaming append. The first
  //                                   sentence plays the moment it crosses a
  //                                   punctuation boundary so the user doesn't
  //                                   wait for the full reply.
  //   markTurnComplete(turnId)      — terminal flush; once the queue drains
  //                                   the session fires onAllDone and clears
  //                                   aiSpeaking.
  //
  // The onAllDone closure is registered on supersede() and on the first
  // enqueue() of a turn — whichever lands first owns the reset.
  useEffect(() => {
    if (!ttsOn) {
      setSpeakCallback(null);
      cancelSpeech();
      speakingRef.current = false;
      setAiSpeaking(false);
      return;
    }
    // Safety net: state thinks AI is mid-narration but the controller has
    // actually drained (cancel never fired onDone, watchdog missed, etc.).
    // Without this, the *next* call would see the same stuck flag and the
    // user-visible mic mute would persist indefinitely. Cheap belt-and-braces
    // — most calls hit the false branch immediately.
    const armSpeaking = () => {
      if (speakingRef.current && !isSpeechActive()) {
        speakingRef.current = false;
        setAiSpeaking(false);
      }
      speakingRef.current = true;
      setAiSpeaking(true);
    };
    const finishSpeaking = () => {
      speakingRef.current = false;
      setAiSpeaking(false);
    };
    const handle: SpeakHandle = {
      supersede: (text, onDone) => {
        armSpeaking();
        speakConversational(text, () => {
          finishSpeaking();
          onDone?.();
        });
      },
      enqueue: (text, turnId, opts, onDone) => {
        if (text.trim().length > 0) armSpeaking();
        enqueueConversational(text, turnId, opts, () => {
          finishSpeaking();
          onDone?.();
        });
      },
      markTurnComplete: (turnId) => {
        markTurnComplete(turnId);
      },
    };
    setSpeakCallback(handle);
    return () => {
      setSpeakCallback(null);
    };
  }, [setSpeakCallback, ttsOn]);

  // Push the trust-mode scope down to the main process. setAutoApprove flips
  // the canUseTool short-circuit (instant, even mid-session); setPermissionMode
  // mirrors it through the SDK's permission mode for belt-and-braces so any
  // path that bypasses canUseTool still won't block. Sent on every session
  // start so a new session inherits the scope.
  useEffect(() => {
    void window.vibeMeet.setAutoApprove(autoApproveScope);
    if (!state.running) return;
    // Apply to the currently-focused live session. Background tabs keep their
    // existing mode; toggling here is a per-meeting decision tied to the tab
    // the user is looking at.
    const id = meetingStore.getActiveId();
    void window.vibeMeet.setPermissionMode(
      id,
      autoApproveScope !== 'off' ? 'bypassPermissions' : 'default',
    );
  }, [autoApproveScope, state.running]);

  // If auto-approve is toggled on while a prompt is already showing, resolve
  // it immediately so the user isn't blocked by a stale modal.
  useEffect(() => {
    if (autoApproveScope !== 'off' && state.pendingPermission) {
      void resolvePermission(state.pendingPermission.id, 'allow');
    }
  }, [autoApproveScope, state.pendingPermission, resolvePermission]);

  // "Leave" in the multi-tab world means "close the focused meeting". closeTab
  // tears down the Orchestrator, removes the slot, switches focus to the next
  // tab if any (or back to the Lobby if this was the last one).
  const leave = useCallback(async () => {
    cancelSpeech();
    speakingRef.current = false;
    setAiSpeaking(false);
    stopShare();
    const id = meetingStore.getActiveId();
    if (id) await meetingStore.closeTab(id);
  }, [stopShare]);

  const handlePickSource = useCallback(async (src: DesktopSource) => {
    await startShare(src.id, src.name);
  }, [startShare]);

  const toggleShare = useCallback(() => {
    if (share.active) {
      stopShare();
    } else {
      setPickerOpen(true);
    }
  }, [share.active, stopShare]);

  const handleSnapshot = useCallback(async () => {
    const dataUrl = captureFrame();
    if (!dataUrl) return;
    const caption = `Here is the current view of "${share.sourceName ?? 'my screen'}". Take a look and let me know what you see.`;
    await sendImage(dataUrl, caption);
  }, [captureFrame, sendImage, share.sourceName]);

  // 多 Agent 并行: when the header toggle is on, every user message is wrapped
  // in a meta-instruction that nudges the Talker to call its plan_meeting MCP
  // tool, which evaluates dependencies, decomposes the request into a DAG of
  // workers, and spawns them in parallel via the orchestrator. Reuses the
  // existing infrastructure — no new IPC, no parallel LLM path.
  const sendWithMode = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!multiAgent) {
      await sendText(trimmed);
      return;
    }
    const directive = `请把下面这段需求当作"多 Agent 并行"模式处理：先评估各子任务之间的依赖关系，再拆成多个相互独立（或按依赖排序）的子任务，**立即调用 plan_meeting 工具**一次性派发给多个 worker 并行执行。
- 仔细判断哪些任务可以并行、哪些有依赖（用 deps 字段标注）。
- 每个 task 给一个稳定的 kebab-case id、一句话标题、给 worker 看的完整 prompt。
- 拆完直接调工具，不要先问我确认。

需求：
${trimmed}`;
    await sendText(directive);
  }, [multiAgent, sendText]);

  const sendAttachmentsWithMode = useCallback(
    async (staged: Parameters<typeof sendAttachments>[0], raw: string) => {
      const trimmed = raw.trim();
      if (!multiAgent) {
        return sendAttachments(staged, trimmed);
      }
      const directive = trimmed.length > 0
        ? `请把下面这段需求和附带文档一起当作"多 Agent 并行"模式处理：评估依赖，拆任务，**调用 plan_meeting 工具**派发多个 worker 并行执行。

需求：
${trimmed}`
        : '请阅读附带的文档，按"多 Agent 并行"模式拆解：评估依赖，调用 plan_meeting 派发 worker。';
      return sendAttachments(staged, directive);
    },
    [multiAgent, sendAttachments],
  );

  // Window-level drag-and-drop. We accept files anywhere on the meeting view
  // and republish them through the meeting store so the SideDrawer can pick
  // them up as staged chips — without App.tsx reaching into the drawer's
  // local state.
  const [dropActive, setDropActive] = useState(false);
  const dragCounterRef = useRef(0);
  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDropActive(true);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const onDragLeave = useCallback(() => {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDropActive(false);
  }, []);
  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setDropActive(false);
    publishDroppedFiles(Array.from(e.dataTransfer.files));
    // Auto-open the drawer so the user sees the chips land.
    setDrawerOpen(true);
  }, [publishDroppedFiles]);

  if (!hasTabs) {
    return <Lobby lastError={state.lastError} />;
  }

  return (
    <div
      className={`mtg${dropActive ? ' mtg-dropping' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TabStrip tabs={tabs} />
      <MeetingHeader
        cwd={state.cwd}
        elapsed={elapsed}
        autoApproveScope={autoApproveScope}
        onChangeAutoApproveScope={setAutoApproveScope}
        multiAgent={multiAgent}
        onToggleMultiAgent={() => setMultiAgent((v) => !v)}
        settingsSlot={
          <SettingsMenu badge={enrollment != null}>
            <MemoryPanel />
            <VoiceSelector
              voices={voices}
              selectedVoiceName={selectedVoiceName}
              onChange={handleVoiceChange}
              onOpenGuide={handleOpenGuide}
              filterMode={filterMode}
              onChangeFilterMode={handleFilterModeChange}
            />
            <VoiceLockPanel
              enabled={voiceLockEnabled}
              enrolledAt={voicePrint?.enrolledAt ?? null}
              modelMatches={voicePrint?.model === SPEAKER_MODEL_ID}
              enrollment={
                enrollment
                  ? {
                      targetSeconds: ENROLLMENT_TARGET_SECONDS,
                      capturedSeconds: enrollment.capturedSamples / SAMPLE_RATE,
                      segments: enrollment.embeddings.length,
                    }
                  : null
              }
              recentlyRejected={recentlyRejected}
              enrollmentToast={enrollmentToast}
              onToggleEnabled={handleToggleVoiceLock}
              onStartEnroll={handleStartEnrollment}
              onCancelEnroll={handleCancelEnrollment}
              onClearEnrollment={handleClearEnrollment}
            />
          </SettingsMenu>
        }
      />

      <main className="mtg-main">
        <section className="stage-wrap">
          <ScreenStage
            share={share}
            videoRef={videoRef}
            onPickSource={() => setPickerOpen(true)}
            onStopShare={stopShare}
            delivery={workers.currentDelivery}
            sessionId={activeTab?.id ?? null}
            onAcceptDelivery={workers.acceptDelivery}
            onReviseDelivery={workers.reviseDelivery}
            defaultContent={
              <ParticipantPanel
                workers={workers.workerList}
                plan={workers.plan}
                running={state.running}
                aiSpeaking={aiSpeaking}
                onResolvePermission={resolvePermission}
                selfTile={
                  <ParticipantTile
                    name="You"
                    role="You"
                    initials="You"
                    variant="self"
                    speaking={effectiveListening && !muted}
                    muted={muted}
                    status={muted ? 'Muted' : effectiveListening ? 'Speaking' : 'Mic idle'}
                    ariaLabel="查看我派出的任务"
                  />
                }
              />
            }
          />
        </section>

        <SideDrawer
          open={drawerOpen}
          transcript={state.transcript}
          activity={state.activity}
          pending={state.pendingPermission}
          onResolve={resolvePermission}
          onSend={sendWithMode}
          onSendAttachments={sendAttachmentsWithMode}
          onSubscribeDroppedFiles={onDroppedFiles}
          multiAgent={multiAgent}
          disabled={!state.running}
        />
      </main>

      <BottomToolbar
        muted={muted}
        onToggleMute={() => setMuted((v) => !v)}
        micSupported={micSupported}
        listening={effectiveListening}
        speechLevel={speechLevel}
        asrMode={asrMode}
        ttsOn={ttsOn}
        onToggleTts={() => setTtsOn((v) => !v)}
        sharing={share.active}
        onToggleShare={toggleShare}
        snapshotEnabled={share.active && state.running}
        onSnapshot={handleSnapshot}
        onInterrupt={interrupt}
        chatOpen={drawerOpen}
        onToggleChat={() => setDrawerOpen((v) => !v)}
        onLeave={leave}
      />

      <SourcePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickSource}
      />

      <VoiceGuideModal
        open={guideOpen}
        onClose={handleGuideClose}
        onDismissForever={handleDismissForever}
      />

      {(state.lastError || micError) && (
        <div className="error-banner">
          <span className="error-banner__text">{state.lastError ?? micError}</span>
          {state.lastError && !state.running && (
            <button
              type="button"
              className="error-banner__reconnect"
              onClick={() => { void restartSession(); }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
