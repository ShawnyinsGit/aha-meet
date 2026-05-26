import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, systemPreferences, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Orchestrator, type OrchestratorEvent } from './orchestrator.js';
import { transcribePcm, isWhisperAvailable, disposeWhisper } from './whisper.js';
import { buildClaudeShadowHome } from './claude-defaults.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import { formatError, errorMessage } from './format-error.js';
import { getSettings, updateSettings, clearVoicePrint, type VoicePrint } from './store.js';
import {
  computeProjectId,
  deleteEntry as deleteMemoryEntry,
  listEntries as listMemoryEntries,
  updateEntry as updateMemoryEntry,
  type MemoryCategory,
  type MemoryListFilter,
} from './memory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;
// Trust-mode flag — module-level so it survives between session start/stop
// and isn't lost when the renderer reloads. Default OFF every launch; we
// intentionally do NOT persist this to disk.
let autoApprove = false;
// Shadow HOME pointing at the merged bundled+user .claude tree, computed
// once at app launch. `null` in dev mode → SDK uses real ~/.claude.
let claudeShadowHome: string | null = null;
// Last cwd we started a session against. Used by `memory:projectId` so the
// renderer can ask "what's my current project memory scope?" without re-
// computing the hash on its side.
let currentCwd: string | null = null;

const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'AhaMeet',
    backgroundColor: '#0e0f12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true is safe here — preload.cjs only uses ipcRenderer +
      // contextBridge, both of which are sandbox-compatible. Keeping the OS
      // sandbox on means a renderer compromise (XSS in transcript, vuln in
      // Electron's HTML/JS engine) can't directly call native fs / exec.
      sandbox: true,
    },
  });

  // CSP injection. The packaged HTML has no <meta> CSP, so the renderer
  // would default to "anything goes" without this. Dev mode loosens the
  // policy enough that Vite's HMR client (ws + eval'd modules) keeps
  // working; prod is tight: no eval, no remote scripts, no remote fetches.
  const devOrigin = isDev ? new URL(process.env.VITE_DEV_SERVER_URL!).origin : '';
  const devWsOrigin = isDev ? devOrigin.replace(/^http/, 'ws') : '';
  const csp = isDev
    ? [
        `default-src 'self' ${devOrigin}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}`,
        `style-src 'self' 'unsafe-inline' ${devOrigin}`,
        `img-src 'self' data: blob: ${devOrigin}`,
        `media-src 'self' blob: data: ${devOrigin}`,
        `font-src 'self' data: ${devOrigin}`,
        `connect-src 'self' ${devOrigin} ${devWsOrigin}`,
        `worker-src 'self' blob:`,
        `frame-src 'none'`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self' 'wasm-unsafe-eval'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `media-src 'self' blob: data:`,
        `font-src 'self' data:`,
        `connect-src 'self'`,
        `worker-src 'self' blob:`,
        `frame-src 'none'`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ');

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
    if (process.env.VIBE_MEET_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }

  // Lock down navigation. The renderer should only ever live at our Vite dev
  // URL (dev) or our packaged file:// HTML (prod) — anything else (a stray
  // <a href>, a malicious tool-result-injected URL, a window.open) must NOT
  // turn this BrowserWindow into a generic web browser.
  const allowedOrigin = isDev
    ? new URL(process.env.VITE_DEV_SERVER_URL!).origin
    : 'file://';

  // window.open / target="_blank" → route external links to the OS browser
  // and refuse to spawn a new Electron window for them.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch { /* ignore unparseable URLs */ }
    return { action: 'deny' };
  });

  // Any in-window navigation away from our app origin gets cancelled. http(s)
  // links go to the user's default browser; everything else is silently
  // dropped (could be a custom-scheme attack vector).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      const sameOrigin = isDev
        ? u.origin === allowedOrigin
        : u.protocol === 'file:';
      if (sameOrigin) return;
      event.preventDefault();
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
}

