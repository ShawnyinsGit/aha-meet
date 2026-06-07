import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkerDeliveryFile } from '../types';
import type { DeliverySnapshot } from '../lib/meeting-store';
import { FileContent, ViewState, basename, formatSize, kindLabel } from './FileViewer';
import { useAutoScroll } from '../hooks/useAutoScroll';

interface DeliveryViewerProps {
  delivery: DeliverySnapshot;
  sessionId: string | null;
  aiSpeaking: boolean;
  onAccept: () => void;
  onRevise: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  onFileSelect?: (relativePath: string) => void;
}

export function DeliveryViewer({
  delivery,
  sessionId,
  aiSpeaking,
  onAccept,
  onRevise,
  onFileSelect,
}: DeliveryViewerProps) {
  const files = delivery.files;
  const [activePath, setActivePath] = useState<string>(
    files[0]?.snapshotRelativePath ?? files[0]?.path ?? '',
  );
  const [state, setState] = useState<ViewState>({ phase: 'loading' });
  const [feedback, setFeedback] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const loadTokenRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { onUserScroll, scrolling } = useAutoScroll({
    scrollRef,
    active: aiSpeaking,
  });

  useEffect(() => {
    const first = files[0]?.snapshotRelativePath ?? files[0]?.path ?? '';
    setActivePath(first);
    if (first) onFileSelect?.(first);
    setFeedback('');
    setFeedbackOpen(false);
    setToast(null);
  }, [delivery.taskId, files]);

  useEffect(() => {
    if (!activePath || !sessionId) {
      setState({ phase: 'error', message: '没有可预览的文件' });
      return;
    }
    const token = ++loadTokenRef.current;
    setState({ phase: 'loading' });
    void window.vibeMeet.documents
      .read(sessionId, activePath)
      .then((res) => {
        if (token !== loadTokenRef.current) return;
        if (!res.ok) {
          setState({ phase: 'error', message: res.error });
          return;
        }
        setState({ phase: 'ready', doc: res });
      })
      .catch((err: unknown) => {
        if (token !== loadTokenRef.current) return;
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Read failed',
        });
      });
  }, [activePath, sessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activePath, state.phase]);

  const handleAccept = useCallback(() => {
    onAccept();
  }, [onAccept]);

  const handleSubmitFeedback = useCallback(async () => {
    const trimmed = feedback.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setToast(null);
    try {
      const res = await onRevise(trimmed);
      if (res.ok) {
        setToast(
          res.route === 'worker'
            ? '修改意见已直接发回该 worker。'
            : '该 worker 已收尾，修改意见已交给 talker 重新派活。',
        );
        setFeedback('');
        setFeedbackOpen(false);
      } else {
        setToast(`发送失败：${res.error}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [feedback, onRevise, submitting]);

  const headerMeta = useMemo(() => {
    return `${files.length} 个交付物 · ${delivery.workerId}`;
  }, [files.length, delivery.workerId]);

  const activeFileName = basename(activePath);

  return (
    <div className="delivery-viewer">
      <header className="delivery-viewer-header">
        <div className="delivery-viewer-title">
          <span className="delivery-viewer-badge">交付验收</span>
          <h2>{delivery.title}</h2>
        </div>
        <div className="delivery-viewer-meta">{headerMeta}</div>
        {delivery.summary && (
          <p className="delivery-viewer-summary">{delivery.summary}</p>
        )}
      </header>

      <div className="delivery-viewer-body">
        <aside className="delivery-viewer-sidebar">
          {files.length === 0 ? (
            <div className="delivery-viewer-sidebar-empty">
              这一轮没有产出文件，只有总结。
            </div>
          ) : (
            <ul className="delivery-viewer-file-list">
              {files.map((f: WorkerDeliveryFile) => {
                const filePath = f.snapshotRelativePath ?? f.path;
                const isActive = filePath === activePath;
                return (
                  <li key={filePath}>
                    <button
                      type="button"
                      className={`delivery-viewer-file${isActive ? ' is-active' : ''}`}
                      onClick={() => { setActivePath(filePath); onFileSelect?.(filePath); }}
                      title={f.path}
                    >
                      <span className="delivery-viewer-file-name">
                        {basename(f.path)}
                      </span>
                      <span className="delivery-viewer-file-path">
                        {f.snapshotRelativePath ?? f.path}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section
          className={`delivery-viewer-content${scrolling ? ' auto-scrolling' : ''}`}
          ref={scrollRef}
          onWheel={onUserScroll}
          onTouchStart={onUserScroll}
        >
          <FileContent state={state} fileName={activeFileName} />
        </section>
      </div>

      <footer className="delivery-viewer-footer">
        {toast && <div className="delivery-viewer-toast">{toast}</div>}
        {!feedbackOpen ? (
          <div className="delivery-viewer-actions">
            <button
              type="button"
              className="delivery-viewer-btn delivery-viewer-btn-secondary"
              onClick={() => setFeedbackOpen(true)}
            >
              还要继续改
            </button>
            <button
              type="button"
              className="delivery-viewer-btn delivery-viewer-btn-primary"
              onClick={handleAccept}
            >
              通过 · 验收
            </button>
          </div>
        ) : (
          <div className="delivery-viewer-feedback">
            <textarea
              className="delivery-viewer-feedback-input"
              placeholder="说一下哪里不对、希望怎么改…"
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={submitting}
              autoFocus
            />
            <div className="delivery-viewer-actions">
              <button
                type="button"
                className="delivery-viewer-btn delivery-viewer-btn-secondary"
                onClick={() => {
                  setFeedbackOpen(false);
                  setFeedback('');
                }}
                disabled={submitting}
              >
                取消
              </button>
              <button
                type="button"
                className="delivery-viewer-btn delivery-viewer-btn-primary"
                onClick={handleSubmitFeedback}
                disabled={submitting || feedback.trim().length === 0}
              >
                {submitting ? '发送中…' : '把意见发回去'}
              </button>
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
