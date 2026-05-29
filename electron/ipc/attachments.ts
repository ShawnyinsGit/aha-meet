// Receives raw attachment payloads from the renderer, parses/extracts text,
// then either inlines content blocks straight into the next user message or
// spills the file to `<cwd>/.vibe-attachments/` and tells Talker the path.

import { ipcMain } from 'electron';
import { formatError } from '../format-error.js';
import type { IpcContext } from './context.js';
import {
  classifyKind,
  formatBytes,
  formatInlineTextBlock,
  parseAttachment,
  type AttachmentKind,
  type ParsedAttachment,
  type RawAttachmentItem,
} from '../attachments/parse.js';
import {
  ensureAttachmentsDir,
  maybeAppendGitignore,
  writeAttachmentSafely,
} from '../attachments/workspace.js';

// Inline payloads travel through the Anthropic content array. The Talker runs
// on a Haiku-class window (~200K tokens) shared with system prompt + memory +
// tool defs + chat history, so a single oversized inline block can blow the
// budget AND poison SDK conversation history (every retry replays the bad
// message). Keep the per-file and aggregate caps small; anything over spills
// to `<cwd>/.vibe-attachments/` and Talker is told to Read it on demand.
const INLINE_TEXT_MAX = 32 * 1024;             // 32 KB per file (~8K tokens for CJK)
const INLINE_TEXT_AGGREGATE_MAX = 96 * 1024;   // 96 KB across all inline text blocks (~24K tokens)
const INLINE_IMAGE_MAX = 2 * 1024 * 1024;      // 2 MB raw image bytes
const HARD_LIMIT_PER_FILE = 25 * 1024 * 1024;  // 25 MB raw
const HARD_LIMIT_TOTAL = 50 * 1024 * 1024;     // 50 MB raw aggregate

interface RawPayload {
  sessionId?: unknown;
  items?: unknown;
  caption?: unknown;
}

function pickSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp'; data: string } };

