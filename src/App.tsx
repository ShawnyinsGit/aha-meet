import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClaude } from './hooks/useClaude';
import { useWorkers } from './hooks/useWorkers';
import { useTabs } from './hooks/useTabs';
import { useScreenShare } from './hooks/useScreenShare';
import { useBrowser } from './hooks/useBrowser';
import { useStageWindows } from './hooks/useStageWindows';
import { useElapsedSeconds } from './hooks/useTimer';
import { cancelSpeech, isSpeechActive } from './hooks/useSpeech';
import { useAsr } from './hooks/useAsr';
import { useVoiceLock } from './hooks/useVoiceLock';
import { useVoicePreferences } from './hooks/useVoicePreferences';
import { useSpacebarMute } from './hooks/useSpacebarMute';
import { useTtsWiring } from './hooks/useTtsWiring';
import { useDragAndDrop } from './hooks/useDragAndDrop';
import { meetingStore } from './lib/meeting-store';
import { Lobby } from './components/Lobby';
import { TabStrip } from './components/TabStrip';
import { MeetingHeader } from './components/MeetingHeader';
import { ScreenStage } from './components/ScreenStage';
import { SourcePicker } from './components/SourcePicker';
import { BottomToolbar } from './components/BottomToolbar';
import { SideDrawer } from './components/SideDrawer';
import { SettingsMenu } from './components/SettingsMenu';
import { VoiceGuideModal } from './components/VoiceGuideModal';
import { ParticipantPanel } from './components/ParticipantPanel';
import type { AutoApproveScope, DesktopSource } from './types';

