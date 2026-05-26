import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry, PendingPermission, TranscriptEntry } from '../types';
import { PermissionCard } from './PermissionCard';

interface SideDrawerProps {
  open: boolean;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pending: PendingPermission | null;
  onResolve: (id: string, decision: 'allow' | 'deny') => void;
  onSend: (text: string) => void;
  disabled: boolean;
}

type Tab = 'chat' | 'activity';

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
};

export function SideDrawer({
  open,
  transcript,
  activity,
  pending,
  onResolve,
  onSend,
  disabled,
}: SideDrawerProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

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
            {transcript.map((e) => (
              <div key={e.id} className={`msg msg-${e.role}`}>
                <div className="msg-meta">{e.role === 'assistant' ? 'Claude' : e.role === 'user' ? 'You' : 'System'}</div>
                <div className="msg-body">{e.text}</div>
              </div>
            ))}
            {pending && <PermissionCard pending={pending} onDecide={onResolve} />}
            <div ref={endRef} />
          </div>
          <div className="drawer-composer">
            <textarea
              className="drawer-input"
              value={text}
              disabled={disabled}
              placeholder={disabled ? 'Join a meeting to chat' : 'Type a message · ⌘↵ to send'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
            />
            <button className="drawer-send" disabled={disabled || !text.trim()} onClick={submit}>
              Send
            </button>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="drawer-activity">
          {activity.length === 0 && <div className="drawer-empty">Tool calls and system events will appear here.</div>}
          {activity.slice().reverse().map((e) => (
            <div key={e.id} className="act-row">
              <span className="act-dot" style={{ background: dotColor[e.kind] }} />
              <div className="act-body">
                <div className="act-title">
                  {e.source && (
                    <span className={`agent-pill agent-pill-${e.source}`}>
                      {e.source === 'talker' ? 'Host' : 'Worker'}
                    </span>
                  )}
                  {e.title}
                </div>
                {e.detail && <div className="act-detail">{e.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
