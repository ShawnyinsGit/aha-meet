const { contextBridge, ipcRenderer } = require('electron');

const api = {
  startSession: (cwd, greeting) => ipcRenderer.invoke('session:start', cwd, greeting),
  sendUserText: (text) => ipcRenderer.invoke('session:user-text', text),
  sendUserImage: (dataUrl, caption) => ipcRenderer.invoke('session:user-image', dataUrl, caption),
  resolvePermission: (id, decision, message) =>
    ipcRenderer.invoke('session:resolve-permission', id, decision, message),
  interrupt: () => ipcRenderer.invoke('session:interrupt'),
  setPermissionMode: (mode) => ipcRenderer.invoke('session:set-permission-mode', mode),
  setAutoApprove: (on) => ipcRenderer.invoke('session:set-auto-approve', on),
  endSession: () => ipcRenderer.invoke('session:end'),
  pickCwd: () => ipcRenderer.invoke('dialog:pick-cwd'),
  getLastCwd: () => ipcRenderer.invoke('settings:get-last-cwd'),
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
    currentProjectId: () => ipcRenderer.invoke('memory:projectId'),
  },
  decisions: {
    open: (path) => ipcRenderer.invoke('decision:open', path),
  },
  onEvent: (cb) => {
    const listener = (_, e) => cb(e);
    ipcRenderer.on('session:event', listener);
    return () => ipcRenderer.removeListener('session:event', listener);
  },
};

contextBridge.exposeInMainWorld('vibeMeet', api);
