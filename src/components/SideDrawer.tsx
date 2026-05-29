import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Paperclip, X, FileText, FileType, Image as ImageIcon, FileWarning } from 'lucide-react';
import type {
  ActivityEntry,
  AttachmentKind,
  PendingPermission,
  StagedAttachment,
  TranscriptEntry,
} from '../types';
import { PermissionCard } from './PermissionCard';

interface SideDrawerProps {
  open: boolean;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pending: PendingPermission | null;
  onResolve: (id: string, decision: 'allow' | 'deny') => void;
  onSend: (text: string) => void;
  onSendAttachments?: (
    staged: StagedAttachment[],
    text: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onSubscribeDroppedFiles?: (cb: (files: File[]) => void) => () => void;
  multiAgent?: boolean;
  disabled: boolean;
}

const TIME_TICK_MS = 30_000;
const STAGED_MAX = 10;
const PER_FILE_MAX = 25 * 1024 * 1024;
const TOTAL_MAX = 50 * 1024 * 1024;

const ACCEPT_ATTR = [
  '.md', '.markdown', '.txt', '.log',
  '.json', '.jsonc',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.yaml', '.yml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.csv', '.tsv',
  '.docx', '.pdf',
  'image/png', 'image/jpeg', 'image/webp',
].join(',');

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'yaml', 'yml', 'toml', 'ini', 'env',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'csv', 'tsv',
]);