function emitToRenderer(e: OrchestratorEvent) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Flatten { source, event } onto each event so the renderer's RendererEvent
  // shape stays a single object with an extra `source` field.
  mainWindow.webContents.send('session:event', { ...e.event, source: e.source });
}

ipcMain.handle('session:start', async (_e, cwd: string, greeting?: string) => {
  try {
    if (orchestrator) {
      orchestrator.end();
      orchestrator = null;
    }
    const resolvedCwd = cwd && cwd.length > 0 ? cwd : homedir();
    // If we built a shadow home, splice HOME into the worker subprocess env
    // so the SDK's `settingSources: ['user']` reads our merged tree (bundled
    // ECC defaults + user's overrides) instead of the bare `~/.claude`.
    const workerEnv = claudeShadowHome
      ? { ...mergedSubprocessEnv(), HOME: claudeShadowHome }
      : undefined;
    orchestrator = new Orchestrator({
      emit: emitToRenderer,
      cwd: resolvedCwd,
      autoApprove,
      workerEnv,
    });
    currentCwd = resolvedCwd;
    await orchestrator.start(greeting);
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
    emitToRenderer({ source: 'talker', event: { kind: 'error', error: `session:start failed: ${msg}` } });
    return { ok: false, error: msg };
  }
});

ipcMain.handle('session:user-text', async (_e, text: string) => {
  if (!orchestrator) return { ok: false, error: 'No active session' };
  orchestrator.sendUserText(text);
  return { ok: true };
});

ipcMain.handle('session:resolve-permission', async (_e, id: string, decision: 'allow' | 'deny', message?: string) => {
  if (!orchestrator) return { ok: false };
  orchestrator.resolvePermission(id, decision, message);
  return { ok: true };
});

ipcMain.handle('session:interrupt', async () => {
  if (!orchestrator) return { ok: false };
  await orchestrator.interrupt();
  return { ok: true };
});

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const);
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as Set<string>).has(v);
}

ipcMain.handle('session:set-permission-mode', async (_e, mode: unknown) => {
  if (!orchestrator) return { ok: false, error: 'No active session' };
  if (!isPermissionMode(mode)) {
    return { ok: false, error: `Invalid permission mode: ${String(mode)}` };
  }
  await orchestrator.setPermissionMode(mode);
  return { ok: true };
});

ipcMain.handle('session:set-auto-approve', async (_e, on: boolean) => {
  autoApprove = !!on;
  // Live-toggle the running session if any — affects subsequent canUseTool
  // calls only; in-flight permission requests stay pending until resolved
  // (or session ends).
  if (orchestrator) orchestrator.setAutoApprove(autoApprove);
  return { ok: true, autoApprove };
});

ipcMain.handle('session:end', async () => {
  if (orchestrator) {
    orchestrator.end();
    orchestrator = null;
  }
  return { ok: true };
});

ipcMain.handle('session:user-image', async (_e, dataUrl: string, caption: string) => {
  if (!orchestrator) return { ok: false, error: 'No active session' };
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = (dataUrl.match(/^data:(image\/\w+);/)?.[1] ?? 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  orchestrator.sendUserImage([
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
    { type: 'text', text: caption || 'Here is my current screen. Please take a look.' },
  ]);
  return { ok: true };
});

ipcMain.handle('desktop:get-sources', async () => {
  try {
    const status = process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('screen')
      : 'granted';
    if (status === 'denied' || status === 'restricted') {
      return { ok: false, error: 'permission-denied', status };
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 240, height: 140 },
      fetchWindowIcons: false,
    });
    return {
      ok: true,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      })),
    };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err), status: 'unknown' };
  }
});

ipcMain.handle('desktop:check-permission', async () => {
  if (process.platform !== 'darwin') return 'granted';
  const status = systemPreferences.getMediaAccessStatus('screen');
  return status;
});

