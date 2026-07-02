// IPC handlers for the embedded browser panel.
//
// The renderer drives tab management, navigation, bounds synchronization, and
// visibility through these handlers. The BrowserTabManager owns all
// WebContentsView instances; this module is a thin IPC adapter.

import { ipcMain, BrowserWindow } from 'electron';
import { BrowserTabManager } from '../browser-tab-manager.js';
import { errorMessage } from '../format-error.js';

export function registerBrowserIpc(manager: BrowserTabManager): void {
  manager.onStateUpdate((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('browser:state-update', state);
    }
  });

  ipcMain.handle('browser:open-tab', async (_e, { url }: { url?: string }) => {
    try {
      const info = await manager.openTab(url);
      return { ok: true, tab: info };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:close-tab', (_e, { tabId }: { tabId: string }) => {
    try {
      manager.closeTab(tabId);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:set-active', (_e, { tabId }: { tabId: string }) => {
    try {
      manager.setActiveTab(tabId);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:navigate', async (_e, { tabId, url }: { tabId: string; url: string }) => {
    try {
      const result = await manager.navigate(tabId, url);
      return result;
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:back', (_e, { tabId }: { tabId: string }) => {
    try {
      manager.goBack(tabId);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:forward', (_e, { tabId }: { tabId: string }) => {
    try {
      manager.goForward(tabId);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:reload', (_e, { tabId }: { tabId: string }) => {
    try {
      manager.reload(tabId);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:set-bounds', (_e, bounds: { x: number; y: number; width: number; height: number; dpr: number }) => {
    try {
      manager.setBounds(bounds);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:set-visible', (_e, { visible }: { visible: boolean }) => {
    try {
      manager.setVisible(visible);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('browser:get-state', () => {
    return manager.snapshot();
  });

  ipcMain.handle('browser:capture-page', async (_e, { tabId }: { tabId?: string }) => {
    try {
      const result = await manager.capturePage(tabId);
      if (!result) return { ok: false, error: 'No active tab' };
      return { ok: true, ...result };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });
}
