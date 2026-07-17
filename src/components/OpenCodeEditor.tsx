// OpenCodeEditor — independent editor window for a digital employee.
// Currently a placeholder shell; full IDE features (file tree, editor,
// terminal) will be added in Phase 3.

import { useEffect, useState } from 'react';

interface OpenCodeEditorProps {
  backendId: string;
  sessionId: string;
  cwd: string;
}

export function OpenCodeEditor({ backendId, sessionId, cwd }: OpenCodeEditorProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    // TODO: connect to OpenCode server and load session data
    setStatus('ready');
  }, [backendId, sessionId]);

  return (
    <div className="opencode-editor">
      <header className="opencode-editor-header">
        <button
          type="button"
          className="opencode-editor-back"
          onClick={() => window.close()}
        >
          ← 返回会议
        </button>
        <div className="opencode-editor-title">
          <span className="opencode-editor-backend">{backendId}</span>
          <span className="opencode-editor-session">{sessionId}</span>
        </div>
        <button
          type="button"
          className="opencode-editor-close"
          onClick={() => window.close()}
        >
          ✕
        </button>
      </header>
      <div className="opencode-editor-body">
        <aside className="opencode-editor-sidebar">
          <div className="opencode-editor-sidebar-title">文件</div>
          <div className="opencode-editor-file-tree">
            {/* File tree placeholder */}
            <div className="opencode-editor-file-item">📁 {cwd}</div>
          </div>
        </aside>
        <main className="opencode-editor-content">
          <div className="opencode-editor-code">
            {status === 'loading' && <div>加载中...</div>}
            {status === 'ready' && (
              <div className="opencode-editor-placeholder">
                <h2>OpenCode 编辑器</h2>
                <p>后端: {backendId}</p>
                <p>会话: {sessionId}</p>
                <p>目录: {cwd}</p>
                <p>Phase 3 将在此集成完整的 IDE 功能。</p>
              </div>
            )}
            {status === 'error' && <div>加载失败</div>}
          </div>
        </main>
        <aside className="opencode-editor-activity">
          <div className="opencode-editor-activity-title">活动日志</div>
          <div className="opencode-editor-activity-list">
            {/* Activity log placeholder */}
            <div className="opencode-editor-activity-item">会话已创建</div>
          </div>
        </aside>
      </div>
      <footer className="opencode-editor-terminal">
        <div className="opencode-editor-terminal-title">终端</div>
        <div className="opencode-editor-terminal-content">
          {/* Terminal placeholder */}
          <div className="opencode-editor-terminal-line">$</div>
        </div>
      </footer>
    </div>
  );
}
