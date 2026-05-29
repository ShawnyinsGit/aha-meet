// transcript-store.ts — per-cwd JSONL persistence for talker transcripts.
//
// Each entry the renderer pushes into a slot's talker transcript is mirrored
// here as one JSON object per line, keyed by `projectId = sha1(realpath(cwd))`
// (reused from memory.ts so a single tab and a recent-list entry agree on
// where to look). On load we return at most SOFT_CAP entries; when the file
// has grown past HARD_CAP we lazily rewrite it down to SOFT_CAP so a
// long-lived project doesn't bloat the JSONL forever.
//
// Concurrency: appendFile is async and the renderer fires entries through
// without awaiting, so without a serializer two near-simultaneous appends
// would race the OS-level offset (rare on macOS APFS but real on linux
// ext4 + O_APPEND with concurrent writes). We serialize per-projectId with
// a chained-promise map — separate cwds remain fully parallel.

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeProjectId } from './memory.js';

const HARD_CAP = 1500;
const SOFT_CAP = 1000;

// One tail-promise per projectId. New writes append .then(...) and store the
// new tail. We delete the entry once it's the still-current tail at completion
// so revisiting many cwds in one session doesn't leak Map entries.
const writeLocks = new Map<string, Promise<void>>();

function transcriptsRoot(): string {
  return join(app.getPath('userData'), 'transcripts');
}

function transcriptPath(cwd: string): string {
  const projectId = computeProjectId(cwd);
  return join(transcriptsRoot(), `${projectId}.jsonl`);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

function isValidCwd(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0;
}

async function readAllLines(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (raw.length === 0) return [];
    // Split on newline, drop trailing empty line from the file's final \n.
    const lines = raw.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }
}

function parseLines<T>(lines: string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Malformed line — skip silently rather than crash the whole load.
      // (Could be a torn write from a kill mid-append; safer to drop one
      // entry than to lose the whole transcript.)
      console.warn('[transcript-store] skipping malformed line');
    }
  }
  return out;
}

async function rewriteFile(filePath: string, lines: string[]): Promise<void> {
  await ensureParentDir(filePath);
  const payload = lines.length === 0 ? '' : lines.join('\n') + '\n';
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, filePath);
}

function runSerialized<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = writeLocks.get(projectId) ?? Promise.resolve();
  // We need the returned promise to carry the result, but the tail stored in
  // the map must be a void Promise that swallows errors so a single failed
  // write can't poison subsequent ones.
  let resultResolve!: (v: T) => void;
  let resultReject!: (e: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resultResolve = res;
    resultReject = rej;
  });
  const next: Promise<void> = prev.then(async () => {
    try {
      const v = await fn();
      resultResolve(v);
    } catch (err) {
      resultReject(err);
    }
  });
  writeLocks.set(projectId, next);
  // Cleanup: if we're still the tail when we finish, drop the map entry so
  // long-lived sessions visiting many cwds don't leak.
  void next.then(() => {
    if (writeLocks.get(projectId) === next) {
      writeLocks.delete(projectId);
    }
  });
  return result;
}

/** Read the on-disk transcript for `cwd`, returning at most SOFT_CAP entries.
 *  Compacts the file down to SOFT_CAP when it exceeds HARD_CAP so it can't
 *  grow without bound. Returns `[]` on any error / missing file. */
export async function loadTranscript<T = unknown>(cwd: string): Promise<T[]> {
  if (!isValidCwd(cwd)) return [];
  const projectId = computeProjectId(cwd);
  const filePath = transcriptPath(cwd);
  return runSerialized(projectId, async () => {
    const lines = await readAllLines(filePath);
    if (lines.length === 0) return [] as T[];
    if (lines.length > HARD_CAP) {
      // Compact: keep the trailing SOFT_CAP raw lines (no need to parse +
      // re-serialize, which would lose any fields we don't know about).
      const trimmed = lines.slice(-SOFT_CAP);
      try {
        await rewriteFile(filePath, trimmed);
      } catch (err) {
        console.warn('[transcript-store] compaction failed:', err);
      }
      return parseLines<T>(trimmed);
    }
    const tail = lines.length > SOFT_CAP ? lines.slice(-SOFT_CAP) : lines;
    return parseLines<T>(tail);
  });
}

/** Append one entry to the `cwd`'s transcript file. Serialized per projectId
 *  so concurrent appends never interleave. */
export async function appendTranscript<T>(cwd: string, entry: T): Promise<void> {
  if (!isValidCwd(cwd)) return;
  const projectId = computeProjectId(cwd);
  const filePath = transcriptPath(cwd);
  return runSerialized(projectId, async () => {
    await ensureParentDir(filePath);
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(filePath, line, 'utf8');
  });
}

/** Truncate the `cwd`'s transcript to empty. */
export async function clearTranscript(cwd: string): Promise<void> {
  if (!isValidCwd(cwd)) return;
  const projectId = computeProjectId(cwd);
  const filePath = transcriptPath(cwd);
  return runSerialized(projectId, async () => {
    await ensureParentDir(filePath);
    await fs.writeFile(filePath, '', 'utf8');
  });
}
