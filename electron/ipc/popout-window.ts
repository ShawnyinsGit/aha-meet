// popout-window.ts — opens a session tab or stage tab in a standalone window.
//
// Follows the same pattern as settings-window.ts: loads the same renderer HTML
// with a ?view=popout query param. The pop-out window is a full BrowserWindow
// with its own preload, CSP, and lifecycle.
//
// Two pop-out types:
// - session: opens an entire session (meeting) in a new window
// - stage: opens a single stage tab (browser, terminal, file) in a new window
//
// For v0.14.0, both show a placeholder view. Full rendering is deferred to
// a future iteration — the buttons and IPC plumbing are in place.

import { ipcMain, BrowserWindow, app, shell, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const popoutWindows = new Map<string, BrowserWindow>();

function getThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7';
}

function createPopoutWindow(id: string, viewType: string, title: string): BrowserWindow {
  const existing = popoutWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

  const win = new BrowserWindow({
    width: 900,
    height: 680,
    title,
    backgroundColor: getThemeBackgroundColor(),
    transparent: false,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  popoutWindows.set(id, win);

  win.on('closed', () => {
    popoutWindows.delete(id);
  });

  // CSP — same as settings window
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
        `connect-src 'self' ${devOrigin} ${devWsOrigin}`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self' 'wasm-unsafe-eval'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `media-src 'self' blob: data:`,
        `font-src 'self' data:`,
        `connect-src 'self'`,
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
      },
    });
  });

  // External links → OS browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch { /* ignore */ }
    return { action: 'deny' };
  });

  const query: Record<string, string> = {
    view: 'popout',
    type: viewType,
    id,
  };

  if (dev) {
    const sep = process.env.VITE_DEV_SERVER_URL!.includes('?') ? '&' : '?';
    const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}${sep}${qs}`).catch((err) => {
      console.error('[popout-window] loadURL error:', err);
    });
  } else {
    const htmlPath = join(__dirname, '..', '..', 'dist', 'index.html');
    win.loadFile(htmlPath, { query }).catch((err) => {
      console.error('[popout-window] loadFile error:', htmlPath, err);
    });
  }

  return win;
}

export function registerPopoutWindowIpc(): void {
  ipcMain.handle('popout:open-session', (_e, { tabId }: { tabId: string }) => {
    createPopoutWindow(`session-${tabId}`, 'session', `Session — ${tabId}`);
    return { ok: true };
  });

  ipcMain.handle('popout:open-stage', (_e, { windowId, type }: { windowId: string; type: string }) => {
    createPopoutWindow(`stage-${windowId}`, type, `${type} — ${windowId}`);
    return { ok: true };
  });

  ipcMain.handle('popout:close', (_e, { id }: { id: string }) => {
    const win = popoutWindows.get(id);
    if (win && !win.isDestroyed()) {
      win.close();
    }
    return { ok: true };
  });
}

/** Close all pop-out windows during app shutdown. */
export function closeAllPopoutWindows(): void {
  for (const [id, win] of popoutWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  popoutWindows.clear();
}
