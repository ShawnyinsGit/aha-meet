// backend-auth.ts — IPC handlers for per-backend auth configuration.
//
// Each CLI backend (Claude Code, Codex, Kimi, Qoder) has its own auth state.
// These handlers manage the backendAuth array in settings.json, which stores
// per-backend API keys (encrypted), base URLs, models, and auth modes.

import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  getBackendAuth,
  listBackendAuth,
  setBackendAuth,
  removeBackendAuth,
  setDefaultBackend,
  getSettings,
} from '../store.js';
import { getBackendRegistry } from '../backends/registry.js';
import { augmentedPath } from '../backends/subprocess-backend.js';
import type { BackendAuthEntry } from '../store.js';

/** One install at a time — prevents double-click races from stacking npm
 *  processes that fight over the same global node_modules lock. */
let activeInstall: { backendId: string; proc: ReturnType<typeof spawn> } | null = null;

/** Build a subprocess env with an augmented PATH so npm/curl can find their
 *  dependencies and freshly-installed binaries land in discoverable dirs. */
function installEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentedPath(),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
  // Set HOME/USERPROFILE for tools that read config from home directory
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
  // Set shell/comspec based on platform
  if (process.platform === 'win32') {
    env.ComSpec = process.env.ComSpec;
    env.SYSTEMROOT = process.env.SYSTEMROOT;
  } else {
    env.SHELL = process.env.SHELL ?? '/bin/zsh';
    env.USER = process.env.USER;
  }
  return env;
}

/** npm lives at different places depending on how Node was installed.
 *  Check the common absolute paths before falling back to bare `npm` (which
 *  relies on the inherited PATH, unreliable from a .app bundle). */
