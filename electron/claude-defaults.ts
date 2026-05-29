// claude-defaults.ts — bundle-aware Claude home resolution.
//
// At packaged-app launch, build a "shadow" `.claude` directory under
// `app.getPath('userData')` that merges:
//   • app-bundled defaults from `process.resourcesPath/claude-defaults`
//     (the ECC pack: 60 agents + 181 skills/ecc + 75 commands + rules/ecc),
//   • the user's own `~/.claude` overrides — user always wins on same name.
//
// We then redirect `HOME` for the worker subprocess at this shadow dir,
// so the SDK's `settingSources: ['user', ...]` reads the merged tree as if
// it were the user's real `~/.claude`.
//
// In dev mode (or if the bundled dir is missing), this is a no-op and the
// SDK reads the real `~/.claude` directly.
//
// Performance: runs OFF the launch critical path. main.ts kicks the build
// and stashes the resulting promise; sessions:open awaits that promise the
// first time it actually needs HOME (typically 1–3 s after launch when the
// user clicks "Open"). A manifest at userData/claude-shadow/.shadow-manifest.json
// records mtime fingerprints of bundled + user merge dirs so a second launch
// with no source change reuses the existing tree (single fs.access + small
// JSON read instead of rm-rf + hundreds of symlinks).

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Subdirectories under .claude where we merge bundled + user. Each path is
// relative to .claude. Carving out `skills/ecc` and `rules/ecc` (rather than
// the whole `skills/` / `rules/` tree) preserves any other skill/rule
// vendors the user may have installed.
const MERGE_DIRS = ['agents', 'commands', 'skills/ecc', 'rules/ecc'] as const;

const MANIFEST_VERSION = 1;

export interface ClaudeHomeResult {
  /** Absolute HOME path to set in the worker subprocess so it sees the merged
   *  shadow tree. `null` means "use the real HOME / ~/.claude" (dev mode). */
  home: string | null;
  /** Counters for logging. */
  stats: { bundled: number; userOverrides: number; passthrough: number; cached?: boolean };
}

interface ManifestSnapshot {
  version: number;
  bundledRoot: string;
  realDotClaude: string;
  /** mtimeMs + entry-count fingerprints so we can tell if any merge source
   *  changed since the last build. Cross-FS atime/mtime variance is the
   *  reason we also include the entry count — a rename-only change still
   *  flips the count even if mtime is preserved. */
  fingerprints: Record<string, { mtimeMs: number; count: number }>;
}

async function safeSymlink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fingerprintDir(p: string): Promise<{ mtimeMs: number; count: number } | null> {
  try {
    const st = await fs.stat(p);
    if (!st.isDirectory()) return null;
    const entries = await fs.readdir(p);
    return { mtimeMs: st.mtimeMs, count: entries.length };
  } catch {
    return null;
  }
}

async function buildFingerprints(
  bundledRoot: string,
  realDotClaude: string,
): Promise<Record<string, { mtimeMs: number; count: number }>> {
  const fp: Record<string, { mtimeMs: number; count: number }> = {};
  const realRoot = await fingerprintDir(realDotClaude);
  if (realRoot) fp['__user_root__'] = realRoot;
  const bundledFp = await fingerprintDir(bundledRoot);
  if (bundledFp) fp['__bundled_root__'] = bundledFp;
  for (const rel of MERGE_DIRS) {
    const userFp = await fingerprintDir(join(realDotClaude, rel));
    if (userFp) fp[`user:${rel}`] = userFp;
    const bundledRel = await fingerprintDir(join(bundledRoot, rel));
    if (bundledRel) fp[`bundled:${rel}`] = bundledRel;
  }
  return fp;
}

function fingerprintsMatch(
  a: Record<string, { mtimeMs: number; count: number }>,
  b: Record<string, { mtimeMs: number; count: number }>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const av = a[k];
    const bv = b[k];
    if (!bv) return false;
    if (av.mtimeMs !== bv.mtimeMs) return false;
    if (av.count !== bv.count) return false;
  }
  return true;
}

