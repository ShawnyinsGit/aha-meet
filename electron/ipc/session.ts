// session:* IPC handlers — per-meeting operations targeting a specific
// SessionSlot identified by `payload.sessionId`. When the renderer omits the
// id (legacy / global-hotkey callers), the registry falls back to the active
// slot via `resolve(undefined) === getActive()`. session:start is gone —
// opening a meeting goes through `sessions:open` now (see ipc/sessions.ts).

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { formatError } from '../format-error.js';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { IpcContext } from './context.js';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const);
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as Set<string>).has(v);
}

// Renderer payloads (post-multi-tab) all share an optional `sessionId`. Helper
// pulls it out safely and lets caller forward an unknown payload through.
function pickSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function registerSessionIpc(ctx: IpcContext): void {
  ipcMain.handle('session:user-text', async (_e, payload: { sessionId?: string; text: string }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const text = typeof payload?.text === 'string' ? payload.text : '';
    slot.orchestrator.sendUserText(text);
    ctx.registry.touch(slot.id);
    return { ok: true };
  });

  ipcMain.handle(
    'session:resolve-permission',
    async (_e, payload: { sessionId?: string; id: string; decision: 'allow' | 'deny'; message?: string }) => {
      const slot = ctx.registry.resolve(pickSessionId(payload));
      if (!slot) return { ok: false };
      slot.orchestrator.resolvePermission(payload.id, payload.decision, payload.message);
      return { ok: true };
    },
  );

  ipcMain.handle('session:interrupt', async (_e, payload?: { sessionId?: string }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    // Prefer the live orchestrator. Fall back to a slot's recap-pending state
    // for post-end interrupts (B4); the recap reference is the same
    // Orchestrator instance, so .interrupt() still aborts it.
    const target = slot?.orchestrator ?? null;
    if (!target) return { ok: false };
    await target.interrupt();
    return { ok: true };
  });

  ipcMain.handle(
    'session:set-permission-mode',
    async (_e, payload: { sessionId?: string; mode: unknown }) => {
      const slot = ctx.registry.resolve(pickSessionId(payload));
      if (!slot) return { ok: false, error: 'No active session' };
      if (!isPermissionMode(payload?.mode)) {
        return { ok: false, error: `Invalid permission mode: ${String(payload?.mode)}` };
      }
      await slot.orchestrator.setPermissionMode(payload.mode);
      return { ok: true };
    },
  );

  ipcMain.handle('session:set-auto-approve', async (_e, payload: { scope: unknown }) => {
    const VALID_SCOPES = new Set<string>(['off', 'read', 'all']);
    const scope = payload?.scope;
    const next: AutoApproveScope =
      typeof scope === 'string' && VALID_SCOPES.has(scope)
        ? (scope as AutoApproveScope)
        : 'off';

    // S9: scope 'all' lets Claude execute every tool without prompting. A
    // compromised renderer can fire this IPC silently — require a native
    // OS-level confirmation so the elevation can't happen behind the user's
    // back. 'off' and 'read' keep their existing no-prompt behavior.
    if (next === 'all') {
      const parent = BrowserWindow.getFocusedWindow();
      const result = await dialog.showMessageBox(parent ?? (null as unknown as BrowserWindow), {
        type: 'warning',
        title: '启用自动执行?',
        message: '即将允许 Claude 在不询问的情况下执行所有工具，包括写入、执行命令、修改文件。',
        detail: '只在你完全信任当前任务时启用。会话结束或切回 read/off 可关闭。',
        buttons: ['取消', '启用全自动'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) {
        return { ok: false, error: 'cancelled', autoApproveScope: ctx.getAutoApprove() };
      }
    }

    ctx.setAutoApprove(next);
    // Live-toggle every running orchestrator. We deliberately don't scope
    // auto-approve per slot — switching one tab's mode switches them all so a
    // backgrounded tab can't sneak elevated permissions past a user who
    // thinks they're in dontask mode in the front tab.
    for (const slot of ctx.registry.values()) {
      slot.orchestrator.setAutoApproveScope(next);
    }
    return { ok: true, autoApproveScope: next };
  });

  ipcMain.handle('session:end', async (_e, payload?: { sessionId?: string }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: true };
    slot.orchestrator.end();
    // B4: end() fires the recap pass. Mark the slot as recap-pending so a
    // follow-up `session:interrupt` (same sessionId) still reaches the
    // Orchestrator. The slot stays in the registry until the renderer asks
    // to fully close the tab (sessions:close), which drops the entry.
    if (slot.orchestrator.isRecapActive()) {
      slot.recapPending = true;
      const done = slot.orchestrator.recapDonePromise();
      if (done) {
        void done.finally(() => {
          const s = ctx.registry.get(slot.id);
          if (s) s.recapPending = false;
        });
      } else {
        slot.recapPending = false;
      }
    }
    return { ok: true };
  });

  ipcMain.handle(
    'session:user-image',
    async (_e, payload: { sessionId?: string; dataUrl: string; caption: string }) => {
      const slot = ctx.registry.resolve(pickSessionId(payload));
      if (!slot) return { ok: false, error: 'No active session' };
      const dataUrl = typeof payload?.dataUrl === 'string' ? payload.dataUrl : '';
      const caption = typeof payload?.caption === 'string' ? payload.caption : '';
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
      try {
        slot.orchestrator.sendUserImage([
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: caption || 'Here is my current screen. Please take a look.' },
        ]);
        ctx.registry.touch(slot.id);
      } catch (err: unknown) {
        return { ok: false, error: `Send failed: ${formatError(err)}` };
      }
      return { ok: true };
    },
  );
}