ipcMain.handle('desktop:open-settings', async () => {
  if (process.platform !== 'darwin') return { ok: false };
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return { ok: true };
});

ipcMain.handle('meeting:plan-manual', async (
  _e,
  tasks: Array<{ id: string; title: string; prompt: string; deps?: string[] }>,
) => {
  if (!orchestrator) return { ok: false, error: 'No active session' };
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, error: 'tasks must be a non-empty array' };
  }
  for (const t of tasks) {
    if (typeof t?.id !== 'string' || typeof t?.title !== 'string' || typeof t?.prompt !== 'string') {
      return { ok: false, error: 'each task needs id/title/prompt strings' };
    }
  }
  const res = await orchestrator.installPlan(tasks);
  return res;
});

ipcMain.handle('asr:available', async () => {
  return { ok: true, available: isWhisperAvailable() };
});

ipcMain.handle('asr:transcribe', async (_e, pcmBuffer: ArrayBuffer, lang?: 'auto' | 'zh' | 'en') => {
  try {
    const samples = new Float32Array(pcmBuffer);
    const r = await transcribePcm(samples, lang ?? 'auto');
    return r;
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('settings:get-last-cwd', async () => {
  const s = getSettings();
  const last = s.lastCwd;
  // Validate the saved path still resolves to a directory — if the user
  // deleted or moved it, fall through to the JoinScreen's empty state so
  // they're forced to pick again rather than starting a session against
  // a path that no longer exists.
  if (!last) return null;
  try {
    if (existsSync(last) && statSync(last).isDirectory()) return last;
  } catch {
    /* ignore — treat as missing */
  }
  return null;
});

ipcMain.handle('settings:get-voice-config', async () => {
  const s = getSettings();
  return {
    enabled: Boolean(s.voiceLockEnabled),
    voicePrint: s.voicePrint ?? null,
  };
});

ipcMain.handle('settings:set-voice-lock-enabled', async (_e, enabled: boolean) => {
  updateSettings({ voiceLockEnabled: !!enabled });
  return { ok: true };
});

ipcMain.handle('settings:set-voice-print', async (_e, vp: VoicePrint | null) => {
  if (!vp) {
    clearVoicePrint();
  } else {
    updateSettings({ voicePrint: vp });
  }
  return { ok: true };
});

ipcMain.handle('settings:get-voice-pref', async () => {
  const s = getSettings();
  return {
    selectedVoiceName: s.selectedVoiceName ?? null,
    guidanceDismissed: Boolean(s.voiceGuidanceDismissed),
    speechFilterMode: s.speechFilterMode ?? 'strict',
  };
});

ipcMain.handle('settings:set-voice-pref', async (
  _e,
  patch: { selectedVoiceName?: string | null; guidanceDismissed?: boolean; speechFilterMode?: 'strict' | 'off' },
) => {
  const next: Partial<{ selectedVoiceName: string | null; voiceGuidanceDismissed: boolean; speechFilterMode: 'strict' | 'off' }> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'selectedVoiceName')) {
    next.selectedVoiceName = patch.selectedVoiceName ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'guidanceDismissed')) {
    next.voiceGuidanceDismissed = Boolean(patch.guidanceDismissed);
  }
  if (patch.speechFilterMode === 'strict' || patch.speechFilterMode === 'off') {
    next.speechFilterMode = patch.speechFilterMode;
  }
  updateSettings(next);
  return { ok: true };
});

// Deep-link into System Settings → Accessibility → Spoken Content so the
// user can install the higher-quality Siri / Premium / Enhanced Chinese
// voices. Apple gives us no API to trigger the download programmatically;
// this is the closest we get to one click.
ipcMain.handle('system:open-voice-settings', async () => {
  if (process.platform !== 'darwin') return { ok: false };
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?Speech');
  return { ok: true };
});

// ---- Memory (cross-meeting) ------------------------------------------------

