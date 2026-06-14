// IPC handlers for skill management: list, install, uninstall.

import { ipcMain } from 'electron';
import {
  listSkills,
  installSkill,
  uninstallSkill,
} from '../skills.js';
import { errorMessage } from '../format-error.js';

export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', async () => {
    try {
      const skills = await listSkills();
      return { ok: true, skills };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('skills:install', async (_e, source: unknown) => {
    try {
      if (typeof source !== 'string' || source.trim().length === 0) {
        return { ok: false, error: '请输入 Skill 链接或本地路径' };
      }
      const skill = await installSkill(source);
      return { ok: true, skill };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('skills:uninstall', async (_e, name: unknown) => {
    try {
      if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, error: 'name is required' };
      }
      await uninstallSkill(name);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  });
}
