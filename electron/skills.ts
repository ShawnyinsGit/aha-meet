// skills.ts — skill management: scan, install, uninstall SKILL.md-based skills.
//
// Skills live under ~/.claude/skills/<name>/SKILL.md. Each SKILL.md uses YAML
// frontmatter with `name` and `description` fields. This module provides:
//   • listSkills() — scan real ~/.claude/skills + shadow-home bundled skills
//   • installSkill(source) — download from URL or copy from local path
//   • uninstallSkill(name) — remove a user-installed skill directory
//
// The shadow home (built by claude-defaults.ts at launch) merges bundled ECC
// skills with user-installed ones. We always write to the real ~/.claude/skills
// so the shadow merge picks them up automatically on the next session.

import { homedir } from 'node:os';
import { promises as fs, existsSync } from 'node:fs';
import { join, basename, dirname, resolve, sep } from 'node:path';

export interface SkillInfo {
  name: string;
  description: string;
  source: 'bundled' | 'user';
  path: string;
}

const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function validateSkillName(name: string): string {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`无效的 Skill 名称: ${name}`);
  }
  return name;
}

function assertWithinBase(target: string, base: string): void {
  const resolved = resolve(base, target);
  const normalizedBase = base.endsWith(sep) ? base : base + sep;
  if (!resolved.startsWith(normalizedBase) && resolved !== base) {
    throw new Error('路径越界');
  }
}

let shadowSkillsDir: string | null = null;

export function setShadowSkillsDir(dir: string | null): void {
  shadowSkillsDir = dir;
}

function parseFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const block = match[1];
  let name = '';
  let description = '';
  for (const line of block.split('\n')) {
    const m = line.match(/^(name|description)\s*:\s*(.+)$/);
    if (m) {
      const val = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (m[1] === 'name') name = val;
      else if (m[1] === 'description') description = val;
    }
  }
  return name ? { name, description } : null;
}

async function readSkillMd(skillDir: string): Promise<{ name: string; description: string } | null> {
  const skillMd = join(skillDir, 'SKILL.md');
  try {
    const content = await fs.readFile(skillMd, 'utf8');
    return parseFrontmatter(content);
  } catch {
    return null;
  }
}

async function scanDir(dir: string, source: 'bundled' | 'user'): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const meta = await readSkillMd(skillDir);
      if (meta) {
        skills.push({
          name: meta.name,
          description: meta.description,
          source,
          path: skillDir,
        });
      }
    }
  } catch {
    // dir doesn't exist or can't be read — return empty
  }
  return skills;
}

async function scanVendorDir(dir: string, source: 'bundled' | 'user'): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  try {
    const vendors = await fs.readdir(dir, { withFileTypes: true });
    for (const vendor of vendors) {
      if (!vendor.isDirectory()) continue;
      if (vendor.name === 'ecc') continue; // ecc is handled separately
      const vendorSkills = await scanDir(join(dir, vendor.name), source);
      skills.push(...vendorSkills);
    }
  } catch {
    // ignore
  }
  return skills;
}

export async function listSkills(): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const result: SkillInfo[] = [];

  // User skills (real ~/.claude/skills) — always scan
  const userSkills = await scanDir(USER_SKILLS_DIR, 'user');
  // Also scan vendor subdirs under user skills
  const userVendorSkills = await scanVendorDir(USER_SKILLS_DIR, 'user');
  for (const s of [...userSkills, ...userVendorSkills]) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      result.push(s);
    }
  }

  // Bundled skills from shadow home (only in packaged mode)
  if (shadowSkillsDir) {
    const eccDir = join(shadowSkillsDir, '.claude', 'skills', 'ecc');
    const bundledSkills = await scanDir(eccDir, 'bundled');
    for (const s of bundledSkills) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        result.push(s);
      }
    }
    // Bundled vendor skills
    const bundledVendorDir = join(shadowSkillsDir, '.claude', 'skills');
    const bundledVendorSkills = await scanVendorDir(bundledVendorDir, 'bundled');
    for (const s of bundledVendorSkills) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        result.push(s);
      }
    }
  }

  return result.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function githubBlobToRaw(url: string): string {
  // https://github.com/user/repo/blob/branch/path/to/SKILL.md
  // → https://raw.githubusercontent.com/user/repo/branch/path/to/SKILL.md
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/);
  if (m) {
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  }
  return url;
}

