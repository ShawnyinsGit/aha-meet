import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadModule() {
  const source = await readFile(
    new URL('../src/lib/onnx-session-init.ts', import.meta.url),
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

test('ONNX session initialization is serialized', async () => {
  const { serializeOnnxSessionInitialization } = await loadModule();
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const events = [];

  const first = serializeOnnxSessionInitialization(async () => {
    events.push('first:start');
    markFirstStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:end');
    return 1;
  });
  const second = serializeOnnxSessionInitialization(async () => {
    events.push('second:start');
    return 2;
  });

  await firstStarted;
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('a failed initialization does not block the next session', async () => {
  const { serializeOnnxSessionInitialization } = await loadModule();
  await assert.rejects(
    serializeOnnxSessionInitialization(async () => { throw new Error('failed'); }),
    /failed/,
  );
  assert.equal(await serializeOnnxSessionInitialization(async () => 'ready'), 'ready');
});
