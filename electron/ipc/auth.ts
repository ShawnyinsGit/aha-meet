import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { getSettings, updateSettings } from '../store.js';
import { mergedSubprocessEnv } from '../settings-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function registerAuthIpc(): void {
  ipcMain.handle('auth:get-config', async () => {
    const s = getSettings();
    return {
      authMode: s.authMode ?? null,
      // Never send the actual key back to the renderer — only indicate if one is set.
      hasApiKey: Boolean(s.anthropicApiKey),
    };
  });

  ipcMain.handle('auth:set-api-key', async (_e, key: unknown) => {
    if (typeof key !== 'string') {
      return { ok: false, error: 'key must be a string' };
    }
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      updateSettings({ anthropicApiKey: undefined, authMode: undefined });
      return { ok: true };
    }
    updateSettings({ anthropicApiKey: trimmed, authMode: 'apikey' });
    return { ok: true };
  });

  ipcMain.handle('auth:set-mode', async (_e, mode: unknown) => {
    if (mode !== 'apikey' && mode !== 'subscription' && mode !== null) {
      return { ok: false, error: 'mode must be apikey, subscription, or null' };
    }
    updateSettings({ authMode: (mode as 'apikey' | 'subscription') ?? undefined });
    return { ok: true };
  });

  /** Run `claude auth login` in a child process.
   *  The claude CLI opens a browser for OAuth; we wait for it to exit. */
  ipcMain.handle('auth:login-subscription', async () => {
    // Resolve the bundled claude binary. Try multiple strategies so both dev
    // (node_modules on disk) and production (app.asar.unpacked) work.
    function unpackify(p: string): string {
      return p.includes('/app.asar/') ? p.replace('/app.asar/', '/app.asar.unpacked/') : p;
    }
    const arch = process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
    const relPath = `node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-${arch}/claude`;
    const relPathFlat = `node_modules/@anthropic-ai/claude-agent-sdk-${arch}/claude`;

    let claudeBin: string | undefined;

    // 1. Packaged app: resources/app.asar.unpacked/node_modules/...
    if (process.resourcesPath) {
      const candidates = [
        join(process.resourcesPath, 'app.asar.unpacked', relPath),
        join(process.resourcesPath, 'app.asar.unpacked', relPathFlat),
      ];
      for (const c of candidates) {
        if (existsSync(c)) { claudeBin = c; break; }
      }
    }

    // 2. Dev / unpackaged: resolve from project root next to main.js
    if (!claudeBin) {
      const projectRoot = join(__dirname, '..', '..');
      const candidates = [
        join(projectRoot, relPath),
        join(projectRoot, relPathFlat),
      ];
      for (const c of candidates) {
        if (existsSync(c)) { claudeBin = c; break; }
      }
    }

    // 3. Try require.resolve as last resort
    if (!claudeBin) {
      try {
        const { createRequire } = await import('node:module');
        const require_ = createRequire(import.meta.url);
        const subpkg = `@anthropic-ai/claude-agent-sdk-${arch}/claude`;
        try {
          const sdkPkg = require_.resolve('@anthropic-ai/claude-agent-sdk/package.json');
          const p = unpackify(createRequire(sdkPkg).resolve(subpkg));
          if (existsSync(p)) claudeBin = p;
        } catch { /* fall through */ }
        if (!claudeBin) {
          const p = unpackify(require_.resolve(subpkg));
          if (existsSync(p)) claudeBin = p;
        }
      } catch { /* fall through */ }
    }

    if (!claudeBin) {
      return { ok: false, error: 'claude binary not found' };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const env = mergedSubprocessEnv();
      const proc = spawn(claudeBin!, ['auth', 'login'], {
        env,
        stdio: 'ignore',
        detached: false,
      });
      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          updateSettings({ authMode: 'subscription', anthropicApiKey: undefined });
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: `claude auth login exited with code ${code}` });
        }
      });
    });
  });

  /** Check if the user appears to be logged in via subscription (credentials file exists). */
  ipcMain.handle('auth:check-subscription-status', async () => {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const hasCredentials = existsSync(credPath);
    return { loggedIn: hasCredentials };
  });
}
