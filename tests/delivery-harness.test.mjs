import assert from 'node:assert/strict';
import test from 'node:test';

import { DeliveryHarness } from '../dist-electron/delivery-harness.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(harness, id, status) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const view = await harness.inspect(id);
    if (view.status === status) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`delivery ${id} did not reach ${status}`);
}

test('approved delivery requires independent verification and review before user acceptance', async () => {
  const execution = deferred();
  const calls = { verify: 0, review: 0, integrate: 0 };
  const harness = new DeliveryHarness({
    runtime: {
      execute: async () => execution.promise,
    },
    verifier: {
      verify: async (_order, report) => {
        calls.verify += 1;
        return { passed: true, checks: report.tests };
      },
    },
    reviewer: {
      review: async () => {
        calls.review += 1;
        return { passed: true, findings: [] };
      },
    },
    integrator: {
      integrate: async () => {
        calls.integrate += 1;
        return { commit: 'result-commit' };
      },
    },
  });

  const proposed = await harness.propose({
    meetingId: 'meeting-1',
    objective: 'Implement a verified change',
    workspace: '/repo',
    sourceRevision: 'base-commit',
    acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
  });
  assert.equal(proposed.status, 'awaiting-spec-approval');

  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  await waitFor(harness, proposed.id, 'executing');
  execution.resolve({
    outcome: 'completed',
    summary: 'implemented',
    changes: [{ path: 'src/a.ts', purpose: 'feature' }],
    tests: [{ name: 'unit', status: 'passed', evidenceRef: 'log-1' }],
    artifacts: [], risks: [], unresolved: [],
  });

  const reviewReady = await waitFor(harness, proposed.id, 'awaiting-delivery-acceptance');
  assert.equal(calls.verify, 1);
  assert.equal(calls.review, 1);
  assert.equal(calls.integrate, 0);
  assert.equal(reviewReady.candidate.verification.passed, true);
  assert.equal(reviewReady.candidate.review.passed, true);

  const accepted = await harness.decide(proposed.id, {
    kind: 'accept-delivery', candidateId: reviewReady.candidate.id,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration.commit, 'result-commit');
  assert.equal(calls.integrate, 1);
});

test('agent completion cannot produce a delivery candidate when verification fails', async () => {
  let reviewed = false;
  const harness = new DeliveryHarness({
    runtime: {
      execute: async () => ({
        outcome: 'completed', summary: 'claimed complete', changes: [],
        tests: [{ name: 'unit', status: 'failed', evidenceRef: 'log-failed' }],
        artifacts: [], risks: [], unresolved: [],
      }),
    },
    verifier: {
      verify: async () => ({ passed: false, checks: [], error: 'unit test failed' }),
    },
    reviewer: {
      review: async () => { reviewed = true; return { passed: true, findings: [] }; },
    },
    integrator: { integrate: async () => ({}) },
  });
  const proposed = await harness.propose({
    meetingId: 'meeting-2', objective: 'must verify', workspace: '/repo',
    sourceRevision: 'base', acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
  });
  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  const failed = await waitFor(harness, proposed.id, 'failed');
  assert.equal(failed.error, 'unit test failed');
  assert.equal(failed.candidate, undefined);
  assert.equal(reviewed, false);
  await assert.rejects(
    harness.decide(proposed.id, { kind: 'accept-delivery', candidateId: 'missing' }),
    /not ready for acceptance/,
  );
});

test('delivery observers continue from a cursor and receive later state changes in order', async () => {
  const execution = deferred();
  const harness = new DeliveryHarness({
    runtime: { execute: async () => execution.promise },
    verifier: { verify: async () => ({ passed: true, checks: [] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({}) },
  });
  const proposed = await harness.propose({
    meetingId: 'meeting-3', objective: 'observable delivery', workspace: '/repo',
    sourceRevision: 'base', acceptanceCriteria: [{ id: 'done', description: 'done' }],
  });
  const stream = harness.observe(proposed.id, 1)[Symbol.asyncIterator]();
  const nextEvent = stream.next();
  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  const event = await Promise.race([
    nextEvent,
    new Promise((_, reject) => setTimeout(() => reject(new Error('observer timed out')), 200)),
  ]);
  assert.equal(event.done, false);
  assert.equal(event.value.seq, 2);
  assert.equal(event.value.status, 'preparing-workspace');
  execution.resolve({
    outcome: 'completed', summary: 'done', changes: [], tests: [], artifacts: [], risks: [], unresolved: [],
  });
  await waitFor(harness, proposed.id, 'awaiting-delivery-acceptance');
});

test('integration failures are terminal and accepted deliveries cannot be cancelled', async () => {
  const makeHarness = (integrate) => new DeliveryHarness({
    runtime: { execute: async () => ({
      outcome: 'completed', summary: 'done', changes: [], tests: [], artifacts: [], risks: [], unresolved: [],
    }) },
    verifier: { verify: async () => ({ passed: true, checks: ['ok'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate },
  });
  const proposal = {
    meetingId: 'meeting-4', objective: 'integrate safely', workspace: '/repo',
    sourceRevision: 'base', acceptanceCriteria: [{ id: 'done', description: 'done' }],
  };

  const failing = makeHarness(async () => { throw new Error('branch moved'); });
  const failedRun = await failing.propose(proposal);
  await failing.decide(failedRun.id, { kind: 'approve-spec', specVersion: 1 });
  const candidate = await waitFor(failing, failedRun.id, 'awaiting-delivery-acceptance');
  await assert.rejects(
    failing.decide(failedRun.id, { kind: 'accept-delivery', candidateId: candidate.candidate.id }),
    /branch moved/,
  );
  assert.equal((await failing.inspect(failedRun.id)).status, 'failed');

  const successful = makeHarness(async () => ({ commit: 'abc' }));
  const acceptedRun = await successful.propose(proposal);
  await successful.decide(acceptedRun.id, { kind: 'approve-spec', specVersion: 1 });
  const ready = await waitFor(successful, acceptedRun.id, 'awaiting-delivery-acceptance');
  await successful.decide(acceptedRun.id, { kind: 'accept-delivery', candidateId: ready.candidate.id });
  await assert.rejects(successful.decide(acceptedRun.id, { kind: 'cancel' }), /cannot cancel/);
});
