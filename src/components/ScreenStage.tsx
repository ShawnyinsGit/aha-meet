import { ReactNode, RefObject, useState, useCallback, useMemo } from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot, WorkerState } from '../lib/meeting-store';
import type { ActivityEntry, BrowserTabInfo, MeetingPlan } from '../types';
import type { StageWindow, StageWindowType } from '../lib/stage-window-store';
import { DeliveryViewer } from './DeliveryViewer';
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
}

const ACTIVITY_TAB_ID = 'activity-default';
const USER_SLOT = 'user';

export function ScreenStage({
  share,
  videoRef,
  onPickSource: _onPickSource,
  onStopShare,
  workers,
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
}: ScreenStageProps) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const handleSelectUser = useCallback(() => {
    setSelectedUserId(USER_SLOT);
  }, []);

  const handleSelectWorker = useCallback((id: string) => {
    setSelectedUserId(id);
  }, []);

  const activeWindow = stageWindows.find((w) => w.id === activeWindowId) ?? null;
  const isActivityTab = activeWindow?.type === 'activity' || activeWindowId === ACTIVITY_TAB_ID;

  // For terminal stage windows, find the worker whose activity should be
  // displayed. When no workerId is specified, aggregate all workers' Bash
  // activity so the terminal tab shows real command output instead of being
  // empty (talkers have `tools: []` and never produce Bash activity).
  const terminalActivity = useMemo(() => {
    if (activeWindow?.type !== 'terminal') return [];
    if (activeWindow.workerId) {
      const target = workers.find((w) => w.id === activeWindow.workerId);
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
            {galleryContent}
          </div>

          <StageTabBar
            windows={stageWindows}
            activeWindowId={activeWindowId}
            onSelect={onSelectWindow}
            onClose={onCloseWindow}
            onCreate={onCreateWindow}
          />

          <div className="stage-content">
            {isActivityTab && (
              <ActivityTabContent
                workers={workers}
                plan={plan}
                running={running}
                aiSpeaking={aiSpeaking}
                onResolvePermission={onResolvePermission}
                onSelectUser={handleSelectUser}
                selectedUser={selectedUserId === USER_SLOT}
                onOpenInTerminal={(workerId) => onCreateWindow('terminal', { workerId })}
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

            {activeWindow?.type === 'delivery' && delivery && (
              <div className="stage-delivery-content">
                <DeliveryViewer
                  delivery={delivery}
                  sessionId={sessionId}
                  aiSpeaking={aiSpeaking}
                  onAccept={onAcceptDelivery}
                  onRevise={onReviseDelivery}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
