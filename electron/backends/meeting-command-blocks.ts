// meeting-command-blocks.ts — shared ```meeting-command fenced-block protocol.
//
// Backends that cannot mount the in-process meeting MCP server (Codex, Kimi,
// Qoder) coordinate by embedding fenced JSON command blocks in ordinary
// assistant text. This helper extracts those blocks, forwards each parsed
// command to the orchestrator's handler, and reports the text that should
// remain visible to the user.

import type { BackendSessionEvent } from './cli-backend.js';

export type MeetingCommandHandler = (command: unknown) => Promise<unknown> | unknown;

export interface MeetingCommandDispatch {
  visibleText: string;
  hasSpeakCommand: boolean;
  hasNonSpeakCommand: boolean;
}

/** Placeholder chat line when a turn contained only non-speak commands, so
 *  the user is not left staring at silence while the meeting acts on them. */
export const COMMAND_ONLY_ACK = '我正在处理，有结果会马上告诉你。';

/** Upper bound on command blocks dispatched from a single assistant turn.
 *  A runaway model must not turn one message into a handler call storm. */
export const MAX_MEETING_COMMAND_BLOCKS = 10;

/** Read the orchestrator-provided command handler out of session extra. */
export function meetingCommandHandlerFrom(
  extra: Record<string, unknown> | undefined,
): MeetingCommandHandler | undefined {
  const handler = extra?.meetingCommandHandler;
  return typeof handler === 'function' ? handler as MeetingCommandHandler : undefined;
}

/** Strip fenced ```meeting-command blocks from assistant text and dispatch
 *  each parsed command. Speak commands are flagged separately: the
 *  orchestrator narrates them via TTS, so the carrier message is suppressed
 *  instead of shown. */
export function dispatchMeetingCommandBlocks(
  text: string,
  handler: MeetingCommandHandler | undefined,
  emit: (event: BackendSessionEvent) => void,
): MeetingCommandDispatch {
  const fenced = /```meeting-command\s*([\s\S]*?)```/gi;
  let hasSpeakCommand = false;
  let hasNonSpeakCommand = false;
  let dispatched = 0;
  for (const match of text.matchAll(fenced)) {
    if (dispatched >= MAX_MEETING_COMMAND_BLOCKS) {
      emit({ kind: 'error', error: `Ignoring meeting-command blocks beyond the ${MAX_MEETING_COMMAND_BLOCKS}-per-turn limit` });
      break;
    }
    dispatched += 1;
    try {
      const command = JSON.parse(match[1]) as { kind?: unknown; text?: unknown };
      if (command?.kind === 'speak' && typeof command.text === 'string' && command.text.trim()) {
        hasSpeakCommand = true;
      } else {
        hasNonSpeakCommand = true;
      }
      if (handler) {
        void Promise.resolve(handler(command)).then((result) => {
          // executeMeetingCommand resolves { ok: false } instead of rejecting;
          // surface those rejections or the user never learns a command failed.
          if (isFailureResult(result)) {
            emit({ kind: 'error', error: `Meeting command rejected: ${result.error}` });
          }
        }).catch((error) => {
          emit({ kind: 'error', error: `Meeting command failed: ${String(error)}` });
        });
      }
    } catch (error) {
      emit({ kind: 'error', error: `Invalid meeting-command JSON: ${String(error)}` });
    }
  }
  return { visibleText: text.replace(fenced, '').trim(), hasSpeakCommand, hasNonSpeakCommand };
}

function isFailureResult(result: unknown): result is { ok: false; error: string } {
  return typeof result === 'object' && result !== null
    && (result as { ok?: unknown }).ok === false
    && typeof (result as { error?: unknown }).error === 'string';
}
