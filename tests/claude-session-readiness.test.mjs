import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSession } from '../dist-electron/claude-session.js';

test('Claude readiness rejects and emits one auth-required event when initialization is unauthenticated', async () => {
  let finish;
  const query = {
    initializationResult: async () => {
      throw new Error('authentication_failed: please login');
    },
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise((resolve) => { finish = resolve; }); },
    async interrupt() { finish?.({ value: undefined, done: true }); },
    async setPermissionMode() {},
  };
  const events = [];
  const session = new ClaudeSession({
    cwd: process.cwd(),
    emit: (event) => events.push(event),
    queryFactory: () => query,
  });

  await assert.rejects(session.start(), /authentication/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.kind === 'auth-required').length, 1);
  assert.equal(events.some((event) => event.kind === 'error'), false);
});

test('Claude readiness rejects a successful initialize response with no account credential source', async () => {
  let finish;
  const query = {
    initializationResult: async () => ({
      account: { apiProvider: 'firstParty', tokenSource: 'none' },
    }),
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise((resolve) => { finish = resolve; }); },
    async interrupt() { finish?.({ value: undefined, done: true }); },
    async setPermissionMode() {},
  };
  const events = [];
  const session = new ClaudeSession({
    cwd: process.cwd(), emit: (event) => events.push(event), queryFactory: () => query,
  });

  await assert.rejects(session.start(), /authentication required/i);
  assert.equal(events.filter((event) => event.kind === 'auth-required').length, 1);
});
