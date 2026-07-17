// opencode-editor.ts — IPC handlers for OpenCode editor windows.

import { ipcMain } from 'electron';
import {
  createOpenCodeEditorWindow,
  closeOpenCodeEditorWindow,
  listOpenCodeEditorWindows,
} from '../opencode-window-manager.js';

export function registerOpenCodeEditorIpc(): void {
  ipcMain.handle('opencode-editor:open', (_event, payload: {
    backendId: string;
    sessionId: string;
    cwd: string;
    title?: string;
  }) => {
    try {
      createOpenCodeEditorWindow(payload);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('opencode-editor:close', (_event, payload: {
    backendId: string;
    sessionId: string;
  }) => {
    try {
      closeOpenCodeEditorWindow(payload.backendId, payload.sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('opencode-editor:list', () => {
    try {
      return { ok: true, windows: listOpenCodeEditorWindows() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
