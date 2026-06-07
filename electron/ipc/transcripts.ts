// transcripts IPC — load / append / clear per-cwd transcript files.
//
// `append` is one-way (`ipcMain.on` + `ipcRenderer.send`) — the renderer
// already ignores the result and we want to avoid a round-trip ack per
// transcript line (5–10/sec during busy meetings). Failures are logged here
// instead of bubbling back; a stuck disk shouldn't disrupt the UI but should
// still be visible in the main-process console.
//
// `load` and `clear` stay round-trip (`ipcMain.handle`) because their callers
// genuinely need the result.

import { ipcMain } from 'electron';
import {
  appendTranscript,
  clearTranscript,
  loadTranscript,
} from '../transcript-store.js';
import { errorMessage } from '../format-error.js';
import type { IpcContext } from './context.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function registerTranscriptsIpc(ctx: IpcContext): void {
  ipcMain.handle('transcripts:load', async (_e, payload: unknown) => {
    try {
      const cwd = (payload as { cwd?: unknown } | undefined)?.cwd;
      if (!isNonEmptyString(cwd)) {
        return { ok: false as const, error: 'invalid cwd' };
      }
      if (!ctx.registry.findByCwd(cwd)) {
        return { ok: false as const, error: 'cwd has no active session' };
      }
      const entries = await loadTranscript(cwd);
      return { ok: true as const, entries };
    } catch (err: unknown) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });

  ipcMain.on('transcripts:append', (_e, payload: unknown) => {
    const p = payload as { cwd?: unknown; entry?: unknown } | undefined;
    const cwd = p?.cwd;
    if (!isNonEmptyString(cwd)) {
      console.warn('[transcripts] append: invalid cwd, dropping');
      return;
    }
    if (!ctx.registry.findByCwd(cwd)) {
      console.warn('[transcripts] append: cwd has no active session, dropping');
      return;
    }
    if (!p || p.entry === undefined || p.entry === null) {
      console.warn('[transcripts] append: missing entry, dropping');
      return;
    }
    appendTranscript(cwd, p.entry).catch((err: unknown) => {
      console.error('[transcripts] append failed:', errorMessage(err));
    });
  });

  ipcMain.handle('transcripts:clear', async (_e, payload: unknown) => {
    try {
      const cwd = (payload as { cwd?: unknown } | undefined)?.cwd;
      if (!isNonEmptyString(cwd)) {
        return { ok: false as const, error: 'invalid cwd' };
      }
      if (!ctx.registry.findByCwd(cwd)) {
        return { ok: false as const, error: 'cwd has no active session' };
      }
      await clearTranscript(cwd);
      return { ok: true as const };
    } catch (err: unknown) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });
}
