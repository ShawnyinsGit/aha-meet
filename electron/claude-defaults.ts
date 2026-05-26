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

import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Subdirectories under .claude where we merge bundled + user. Each path is
// relative to .claude. Carving out `skills/ecc` and `rules/ecc` (rather than
// the whole `skills/` / `rules/` tree) preserves any other skill/rule
// vendors the user may have installed.
const MERGE_DIRS = ['agents', 'commands', 'skills/ecc', 'rules/ecc'] as const;

export interface ClaudeHomeResult {
  /** Absolute HOME path to set in the worker subprocess so it sees the merged
   *  shadow tree. `null` means "use the real HOME / ~/.claude" (dev mode). */
  home: string | null;
  /** Counters for logging. */
  stats: { bundled: number; userOverrides: number; passthrough: number };
}

function safeSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

export function buildClaudeShadowHome(): ClaudeHomeResult {
  if (!app.isPackaged) {
    return { home: null, stats: { bundled: 0, userOverrides: 0, passthrough: 0 } };
  }

  const bundledRoot = join(process.resourcesPath, 'claude-defaults');
  if (!existsSync(bundledRoot)) {
    return { home: null, stats: { bundled: 0, userOverrides: 0, passthrough: 0 } };
  }

  const realDotClaude = join(homedir(), '.claude');
  const shadowHome = join(app.getPath('userData'), 'claude-shadow');
  const shadowDotClaude = join(shadowHome, '.claude');

  // Wipe and recreate to avoid stale links from previous launches (user may
  // have added a new agent in ~/.claude since the last run).
  try { rmSync(shadowDotClaude, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(shadowDotClaude, { recursive: true });

  let bundled = 0;
  let userOverrides = 0;
  let passthrough = 0;

  // The top-level dirs we will manage ourselves; everything else passes through.
  const managedTopLevel = new Set<string>();
  for (const dir of MERGE_DIRS) managedTopLevel.add(dir.split('/')[0]);

  // 1. Pass-through every other top-level entry from the user's real ~/.claude.
  //    settings.json, projects/, mcp-configs/, history.jsonl, plugins/, etc.
  const realEntries = existsSync(realDotClaude) ? readdirSync(realDotClaude) : [];
  for (const entry of realEntries) {
    if (managedTopLevel.has(entry)) continue;
    if (safeSymlink(join(realDotClaude, entry), join(shadowDotClaude, entry))) passthrough++;
  }

  // 2. For each merge subtree: bundled first, user's entries layered on top.
  for (const rel of MERGE_DIRS) {
    const bundledSrc = join(bundledRoot, rel);
    const userSrc = join(realDotClaude, rel);
    const dst = join(shadowDotClaude, rel);
    mkdirSync(dst, { recursive: true });

    if (existsSync(bundledSrc)) {
      for (const entry of readdirSync(bundledSrc)) {
        if (safeSymlink(join(bundledSrc, entry), join(dst, entry))) bundled++;
      }
    }

    if (existsSync(userSrc)) {
      for (const entry of readdirSync(userSrc)) {
        const target = join(dst, entry);
        // Replace bundled entry if user has the same name — user wins.
        try { rmSync(target, { force: true, recursive: true }); } catch { /* ignore */ }
        if (safeSymlink(join(userSrc, entry), target)) userOverrides++;
      }
    }
  }

  // 3. Pass-through any other vendor subdirs under skills/ and rules/ that the
  //    user has (e.g. skills/their-vendor/), so we don't shadow them by
  //    accident when we mkdir'd skills/ in step 2.
  for (const top of ['skills', 'rules'] as const) {
    const userDir = join(realDotClaude, top);
    if (!existsSync(userDir)) continue;
    for (const entry of readdirSync(userDir)) {
      if (entry === 'ecc') continue; // already merged in step 2
      if (safeSymlink(join(userDir, entry), join(shadowDotClaude, top, entry))) passthrough++;
    }
  }

  return { home: shadowHome, stats: { bundled, userOverrides, passthrough } };
}
