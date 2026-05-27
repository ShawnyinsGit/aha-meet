#!/usr/bin/env node
// Acquires the 3D-Speaker CAM++ speaker-embedding ONNX model into
// public/voice-id/. The renderer fetches it via the dev server (and from
// dist/voice-id/ in the packaged app via Vite's public-asset pipeline).
//
// Idempotent — skips when the file already exists with a plausible size.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cachePath, ensureCacheDir, materializeFromCache } from './lib/asset-cache.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'public', 'voice-id');

const MODEL_NAME = '3dspeaker_campplus_sv_zh_en_16k.onnx';
// CAM++ from 3D-Speaker (200k trained on CN + EN common), pre-converted to ONNX.
// The previous sherpa-onnx mirror became 401/404; this welcomyou repo is the
// currently-reachable copy. ~28 MB. We rename to MODEL_NAME locally so the
// renderer URL (referenced from speaker-embedding.ts) stays stable.
const MIRRORS = [
  `https://hf-mirror.com/welcomyou/campplus-3dspeaker-200k-onnx/resolve/main/campplus_cn_en_common_200k.onnx`,
  `https://huggingface.co/welcomyou/campplus-3dspeaker-200k-onnx/resolve/main/campplus_cn_en_common_200k.onnx`,
];
const MIN_SIZE = 20_000_000; // ~28 MB upstream; reject obvious failures
const MAX_SIZE = 80_000_000;

function log(msg) {
  process.stdout.write(`[fetch-speaker] ${msg}\n`);
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return -1; }
}

function downloadWithCurl(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const p = spawn(
      'curl',
      [
        '-fL',
        '--retry', '3',
        '--retry-delay', '2',
        '--connect-timeout', '20',
        '--progress-bar',
        '-o', tmp,
        url,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) {
        try { renameSync(tmp, dest); resolve(); }
        catch (e) { reject(e); }
      } else {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        reject(new Error(`curl exit ${code}`));
      }
    });
  });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, MODEL_NAME);
  const existing = fileSize(dest);
  if (existing >= MIN_SIZE && existing <= MAX_SIZE) {
    log(`already present (${existing} bytes), skipping`);
    return;
  }
  if (existing > 0) {
    log(`existing file size ${existing} out of expected range — re-downloading`);
    try { unlinkSync(dest); } catch { /* ignore */ }
  }

  // Reuse a previously-downloaded copy from the durable cache before hitting the network.
  const cached = cachePath('voice-id', MODEL_NAME);
  const cachedSize = fileSize(cached);
  if (cachedSize >= MIN_SIZE && cachedSize <= MAX_SIZE) {
    const how = materializeFromCache(cached, dest);
    log(`restored from cache (${how}): ${cached}`);
    return;
  }
  if (cachedSize > 0) {
    try { unlinkSync(cached); } catch { /* ignore */ }
  }

  ensureCacheDir('voice-id');
  let lastErr = null;
  for (const url of MIRRORS) {
    log(`downloading from ${url}`);
    try {
      // Download into the cache, then materialize into public/voice-id/.
      // Survives `rm -rf public/voice-id/` and fresh git checkouts.
      await downloadWithCurl(url, cached);
      const size = fileSize(cached);
      if (size < MIN_SIZE) {
        throw new Error(`downloaded size ${size} below expected ${MIN_SIZE}`);
      }
      const how = materializeFromCache(cached, dest);
      log(`done (${size} bytes) — cached at ${cached}, ${how}ed to ${dest}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`mirror failed: ${e.message ?? e}`);
    }
  }
  throw lastErr ?? new Error('all mirrors failed');
}

main().catch((e) => {
  process.stderr.write(`[fetch-speaker] FAILED: ${e.message ?? e}\n`);
  process.exit(1);
});
