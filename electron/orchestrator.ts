// orchestrator.ts — runs one Talker + N Worker ClaudeSession instances.
//
//   Talker  (Haiku-class, no real tools, only meeting-MCP tools)
//     - Faces the user via voice + chat
//     - For a single request → delegate_task → spawns one anonymous worker
//     - For multiple independent asks → plan_meeting({tasks}) → DAG of workers
//     - Mid-flight steer one → delegate_to({workerId, addendum})
//     - Broadcast course-correct → update_task({addendum})
//     - Status query → ask_worker_status({workerId?})
//
//   Worker  (Sonnet, full Claude Code preset, per-task cwd shared)
//     - Each one is a real Claude Code session with user's installed agents
//       and skills loaded; we just instruct it to dispatch to them.
//     - On completion it calls task_done({summary}) which releases dependents.
//
// MCP tool callbacks for both roles live in `meeting-mcp.ts` and reach back
// here through the `OrchestratorBridge` interface this class implements.
// Recap (post-meeting Haiku summarisation) lives in `recap.ts`. Per-worker
// scheduling, spawn / dispose / DAG cascades, file-collision tracking, and
// the bursty worker→talker update queue live in `worker-scheduler.ts` —
// this file owns the Talker side and delegates all worker mechanics to the
// scheduler.

import { randomUUID } from 'node:crypto';
import { ClaudeSession, type SessionEvent } from './claude-session.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import type { PlanMeetingTask } from './meeting-tools.js';
import {
  DecisionWatcher,
  createDecisionDoc,
  type CreateDecisionPayload,
  type ResolvedDecision,
} from './decisions.js';
import {
  appendEntry,
  computeProjectId,
  formatForPrompt,
  selectRelevant,
  type MemoryCategory,
} from './memory.js';
import { getSettings } from './store.js';
import { TALKER_PROMPT } from './orchestrator-prompts.js';
import {
  MEMORY_TOKEN_BUDGET,
  SAVE_MEMORY_PER_SESSION_LIMIT,
  TALKER_TRANSCRIPT_MAX_ENTRIES,
  extractText,
} from './orchestrator-helpers.js';
import {
  buildTalkerMcp,
  buildWorkerMcp,
  type DecisionCreationResult,
  type OrchestratorBridge,
  type SaveMemoryResult,
  type SteerResult,
} from './meeting-mcp.js';
import { startRecap, type RecapHandle } from './recap.js';
import { WorkerScheduler, type SessionFactory } from './worker-scheduler.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  OrchestratorEvent,
  OrchestratorSource,
  TalkerTurn,
  WorkerSpecialtyKind,
  WorkerStatusKind,
} from './orchestrator-types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type {
  OrchestratorEvent,
  OrchestratorSource,
  MeetingPlan,
  MeetingPlanNode,
  WorkerStatusKind,
  WorkerSpecialtyKind,
} from './orchestrator-types.js';

