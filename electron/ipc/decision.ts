import { ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { isInsideDecisionsRoot } from '../decisions.js';
import { errorMessage } from '../format-error.js';

export function registerDecisionIpc(): void {
  ipcMain.handle('decision:open', async (_e, decisionPath: unknown) => {
    if (typeof decisionPath !== 'string' || decisionPath.length === 0) {
      return { ok: false, error: 'path is required' };
    }
    if (!isInsideDecisionsRoot(decisionPath)) {
      return { ok: false, error: 'path is outside decisions root' };
    }
    if (!existsSync(decisionPath)) {
      return { ok: false, error: 'file not found' };
    }
    try {
      const err = await shell.openPath(decisionPath);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: errorMessage(e) };
    }
  });
}
