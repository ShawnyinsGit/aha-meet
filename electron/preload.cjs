const { contextBridge, ipcRenderer } = require('electron');

// Most send* methods take an explicit sessionId so the renderer can target a
// specific tab's Orchestrator. Passing `null` (or omitting it) lets main fall
// back to the currently-active slot — used by legacy callsites that haven't
// been threaded for tabs yet.
const api = {
  sessions: {
    open: (cwd, greeting) => ipcRenderer.invoke('sessions:open', { cwd, greeting }),
    close: (id) => ipcRenderer.invoke('sessions:close', { id }),
    setActive: (id) => ipcRenderer.invoke('sessions:set-active', { id }),
    list: () => ipcRenderer.invoke('sessions:list'),
    listRestore: () => ipcRenderer.invoke('sessions:list-restore'),
  },
  sendUserText: (sessionId, text) =>
    ipcRenderer.invoke('session:user-text', { sessionId, text }),
  sendUserImage: (sessionId, dataUrl, caption) =>
    ipcRenderer.invoke('session:user-image', { sessionId, dataUrl, caption }),
  sendUserAttachments: (sessionId, items, caption) =>
    ipcRenderer.invoke('session:user-attachments', { sessionId, items, caption }),
  resolvePermission: (sessionId, id, decision, message) =>
    ipcRenderer.invoke('session:resolve-permission', { sessionId, id, decision, message }),
  interrupt: (sessionId) => ipcRenderer.invoke('session:interrupt', { sessionId }),
  setPermissionMode: (sessionId, mode) =>
    ipcRenderer.invoke('session:set-permission-mode', { sessionId, mode }),
  setAutoApprove: (scope) => ipcRenderer.invoke('session:set-auto-approve', { scope }),
  endSession: (sessionId) => ipcRenderer.invoke('session:end', { sessionId }),
  pickCwd: () => ipcRenderer.invoke('dialog:pick-cwd'),
  getVoiceConfig: () => ipcRenderer.invoke('settings:get-voice-config'),
  setVoiceLockEnabled: (on) => ipcRenderer.invoke('settings:set-voice-lock-enabled', on),
  setVoicePrint: (vp) => ipcRenderer.invoke('settings:set-voice-print', vp),
  getVoicePref: () => ipcRenderer.invoke('settings:get-voice-pref'),
  setVoicePref: (patch) => ipcRenderer.invoke('settings:set-voice-pref', patch),
  openVoiceSettings: () => ipcRenderer.invoke('system:open-voice-settings'),
  getDesktopSources: () => ipcRenderer.invoke('desktop:get-sources'),
  checkScreenPermission: () => ipcRenderer.invoke('desktop:check-permission'),
  openScreenSettings: () => ipcRenderer.invoke('desktop:open-settings'),
  requestMicPermission: () => ipcRenderer.invoke('mic:request-permission'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  asrAvailable: () => ipcRenderer.invoke('asr:available'),
  transcribePcm: (pcmBuffer, lang) => ipcRenderer.invoke('asr:transcribe', pcmBuffer, lang),
  auth: {
    getConfig: () => ipcRenderer.invoke('auth:get-config'),
    setApiKey: (key) => ipcRenderer.invoke('auth:set-api-key', key),
    setMode: (mode) => ipcRenderer.invoke('auth:set-mode', mode),
    loginSubscription: () => ipcRenderer.invoke('auth:login-subscription'),
    checkSubscriptionStatus: () => ipcRenderer.invoke('auth:check-subscription-status'),
  },
  memory: {
    list: (filter) => ipcRenderer.invoke('memory:list', filter ?? null),
    update: (id, patch) => ipcRenderer.invoke('memory:update', { id, patch }),
    delete: (id) => ipcRenderer.invoke('memory:delete', id),
    currentProjectId: (sessionId) => ipcRenderer.invoke('memory:projectId', { sessionId }),
  },
  decisions: {
    open: (path) => ipcRenderer.invoke('decision:open', path),
  },
  documents: {
    read: (sessionId, path) => ipcRenderer.invoke('documents:read', { sessionId, path }),
  },
  transcripts: {
    load: (cwd) => ipcRenderer.invoke('transcripts:load', { cwd }),
    // Fire-and-forget: the renderer's caller already ignores the result
    // (.catch swallows errors), so we skip the round-trip ack. Saves an
    // extra IPC reply per transcript line — at 5–10 lines/sec during a busy
    // meeting that's 10–30 ms/sec of main-thread time freed up. We still
    // return a resolved Promise to preserve the existing type shape.
    append: (cwd, entry) => {
      ipcRenderer.send('transcripts:append', { cwd, entry });
      return Promise.resolve({ ok: true });
    },
    clear: (cwd) => ipcRenderer.invoke('transcripts:clear', { cwd }),
  },
  steerWorker: (sessionId, workerId, addendum) =>
    ipcRenderer.invoke('session:steer-worker', { sessionId, workerId, addendum }),
  onEvent: (cb) => {
    const listener = (_, e) => cb(e);
    ipcRenderer.on('session:event', listener);
    return () => ipcRenderer.removeListener('session:event', listener);
  },
};

contextBridge.exposeInMainWorld('vibeMeet', api);