interface OrchestratorOpts {
  emit: (e: OrchestratorEvent) => void;
  cwd: string;
  autoApproveScope?: AutoApproveScope;
  workerEnv?: NodeJS.ProcessEnv;
  /** Optional override for ClaudeSession construction. Production code leaves
   *  this unset; tests inject a stub so cleanup paths can run without
   *  spawning the real Claude CLI subprocess. */
  sessionFactory?: SessionFactory;
  /** S3: native OS confirmer for destructive tool calls when auto-approve is
   *  on. Main wires this to dialog.showMessageBox so a compromised renderer
   *  cannot fake the approval. Threaded through to every ClaudeSession. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}

export class Orchestrator implements OrchestratorBridge {
  private talker: ClaudeSession | null = null;
  private scheduler: WorkerScheduler;
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private autoApproveScope: AutoApproveScope;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private confirmDestructive: ((toolName: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
  private closed = false;
  private projectId: string;
  private meetingId: string;
  private saveMemoryCallsThisSession = 0;
  private talkerTranscript: TalkerTurn[] = [];
  // Active end-of-meeting recap, if any. Tracked so `interrupt()` can reach
  // into a closed orchestrator and abort the recap pass (B4) — otherwise
  // the user pressing the interrupt button after `end()` was a no-op while
  // Haiku continued to chew through the transcript.
  private recapHandle: RecapHandle | null = null;
  private sessionFactory: SessionFactory;
  // Async decision side-channel. Each open decision has a fs.watch entry that
  // fires onDecisionResolved() when the user fills in "✅ 确认结论". Cleaned up
  // in end().
  private decisions: DecisionWatcher = new DecisionWatcher();
  private decisionMeta: Map<string, { question: string; path: string }> = new Map();

  // Cached in-flight `end()` Promise. Subsequent calls return the same Promise
  // so callers can `await orchestrator.end()` repeatedly without re-running
  // teardown. Distinct from `this.closed` so we can both gate the work AND
  // surface the async cleanup tail (recap) to a waiting before-quit handler.
  private endPromise: Promise<void> | null = null;

  // Process-level fallback: if main.ts forgets (or crashes) before its own
  // before-quit / window-all-closed hooks fire, `process.exit` still gives us
  // one synchronous chance to release native resources held by live workers.
  private static liveInstances: Set<Orchestrator> = new Set();
  private static shutdownHookInstalled = false;

  private static ensureShutdownHook() {
    if (Orchestrator.shutdownHookInstalled) return;
    Orchestrator.shutdownHookInstalled = true;
    const handler = () => {
      for (const inst of Orchestrator.liveInstances) {
        try { inst.end(); } catch { /* ignore */ }
      }
      Orchestrator.liveInstances.clear();
    };
    // 'exit' is sync-only and last-ditch; that's the right shape for "kill
    // anything still alive on the way out". We deliberately don't grab
    // SIGINT/SIGTERM — Electron owns those and would route them through its
    // own quit lifecycle, where main.ts's before-quit handler runs end()
    // for us via the normal path.
    process.once('exit', handler);
  }

  constructor(opts: OrchestratorOpts) {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.autoApproveScope = opts.autoApproveScope ?? 'off';
    this.workerEnv = opts.workerEnv;
    this.confirmDestructive = opts.confirmDestructive;
    this.projectId = computeProjectId(this.cwd);
    this.meetingId = randomUUID();
    this.sessionFactory = opts.sessionFactory ?? ((o) => new ClaudeSession(o));
    this.scheduler = new WorkerScheduler({
      emit: (e) => this.safeEmit(e),
      cwd: this.cwd,
      autoApproveScope: this.autoApproveScope,
      workerEnv: this.workerEnv,
      confirmDestructive: this.confirmDestructive,
      sessionFactory: this.sessionFactory,
      buildWorkerMcp: (workerId) => buildWorkerMcp(this, workerId),
      getTalker: () => this.talker,
      isClosed: () => this.closed,
      // Live read from the settings store so the user's "播报过滤" toggle in
      // the side drawer reaches every active orchestrator without an IPC
      // fanout — getSettings() is backed by an in-process cache that
      // updateSettings() refreshes in place.
      getSpeechFilterMode: () => (getSettings().speechFilterMode === 'off' ? 'off' : 'strict'),
    });
    Orchestrator.liveInstances.add(this);
    Orchestrator.ensureShutdownHook();
  }

  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
    this.talker?.setAutoApproveScope(scope);
    this.scheduler.setAutoApproveScope(scope);
  }

  private safeEmit(e: OrchestratorEvent) {
    if (this.closed) return;
    this.emit(e);
  }

  async start(greeting?: string) {
    const meetingMcp = buildTalkerMcp(this);

    // Pull relevant long-term memory for this project and prepend it to the
    // Talker system prompt so Claude has context from prior meetings before
    // the user even speaks. Always per-project; never cross-project leak.
    let systemPrompt: string = TALKER_PROMPT;
    try {
      const memoryEntries = await selectRelevant(this.projectId, {
        tokenBudget: MEMORY_TOKEN_BUDGET,
      });
      const memoryBlock = formatForPrompt(memoryEntries);
      if (memoryBlock) {
        systemPrompt = `## 历史记忆 (从过往会议沉淀)\n\n${memoryBlock}\n\n---\n\n${TALKER_PROMPT}`;
      }
    } catch (err) {
      console.warn('[memory] failed to load memory for system prompt:', err);
    }

    this.talker = this.sessionFactory({
      cwd: this.cwd,
      autoApproveScope: this.autoApproveScope,
      envOverride: this.workerEnv,
      confirmDestructive: this.confirmDestructive,
      emit: (e) => this.onTalkerEvent(e),
      sessionOptions: {
        systemPrompt,
        tools: [],
        mcpServers: { meeting: meetingMcp },
        skills: [],
        settingSources: [],
      },
    });

    this.talker.start();

    if (greeting) {
      this.talker.sendUserText(greeting);
    }
  }

  sendUserText(text: string) {
    this.talker?.sendUserText(text);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendUserImage(content: any[]) {
    this.talker?.sendUserContent(content);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    // Try every active session; only the one that issued the permission
    // request actually has a matching pending entry.
    this.talker?.resolvePermission(id, decision, message);
    this.scheduler.resolvePermissionInAny(id, decision, message);
  }

  async interrupt() {
    const tasks: Promise<void>[] = [];
    if (this.talker) tasks.push(this.talker.interrupt());
    for (const t of this.scheduler.interruptAll()) tasks.push(t);
    // B4: abort end-of-meeting recap if it's mid-flight. Recap runs after
    // `end()` so an interrupt arriving here may be the only signal to stop.
    if (this.recapHandle) tasks.push(this.recapHandle.abort());
    await Promise.all(tasks);
  }

  /** Returns true if the post-meeting recap is still in flight. Main process
   *  checks this to decide whether to keep the orchestrator reference alive
   *  past `end()` so a follow-up interrupt can still reach it. */
  isRecapActive(): boolean {
    return this.recapHandle?.isActive() ?? false;
  }

  /** Promise that resolves when the post-meeting recap finishes (success,
   *  abort, or failure). Main uses this to clear its held reference once the
   *  recap is no longer reachable. Null if no recap was started. */
  recapDonePromise(): Promise<void> | null {
    return this.recapHandle?.done ?? null;
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    const tasks: Promise<void>[] = [];
    if (this.talker) tasks.push(this.talker.setPermissionMode(mode));
    for (const t of this.scheduler.setPermissionModeAll(mode)) tasks.push(t);
    await Promise.all(tasks);
  }

  end(): Promise<void> {
    if (this.endPromise) return this.endPromise;

    // Snapshot the talker transcript and kick off a recap pass against Haiku
    // BEFORE we tear down. Recap runs in the background; the returned Promise
    // resolves once recap (the only truly async cleanup) finishes so a
    // before-quit handler can `await` end() and reap the SDK subprocesses
    // cleanly instead of getting SIGKILL'd mid-stream.
    const transcriptSnapshot = [...this.talkerTranscript];
    this.recapHandle = startRecap({
      transcript: transcriptSnapshot,
      cwd: this.cwd,
      env: this.workerEnv,
      projectId: this.projectId,
      meetingId: this.meetingId,
    });

    // Flush any unfinished worker progress into one final talker line so the
    // user isn't left wondering what happened. Done BEFORE closing the gate.
    if (this.talker) {
      const finalLines = this.scheduler.collectFinalBufferedLines();
      if (finalLines.length > 0) {
        this.safeEmit({
          source: 'talker',
          event: {
            kind: 'message',
            message: {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: `（会话结束前各 worker 最后动作）\n${finalLines.join('\n')}` }] },
              parent_tool_use_id: null,
              session_id: 'orchestrator-shutdown',
            } as unknown as SDKMessage,
          },
        });
      }
    }

    this.closed = true;
    this.scheduler.endAll();
    this.decisions.dispose();
    this.decisionMeta.clear();
    this.talker?.end();
    this.talker = null;
    Orchestrator.liveInstances.delete(this);

    // Currently only recap.done is async; talker.end() / scheduler.endAll() /
    // decisions.dispose() all return void. If any of those grow async cleanup
    // later, push their Promises into this array.
    const cleanupPromises: Promise<void>[] = [];
    if (this.recapHandle) cleanupPromises.push(this.recapHandle.done);

    this.endPromise = Promise.all(cleanupPromises).then(() => undefined);
    return this.endPromise;
  }

  /** Manual entry point: renderer-side "Plan meeting" button. */
  async installPlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.scheduler.installPlan(tasks);
  }

  // ===========================================================================
  // OrchestratorBridge — methods called from the MCP tool factories in
  // meeting-mcp.ts. Most are thin delegates to the scheduler; the talker-side
  // operations (narrateAssistantLine, createDecision, saveMemory) live here
  // because they touch the talker session / decision watcher / memory store
  // that the orchestrator owns.

  delegateSingleTask(description: string): { workerId: string; specialty: WorkerSpecialtyKind; reused: boolean } {
    return this.scheduler.delegateSingleTask(description);
  }

  steerWorker(workerId: string, addendum: string): SteerResult {
    return this.scheduler.steerWorker(workerId, addendum);
  }

  hasWorker(workerId: string): boolean {
    return this.scheduler.hasWorker(workerId);
  }

  activeWorkerIds(): string[] {
    return this.scheduler.activeWorkerIds();
  }

  describeWorkers(workerId?: string): string {
    return this.scheduler.describeWorkers(workerId);
  }

  narrateAssistantLine(text: string): void {
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'message',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'orchestrator-narrate',
        } as unknown as SDKMessage,
      },
    });
    this.talker?.sendUserText(`(you just spoke to the user) ${text}`);
  }

  async createDecision(payload: CreateDecisionPayload): Promise<DecisionCreationResult> {
    const created = await createDecisionDoc(payload);
    const recommended = payload.options[created.recommendedIndex];
    this.decisionMeta.set(created.id, { question: payload.question, path: created.path });
    this.decisions.watch(created.id, created.path, (r) => this.onDecisionResolved(r));
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'decision-pending',
        decisionId: created.id,
        question: payload.question,
        path: created.path,
        recommendedTitle: recommended?.title ?? '',
        calendarOk: created.calendar.ok,
        remindersOk: created.reminders.ok,
      },
    });
    const sideChannelNote = [
      created.calendar.ok ? 'Calendar ✓' : 'Calendar ✗',
      created.reminders.ok ? 'Reminders ✓' : 'Reminders ✗',
    ].join(' / ');
    return {
      id: created.id,
      path: created.path,
      recommendedTitle: recommended?.title ?? '',
      calendarOk: created.calendar.ok,
      remindersOk: created.reminders.ok,
      sideChannelNote,
    };
  }

  async saveMemory(input: { category: MemoryCategory; content: string; tags: string[] }): Promise<SaveMemoryResult> {
    if (this.saveMemoryCallsThisSession >= SAVE_MEMORY_PER_SESSION_LIMIT) {
      return { ok: false, error: `rate limit reached (${SAVE_MEMORY_PER_SESSION_LIMIT}/session)` };
    }
    this.saveMemoryCallsThisSession += 1;
    const r = await appendEntry({
      category: input.category,
      content: input.content,
      tags: input.tags,
      projectId: this.projectId,
      sourceMeetingId: this.meetingId,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, preview: input.content.slice(0, 40) };
  }

  markWorkerTaskDone(workerId: string, summary: string): void {
    this.scheduler.markTaskDone(workerId, summary);
  }

  // ===========================================================================

  /**
   * Called from DecisionWatcher when the user fills in "✅ 确认结论". Pushes a
   * synthetic system message into the talker so the model can re-evaluate, and
   * surfaces an activity entry to the renderer.
   */
  private onDecisionResolved(r: ResolvedDecision): void {
    if (this.closed) return;
    const meta = this.decisionMeta.get(r.id);
    const question = meta?.question ?? '';
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'decision-resolved',
        decisionId: r.id,
        question,
        path: r.path,
        conclusion: r.conclusion,
      },
    });
    const condensed = r.conclusion.length > 400 ? `${r.conclusion.slice(0, 398)}…` : r.conclusion;
    this.talker?.sendUserText(
      `(decision update) 用户对"${question}"给出了结论：${condensed}\n\n如果这跟你之前推进的方向不一致，请马上调整：可以 delegate_to 现有 worker 让他改，或开新 worker 走另一条路；并简短告诉用户你怎么调整。`,
    );
    // Resolved → drop both the metadata entry and the fs.watch handle.
    // Without this, a 2hr meeting with 30 decisions leaves 30 stale watchers
    // until end() runs. DecisionWatcher.unwatch is keyed by path, not id;
    // ResolvedDecision carries the path directly so no map lookup needed.
    this.decisionMeta.delete(r.id);
    this.decisions.unwatch(r.path);
  }

  private onTalkerEvent(e: SessionEvent) {
    this.safeEmit({ source: 'talker', event: e });

    // ClaudeSession emits 'ended' both for our own teardown (this.closed is
    // already true by then, see end()) and for unexpected subprocess death
    // (OOM, external kill, crash). The second case used to silently break
    // sendUserText — the user kept talking, nothing reached the model, no UI
    // feedback. Surface it via a synthetic assistant message and tear down
    // so the slot ends cleanly. void: end() returns a Promise we don't await
    // here (we're inside an event callback).
    if (e.kind === 'ended' && !this.closed) {
      this.safeEmit({
        source: 'talker',
        event: {
          kind: 'message',
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: '（Talker 进程意外退出，会议自动结束。如需继续请重新打开会议。）' }] },
            parent_tool_use_id: null,
            session_id: 'orchestrator-talker-exit',
          } as unknown as SDKMessage,
        },
      });
      void this.end();
      return;
    }

    // Capture talker turns into a private transcript so end-of-meeting recap
    // has something to feed Haiku. We grab user + assistant text only, never
    // tool-use blobs (those are noisy and recap should focus on conversation).
    if (e.kind === 'message') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: any = e.message;
      const t = msg?.type;
      if (t === 'assistant') {
        const text = extractText(msg);
        if (text) this.appendTalkerTurn({ role: 'assistant', text });
      } else if (t === 'user') {
        const text = extractText(msg);
        if (text) this.appendTalkerTurn({ role: 'user', text });
      }
    }
  }

  private appendTalkerTurn(turn: TalkerTurn) {
    this.talkerTranscript.push(turn);
    if (this.talkerTranscript.length > TALKER_TRANSCRIPT_MAX_ENTRIES) {
      this.talkerTranscript.splice(
        0,
        this.talkerTranscript.length - TALKER_TRANSCRIPT_MAX_ENTRIES,
      );
    }
  }
}
