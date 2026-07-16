import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { KimiAcpTransport } from '../dist-electron/backends/kimi-acp-transport.js';

function fakeAcp() {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => true;
  const methods = [];
  process.stdin = new Writable({
    write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk));
      methods.push(message.method);
      queueMicrotask(() => {
        let result = {};
        if (message.method === 'initialize') result = {
          protocolVersion: 1,
          agentInfo: { name: 'Kimi Code CLI', version: '0.24.1' },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        };
        if (message.method === 'session/new') result = { sessionId: 'kimi-session-1' };
        if (message.method === 'session/resume') result = { sessionId: message.params.sessionId };
        if (message.id !== undefined) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
        }
      });
      done();
    },
  });
  return { process, methods };
}

test('Kimi ACP performs authoritative auth and persistent session lifecycle', async () => {
  const fake = fakeAcp();
  const transport = new KimiAcpTransport({
    binaryPath: '/fake/kimi', cwd: '/workspace', env: {}, spawnProcess: () => fake.process,
  });
  const initialized = await transport.start();
  assert.equal(initialized.protocolVersion, 1);
  await transport.authenticate();
  assert.equal(await transport.newSession('/workspace'), 'kimi-session-1');
  assert.equal(await transport.resumeSession('kimi-restored', '/workspace'), 'kimi-restored');
  await transport.setMode('kimi-restored', 'plan');
  assert.deepEqual(fake.methods, [
    'initialize', 'authenticate', 'session/new', 'session/resume', 'session/set_config_option',
  ]);
  transport.close();
});

test('Kimi ACP returns client request results over the same JSON-RPC channel', async () => {
  const fake = fakeAcp();
  const requests = [];
  const transport = new KimiAcpTransport({
    binaryPath: '/fake/kimi', cwd: '/workspace', env: {}, spawnProcess: () => fake.process,
    onRequest: async (request) => { requests.push(request); return { content: 'safe' }; },
  });
  await transport.start();
  fake.process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 'server-1', method: 'fs/read_text_file', params: { path: 'README.md' },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].method, 'fs/read_text_file');
  assert.equal(fake.methods.at(-1), undefined, 'server response has no method');
  transport.close();
});
