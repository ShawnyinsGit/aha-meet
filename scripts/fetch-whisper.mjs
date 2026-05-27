#!/usr/bin/env node
// Acquires whisper.cpp assets (whisper-cli binary + ggml-small-q5_1.bin model)
// into build/whisper/. Idempotent — skips files that already exist with a
// plausible size. Designed to tolerate flaky CN networks.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, copyFileSync, chmodSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cachePath, ensureCacheDir, materializeFromCache } from './lib/asset-cache.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'build', 'whisper');

const MODEL_NAME = 'ggml-small-q5_1.bin';
const MODEL_SIZE = 190_085_487; // verified from upstream Content-Length
const MODEL_MIN_SIZE = MODEL_SIZE - 1_000_000; // tolerate small variance

const MODEL_MIRRORS = [
  `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`,
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`,
];

const BREW_CANDIDATES = [
  '/opt/homebrew/opt/whisper-cpp/bin/whisper-cli',
  '/usr/local/opt/whisper-cpp/bin/whisper-cli',
];

function log(msg) {
  process.stdout.write(`[fetch-whisper] ${msg}\n`);
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

async function downloadWithCurl(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const p = spawn(
      'curl',
      [
        '-fL',
        '--retry', '3',
        '--retry-delay', '2',
        '--continue-at', '-',
        '--connect-timeout', '20',
        '--progress-bar',
        '-o', tmp,
        url,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    p.on('exit', (code) => {
      if (code === 0) {
        try {
          // rename .part → final
          spawnSync('mv', [tmp, dest]);
          resolve();
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`curl exited ${code} for ${url}`));
      }
    });
    p.on('error', reject);
  });
}

async function ensureModel() {
  const dest = join(outDir, MODEL_NAME);
  if (fileSize(dest) >= MODEL_MIN_SIZE) {
    log(`model ok (${(fileSize(dest) / 1e6).toFixed(1)} MB) — skip`);
    return;
  }

  // Reuse a previously-downloaded copy from the durable cache before hitting the network.
  const cached = cachePath('whisper', MODEL_NAME);
  if (fileSize(cached) >= MODEL_MIN_SIZE) {
    const how = materializeFromCache(cached, dest);
    log(`model restored from cache (${how}): ${cached}`);
    return;
  }

  ensureCacheDir('whisper');
  for (const url of MODEL_MIRRORS) {
    log(`downloading model from ${url}`);
    try {
      // Download into the cache, then materialize into the build dir. That
      // way the next `npm run dist:dmg` (even after `rm -rf build/`) skips
      // the 190 MB pull.
      await downloadWithCurl(url, cached);
      const size = fileSize(cached);
      if (size >= MODEL_MIN_SIZE) {
        const how = materializeFromCache(cached, dest);
        log(`model ok (${(size / 1e6).toFixed(1)} MB) — cached at ${cached}, ${how}ed to ${dest}`);
        return;
      }
      log(`download incomplete (${size} bytes), trying next mirror`);
    } catch (e) {
      log(`mirror failed: ${e.message}`);
      await sleep(500);
    }
  }
  throw new Error(
    `Unable to download ${MODEL_NAME} from any mirror. ` +
    `Place the file manually at ${cached} or ${dest} (~190 MB).`,
  );
}

function findInstalledWhisperCli() {
  // explicit candidates
  for (const c of BREW_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  // PATH
  const onPath = which('whisper-cli');
  if (onPath) return onPath;
  return null;
}

function copyBinaryAndDylibs(srcBin, destDir) {
  const destBin = join(destDir, 'whisper-cli');
  copyFileSync(srcBin, destBin);
  chmodSync(destBin, 0o755);
  log(`copied whisper-cli → ${destBin}`);

  // Inspect the binary's dylib references; copy any @rpath libs we own.
  const otool = spawnSync('otool', ['-L', srcBin], { encoding: 'utf8' });
  if (otool.status !== 0) {
    log('otool unavailable; binary copied as-is (system libs only assumed)');
    return;
  }
  const lines = otool.stdout.split('\n').slice(1);
  const ourLibs = lines
    .map((l) => l.trim().split(' ')[0])
    .filter((p) => p && (p.startsWith('@rpath/') || p.startsWith('/opt/homebrew/') || p.startsWith('/usr/local/')));

  // Resolve @rpath libs against the brew Cellar (sibling lib/ dir).
  const brewLib = (() => {
    if (srcBin.includes('/whisper-cpp/')) {
      const root = srcBin.replace(/\/bin\/whisper-cli$/, '');
      const lib = join(root, 'lib');
      return existsSync(lib) ? lib : null;
    }
    return null;
  })();

  for (const ref of ourLibs) {
    let abs = ref;
    if (ref.startsWith('@rpath/')) {
      if (!brewLib) continue;
      abs = join(brewLib, ref.slice('@rpath/'.length));
    }
    if (!existsSync(abs)) continue;
    const name = abs.split('/').pop();
    const out = join(destDir, name);
    if (!existsSync(out)) {
      copyFileSync(abs, out);
      chmodSync(out, 0o644);
      log(`copied dep ${name}`);
    } else {
      log(`dep ${name} already present — skip`);
    }

    // Recursively copy that dylib's deps too (one level deep is usually enough).
    const sub = spawnSync('otool', ['-L', abs], { encoding: 'utf8' });
    if (sub.status === 0) {
      for (const l of sub.stdout.split('\n').slice(1)) {
        const p = l.trim().split(' ')[0];
        if (!p) continue;
        let pAbs = p;
        if (p.startsWith('@rpath/') && brewLib) pAbs = join(brewLib, p.slice('@rpath/'.length));
        if (existsSync(pAbs) && (p.startsWith('@rpath/') || p.startsWith('/opt/homebrew/'))) {
          const pn = pAbs.split('/').pop();
          const outP = join(destDir, pn);
          if (!existsSync(outP)) {
            copyFileSync(pAbs, outP);
            chmodSync(outP, 0o644);
            log(`copied transitive dep ${pn}`);
          }
        }
      }
    }
  }

  // Copy ggml backend .so files (BLAS, Metal, per-CPU-arch). Without these,
  // whisper.cpp falls back to the slow generic backend or fails outright on a
  // clean machine that has no /opt/homebrew/Cellar.
  const ggmlLibexec = (() => {
    const r = spawnSync('sh', ['-c', 'ls -d /opt/homebrew/Cellar/ggml/*/libexec 2>/dev/null | head -1'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  })();
  if (ggmlLibexec && existsSync(ggmlLibexec)) {
    for (const so of readdirSync(ggmlLibexec)) {
      if (!so.endsWith('.so')) continue;
      const src = join(ggmlLibexec, so);
      const dst = join(destDir, so);
      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        chmodSync(dst, 0o755);
        log(`copied backend ${so}`);
      }
    }
  } else {
    log('warn: ggml libexec dir not found; backends will not be bundled');
  }

  // Rewrite all @rpath/... references inside the copied binary + dylibs to
  // @loader_path/... so they resolve against the same directory at runtime.
  const allBins = readdirSync(destDir).filter((f) => f === 'whisper-cli' || f.endsWith('.dylib') || f.endsWith('.so'));
  for (const f of allBins) {
    const fp = join(destDir, f);
    const ins = spawnSync('otool', ['-L', fp], { encoding: 'utf8' });
    if (ins.status !== 0) continue;
    for (const l of ins.stdout.split('\n').slice(1)) {
      const ref = l.trim().split(' ')[0];
      if (!ref) continue;
      if (ref.startsWith('@rpath/')) {
        const newRef = `@loader_path/${ref.slice('@rpath/'.length)}`;
        spawnSync('install_name_tool', ['-change', ref, newRef, fp]);
      } else if (ref.startsWith('/opt/homebrew/') || ref.startsWith('/usr/local/')) {
        const name = ref.split('/').pop();
        if (existsSync(join(destDir, name))) {
          spawnSync('install_name_tool', ['-change', ref, `@loader_path/${name}`, fp]);
        }
      }
    }
    // Also set the dylib's own install name to @loader_path so re-linking is stable.
    if (f.endsWith('.dylib') || f.endsWith('.so')) {
      spawnSync('install_name_tool', ['-id', `@loader_path/${f}`, fp]);
    }
  }
  log('dylib paths rewritten to @loader_path');

  // install_name_tool invalidates the existing ad-hoc signature; macOS
  // Gatekeeper kills any unsigned mach-o with SIGKILL at exec time. Re-sign
  // ad-hoc so the binary can actually run.
  for (const f of allBins) {
    const fp = join(destDir, f);
    const r = spawnSync('codesign', ['--force', '--sign', '-', fp]);
    if (r.status !== 0) log(`warn: codesign failed for ${f}`);
  }
  log('ad-hoc re-signed after relocation');
}

async function ensureBinary() {
  const destBin = join(outDir, 'whisper-cli');
  if (existsSync(destBin)) {
    log('whisper-cli already present — skip');
    return;
  }

  const src = findInstalledWhisperCli();
  if (src) {
    log(`found system whisper-cli at ${src}`);
    copyBinaryAndDylibs(src, outDir);
    return;
  }

  // Last-resort: print clear manual instructions and exit non-fatally so
  // the rest of the build can proceed in dev environments.
  log('');
  log('whisper-cli not found. Install one of:');
  log('  1) brew install whisper-cpp        (recommended; this script will copy it on next run)');
  log('  2) Build from source: https://github.com/ggml-org/whisper.cpp');
  log('');
  log(`Then re-run: node scripts/fetch-whisper.mjs`);
  log('The app will fall back to webkitSpeechRecognition until whisper-cli is available.');
  // Exit 0 — missing binary should NOT fail the wider build pipeline during
  // development. Packaging will check separately.
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  await ensureModel().catch((e) => {
    log(`model: ${e.message}`);
    // Non-fatal — same rationale as binary.
  });
  await ensureBinary();
  log('done');
}

main().catch((e) => {
  process.stderr.write(`[fetch-whisper] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
