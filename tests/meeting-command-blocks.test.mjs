import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_ONLY_ACK,
  dispatchMeetingCommandBlocks,
  meetingCommandHandlerFrom,
} from '../dist-electron/backends/meeting-command-blocks.js';

test('meeting-command blocks are stripped from visible text and dispatched', async () => {
  const commands = [];
  const errors = [];
  const dispatch = dispatchMeetingCommandBlocks(
    '好的。\n```meeting-command\n{"kind":"speak","text":"收到"}\n```',
    (command) => { commands.push(command); },
    (event) => errors.push(event),
  );
  assert.equal(dispatch.visibleText, '好的。');
  assert.equal(dispatch.hasSpeakCommand, true);
  assert.equal(dispatch.hasNonSpeakCommand, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [{ kind: 'speak', text: '收到' }]);
  assert.deepEqual(errors, []);
});

test('non-speak commands are flagged separately from speak commands', () => {
  const dispatch = dispatchMeetingCommandBlocks(
    '```meeting-command\n{"kind":"ask-host","hostId":"default","question":"进展？"}\n```',
    () => {},
    () => {},
  );
  assert.equal(dispatch.visibleText, '');
  assert.equal(dispatch.hasSpeakCommand, false);
  assert.equal(dispatch.hasNonSpeakCommand, true);
});

test('a speak command without text counts as a non-speak command', () => {
  const dispatch = dispatchMeetingCommandBlocks(
    '```meeting-command\n{"kind":"speak","text":"  "}\n```',
    () => {},
    () => {},
  );
  assert.equal(dispatch.hasSpeakCommand, false);
  assert.equal(dispatch.hasNonSpeakCommand, true);
});

test('malformed command JSON surfaces an error event instead of throwing', () => {
  const errors = [];
  const dispatch = dispatchMeetingCommandBlocks(
    '```meeting-command\n{not json}\n```',
    () => {},
    (event) => errors.push(event),
  );
  assert.equal(dispatch.visibleText, '');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'error');
  assert.match(errors[0].error, /Invalid meeting-command JSON/);
});

test('handler failures surface as error events without breaking dispatch', async () => {
  const errors = [];
  dispatchMeetingCommandBlocks(
    '```meeting-command\n{"kind":"broadcast-hosts","question":"q"}\n```',
    () => Promise.reject(new Error('boom')),
    (event) => errors.push(event),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [{ kind: 'error', error: 'Meeting command failed: Error: boom' }]);
});

test('a resolved { ok: false } handler result surfaces as an error event', async () => {
  const errors = [];
  dispatchMeetingCommandBlocks(
    '```meeting-command\n{"kind":"speak","text":"hi"}\n```',
    () => ({ ok: false, code: 'forbidden', error: 'speak requires the coordinator role' }),
    (event) => errors.push(event),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [{
    kind: 'error',
    error: 'Meeting command rejected: speak requires the coordinator role',
  }]);
});

test('command blocks beyond the per-turn limit are ignored with an error event', async () => {
  const commands = [];
  const errors = [];
  const text = Array.from(
    { length: 12 },
    (_, i) => `\`\`\`meeting-command\n{"kind":"broadcast-hosts","question":"q${i}"}\n\`\`\``,
  ).join('\n');
  dispatchMeetingCommandBlocks(
    text,
    (command) => { commands.push(command); },
    (event) => errors.push(event),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands.length, 10);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /limit/);
});

test('meetingCommandHandlerFrom only accepts functions', () => {
  const handler = () => {};
  assert.equal(meetingCommandHandlerFrom({ meetingCommandHandler: handler }), handler);
  assert.equal(meetingCommandHandlerFrom({ meetingCommandHandler: 'nope' }), undefined);
  assert.equal(meetingCommandHandlerFrom({}), undefined);
  assert.equal(meetingCommandHandlerFrom(undefined), undefined);
});

test('the command-only ack is a non-empty chat line', () => {
  assert.equal(typeof COMMAND_ONLY_ACK, 'string');
  assert.ok(COMMAND_ONLY_ACK.trim().length > 0);
});
