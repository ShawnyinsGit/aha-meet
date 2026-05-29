// sessions:* IPC — tab/meeting lifecycle. The renderer drives:
//   sessions:open(cwd, greeting)   → spin up an Orchestrator, register slot
//   sessions:close(id)             → graceful end + drop slot
//   sessions:set-active(id)        → focus a tab (mic/TTS/screen follow)
//   sessions:list                  → current live slots (metadata only)
//   sessions:list-restore          → openTabs + lastActiveCwd from last quit
//
// cwd uniqueness is enforced inside SessionRegistry.open(): if the cwd already
// has a live slot, we return { ok:false, error:'duplicate', sessionId:<existing>}
// and the renderer is expected to switch to that tab instead of opening a new
// one. Lazy restore (renderer hydrates placeholder tabs without spawning
// Orchestrators until clicked) means listRestore returns metadata only.

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { formatError } from '../format-error.js';
import {
  getSettings,
  pushRecentCwd,
  setOpenTabs,
} from '../store.js';
import type { IpcContext } from './context.js';

interface OpenPayload {
  cwd?: unknown;
  greeting?: unknown;
}

// Coalesce rapid-fire `setOpenTabs` writes (lobby-restore can fire 5+
// snapshots in 50 ms when the user had several tabs open last quit).
// 100 ms is below human-perceptible latency but easily long enough to fold
// the burst into a single fs write. `before-quit` calls `flushOpenTabsNow`
// to make sure the final state always lands on disk.
const SNAPSHOT_DEBOUNCE_MS = 100;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotPendingCtx: IpcContext | null = null;

function writeSnapshotNow(ctx: IpcContext): void {
  const tabs = ctx.registry.list().map((s) => ({ cwd: s.cwd, openedAt: s.openedAt }));
  const active = ctx.registry.getActive();
  void setOpenTabs(tabs, active?.cwd ?? null).catch((err) => {
    console.error('[sessions] failed to persist openTabs:', err);
  });
}

function snapshotOpenTabs(ctx: IpcContext): void {
  snapshotPendingCtx = ctx;
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    const pending = snapshotPendingCtx;
    snapshotPendingCtx = null;
    if (pending) writeSnapshotNow(pending);
  }, SNAPSHOT_DEBOUNCE_MS);
}

/** Cancels the pending debounce timer (if any) and writes the latest registry
 *  snapshot synchronously-scheduled (still async on disk). Call sites that
 *  need "this state must hit disk before I return": `sessions:close`,
 *  `before-quit`. */
export function flushOpenTabsNow(ctx: IpcContext): void {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  snapshotPendingCtx = null;
  writeSnapshotNow(ctx);
}

