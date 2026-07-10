import { ExternalLink } from 'lucide-react';

/**
 * Placeholder view for pop-out windows (session or stage tabs opened in a
 * standalone BrowserWindow). Full rendering is deferred to a future iteration.
 *
 * Query params: ?view=popout&type={session|browser|terminal|file}&id={id}
 */
export function PopoutPlaceholder() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get('type') ?? 'unknown';
  const id = params.get('id') ?? '';

  return (
    <div className="popout-placeholder">
      <ExternalLink size={48} strokeWidth={1.5} />
      <h1>独立窗口</h1>
      <p className="popout-type">
        {type === 'session' ? '会话' : type === 'browser' ? '浏览器' : type === 'terminal' ? '终端' : type === 'file' ? '文件' : type}
      </p>
      <p className="popout-hint">此内容已在独立窗口中打开。请在主窗口中操作。</p>
    </div>
  );
}
