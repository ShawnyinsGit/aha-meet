import { app, BrowserWindow, dialog, shell, systemPreferences } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { disposeWhisper } from './whisper.js';
import { buildClaudeShadowHome } from './claude-defaults.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import { SessionRegistry } from './sessions.js';
import type { IpcContext, IpcEmittedEvent } from './ipc/context.js';
import { registerSessionIpc } from './ipc/session.js';
import { registerSessionsIpc } from './ipc/sessions.js';
import { registerAuthIpc } from './ipc/auth.js';
import { registerDesktopIpc } from './ipc/desktop.js';
import { registerAsrIpc } from './ipc/asr.js';
import { registerSettingsIpc } from './ipc/settings.js';
import { registerMemoryIpc } from './ipc/memory.js';
import { registerDecisionIpc } from './ipc/decision.js';
import { registerDialogIpc } from './ipc/dialog.js';
import { registerAttachmentsIpc } from './ipc/attachments.js';
import { registerDocumentsIpc } from './ipc/documents.js';
import { registerTranscriptsIpc } from './ipc/transcripts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
// Multi-tab session store. Each slot owns one Orchestrator (= one Talker +
// scheduler) tied to a single cwd. Replaces the prior global `orchestrator`
// + `currentCwd` + `recapPending` triple — those now live per-slot inside
// the registry. `recapPending` for a slot is tracked on the slot itself.
const registry = new SessionRegistry();
// Trust-mode scope — module-level so it survives between session start/stop
// and isn't lost when the renderer reloads. Default OFF every launch; we
// intentionally do NOT persist this to disk. Shared across all slots: see
// the note in IpcContext for the rationale (avoid backgrounded-tab privilege
// confusion).
let autoApprove: AutoApproveScope = 'off';
// Shadow HOME pointing at the merged bundled+user .claude tree, computed
// once at app launch. `null` in dev mode → SDK uses real ~/.claude.
let claudeShadowHome: string | null = null;

const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

// B11/B12: a single live-window accessor. Every caller outside createWindow
// goes through this so the "is it still there?" check is impossible to forget.
// Anything inside createWindow is fine to touch mainWindow directly — TS
// narrows the freshly-assigned value within the function scope.
function liveWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return mainWindow;
}

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

  // B11: the OS will reap the BrowserWindow after 'closed', but our module
  // binding keeps pointing at the destroyed instance. Without this, any
  // subsequent emitToRenderer / dialog handler hits "Object has been
  // destroyed" on .webContents access — the isDestroyed() guards in
  // liveWindow() are belt-and-braces for that same case.
  mainWindow.on('closed', () => {
    mainWindow = null;
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

  // DevTools toggle: Cmd+Option+I (mac) / Ctrl+Shift+I (others). Packaged
  // builds otherwise have no UI to open DevTools, which leaves the user
  // stuck if they need to read renderer logs (e.g. the [asr] probe line
  // that reports whether whisper or browser ASR is live).
  const wc = mainWindow.webContents;
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key.toLowerCase() !== 'i') return;
    const combo = process.platform === 'darwin'
      ? input.meta && input.alt
      : input.control && input.shift;
    if (!combo) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });

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

function emitToRenderer(e: IpcEmittedEvent) {
  const win = liveWindow();
  if (!win) return;
  // Flatten { source, event } onto each event so the renderer's RendererEvent
  // shape stays a single object with an extra `source` field. sessionId is
  // pre-bound by the per-slot emit wrapper created in sessions:open so the
  // renderer can route the event to the right MeetingState slot.
  win.webContents.send('session:event', { ...e.event, source: e.source, sessionId: e.sessionId });
}

// S3: under auto-approve, render a short preview of the tool call for the
// native dialog so the user can decide without context-switching to the
// renderer (and without trusting the renderer to render it faithfully).
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillBash':
      return truncate(`$ ${str(input.command)}`, 400);
    case 'Write':
      return truncate(`Write → ${str(input.file_path)}`, 400);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return truncate(`Edit → ${str(input.file_path) || str(input.notebook_path)}`, 400);
    case 'SlashCommand':
      return truncate(`/${str(input.command)}`, 400);
    default:
      try {
        return truncate(JSON.stringify(input), 400);
      } catch {
        return '(input not serializable)';
      }
  }
}