async function readManifest(manifestPath: string): Promise<ManifestSnapshot | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as ManifestSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== MANIFEST_VERSION) return null;
    if (typeof parsed.bundledRoot !== 'string') return null;
    if (typeof parsed.realDotClaude !== 'string') return null;
    if (!parsed.fingerprints || typeof parsed.fingerprints !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifest(manifestPath: string, snapshot: ManifestSnapshot): Promise<void> {
  try {
    await fs.writeFile(manifestPath, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    console.error('[claude-defaults] failed to write manifest:', err);
  }
}

export async function buildClaudeShadowHome(): Promise<ClaudeHomeResult> {
  if (!app.isPackaged) {
    return { home: null, stats: { bundled: 0, userOverrides: 0, passthrough: 0 } };
  }

  const bundledRoot = join(process.resourcesPath, 'claude-defaults');
  if (!(await pathExists(bundledRoot))) {
    return { home: null, stats: { bundled: 0, userOverrides: 0, passthrough: 0 } };
  }

  const realDotClaude = join(homedir(), '.claude');
  const shadowHome = join(app.getPath('userData'), 'claude-shadow');
  const shadowDotClaude = join(shadowHome, '.claude');
  const manifestPath = join(shadowHome, '.shadow-manifest.json');

  // Manifest fast path: if every fingerprint matches AND the shadow tree is
  // still on disk, reuse it. Saves ~50–200 ms on second-and-later launches.
  const fingerprints = await buildFingerprints(bundledRoot, realDotClaude);
  const prior = await readManifest(manifestPath);
  if (
    prior
    && prior.bundledRoot === bundledRoot
    && prior.realDotClaude === realDotClaude
    && fingerprintsMatch(prior.fingerprints, fingerprints)
    && (await pathExists(shadowDotClaude))
  ) {
    return { home: shadowHome, stats: { bundled: 0, userOverrides: 0, passthrough: 0, cached: true } };
  }

  // Wipe and recreate to avoid stale links from previous launches (user may
  // have added a new agent in ~/.claude since the last run).
  try { await fs.rm(shadowDotClaude, { recursive: true, force: true }); } catch { /* ignore */ }
  await fs.mkdir(shadowDotClaude, { recursive: true });

  let bundled = 0;
  let userOverrides = 0;
  let passthrough = 0;

  // The top-level dirs we will manage ourselves; everything else passes through.
  const managedTopLevel = new Set<string>();
  for (const dir of MERGE_DIRS) managedTopLevel.add(dir.split('/')[0]);

  // 1. Pass-through every other top-level entry from the user's real ~/.claude.
  //    settings.json, projects/, mcp-configs/, history.jsonl, plugins/, etc.
  let realEntries: string[] = [];
  try {
    if (await pathExists(realDotClaude)) realEntries = await fs.readdir(realDotClaude);
  } catch { /* ignore */ }
  for (const entry of realEntries) {
    if (managedTopLevel.has(entry)) continue;
    if (await safeSymlink(join(realDotClaude, entry), join(shadowDotClaude, entry))) passthrough++;
  }

  // 2. For each merge subtree: bundled first, user's entries layered on top.
  for (const rel of MERGE_DIRS) {
    const bundledSrc = join(bundledRoot, rel);
    const userSrc = join(realDotClaude, rel);
    const dst = join(shadowDotClaude, rel);
    await fs.mkdir(dst, { recursive: true });

    if (await pathExists(bundledSrc)) {
      try {
        const entries = await fs.readdir(bundledSrc);
        for (const entry of entries) {
          if (await safeSymlink(join(bundledSrc, entry), join(dst, entry))) bundled++;
        }
      } catch { /* ignore */ }
    }

    if (await pathExists(userSrc)) {
      try {
        const entries = await fs.readdir(userSrc);
        for (const entry of entries) {
          const target = join(dst, entry);
          // Replace bundled entry if user has the same name — user wins.
          try { await fs.rm(target, { force: true, recursive: true }); } catch { /* ignore */ }
          if (await safeSymlink(join(userSrc, entry), target)) userOverrides++;
        }
      } catch { /* ignore */ }
    }
  }

  // 3. Pass-through any other vendor subdirs under skills/ and rules/ that the
  //    user has (e.g. skills/their-vendor/), so we don't shadow them by
  //    accident when we mkdir'd skills/ in step 2.
  for (const top of ['skills', 'rules'] as const) {
    const userDir = join(realDotClaude, top);
    if (!(await pathExists(userDir))) continue;
    try {
      const entries = await fs.readdir(userDir);
      for (const entry of entries) {
        if (entry === 'ecc') continue; // already merged in step 2
        if (await safeSymlink(join(userDir, entry), join(shadowDotClaude, top, entry))) passthrough++;
      }
    } catch { /* ignore */ }
  }

  await writeManifest(manifestPath, {
    version: MANIFEST_VERSION,
    bundledRoot,
    realDotClaude,
    fingerprints,
  });

  return { home: shadowHome, stats: { bundled, userOverrides, passthrough } };
}
