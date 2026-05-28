import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Bell } from 'lucide-react';
import type { WorkerState } from '../lib/meeting-store';
import type { WorkerSpecialty } from '../types';
import { ClaudeAvatar } from './ClaudeAvatar';

interface WorkerCardProps {
  worker: WorkerState;
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

/** Human-readable status label shown below the avatar. */
function statusLabel(worker: WorkerState, speaking: boolean): string {
  if (speaking) return 'Speaking';
  if (worker.pendingPermission) return 'Waiting';
  if (worker.currentTool) return 'Thinking';
  switch (worker.status) {
    case 'running': return 'Running';
    case 'pending': return 'Pending';
    case 'done':    return 'Done';
    case 'failed':  return 'Failed';
    default:        return 'Idle';
  }
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
    const label = statusLabel(worker, Boolean(speaking));
    const roleName = isTalker ? 'Talker' : 'Worker';

    return (
      <div
        className={className}
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect}
        onKeyDown={onSelect ? handleKey : undefined}
      >
        {/* Role badge — top-right */}
        <div className="tile-role-badge">{roleName}</div>

        <div className={`worker-card-stage worker-card-stage-centered ${isTalker ? 'worker-card-stage-talker' : 'worker-card-stage-worker'}`}>
          <div className={`worker-card-avatar worker-card-avatar-${isTalker ? 'talker' : 'worker'}`}>
            {avatar}
          </div>
          {/* Status below avatar */}
          <div className="worker-card-status-badge">
            <span className={`worker-card-pill worker-card-pill-${tone}`}>{label}</span>
            {worker.pendingPermission && (
              <span className="worker-card-icon worker-card-icon-perm" title="Awaiting approval" aria-label="Awaiting approval">
                <Bell size={11} />
              </span>
            )}
          </div>
        </div>

        {/* Permission approval inline */}
        {worker.pendingPermission && (
          <div className="worker-card-perm">
            <div className="worker-card-perm-text">
              <span className="worker-card-perm-label">Allow</span>{' '}
              <span className="worker-card-perm-tool">{worker.pendingPermission.toolName}</span>?
            </div>
            <div className="worker-card-perm-actions">
              <button type="button" className="worker-card-perm-allow"
                onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'allow'); }}
              >Allow</button>
              <button type="button" className="worker-card-perm-deny"
                onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'deny'); }}
              >Deny</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // sidebar mode — horizontal layout
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
          <div className="worker-card-title" title={worker.title}>{worker.title}</div>
          <div className="worker-card-meta">
            <span className={`worker-card-pill worker-card-pill-${tone}`}>{worker.status}</span>
            {worker.pendingPermission && (
              <span className="worker-card-icon worker-card-icon-perm" title="Awaiting approval" aria-label="Awaiting approval">
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
            <button type="button" className="worker-card-perm-allow"
              onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'allow'); }}
            >Allow</button>
            <button type="button" className="worker-card-perm-deny"
              onClick={(e) => { e.stopPropagation(); if (worker.pendingPermission) onResolvePermission(worker.pendingPermission.id, 'deny'); }}
            >Deny</button>
          </div>
        </div>
      )}
    </div>
  );
}
