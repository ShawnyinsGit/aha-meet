// transcripts IPC — load / append / clear per-cwd transcript files.
//
// `append` is one-way (`ipcMain.on` + `ipcRenderer.send`) — the renderer
// already ignores the result and we want to avoid a round-trip ack per
// transcript line (5–10/sec during busy meetings). Failures are logged here
// instead of bubbling back; a stuck disk shouldn't disrupt the UI but should
// still be visible in the main-process console.
//
// `load` and `clear` stay round-trip (`ipcMain.handle`) because their callers
// genuinely need the result.

import { ipcMain } from 'electron';
import {
  appendTranscript,
  clearTranscript,
  loadTranscript,
} from '../transcript-store.js';
import { errorMessage } from '../format-error.js';
import type { IpcContext } from './context.js';
import { saveChatMessage } from '../materials.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const VALID_ROLES = new Set(['user', 'assistant', 'system']);
const VALID_ATTACHMENT_KINDS = new Set(['text', 'image', 'word', 'pdf']);

interface ValidTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  imageUrl?: string;
  attachments?: { name: string; kind: string; sizeBytes: number }[];
}

function isValidTranscriptEntry(v: unknown): v is ValidTranscriptEntry {
  if (v === null || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.role !== 'string' || !VALID_ROLES.has(e.role)) return false;
  if (typeof e.text !== 'string') return false;
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
  if (e.imageUrl !== undefined && typeof e.imageUrl !== 'string') return false;
  if (e.attachments !== undefined) {
    if (!Array.isArray(e.attachments)) return false;
    for (const a of e.attachments) {
      if (a === null || typeof a !== 'object') return false;
      const att = a as Record<string, unknown>;
      if (typeof att.name !== 'string') return false;
      if (typeof att.kind !== 'string' || !VALID_ATTACHMENT_KINDS.has(att.kind))
        return false;
      if (typeof att.sizeBytes !== 'number' || !Number.isFinite(att.sizeBytes))
        return false;
    }
  }
  return true;
}

function sanitizeEntry(e: ValidTranscriptEntry): ValidTranscriptEntry {
  const clean: ValidTranscriptEntry = {
    id: e.id,
    role: e.role as 'user' | 'assistant' | 'system',
    text: e.text,
    ts: e.ts,
  };
  if (e.imageUrl !== undefined) clean.imageUrl = e.imageUrl;
  if (e.attachments !== undefined) {
    clean.attachments = e.attachments.map((a) => ({
      name: a.name,
      kind: a.kind,
      sizeBytes: a.sizeBytes,
    }));
  }
  return clean;
}

export function registerTranscriptsIpc(ctx: IpcContext): void {
  ipcMain.handle('transcripts:load', async (_e, payload: unknown) => {
    try {
      const cwd = (payload as { cwd?: unknown } | undefined)?.cwd;
      if (!isNonEmptyString(cwd)) {
        return { ok: false as const, error: 'invalid cwd' };
      }
      // No session gate — transcripts are keyed by projectId (sha1 of realpath),
      // so a stale/missing session just returns [] from the file store. This
      // lets the renderer load history for a cwd even if the session hasn't
      // finished registering yet, or was already torn down.
      const entries = await loadTranscript(cwd);
      return { ok: true as const, entries };
    } catch (err: unknown) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });

  ipcMain.on('transcripts:append', (_e, payload: unknown) => {
    const p = payload as { cwd?: unknown; entry?: unknown } | undefined;
    const cwd = p?.cwd;
    if (!isNonEmptyString(cwd)) {
      console.warn('[transcripts] append: invalid cwd, dropping');
      return;
    }
    // No session gate — the transcript store writes to a per-projectId JSONL
    // file keyed by sha1(realpath(cwd)). Writing without an active session is
    // safe: the file is created on demand and only the renderer that owns the
    // slot calls append. Previously the gate dropped the last few entries
    // during session teardown (registry cleared before the IPC pipeline
    // drained), causing the tail of the conversation to vanish on reopen.
    if (!p || p.entry === undefined || p.entry === null) {
      console.warn('[transcripts] append: missing entry, dropping');
      return;
    }
    if (!isValidTranscriptEntry(p.entry)) {
      console.warn('[transcripts] append: entry failed schema validation, dropping');
      return;
    }
    const cleaned = sanitizeEntry(p.entry);
    appendTranscript(cwd, cleaned).catch((err: unknown) => {
      console.error('[transcripts] append failed:', errorMessage(err));
    });
    // Also save to local materials directory for persistent reference.
    // Only when a session is active — materials are session-scoped.
    if (ctx.registry.findByCwd(cwd)) {
      saveChatMessage({
        cwd,
        role: cleaned.role,
        text: cleaned.text,
        ts: cleaned.ts,
        imageUrl: cleaned.imageUrl,
        attachments: cleaned.attachments,
      }).catch((err: unknown) => {
        console.warn('[transcripts] saveChatMessage failed:', errorMessage(err));
      });
    }
  });

  ipcMain.handle('transcripts:clear', async (_e, payload: unknown) => {
    try {
      const cwd = (payload as { cwd?: unknown } | undefined)?.cwd;
      if (!isNonEmptyString(cwd)) {
        return { ok: false as const, error: 'invalid cwd' };
      }
      // No session gate — clear the JSONL regardless of session state so the
      // renderer can wipe history even during teardown.
      await clearTranscript(cwd);
      return { ok: true as const };
    } catch (err: unknown) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });
}
