import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { ActivityEntry, PendingPermission, TranscriptEntry } from '../types';
import { PermissionCard } from './PermissionCard';

interface SideDrawerProps {
  open: boolean;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pending: PendingPermission | null;
  onResolve: (id: string, decision: 'allow' | 'deny') => void;
  onSend: (text: string) => void;
  multiAgent?: boolean;
  disabled: boolean;
}

const TIME_TICK_MS = 30_000;

type Tab = 'chat' | 'activity';

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatMessageTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffMs = now - ts;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 60 * 60_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  const d = new Date(ts);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

export function SideDrawer({
  open,
  transcript,
  activity,
  pending,
  onResolve,
  onSend,
  multiAgent = false,
  disabled,
}: SideDrawerProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (tab !== 'chat') return;
    const id = window.setInterval(() => setNow(Date.now()), TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, [tab]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (tab !== 'chat') return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript.length, tab, pending]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const placeholder = disabled
    ? 'Join a meeting to chat'
    : multiAgent
      ? '多 Agent 并行 · Enter 发送 · Shift+Enter 换行'
      : 'Type a message · Enter 发送 · Shift+Enter 换行';

  return (
    <aside className={`drawer ${open ? 'drawer-open' : ''}`}>
      <div className="drawer-tabs">
        <button className={`drawer-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          Chat
          {transcript.length > 0 && <span className="drawer-badge">{transcript.length}</span>}
        </button>
        <button className={`drawer-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          Activity
          {activity.length > 0 && <span className="drawer-badge">{activity.length}</span>}
        </button>
      </div>

      {tab === 'chat' && (
        <div className="drawer-chat">
          <div className="drawer-scroll">
            {transcript.length === 0 && (
              <div className="drawer-empty">Claude will introduce themself shortly. Speak or type to reply.</div>
            )}
            {transcript.map((e) => {
              const timeLabel = formatMessageTime(e.ts, now);
              const isoTitle = e.ts ? new Date(e.ts).toISOString() : undefined;
              return (
                <div key={e.id} className={`msg msg-${e.role}`}>
                  <div className="msg-meta">
                    <span className="msg-author">
                      {e.role === 'assistant' ? 'Claude' : e.role === 'user' ? 'You' : 'System'}
                    </span>
                    {timeLabel && (
                      <span className="msg-time" title={isoTitle}>{timeLabel}</span>
                    )}
                  </div>
                  {e.imageUrl && (
                    <img className="msg-image" src={e.imageUrl} alt={e.text || 'Shared screenshot'} />
                  )}
                  {e.text && <div className="msg-body">{e.text}</div>}
                </div>
              );
            })}
            {pending && <PermissionCard pending={pending} onDecide={onResolve} />}
            <div ref={endRef} />
          </div>
          <div className="drawer-composer">
            <div className="drawer-input-wrap">
              <textarea
                className="drawer-input"
                value={text}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
              />
              <button
                type="button"
                className="drawer-send-icon"
                disabled={disabled || !text.trim()}
                onClick={submit}
                aria-label="发送"
                title="发送 · Enter"
              >
                <Send size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="drawer-activity">
          {activity.length === 0 && <div className="drawer-empty">Tool calls and system events will appear here.</div>}
          {activity.slice().reverse().map((e) => {
            const hasDetail = Boolean(e.detail);
            const isOpen = expanded.has(e.id);
            const rowClass = `act-row${hasDetail ? ' has-detail' : ''}${isOpen ? ' expanded' : ''}`;
            return (
              <div
                key={e.id}
                className={rowClass}
                role={hasDetail ? 'button' : undefined}
                tabIndex={hasDetail ? 0 : undefined}
                aria-expanded={hasDetail ? isOpen : undefined}
                onClick={hasDetail ? () => toggleExpanded(e.id) : undefined}
                onKeyDown={
                  hasDetail
                    ? (ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          toggleExpanded(e.id);
                        }
                      }
                    : undefined
                }
              >
                <span className="act-dot" style={{ background: dotColor[e.kind] }} />
                <div className="act-body">
                  <div className="act-title">
                    {e.source && (
                      <span className={`agent-pill agent-pill-${e.source}`}>
                        {e.source === 'talker' ? 'Host' : 'Worker'}
                      </span>
                    )}
                    <span className="act-title-text">{e.title}</span>
                    {hasDetail && (
                      <span className="act-chevron" aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>
                    )}
                  </div>
                  {hasDetail && <div className="act-detail">{e.detail}</div>}
                  {e.actionPath && (
                    <button
                      type="button"
                      className="act-action"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        const p = e.actionPath;
                        if (p) void window.vibeMeet.decisions.open(p);
                      }}
                    >
                      打开 md
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
