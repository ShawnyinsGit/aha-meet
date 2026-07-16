import assert from 'node:assert/strict';
import test from 'node:test';

import { whisperServerEnv } from '../dist-electron/whisper-server.js';

test('packaged Whisper loads ggml backends from its bundled resource directory', () => {
  const env = whisperServerEnv('/Applications/AhaMeet.app/Contents/Resources/whisper');
  assert.equal(
    env.GGML_BACKEND_PATH,
    '/Applications/AhaMeet.app/Contents/Resources/whisper/libggml-cpu-apple_m1.so',
  );
});
