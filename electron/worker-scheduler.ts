// worker-scheduler.ts — owns the N-worker pool: spawning, disposal, DAG
// scheduling, dependency cascades, file-collision tracking, and the bursty
// per-worker → talker update queue.
//
// Extracted out of orchestrator.ts so the orchestrator can stay focused on
// Talker lifecycle, post-meeting recap, decision watchers, memory, and the
// MCP bridge surface. The scheduler is the part that carries all of the
// per-worker mutable state (Map<id, WorkerHandle>, recentEdits, the worker
// id sequence, and per-worker debounce timers).
//
// Coupling to the orchestrator is via constructor callbacks — `getTalker`,
// `isClosed`, `emit`, `buildWorkerMcp` — so the scheduler never imports the
// orchestrator class directly. The bridge interface in meeting-mcp.ts is
// still implemented by the orchestrator; the scheduler just receives a
// pre-bound `buildWorkerMcp(workerId)` factory.
//
// The dispose / endAll path is idempotent: every native handle (SDK session,
// flush timer, recent-edit pointer) is released exactly once, even if the
// SDK 'ended' event arrives after end() already disposed the same handle.

import type { ClaudeSession, SessionEvent } from './claude-session.js';
import {
  validatePlan,
  type PlanMeetingTask,
} from './meeting-tools.js';
import { WORKER_PROMPT } from './orchestrator-prompts.js';
import {
  FILE_COLLISION_WINDOW_MS,
  FILE_EDIT_TOOLS,
  condense,
  extractFilePath,
  extractText,
  extractToolUses,
  inferSpecialty,
  summariseToolInput,
  titleFromDescription,
} from './orchestrator-helpers.js';
import type { SteerResult } from './meeting-mcp.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  OrchestratorEvent,
  RecentFileEdit,
  WorkerHandle,
  WorkerSpecialtyKind,
  WorkerStatusKind,
} from './orchestrator-types.js';

export type SessionFactory = (
  opts: ConstructorParameters<typeof ClaudeSession>[0],
) => ClaudeSession;

export interface WorkerSchedulerOpts {
  /** Emit channel — should be the orchestrator's `safeEmit` so events
   *  arriving after end() are dropped at the gate. */
  emit: (e: OrchestratorEvent) => void;
  /** Shared workspace cwd; every worker session inherits this. */
  cwd: string;
  /** Initial trust-mode scope. Live updates go through `setAutoApproveScope`. */
  autoApproveScope: AutoApproveScope;
  /** Env override threaded into ClaudeSession (HOME redirect for the shadow
   *  ~/.claude merge + the env allowlist from settings-loader). */
  workerEnv?: NodeJS.ProcessEnv;
  /** S3: native OS confirmer for destructive tool calls under auto-approve.
   *  Passed straight through to every spawned worker session. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** ClaudeSession constructor (production = `new ClaudeSession(o)`; tests
   *  inject a stub so cleanup paths run without spawning the real CLI). */
  sessionFactory: SessionFactory;
  /** Pre-bound `buildWorkerMcp(bridge, workerId)` from meeting-mcp.ts.
   *  Owned by the orchestrator because the MCP factory needs the bridge;
   *  the scheduler treats the returned object as opaque mcpServer config. */
  buildWorkerMcp: (workerId: string) => unknown;
  /** Talker accessor — used to push worker-update batches, file-collision
   *  warnings, task_done completions, and cascade-failure notes. Returns
   *  null when the talker hasn't started yet or has been torn down. */
  getTalker: () => ClaudeSession | null;
  /** Reports orchestrator shutdown. Scheduler uses it to short-circuit
   *  queued setTimeout callbacks that fire after end(). */
  isClosed: () => boolean;
}

const QUEUED_UPDATE_FLUSH_MS = 1200;
const QUEUED_UPDATE_MAX = 8;
const TASK_HISTORY_MAX = 50;
const ASSISTANT_CONDENSE_CHARS = 140;
const ASSISTANT_DESCRIBE_MAX = 200;
const TASK_DONE_LINE_MAX = 180;

export class WorkerScheduler {
  private workers: Map<string, WorkerHandle> = new Map();
  private recentEdits: Map<string, RecentFileEdit> = new Map();
  private workerIdSeq = 0;
  private autoApproveScope: AutoApproveScope;
  private readonly opts: WorkerSchedulerOpts;

  constructor(opts: WorkerSchedulerOpts) {
    this.opts = opts;
    this.autoApproveScope = opts.autoApproveScope;
  }

