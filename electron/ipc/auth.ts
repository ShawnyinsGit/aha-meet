import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getSettings, updateSettings } from '../store.js';
import { mergedSubprocessEnv } from '../settings-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function unpackify(p: string): string {
  return p.includes('/app.asar/') ? p.replace('/app.asar/', '/app.asar.unpacked/') : p;
}

/** Resolve the bundled claude binary. Tries multiple strategies so both dev
 *  (node_modules on disk) and production (app.asar.unpacked) work. */
async function resolveClaudeBin(): Promise<string | undefined> {
  const arch = process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
  const relPath = `node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-${arch}/claude`;
  const relPathFlat = `node_modules/@anthropic-ai/claude-agent-sdk-${arch}/claude`;

  // 1. Packaged app: resources/app.asar.unpacked/node_modules/...
  if (process.resourcesPath) {
    const candidates = [
      join(process.resourcesPath, 'app.asar.unpacked', relPath),
      join(process.resourcesPath, 'app.asar.unpacked', relPathFlat),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  // 2. Dev / unpackaged: resolve from project root next to main.js
  const projectRoot = join(__dirname, '..', '..');
  const candidates = [
    join(projectRoot, relPath),
    join(projectRoot, relPathFlat),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 3. Try require.resolve as last resort
  try {
    const { createRequire } = await import('node:module');
    const require_ = createRequire(import.meta.url);
    const subpkg = `@anthropic-ai/claude-agent-sdk-${arch}/claude`;
    try {
      const sdkPkg = require_.resolve('@anthropic-ai/claude-agent-sdk/package.json');
      const p = unpackify(createRequire(sdkPkg).resolve(subpkg));
      if (existsSync(p)) return p;
    } catch { /* fall through */ }
    const p = unpackify(require_.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  return undefined;
}

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
      await updateSettings({ anthropicApiKey: undefined, authMode: undefined });
      return { ok: true };
    }
    await updateSettings({ anthropicApiKey: trimmed, authMode: 'apikey' });
    return { ok: true };
  });

  ipcMain.handle('auth:set-mode', async (_e, mode: unknown) => {
    if (mode !== 'apikey' && mode !== 'subscription' && mode !== null) {
      return { ok: false, error: 'mode must be apikey, subscription, or null' };
    }
    await updateSettings({ authMode: (mode as 'apikey' | 'subscription') ?? undefined });
    return { ok: true };
  });

  /** Run `claude auth login` in a child process.
   *  The claude CLI opens a browser for OAuth; we wait for it to exit. */
  ipcMain.handle('auth:login-subscription', async () => {
    const claudeBin = await resolveClaudeBin();
    if (!claudeBin) {
      return { ok: false, error: 'claude binary not found' };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const env = mergedSubprocessEnv();
      const proc = spawn(claudeBin, ['auth', 'login'], {
        env,
        stdio: 'ignore',
        detached: false,
      });
      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          updateSettings({ authMode: 'subscription', anthropicApiKey: undefined })
            .catch((err) => console.error('[auth] failed to persist authMode:', err))
            .finally(() => resolve({ ok: true }));
        } else {
          resolve({ ok: false, error: `claude auth login exited with code ${code}` });
        }
      });
    });
  });

  /** Check subscription login status by asking the Claude CLI directly.
   *  The CLI stores OAuth credentials in its own internal storage (Keychain on
   *  macOS), not a plain JSON file, so we run `claude auth status --json`
   *  rather than checking for a credentials file on disk. */
  ipcMain.handle('auth:check-subscription-status', async () => {
    const claudeBin = await resolveClaudeBin();
    if (!claudeBin) {
      return { loggedIn: false };
    }

    return new Promise<{ loggedIn: boolean }>((resolve) => {
      const env = mergedSubprocessEnv();
      let stdout = '';
      let stderr = '';
      const proc = spawn(claudeBin, ['auth', 'status', '--json'], {
        env,
        stdio: 'pipe',
        detached: false,
      });
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      proc.on('error', () => {
        resolve({ loggedIn: false });
      });
      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          resolve({ loggedIn: false });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ loggedIn: Boolean(parsed?.loggedIn) });
        } catch {
          resolve({ loggedIn: false });
        }
      });
    });
  });
}
