import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';

test('Claude adapter carries the universal session configuration into the official SDK', async () => {
  let queryInput;
  let finish;
  const fakeQuery = {
    initializationResult: async () => ({ session_id: 'claude-session-1' }),
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise((resolve) => { finish = resolve; }); },
    async interrupt() { finish?.({ value: undefined, done: true }); },
    async setPermissionMode() {},
  };
  const backend = new ClaudeCodeBackend({
    queryFactory: (input) => { queryInput = input; return fakeQuery; },
  });
  const session = backend.createSession({
    cwd: '/workspace',
    systemPrompt: 'meeting host',
    model: 'claude-test-model',
    mcpServers: { meeting: { type: 'sdk' } },
    skills: ['review'],
    extra: { settingSources: [], tools: [] },
  }, () => {});

  await session.start();
  assert.equal(queryInput.options.systemPrompt, 'meeting host');
  assert.equal(queryInput.options.model, 'claude-test-model');
  assert.deepEqual(queryInput.options.mcpServers, { meeting: { type: 'sdk' } });
  assert.deepEqual(queryInput.options.skills, ['review']);
  assert.deepEqual(queryInput.options.settingSources, []);
  assert.deepEqual(queryInput.options.tools, []);
  session.end();
});
