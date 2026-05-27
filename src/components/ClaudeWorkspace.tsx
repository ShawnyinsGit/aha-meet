import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type {
  ActivityEntry,
  TranscriptEntry,
  WorkerSpecialty,
  WorkerStatus,
  WorkerTaskHistoryEntry,
} from '../types';
import { ClaudeAvatar } from './ClaudeAvatar';

type CurrentTaskStatus = 'idle' | WorkerStatus | 'speaking';

interface ClaudeWorkspaceProps {
  speaking: boolean;
  awaitingPermission: boolean;
  running: boolean;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  // Identity overrides used when this workspace is rendered for a specific
  // worker (dock view). Defaults preserve the original single-agent UI.
  name?: string;
  subtitle?: string;
  avatar?: 'claude' | 'worker';
  initial?: string;
  // Gallery view shows identity in the top tile row, so the workspace's own
  // avatar/name/status header is redundant. Pass true to skip rendering it.
  hideHero?: boolean;
  // Current task title for the worker this workspace represents.
  //   undefined → hide the current-task card entirely (e.g. talker)
  //   null      → render "Idle" placeholder
  //   string    → render the task as a Current-action style card
  task?: string | null;
  taskStatus?: CurrentTaskStatus;
  taskSpecialty?: WorkerSpecialty;
  taskDeps?: string[];
  taskHistory?: WorkerTaskHistoryEntry[];
  currentTool?: string | null;
  currentToolInput?: string | null;
  lastText?: string;
  startedAt?: number | null;
  pendingPermissionTool?: string | null;
}

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
};

const taskStatusTone: Record<CurrentTaskStatus, 'idle' | 'waiting' | 'working' | 'done' | 'failed' | 'speaking'> = {
  idle: 'idle',
  pending: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
  speaking: 'speaking',
};

const taskStatusLabel: Record<CurrentTaskStatus, string> = {
  idle: 'Idle',
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  speaking: 'Speaking',
};

function statusFor(speaking: boolean, awaitingPermission: boolean, running: boolean, hasRecentTool: boolean): { label: string; tone: 'speaking' | 'working' | 'waiting' | 'idle' | 'off' } {
  if (!running) return { label: 'Offline', tone: 'off' };
  if (awaitingPermission) return { label: 'Waiting for your approval', tone: 'waiting' };
  if (speaking) return { label: 'Speaking', tone: 'speaking' };
  if (hasRecentTool) return { label: 'Working', tone: 'working' };
  return { label: 'Listening', tone: 'idle' };
}

function formatHistoryTime(ts: number): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