/**
 * Resolve a web-page URL to a raw SKILL.md URL.
 *
 * Supported patterns:
 *   • skills.sh/{owner}/{repo}/{skill}  → raw.githubusercontent.com
 *   • github.com/{owner}/{repo}          → try main/HEAD SKILL.md
 *   • github.com/{owner}/{repo}/tree/…/{skill} → drill into subdir
 *   • already-raw URLs                   → pass through
 */
function resolveWebUrl(url: string): { rawUrl: string; fallbackBranch?: string } {
  const urlObj = new URL(url);
  const host = urlObj.hostname.replace(/^www\./, '');
  const parts = urlObj.pathname.split('/').filter(Boolean);

  // ── skills.sh/{owner}/{repo}/{skill-name} ──
  if (host === 'skills.sh' && parts.length >= 3) {
    const [owner, repo, skillName] = parts;
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${skillName}/SKILL.md`,
      fallbackBranch: 'main',
    };
  }

  // ── github.com/{owner}/{repo}/tree/{branch}/{skill-dir} ──
  if (host === 'github.com' && parts.length >= 4 && parts[2] === 'tree') {
    const [owner, repo, , branch, ...rest] = parts;
    const subdir = rest.length > 0 ? rest.join('/') + '/' : '';
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${subdir}SKILL.md`,
    };
  }

  // ── github.com/{owner}/{repo} (repo root — try HEAD) ──
  if (host === 'github.com' && parts.length >= 2 && parts.length <= 3) {
    const [owner, repo] = parts;
    const cleanRepo = repo?.replace(/\.git$/, '') ?? '';
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${cleanRepo}/HEAD/SKILL.md`,
      fallbackBranch: 'main',
    };
  }

  // ── Pass through (already a raw / direct URL) ──
  return { rawUrl: url };
}

/**
 * If the first attempt at fetching a raw SKILL.md returns a non-ok status
 * (e.g. 404 because HEAD resolved to a missing ref), retry with the explicit
 * fallback branch.
 */
async function fetchRawSkill(rawUrl: string, fallbackBranch?: string): Promise<string> {
  const MAX_SIZE = 1_000_000; // 1 MB limit to prevent OOM from malicious URLs

  let res = await fetch(rawUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok && fallbackBranch) {
    const retry = rawUrl.replace('/HEAD/', `/${fallbackBranch}/`);
    if (retry !== rawUrl) {
      res = await fetch(retry, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    }
  }
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  }

  // Pre-check Content-Length header if available
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_SIZE) {
    throw new Error(`Skill 文件过大（${Math.round(parseInt(contentLength, 10) / 1024)} KB），超过 1 MB 限制`);
  }

  const content = await res.text();

  // Post-download size check
  if (content.length > MAX_SIZE) {
    throw new Error(`Skill 文件过大（${Math.round(content.length / 1024)} KB），超过 1 MB 限制`);
  }

  return content;
}

function inferSkillNameFromUrl(url: string): string {
  // Try to extract skill name from URL path segments
  const urlObj = new URL(url);
  const parts = urlObj.pathname.split('/').filter(Boolean);
  // Look for a segment named "skills" and take the next segment as the name
  const skillsIdx = parts.indexOf('skills');
  if (skillsIdx >= 0 && skillsIdx + 1 < parts.length) {
    return parts[skillsIdx + 1];
  }
  // Fall back to the directory name containing SKILL.md
  const skillMdIdx = parts.indexOf('SKILL.md');
  if (skillMdIdx > 0) {
    return parts[skillMdIdx - 1];
  }
  // Last resort: use the last meaningful path segment
  const last = parts[parts.length - 1] || 'unnamed-skill';
  return last.replace(/\.[^.]+$/, '');
}

async function downloadSkill(url: string): Promise<{ name: string; content: string }> {
  const { rawUrl, fallbackBranch } = resolveWebUrl(url);
  const finalUrl = githubBlobToRaw(rawUrl); // handles blob URLs too
  const content = await fetchRawSkill(finalUrl, fallbackBranch);
  // Validate that we actually got a SKILL.md with frontmatter, not an HTML page
  if (content.trimStart().startsWith('<!') || content.trimStart().startsWith('<html')) {
    throw new Error(
      '该链接指向的是一个网页，而非 SKILL.md 原始文件。\n' +
      '请使用以下格式的直接链接：\n' +
      '  • skills.sh: https://www.skills.sh/{owner}/{repo}/{skill}\n' +
      '  • GitHub blob: https://github.com/{owner}/{repo}/blob/{branch}/{path}/SKILL.md\n' +
      '  • raw 链接: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}/SKILL.md'
    );
  }
  const meta = parseFrontmatter(content);
  const name = meta?.name || inferSkillNameFromUrl(url);
  return { name, content };
}

async function copyLocalSkill(localPath: string): Promise<{ name: string; dir: string }> {
  const resolvedPath = localPath.startsWith('~')
    ? join(homedir(), localPath.slice(1))
    : localPath;

  if (!existsSync(resolvedPath)) {
    throw new Error(`路径不存在: ${resolvedPath}`);
  }

  const stat = await fs.stat(resolvedPath);

  if (stat.isFile()) {
    // User pointed directly at a SKILL.md file
    if (!resolvedPath.endsWith('SKILL.md')) {
      throw new Error('文件必须是 SKILL.md');
    }
    const content = await fs.readFile(resolvedPath, 'utf8');
    const meta = parseFrontmatter(content);
    const name = meta?.name || basename(dirname(resolvedPath));
    return { name, dir: dirname(resolvedPath) };
  }

  if (stat.isDirectory()) {
    const skillMd = join(resolvedPath, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error('目录中未找到 SKILL.md');
    }
    const content = await fs.readFile(skillMd, 'utf8');
    const meta = parseFrontmatter(content);
    const name = meta?.name || basename(resolvedPath);
    return { name, dir: resolvedPath };
  }

  throw new Error('无效的路径');
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill 目录中不允许符号链接: ${entry.name}`);
    }
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// Serializes install/uninstall per skill name to prevent races.
const inflight = new Map<string, Promise<unknown>>();
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const sentinel = next.catch(() => {});
  inflight.set(name, sentinel);
  sentinel.finally(() => {
    if (inflight.get(name) === sentinel) inflight.delete(name);
  });
  return next;
}