function resolveNpmBinary(): string {
  if (process.platform === 'win32') {
    // Windows: check APPDATA/npm and Program Files
    const candidates = [
      process.env.APPDATA ? `${process.env.APPDATA}\\npm\\npm.cmd` : null,
      'C:\\Program Files\\nodejs\\npm.cmd',
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return 'npm.cmd';
  }
  // macOS/Linux: check common npm locations
  const candidates = ['/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'npm';
}

export function registerBackendAuthIpc(): void {
  /** Validate that a backendId corresponds to a registered backend. */
  function validateBackendId(backendId: string): string | null {
    if (!backendId || !/^[a-zA-Z0-9._-]{1,64}$/.test(backendId)) {
      return 'backendId must be alphanumeric with dots/hyphens/underscores, max 64 chars';
    }
    if (!getBackendRegistry().get(backendId)) {
      return `unknown backend: ${backendId}`;
    }
    return null;
  }

  /** List all backends with their auth status and availability. */
  ipcMain.handle('backend-auth:list', async () => {
    const registry = getBackendRegistry();
    const authEntries = listBackendAuth();
    const defaultBackend = getSettings().defaultBackend ?? 'claude-code';

    const result = registry.listWithStatus().map(({ backend, available, binaryPath }) => {
      const auth = authEntries.find((e) => e.backendId === backend.id);
      return {
        id: backend.id,
        displayName: backend.capabilities.displayName,
        iconId: backend.capabilities.iconId,
        available,
        binaryPath,
        authMode: auth?.authMode ?? 'none',
        hasApiKey: Boolean(auth?.apiKey),
        baseUrl: auth?.baseUrl ?? null,
        model: auth?.model ?? null,
        defaultModel: backend.capabilities.defaultModel ?? null,
        models: backend.capabilities.models ?? null,
        isDefault: backend.id === defaultBackend,
        installHint: backend.capabilities.installHint ?? null,
        supportsMcp: backend.capabilities.mcp,
        supportsPermissions: backend.capabilities.permissions,
      };
    });

    return result;
  });

  /** Get auth config for a specific backend. */
  ipcMain.handle('backend-auth:get-config', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const auth = getBackendAuth(backendId);
    return {
      ok: true,
      config: auth
        ? {
            authMode: auth.authMode,
            hasApiKey: Boolean(auth.apiKey),
            baseUrl: auth.baseUrl ?? null,
            model: auth.model ?? null,
            lastValidatedAt: auth.lastValidatedAt ?? null,
          }
        : null,
    };
  });

  /** Set API key for a specific backend. */
  ipcMain.handle('backend-auth:set-api-key', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, key } = payload as { backendId?: string; key?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const validationError = validateBackendId(backendId);
    if (validationError) {
      return { ok: false, error: validationError };
    }
    if (typeof key !== 'string') {
      return { ok: false, error: 'key must be a string' };
    }
    const trimmed = key.trim();
    const patch: Partial<BackendAuthEntry> = trimmed.length === 0
      ? { authMode: 'none', apiKey: undefined, apiKeyEnc: undefined }
      : { authMode: 'apikey', apiKey: trimmed };
    try {
      await setBackendAuth(backendId, patch);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set base URL for a specific backend. */
  ipcMain.handle('backend-auth:set-base-url', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, url } = payload as { backendId?: string; url?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (typeof url !== 'string') {
      return { ok: false, error: 'url must be a string' };
    }
    const trimmed = url.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { ok: false, error: 'base URL must use http:// or https://' };
        }
      } catch {
        return { ok: false, error: 'invalid URL format' };
      }
    }
    try {
      await setBackendAuth(backendId, { baseUrl: trimmed.length === 0 ? undefined : trimmed });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set model for a specific backend. */
  ipcMain.handle('backend-auth:set-model', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, model } = payload as { backendId?: string; model?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (typeof model !== 'string') {
      return { ok: false, error: 'model must be a string' };
    }
    const trimmed = model.trim();
    try {
      await setBackendAuth(backendId, { model: trimmed.length === 0 ? undefined : trimmed });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set auth mode for a specific backend. */
  ipcMain.handle('backend-auth:set-mode', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, mode } = payload as { backendId?: string; mode?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (mode !== 'apikey' && mode !== 'oauth' && mode !== 'none') {
      return { ok: false, error: 'mode must be apikey, oauth, or none' };
    }
    try {
      await setBackendAuth(backendId, { authMode: mode });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set the default backend for new sessions. */
  ipcMain.handle('backend-auth:set-default', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    try {
      await setDefaultBackend(backendId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Check auth status for a specific backend. */
  ipcMain.handle('backend-auth:check-status', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const registry = getBackendRegistry();
    const backend = registry.get(backendId);
    if (!backend) {
      return { ok: false, error: `unknown backend: ${backendId}` };
    }
    if (backend.checkAuthStatus) {
      const status = await backend.checkAuthStatus();
      return { ok: true, ...status };
    }
    // For backends without explicit auth check, having an API key or the
    // binary available counts as "logged in".
    const auth = getBackendAuth(backendId);
    const available = registry.isAvailable(backendId);
    return {
      ok: true,
      loggedIn: Boolean(auth?.apiKey) || available,
    };
  });

  /** Run the install command for a backend that isn't available yet.
   *
   *  Streams `backend:install-progress` events to the renderer while the
   *  subprocess runs. Final result is returned via the invoke reply. Only
   *  one install may be active at a time — a second concurrent call for
   *  the same backend returns "in progress"; a different backend is
   *  rejected until the first finishes. */
  ipcMain.handle('backend-auth:install', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };

    // Guard against concurrent installs.
    if (activeInstall) {
      if (activeInstall.backendId === backendId) {
        return { ok: false, error: 'Install already in progress' };
      }
      return { ok: false, error: `Another install is in progress (${activeInstall.backendId})` };
    }

    const registry = getBackendRegistry();
    const backend = registry.get(backendId);
    if (!backend) {
      return { ok: false, error: `unknown backend: ${backendId}` };
    }

    // Decide what to spawn based on whether the backend has an npm package
    // (structured install) or only a shell hint (e.g. curl | bash for Kimi).
    const npmPackage = backend.capabilities.npmPackage;
    const hint = backend.capabilities.installHint ?? '';

    let cmd: string;
    let args: string[];
    if (npmPackage) {
      cmd = resolveNpmBinary();
      args = ['install', '-g', npmPackage];
    } else if (hint && hint !== 'Bundled with AhaMeet') {
      // Use platform-appropriate shell
      if (process.platform === 'win32') {
        cmd = process.env.ComSpec ?? 'cmd.exe';
        args = ['/c', hint];
      } else {
        cmd = '/bin/sh';
        args = ['-c', hint];
      }
    } else {
      return { ok: false, error: 'No install command available for this backend' };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      try {
        const child = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Augmented PATH so npm can find node and the freshly-installed
          // binary lands in a location resolveBinaryFromPath() can discover.
          env: installEnv(),
        });
        activeInstall = { backendId, proc: child };

        const sendProgress = (data: string) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('backend:install-progress', { backendId, data });
          }
        };

        // Show the user what we're running — without this the log is empty
        // until npm starts printing, which can take several seconds.
        sendProgress(`$ ${cmd} ${args.join(' ')}\n\n`);

        child.stdout?.on('data', (buf: Buffer) => sendProgress(buf.toString()));
        child.stderr?.on('data', (buf: Buffer) => sendProgress(buf.toString()));

        child.on('close', (code) => {
          activeInstall = null;
          if (code === 0) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `Install exited with code ${code}` });
          }
        });

        child.on('error', (err) => {
          activeInstall = null;
          sendProgress(`\n✗ Failed to start install: ${err.message}\n`);
          resolve({ ok: false, error: err.message });
        });
      } catch (err) {
        activeInstall = null;
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
}
