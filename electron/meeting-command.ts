import { z } from 'zod';
import { planMeetingTaskSchema } from './meeting-tools.js';

const boundedText = z.string().trim().min(1).max(100_000);
const actorId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/);

export const meetingCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('propose-plan'), tasks: z.array(planMeetingTaskSchema).min(1).max(100) }),
  z.object({ kind: z.literal('ask-host'), hostId: actorId, question: boundedText }),
  z.object({ kind: z.literal('broadcast-hosts'), question: boundedText }),
  z.object({ kind: z.literal('steer-worker'), workerId: actorId, addendum: boundedText }),
  z.object({ kind: z.literal('speak'), text: boundedText }),
]);

export type MeetingCommand = z.infer<typeof meetingCommandSchema>;

export type MeetingCommandActor = {
  hostId: string;
  role: 'coordinator' | 'expert';
};

export type MeetingCommandResult =
  | { ok: true; value?: unknown }
  | { ok: false; code: 'invalid-command' | 'forbidden' | 'invalid-state' | 'execution-failed'; error: string };

/** The validation/authorization seam shared by native tools, SDK structured
 * output and future JSONL adapters. Models never call the Scheduler directly. */
export function authorizeMeetingCommand(
  raw: unknown,
  actor: MeetingCommandActor,
): { ok: true; command: MeetingCommand } | { ok: false; code: 'invalid-command' | 'forbidden'; error: string } {
  const parsed = meetingCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-command', error: parsed.error.issues[0]?.message ?? 'invalid command' };
  }
  const command = parsed.data;
  const coordinatorOnly = command.kind === 'propose-plan'
    || command.kind === 'steer-worker'
    || command.kind === 'speak';
  if (coordinatorOnly && actor.role !== 'coordinator') {
    return { ok: false, code: 'forbidden', error: `${command.kind} requires the coordinator role` };
  }
  return { ok: true, command };
}
