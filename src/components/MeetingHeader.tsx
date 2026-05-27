import type { ReactNode } from 'react';
import { formatElapsed } from '../hooks/useTimer';

interface MeetingHeaderProps {
  cwd: string | null;
  elapsed: number;
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  multiAgent: boolean;
  onToggleMultiAgent: () => void;
  // Settings entry (gear + popover). Chat-drawer toggle and Leave button live
  // on the BottomToolbar — keeping them only there avoids duplicate controls.
  settingsSlot?: ReactNode;
}

export function MeetingHeader({
  cwd,
  elapsed,
  autoApprove,
  onToggleAutoApprove,
  multiAgent,
  onToggleMultiAgent,
  settingsSlot,
}: MeetingHeaderProps) {
  const folder = cwd?.split('/').filter(Boolean).slice(-1)[0] ?? 'No folder';
  const approveTitle = autoApprove
    ? '自动批准已开启 · 点击切换为手动批准'
    : '手动批准 · 点击开启自动批准';
  const multiAgentTitle = multiAgent
    ? '多 Agent 并行已开启 · 所有需求会先评估依赖再拆解并行 · 点击关闭'
    : '单 Agent 模式 · 点击开启多 Agent 并行';
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
          className={`mtg-approve-toggle mtg-multi-toggle ${multiAgent ? 'mtg-multi-toggle-on' : ''}`}
          role="switch"
          aria-checked={multiAgent}
          onClick={onToggleMultiAgent}
          title={multiAgentTitle}
        >
          <span className="mtg-approve-toggle-track" aria-hidden="true">
            <span className="mtg-approve-toggle-knob" />
          </span>
          <span className="mtg-approve-toggle-label">多 Agent 并行</span>
        </button>
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
