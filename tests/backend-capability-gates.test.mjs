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

test('host listings include the native backend session reference for recovery', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: () => ({
      async start() {}, end() {}, sendUserText() {}, sendUserContent() {},
      resolvePermission() {}, async interrupt() {},
      snapshot() { return { protocol: 'codex-sdk', sessionId: 'thread-persisted' }; },
    }),
  });
  try {
    await orchestrator.start();
    assert.deepEqual(orchestrator.listHosts()[0].backendSession, {
      protocol: 'codex-sdk',
      sessionId: 'thread-persisted',
    });
  } finally {
    await orchestrator.end();
  }
});

test('a backend mention routes the user turn to the ready expert instead of the coordinator', async () => {
  const sessions = [];
  const prompts = [];
  const emitted = [];
  const orchestrator = new Orchestrator({
    emit(event) { emitted.push(event); },
    cwd: process.cwd(),
    sessionFactory: (opts) => {
      const inputs = [];
      sessions.push({ inputs, emit: opts.emit });
      prompts.push(String(opts.sessionOptions?.systemPrompt ?? ''));
      return {
        async start() {}, end() {},
        sendUserText(text) { inputs.push(text); },
        sendUserContent() {}, resolvePermission() {}, async interrupt() {},
      };
    },
  });
  try {
    await orchestrator.start();
    assert.equal(orchestrator.addHost('codex', 'codex-expert').ok, true);
    await new Promise((resolve) => setImmediate(resolve));

    orchestrator.sendUserText('排查 ASR 为什么启动失败@codex');

    assert.deepEqual(sessions[0].inputs, [], 'the coordinator must not consume a directly addressed expert turn');
    assert.equal(sessions[1].inputs.length, 1, 'the expert receives exactly the user-directed turn, not a startup greeting');
    assert.match(sessions[1].inputs[0], /排查 ASR 为什么启动失败/);
    assert.doesNotMatch(sessions[1].inputs[0], /@codex/);
    assert.match(prompts[0], /Coordinator/i);
    assert.match(prompts[1], /Expert/i);

    sessions[1].emit({
      kind: 'message',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ASR 依赖没有加载成功。' }] },
      },
    });
    assert.ok(emitted.some((event) => event.hostId === 'codex-expert' && event.event.kind === 'message'));
    assert.match(sessions[0].inputs[0], /expert response from codex-expert.*ASR 依赖没有加载成功/s);
  } finally {
    await orchestrator.end();
  }
});
