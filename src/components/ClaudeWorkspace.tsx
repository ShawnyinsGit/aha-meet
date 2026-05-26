import { useEffect, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { ActivityEntry, TranscriptEntry } from '../types';
import { ClaudeAvatar } from './ClaudeAvatar';

interface ClaudeWorkspaceProps {
  cwd: string | null;
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
}

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
};

function statusFor(speaking: boolean, awaitingPermission: boolean, running: boolean, hasRecentTool: boolean): { label: string; tone: 'speaking' | 'working' | 'waiting' | 'idle' | 'off' } {
  if (!running) return { label: 'Offline', tone: 'off' };
  if (awaitingPermission) return { label: 'Waiting for your approval', tone: 'waiting' };
  if (speaking) return { label: 'Speaking', tone: 'speaking' };
  if (hasRecentTool) return { label: 'Working', tone: 'working' };
  return { label: 'Listening', tone: 'idle' };
}

export function ClaudeWorkspace({
  cwd,
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
}: ClaudeWorkspaceProps) {
  const lastAssistant = useMemo(() => [...transcript].reverse().find((t) => t.role === 'assistant'), [transcript]);
  const recentActivity = useMemo(() => activity.slice(-6).reverse(), [activity]);
  const latestToolCall = useMemo(
    () => [...activity].reverse().find((a) => a.kind === 'tool-call'),
    [activity],
  );

  // The "Working" pill expires 8s after the last tool call. Date.now() in
  // render alone won't re-evaluate without a new prop/state change, so we
  // tick a clock every second while a recent tool call exists. The interval
  // self-cancels once the call goes stale (>8s old) to avoid wakeups during
  // long idle stretches.
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
  const folder = cwd?.split('/').filter(Boolean).slice(-1)[0] ?? '—';

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

      <section className="workspace-context">
        <div className="workspace-context-label">Working in</div>
        <div className="workspace-context-value" title={cwd ?? ''}>
          <FolderOpen size={14} aria-hidden="true" /> {folder}
        </div>
        {cwd && <div className="workspace-context-path">{cwd}</div>}
      </section>

      {latestToolCall && (
        <section className="workspace-now">
          <div className="workspace-now-label">Current action</div>
          <div className="workspace-now-card">
            <div className="workspace-now-title">{latestToolCall.title}</div>
            {latestToolCall.detail && (
              <div className="workspace-now-detail">{latestToolCall.detail}</div>
            )}
          </div>
        </section>
      )}

      {lastAssistant && !latestToolCall && (
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
          {recentActivity.length === 0 ? (
            <div className="workspace-feed-empty">No tool activity yet.</div>
          ) : (
            recentActivity.map((e) => (
              <div key={e.id} className="workspace-feed-row">
                <span className="workspace-feed-dot" style={{ background: dotColor[e.kind] }} />
                <div className="workspace-feed-text">
                  <div className="workspace-feed-title">
                    {e.source && (
                      <span className={`agent-pill agent-pill-${e.source}`}>
                        {e.source === 'talker' ? 'Host' : 'Worker'}
                      </span>
                    )}
                    {e.title}
                  </div>
                  {e.detail && <div className="workspace-feed-detail">{e.detail}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
