// Minimal stub of the parts of `electron` that the orchestrator's transitive
// imports touch at module load time. The test never reaches code that calls
// these — they exist only so `import { app } from 'electron'` resolves.

export const app = {
  getPath: () => '/tmp',
  isPackaged: false,
};
export const ipcMain = { handle: () => {}, on: () => {} };
export const dialog = {};
export const desktopCapturer = {};
export const systemPreferences = { getMediaAccessStatus: () => 'granted' };
export const shell = {};
export const BrowserWindow = class {};

export default { app, ipcMain, dialog, desktopCapturer, systemPreferences, shell, BrowserWindow };