  // ---------------------------------------------------------------------------
  // Mutators

  setAutoApproveScope(scope: AutoApproveScope): void {
    this.autoApproveScope = scope;
    for (const handle of this.workers.values()) {
      handle.session?.setAutoApproveScope(scope);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries — mirrored on OrchestratorBridge; orchestrator just delegates.

  hasWorker(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  activeWorkerIds(): string[] {
    const out: string[] = [];
    for (const handle of this.workers.values()) {
      if (handle.status === 'running') out.push(handle.id);
    }
    return out;
  }

  describeWorkers(workerId?: string): string {
    const ids = workerId ? [workerId] : Array.from(this.workers.keys());
    const lines: string[] = [];
    for (const id of ids) {
      const h = this.workers.get(id);
      if (!h) { lines.push(`${id}: unknown`); continue; }
      const parts: string[] = [`${id} [${h.title}] status=${h.status}`];
      if (h.live.currentTool) {
        parts.push(`tool=${h.live.currentTool}${h.live.currentToolInput ? `(${h.live.currentToolInput})` : ''}`);
      }
      if (h.live.lastAssistantText) {
        const t = h.live.lastAssistantText.length > ASSISTANT_DESCRIBE_MAX
          ? `${h.live.lastAssistantText.slice(0, ASSISTANT_DESCRIBE_MAX)}…`
          : h.live.lastAssistantText;
        parts.push(`thought="${t}"`);
      }
      if (h.summary && h.status === 'done') parts.push(`summary="${h.summary}"`);
      if (h.deps.length > 0) {
        const pending = h.deps.filter((d) => this.workers.get(d)?.status !== 'done');
        if (pending.length > 0) parts.push(`waiting_on=${pending.join(',')}`);
      }
      lines.push(parts.join(' | '));
    }
    return lines.join('\n') || 'no workers';
  }

  /** Snapshot every worker's un-flushed update buffer so the orchestrator
   *  can fold them into a final talker line at end(). */
  collectFinalBufferedLines(): string[] {
    const out: string[] = [];
    for (const handle of this.workers.values()) {
      if (handle.bufferedUpdates.length > 0) {
        out.push(`[${handle.title}] ${handle.bufferedUpdates.join(' / ')}`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Broadcast operations to every worker session

  /** Try to land a permission resolution on whichever worker session holds
   *  the pending entry. Talker resolutions are handled separately by the
   *  orchestrator. */
  resolvePermissionInAny(id: string, decision: 'allow' | 'deny', message?: string): void {
    for (const handle of this.workers.values()) {
      handle.session?.resolvePermission(id, decision, message);
    }
  }

  interruptAll(): Promise<void>[] {
    const tasks: Promise<void>[] = [];
    for (const handle of this.workers.values()) {
      if (handle.session) tasks.push(handle.session.interrupt());
    }
    return tasks;
  }

  setPermissionModeAll(
    mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
  ): Promise<void>[] {
    const tasks: Promise<void>[] = [];
    for (const handle of this.workers.values()) {
      if (handle.session) tasks.push(handle.session.setPermissionMode(mode));
    }
    return tasks;
  }

  // ---------------------------------------------------------------------------
  // Delegation entry points — the OrchestratorBridge layer delegates here.

  delegateSingleTask(description: string): {
    workerId: string;
    specialty: WorkerSpecialtyKind;
    reused: boolean;
  } {
    const title = titleFromDescription(description);
    const specialty = inferSpecialty(`${title} ${description}`);
    const reusable = this.findReusableWorker(specialty);
    if (reusable) {
      this.reassignWorker(reusable, { title, prompt: description });
      return { workerId: reusable.id, specialty, reused: true };
    }
    const id = this.nextWorkerId('task');
    this.registerHandle({ id, title, prompt: description, deps: [], specialty });
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { workerId: id, specialty, reused: false };
  }

  installPlan(tasks: PlanMeetingTask[]): { ok: true } | { ok: false; error: string } {
    const err = validatePlan(tasks);
    if (err) return { ok: false, error: err.message };
    for (const task of tasks) {
      if (this.workers.has(task.id)) {
        return { ok: false, error: `Worker id already in use: ${task.id}` };
      }
    }
    for (const task of tasks) {
      this.registerHandle({
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        deps: task.deps ?? [],
        specialty: inferSpecialty(`${task.title} ${task.prompt}`),
      });
    }
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { ok: true };
  }

  steerWorker(workerId: string, addendum: string): SteerResult {
    const handle = this.workers.get(workerId);
    if (!handle) return { ok: false, reason: 'unknown' };
    // B7: addenda for a worker the user can no longer steer used to vanish
    // silently. Surface the actual state so the MCP tool can tell Talker to
    // re-dispatch instead of pretending it landed.
    if (handle.status === 'done') return { ok: false, reason: 'done' };
    if (handle.status === 'failed') return { ok: false, reason: 'failed' };
    if (!handle.session) return { ok: false, reason: 'no-session' };
    if (handle.pendingDelegateAck) {
      handle.queuedAddenda.push(addendum);
      return { ok: true, queued: true };
    }
    void (async () => {
      try {
        await handle.session?.interrupt();
      } catch (err) {
        console.error(`[scheduler] worker.interrupt() failed steering ${workerId}:`, err);
      }
      handle.session?.sendUserText(`(plan update) ${addendum}`);
    })();
    handle.live.busy = true;
    handle.live.lastUpdateTs = Date.now();
    return { ok: true, queued: false };
  }

  markTaskDone(workerId: string, summary: string): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;
    // Inform the talker so the user hears a clean completion line.
    const talker = this.opts.getTalker();
    if (talker) {
      const condensed = summary.length > TASK_DONE_LINE_MAX
        ? `${summary.slice(0, TASK_DONE_LINE_MAX - 2)}…`
        : summary;
      talker.sendUserText(`(worker ${workerId} done) ${condensed}`);
    }
    this.opts.emit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId, status: 'done', summary },
    });
    // Tombstone the handle: status flips to 'done' and the SDK subprocess +
    // flush timer + buffers are released. We keep the entry in `workers` so
    // dependents can still see `status === 'done'` when spawnReadyWorkers
    // walks the graph below.
    this.disposeWorker(handle, 'done', summary);
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** Tear down every live worker resource and stamp terminal status onto
   *  each handle. Pending or running workers at end-of-session count as
   *  failed (the user pulled the plug before task_done landed); done/failed
   *  workers keep their status. Idempotent via `disposeWorker`. */
  endAll(): void {
    for (const handle of this.workers.values()) {
      const finalStatus: WorkerStatusKind =
        handle.status === 'running' || handle.status === 'pending'
          ? 'failed'
          : handle.status;
      this.disposeWorker(handle, finalStatus, handle.summary);
    }
    this.workers.clear();
  }

  // ---------------------------------------------------------------------------
  // Session event handler — wired into every spawnWorker emit callback.

  onWorkerEvent(workerId: string, e: SessionEvent): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    this.opts.emit({ source: workerId, event: e });

    try {
      if (e.kind === 'message') {
        // SDK message shapes are opaque; we walk known fields defensively.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg: any = e.message;
        if (msg?.type === 'assistant') {
          if (handle.pendingDelegateAck) {
            handle.pendingDelegateAck = false;
            if (handle.queuedAddenda.length > 0) {
              this.flushQueuedAddenda(handle);
            }
          }
          const text = extractText(msg);
          if (text) {
            handle.live.lastAssistantText = text;
            handle.live.lastUpdateTs = Date.now();
            this.queueWorkerUpdate(handle, `[${handle.id}] thought: ${condense(text, ASSISTANT_CONDENSE_CHARS)}`);
          }
          const tools = extractToolUses(msg);
          if (tools.length > 0) {
            const t = tools[tools.length - 1];
            handle.live.currentTool = t.name;
            handle.live.currentToolInput = summariseToolInput(t.name, t.input);
            handle.live.busy = true;
            this.queueWorkerUpdate(
              handle,
              `[${handle.id}] started ${t.name}${handle.live.currentToolInput ? `: ${handle.live.currentToolInput}` : ''}`,
            );
            // Track file edits for collision advisory.
            for (const t2 of tools) {
              if (FILE_EDIT_TOOLS.has(t2.name)) {
                const p = extractFilePath(t2.input);
                if (p) this.recordFileEdit(workerId, p);
              }
            }
          }
        } else if (msg?.type === 'user') {
          try {
            const content = msg?.message?.content;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hasResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
            if (hasResult && handle.live.currentTool) {
              this.queueWorkerUpdate(handle, `[${handle.id}] finished ${handle.live.currentTool}`);
              handle.live.currentTool = null;
              handle.live.currentToolInput = null;
            }
          } catch { /* ignore */ }
        } else if (msg?.type === 'result') {
          handle.live.busy = false;
          // If the worker ended a turn WITHOUT calling task_done, we don't
          // mark the node done — that's intentional, it might still be
          // mid-task. But we queue a turn-complete note so the talker hears
          // about it.
          this.queueWorkerUpdate(handle, `[${handle.id}] turn complete`);
        }
      } else if (e.kind === 'ended') {
        // SDK stream ended. Two paths land here:
        //   1. Worker reported task_done → markTaskDone already disposed the
        //      handle and called `session.end()`; this event is the SDK
        //      acknowledging that. handle.status is 'done', skip further work.
        //   2. Worker died / errored / exited a turn without task_done →
        //      status is still 'running'. Treat as failure: emit, dispose,
        //      cascade.
        if (handle.status === 'running') {
          this.opts.emit({
            source: 'talker',
            event: { kind: 'worker-ended', workerId, status: 'failed' },
          });
          this.harvestUnresolvedAddenda(handle);
          this.disposeWorker(handle, 'failed');
          this.emitPlanUpdate();
          this.cascadeFailure(workerId);
        } else {
          // Defensive re-dispose in case the session leaked back here after a
          // direct end() — disposeWorker is idempotent.
          this.disposeWorker(handle, handle.status, handle.summary);
        }
      }
    } catch (err) {
      // B2: stop event-handler exceptions from leaving the handle stranded in
      // 'running'. We deliberately don't dispose+cascade here — the SDK
      // 'ended' event will arrive (or end() will run) and drive cleanup
      // through the normal path. Logging is enough to surface the bug.
      console.error(`[scheduler] onWorkerEvent body threw for ${workerId}:`, err);
    }
  }

  // ===========================================================================
  // Internals

  private registerHandle(spec: {
    id: string;
    title: string;
    prompt: string;
    deps: string[];
    specialty: WorkerSpecialtyKind;
  }): void {
    const handle: WorkerHandle = {
      id: spec.id,
      title: spec.title,
      prompt: spec.prompt,
      deps: spec.deps,
      status: 'pending',
      session: null,
      summary: '',
      live: {
        lastAssistantText: '',
        currentTool: null,
        currentToolInput: null,
        lastUpdateTs: 0,
        busy: false,
      },
      pendingDelegateAck: false,
      queuedAddenda: [],
      bufferedUpdates: [],
      flushTimer: null,
      specialty: spec.specialty,
      startedAt: Date.now(),
      currentTaskId: `${spec.id}-task-1`,
      taskSeq: 1,
      taskHistory: [],
    };
    this.workers.set(spec.id, handle);
  }

  /** Find an idle worker with the same specialty that can take a new task.
   *  An idle worker has terminal status ('done' only — failed workers we
   *  leave alone so the user can inspect them) and no live session. */
  private findReusableWorker(specialty: WorkerSpecialtyKind): WorkerHandle | null {
    for (const handle of this.workers.values()) {
      if (handle.status === 'done' && handle.session === null && handle.specialty === specialty) {
        return handle;
      }
    }
    return null;
  }

  /** Reassign a previously-done worker to a new task. Archives the just-
   *  completed task into taskHistory, resets transient state, then calls
   *  spawnWorker to bring up a fresh SDK subprocess under the same id. */
  private reassignWorker(handle: WorkerHandle, next: { title: string; prompt: string; deps?: string[] }): void {
    const finishedAt = Date.now();
    handle.taskHistory.push({
      id: handle.currentTaskId,
      title: handle.title,
      status: handle.status,
      startedAt: handle.startedAt,
      finishedAt,
      summary: handle.summary || undefined,
    });
    // Cap history length defensively so a single tile doesn't grow unbounded.
    if (handle.taskHistory.length > TASK_HISTORY_MAX) {
      handle.taskHistory.splice(0, handle.taskHistory.length - TASK_HISTORY_MAX);
    }
    handle.taskSeq += 1;
    handle.currentTaskId = `${handle.id}-task-${handle.taskSeq}`;
    handle.title = next.title;
    handle.prompt = next.prompt;
    handle.deps = next.deps ?? [];
    handle.status = 'pending';
    handle.summary = '';
    handle.startedAt = finishedAt;
    handle.live = {
      lastAssistantText: '',
      currentTool: null,
      currentToolInput: null,
      lastUpdateTs: 0,
      busy: false,
    };
    handle.bufferedUpdates = [];
    handle.queuedAddenda = [];
    handle.pendingDelegateAck = false;
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
      handle.flushTimer = null;
    }
    this.emitPlanUpdate();
    this.spawnWorker(handle);
  }

  private spawnReadyWorkers(): void {
    for (const handle of this.workers.values()) {
      if (handle.status !== 'pending') continue;
      const allDepsDone = handle.deps.every((d) => this.workers.get(d)?.status === 'done');
      if (allDepsDone) this.spawnWorker(handle);
    }
  }

  private spawnWorker(handle: WorkerHandle): void {
    const workerMcp = this.opts.buildWorkerMcp(handle.id);
    try {
      handle.session = this.opts.sessionFactory({
        cwd: this.opts.cwd,
        autoApproveScope: this.autoApproveScope,
        envOverride: this.opts.workerEnv,
        confirmDestructive: this.opts.confirmDestructive,
        emit: (e) => this.onWorkerEvent(handle.id, e),
        sessionOptions: {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: WORKER_PROMPT },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mcpServers: { 'meeting-worker': workerMcp as any },
        },
      });
      handle.status = 'running';
      handle.pendingDelegateAck = true;
      handle.queuedAddenda = [];
      handle.live.busy = true;
      handle.live.lastUpdateTs = Date.now();
      handle.session.start();

      // First prompt mentions peer workers so the new worker knows it may be
      // touching shared code with others.
      const peers = Array.from(this.workers.values()).filter(
        (h) => h.id !== handle.id && (h.status === 'running' || h.status === 'pending'),
      );
      const peerLine = peers.length > 0
        ? `\n\n（同事 worker 也在跑：${peers.map((p) => `${p.id}「${p.title}」`).join('、')}。注意可能改到同一份代码。）`
        : '';
      handle.session.sendUserText(handle.prompt + peerLine);

      this.opts.emit({
        source: 'talker',
        event: {
          kind: 'worker-spawned',
          workerId: handle.id,
          title: handle.title,
          deps: handle.deps,
          specialty: handle.specialty,
        },
      });
      this.emitPlanUpdate();
    } catch (err) {
      // B2: anything throwing between sessionFactory and the first
      // sendUserText would otherwise strand the handle: status='pending'
      // (factory threw — and since spawnReadyWorkers retries on pending,
      // that's an infinite loop) or status='running' with a half-initialised
      // session that never receives its prompt. Treat as failure: dispose,
      // tombstone the tile, cascade.
      console.error(`[scheduler] spawnWorker failed for ${handle.id}:`, err);
      this.opts.emit({
        source: 'talker',
        event: { kind: 'worker-ended', workerId: handle.id, status: 'failed' },
      });
      this.harvestUnresolvedAddenda(handle);
      this.disposeWorker(handle, 'failed');
      this.emitPlanUpdate();
      this.cascadeFailure(handle.id);
    }
  }

  /** B8: when a worker fails (SDK exit without task_done, spawn-time throw,
   *  cascade) any addenda that the user/Talker queued via steerWorker are
   *  about to be wiped by disposeWorker. Without this, those instructions
   *  vanish silently — the user sees no feedback and the Talker has no idea
   *  the steer never landed. Snapshot them BEFORE disposal and forward a
   *  single framed note to Talker so it can decide (re-delegate, abandon,
   *  surface to the user). */
  private harvestUnresolvedAddenda(handle: WorkerHandle): void {
    if (handle.queuedAddenda.length === 0) return;
    const lost = handle.queuedAddenda.slice();
    handle.queuedAddenda = [];
    const talker = this.opts.getTalker();
    if (!talker) return;
    const joined = lost.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
    talker.sendUserText(
      `(worker ${handle.id} failed with ${lost.length} unresolved instruction${lost.length === 1 ? '' : 's'} you previously queued via delegate_to/update:\n${joined}\nDecide whether to re-delegate, fold into a new task, or surface to the user.)`,
    );
  }

  /** Release per-worker resources (SDK subprocess, flush timer, buffered
   *  updates, queued addenda, recent-edits entries) and stamp a terminal
   *  status onto the handle. We intentionally retain the handle in
   *  `this.workers` so that dependent workers' status checks still resolve
   *  correctly — the actual leak was the subprocess and listener handles,
   *  not the small handle object itself. The entries are flushed wholesale
   *  when `endAll()` calls `workers.clear()`.
   *
   *  Idempotent: safe to call again on an already-disposed handle. */
  private disposeWorker(handle: WorkerHandle, finalStatus: WorkerStatusKind, summary?: string): void {
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
      handle.flushTimer = null;
    }
    if (handle.session) {
      try {
        handle.session.end();
      } catch (err) {
        console.warn(`[scheduler] worker.end() threw for ${handle.id}:`, err);
      }
      handle.session = null;
    }
    handle.bufferedUpdates = [];
    handle.queuedAddenda = [];
    handle.pendingDelegateAck = false;
    handle.live.busy = false;
    handle.live.currentTool = null;
    handle.live.currentToolInput = null;
    handle.status = finalStatus;
    if (typeof summary === 'string') handle.summary = summary;
    // Drop any file-collision tracking pointing at this worker — without
    // this the recentEdits map keeps a stale workerId reference for up to
    // FILE_COLLISION_WINDOW_MS that can't fire anyway (worker is gone).
    for (const [path, edit] of this.recentEdits) {
      if (edit.workerId === handle.id) this.recentEdits.delete(path);
    }
  }

