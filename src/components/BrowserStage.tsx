// Browser stage: wraps the browser toolbar + a transparent viewport div.
// The viewport div is measured by the ResizeObserver in useBrowser to
// position the WebContentsView overlay in the main process.

import { memo, type RefObject } from 'react';
import type { BrowserTabInfo } from '../types';
import { BrowserToolbar } from './BrowserToolbar';

interface BrowserStageProps {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  viewportRef: RefObject<HTMLDivElement>;
  onOpenTab: () => void;
  onCloseTab: (id: string) => void;
  onSetActive: (id: string) => void;
  onNavigate: (tabId: string, url: string) => void;
  onBack: (tabId: string) => void;
  onForward: (tabId: string) => void;
  onReload: (tabId: string) => void;
}

export const BrowserStage = memo(function BrowserStage({
  tabs,
  activeTabId,
  viewportRef,
  onOpenTab,
  onCloseTab,
  onSetActive,
  onNavigate,
  onBack,
  onForward,
  onReload,
}: BrowserStageProps) {
  return (
    <div className="browser-stage">
      <BrowserToolbar
        tabs={tabs}
        activeTabId={activeTabId}
        onOpenTab={onOpenTab}
        onCloseTab={onCloseTab}
        onSetActive={onSetActive}
        onNavigate={onNavigate}
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
      />
      <div className="browser-viewport" ref={viewportRef} />
    </div>
  );
});
