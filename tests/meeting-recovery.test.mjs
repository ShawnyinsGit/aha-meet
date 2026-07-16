import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

function fakeSessionFactory() {
  return {
    async start() {}, end() {}, sendUserText() {}, sendUserContent() {},
    resolvePermission() {}, async interrupt() {},
    snapshot() { return { protocol: 'codex-app-server', sessionId: 'thread-recovered' }; },
  };
}

test('recoverable snapshots convert running tasks to interrupted without replaying them', async () => {
  const meetingId = `recovery-${randomUUID()}`;
  const repository = new MeetingRepository(meetingId);
  try {
    await repository.snapshot({
      status: 'active', cwd: '/workspace',
      hosts: [{ id: 'default', backendId: 'codex', backendSession: {
        protocol: 'codex-app-server', sessionId: 'thread-1',
      } }],
      tasks: [{ id: 'task-1', title: 'Running task', prompt: 'do it', status: 'running', deps: [] }],
    });
    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    assert.equal(recovered.seq, 0);
    assert.equal(recovered.state.status, 'recovering');
    assert.equal(recovered.state.tasks[0].status, 'interrupted');
    assert.equal(recovered.state.hosts[0].backendSession.sessionId, 'thread-1');
  } finally {
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('recovered repositories continue the durable event sequence', async () => {
  const meetingId = `recovery-${randomUUID()}`;
  try {
    const original = new MeetingRepository(meetingId);
    await original.append('meeting-created', {});
    await original.snapshot({ status: 'active', cwd: '/tmp', tasks: [] });
    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    const resumed = new MeetingRepository(meetingId, recovered.seq);
    await resumed.append('meeting-recovered', {});
    assert.deepEqual((await MeetingRepository.replay(meetingId)).map((event) => event.seq), [1, 2]);
  } finally {
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('user-confirmed recovery projects interrupted tasks but spawns no workers', async () => {
  const events = [];
  const meetingId = `recovery-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (event) => events.push(event),
    cwd: '/tmp',
    meetingId,
    sessionFactory: fakeSessionFactory,
    recoveredTasks: [{ id: 'task-1', title: 'Interrupted task', prompt: 'do it', status: 'interrupted', deps: [] }],
  });
  try {
    await orchestrator.start();
    const plan = events.find((event) => event.event.kind === 'plan-updated');
    assert.equal(plan.event.plan.nodes[0].status, 'interrupted');
    assert.equal(events.some((event) => event.event.kind === 'worker-spawned'), false);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('the user can explicitly resolve or restart an interrupted task', async () => {
  const events = [];
  const meetingId = `recovery-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (event) => events.push(event), cwd: '/tmp', meetingId,
    sessionFactory: fakeSessionFactory,
    recoveredTasks: [
      { id: 'finish-manually', title: 'Finished outside', prompt: 'done', status: 'interrupted', deps: [] },
      { id: 'retry-task', title: 'Retry task', prompt: 'do it again', status: 'interrupted', deps: [] },
    ],
  });
  try {
    await orchestrator.start();
    assert.deepEqual(await orchestrator.resolveRecoveredTask('finish-manually', 'complete'), { ok: true });
    assert.deepEqual(await orchestrator.resolveRecoveredTask('retry-task', 'retry'), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.some((event) => (
      event.event.kind === 'worker-spawned' && event.event.workerId === 'retry-task'
    )), true);
    const latestPlan = events.filter((event) => event.event.kind === 'plan-updated').at(-1);
    assert.equal(latestPlan.event.plan.nodes.some((node) => node.id === 'retry-task'), true);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});