export function App() {
  const { state, restartSession, sendText, sendImage, sendAttachments, publishDroppedFiles, onDroppedFiles, resolvePermission, interrupt, setSpeakCallback } = useClaude();
  const workers = useWorkers();
  const tabs = useTabs();
  const { state: share, start: startShare, startSystemPicker, stop: stopShare, captureFrame, videoRef } = useScreenShare();
  const browser = useBrowser();
  const stageWindows = useStageWindows();

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
  const [viewingFile, setViewingFile] = useState<{ relativePath: string } | null>(null);
  const elapsed = useElapsedSeconds(activeOpenedAt);

  const speakingRef = useRef(false);
  const sendWithModeRef = useRef<(text: string) => void>(sendText);

  const voiceLock = useVoiceLock({ muted, setMuted, setAiSpeaking, speakingRef });
  const voicePrefs = useVoicePreferences();
  useSpacebarMute(muted, setMuted);
  useTtsWiring({ ttsOn, speakingRef, setAiSpeaking, setSpeakCallback });
  const dragDrop = useDragAndDrop({
    publishDroppedFiles,
    onFilesDropped: () => setDrawerOpen(true),
  });

  // aiSpeaking safety-net: clears stuck state when TTS controller drains
  useEffect(() => {
    if (!aiSpeaking) return;
    const id = window.setInterval(() => {
      if (speakingRef.current && !isSpeechActive()) {
        speakingRef.current = false;
        setAiSpeaking(false);
      }
    }, 300);
    return () => window.clearInterval(id);
  }, [aiSpeaking]);

  useEffect(() => {
    meetingStore.hydrateRestore().catch((err) => {
      console.error('[App] hydrateRestore failed:', err);
    });
  }, []);

  const micEnabled = hasLiveTab || voiceLock.enrollmentActive;

  const onVoiceFinal = useCallback(async (text: string) => {
    const id = meetingStore.getActiveId();
    if (!id) {
      console.warn('[voice] dropped — no active session');
      return;
    }
    let finalText = text;
    if (voicePrefs.voicePolishEnabled) {
      try {
        const result = await window.vibeMeet.polishAsrText(text);
        if (result.ok) finalText = result.text;
      } catch (err) {
        console.warn('[voice] polishAsrText IPC failed:', err);
      }
    }
    sendWithModeRef.current(finalText);
  }, [voicePrefs.voicePolishEnabled]);

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
    paused: muted,
    suppressed: aiSpeaking,
    voiceLockEnabled: voiceLock.voiceLockEnabled,
    voicePrintEmbedding: voiceLock.voicePrintEmbedding,
    onVoiceLockReject: voiceLock.handleVoiceLockReject,
    tapSegment: voiceLock.enrollmentActive ? voiceLock.handleEnrollmentSegment : undefined,
    muted,
  });

  useEffect(() => {
    meetingStore.setAutoApproveScope(autoApproveScope);
    void (async () => {
      const res = await window.vibeMeet.setAutoApprove(autoApproveScope);
      if (!res.ok || !state.running) return;
      const id = meetingStore.getActiveId();
      void window.vibeMeet.setPermissionMode(
        id,
        autoApproveScope !== 'off' ? 'bypassPermissions' : 'default',
      );
    })();
  }, [autoApproveScope, state.running]);

  useEffect(() => {
    if (autoApproveScope !== 'off' && state.pendingPermission) {
      void resolvePermission(state.pendingPermission.id, 'allow');
    }
  }, [autoApproveScope, state.pendingPermission, resolvePermission]);

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

  const toggleShare = useCallback(async () => {
    if (share.active) {
      stopShare();
      return;
    }
    try {
      const useSystem = await window.vibeMeet.useSystemPicker();
      if (useSystem) {
        await startSystemPicker();
      } else {
        setPickerOpen(true);
      }
    } catch {
      setPickerOpen(true);
    }
  }, [share.active, stopShare, startSystemPicker]);

  const handleSnapshot = useCallback(async () => {
    const dataUrl = captureFrame();
    if (!dataUrl) return;
    const caption = `Here is the current view of "${share.sourceName ?? 'my screen'}". Take a look and let me know what you see.`;
    await sendImage(dataUrl, caption);
  }, [captureFrame, sendImage, share.sourceName]);

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

  sendWithModeRef.current = sendWithMode;

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

  if (!hasTabs) {
    return <Lobby lastError={state.lastError} />;
  }

  return (
    <div
      className={`mtg${dragDrop.dropActive ? ' mtg-dropping' : ''}`}
      onDragEnter={dragDrop.onDragEnter}
      onDragOver={dragDrop.onDragOver}
      onDragLeave={dragDrop.onDragLeave}
      onDrop={dragDrop.onDrop}
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
          <SettingsMenu badge={voiceLock.enrollmentActive} />
        }
      />

      <main className="mtg-main">
        <section className="stage-wrap">
          <ScreenStage
            share={share}
            videoRef={videoRef}
            onPickSource={() => setPickerOpen(true)}
            onStopShare={stopShare}
            workers={workers.workerList}
            plan={workers.plan}
            running={state.running}
            aiSpeaking={aiSpeaking}
            galleryContent={
              <ParticipantPanel
                workers={workers.workerList}
                hostGroups={workers.hostGroups}
                running={state.running}
                aiSpeaking={aiSpeaking}
                onAddHost={workers.addHostGroup}
                selfTile={
                  <>
                    <div className={`self-avatar ${effectiveListening && !muted ? 'speaking' : ''}`}>
                      Y
                    </div>
                    <span className="host-label">You</span>
                    {muted && <span className="self-muted-chip">Muted</span>}
                  </>
                }
              />
            }
            delivery={workers.currentDelivery}
            sessionId={activeTab?.id ?? null}
            onAcceptDelivery={() => { setViewingFile(null); workers.acceptDelivery(); }}
            onReviseDelivery={(fb: string) => { setViewingFile(null); return workers.reviseDelivery(fb); }}
            viewingFile={viewingFile}
            onCloseFileView={() => setViewingFile(null)}
            stageWindows={stageWindows.windows}
            activeWindowId={stageWindows.activeWindowId}
            onSelectWindow={stageWindows.setActiveWindow}
            onCloseWindow={stageWindows.closeWindow}
            onCreateWindow={stageWindows.createWindow}
            onResolvePermission={resolvePermission}
            browserTabs={browser.state.tabs}
            browserActiveTabId={browser.state.activeTabId}
            browserViewportRef={browser.viewportRef}
            onBrowserOpenTab={() => browser.openTab()}
            onBrowserCloseTab={browser.closeTab}
            onBrowserSetActive={browser.setActiveTab}
            onBrowserNavigate={browser.navigate}
            onBrowserBack={browser.goBack}
            onBrowserForward={browser.goForward}
            onBrowserReload={browser.reload}
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
          sessionId={activeTab?.id ?? null}
          onViewFile={(path) => {
            setViewingFile({ relativePath: path });
            stageWindows.openFile(path);
          }}
          viewingFilePath={viewingFile?.relativePath ?? null}
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
        open={voicePrefs.guideOpen}
        onClose={voicePrefs.handleGuideClose}
        onDismissForever={voicePrefs.handleDismissForever}
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
