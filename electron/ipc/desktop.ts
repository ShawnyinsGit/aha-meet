import { ipcMain, app, desktopCapturer, systemPreferences, shell } from 'electron';
import { errorMessage } from '../format-error.js';

export function registerDesktopIpc(): void {
  ipcMain.handle('desktop:get-sources', async () => {
    try {
      const status = process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'granted';
      if (status !== 'granted') {
        // Not-determined needs special handling on macOS: calling getSources
        // is what registers AhaMeet in the Screen Recording list under System
        // Settings, so we still fire it (best-effort, ignore the result) before
        // returning. Without that ping, AhaMeet won't appear for the user to
        // toggle on. The OS may also raise its own prompt at this point.
        if (status === 'not-determined') {
          desktopCapturer
            .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
            .catch(() => { /* expected — perm prompt is the point */ });
        }
        return { ok: false, error: 'permission-needed', status };
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

  // One-click relaunch after the user grants Screen Recording in System
  // Settings. macOS only applies new screen-capture permissions to processes
  // that start *after* the grant, so the running AhaMeet keeps seeing 'denied'
  // until we restart.
  ipcMain.handle('app:relaunch', async () => {
    app.relaunch();
    app.exit(0);
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

  ipcMain.handle('mic:request-permission', async () => {
    if (process.platform !== 'darwin') return true;
    // askForMediaAccess shows the macOS native permission dialog when status is
    // 'not-determined', and returns false immediately if already denied (the user
    // must change it in System Settings). Returns true if already granted.
    return systemPreferences.askForMediaAccess('microphone');
  });
}
