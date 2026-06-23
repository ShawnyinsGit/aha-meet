import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { DeliveryFileKind, DocumentReadResult } from '../types';

interface FileViewerProps {
  relativePath: string;
  sessionId: string | null;
  onClose: () => void;
}

export type ViewState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; doc: Extract<DocumentReadResult, { ok: true }> };

export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function kindLabel(kind: DeliveryFileKind): string {
  switch (kind) {
    case 'text': return 'TEXT';
    case 'image': return 'IMG';
    case 'video': return 'VIDEO';
    case 'word': return 'DOCX';
    case 'pdf': return 'PDF';
    case 'pptx': return 'PPTX';
    case 'xlsx': return 'XLSX';
    case 'binary': return 'BIN';
    case 'missing': return 'MISSING';
    default: return 'FILE';
  }
}

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const HTML_EXTS = new Set(['html', 'htm']);
const SVG_EXT = 'svg';

export function FileViewer({ relativePath, sessionId, onClose }: FileViewerProps) {
  const [state, setState] = useState<ViewState>({ phase: 'loading' });
  const loadTokenRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionId || !relativePath) {
      setState({ phase: 'error', message: 'No file selected' });
      return;
    }

    const token = ++loadTokenRef.current;
    setState({ phase: 'loading' });

    void window.vibeMeet.documents
      .read(sessionId, relativePath)
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
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'Read failed' });
      });
  }, [relativePath, sessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [relativePath, state.phase]);

  const fileName = basename(relativePath);

  return (
    <div className="file-viewer">
      <header className="file-viewer-header">
        <div className="file-viewer-path" title={relativePath}>
          <span className="file-viewer-name">{fileName}</span>
          <span className="file-viewer-dir">{relativePath}</span>
        </div>
        <div className="file-viewer-actions">
          <button
            type="button"
            className="file-viewer-action-btn"
            onClick={() => {
              if (sessionId) void window.vibeMeet.documents.openExternal(sessionId, relativePath).then((res) => {
                if (res && !res.ok) console.warn('[FileViewer] open-external failed:', res.error);
              });
            }}
            aria-label="用系统应用打开"
            title="用系统应用打开"
          >
            <ExternalLink size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-viewer-close"
            onClick={onClose}
            aria-label="Close file viewer"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="file-viewer-content" ref={scrollRef}>
        <FileContent state={state} fileName={fileName} sessionId={sessionId} />
      </div>
    </div>
  );
}

