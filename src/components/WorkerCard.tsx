import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Mic, Bell } from 'lucide-react';
import type { WorkerState } from '../lib/meeting-store';
import { ClaudeAvatar } from './ClaudeAvatar';

interface WorkerCardProps {
  worker: WorkerState;
  // Kept on the prop list for API parity with the dock-detail consumer, but
  // intentionally unused now — gallery/sidebar tiles stay Zoom-clean and
  // don't render dep chips. Detail-level info belongs in the dock workspace.
  depTitles?: Map<string, string>;
  mode: 'gallery' | 'sidebar';
  selected?: boolean;
  speaking?: boolean;
  onSelect?: () => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
}

const statusTone: Record<WorkerState['status'], 'idle' | 'waiting' | 'working' | 'done' | 'failed'> = {
  idle: 'idle',
  pending: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
};

function avatarInitial(title: string): string {
  const trim = title.trim();
  if (!trim) return '?';
  return trim.slice(0, 1).toUpperCase();
}

const PULSE_MS = 600;

export function WorkerCard({
  worker,
  mode,
  selected,
  speaking,
  onSelect,
  onResolvePermission,
}: WorkerCardProps) {
  const isTalker = worker.role === 'talker';
  const tone = statusTone[worker.status];

  // Pulse for ~600ms whenever a new activity row lands. This is the only
  // "something is happening" signal on the lean tile — no transcript, no
  // current-tool text, no recent-activity list.
  const [pulse, setPulse] = useState(false);
  const lastTs = worker.activity.length > 0 ? worker.activity[worker.activity.length - 1].ts : 0;
  useEffect(() => {
    if (!lastTs) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [lastTs]);

  const avatar = isTalker ? (
    <ClaudeAvatar size={mode === 'gallery' ? 56 : 32} speaking={Boolean(speaking)} />
  ) : (
    <span className="worker-card-initial">{avatarInitial(worker.title)}</span>
  );

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  const className = [
    'worker-card',
    `worker-card-${mode}`,
    `worker-card-${tone}`,
    selected ? 'worker-card-selected' : '',
    pulse || speaking ? 'worker-card-pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (mode === 'gallery') {
    return (
      <div
        className={className}
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect}
        onKeyDown={onSelect ? handleKey : undefined}
      >
        <div className={`worker-card-stage ${isTalker ? 'worker-card-stage-talker' : 'worker-card-stage-worker'}`}>
          <div className={`worker-card-avatar worker-card-avatar-${isTalker ? 'talker' : 'worker'}`}>
            {avatar}
          </div>
          <div className="worker-card-status-badge">
            <span className={`worker-card-pill worker-card-pill-${tone}`}>{worker.status}</span>
            {speaking && (
              <span className="worker-card-icon worker-card-icon-speaking" title="Speaking" aria-label="Speaking">
                <Mic size={12} />
              </span>
            )}
            {worker.pendingPermission && (
              <span className="worker-card-icon worker-card-icon-perm" title="Awaiting your approval" aria-label="Awaiting approval">
                <Bell size={12} />
              </span>
            )}
          </div>
        </div>
        <div className="worker-card-footer">
          <span className="worker-card-title" title={worker.title}>{worker.title}</span>
          <span className="worker-card-role">{isTalker ? 'Claude' : 'Worker'}</span>
        </div>
        {worker.pendingPermission && (
          <div className="worker-card-perm">
            <div className="worker-card-perm-text">
              <span className="worker-card-perm-label">Allow</span>{' '}
              <span className="worker-card-perm-tool">{worker.pendingPermission.toolName}</span>?
            </div>
            <div className="worker-card-perm-actions">
              <button
                type="button"
                className="worker-card-perm-allow"
                onClick={(e) => {
                  e.stopPropagation();
                  if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'allow');
                }}
              >Allow</button>
              <button
                type="button"
                className="worker-card-perm-deny"
                onClick={(e) => {
                  e.stopPropagation();
                  if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'deny');
                }}
              >Deny</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={className}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={onSelect ? handleKey : undefined}
    >
      <div className="worker-card-header">
        <div className={`worker-card-avatar worker-card-avatar-${isTalker ? 'talker' : 'worker'}`}>
          {avatar}
        </div>
        <div className="worker-card-titleblock">
          <div className="worker-card-title" title={worker.title}>
            {worker.title}
          </div>
          <div className="worker-card-meta">
            <span className={`worker-card-pill worker-card-pill-${tone}`}>{worker.status}</span>
            {speaking && (
              <span className="worker-card-icon worker-card-icon-speaking" title="Speaking" aria-label="Speaking">
                <Mic size={12} />
              </span>
            )}
            {worker.pendingPermission && (
              <span className="worker-card-icon worker-card-icon-perm" title="Awaiting your approval" aria-label="Awaiting approval">
                <Bell size={12} />
              </span>
            )}
          </div>
        </div>
      </div>

      {worker.pendingPermission && (
        <div className="worker-card-perm">
          <div className="worker-card-perm-text">
            <span className="worker-card-perm-label">Allow</span>{' '}
            <span className="worker-card-perm-tool">{worker.pendingPermission.toolName}</span>?
          </div>
          <div className="worker-card-perm-actions">
            <button
              type="button"
              className="worker-card-perm-allow"
              onClick={(e) => {
                e.stopPropagation();
                if (worker.pendingPermission) {
                  onResolvePermission(worker.pendingPermission.id, 'allow');
                }
              }}
            >
              Allow
            </button>
            <button
              type="button"
              className="worker-card-perm-deny"
              onClick={(e) => {
                e.stopPropagation();
                if (worker.pendingPermission) {
                  onResolvePermission(worker.pendingPermission.id, 'deny');
                }
              }}
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
