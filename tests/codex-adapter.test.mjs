import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';

function makeSession(commands, events = []) {
  return new CodexBackend().createSession({
    cwd: process.cwd(),
    extra: { meetingCommandHandler: (command) => commands.push(command) },
  }, (event) => events.push(event));
}

test('Codex adapter hides speak protocol frames and dispatches commands', () => {
  const commands = [];
  const session = makeSession(commands);
  const message = session.normalizeItem({
    type: 'agent_message',
    text: '欢迎回来。\n```meeting-command\n{"kind":"speak","text":"欢迎回来。"}\n```\n```meeting-command\n{"kind":"speak","text":""}\n```',
  });
  assert.equal(message, null);
  assert.deepEqual(commands, [
    { kind: 'speak', text: '欢迎回来。' },
    { kind: 'speak', text: '' },
  ]);
});

test('Codex adapter preserves normal text while removing non-speak command frames', () => {
  const commands = [];
  const session = makeSession(commands);
  const message = session.normalizeItem({
    type: 'agent_message',
    text: '我先安排任务。\n```meeting-command\n{"kind":"propose-plan","tasks":[]}\n```',
  });
  assert.equal(message.message.content[0].text, '我先安排任务。');
  assert.deepEqual(commands, [{ kind: 'propose-plan', tasks: [] }]);
});

test('Codex adapter does not emit an empty chat message for command-only output', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    type: 'agent_message',
    text: '```meeting-command\n{"kind":"broadcast-hosts","question":"status?"}\n```',
  });
  assert.equal(message, null);
});

test('Codex adapter collapses an authentication failure into one auth-required event', () => {
  const events = [];
  const session = makeSession([], events);
  assert.equal(session.normalizeEvent({
    type: 'item.completed',
    item: { id: 'error-1', type: 'error', message: 'Item error' },
  }), null);
  assert.equal(session.normalizeEvent({
    type: 'turn.failed',
    error: { message: 'unexpected status 401 Unauthorized: Missing bearer authentication' },
  }), null);
  assert.deepEqual(events, [{
    kind: 'auth-required',
    error: 'Codex 登录已失效，请完成重新认证后重连 Host。',
  }]);
});

test('Codex adapter maps the official command execution shape without losing output', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'cmd-1',
    type: 'command_execution',
    command: 'npm test',
    aggregated_output: '74 tests passed',
    exit_code: 0,
    status: 'completed',
  });
  assert.deepEqual(message.message.content, [
    { type: 'tool_use', id: 'cmd-1', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_result', tool_use_id: 'cmd-1', content: '74 tests passed' },
  ]);
});

test('Codex command completion has a terminal result even when output is empty', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'cmd-empty', type: 'command_execution', command: 'false',
    aggregated_output: '', exit_code: 1, status: 'failed',
  });
  assert.deepEqual(message.message.content[1], {
    type: 'tool_result', tool_use_id: 'cmd-empty', content: '[failed; exit 1]', is_error: true,
  });
});

test('Codex adapter maps every path in the official file change shape', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'patch-1',
    type: 'file_change',
    changes: [
      { path: 'src/a.ts', kind: 'update' },
      { path: 'src/b.ts', kind: 'add' },
    ],
    status: 'completed',
  });
  assert.deepEqual(message.message.content, [
    { type: 'tool_use', id: 'patch-1:0', name: 'Write', input: { file_path: 'src/a.ts', change_kind: 'update', status: 'completed' } },
    { type: 'tool_use', id: 'patch-1:1', name: 'Write', input: { file_path: 'src/b.ts', change_kind: 'add', status: 'completed' } },
  ]);
});

test('Codex adapter maps official MCP server, tool, arguments and result', () => {
  const session = makeSession([]);
  const message = session.normalizeItem({
    id: 'mcp-1',
    type: 'mcp_tool_call',
    server: 'meeting-worker',
    tool: 'task_done',
    arguments: { summary: 'finished' },
    result: { content: [{ type: 'text', text: 'ok' }], structured_content: null },
    status: 'completed',
  });
  assert.deepEqual(message.message.content, [
    { type: 'tool_use', id: 'mcp-1', name: 'mcp__meeting-worker__task_done', input: { summary: 'finished' } },
    { type: 'tool_result', tool_use_id: 'mcp-1', content: '[{"type":"text","text":"ok"}]' },
  ]);
});

