import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { KimiBackend } from '../dist-electron/backends/kimi-adapter.js';

test('each backend environment receives only its own provider credentials', () => {
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = 'anthropic-canary';
  process.env.OPENAI_API_KEY = 'openai-canary';
  process.env.MOONSHOT_API_KEY = 'moonshot-canary';

  try {
    const claude = new ClaudeCodeBackend().buildEnv({
      authMode: 'apikey', apiKey: 'claude-explicit',
    }, { OPENAI_API_KEY: 'must-not-cross', MOONSHOT_API_KEY: 'must-not-cross' });
    const codex = new CodexBackend().buildEnv({
      authMode: 'apikey', apiKey: 'codex-explicit',
    }, { ANTHROPIC_AUTH_TOKEN: 'must-not-cross' });
    const kimi = new KimiBackend().buildEnv({
      authMode: 'apikey', apiKey: 'kimi-explicit',
    }, { ANTHROPIC_BASE_URL: 'https://must-not-cross.invalid' });

    assert.equal(claude.ANTHROPIC_API_KEY, 'claude-explicit');
    assert.equal(claude.OPENAI_API_KEY, undefined);
    assert.equal(claude.MOONSHOT_API_KEY, undefined);

    assert.equal(codex.OPENAI_API_KEY, 'codex-explicit');
    assert.equal(codex.ANTHROPIC_API_KEY, undefined);
    assert.equal(codex.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(codex.MOONSHOT_API_KEY, undefined);

    assert.equal(kimi.MOONSHOT_API_KEY, 'kimi-explicit');
    assert.equal(kimi.ANTHROPIC_API_KEY, undefined);
    assert.equal(kimi.ANTHROPIC_BASE_URL, undefined);
    assert.equal(kimi.OPENAI_API_KEY, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