export function FileContent({
  state,
  fileName,
  sessionId,
}: {
  state: ViewState;
  fileName: string;
  sessionId?: string | null;
}) {
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

  useEffect(() => {
    if (!mediaUrl || !mediaUrl.startsWith('blob:')) return;
    return () => { URL.revokeObjectURL(mediaUrl); };
  }, [mediaUrl]);

  const htmlBlobUrl = useMemo(() => {
    if (state.phase !== 'ready') return null;
    const { doc } = state;
    const ext = extensionOf(doc.name);
    if (doc.kind === 'text' && HTML_EXTS.has(ext) && doc.text) {
      return URL.createObjectURL(new Blob([doc.text], { type: 'text/html' }));
    }
    return null;
  }, [state]);

  useEffect(() => {
    if (!htmlBlobUrl) return;
    return () => { URL.revokeObjectURL(htmlBlobUrl); };
  }, [htmlBlobUrl]);

  const pdfBlobUrl = useMemo(() => {
    if (state.phase !== 'ready') return null;
    const { doc } = state;
    if (doc.kind === 'pdf' && doc.data) {
      return URL.createObjectURL(new Blob([doc.data as BlobPart], { type: 'application/pdf' }));
    }
    return null;
  }, [state]);

  useEffect(() => {
    if (!pdfBlobUrl) return;
    return () => { URL.revokeObjectURL(pdfBlobUrl); };
  }, [pdfBlobUrl]);

  const xlsxBlobUrl = useMemo(() => {
    if (state.phase !== 'ready') return null;
    const { doc } = state;
    if (doc.kind === 'xlsx' && doc.text) {
      const wrapped = wrapXlsxHtml(doc.text);
      return URL.createObjectURL(new Blob([wrapped], { type: 'text/html' }));
    }
    return null;
  }, [state]);

  useEffect(() => {
    if (!xlsxBlobUrl) return;
    return () => { URL.revokeObjectURL(xlsxBlobUrl); };
  }, [xlsxBlobUrl]);

  const svgBlobUrl = useMemo(() => {
    if (state.phase !== 'ready') return null;
    const { doc } = state;
    const ext = extensionOf(doc.name);
    if (doc.kind === 'text' && ext === SVG_EXT) {
      const source = doc.data ?? (doc.text ? new TextEncoder().encode(doc.text) : null);
      if (source) {
        return URL.createObjectURL(new Blob([source as BlobPart], { type: 'image/svg+xml' }));
      }
    }
    return null;
  }, [state]);

  useEffect(() => {
    if (!svgBlobUrl) return;
    return () => { URL.revokeObjectURL(svgBlobUrl); };
  }, [svgBlobUrl]);

  if (state.phase === 'loading') {
    return <div className="file-viewer-status">Loading...</div>;
  }
  if (state.phase === 'error') {
    return <div className="file-viewer-status file-viewer-error">{state.message}</div>;
  }

  const { doc } = state;
  const ext = extensionOf(doc.name);
  const sizeLine = `${formatSize(doc.sizeBytes)} · ${kindLabel(doc.kind)}`;

  if (doc.kind === 'text' && ext === SVG_EXT && svgBlobUrl) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <div className="file-viewer-media">
          <img src={svgBlobUrl} alt={fileName} />
        </div>
      </div>
    );
  }

  if (doc.kind === 'text' && HTML_EXTS.has(ext) && htmlBlobUrl) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <iframe
          className="file-viewer-iframe"
          src={htmlBlobUrl}
          sandbox=""
          title={doc.name}
        />
      </div>
    );
  }

  if (doc.kind === 'text' && MARKDOWN_EXTS.has(ext) && doc.text) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}{doc.truncated ? ' · truncated' : ''}</div>
        <div className="file-viewer-markdown">
          <MarkdownRenderer text={doc.text} />
        </div>
      </div>
    );
  }

  if (doc.kind === 'word' && doc.data) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <DocxRenderer data={doc.data} />
      </div>
    );
  }

  if ((doc.kind === 'text' || doc.kind === 'word') && doc.text !== undefined) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}{doc.truncated ? ' · truncated' : ''}</div>
        <pre className="file-viewer-text">{doc.text}</pre>
      </div>
    );
  }

  if (doc.kind === 'pdf' && pdfBlobUrl) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <iframe
          className="file-viewer-iframe"
          src={pdfBlobUrl}
          sandbox=""
          title={doc.name}
        />
      </div>
    );
  }

  if (doc.kind === 'pdf' && doc.text !== undefined) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <pre className="file-viewer-text">{doc.text}</pre>
      </div>
    );
  }

  if (doc.kind === 'pptx' && doc.data) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <PptxRenderer data={doc.data} />
      </div>
    );
  }

  if (doc.kind === 'xlsx' && xlsxBlobUrl) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <iframe
          className="file-viewer-iframe"
          src={xlsxBlobUrl}
          sandbox=""
          title={doc.name}
        />
      </div>
    );
  }

  if (doc.kind === 'image' && mediaUrl) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <div className="file-viewer-media">
          <img src={mediaUrl} alt={doc.name} />
        </div>
      </div>
    );
  }

  if (doc.kind === 'video' && mediaUrl) {
    return (
      <div className="file-viewer-pane">
        <div className="file-viewer-meta">{sizeLine}</div>
        <div className="file-viewer-media">
          <video controls src={mediaUrl} />
        </div>
      </div>
    );
  }

  return (
    <div className="file-viewer-pane file-viewer-binary">
      <div className="file-viewer-meta">{sizeLine}</div>
      <div className="file-viewer-status">
        无法在应用内预览此文件
        <div className="file-viewer-path-hint">{doc.path}</div>
        <button
          type="button"
          className="file-viewer-open-btn"
          onClick={() => {
            if (sessionId) void window.vibeMeet.documents.openExternal(sessionId, doc.path).then((res) => {
              if (res && !res.ok) console.warn('[FileViewer] open-external failed:', res.error);
            });
          }}
        >
          用系统应用打开
        </button>
      </div>
    </div>
  );
}

