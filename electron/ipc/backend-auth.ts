// backend-auth.ts — IPC handlers for per-backend auth configuration.
//
// Each CLI backend (Claude Code, Codex, Kimi, Qoder) has its own auth state.
// These handlers manage the backendAuth array in settings.json, which stores
// per-backend API keys (encrypted), base URLs, models, and auth modes.

import { ipcMain } from 'electron';
import {
  getBackendAuth,
  listBackendAuth,
  setBackendAuth,
  removeBackendAuth,
  setDefaultBackend,
  getSettings,
} from '../store.js';
import { getBackendRegistry } from '../backends/registry.js';
import type { BackendAuthEntry } from '../store.js';

export function registerBackendAuthIpc(): void {
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
    if (typeof key !== 'string') {
      return { ok: false, error: 'key must be a string' };
    }
    const trimmed = key.trim();
    const patch: Partial<BackendAuthEntry> = trimmed.length === 0
      ? { authMode: 'none', apiKey: undefined, apiKeyEnc: undefined }
      : { authMode: 'apikey', apiKey: trimmed };
    await setBackendAuth(backendId, patch);
    return { ok: true };
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
    await setBackendAuth(backendId, { baseUrl: trimmed.length === 0 ? undefined : trimmed });
    return { ok: true };
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
    if (typeof model !== 'string') {
      return { ok: false, error: 'model must be a string' };
    }
    const trimmed = model.trim();
    await setBackendAuth(backendId, { model: trimmed.length === 0 ? undefined : trimmed });
    return { ok: true };
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
    if (mode !== 'apikey' && mode !== 'oauth' && mode !== 'none') {
      return { ok: false, error: 'mode must be apikey, oauth, or none' };
    }
    await setBackendAuth(backendId, { authMode: mode });
    return { ok: true };
  });

  /** Set the default backend for new sessions. */
  ipcMain.handle('backend-auth:set-default', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    await setDefaultBackend(backendId);
    return { ok: true };
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
}
