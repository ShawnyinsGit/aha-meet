// materials.ts — Unified local materials saving system.
//
// Saves chat transcripts, file attachments, and screenshots to a structured
// directory under the project cwd: `.vibe-materials/`.
//
// Structure:
//   .vibe-materials/
//     README.md          # Auto-generated index/manifest
//     chat/
//       2026-06-23.md    # Chat logs grouped by date
//       2026-06-24.md
//     files/
//       2026-06-23/
//         report.pdf
//         screenshot-143022.png

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const MATERIALS_DIR = '.vibe-materials';
const CHAT_DIR = 'chat';
const FILES_DIR = 'files';

// Cache per-cwd to avoid re-reading manifest on every append.
const manifestCache = new Map<string, { path: string; lastWrite: number }>();

function dateStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeOnly(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeFilename(name: string): string {
  const stripped = name.replace(/[\/\\\x00-\x1f]/g, '_').trim();
  if (!stripped || stripped === '.' || stripped === '..') return `file-${Date.now()}`;
  if (stripped.length > 180) {
    const ext = extensionOf(stripped);
    const stem = ext ? stripped.slice(0, stripped.length - ext.length - 1) : stripped;
    return ext ? `${stem.slice(0, 170)}.${ext}` : stem.slice(0, 180);
  }
  return stripped;
}

function extensionOf(name: string): string | null {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function maybeAppendGitignore(cwd: string): Promise<void> {
  if (!existsSync(path.join(cwd, '.git'))) return;
  const gitignorePath = path.join(cwd, '.gitignore');
  const entry = `${MATERIALS_DIR}/`;
  try {
    let current = '';
    try {
      current = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      current = '';
    }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(MATERIALS_DIR)) return;
    const sep = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await fs.appendFile(gitignorePath, `${sep}${entry}\n`);
  } catch {
    // best-effort
  }
}

async function writeSafely(dir: string, name: string, buffer: Buffer): Promise<string> {
  const safeBase = sanitizeFilename(name);
  const ext = extensionOf(safeBase);
  const stem = ext ? safeBase.slice(0, safeBase.length - ext.length - 1) : safeBase;

  let candidate = safeBase;
  let n = 2;
  for (;;) {
    const absPath = path.join(dir, candidate);
    try {
      await fs.writeFile(absPath, buffer, { flag: 'wx' });
      return absPath;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      candidate = ext ? `${stem}-${n}.${ext}` : `${stem}-${n}`;
      n++;
      if (n > 9999) throw new Error('too many collisions');
    }
  }
}

export interface SaveChatMessageOptions {
  cwd: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  imageUrl?: string;
  attachments?: { name: string; kind: string; sizeBytes: number }[];
}

/**
 * Append a chat message to the daily markdown file.
 * Returns the absolute path of the updated chat file.
 */
export async function saveChatMessage(opts: SaveChatMessageOptions): Promise<string> {
  const { cwd, role, text, ts, imageUrl, attachments } = opts;
  const chatDir = path.join(cwd, MATERIALS_DIR, CHAT_DIR);
  await ensureDir(chatDir);
  await maybeAppendGitignore(cwd);

  const dateStr = dateStamp();
  const chatFile = path.join(chatDir, `${dateStr}.md`);

  const time = new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  const roleLabel = role === 'user' ? '用户' : role === 'assistant' ? '助手' : '系统';

  const lines: string[] = [];
  lines.push(`\n## ${time} ${roleLabel}\n\n`);
  if (text.trim()) {
    lines.push(text.trim());
    lines.push('\n');
  }
  if (imageUrl) {
    lines.push(`\n![screenshot](${imageUrl})\n`);
  }
  if (attachments && attachments.length > 0) {
    lines.push('\n**附件:**\n');
    for (const a of attachments) {
      const sizeKb = (a.sizeBytes / 1024).toFixed(1);
      lines.push(`- ${a.name} (${a.kind}, ${sizeKb} KB)\n`);
    }
  }

  const content = lines.join('');
  await fs.appendFile(chatFile, content, 'utf8');

  // Update manifest cache timestamp.
  manifestCache.set(cwd, { path: chatFile, lastWrite: ts });

  // Update manifest every 10 messages or on first write.
  await updateManifest(cwd);

  return chatFile;
}

export interface SaveFileOptions {
  cwd: string;
  name: string;
  buffer: Buffer;
}

/**
 * Save a file attachment to the materials directory, grouped by date.
 * Returns the absolute path of the saved file.
 */
export async function saveFileToMaterials(opts: SaveFileOptions): Promise<string> {
  const { cwd, name, buffer } = opts;
  const dateStr = dateStamp();
  const filesDir = path.join(cwd, MATERIALS_DIR, FILES_DIR, dateStr);
  await ensureDir(filesDir);
  await maybeAppendGitignore(cwd);

  const absPath = await writeSafely(filesDir, name, buffer);
  await updateManifest(cwd);
  return absPath;
}

export interface SaveImageOptions {
  cwd: string;
  base64: string;
  mediaType: string;
}

/**
 * Save a screenshot to the materials directory, grouped by date.
 * Returns the absolute path of the saved image.
 */
export async function saveImageToMaterials(opts: SaveImageOptions): Promise<string> {
  const { cwd, base64, mediaType } = opts;
  const dateStr = dateStamp();
  const filesDir = path.join(cwd, MATERIALS_DIR, FILES_DIR, dateStr);
  await ensureDir(filesDir);
  await maybeAppendGitignore(cwd);

  const ext = mimeToExt(mediaType);
  const name = `screenshot-${timeOnly()}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');
  const absPath = await writeSafely(filesDir, name, buffer);
  await updateManifest(cwd);
  return absPath;
}

function mimeToExt(mediaType: string): string {
  if (mediaType.includes('png')) return 'png';
  if (mediaType.includes('gif')) return 'gif';
  if (mediaType.includes('webp')) return 'webp';
  if (mediaType.includes('svg')) return 'svg';
  return 'jpg';
}

/**
 * Update the README.md manifest file with a summary of saved materials.
 */
async function updateManifest(cwd: string): Promise<void> {
  const materialsDir = path.join(cwd, MATERIALS_DIR);
  const manifestPath = path.join(materialsDir, 'README.md');

  try {
    await ensureDir(materialsDir);

    // Gather chat files.
    const chatDir = path.join(materialsDir, CHAT_DIR);
    let chatFiles: string[] = [];
    try {
      const entries = await fs.readdir(chatDir);
      chatFiles = entries.filter((e) => e.endsWith('.md')).sort();
    } catch {
      // no chat dir yet
    }

    // Gather file directories (by date).
    const filesDir = path.join(materialsDir, FILES_DIR);
    let fileDates: string[] = [];
    try {
      const entries = await fs.readdir(filesDir, { withFileTypes: true });
      fileDates = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      // no files dir yet
    }

    const lines: string[] = [];
    lines.push('# 本地素材库\n\n');
    lines.push('此目录自动保存会话中发送的聊天记录、文件和截图，供后续参考。\n\n');
    lines.push(`> 最后更新: ${new Date().toLocaleString('zh-CN')}\n\n`);

    if (chatFiles.length > 0) {
      lines.push('## 聊天记录\n\n');
      for (const f of chatFiles) {
        const date = f.replace('.md', '');
        lines.push(`- [${date}](chat/${f})\n`);
      }
      lines.push('\n');
    }

    if (fileDates.length > 0) {
      lines.push('## 文件与截图\n\n');
      for (const d of fileDates) {
        const dirPath = path.join(filesDir, d);
        try {
          const files = await fs.readdir(dirPath);
          if (files.length > 0) {
            lines.push(`### ${d}\n\n`);
            for (const f of files) {
              lines.push(`- ${f}\n`);
            }
            lines.push('\n');
          }
        } catch {
          // skip unreadable
        }
      }
    }

    if (chatFiles.length === 0 && fileDates.length === 0) {
      lines.push('暂无保存的素材。\n');
    }

    const content = lines.join('');
    await fs.writeFile(manifestPath, content, 'utf8');
  } catch {
    // best-effort — don't fail the main operation
  }
}