function formatDuration(start: number | null | undefined, end: number): string {
  if (!start || !end || end < start) return '';
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

interface FeedRow {
  key: string;
  kind: 'task-history' | ActivityEntry['kind'];
  dotColor: string;
  ts: number;
  title: string;
  detail?: string;
  pill?: { label: string; tone: 'done' | 'failed' | 'running' | 'pending' };
}

export function ClaudeWorkspace({
  speaking,
  awaitingPermission,
  running,
  transcript,
  activity,
  name = 'Claude',
  subtitle,
  avatar = 'claude',
  initial,
  hideHero = false,
  task,
  taskStatus,
  taskSpecialty,
  taskDeps,
  taskHistory,
  currentTool,
  currentToolInput,
  lastText,
  startedAt,
  pendingPermissionTool,
}: ClaudeWorkspaceProps) {
  const lastAssistant = useMemo(() => [...transcript].reverse().find((t) => t.role === 'assistant'), [transcript]);
  const latestToolCall = useMemo(
    () => [...activity].reverse().find((a) => a.kind === 'tool-call'),
    [activity],
  );

  // The "Working" pill expires 8s after the last tool call. Date.now() in
  // render alone won't re-evaluate without a new prop/state change, so we
  // tick a clock every second while a recent tool call exists.
  const [, setClockTick] = useState(0);
  const toolTs = latestToolCall?.ts ?? 0;
  useEffect(() => {
    if (!toolTs) return;
    const stillRecent = () => Date.now() - toolTs < 8000;
    if (!stillRecent()) return;
    const id = setInterval(() => {
      if (stillRecent()) {
        setClockTick((n) => n + 1);
      } else {
        clearInterval(id);
        setClockTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [toolTs]);

  const status = statusFor(speaking, awaitingPermission, running, Boolean(latestToolCall) && (Date.now() - toolTs < 8000));

  // Per-row expand/collapse for the current task card and each feed row.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Current task — only rendered when task !== undefined.
  const showCurrentTask = task !== undefined;
  const currentTaskTone = taskStatus ? taskStatusTone[taskStatus] : 'idle';
  const currentTaskLabel = taskStatus ? taskStatusLabel[taskStatus] : 'Idle';
  const currentTaskExpanded = expanded.has('__current__');

  // Build the merged feed: taskHistory (most recent first) followed by
  // recent activity entries. Capped so we don't blow the panel up.
  const feedRows: FeedRow[] = useMemo(() => {
    const rows: FeedRow[] = [];
    if (taskHistory && taskHistory.length > 0) {
      for (const entry of [...taskHistory].reverse()) {
        rows.push({
          key: `task-${entry.id}`,
          kind: 'task-history',
          dotColor: entry.status === 'failed' ? '#ff7a7a' : entry.status === 'done' ? '#9ae29a' : '#7cc6ff',
          ts: entry.finishedAt || entry.startedAt,
          title: entry.title,
          detail: entry.summary,
          pill: {
            label: entry.status,
            tone: entry.status === 'done' || entry.status === 'failed' || entry.status === 'running' || entry.status === 'pending'
              ? entry.status
              : 'pending',
          },
        });
      }
    }
    for (const a of activity.slice(-10).reverse()) {
      rows.push({
        key: `act-${a.id}`,
        kind: a.kind,
        dotColor: dotColor[a.kind],
        ts: a.ts,
        title: a.title,
        detail: a.detail,
      });
    }
    return rows.slice(0, 12);
  }, [taskHistory, activity]);

  return (
    <div className={`workspace workspace-${status.tone}`}>
      <div className="workspace-aurora" />

      {!hideHero && (
        <header className="workspace-hero">
          <div className="workspace-avatar">
            {avatar === 'claude' ? (
              <ClaudeAvatar size={104} speaking={speaking} />
            ) : (
              <div className="workspace-avatar-worker">
                <span className="workspace-avatar-worker-initial">
                  {(initial ?? name.trim().slice(0, 1) ?? '?').toUpperCase()}
                </span>
              </div>
            )}
            {(speaking || awaitingPermission) && <span className="workspace-avatar-ring" />}
          </div>
          <div className="workspace-hero-text">
            <div className="workspace-name" title={name}>{name}</div>
            {subtitle && <div className="workspace-subtitle">{subtitle}</div>}
            <div className={`workspace-status workspace-status-${status.tone}`}>
              <span className="workspace-status-dot" />
              {status.label}
            </div>
          </div>
        </header>
      )}

      {showCurrentTask && (
        <section className="workspace-now workspace-current-task">
          <div className="workspace-now-label">Current task</div>
          <button
            type="button"
            className={`workspace-now-card workspace-task-card ${currentTaskExpanded ? 'workspace-task-card-open' : ''}`}
            onClick={() => toggleExpand('__current__')}
            aria-expanded={currentTaskExpanded}
            aria-label={task ? `Current task: ${task}` : 'No current task'}
          >
            <div className="workspace-task-row">
              <span className="workspace-task-caret" aria-hidden>
                {currentTaskExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <span className="workspace-task-title" title={task ?? undefined}>
                {task ?? 'Idle'}
              </span>
              <span className={`workspace-task-pill workspace-task-pill-${currentTaskTone}`}>
                {currentTaskLabel}
              </span>
            </div>
            {currentTaskExpanded && (
              <div className="workspace-task-detail" onClick={(e) => e.stopPropagation()}>
                {currentTool && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Tool</span>
                    <span className="workspace-task-detail-value">
                      {currentTool}
                      {currentToolInput && <span className="workspace-task-detail-mono"> · {currentToolInput}</span>}
                    </span>
                  </div>
                )}
                {pendingPermissionTool && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Awaiting</span>
                    <span className="workspace-task-detail-value">{pendingPermissionTool}</span>
                  </div>
                )}
                {taskSpecialty && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Specialty</span>
                    <span className="workspace-task-detail-value">{taskSpecialty}</span>
                  </div>
                )}
                {taskDeps && taskDeps.length > 0 && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Deps</span>
                    <span className="workspace-task-detail-value">{taskDeps.join(', ')}</span>
                  </div>
                )}
                {startedAt && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Started</span>
                    <span className="workspace-task-detail-value">{formatHistoryTime(startedAt)}</span>
                  </div>
                )}
                {lastText && (
                  <div className="workspace-task-detail-row workspace-task-detail-row-block">
                    <span className="workspace-task-detail-label">Last said</span>
                    <span className="workspace-task-detail-value workspace-task-detail-text">{lastText}</span>
                  </div>
                )}
                {!currentTool && !pendingPermissionTool && !taskSpecialty && (!taskDeps || taskDeps.length === 0) && !startedAt && !lastText && (
                  <div className="workspace-task-detail-empty">No additional context yet.</div>
                )}
              </div>
            )}
          </button>
        </section>
      )}

      {/* Keep the original "Latest thought" surface when there's no active tool;
          omit it for talker once a current-task card is in play to avoid stacking. */}
      {lastAssistant && !latestToolCall && !showCurrentTask && (
        <section className="workspace-now">
          <div className="workspace-now-label">Latest thought</div>
          <div className="workspace-now-card workspace-now-thought">
            {lastAssistant.text.slice(0, 280)}
            {lastAssistant.text.length > 280 ? '…' : ''}
          </div>
        </section>
      )}

      <section className="workspace-feed">
        <div className="workspace-feed-label">Recent activity</div>
        <div className="workspace-feed-list">
          {feedRows.length === 0 ? (
            <div className="workspace-feed-empty">No activity yet.</div>
          ) : (
            feedRows.map((row) => {
              const isOpen = expanded.has(row.key);
              const clickable = Boolean(row.detail);
              return (
                <div
                  key={row.key}
                  className={`workspace-feed-row ${clickable ? 'workspace-feed-row-clickable' : ''} ${isOpen ? 'workspace-feed-row-open' : ''}`}
                  onClick={clickable ? () => toggleExpand(row.key) : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={clickable ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(row.key);
                    }
                  } : undefined}
                  aria-expanded={clickable ? isOpen : undefined}
                >
                  <span className="workspace-feed-dot" style={{ background: row.dotColor }} />
                  <div className="workspace-feed-text">
                    <div className="workspace-feed-title">
                      {row.kind === 'task-history' && (
                        <span className={`workspace-feed-task-pill workspace-feed-task-pill-${row.pill?.tone ?? 'pending'}`}>
                          Task
                        </span>
                      )}
                      <span className="workspace-feed-title-text">{row.title}</span>
                      {row.pill && (
                        <span className={`workspace-task-pill workspace-task-pill-${row.pill.tone === 'done' ? 'done' : row.pill.tone === 'failed' ? 'failed' : row.pill.tone === 'running' ? 'working' : 'waiting'}`}>
                          {row.pill.label}
                        </span>
                      )}
                      {row.ts > 0 && (
                        <span className="workspace-feed-time">{formatHistoryTime(row.ts)}</span>
                      )}
                      {clickable && (
                        <span className="workspace-feed-caret" aria-hidden>
                          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                      )}
                    </div>
                    {row.detail && !isOpen && (
                      <div className="workspace-feed-detail">{row.detail}</div>
                    )}
                    {row.detail && isOpen && (
                      <div className="workspace-feed-detail workspace-feed-detail-expanded">
                        {row.detail}
                        {row.kind === 'task-history' && (
                          <div className="workspace-feed-meta">
                            duration {formatDuration((taskHistory ?? []).find((h) => `task-${h.id}` === row.key)?.startedAt ?? null, row.ts)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
