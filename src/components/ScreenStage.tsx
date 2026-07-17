import { ReactNode, RefObject, useState, useCallback, useMemo, cloneElement, isValidElement } from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot, HostGroupState, WorkerState } from '../lib/meeting-store';
import type { ActivityEntry, BrowserTabInfo, MeetingPlan } from '../types';
import type { StageWindow, StageWindowType } from '../lib/stage-window-store';
import { FileViewer } from './FileViewer';
import { BrowserStage } from './BrowserStage';
import { StageTabBar } from './StageTabBar';
import { TerminalPanel } from './TerminalPanel';
import { ActivityTabContent } from './ActivityTabContent';

interface ScreenStageProps {
  share: ScreenShareState;
  videoRef: RefObject<HTMLVideoElement>;
  onPickSource: () => void;
  onStopShare: () => void;
  workers: WorkerState[];
  hostGroups: Map<string, HostGroupState>;
  plan: MeetingPlan | null;
  running: boolean;
  aiSpeaking: boolean;
  galleryContent: ReactNode;
  delivery: DeliverySnapshot | null;
  sessionId: string | null;
  onAcceptDelivery: () => void;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  viewingFile?: { relativePath: string } | null;
  onCloseFileView?: () => void;
  stageWindows: StageWindow[];
  activeWindowId: string | null;
  onSelectWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onCreateWindow: (type: StageWindowType, opts?: { workerId?: string; title?: string }) => void;
  onPopOutWindow?: (id: string) => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
  browserTabs?: BrowserTabInfo[];
  browserActiveTabId?: string | null;
  browserViewportRef?: RefObject<HTMLDivElement>;
  onBrowserOpenTab?: () => void;
  onBrowserCloseTab?: (id: string) => void;
  onBrowserSetActive?: (id: string) => void;
  onBrowserNavigate?: (tabId: string, url: string) => void;
  onBrowserBack?: (tabId: string) => void;
  onBrowserForward?: (tabId: string) => void;
  onBrowserReload?: (tabId: string) => void;
  /** Map of iconId → custom avatar data URL */
  customAvatars?: Map<string, string | null>;
}

const ACTIVITY_TAB_ID = 'activity-default';

export function ScreenStage({
  share,
  videoRef,
  onPickSource: _onPickSource,
  onStopShare,
  workers,
  hostGroups,
  plan,
  running,
  aiSpeaking = false,
  galleryContent,
  delivery,
  sessionId,
  onAcceptDelivery,
  onReviseDelivery,
  viewingFile,
  onCloseFileView,
  stageWindows,
  activeWindowId,
  onSelectWindow,
  onCloseWindow,
  onCreateWindow,
  onPopOutWindow,
  onResolvePermission,
  browserTabs = [],
  browserActiveTabId = null,
  browserViewportRef,
  onBrowserOpenTab,
  onBrowserCloseTab,
  onBrowserSetActive,
  onBrowserNavigate,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  customAvatars,
}: ScreenStageProps) {
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);

  const handleSelectParticipant = useCallback((id: string) => {
    setSelectedParticipantId(id);
    // Auto-switch to activity tab so the selection is visible
    if (activeWindowId !== ACTIVITY_TAB_ID) {
      onSelectWindow(ACTIVITY_TAB_ID);
    }
  }, [activeWindowId, onSelectWindow]);

  const activeWindow = stageWindows.find((w) => w.id === activeWindowId) ?? null;
  const isActivityTab = activeWindow?.type === 'activity' || activeWindowId === ACTIVITY_TAB_ID;

  // For terminal stage windows, find the worker whose activity should be
  // displayed. When no workerId is specified, aggregate all workers' Bash
  // activity so the terminal tab shows real command output instead of being
  // empty (talkers have `tools: []` and never produce Bash activity).
  const terminalActivity = useMemo(() => {
    if (activeWindow?.type !== 'terminal') return [];
    if (activeWindow.workerId) {
      // Match by worker id OR by hostId (gallery passes hostId when opening terminal)
      const target = workers.find(
        (w) => w.id === activeWindow.workerId || w.hostId === activeWindow.workerId,
      );
      return target?.activity ?? [];
    }
    // Aggregate all workers' Bash-related activity chronologically
    const bashEntries: ActivityEntry[] = [];
    for (const w of workers) {
      for (const a of w.activity) {
        if (a.title?.toLowerCase().includes('bash') || a.kind === 'tool-call' || a.kind === 'tool-result') {
          bashEntries.push(a);
        }
      }
    }
    bashEntries.sort((a, b) => a.ts - b.ts);
    return bashEntries;
  }, [activeWindow, workers]);

  const stageClass = share.active
    ? 'stage-sharing'
    : isActivityTab
      ? 'stage-default'
      : activeWindow?.type === 'browser'
        ? 'stage-browser'
        : activeWindow?.type === 'file'
          ? 'stage-file'
          : 'stage-default';

  return (
    <div className={`stage ${stageClass}`}>
      {share.active && (
        <>
          <video
            ref={videoRef}
            className="stage-video"
            autoPlay
            playsInline
            muted
          />
          <div className="stage-banner">
            <span className="stage-banner-dot" />
            Sharing your screen · {share.sourceName}
            <button className="stage-banner-stop" onClick={onStopShare}>Stop</button>
          </div>
        </>
      )}

      {share.error && !share.active && (
        <div className="stage-error-floating">{share.error}</div>
      )}

      {!share.active && (
        <>
          <div className="stage-gallery">
            {isValidElement(galleryContent)
              ? cloneElement(galleryContent, { onSelectParticipant: handleSelectParticipant } as any)
              : galleryContent}
          </div>

          <StageTabBar
            windows={stageWindows}
            activeWindowId={activeWindowId}
            onSelect={onSelectWindow}
            onClose={onCloseWindow}
            onCreate={onCreateWindow}
            onPopOut={onPopOutWindow}
          />

          <div className="stage-content">
            {isActivityTab && (
              <ActivityTabContent
                workers={workers}
                hostGroups={hostGroups}
                plan={plan}
                running={running}
                aiSpeaking={aiSpeaking}
                onResolvePermission={onResolvePermission}
                selectedId={selectedParticipantId}
                onOpenInTerminal={(workerId) => onCreateWindow('terminal', { workerId })}
          customAvatars={customAvatars}
          sessionId={sessionId}
              />
            )}

            {activeWindow?.type === 'browser' && browserViewportRef && onBrowserOpenTab && onBrowserCloseTab && onBrowserSetActive && onBrowserNavigate && onBrowserBack && onBrowserForward && onBrowserReload && (
              <div className="stage-browser-content">
                <BrowserStage
                  tabs={browserTabs}
                  activeTabId={browserActiveTabId}
                  viewportRef={browserViewportRef}
                  onOpenTab={onBrowserOpenTab}
                  onCloseTab={onBrowserCloseTab}
                  onSetActive={onBrowserSetActive}
                  onNavigate={onBrowserNavigate}
                  onBack={onBrowserBack}
                  onForward={onBrowserForward}
                  onReload={onBrowserReload}
                />
              </div>
            )}

            {activeWindow?.type === 'terminal' && (
              <div className="stage-terminal-content">
                <TerminalPanel activity={terminalActivity} />
              </div>
            )}

            {activeWindow?.type === 'file' && activeWindow.filePath && (
              <div className="stage-file-content">
                <FileViewer
                  relativePath={activeWindow.filePath}
                  sessionId={sessionId}
                  onClose={() => {
                    onCloseWindow(activeWindow.id);
                    onCloseFileView?.();
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
