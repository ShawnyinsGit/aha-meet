import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClaude } from './hooks/useClaude';
import { useWorkers } from './hooks/useWorkers';
import { useScreenShare } from './hooks/useScreenShare';
import { useElapsedSeconds } from './hooks/useTimer';
import { cancelSpeech, setSelectedVoiceName, setSpeechFilterMode, speakConversational, useVoices } from './hooks/useSpeech';
import type { SpeechFilterMode } from './lib/speech-format';
import { useAsr } from './hooks/useAsr';
import { JoinScreen } from './components/JoinScreen';
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
import type { DesktopSource, VoicePrint } from './types';

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

const GREETING = "You're joining a live screen-share meeting with your developer. Greet them in one or two sentences, ask what they want to work on today, and remind them they can share the current screen with the snapshot button when something needs your eyes. Keep it warm and short.";

export function App() {
  const { state, startSession, restartSession, sendText, sendImage, resolvePermission, interrupt, endSession, setSpeakCallback } = useClaude();
  const workers = useWorkers();
  const { state: share, start: startShare, stop: stopShare, captureFrame, videoRef } = useScreenShare();

  const [joined, setJoined] = useState(false);
  const [rememberedCwd, setRememberedCwd] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [ttsOn, setTtsOn] = useState(true);
  const [muted, setMuted] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [multiAgent, setMultiAgent] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const elapsed = useElapsedSeconds(startedAt);

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

  // Load the last-used cwd from disk once on mount so the JoinScreen can
  // pre-fill it. Main validates the path still exists before returning it,
  // so we never default to a stale directory.
  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getLastCwd().then((dir) => {
      if (!cancelled) setRememberedCwd(dir);
    }).catch(() => { /* ignore — JoinScreen will fall back to empty */ });
    return () => { cancelled = true; };
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
    cancelSpeech();
    // cancelSpeech() flips activeSession.cancelled but does NOT invoke the
    // speakConversational onAllDone callback that resets aiSpeaking — so
    // without this synchronous reset, `suppressed` stays true into the next
    // render and useVoiceCapture's suppressedRef keeps swallowing user audio
    // even though TTS playback is gone. Tear down the speaking flag locally
    // so the next render of useAsr propagates suppressed=false to the VAD
    // callbacks well before the user's first enrollment segment lands.
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

  // Keep mic always on once joined; barge-in handles overlap with Claude.
  // Voice-print enrollment needs the mic too, and runs from the settings panel
  // before the user has joined a meeting — keep the mic on whenever an
  // enrollment is in flight so the VAD can deliver segments to tapSegment.
  const micEnabled = (!muted && joined) || enrollment != null;

  const onVoiceFinal = useCallback((text: string) => {
    if (!joined) return;
    sendText(text);
  }, [joined, sendText]);

  // Barge-in: any time the VAD says we've started speaking, cut Claude off.
  const onBargeIn = useCallback(() => {
    if (speakingRef.current) {
      cancelSpeech();
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
  useEffect(() => {
    if (!ttsOn) {
      setSpeakCallback(null);
      cancelSpeech();
      speakingRef.current = false;
      setAiSpeaking(false);
      return;
    }
    setSpeakCallback((text: string) => {
      speakingRef.current = true;
      setAiSpeaking(true);
      speakConversational(text, () => {
        speakingRef.current = false;
        setAiSpeaking(false);
      });
    });
    return () => setSpeakCallback(null);
  }, [setSpeakCallback, ttsOn]);

  // Push the trust-mode flag down to the main process. Two channels working
  // together: setAutoApprove flips the canUseTool short-circuit (instant, even
  // mid-session); setPermissionMode mirrors it through the SDK's permission
  // mode for belt-and-braces so any path that bypasses canUseTool still won't
  // block. Sent on every session start so a new session inherits the toggle.
  useEffect(() => {
    void window.vibeMeet.setAutoApprove(autoApprove);
    if (!state.running) return;
    void window.vibeMeet.setPermissionMode(autoApprove ? 'bypassPermissions' : 'default');
  }, [autoApprove, state.running]);

  // If auto-approve is toggled on while a prompt is already showing, resolve
  // it immediately so the user isn't blocked by a stale modal.
  useEffect(() => {
    if (autoApprove && state.pendingPermission) {
      void resolvePermission(state.pendingPermission.id, 'allow');
    }
  }, [autoApprove, state.pendingPermission, resolvePermission]);

  const join = useCallback(async (cwd: string) => {
    setJoined(true);
    setStartedAt(Date.now());
    await startSession(cwd, GREETING);
  }, [startSession]);

  const leave = useCallback(async () => {
    cancelSpeech();
    // cancelSpeech() doesn't fire the active session's onAllDone, so reset
    // the speaking flag here too — otherwise a leave during TTS leaves
    // aiSpeaking=true and the next session re-joins with the mic suppressed.
    speakingRef.current = false;
    setAiSpeaking(false);
    stopShare();
    await endSession();
    setJoined(false);
    setStartedAt(null);
  }, [endSession, stopShare]);

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

  if (!joined) {
    return <JoinScreen onJoin={join} defaultCwd={state.cwd ?? rememberedCwd ?? undefined} lastError={state.lastError} />;
  }

  return (
    <div className="mtg">
      <MeetingHeader
        cwd={state.cwd}
        elapsed={elapsed}
        autoApprove={autoApprove}
        onToggleAutoApprove={() => setAutoApprove((v) => !v)}
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
