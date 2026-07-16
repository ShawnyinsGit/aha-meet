import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKimiCommandArgs,
  parseKimiStreamEvent,
} from '../dist-electron/backends/kimi-adapter.js';

test('Kimi Code 0.24 uses supported one-shot stream-json arguments', () => {
  assert.deepEqual(buildKimiCommandArgs({ prompt: 'hello', model: 'kimi-k2' }), [
    '--prompt', 'hello',
    '--output-format', 'stream-json',
    '--model', 'kimi-k2',
  ]);
});

test('Kimi follow-up turns resume the exact CLI session', () => {
  assert.deepEqual(buildKimiCommandArgs({ prompt: 'next', sessionId: 'session_123' }), [
    '--session', 'session_123',
    '--prompt', 'next',
    '--output-format', 'stream-json',
  ]);
});

test('Kimi stream parser captures assistant text and resume hints', () => {
  assert.deepEqual(
    parseKimiStreamEvent('{"role":"assistant","content":"hello"}'),
    {
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        raw: { role: 'assistant', content: 'hello' },
      },
    },
  );
  assert.deepEqual(
    parseKimiStreamEvent('{"role":"meta","type":"session.resume_hint","session_id":"session_123"}'),
    { sessionId: 'session_123' },
  );
});
