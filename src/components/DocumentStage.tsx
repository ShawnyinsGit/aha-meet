import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeliveryFileKind, DocumentReadResult, WorkerDeliveryFile } from '../types';
import type { DeliverySnapshot } from '../lib/meeting-store';

interface DocumentStageProps {
  delivery: DeliverySnapshot;
  sessionId: string | null;
  onAccept: () => void;
  onRevise: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}

type PreviewState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; doc: Extract<DocumentReadResult, { ok: true }> };

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function kindLabel(kind: DeliveryFileKind): string {
  switch (kind) {
    case 'text': return 'TEXT';
    case 'image': return 'IMG';
    case 'video': return 'VIDEO';
    case 'word': return 'DOCX';
    case 'pdf': return 'PDF';
    case 'binary': return 'BIN';
    case 'missing': return 'MISSING';
    default: return 'FILE';
  }
}

export function DocumentStage({ delivery, sessionId, onAccept, onRevise }: DocumentStageProps) {
  const files = delivery.files;
  const [activePath, setActivePath] = useState<string | null>(files[0]?.path ?? null);
  const [preview, setPreview] = useState<PreviewState>({ phase: 'loading' });
  const [feedback, setFeedback] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Each load attempt gets a token so a late response from a stale path can't
  // overwrite the preview the user is currently looking at.
  const loadTokenRef = useRef(0);
  const textRef = useRef<HTMLPreElement | null>(null);

  // When a fresher delivery lands the same component is reused — reset
  // selection + feedback so the old text doesn't leak into the next round.
  useEffect(() => {
    setActivePath(files[0]?.path ?? null);
    setFeedback('');
    setFeedbackOpen(false);
    setToast(null);
  }, [delivery.taskId, files]);

  useEffect(() => {
    if (!activePath) {
      setPreview({ phase: 'error', message: '没有可预览的文件' });
      return;
    }
    const token = ++loadTokenRef.current;
    setPreview({ phase: 'loading' });
    void window.vibeMeet.documents
      .read(sessionId, activePath)
      .then((res) => {
        if (token !== loadTokenRef.current) return;
        if (!res.ok) {
          setPreview({ phase: 'error', message: res.error });
          return;
        }
        setPreview({ phase: 'ready', doc: res });
      })
      .catch((err: unknown) => {
        if (token !== loadTokenRef.current) return;
        const message = err instanceof Error ? err.message : 'Read failed';
        setPreview({ phase: 'error', message });
      });
  }, [activePath, sessionId]);

  // Scroll the text preview back to the top whenever the underlying file
  // changes — otherwise jumping between a 5kb and a 5MB file leaves the user
  // staring at line 8000 of an unrelated doc.
  useEffect(() => {
    if (textRef.current) textRef.current.scrollTop = 0;
  }, [activePath, preview.phase]);

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
        setToast(res.route === 'worker'
          ? '修改意见已直接发回该 worker。'
          : '该 worker 已收尾，修改意见已交给 talker 重新派活。');
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
    const count = files.length;
    return `${count} 个交付物 · ${delivery.workerId}`;
  }, [files.length, delivery.workerId]);

  return (
    <div className="docstage">
      <header className="docstage-header">
        <div className="docstage-title">
          <span className="docstage-badge">交付验收</span>
          <h2>{delivery.title}</h2>
        </div>
        <div className="docstage-meta">{headerMeta}</div>
        {delivery.summary && (
          <p className="docstage-summary">{delivery.summary}</p>
        )}
      </header>

      <div className="docstage-body">
        <aside className="docstage-files">
          {files.length === 0 ? (
            <div className="docstage-files-empty">这一轮没有产出文件，只有总结。</div>
          ) : (
            <ul className="docstage-file-list">
              {files.map((f: WorkerDeliveryFile) => {
                const isActive = f.path === activePath;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={`docstage-file${isActive ? ' is-active' : ''}`}
                      onClick={() => setActivePath(f.path)}
                      title={f.path}
                    >
                      <span className="docstage-file-name">{basename(f.path)}</span>
                      <span className="docstage-file-path">{f.path}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="docstage-preview">
          <PreviewPane state={preview} textRef={textRef} />
        </section>
      </div>

      <footer className="docstage-footer">
        {toast && <div className="docstage-toast">{toast}</div>}
        {!feedbackOpen ? (
          <div className="docstage-actions">
            <button
              type="button"
              className="docstage-btn docstage-btn-secondary"
              onClick={() => setFeedbackOpen(true)}
            >
              还要继续改
            </button>
            <button
              type="button"
              className="docstage-btn docstage-btn-primary"
              onClick={handleAccept}
            >
              通过 · 验收
            </button>
          </div>
        ) : (
          <div className="docstage-feedback">
            <textarea
              className="docstage-feedback-input"
              placeholder="说一下哪里不对、希望怎么改…"
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={submitting}
              autoFocus
            />
            <div className="docstage-actions">
              <button
                type="button"
                className="docstage-btn docstage-btn-secondary"
                onClick={() => { setFeedbackOpen(false); setFeedback(''); }}
                disabled={submitting}
              >
                取消
              </button>
              <button
                type="button"
                className="docstage-btn docstage-btn-primary"
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

interface PreviewPaneProps {
  state: PreviewState;
  textRef: React.MutableRefObject<HTMLPreElement | null>;
}

function PreviewPane({ state, textRef }: PreviewPaneProps) {
  // Build a Blob URL once per (data, mediaType) pair so the underlying bytes
  // don't get re-encoded into a data URL on every render. Falls back to a
  // base64 data URL when an older main process delivers `dataBase64` only.
  const mediaUrl = useMemo(() => {
    if (state.phase !== 'ready') return null;
    const { doc } = state;
    if (doc.kind !== 'image' && doc.kind !== 'video') return null;
    if (!doc.mediaType) return null;
    if (doc.data) {
      return URL.createObjectURL(new Blob([doc.data as BlobPart], { type: doc.mediaType }));
    }
    if (doc.dataBase64) {
      return `data:${doc.mediaType};base64,${doc.dataBase64}`;
    }
    return null;
  }, [state]);

  // Revoke the object URL when the preview transitions away from this doc.
  // Skip the revoke for the `data:` fallback string — `revokeObjectURL` on a
  // non-blob URL is a no-op, but cleaner to gate it.
  useEffect(() => {
    if (!mediaUrl) return;
    if (!mediaUrl.startsWith('blob:')) return;
    return () => {
      URL.revokeObjectURL(mediaUrl);
    };
  }, [mediaUrl]);

  if (state.phase === 'loading') {
    return <div className="docstage-preview-status">读取中…</div>;
  }
  if (state.phase === 'error') {
    return <div className="docstage-preview-status docstage-preview-error">{state.message}</div>;
  }
  const { doc } = state;
  const sizeLine = `${formatSize(doc.sizeBytes)} · ${kindLabel(doc.kind)}`;

  if (doc.kind === 'text' || doc.kind === 'word' || doc.kind === 'pdf') {
    return (
      <div className="docstage-preview-pane">
        <div className="docstage-preview-meta">
          <span className="docstage-preview-name">{doc.name}</span>
          <span className="docstage-preview-size">
            {sizeLine}{doc.truncated ? ' · 已截断' : ''}
          </span>
        </div>
        <pre ref={textRef} className="docstage-preview-text">{doc.text ?? ''}</pre>
      </div>
    );
  }

  if (doc.kind === 'image' && mediaUrl) {
    return (
      <div className="docstage-preview-pane">
        <div className="docstage-preview-meta">
          <span className="docstage-preview-name">{doc.name}</span>
          <span className="docstage-preview-size">{sizeLine}</span>
        </div>
        <div className="docstage-preview-media">
          <img src={mediaUrl} alt={doc.name} />
        </div>
      </div>
    );
  }

  if (doc.kind === 'video' && mediaUrl) {
    return (
      <div className="docstage-preview-pane">
        <div className="docstage-preview-meta">
          <span className="docstage-preview-name">{doc.name}</span>
          <span className="docstage-preview-size">{sizeLine}</span>
        </div>
        <div className="docstage-preview-media">
          <video controls src={mediaUrl} />
        </div>
      </div>
    );
  }

  // binary / unknown — placeholder card with size + path.
  return (
    <div className="docstage-preview-pane docstage-preview-binary">
      <div className="docstage-preview-meta">
        <span className="docstage-preview-name">{doc.name}</span>
        <span className="docstage-preview-size">{sizeLine}</span>
      </div>
      <div className="docstage-preview-status">
        这个文件不便在页面里直接预览，可以打开访达查看。
        <div className="docstage-preview-path">{doc.path}</div>
      </div>
    </div>
  );
}
