// Workspace fallback for oversized / non-inline attachments. Files land at
// `<cwd>/.vibe-attachments/` with collision-safe rename, and `.gitignore` is
// touched up if the cwd is a git repo. Talker is told the absolute path so it
// can hand the file off to Worker via the Read tool.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

const DIR_NAME = '.vibe-attachments';

const gitignoreTouched = new Set<string>();

export interface WorkspaceWriteResult {
  absPath: string;
  finalName: string;
}

export async function ensureAttachmentsDir(cwd: string): Promise<string | null> {
  try {
    const dir = path.join(cwd, DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export async function writeAttachmentSafely(
  dir: string,
  originalName: string,
  buffer: Buffer,
): Promise<WorkspaceWriteResult> {
  const safeBase = sanitizeFilename(originalName);
  const ext = extensionOf(safeBase);
  const stem = ext ? safeBase.slice(0, safeBase.length - ext.length - 1) : safeBase;

  let candidate = safeBase;
  let n = 2;
  while (existsSync(path.join(dir, candidate))) {
    candidate = ext ? `${stem}-${n}.${ext}` : `${stem}-${n}`;
    n++;
    if (n > 9999) throw new Error('too many collisions writing attachment');
  }
  const absPath = path.join(dir, candidate);
  await fs.writeFile(absPath, buffer);
  return { absPath, finalName: candidate };
}

export async function maybeAppendGitignore(cwd: string): Promise<void> {
  if (gitignoreTouched.has(cwd)) return;
  gitignoreTouched.add(cwd);
  if (!existsSync(path.join(cwd, '.git'))) return;

  const gitignorePath = path.join(cwd, '.gitignore');
  const entry = `${DIR_NAME}/`;
  try {
    let current = '';
    try {
      current = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      current = '';
    }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(DIR_NAME)) return;
    const sep = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await fs.appendFile(gitignorePath, `${sep}${entry}\n`);
  } catch {
    // best-effort — never break a send because of gitignore housekeeping.
  }
}

function sanitizeFilename(name: string): string {
  // strip path separators + control chars; keep dots so the extension survives.
  const stripped = name.replace(/[\/\\\x00-\x1f]/g, '_').trim();
  if (!stripped || stripped === '.' || stripped === '..') return `attachment-${Date.now()}`;
  // Bound length so absurd names don't break the filesystem.
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
