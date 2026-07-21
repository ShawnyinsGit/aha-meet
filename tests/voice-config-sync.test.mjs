import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('voice-lock changes are broadcast and consumed by every renderer', async () => {
  const [settingsIpc, preload, hook] = await Promise.all([
    readFile(new URL('../electron/ipc/settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useVoiceLock.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(settingsIpc, /BrowserWindow\.getAllWindows\(\)/);
  assert.match(settingsIpc, /settings:voice-config-changed/);
  assert.match(preload, /onVoiceConfigChanged/);
  assert.match(hook, /onVoiceConfigChanged/);
  assert.match(hook, /setVoiceLockEnabled\(enabled\)/);
  assert.match(hook, /setVoicePrintEmbedding\(/);
});
