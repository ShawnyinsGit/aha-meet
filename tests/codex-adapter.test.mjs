import assert from 'node:assert/strict';
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
    item: { type: 'error', error: 'Item error' },
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