function classifyKind(name: string, mime: string): AttachmentKind | null {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'word';
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/jpg' || m === 'image/webp') return 'image';
  if (m.startsWith('text/') || m.startsWith('application/json') || m.startsWith('application/xml')) return 'text';
  const idx = name.lastIndexOf('.');
  if (idx < 0) return null;
  const ext = name.slice(idx + 1).toLowerCase();
  if (ext === 'docx') return 'word';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function iconFor(kind: AttachmentKind) {
  if (kind === 'image') return <ImageIcon size={12} aria-hidden="true" />;
  if (kind === 'pdf') return <FileType size={12} aria-hidden="true" />;
  if (kind === 'word') return <FileType size={12} aria-hidden="true" />;
  return <FileText size={12} aria-hidden="true" />;
}

export function SideDrawer({
  open,
  transcript,
  activity,
  pending,
  onResolve,
  onSend,
  onSendAttachments,
  onSubscribeDroppedFiles,
  multiAgent = false,
  disabled,
}: SideDrawerProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [rejected, setRejected] = useState<Array<{ id: string; name: string; reason: string }>>([]);
  const [staging, setStaging] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const totalStagedBytes = useMemo(
    () => staged.reduce((acc, a) => acc + a.sizeBytes, 0),
    [staged],
  );

  const enqueueFiles = async (files: File[] | FileList) => {
    if (disabled) return;
    if (!onSendAttachments) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setStaging(true);
    try {
      const accepted: StagedAttachment[] = [];
      const rejects: Array<{ id: string; name: string; reason: string }> = [];
      let runningTotal = totalStagedBytes + accepted.reduce((a, x) => a + x.sizeBytes, 0);
      for (const f of list) {
        if (staged.length + accepted.length >= STAGED_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `已达 ${STAGED_MAX} 个附件上限` });
          continue;
        }
        if (f.size > PER_FILE_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `超过单文件 ${formatBytes(PER_FILE_MAX)} 上限` });
          continue;
        }
        if (runningTotal + f.size > TOTAL_MAX) {
          rejects.push({ id: uid(), name: f.name, reason: `本次合计将超过 ${formatBytes(TOTAL_MAX)} 上限` });
          continue;
        }
        const kind = classifyKind(f.name, f.type);
        if (!kind) {
          rejects.push({ id: uid(), name: f.name, reason: '不支持的文件类型' });
          continue;
        }
        try {
          const dataBase64 = await fileToBase64(f);
          accepted.push({
            id: uid(),
            name: f.name,
            mime: f.type || '',
            sizeBytes: f.size,
            kind,
            dataBase64,
          });
          runningTotal += f.size;
        } catch {
          rejects.push({ id: uid(), name: f.name, reason: '读取失败' });
        }
      }
      if (accepted.length > 0) setStaged((prev) => [...prev, ...accepted]);
      if (rejects.length > 0) setRejected((prev) => [...prev, ...rejects]);
    } finally {
      setStaging(false);
    }
  };

  // Subscribe to window-level drops published by App.tsx.
  useEffect(() => {
    if (!onSubscribeDroppedFiles) return;
    const unsub = onSubscribeDroppedFiles((files) => {
      void enqueueFiles(files);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSubscribeDroppedFiles, disabled, totalStagedBytes, staged.length, onSendAttachments]);

  const removeStaged = (id: string) => {
    setStaged((prev) => prev.filter((a) => a.id !== id));
  };

  const dismissRejected = (id: string) => {
    setRejected((prev) => prev.filter((r) => r.id !== id));
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (staged.length > 0 && onSendAttachments) {
      const res = await onSendAttachments(staged, trimmed);
      if (res.ok) {
        setStaged([]);
        setText('');
        setRejected([]);
      }
      return;
    }
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onSendAttachments) return;
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void enqueueFiles(files);
    }
  };

  const placeholder = disabled
    ? 'Join a meeting to chat'
    : multiAgent
      ? '多 Agent 并行 · Enter 发送 · Shift+Enter 换行 · 📎/拖放/粘贴可附文件'
      : 'Type a message · Enter 发送 · 📎 附件 / 拖放 / 粘贴均可';

  const sendDisabled = disabled || staging || (staged.length === 0 && !text.trim());

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
                  {e.attachments && e.attachments.length > 0 && (
                    <div className="msg-attachments">
                      {e.attachments.map((a, idx) => (
                        <span key={`${e.id}-att-${idx}`} className={`attachment-chip attachment-chip-${a.kind} attachment-chip-sent`}>
                          <span className="attachment-icon">{iconFor(a.kind)}</span>
                          <span className="attachment-name">{a.name}</span>
                          <span className="attachment-size">{formatBytes(a.sizeBytes)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {e.text && <div className="msg-body">{e.text}</div>}
                </div>
              );
            })}
            {pending && <PermissionCard pending={pending} onDecide={onResolve} />}
            <div ref={endRef} />
          </div>
          <div className="drawer-composer">
            {(staged.length > 0 || rejected.length > 0) && (
              <div className="attachment-strip">
                {staged.map((a) => (
                  <span key={a.id} className={`attachment-chip attachment-chip-${a.kind}`}>
                    <span className="attachment-icon">{iconFor(a.kind)}</span>
                    <span className="attachment-name" title={a.name}>{a.name}</span>
                    <span className="attachment-size">{formatBytes(a.sizeBytes)}</span>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => removeStaged(a.id)}
                      aria-label={`移除 ${a.name}`}
                      title="移除"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {rejected.map((r) => (
                  <span key={r.id} className="attachment-chip attachment-chip-rejected" title={r.reason}>
                    <span className="attachment-icon"><FileWarning size={12} aria-hidden="true" /></span>
                    <span className="attachment-name">{r.name}</span>
                    <span className="attachment-size">{r.reason}</span>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => dismissRejected(r.id)}
                      aria-label={`关闭 ${r.name}`}
                      title="关闭"
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="drawer-input-wrap">
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={ACCEPT_ATTR}
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) void enqueueFiles(files);
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = '';
                }}
              />
              {onSendAttachments && (
                <button
                  type="button"
                  className="drawer-attach-icon"
                  disabled={disabled || staging}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="添加附件"
                  title="添加附件 (.md, .docx, .pdf, 图片…)"
                >
                  <Paperclip size={16} aria-hidden="true" />
                </button>
              )}
              <textarea
                ref={textareaRef}
                className="drawer-input"
                value={text}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(e) => setText(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
              />
              <button
                type="button"
                className="drawer-send-icon"
                disabled={sendDisabled}
                onClick={() => void submit()}
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
