// documents:* IPC — read a worker's just-delivered file off disk for the
// renderer's ScreenStage "delivery acceptance" panel. Path is validated to
// live under the active session's workspace cwd; renderer cannot ask for
// arbitrary files via this channel.
//
// Sibling `session:steer-worker` lives here too: the acceptance panel's
// "still needs work + 修改意见" button funnels feedback through it, which
// reaches Orchestrator.steerWorker → WorkerScheduler.steerWorker and lands on
// the same worker session as a (plan update) addendum.

import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, resolve as pathResolve, sep } from 'node:path';
import { formatError } from '../format-error.js';
import type { IpcContext } from './context.js';
import { classifyKind, parseAttachment, type AttachmentKind } from '../attachments/parse.js';

// Cap any single deliverable we'll fetch into the renderer. 8 MB on disk
// covers code files, generated PDFs, screenshots, and short videos; anything
// larger we hand back as a "binary placeholder" entry so the user still sees
// it in the list without us streaming hundreds of MB across the IPC.
const MAX_READ_BYTES = 8 * 1024 * 1024;
// Text files: we slice the on-disk bytes to a renderer-friendly upper bound so
// a 5 MB generated log doesn't drag the preview pane down. The user can still
// open the file in their editor.
const MAX_TEXT_BYTES = 512 * 1024;

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const VIDEO_MIME_BY_EXT: Record<string, 'video/mp4' | 'video/webm' | 'video/quicktime'> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export type DeliveryFileKind = AttachmentKind | 'video' | 'binary' | 'missing';

export interface DocumentReadResult {
  ok: true;
  path: string;
  name: string;
  sizeBytes: number;
  kind: DeliveryFileKind;
  /** UTF-8 text for text-like deliverables; may be truncated. */
  text?: string;
  /** True if `text` was sliced by MAX_TEXT_BYTES. */
  truncated?: boolean;
  /** base64 payload for image/video kinds. Word/pdf NOT base64-shipped —
   *  they are parsed to text on the main side. */
  dataBase64?: string;
  /** Media type for image/video kinds. */
  mediaType?: string;
}

export interface DocumentReadError {
  ok: false;
  error: string;
  code?: 'not-in-cwd' | 'no-session' | 'missing' | 'too-large' | 'read-failed' | 'invalid-path';
}

interface RawReadPayload {
  sessionId?: unknown;
  path?: unknown;
}

interface RawSteerPayload {
  sessionId?: unknown;
  workerId?: unknown;
  addendum?: unknown;
}

function pickSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function isUnderCwd(absPath: string, cwd: string): boolean {
  // Resolve both sides + ensure the path lives strictly under cwd. `..`
  // segments collapse via pathResolve; a malicious "/../etc/passwd" turns
  // into an absolute path outside cwd and fails the prefix check.
  const normalisedCwd = pathResolve(cwd) + sep;
  const normalisedPath = pathResolve(absPath) + sep;
  return normalisedPath.startsWith(normalisedCwd) || pathResolve(absPath) === pathResolve(cwd);
}

function extensionOf(name: string): string | null {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

function detectKind(name: string): DeliveryFileKind {
  const ext = extensionOf(name);
  if (ext && VIDEO_EXTENSIONS.has(ext)) return 'video';
  const k = classifyKind(name, '');
  if (k) return k;
  return 'binary';
}

export function registerDocumentsIpc(ctx: IpcContext): void {
  ipcMain.handle('documents:read', async (_e, payload: RawReadPayload): Promise<DocumentReadResult | DocumentReadError> => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session', code: 'no-session' };

    const rawPath = typeof payload?.path === 'string' ? payload.path : '';
    if (!rawPath || !isAbsolute(rawPath)) {
      return { ok: false, error: 'Path must be absolute', code: 'invalid-path' };
    }

    const cwd = slot.cwd;
    if (!cwd || !isUnderCwd(rawPath, cwd)) {
      return { ok: false, error: 'Path is not inside the session workspace', code: 'not-in-cwd' };
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(rawPath);
    } catch (err: unknown) {
      return { ok: false, error: `File not found: ${basename(rawPath)}`, code: 'missing' };
    }

    if (!stat.isFile()) {
      return { ok: false, error: 'Path is not a regular file', code: 'invalid-path' };
    }

    const sizeBytes = stat.size;
    const name = basename(rawPath);
    const kind = detectKind(name);

    // Oversized → return a metadata-only "binary" entry so the renderer can
    // still show the file in the list with size + an "open in finder" hint.
    if (sizeBytes > MAX_READ_BYTES) {
      return {
        ok: true,
        path: rawPath,
        name,
        sizeBytes,
        kind: 'binary',
      };
    }

    try {
      if (kind === 'text') {
        const buffer = await fs.readFile(rawPath);
        const truncated = buffer.length > MAX_TEXT_BYTES;
        const slice = truncated ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer;
        return {
          ok: true,
          path: rawPath,
          name,
          sizeBytes,
          kind: 'text',
          text: slice.toString('utf8'),
          truncated,
        };
      }

      if (kind === 'image') {
        const buffer = await fs.readFile(rawPath);
        const ext = extensionOf(name);
        const mediaType =
          ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
              : 'image/jpeg';
        return {
          ok: true,
          path: rawPath,
          name,
          sizeBytes,
          kind: 'image',
          dataBase64: buffer.toString('base64'),
          mediaType,
        };
      }

      if (kind === 'video') {
        const buffer = await fs.readFile(rawPath);
        const ext = extensionOf(name) ?? 'mp4';
        const mediaType = VIDEO_MIME_BY_EXT[ext] ?? 'video/mp4';
        return {
          ok: true,
          path: rawPath,
          name,
          sizeBytes,
          kind: 'video',
          dataBase64: buffer.toString('base64'),
          mediaType,
        };
      }

      if (kind === 'word' || kind === 'pdf') {
        // Reuse the same parser used for inbound attachments: returns text.
        const buffer = await fs.readFile(rawPath);
        const parsed = await parseAttachment({
          name,
          mime: kind === 'word'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/pdf',
          sizeBytes,
          dataBase64: buffer.toString('base64'),
        });
        return {
          ok: true,
          path: rawPath,
          name,
          sizeBytes,
          kind,
          text: parsed.text ?? '',
        };
      }

      // Unknown binary — return metadata only.
      return {
        ok: true,
        path: rawPath,
        name,
        sizeBytes,
        kind: 'binary',
      };
    } catch (err: unknown) {
      return { ok: false, error: `Read failed: ${formatError(err)}`, code: 'read-failed' };
    }
  });

  ipcMain.handle('session:steer-worker', (_e, payload: RawSteerPayload) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const workerId = typeof payload?.workerId === 'string' ? payload.workerId : '';
    const addendum = typeof payload?.addendum === 'string' ? payload.addendum : '';
    if (!workerId) return { ok: false, error: 'Missing workerId' };
    if (!addendum.trim()) return { ok: false, error: 'Empty addendum' };
    const result = slot.orchestrator.steerWorker(workerId, addendum.trim());
    ctx.registry.touch(slot.id);
    if (!result.ok) {
      return { ok: false, error: `steer-worker failed: ${result.reason}`, reason: result.reason };
    }
    return { ok: true, queued: result.queued === true };
  });
}
