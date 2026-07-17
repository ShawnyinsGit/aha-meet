// opencode-files.ts — IPC handlers for OpenCode editor file operations.
// Uses Node.js fs directly (not OpenCode SDK) to browse the project directory.

import { ipcMain } from 'electron';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
}

const MAX_FILE_SIZE = 512 * 1024; // 512KB

function isPathSafe(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith('..') && !relative(root, target).startsWith('/') && !resolve(target).includes('..');
}

export function registerOpenCodeFilesIpc(): void {
  ipcMain.handle('opencode-files:list', async (_event, payload: { cwd: string; path?: string }) => {
    try {
      const root = resolve(payload.cwd);
      const target = payload.path ? resolve(root, payload.path) : root;

      if (!isPathSafe(root, target)) {
        return { ok: false, error: 'Path outside workspace' };
      }

      const entries = await readdir(target, { withFileTypes: true });
      const result: FileEntry[] = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = join(target, entry.name);
          const stats = await stat(fullPath).catch(() => null);
          return {
            name: entry.name,
            path: relative(root, fullPath),
            isDir: entry.isDirectory(),
            size: stats?.size ?? 0,
            modifiedAt: stats?.mtimeMs ?? 0,
          };
        }),
      );

      // Sort: dirs first, then files, alphabetically
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { ok: true, entries: result };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('opencode-files:read', async (_event, payload: { cwd: string; path: string }) => {
    try {
      const root = resolve(payload.cwd);
      const target = resolve(root, payload.path);

      if (!isPathSafe(root, target)) {
        return { ok: false, error: 'Path outside workspace' };
      }

      const stats = await stat(target);
      if (stats.size > MAX_FILE_SIZE) {
        return { ok: false, error: 'File too large' };
      }

      const content = await readFile(target, 'utf-8');
      return {
        ok: true,
        file: {
          path: payload.path,
          content,
          truncated: false,
        } as FileContent,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