  private emitPlanUpdate(): void {
    const nodes: MeetingPlanNode[] = Array.from(this.workers.values()).map((h) => ({
      id: h.id,
      title: h.title,
      status: h.status,
      deps: h.deps,
    }));
    const plan: MeetingPlan = { nodes };
    this.opts.emit({ source: 'talker', event: { kind: 'plan-updated', plan } });
  }

  private nextWorkerId(prefix: string): string {
    this.workerIdSeq += 1;
    return `${prefix}-${this.workerIdSeq}`;
  }

  private cascadeFailure(rootId: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const handle of this.workers.values()) {
        if (handle.status !== 'pending') continue;
        if (handle.deps.some((d) => this.workers.get(d)?.status === 'failed')) {
          // Pending nodes have no live session, but disposeWorker normalises
          // any stragglers (queued addenda, ad-hoc flush timers from
          // pre-spawn steering attempts) along with stamping the status.
          // B8: a pending node may still have user-queued addenda from a
          // pre-spawn steerWorker call — surface those to Talker before
          // they get wiped.
          this.harvestUnresolvedAddenda(handle);
          this.disposeWorker(handle, 'failed');
          changed = true;
          this.opts.emit({
            source: 'talker',
            event: { kind: 'worker-ended', workerId: handle.id, status: 'failed' },
          });
        }
      }
    }
    const talker = this.opts.getTalker();
    if (talker) {
      talker.sendUserText(`(worker ${rootId} ended without task_done — downstream tasks marked failed)`);
    }
    this.emitPlanUpdate();
  }

  private flushQueuedAddenda(handle: WorkerHandle): void {
    const batch = handle.queuedAddenda;
    handle.queuedAddenda = [];
    if (batch.length === 0 || !handle.session) return;
    void (async () => {
      try {
        await handle.session?.interrupt();
      } catch (err) {
        console.error(`[scheduler] worker.interrupt() failed flushing addenda for ${handle.id}:`, err);
      }
      handle.session?.sendUserText(`(plan update) ${batch.join('\n')}`);
    })();
  }

  // Coalesce a burst of per-worker events into ONE injected user message to
  // Talker so we don't flood its context.
  private queueWorkerUpdate(handle: WorkerHandle, line: string): void {
    handle.bufferedUpdates.push(line);
    if (handle.bufferedUpdates.length > QUEUED_UPDATE_MAX) {
      handle.bufferedUpdates.splice(0, handle.bufferedUpdates.length - QUEUED_UPDATE_MAX);
    }
    if (handle.flushTimer) return;
    handle.flushTimer = setTimeout(() => {
      handle.flushTimer = null;
      if (this.opts.isClosed()) return;
      const batch = handle.bufferedUpdates;
      handle.bufferedUpdates = [];
      const talker = this.opts.getTalker();
      if (batch.length === 0 || !talker) return;
      const text = `(worker ${handle.id} update)\n${batch.join('\n')}`;
      talker.sendUserText(text);
    }, QUEUED_UPDATE_FLUSH_MS);
  }

  private recordFileEdit(workerId: string, path: string): void {
    const now = Date.now();
    // Sweep expired entries cheaply.
    for (const [key, entry] of this.recentEdits) {
      if (now - entry.ts > FILE_COLLISION_WINDOW_MS) this.recentEdits.delete(key);
    }
    const prior = this.recentEdits.get(path);
    if (prior && prior.workerId !== workerId && (now - prior.ts) < FILE_COLLISION_WINDOW_MS) {
      const talker = this.opts.getTalker();
      if (talker) {
        talker.sendUserText(
          `(file collision) worker ${workerId} and worker ${prior.workerId} both touched ${path} within ${Math.round((now - prior.ts) / 1000)}s. 提醒用户可能有冲突。`,
        );
      }
    }
    this.recentEdits.set(path, { workerId, ts: now });
  }
}
