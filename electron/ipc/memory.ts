import { ipcMain } from 'electron';
import {
  computeProjectId,
  deleteEntry as deleteMemoryEntry,
  listEntries as listMemoryEntries,
  updateEntry as updateMemoryEntry,
  type MemoryCategory,
  type MemoryListFilter,
} from '../memory.js';
import { errorMessage } from '../format-error.js';
import type { IpcContext } from './context.js';

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

export function registerMemoryIpc(ctx: IpcContext): void {
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
    const cwd = ctx.getCurrentCwd();
    if (!cwd) return null;
    try {
      return computeProjectId(cwd);
    } catch (err) {
      console.error('[memory] computeProjectId failed:', err);
      return null;
    }
  });
}
