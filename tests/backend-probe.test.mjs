import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendRegistry } from '../dist-electron/backends/registry.js';

function fakeBackend(overrides = {}) {
  return {
    id: 'fake',
    capabilities: {
      coordinate: true, executeTasks: false,
      displayName: 'Fake', iconId: 'fake', mcp: false, permissions: false,
      systemPrompt: true, skills: false, interrupt: true,
    },
    resolveBinary: () => '/fake/backend',
    async checkAuthStatus() { return { loggedIn: false }; },
    buildEnv() { return {}; },
    createSession() { throw new Error('not used'); },
    ...overrides,
  };
}

test('backend probe separates runtime, authentication, and effective role capability', async () => {
  const registry = new BackendRegistry();
  registry.register(fakeBackend());

  assert.deepEqual(await registry.probe('fake', { authMode: 'oauth' }), {
    backendId: 'fake',
    installed: true,
    runtimePath: '/fake/backend',
    auth: 'required',
    capabilities: { coordinate: true, executeTasks: false },
    blockers: ['authentication-required'],
  });
});

test('a configured API key remains provisional until the first session handshake', async () => {
  const registry = new BackendRegistry();
  registry.register(fakeBackend());
  const probe = await registry.probe('fake', { authMode: 'apikey', apiKey: 'secret' });
  assert.equal(probe.auth, 'configured');
  assert.deepEqual(probe.blockers, []);
});
