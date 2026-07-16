import assert from 'node:assert/strict';
import test from 'node:test';

import { Orchestrator } from '../dist-electron/orchestrator.js';

function fakeSessionFactory() {
  return {
    start() {}, end() {}, sendUserText() {}, sendUserContent() {},
    resolvePermission() {}, async interrupt() {},
  };
}

test('a backend without coordinator capability cannot become the default coordinator', () => {
  assert.throws(() => new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
    defaultBackendId: 'kimi',
  }), /cannot coordinate/i);
});

test('a plan cannot select a backend that cannot execute delivery tasks', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
    defaultBackendId: 'claude-code',
  });
  try {
    const result = await orchestrator.installPlan([{
      id: 'unsupported-worker',
      title: 'Unsupported worker',
      prompt: 'Do the task',
      executorBackendId: 'kimi',
    }]);
    assert.deepEqual(result, {
      ok: false,
      error: "backend 'kimi' cannot execute delivery tasks",
    });
  } finally {
    await orchestrator.end();
  }
});

test('unknown executor backends fail instead of silently falling back to Claude', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
  });
  try {
    const result = await orchestrator.installPlan([{
      id: 'unknown-worker',
      title: 'Unknown worker',
      prompt: 'Do the task',
      executorBackendId: 'missing-backend',
    }]);
    assert.deepEqual(result, {
      ok: false,
      error: "backend 'missing-backend' is not registered",
    });
  } finally {
    await orchestrator.end();
  }
});

test('single-task delegation respects the coordinator backend worker capability', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
    defaultBackendId: 'codex',
  });
  try {
    assert.throws(
      () => orchestrator.delegateSingleTask('change the code'),
      /backend 'codex' cannot execute delivery tasks/i,
    );
  } finally {
    await orchestrator.end();
  }
});

test('a connecting host cannot take over coordination before readiness', async () => {
  let sessionCount = 0;
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: () => {
      sessionCount += 1;
      return {
        async start() { if (sessionCount === 2) await secondReady; },
        end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {},
        async interrupt() {},
      };
    },
  });
  try {
    await orchestrator.start();
    const added = orchestrator.addHost('codex', 'connecting-codex');
    assert.equal(added.ok, true);
    assert.deepEqual(orchestrator.setCoordinator('connecting-codex'), {
      ok: false,
      error: "host group 'connecting-codex' is not ready",
    });
    releaseSecond();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(orchestrator.setCoordinator('connecting-codex').ok, true);
  } finally {
    await orchestrator.end();
  }
});
