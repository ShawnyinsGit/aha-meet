// skills-url-resolution.test.mjs — unit tests for URL resolution helpers in
// electron/skills.ts. These cover the fix that lets installSkill() accept
// web-page URLs (skills.sh, GitHub repo pages) instead of only raw SKILL.md links.
//
// Run after `npm run build:electron`:
//   node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" --test tests/skills-url-resolution.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _testing } from '../dist-electron/skills.js';

const { resolveWebUrl, githubBlobToRaw, inferSkillNameFromUrl, parseFrontmatter } = _testing;

// ─── resolveWebUrl ───────────────────────────────────────────────────────────

test('resolveWebUrl: skills.sh URL → raw GitHub URL with HEAD + fallback', () => {
  const result = resolveWebUrl('https://www.skills.sh/mattpocock/skills/grill-me');
  assert.equal(
    result.rawUrl,
    'https://raw.githubusercontent.com/mattpocock/skills/HEAD/grill-me/SKILL.md',
  );
  assert.equal(result.fallbackBranch, 'main');
});

test('resolveWebUrl: skills.sh URL without www', () => {
  const result = resolveWebUrl('https://skills.sh/mattpocock/skills/grill-me');
  assert.equal(
    result.rawUrl,
    'https://raw.githubusercontent.com/mattpocock/skills/HEAD/grill-me/SKILL.md',
  );
  assert.equal(result.fallbackBranch, 'main');
});

test('resolveWebUrl: github.com repo root → HEAD SKILL.md', () => {
  const result = resolveWebUrl('https://github.com/mattpocock/skills');
  assert.equal(
    result.rawUrl,
    'https://raw.githubusercontent.com/mattpocock/skills/HEAD/SKILL.md',
  );
  assert.equal(result.fallbackBranch, 'main');
});

test('resolveWebUrl: github.com repo root strips .git suffix', () => {
  const result = resolveWebUrl('https://github.com/mattpocock/skills.git');
  assert.equal(
    result.rawUrl,
    'https://raw.githubusercontent.com/mattpocock/skills/HEAD/SKILL.md',
  );
});

test('resolveWebUrl: github.com tree URL → raw SKILL.md in subdir', () => {
  const result = resolveWebUrl('https://github.com/mattpocock/skills/tree/main/grill-me');
  assert.equal(
    result.rawUrl,
    'https://raw.githubusercontent.com/mattpocock/skills/main/grill-me/SKILL.md',
  );
  assert.equal(result.fallbackBranch, undefined);
});

test('resolveWebUrl: github.com tree URL with nested path', () => {
  const result = resolveWebUrl('https://github.com/owner/repo/tree/dev/packages/my-skill');
  assert.equal(
    result.rawUrl,
    'https://raw.githubusercontent.com/owner/repo/dev/packages/my-skill/SKILL.md',
  );
});

test('resolveWebUrl: raw.githubusercontent.com URL passes through', () => {
  const url = 'https://raw.githubusercontent.com/mattpocock/skills/main/grill-me/SKILL.md';
  const result = resolveWebUrl(url);
  assert.equal(result.rawUrl, url);
  assert.equal(result.fallbackBranch, undefined);
});

test('resolveWebUrl: arbitrary URL passes through unchanged', () => {
  const url = 'https://example.com/some/SKILL.md';
  const result = resolveWebUrl(url);
  assert.equal(result.rawUrl, url);
  assert.equal(result.fallbackBranch, undefined);
});

// ─── githubBlobToRaw ─────────────────────────────────────────────────────────

test('githubBlobToRaw: converts blob URL to raw URL', () => {
  assert.equal(
    githubBlobToRaw('https://github.com/user/repo/blob/main/path/to/SKILL.md'),
    'https://raw.githubusercontent.com/user/repo/main/path/to/SKILL.md',
  );
});

test('githubBlobToRaw: returns non-blob URL unchanged', () => {
  const url = 'https://raw.githubusercontent.com/user/repo/main/SKILL.md';
  assert.equal(githubBlobToRaw(url), url);
});

// ─── inferSkillNameFromUrl ───────────────────────────────────────────────────

test('inferSkillNameFromUrl: extracts name after "skills" segment', () => {
  assert.equal(
    inferSkillNameFromUrl('https://example.com/skills/grill-me'),
    'grill-me',
  );
});

test('inferSkillNameFromUrl: extracts name from SKILL.md parent dir', () => {
  assert.equal(
    inferSkillNameFromUrl('https://raw.githubusercontent.com/user/repo/main/grill-me/SKILL.md'),
    'grill-me',
  );
});

test('inferSkillNameFromUrl: falls back to last path segment', () => {
  assert.equal(
    inferSkillNameFromUrl('https://example.com/some-skill'),
    'some-skill',
  );
});

test('inferSkillNameFromUrl: strips file extension from last segment', () => {
  assert.equal(
    inferSkillNameFromUrl('https://example.com/my-skill.md'),
    'my-skill',
  );
});

// ─── parseFrontmatter ────────────────────────────────────────────────────────

test('parseFrontmatter: extracts name and description', () => {
  const content = [
    '---',
    'name: grill-me',
    'description: Relentless interviewing skill',
    '---',
    '',
    '# Grill Me',
  ].join('\n');
  const result = parseFrontmatter(content);
  assert.deepEqual(result, { name: 'grill-me', description: 'Relentless interviewing skill' });
});

test('parseFrontmatter: strips quotes from values', () => {
  const content = [
    '---',
    "name: 'my-skill'",
    'description: "A cool skill"',
    '---',
  ].join('\n');
  const result = parseFrontmatter(content);
  assert.deepEqual(result, { name: 'my-skill', description: 'A cool skill' });
});

test('parseFrontmatter: returns null when no frontmatter', () => {
  assert.equal(parseFrontmatter('# Just a heading'), null);
});

test('parseFrontmatter: returns null when name is missing', () => {
  const content = [
    '---',
    'description: no name here',
    '---',
  ].join('\n');
  assert.equal(parseFrontmatter(content), null);
});