function DocxRenderer({ data }: { data: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    el.innerHTML = '';
    import('docx-preview').then(({ renderAsync }) => {
      if (cancelled) return;
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      return renderAsync(buffer, el, undefined, {
        className: 'docx-preview-body',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        useBase64URL: true,
      } as Parameters<typeof renderAsync>[3]);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'DOCX 渲染失败');
    });
    return () => { cancelled = true; };
  }, [data]);

  if (error) return <div className="file-viewer-status file-viewer-error">{error}</div>;
  return <div ref={containerRef} className="file-viewer-docx" />;
}

function PptxRenderer({ data }: { data: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    el.innerHTML = '';
    import('pptx-preview').then((mod) => {
      if (cancelled) return;
      const pptx = mod.default || mod;
      const width = el.clientWidth - 48;
      const height = Math.round(width * 9 / 16);
      pptx.init(el, width, height);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      return pptx.preview(buffer);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'PPTX 渲染失败');
    });
    return () => { cancelled = true; };
  }, [data]);

  if (error) return <div className="file-viewer-status file-viewer-error">{error}</div>;
  return <div ref={containerRef} className="file-viewer-pptx" />;
}

function wrapXlsxHtml(tableHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; margin: 0; background: #fff; color: #222; }
table { border-collapse: collapse; width: 100%; margin-bottom: 24px; font-size: 13px; }
td, th { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: left; white-space: nowrap; }
th { background: #f5f5f5; font-weight: 600; position: sticky; top: 0; }
tr:nth-child(even) { background: #fafafa; }
h3 { margin: 20px 0 8px; font-size: 15px; color: #555; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; }
</style></head><body>${tableHtml}</body></html>`;
}

function MarkdownRenderer({ text }: { text: string }) {
  const htmlContent = useMemo(() => simpleMarkdown(text), [text]);
  return (
    <div
      className="file-viewer-md-body"
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function simpleMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';

  for (const raw of lines) {
    if (!inCode && raw.startsWith('```')) {
      inCode = true;
      codeLang = raw.slice(3).trim();
      out.push(`<pre class="md-code-block"><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ''}>`);
      continue;
    }
    if (inCode) {
      if (raw.startsWith('```')) {
        inCode = false;
        out.push('</code></pre>');
        continue;
      }
      out.push(escapeHtml(raw));
      out.push('\n');
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) { out.push('<br/>'); continue; }

    const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${escapeHtml(h[2])}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      out.push(`<li>${inlineFormat(trimmed.slice(2))}</li>`);
      continue;
    }

    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      out.push(`<li>${inlineFormat(numMatch[2])}</li>`);
      continue;
    }

    if (trimmed.startsWith('> ')) {
      out.push(`<blockquote>${inlineFormat(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    if (trimmed.startsWith('---') || trimmed.startsWith('***') || trimmed.startsWith('___')) {
      out.push('<hr/>');
      continue;
    }

    out.push(`<p>${inlineFormat(trimmed)}</p>`);
  }

  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function sanitizeHref(url: string): string {
  const decoded = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const scheme = decoded.trim().toLowerCase().replace(/[\x00-\x1f\x7f]/g, '');
  if (/^(javascript|vbscript|data|blob):/i.test(scheme)) return '';
  return url;
}

function inlineFormat(s: string): string {
  let result = escapeHtml(s);
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, href: string) => {
    const safe = sanitizeHref(href);
    if (!safe) return escapeHtml(text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
    return `<a href="${safe}" target="_blank" rel="noopener">${text}</a>`;
  });
  return result;
}
