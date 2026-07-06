// settings-window.ts — opens settings as a standalone BrowserWindow, separate
// from the main app. The settings window loads the same renderer HTML with a
// ?view=settings query param, which makes main.tsx render SettingsWindow
// instead of the full App. Background is opaque (solid color, no glass).

import { ipcMain, BrowserWindow, app, shell, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let settingsWindow: BrowserWindow | null = null;

function getThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7';
}

function createSettingsWindow(): BrowserWindow {
  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

  const win = new BrowserWindow({
    width: 680,
    height: 780,
    title: '设置',
    backgroundColor: getThemeBackgroundColor(),
    transparent: false,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('closed', () => {
    settingsWindow = null;
  });

  // Inject the same CSP as the main window so the settings renderer can load
  // Vite HMR in dev and run safely in production.
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

  // External links → OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch { /* ignore unparseable URLs */ }
    return { action: 'deny' };
  });

  if (dev) {
    const sep = process.env.VITE_DEV_SERVER_URL!.includes('?') ? '&' : '?';
    void win.loadURL(`${process.env.VITE_DEV_SERVER_URL}${sep}view=settings`);
  } else {
    void win.loadFile(join(__dirname, '..', 'dist', 'index.html'), {
      query: { view: 'settings' },
    });
  }

  return win;
}

export function registerSettingsWindowIpc(): void {
  ipcMain.handle('settings:open-window', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      return { ok: true };
    }
    settingsWindow = createSettingsWindow();
    return { ok: true };
  });

  ipcMain.handle('settings:close-window', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
    return { ok: true };
  });
}
