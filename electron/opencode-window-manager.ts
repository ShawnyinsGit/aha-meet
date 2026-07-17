// opencode-window-manager.ts — manages independent OpenCode editor windows.
//
// Each digital employee (CLI backend) can have its own editor window. Windows
// are keyed by backendId + sessionId so multiple employees can have editors
// open simultaneously.

import { BrowserWindow, app, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface OpenCodeEditorWindowOptions {
  backendId: string;
  sessionId: string;
  cwd: string;
  title?: string;
}

interface EditorWindowEntry {
  win: BrowserWindow;
  options: OpenCodeEditorWindowOptions;
}

const editorWindows = new Map<string, EditorWindowEntry>();

function getThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7';
}

function windowKey(backendId: string, sessionId: string): string {
  return `${backendId}:${sessionId}`;
}

export function createOpenCodeEditorWindow(options: OpenCodeEditorWindowOptions): BrowserWindow {
  const key = windowKey(options.backendId, options.sessionId);
  const existing = editorWindows.get(key);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return existing.win;
  }

  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: options.title ?? `OpenCode - ${options.backendId}`,
    backgroundColor: getThemeBackgroundColor(),
    transparent: false,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const entry: EditorWindowEntry = { win, options };
  editorWindows.set(key, entry);

  win.on('closed', () => {
    editorWindows.delete(key);
  });

  // CSP injection
  const devOrigin = dev ? new URL(process.env.VITE_DEV_SERVER_URL!).origin : '';
  const devWsOrigin = dev ? devOrigin.replace(/^http/, 'ws') : '';
  const csp = dev
    ? [
        `default-src 'self' ${devOrigin}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}`,
        `style-src 'self' 'unsafe-inline' ${devOrigin}`,
        `img-src 'self' data: blob: ${devOrigin}`,
        `media-src 'self' blob: data: ${devOrigin}`,
        `font-src 'self' data: ${devOrigin}`,
        `connect-src 'self' ${devOrigin} ${devWsOrigin} http://localhost:*`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `media-src 'self' blob: data:`,
        `font-src 'self' data:`,
        `connect-src 'self' http://localhost:*`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ');

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });

  // Load the editor UI with query params so the renderer knows which
  // backend/session to display.
  const query = new URLSearchParams({
    view: 'opencode-editor',
    backendId: options.backendId,
    sessionId: options.sessionId,
    cwd: options.cwd,
  });

  if (dev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${query.toString()}`);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '..', 'dist', 'index.html'), { query: Object.fromEntries(query) });
  }

  return win;
}

export function closeOpenCodeEditorWindow(backendId: string, sessionId: string): void {
  const key = windowKey(backendId, sessionId);
  const entry = editorWindows.get(key);
  if (entry && !entry.win.isDestroyed()) {
    entry.win.close();
  }
}

export function listOpenCodeEditorWindows(): Array<{ backendId: string; sessionId: string; focused: boolean }> {
  const result: Array<{ backendId: string; sessionId: string; focused: boolean }> = [];
  for (const entry of editorWindows.values()) {
    if (!entry.win.isDestroyed()) {
      result.push({
        backendId: entry.options.backendId,
        sessionId: entry.options.sessionId,
        focused: entry.win.isFocused(),
      });
    }
  }
  return result;
}
