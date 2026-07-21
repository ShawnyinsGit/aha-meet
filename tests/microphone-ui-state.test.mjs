import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadStateModule() {
  const source = await readFile(
    new URL('../src/lib/microphone-ui-state.ts', import.meta.url),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('Whisper initialization never presents the microphone as unsupported', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  assert.deepEqual(
    deriveMicrophoneUiState({
      mode: 'whisper',
      captureStatus: 'initializing',
      browserSupported: false,
      browserFailed: false,
    }),
    { supported: true, retryable: false },
  );
});

test('Whisper failures keep the microphone control available for retry', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  for (const captureStatus of ['permission-denied', 'failed']) {
    assert.deepEqual(
      deriveMicrophoneUiState({
        mode: 'whisper',
        captureStatus,
        browserSupported: false,
        browserFailed: false,
      }),
      { supported: true, retryable: true },
    );
  }
});

test('browser fallback is unsupported only after capability probing completes', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  assert.deepEqual(
    deriveMicrophoneUiState({
      mode: 'browser',
      captureStatus: 'idle',
      browserSupported: null,
      browserFailed: false,
    }),
    { supported: true, retryable: false },
  );
  assert.deepEqual(
    deriveMicrophoneUiState({
      mode: 'browser',
      captureStatus: 'idle',
      browserSupported: false,
      browserFailed: false,
    }),
    { supported: false, retryable: false },
  );
});

test('browser recognition failures remain retryable', async () => {
  const { deriveMicrophoneUiState } = await loadStateModule();
  assert.deepEqual(
    deriveMicrophoneUiState({
      mode: 'browser',
      captureStatus: 'idle',
      browserSupported: true,
      browserFailed: true,
    }),
    { supported: true, retryable: true },
  );
});

test('audio meter level distinguishes silence from an active signal', async () => {
  const { computeAudioLevel } = await loadStateModule();
  assert.equal(computeAudioLevel(new Uint8Array([128, 128, 128, 128])), 0);
  assert.ok(computeAudioLevel(new Uint8Array([64, 192, 64, 192])) > 0.4);
});

test('microphone operations wait for the previous device release', async () => {
  const { serializeMicrophoneOperation } = await loadStateModule();
  let finishRelease;
  const previous = new Promise((resolve) => { finishRelease = resolve; });
  let nextStarted = false;
  const queued = serializeMicrophoneOperation(previous, async () => {
    nextStarted = true;
  });

  await Promise.resolve();
  assert.equal(nextStarted, false);
  finishRelease();
  await queued;
  assert.equal(nextStarted, true);
});
