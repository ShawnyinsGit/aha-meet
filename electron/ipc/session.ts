import { ipcMain } from 'electron';
import { homedir } from 'node:os';
import { Orchestrator } from '../orchestrator.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { formatError } from '../format-error.js';
import { updateSettings } from '../store.js';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { IpcContext } from './context.js';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const);
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as Set<string>).has(v);
}

export function registerSessionIpc(ctx: IpcContext): void {
  ipcMain.handle('session:start', async (_e, cwd: string, greeting?: string) => {
    try {
      const existing = ctx.getOrchestrator();
      if (existing) {
        existing.end();
        ctx.setOrchestrator(null);
      }
      const resolvedCwd = cwd && cwd.length > 0 ? cwd : homedir();
      // If we built a shadow home, splice HOME into the worker subprocess env
      // so the SDK's `settingSources: ['user']` reads our merged tree (bundled
      // ECC defaults + user's overrides) instead of the bare `~/.claude`.
      const shadow = ctx.getClaudeShadowHome();
      const workerEnv = shadow
        ? { ...mergedSubprocessEnv(), HOME: shadow }
        : undefined;
      const next = new Orchestrator({
        emit: ctx.emitToRenderer,
        cwd: resolvedCwd,
        autoApproveScope: ctx.getAutoApprove(),
        workerEnv,
        confirmDestructive: ctx.nativeConfirmDestructive,
      });
      ctx.setOrchestrator(next);
      ctx.setCurrentCwd(resolvedCwd);
      await next.start(greeting);
      // Persist the chosen directory so the next launch can default to it.
      // Only save real user picks, not the homedir fallback when the user typed
      // nothing — saving the fallback would make "I never picked anything"
      // indistinguishable from "I last picked my home folder".
      if (cwd && cwd.length > 0) {
        try { updateSettings({ lastCwd: resolvedCwd }); } catch (err) {
          console.error('[settings] failed to persist lastCwd:', err);
        }
      }
      return { ok: true, cwd: resolvedCwd };
    } catch (err: unknown) {
      const msg = formatError(err);
      ctx.emitToRenderer({ source: 'talker', event: { kind: 'error', error: `session:start failed: ${msg}` } });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('session:user-text', async (_e, text: string) => {
    const o = ctx.getOrchestrator();
    if (!o) return { ok: false, error: 'No active session' };
    o.sendUserText(text);
    return { ok: true };
  });

  ipcMain.handle('session:resolve-permission', async (_e, id: string, decision: 'allow' | 'deny', message?: string) => {
    const o = ctx.getOrchestrator();
    if (!o) return { ok: false };
    o.resolvePermission(id, decision, message);
    return { ok: true };
  });

  ipcMain.handle('session:interrupt', async () => {
    // Prefer the active session, fall back to a pending recap so the user can
    // cancel the post-meeting Haiku pass (B4).
    const target = ctx.getOrchestrator() ?? ctx.getRecapPending();
    if (!target) return { ok: false };
    await target.interrupt();
    return { ok: true };
  });

  ipcMain.handle('session:set-permission-mode', async (_e, mode: unknown) => {
    const o = ctx.getOrchestrator();
    if (!o) return { ok: false, error: 'No active session' };
    if (!isPermissionMode(mode)) {
      return { ok: false, error: `Invalid permission mode: ${String(mode)}` };
    }
    await o.setPermissionMode(mode);
    return { ok: true };
  });

  ipcMain.handle('session:set-auto-approve', async (_e, scope: unknown) => {
    const VALID_SCOPES = new Set<string>(['off', 'read', 'all']);
    const next: AutoApproveScope =
      typeof scope === 'string' && VALID_SCOPES.has(scope)
        ? (scope as AutoApproveScope)
        : 'off';
    ctx.setAutoApprove(next);
    // Live-toggle the running session if any — affects subsequent canUseTool
    // calls only; in-flight permission requests stay pending until resolved
    // (or session ends).
    const o = ctx.getOrchestrator();
    if (o) o.setAutoApproveScope(next);
    return { ok: true, autoApproveScope: next };
  });

  ipcMain.handle('session:end', async () => {
    const o = ctx.getOrchestrator();
    if (o) {
      ctx.setOrchestrator(null);
      o.end();
      // B4: end() fires the recap pass. If the user clicks interrupt afterward
      // (or starts shutting down) we need a reachable handle to abort it,
      // otherwise the Haiku call runs to completion and the interrupt button
      // is a no-op.
      if (o.isRecapActive()) {
        ctx.setRecapPending(o);
        const done = o.recapDonePromise();
        if (done) {
          void done.finally(() => {
            if (ctx.getRecapPending() === o) ctx.setRecapPending(null);
          });
        } else {
          ctx.setRecapPending(null);
        }
      }
    }
    return { ok: true };
  });

  ipcMain.handle('session:user-image', async (_e, dataUrl: string, caption: string) => {
    const o = ctx.getOrchestrator();
    if (!o) return { ok: false, error: 'No active session' };
    // S7: validate MIME type against an allowlist so a crafted data URL can't
    // slip unexpected content through to the SDK.
    const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
    if (!mimeMatch || !ALLOWED_MIME.has(mimeMatch[1])) {
      return { ok: false, error: `Unsupported image MIME type: ${mimeMatch?.[1] ?? 'unknown'}` };
    }
    // S7: cap base64 payload at ~15 MB (≈ 11 MB raw). Prevents an OOM-style
    // attack where a renderer compromise feeds a multi-GB string into the SDK.
    const MAX_B64_LEN = 15 * 1024 * 1024;
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    if (b64.length > MAX_B64_LEN) {
      return { ok: false, error: `Image too large (${(b64.length / 1024 / 1024).toFixed(1)} MB base64, max ${MAX_B64_LEN / 1024 / 1024} MB)` };
    }
    const mediaType = mimeMatch[1] as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    o.sendUserImage([
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: caption || 'Here is my current screen. Please take a look.' },
    ]);
    return { ok: true };
  });
}
