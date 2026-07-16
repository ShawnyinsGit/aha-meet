import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { resolveBinaryFromPath } from '../dist-electron/backends/subprocess-backend.js';

test('packaged runtime resolver finds the canonical Kimi Code install directory', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ahameet-kimi-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binary = join(home, '.kimi-code', 'bin', 'kimi');
  await mkdir(join(home, '.kimi-code', 'bin'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  assert.equal(resolveBinaryFromPath('kimi'), binary);
});

test('Codex auth status is based on the CLI probe, not config.toml existence', async () => {
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    execFile: () => 'Not logged in\n',
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: false });
});

test('Codex auth status accepts a successful CLI status probe', async () => {
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    execFile: () => 'Logged in using ChatGPT\n',
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: true });
});