const MEMORY_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  'point',
  'decision',
  'todo',
  'fact',
]);

function sanitizeMemoryFilter(input: unknown): MemoryListFilter | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const f = input as Record<string, unknown>;
  const out: MemoryListFilter = {};
  if (typeof f.projectId === 'string' && f.projectId.length > 0) {
    out.projectId = f.projectId;
  }
  if (typeof f.category === 'string' && MEMORY_CATEGORIES.has(f.category as MemoryCategory)) {
    out.category = f.category as MemoryCategory;
  }
  if (typeof f.query === 'string' && f.query.length > 0) {
    out.query = f.query;
  }
  return out;
}

ipcMain.handle('memory:list', async (_e, filter: unknown) => {
  try {
    const sanitized = sanitizeMemoryFilter(filter);
    const entries = await listMemoryEntries(sanitized);
    return { ok: true, entries };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle(
  'memory:update',
  async (_e, payload: { id: string; patch: Record<string, unknown> }) => {
    try {
      if (!payload || typeof payload.id !== 'string') {
        return { ok: false, error: 'id is required' };
      }
      const patch: { category?: MemoryCategory; content?: string; tags?: string[] } = {};
      if (payload.patch && typeof payload.patch === 'object') {
        const p = payload.patch as Record<string, unknown>;
        if (typeof p.category === 'string' && MEMORY_CATEGORIES.has(p.category as MemoryCategory)) {
          patch.category = p.category as MemoryCategory;
        }
        if (typeof p.content === 'string') patch.content = p.content;
        if (Array.isArray(p.tags)) {
          patch.tags = p.tags.filter((t): t is string => typeof t === 'string');
        }
      }
      const entry = await updateMemoryEntry(payload.id, patch);
      if (!entry) return { ok: false, error: 'not-found-or-invalid' };
      return { ok: true, entry };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  },
);

ipcMain.handle('memory:delete', async (_e, id: unknown) => {
  try {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'id is required' };
    }
    const ok = await deleteMemoryEntry(id);
    return { ok };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
});

ipcMain.handle('memory:projectId', async () => {
  if (!currentCwd) return null;
  try {
    return computeProjectId(currentCwd);
  } catch (err) {
    console.error('[memory] computeProjectId failed:', err);
    return null;
  }
});

ipcMain.handle('dialog:pick-cwd', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: homedir(),
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// ---- Claude Auth ------------------------------------------------------------

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
    const projectRoot = join(__dirname, '..');
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

app.whenReady().then(() => {
  // Build the merged bundled+user .claude shadow tree once per launch so the
  // worker subprocess sees both the bundled ECC defaults and the user's own
  // `~/.claude` entries (user wins on same names). Cheap (just symlinks).
  try {
    const result = buildClaudeShadowHome();
    claudeShadowHome = result.home;
    if (claudeShadowHome) {
      console.log(
        `[claude-defaults] shadow home at ${claudeShadowHome} ` +
          `(bundled=${result.stats.bundled} userOverrides=${result.stats.userOverrides} passthrough=${result.stats.passthrough})`,
      );
    } else {
      console.log('[claude-defaults] dev mode or no bundled defaults; using real ~/.claude');
    }
  } catch (err) {
    console.error('[claude-defaults] failed to build shadow home:', err);
    claudeShadowHome = null;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (orchestrator) {
    orchestrator.end();
    orchestrator = null;
  }
  // Reap any in-flight whisper-cli child so it doesn't strand a transcription
  // run past window close (B1).
  disposeWhisper();
  if (process.platform !== 'darwin') app.quit();
});

// Final safety net: even on cmd-Q with the dock alive (macOS) the window-all-
// closed handler doesn't fire. before-quit covers that path so whisper-cli
// always gets SIGTERM'd.
app.on('before-quit', () => {
  if (orchestrator) {
    orchestrator.end();
    orchestrator = null;
  }
  disposeWhisper();
});