export function registerAttachmentsIpc(ctx: IpcContext): void {
  ipcMain.handle('session:user-attachments', async (_e, payload: RawPayload) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const o = slot.orchestrator;

    const items = Array.isArray(payload?.items) ? (payload.items as unknown[]) : [];
    if (items.length === 0) return { ok: false, error: 'No attachments provided' };
    if (items.length > 20) return { ok: false, error: 'Too many attachments in one send (max 20)' };

    const caption = typeof payload?.caption === 'string' ? payload.caption : '';

    // First pass: shape-check + size pre-flight before we burn CPU on parse.
    const raw: RawAttachmentItem[] = [];
    let totalBytes = 0;
    for (const it of items) {
      if (!it || typeof it !== 'object') {
        return { ok: false, error: 'Invalid attachment item shape' };
      }
      const obj = it as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name : '';
      const mime = typeof obj.mime === 'string' ? obj.mime : '';
      const sizeBytes = typeof obj.sizeBytes === 'number' ? obj.sizeBytes : -1;
      const dataBase64 = typeof obj.dataBase64 === 'string' ? obj.dataBase64 : '';
      if (!name || sizeBytes < 0 || !dataBase64) {
        return { ok: false, error: 'Attachment missing required fields' };
      }
      // Enforce caps on the REAL decoded byte count, not the renderer-reported
      // sizeBytes (which a buggy/malicious renderer can understate to smuggle
      // hundreds of MB past the total cap and OOM the main process at decode).
      // Buffer.byteLength counts decoded bytes without allocating the buffer.
      const actualBytes = Buffer.byteLength(dataBase64, 'base64');
      if (actualBytes > HARD_LIMIT_PER_FILE) {
        return { ok: false, error: `${name}: file exceeds ${formatBytes(HARD_LIMIT_PER_FILE)} per-file limit` };
      }
      totalBytes += actualBytes;
      if (totalBytes > HARD_LIMIT_TOTAL) {
        return { ok: false, error: `Combined attachments exceed ${formatBytes(HARD_LIMIT_TOTAL)} total limit` };
      }
      const kind = classifyKind(name, mime);
      if (!kind) {
        return { ok: false, error: `${name}: unsupported file type (${mime || 'no mime'})` };
      }
      raw.push({ name, mime, sizeBytes, dataBase64 });
    }

    // Parse all attachments. Word/PDF extraction is async — run in parallel.
    let parsed: ParsedAttachment[];
    try {
      parsed = await Promise.all(raw.map(parseAttachment));
    } catch (err: unknown) {
      return { ok: false, error: `Parse failed: ${formatError(err)}` };
    }

    const blocks: ContentBlock[] = [];
    const meta: Array<{ name: string; kind: AttachmentKind; sizeBytes: number; route: 'inline' | 'workspace' }> = [];
    let inlinedCount = 0;
    let workspaceCount = 0;
    let inlineTextUsed = 0; // running total of inline text chars across all attachments
    inlineTextUsed += caption.trim().length; // caption shares the same budget
    const cwd = slot.cwd;

    for (const p of parsed) {
      const route = decideRoute(p, inlineTextUsed);
      if (route === 'inline') {
        if (p.kind === 'image') {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: p.imageMediaType ?? 'image/jpeg',
              data: p.buffer.toString('base64'),
            },
          });
          meta.push({ name: p.name, kind: p.kind, sizeBytes: p.sizeBytes, route: 'inline' });
          inlinedCount++;
        } else {
          const textBlock = formatInlineTextBlock(p);
          blocks.push({ type: 'text', text: textBlock });
          inlineTextUsed += textBlock.length;
          meta.push({ name: p.name, kind: p.kind, sizeBytes: p.sizeBytes, route: 'inline' });
          inlinedCount++;
        }
        continue;
      }

      // Workspace route. Falls back to inline if workspace write fails AND the
      // file is small enough to inline safely.
      if (!cwd) {
        // No active cwd yet — can't write. Try inline as a last resort.
        const inlineBlock = tryInlineFallback(p, inlineTextUsed);
        if (inlineBlock) {
          blocks.push(inlineBlock);
          if (inlineBlock.type === 'text') inlineTextUsed += inlineBlock.text.length;
          meta.push({ name: p.name, kind: p.kind, sizeBytes: p.sizeBytes, route: 'inline' });
          inlinedCount++;
          continue;
        }
        return { ok: false, error: `${p.name}: too large to inline and no active workspace to spill into` };
      }
      const dir = await ensureAttachmentsDir(cwd);
      if (!dir) {
        const inlineBlock = tryInlineFallback(p, inlineTextUsed);
        if (inlineBlock) {
          blocks.push(inlineBlock);
          if (inlineBlock.type === 'text') inlineTextUsed += inlineBlock.text.length;
          meta.push({ name: p.name, kind: p.kind, sizeBytes: p.sizeBytes, route: 'inline' });
          inlinedCount++;
          continue;
        }
        return { ok: false, error: `${p.name}: failed to create .vibe-attachments dir and file too large to inline` };
      }
      try {
        const written = await writeAttachmentSafely(dir, p.name, p.buffer);
        await maybeAppendGitignore(cwd);
        blocks.push({
          type: 'text',
          text: formatWorkspaceNotice(p, written.absPath, written.finalName),
        });
        meta.push({ name: p.name, kind: p.kind, sizeBytes: p.sizeBytes, route: 'workspace' });
        workspaceCount++;
      } catch (err: unknown) {
        return { ok: false, error: `${p.name}: workspace write failed (${formatError(err)})` };
      }
    }

    // Caption / default footer text always lands last so the model sees:
    // [attachment-1, attachment-2, ..., user-question]
    const tail = caption.trim().length > 0
      ? caption.trim()
      : defaultCaption(parsed);
    blocks.push({ type: 'text', text: tail });

    try {
      o.sendUserImage(blocks);
      ctx.registry.touch(slot.id);
    } catch (err: unknown) {
      return { ok: false, error: `Send failed: ${formatError(err)}` };
    }
    return { ok: true, inlinedCount, workspaceCount, meta };
  });
}

function decideRoute(p: ParsedAttachment, inlineTextUsed: number): 'inline' | 'workspace' {
  if (p.kind === 'image') {
    return p.sizeBytes <= INLINE_IMAGE_MAX ? 'inline' : 'workspace';
  }
  const textLen = (p.text ?? '').length;
  if (textLen > INLINE_TEXT_MAX) return 'workspace';
  if (inlineTextUsed + textLen > INLINE_TEXT_AGGREGATE_MAX) return 'workspace';
  return 'inline';
}

function tryInlineFallback(p: ParsedAttachment, inlineTextUsed: number): ContentBlock | null {
  if (p.kind === 'image') {
    if (p.sizeBytes > INLINE_IMAGE_MAX) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: p.imageMediaType ?? 'image/jpeg',
        data: p.buffer.toString('base64'),
      },
    };
  }
  const textLen = (p.text ?? '').length;
  if (textLen > INLINE_TEXT_MAX) return null;
  if (inlineTextUsed + textLen > INLINE_TEXT_AGGREGATE_MAX) return null;
  return { type: 'text', text: formatInlineTextBlock(p) };
}

function formatWorkspaceNotice(p: ParsedAttachment, absPath: string, finalName: string): string {
  const sizeLabel = formatBytes(p.sizeBytes);
  return [
    `--- attached file: ${p.name} (${p.kind}, ${sizeLabel}) ---`,
    `File was too large to inline. It has been saved at:`,
    absPath,
    `Use the Read tool (or hand it off to a Worker) when you need its contents.`,
    `Saved name: ${finalName}`,
    `--- end ${p.name} ---`,
  ].join('\n');
}

function defaultCaption(parsed: ParsedAttachment[]): string {
  if (parsed.length === 1) {
    const p = parsed[0];
    return `I've attached ${p.name}. Please take a look.`;
  }
  return `I've attached ${parsed.length} files. Please take a look.`;
}
