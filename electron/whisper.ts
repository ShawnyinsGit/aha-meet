// whisper.ts — spawns the bundled whisper-cli on 16 kHz mono Float32 PCM
// captured by the renderer, returns the transcribed text.
//
// Assets land in build/whisper/ during dev (via scripts/fetch-whisper.mjs)
// and inside the packaged app at <resources>/whisper/ (via electron-builder
// extraResources). At runtime we resolve either location.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type WhisperLang = 'auto' | 'zh' | 'en';

const MODEL_NAME = 'ggml-small-q5_1.bin';

let cachedPaths: { bin: string; model: string } | null = null;
let cachedAvailability: boolean | null = null;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  // Packaged: <Vibe Meet.app>/Contents/Resources/whisper
  if (app.isPackaged) {
    dirs.push(join(process.resourcesPath, 'whisper'));
  }
  // Dev: <repo>/build/whisper (resolve from dist-electron/whisper.js → ../build/whisper)
  dirs.push(join(__dirname, '..', 'build', 'whisper'));
  dirs.push(join(__dirname, '..', '..', 'build', 'whisper'));
  return dirs;
}

function resolvePaths(): { bin: string; model: string } | null {
  if (cachedPaths) return cachedPaths;
  for (const dir of candidateDirs()) {
    const bin = join(dir, 'whisper-cli');
    const model = join(dir, MODEL_NAME);
    if (existsSync(bin) && existsSync(model)) {
      cachedPaths = { bin, model };
      return cachedPaths;
    }
  }
  return null;
}

export function isWhisperAvailable(): boolean {
  if (cachedAvailability !== null) return cachedAvailability;
  cachedAvailability = resolvePaths() !== null;
  return cachedAvailability;
}

// Build a 16 kHz mono PCM16 WAV from Float32 samples in [-1, 1].
function encodeWavPcm16(samples: Float32Array, sampleRate = 16000): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buf;
}

let inFlight: Promise<unknown> = Promise.resolve();
// Currently-running whisper-cli child (if any). Tracked so we can SIGTERM on
// app shutdown or session teardown instead of stranding the subprocess.
let currentChild: ChildProcess | null = null;
// When set, every queued / in-flight call resolves to a cancellation result
// instead of waiting in line. Cleared on the next transcribePcm() call.
let cancelled = false;

export function transcribePcm(
  pcm: Float32Array,
  lang: WhisperLang = 'auto',
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  cancelled = false;
  // Serialize: whisper-cli is single-threaded and we don't want concurrent
  // model loads competing for memory.
  const next = inFlight.then(() => {
    if (cancelled) {
      return { ok: false as const, error: 'whisper cancelled' };
    }
    return runOnce(pcm, lang);
  }).catch((e) => ({
    ok: false as const,
    error: String((e as Error)?.message ?? e),
  }));
  inFlight = next.catch(() => {});
  return next;
}

// SIGTERM the current whisper-cli child (if any) and mark the queue as
// cancelled so anything still waiting in line short-circuits instead of
// starting fresh. Safe to call any number of times.
export function disposeWhisper(): void {
  cancelled = true;
  const child = currentChild;
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

async function runOnce(
  pcm: Float32Array,
  lang: WhisperLang,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const paths = resolvePaths();
  if (!paths) {
    return { ok: false, error: 'whisper-cli not bundled — run `npm run prebuild:whisper`' };
  }
  if (!pcm || pcm.length < 1600) {
    // <100ms — likely VAD misfire; don't waste CPU.
    return { ok: true, text: '' };
  }

  const dir = mkdtempSync(join(tmpdir(), 'vibe-asr-'));
  const wavPath = join(dir, 'in.wav');
  const outBase = join(dir, 'out');
  try {
    writeFileSync(wavPath, encodeWavPcm16(pcm));
    const args = [
      '-m', paths.model,
      '-f', wavPath,
      '-of', outBase,
      '-otxt',
      '-nt',         // no timestamps in output
      '-l', lang,
      '-t', '4',     // 4 threads
      '-bs', '5',    // beam size
      '-bo', '5',    // best of
      '--no-prints', // suppress informational stderr noise
    ];
    const { code, stderr } = await spawnPromise(paths.bin, args, dir);
    if (code !== 0) {
      // Surface as much stderr as is useful for diagnosis without flooding the
      // renderer. Keep both ends: the head usually has the diagnostic message
      // (missing model, invalid args), the tail usually has the actual crash.
      return { ok: false, error: `whisper-cli exit ${code}: ${trimMiddle(stderr.trim(), 4000)}` };
    }
    const txtFile = `${outBase}.txt`;
    if (!existsSync(txtFile)) {
      return { ok: false, error: 'whisper-cli produced no output' };
    }
    const text = readFileSync(txtFile, 'utf8').trim();
    return { ok: true, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function trimMiddle(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const half = Math.floor((cap - 32) / 2);
  return `${s.slice(0, half)}\n…[${s.length - cap + 32} bytes elided]…\n${s.slice(-half)}`;
}

function spawnPromise(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    currentChild = p;
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => (stdout += d.toString()));
    p.stderr?.on('data', (d) => (stderr += d.toString()));
    p.on('error', (e) => {
      if (currentChild === p) currentChild = null;
      resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) });
    });
    p.on('exit', (code) => {
      if (currentChild === p) currentChild = null;
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
