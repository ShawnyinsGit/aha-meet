import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureMicrophoneAccess } from '../dist-electron/microphone-access.js';

function deps(status, askResult = true) {
  const calls = { ask: 0, help: 0, settings: 0 };
  return {
    calls,
    value: {
      platform: 'darwin',
      getStatus: () => status,
      askForAccess: async () => { calls.ask += 1; return askResult; },
      showDeniedHelp: async () => { calls.help += 1; return true; },
      openSettings: async () => { calls.settings += 1; },
    },
  };
}

test('first macOS launch asks for native microphone access', async () => {
  const { calls, value } = deps('not-determined', true);
  assert.equal(await ensureMicrophoneAccess(value, false), true);
  assert.deepEqual(calls, { ask: 1, help: 0, settings: 0 });
});

test('previous denial shows native recovery help and opens Microphone settings', async () => {
  const { calls, value } = deps('denied');
  assert.equal(await ensureMicrophoneAccess(value, true), false);
  assert.deepEqual(calls, { ask: 0, help: 1, settings: 1 });
});

test('non-macOS does not invoke macOS permission APIs', async () => {
  const { calls, value } = deps('not-determined');
  value.platform = 'linux';
  assert.equal(await ensureMicrophoneAccess(value, true), true);
  assert.deepEqual(calls, { ask: 0, help: 0, settings: 0 });
});
