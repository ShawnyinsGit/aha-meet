#!/usr/bin/env node
// Stage ECC defaults from the developer's ~/.claude into build/claude-defaults
// so electron-builder's extraResources can pick them up.
//
// What we copy (matches the ECC repo):
//   agents/         — 60 sub-agents
//   skills/ecc/     — 181 skills (only the ECC namespace)
//   commands/       — 75 slash commands
//   rules/ecc/      — language rule packs
//
// Explicitly NOT copied:
//   hooks/, scripts/, ecc/install-state.json, settings*.json, *.bak — runtime
//   credentials and disabled-by-default hook plumbing the user said not to ship.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

const sources = [
  { from: 'agents', to: 'agents' },
  { from: 'commands', to: 'commands' },
  { from: 'skills/ecc', to: 'skills/ecc' },
  { from: 'rules/ecc', to: 'rules/ecc' },
];

const realDotClaude = join(homedir(), '.claude');
const stageRoot = join(repoRoot, 'build', 'claude-defaults');

// Files we never want to ship even if they sneak into one of the dirs above.
const DENY_BASENAMES = new Set([
  '.DS_Store',
  'install-state.json',
]);
function denyByName(name) {
  if (DENY_BASENAMES.has(name)) return true;
  if (name.endsWith('.bak')) return true;
  if (name.endsWith('.save')) return true;
  return false;
}

function copyTree(src, dst) {
  let files = 0;
  if (!existsSync(src)) return files;
  const st = statSync(src);
  if (st.isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return 1;
  }
  if (!st.isDirectory()) return files;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (denyByName(entry)) continue;
    files += copyTree(join(src, entry), join(dst, entry));
  }
  return files;
}

if (!existsSync(realDotClaude)) {
  console.warn(`[bundle-claude-defaults] ~/.claude not found at ${realDotClaude}; skipping`);
  process.exit(0);
}

// Wipe stale staging dir so removed agents don't ride along.
try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(stageRoot, { recursive: true });

const summary = {};
for (const { from, to } of sources) {
  const src = join(realDotClaude, from);
  const dst = join(stageRoot, to);
  if (!existsSync(src)) {
    console.warn(`[bundle-claude-defaults] missing source: ${src}`);
    summary[from] = 0;
    continue;
  }
  const n = copyTree(src, dst);
  summary[from] = n;
  console.log(`[bundle-claude-defaults] ${from} → ${n} files`);
}

console.log(`[bundle-claude-defaults] staged at ${stageRoot}`);
console.log(`[bundle-claude-defaults] summary:`, summary);
