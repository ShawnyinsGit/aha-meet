import { ipcMain, shell } from 'electron';
import { realpath } from 'node:fs/promises';
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
    try {
      const resolved = await realpath(decisionPath);
      if (!isInsideDecisionsRoot(resolved)) {
        return { ok: false, error: 'symlink target is outside decisions root' };
      }
      const err = await shell.openPath(resolved);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, error: errorMessage(e) };
    }
  });
}