// S3: native OS confirmation for destructive tool calls under auto-approve.
// A compromised renderer (XSS, injected script) could fake the in-app
// permission row and flip auto-approve on, but it cannot synthesize a click
// on this OS-level modal — that's the whole point. Defaults to Deny so even
// a stuck-Enter scenario doesn't run something destructive.
async function nativeConfirmDestructive(
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const win = liveWindow();
  if (!win) return false;
  const detail = summarizeToolInput(toolName, input);
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Auto-approve: confirm destructive action',
    message: `Worker wants to run: ${toolName}`,
    detail,
    buttons: ['Deny', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return res.response === 1;
}

// ---- Wire IPC domain modules -----------------------------------------------
// Each domain module registers its own ipcMain.handle() calls. State that
// crosses domains (orchestrator, autoApprove, etc.) flows through the shared
// IpcContext so domain modules stay pure and testable.

const ipcCtx: IpcContext = {
  liveWindow,
  emitToRenderer,
  registry,
  getOrchestrator: (id) => registry.resolve(id)?.orchestrator ?? null,
  getCurrentCwd: (id) => registry.resolve(id)?.cwd ?? null,
  getSlot: (id) => registry.resolve(id),
  getAutoApprove: () => autoApprove,
  setAutoApprove: (v) => { autoApprove = v; },
  getClaudeShadowHome: () => claudeShadowHome,
  nativeConfirmDestructive,
};

registerSessionIpc(ipcCtx);
registerSessionsIpc(ipcCtx);
registerAuthIpc();
registerDesktopIpc();
registerAsrIpc();
registerSettingsIpc();
registerMemoryIpc(ipcCtx);
registerDecisionIpc();
registerDialogIpc(ipcCtx);
registerAttachmentsIpc(ipcCtx);
registerDocumentsIpc(ipcCtx);
registerTranscriptsIpc();

// ---- App lifecycle ----------------------------------------------------------

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

  // Prompt for microphone access at launch. On macOS this shows the native
  // system dialog when the status is 'not-determined'; on already-granted or
  // denied systems it returns immediately without re-prompting.
  if (process.platform === 'darwin') {
    void systemPreferences.askForMediaAccess('microphone').then((granted) => {
      console.log('[mic-permission] launch-time request result:', granted);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tears down every live slot. Orchestrator.end() returns a Promise that
// resolves once async cleanup (recap, etc.) finishes — we collect those so
// callers can await the whole fleet before letting Electron exit. Registry
// entries are dropped synchronously up front; the async work continues to
// run against detached orchestrator instances.
function shutdownAllSlots(): Promise<void> {
  const endPromises: Promise<void>[] = [];
  for (const slot of registry.values()) {
    try {
      endPromises.push(slot.orchestrator.end());
    } catch {
      /* ignore — best-effort teardown */
    }
  }
  for (const slot of [...registry.values()]) {
    registry.close(slot.id);
  }
  return Promise.all(endPromises).then(() => undefined);
}

app.on('window-all-closed', () => {
  // Fire-and-forget on this path: the relevant subprocess kills land
  // synchronously inside end() (scheduler.endAll + talker.end), so even
  // without awaiting we don't strand zombies. Recap continues in background.
  void shutdownAllSlots();
  // Reap any in-flight whisper-cli child so it doesn't strand a transcription
  // run past window close (B1).
  disposeWhisper();
  if (process.platform !== 'darwin') app.quit();
});

// Final safety net: even on cmd-Q with the dock alive (macOS) the window-all-
// closed handler doesn't fire. before-quit covers that path so whisper-cli
// always gets SIGTERM'd.
//
// v0.7.3: Electron used to terminate this process the moment the handler
// returned, killing recap + SDK subprocess teardown mid-flight and leaving
// zombie children behind. Now we preventDefault, await teardown (capped at
// 5s so a stuck recap can't block Cmd-Q indefinitely), then app.exit(0).
let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) {
    // Re-entrant — let Electron actually quit this time.
    return;
  }
  isQuitting = true;
  event.preventDefault();

  void (async () => {
    try {
      await Promise.race([shutdownAllSlots(), sleepMs(5000)]);
    } finally {
      disposeWhisper();
      app.exit(0);
    }
  })();
});
