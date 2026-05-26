// Single source of truth for the in-proc MCP tools the Talker uses to drive
// Workers. Both sides need these names — the orchestrator registers them
// (electron) and the renderer filters them out of the user-facing activity
// feed (src/hooks/useClaude.ts).
import { z } from 'zod';

export const MEETING_TOOLS = {
  DELEGATE: 'delegate_task',
  UPDATE: 'update_task',
  STATUS: 'ask_worker_status',
  NARRATE: 'narrate_to_user',
  PLAN_MEETING: 'plan_meeting',
  DELEGATE_TO: 'delegate_to',
  TASK_DONE: 'task_done',
} as const;

export type MeetingToolName = (typeof MEETING_TOOLS)[keyof typeof MEETING_TOOLS];

export const MEETING_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(MEETING_TOOLS),
);

export const planMeetingTaskSchema = z.object({
  id: z.string().min(1).describe('Stable kebab-case identifier for the task.'),
  title: z.string().min(1).describe('Short label shown on the worker tile.'),
  prompt: z.string().min(1).describe('The full prompt the worker will receive as its first message.'),
  deps: z.array(z.string()).optional().describe('IDs of tasks that must finish before this one starts.'),
});

export type PlanMeetingTask = z.infer<typeof planMeetingTaskSchema>;

export const planMeetingArgsSchema = {
  tasks: z.array(planMeetingTaskSchema).min(1).describe('One task per independent piece of work.'),
};

export const delegateToArgsSchema = {
  workerId: z.string().min(1).describe('The id of the worker to steer.'),
  addendum: z.string().min(1).describe('Additional instruction or context for that worker.'),
};

export const taskDoneArgsSchema = {
  summary: z.string().min(1).describe('One-line summary of what changed; surfaced to Talker context.'),
};

export interface PlanValidationError {
  code: 'duplicate_id' | 'unknown_dep' | 'cycle' | 'empty';
  message: string;
}

export function validatePlan(tasks: PlanMeetingTask[]): PlanValidationError | null {
  if (tasks.length === 0) {
    return { code: 'empty', message: 'Plan must contain at least one task.' };
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      return { code: 'duplicate_id', message: `Duplicate task id: ${task.id}` };
    }
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (!ids.has(dep)) {
        return { code: 'unknown_dep', message: `Task ${task.id} depends on unknown task ${dep}` };
      }
      if (dep === task.id) {
        return { code: 'cycle', message: `Task ${task.id} depends on itself` };
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) adjacency.set(task.id, task.deps ?? []);

  function visit(id: string): PlanValidationError | null {
    if (visited.has(id)) return null;
    if (visiting.has(id)) {
      return { code: 'cycle', message: `Cycle detected involving task ${id}` };
    }
    visiting.add(id);
    for (const dep of adjacency.get(id) ?? []) {
      const err = visit(dep);
      if (err) return err;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const task of tasks) {
    const err = visit(task.id);
    if (err) return err;
  }
  return null;
}
