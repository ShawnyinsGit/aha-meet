import { ipcMain, dialog } from 'electron';
import { homedir } from 'node:os';
import type { IpcContext } from './context.js';

export function registerDialogIpc(ctx: IpcContext): void {
  ipcMain.handle('dialog:pick-cwd', async () => {
    const win = ctx.liveWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: homedir(),
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const picked = res.filePaths[0];
    // S6: surface the implicit grant. Picking a folder hands every Worker in
    // the meeting Read/Write/Bash access to that path and all subdirectories.
    // We want one moment of friction here so the user isn't surprised when a
    // Worker starts modifying files later.
    // Re-fetch liveWindow because the showOpenDialog above is async — the user
    // may have cmd-Q'd between picking and confirming.
    const winConfirm = ctx.liveWindow();
    if (!winConfirm) return null;
    const confirm = await dialog.showMessageBox(winConfirm, {
      type: 'warning',
      title: 'Confirm meeting workspace',
      message: 'Workers will get filesystem and shell access',
      detail:
        `AhaMeet workers will be able to read, write, and run shell commands in:\n\n${picked}\n\n` +
        'and all subdirectories. Individual tool calls still require your approval unless ' +
        'you enable auto-approve in settings.',
      buttons: ['Cancel', 'Confirm'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirm.response !== 1) return null;
    return picked;
  });
}