export function registerSessionsIpc(ctx: IpcContext): void {
  ipcMain.handle('sessions:open', async (_e, payload: OpenPayload) => {
    try {
      const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
      const greeting = typeof payload?.greeting === 'string' ? payload.greeting : undefined;
      const candidateCwd = rawCwd && rawCwd.length > 0 ? rawCwd : homedir();

      // S8: validate cwd before doing anything. A compromised renderer could
      // pass /etc or any path; verify it exists, is a directory, and is
      // readable by us. Resolve to absolute form so relative segments like
      // "../" don't slip through.
      const resolvedCwd = path.resolve(candidateCwd);
      try {
        const stat = await fs.stat(resolvedCwd);
        if (!stat.isDirectory()) {
          return { ok: false, error: `Invalid cwd: not a directory (${resolvedCwd})` };
        }
        await fs.access(resolvedCwd, fsConstants.R_OK);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Invalid cwd: ${msg}` };
      }

      // cwd uniqueness — bail before constructing an Orchestrator.
      const existing = ctx.registry.findByCwd(resolvedCwd);
      if (existing) {
        ctx.registry.setActive(existing.id);
        snapshotOpenTabs(ctx);
        return { ok: false, error: 'duplicate', sessionId: existing.id, cwd: resolvedCwd };
      }

      const sessionId = randomUUID();
      // Wait for the launch-time shadow-home build the first time. After
      // launch+1 s this resolves immediately; on a manifest-cached relaunch
      // it's effectively instant.
      const shadow = await ctx.awaitClaudeShadowHome();
      const workerEnv = shadow ? { ...mergedSubprocessEnv(), HOME: shadow } : undefined;

      // Pre-bind sessionId into the emit closure so every event this
      // orchestrator emits is automatically routed to the right renderer slot.
      const orch = new Orchestrator({
        emit: (e) => ctx.emitToRenderer({ ...e, sessionId }),
        cwd: resolvedCwd,
        autoApproveScope: ctx.getAutoApprove(),
        workerEnv,
        confirmDestructive: ctx.nativeConfirmDestructive,
      });

      const result = ctx.registry.open(sessionId, resolvedCwd, orch);
      if (result.kind === 'duplicate') {
        // Race: another open landed between our findByCwd and open. Drop the
        // half-built orchestrator, focus the winner, return duplicate.
        try { orch.end(); } catch { /* ignore */ }
        ctx.registry.setActive(result.existingId);
        snapshotOpenTabs(ctx);
        return { ok: false, error: 'duplicate', sessionId: result.existingId, cwd: resolvedCwd };
      }

      // First slot becomes active automatically inside registry.open(). For
      // subsequent opens we explicitly hand focus to the new tab — matches
      // user expectation that "+ Open another folder" jumps to that tab.
      ctx.registry.setActive(sessionId);

      // Snapshot openTabs immediately so a crash before start completes
      // doesn't lose the tab record. The renderer is told the slot is
      // 'starting' and will gate input until the session-ready event lands.
      snapshotOpenTabs(ctx);

      // Fire-and-forget the SDK spawn. The renderer holds slot.status
      // 'starting' until session-ready/session-start-failed arrives.
      void (async () => {
        try {
          await orch.start(greeting);
          // Slot may have been closed by the user while we were starting —
          // bail without emitting if so (orch.end was already called).
          if (!ctx.registry.get(sessionId)) return;
          ctx.emitToRenderer({
            source: 'system',
            sessionId,
            event: { kind: 'session-ready' },
          });
          // Persist recent + open tab list only after a successful start.
          // Only real user picks land in recents (skip the homedir fallback
          // when the user typed nothing) — otherwise "I never picked
          // anything" becomes indistinguishable from "I last picked my home
          // folder".
          if (rawCwd && rawCwd.length > 0) {
            pushRecentCwd(resolvedCwd).catch((err) => {
              console.error('[settings] failed to persist recentCwds:', err);
            });
          }
          snapshotOpenTabs(ctx);
        } catch (err: unknown) {
          const msg = formatError(err);
          // If the slot was already closed (user bailed), don't bother
          // emitting failed — the renderer no longer has a tab to update.
          const stillOpen = !!ctx.registry.get(sessionId);
          ctx.registry.close(sessionId);
          try { orch.end(); } catch { /* ignore */ }
          if (stillOpen) {
            ctx.emitToRenderer({
              source: 'system',
              sessionId,
              event: { kind: 'session-start-failed', error: `start failed: ${msg}` },
            });
          }
          // Re-snapshot so openTabs no longer lists the dead slot.
          snapshotOpenTabs(ctx);
        }
      })();

      return { ok: true, sessionId, cwd: resolvedCwd, status: 'starting' as const };
    } catch (err: unknown) {
      const msg = formatError(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('sessions:close', async (_e, payload: { id?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const slot = ctx.registry.get(id);
    if (!slot) return { ok: false, error: 'not-found' };
    try { slot.orchestrator.end(); } catch { /* ignore */ }
    ctx.registry.close(id);
    // Close is the one path where "tab still on disk after close" would be a
    // real bug — tests that re-launch immediately rely on it. Flush rather
    // than debounce.
    flushOpenTabsNow(ctx);
    return { ok: true, activeId: ctx.registry.getActiveId() };
  });

  ipcMain.handle('sessions:set-active', async (_e, payload: { id?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const ok = ctx.registry.setActive(id);
    if (!ok) return { ok: false, error: 'not-found' };
    snapshotOpenTabs(ctx);
    return { ok: true };
  });

  ipcMain.handle('sessions:list', async () => {
    return {
      ok: true,
      sessions: ctx.registry.list(),
      activeId: ctx.registry.getActiveId(),
    };
  });

  ipcMain.handle('sessions:list-restore', async () => {
    const s = getSettings();
    return {
      ok: true,
      openTabs: Array.isArray(s.openTabs) ? s.openTabs : [],
      recentCwds: Array.isArray(s.recentCwds) ? s.recentCwds : [],
      lastActiveCwd: typeof s.lastActiveCwd === 'string' ? s.lastActiveCwd : null,
    };
  });
}
