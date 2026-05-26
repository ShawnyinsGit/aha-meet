import type { ReactNode } from 'react';
import { formatElapsed } from '../hooks/useTimer';

interface MeetingHeaderProps {
  cwd: string | null;
  elapsed: number;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  // Settings entry (gear + popover). Chat-drawer toggle and Leave button live
  // on the BottomToolbar — keeping them only there avoids duplicate controls.
  settingsSlot?: ReactNode;
}

export function MeetingHeader({
  cwd,
  elapsed,
  autoApprove,
  onToggleAutoApprove,
  settingsSlot,
}: MeetingHeaderProps) {
  const folder = cwd?.split('/').filter(Boolean).slice(-1)[0] ?? 'No folder';
  const approveTitle = autoApprove
    ? '自动批准已开启 · 点击切换为手动批准'
    : '手动批准 · 点击开启自动批准';
  return (
    <header className="mtg-header">
      <div className="mtg-header-left">
        <div className="mtg-dot" />
        <div className="mtg-title">
          <div className="mtg-title-name">{folder}</div>
          <div className="mtg-title-sub" title={cwd ?? ''}>{cwd ?? ''}</div>
        </div>
      </div>
      <div className="mtg-header-center">
        <span className="mtg-timer-dot" />
        <span className="mtg-timer">{formatElapsed(elapsed)}</span>
      </div>
      <div className="mtg-header-right">
        <button
          type="button"
          className={`mtg-approve-toggle ${autoApprove ? 'mtg-approve-toggle-on' : ''}`}
          role="switch"
          aria-checked={autoApprove}
          onClick={onToggleAutoApprove}
          title={approveTitle}
        >
          <span className="mtg-approve-toggle-track" aria-hidden="true">
            <span className="mtg-approve-toggle-knob" />
          </span>
          <span className="mtg-approve-toggle-label">自动批准</span>
        </button>
        {settingsSlot}
      </div>
    </header>
  );
}
