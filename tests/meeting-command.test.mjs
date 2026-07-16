import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeMeetingCommand } from '../dist-electron/meeting-command.js';

test('experts cannot install executable plans', () => {
  const result = authorizeMeetingCommand({
    kind: 'propose-plan',
    tasks: [{ id: 'a', title: 'A', prompt: 'Do A', deps: [] }],
  }, { hostId: 'expert', role: 'expert' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'forbidden');
});

test('coordinator can propose a bounded validated plan', () => {
  const result = authorizeMeetingCommand({
    kind: 'propose-plan',
    tasks: [{ id: 'a', title: 'A', prompt: 'Do A', deps: [], executorBackendId: 'codex' }],
  }, { hostId: 'default', role: 'coordinator' });
  assert.equal(result.ok, true);
  assert.equal(result.command.tasks[0].executorBackendId, 'codex');
});

test('rejects malformed actor and oversized command input', () => {
  const result = authorizeMeetingCommand({ kind: 'ask-host', hostId: '../bad', question: 'hello' }, {
    hostId: 'default', role: 'coordinator',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-command');
});

test('rejects empty speak commands', () => {
  const result = authorizeMeetingCommand({ kind: 'speak', text: '' }, {
    hostId: 'default', role: 'coordinator',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-command');
});