test('Codex maps official reasoning, web search and todo items', () => {
  const session = makeSession([]);
  assert.equal(session.normalizeItem({ id: 'r1', type: 'reasoning', text: 'Checked constraints' }).message.content[0].text, 'Checked constraints');
  assert.deepEqual(session.normalizeItem({ id: 'w1', type: 'web_search', query: 'official docs' }).message.content, [
    { type: 'tool_use', id: 'w1', name: 'WebSearch', input: { query: 'official docs' } },
    { type: 'tool_result', tool_use_id: 'w1', content: 'Search completed' },
  ]);
  assert.equal(session.normalizeItem({
    id: 't1', type: 'todo_list', items: [{ text: 'Map events', completed: true }, { text: 'Ship', completed: false }],
  }).message.content[0].text, '[x] Map events\n[ ] Ship');
});

test('Codex readiness rejects when the handshake reports expired authentication', async () => {
  const events = [];
  const thread = {
    async runStreamed() {
      return {
        events: (async function* () {
          yield {
            type: 'turn.failed',
            error: { message: '401 Unauthorized: token revoked' },
          };
        })(),
      };
    },
  };
  class FakeCodex {
    startThread() { return thread; }
  }
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    loadSdk: async () => FakeCodex,
  });
  const session = backend.createSession({ cwd: process.cwd() }, (event) => events.push(event));

  await assert.rejects(session.start(), /authentication required/i);
  assert.deepEqual(events, [{
    kind: 'auth-required',
    error: 'Codex 登录已失效，请完成重新认证后重连 Host。',
  }]);
});

test('Codex captures the official thread id and resumes it on the next session', async () => {
  const calls = [];
  const makeThread = () => ({
    id: null,
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-123' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
      })() };
    },
  });
  class FakeCodex {
    startThread(options) { calls.push(['start', options]); return makeThread(); }
    resumeThread(id, options) { calls.push(['resume', id, options]); return makeThread(); }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const first = backend.createSession({ cwd: '/workspace' }, () => {});
  await first.start();
  assert.deepEqual(first.snapshot(), { protocol: 'codex-sdk', sessionId: 'thread-123' });
  assert.equal(calls[0][1].sandboxMode, 'read-only');
  assert.equal(calls[0][1].approvalPolicy, 'never');

  const resumed = backend.createSession({ cwd: '/workspace', resumeSessionId: 'thread-123' }, () => {});
  await resumed.start();
  assert.equal(calls[1][0], 'resume');
  assert.equal(calls[1][1], 'thread-123');
  first.end();
  resumed.end();
});

test('Codex SDK capability flags do not overclaim MCP or interactive approvals', () => {
  const capabilities = new CodexBackend().capabilities;
  assert.equal(capabilities.mcp, false);
  assert.equal(capabilities.permissions, false);
});

test('Codex materializes base64 images securely and removes them after the turn', async () => {
  let finishTurn;
  const turnFinished = new Promise((resolve) => { finishTurn = resolve; });
  let imagePath;
  class FakeCodex {
    startThread() {
      let call = 0;
      return {
        id: 'thread-image',
        async runStreamed(input) {
          call += 1;
          if (call === 1) return { events: (async function* () {})() };
          assert.equal(Array.isArray(input), true);
          assert.deepEqual(input[0], { type: 'text', text: 'inspect this' });
          assert.equal(input[1].type, 'local_image');
          imagePath = input[1].path;
          assert.deepEqual(await readFile(imagePath), Buffer.from('secure-image'));
          assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
          return { events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
            finishTurn();
          })() };
        },
      };
    }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const session = backend.createSession({ cwd: '/workspace' }, () => {});
  await session.start();
  session.sendUserContent([
    { type: 'text', text: 'inspect this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('secure-image').toString('base64') } },
  ]);
  await turnFinished;
  for (let i = 0; i < 20; i += 1) {
    try { await access(imagePath); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(access(imagePath));
  session.end();
});

test('Codex interrupt cancels an image turn from the moment it is queued', async () => {
  let calls = 0;
  class FakeCodex {
    startThread() {
      return {
        id: 'thread-interrupt',
        async runStreamed() {
          calls += 1;
          return { events: (async function* () {})() };
        },
      };
    }
  }
  const backend = new CodexBackend({ resolveBinary: () => '/fake/codex', loadSdk: async () => FakeCodex });
  const session = backend.createSession({ cwd: '/workspace' }, () => {});
  await session.start();
  session.sendUserContent([{
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: Buffer.from('cancel-me').toString('base64') },
  }]);
  await session.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'only the readiness turn reached the SDK');
  session.end();
});
