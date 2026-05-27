// Minimal coverage of the worker-resource-release paths added to fix the
// PTY/subprocess leak. The test stubs ClaudeSession via the Orchestrator's
// `sessionFactory` opt so we never spawn the real Claude CLI subprocess.
//
// Run after `npm run build:electron`:
//   node --test tests/orchestrator-cleanup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Orchestrator } from '../dist-electron/orchestrator.js';

class FakeSession {
  constructor() {
    this.started = false;
    this.ended = false;
    this.inputs = [];
  }
  start() { this.started = true; }
  sendUserText(text) { this.inputs.push({ kind: 'text', text }); }
  sendUserContent(content) { this.inputs.push({ kind: 'content', content }); }
  resolvePermission() { /* no-op */ }
  async interrupt() { /* no-op */ }
  async setPermissionMode() { /* no-op */ }
  setAutoApprove() { /* no-op */ }
  end() { this.ended = true; }
}

function makeOrch() {
  const events = [];
  const sessions = [];
  const orch = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: '/tmp',
    sessionFactory: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
  });
  return { orch, events, sessions };
}

test('task_done releases the worker session', async () => {
  const { orch, sessions } = makeOrch();
  const result = await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [] },
  ]);
  assert.equal(result.ok, true);
  assert.equal(sessions.length, 1, 'worker session created');
  assert.equal(sessions[0].started, true);
  assert.equal(sessions[0].ended, false, 'session live during task');

  // Reach into the private markTaskDone to simulate the worker MCP tool path.
  orch.markTaskDone('a', 'finished');

  assert.equal(sessions[0].ended, true, 'session.end() called on task_done');
  orch.end();
});

test('premature session end (no task_done) cleans up + cascades', async () => {
  const { orch, sessions, events } = makeOrch();
  await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [] },
    { id: 'b', title: 'B', prompt: 'do B', deps: ['a'] },
  ]);
  assert.equal(sessions.length, 1, 'only A is spawned initially (B blocked on dep)');

  // Simulate the SDK ending the worker stream before task_done was called
  // (e.g. crash, network drop, or user cancel mid-flight).
  orch.onWorkerEvent('a', { kind: 'ended' });

  assert.equal(sessions[0].ended, true, 'A.session.end() invoked on premature end');

  // B should now be marked failed and never spawn.
  const failedEvents = events.filter(
    (e) => e.event && e.event.kind === 'worker-ended' && e.event.status === 'failed',
  );
  const failedIds = failedEvents.map((e) => e.event.workerId).sort();
  assert.deepEqual(failedIds, ['a', 'b'], 'A failed, B cascaded to failed');
  assert.equal(sessions.length, 1, 'B never spawned a session');
  orch.end();
});

test('end() tears down every live worker', async () => {
  const { orch, sessions } = makeOrch();
  await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [] },
    { id: 'b', title: 'B', prompt: 'do B', deps: [] },
  ]);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.ended === false));

  orch.end();

  assert.ok(
    sessions.every((s) => s.ended === true),
    'all live worker sessions ended on orchestrator.end()',
  );
});

test('disposeWorker is idempotent (double end() does not throw)', async () => {
  const { orch, sessions } = makeOrch();
  await orch.installPlan([{ id: 'a', title: 'A', prompt: 'do A', deps: [] }]);
  orch.markTaskDone('a', 'first');
  // Re-firing the SDK 'ended' event after task_done used to leave dangling
  // listeners behind. With the disposeWorker tombstone it should be a no-op.
  assert.doesNotThrow(() => orch.onWorkerEvent('a', { kind: 'ended' }));
  assert.equal(sessions[0].ended, true);
  orch.end();
});