export async function installSkill(source: string): Promise<SkillInfo> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error('请输入 Skill 链接或本地路径');

  let rawName: string;
  let content: string | null = null;
  let localDir: string | null = null;

  if (isUrl(trimmed)) {
    const dl = await downloadSkill(trimmed);
    rawName = dl.name;
    content = dl.content;
  } else {
    const local = await copyLocalSkill(trimmed);
    rawName = local.name;
    localDir = local.dir;
  }

  const name = validateSkillName(rawName);

  return withLock(name, async () => {
    const skillDir = join(USER_SKILLS_DIR, name);
    assertWithinBase(skillDir, USER_SKILLS_DIR);

    if (content !== null) {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(join(skillDir, 'SKILL.md'), content, 'utf8');
    } else if (localDir !== null && localDir !== skillDir) {
      if (existsSync(skillDir)) {
        await fs.rm(skillDir, { recursive: true, force: true });
      }
      await copyDirRecursive(localDir, skillDir);
    }

    const meta = await readSkillMd(skillDir);
    if (!meta) {
      throw new Error('安装完成但无法读取有效的 SKILL.md（frontmatter 格式可能不正确）');
    }
    return {
      name,
      description: meta.description || '',
      source: 'user',
      path: skillDir,
    };
  });
}

export async function uninstallSkill(name: string): Promise<void> {
  validateSkillName(name);
  return withLock(name, async () => {
    const skillDir = join(USER_SKILLS_DIR, name);
    assertWithinBase(skillDir, USER_SKILLS_DIR);
    if (!existsSync(skillDir)) {
      throw new Error(`未找到 Skill: ${name}`);
    }
    await fs.rm(skillDir, { recursive: true, force: true });
  });
}

// ── Testing surface (not part of the public API) ──
export const _testing = {
  resolveWebUrl,
  githubBlobToRaw,
  inferSkillNameFromUrl,
  parseFrontmatter,
};
