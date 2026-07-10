// orchestrator.ts — coordinates M HostGroups (each: 1 Host + N Workers).
//
//   HostGroup "default" (Claude Code, always present)
//     ├── Host (Talker — Haiku-class, meeting-MCP tools, faces the user)
//     └── Workers (0..4, Sonnet-class, full Claude Code preset)
//
//   HostGroup "codex-host" (added via addHost)
//     ├── Host (Codex agent)
//     └── Workers (0..4, Codex sessions)
//
// When only the default HostGroup exists, behavior is identical to the
// pre-multi-host architecture. The public API is unchanged.
//
// MCP tool callbacks for both roles live in `meeting-mcp.ts` and reach back
// here through the `OrchestratorBridge` interface this class implements.
// Recap (post-meeting Haiku summarisation) lives in `recap.ts`. Per-worker
// scheduling, spawn / dispose / DAG cascades, file-collision tracking, and
// the bursty worker→talker update queue live in `worker-scheduler.ts` —
// this file owns the coordination layer and delegates all per-host mechanics
// to HostGroup.

import { randomUUID } from 'node:crypto';
import { ClaudeSession, type SessionEvent } from './claude-session.js';
import type { BackendSession } from './backends/cli-backend.js';
import { getBackendRegistry } from './backends/registry.js';
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
  type MemoryCategory,
} from './memory.js';
import { getSettings } from './store.js';
import {
  SAVE_MEMORY_PER_SESSION_LIMIT,
} from './orchestrator-helpers.js';
import {
  type DecisionCreationResult,
  type OrchestratorBridge,
  type SaveMemoryResult,
  type SteerResult,
} from './meeting-mcp.js';
import { BrowserTabManager } from './browser-tab-manager.js';
import { startRecap, type RecapHandle } from './recap.js';
import { type SessionFactory } from './worker-scheduler.js';
import { ensureDir, maybeAppendGitignore } from './attachments/workspace.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { HostGroup } from './host-group.js';
import { CrossHostBus } from './cross-host-bus.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  OrchestratorEvent,
  OrchestratorSource,
  WorkerSpecialtyKind,
  WorkerStatusKind,
} from './orchestrator-types.js';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type {
  OrchestratorEvent,
  OrchestratorSource,
  MeetingPlan,
  MeetingPlanNode,
  WorkerStatusKind,
  WorkerSpecialtyKind,
} from './orchestrator-types.js';

/** Default host group id. Always present in every meeting. */
const DEFAULT_HOST_ID = 'default';
const DEFAULT_BACKEND_ID = 'claude-code';

interface OrchestratorOpts {
  emit: (e: OrchestratorEvent) => void;
  cwd: string;
  autoApproveScope?: AutoApproveScope;
  workerEnv?: NodeJS.ProcessEnv;
  /** Model override for the talker session. When unset the talker defaults to
   *  Haiku for latency; a custom gateway/model (ANTHROPIC_MODEL) is threaded
   *  here so the talker doesn't request a model the gateway can't serve. */
  talkerModel?: string;
  /** Optional override for ClaudeSession construction. Production code leaves
   *  this unset; tests inject a stub so cleanup paths can run without
   *  spawning the real Claude CLI subprocess. */
  sessionFactory?: SessionFactory;
  /** S3: native OS confirmer for destructive tool calls when auto-approve is
   *  on. Main wires this to dialog.showMessageBox so a compromised renderer
   *  cannot fake the approval. Threaded through to every ClaudeSession. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Optional browser tab manager for embedded browser MCP tools. When
   *  provided, all workers get browser_navigate/screenshot/click/type tools. */
  browserTabManager?: BrowserTabManager;
  /** Backend ID for the default host group. Defaults to 'claude-code'. */
  defaultBackendId?: string;
}

export class Orchestrator implements OrchestratorBridge {
  /** All host groups in this meeting. Always has at least 'default'. */
  private hostGroups = new Map<string, HostGroup>();
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private autoApproveScope: AutoApproveScope;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private talkerModel: string | undefined;
  private confirmDestructive: ((toolName: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
  private browserTabManager: BrowserTabManager | undefined;
  private closed = false;
  private projectId: string;
  private meetingId: string;
  private saveMemoryCallsThisSession = 0;
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

  // Cross-host messaging bus. Each HostGroup subscribes on creation; the
  // orchestrator publishes when cross-host events occur (file writes, decision
  // resolutions, etc.).
  private crossHostBus = new CrossHostBus();

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
    this.talkerModel = opts.talkerModel;
    this.confirmDestructive = opts.confirmDestructive;
    this.browserTabManager = opts.browserTabManager;
    this.projectId = computeProjectId(this.cwd);
    this.meetingId = randomUUID();
    this.sessionFactory = opts.sessionFactory ?? Orchestrator.defaultClaudeFactory;

    // Create the default HostGroup. Use the user's preferred backend if specified.
    const defaultBackend = opts.defaultBackendId ?? DEFAULT_BACKEND_ID;
    this.createHostGroup(DEFAULT_HOST_ID, defaultBackend);

    Orchestrator.liveInstances.add(this);
    Orchestrator.ensureShutdownHook();
  }

  // ---------------------------------------------------------------------------
  // HostGroup management

  /** Build a SessionFactory for a specific backend. Falls back to ClaudeSession
   *  when the backend is 'claude-code' or when the adapter is not found. */
  private buildSessionFactory(backendId: string): SessionFactory {
    // If a test-injected factory is set, use it for all backends.
    if (this.sessionFactory !== Orchestrator.defaultClaudeFactory) {
      return this.sessionFactory;
    }
    if (backendId === DEFAULT_BACKEND_ID || backendId === 'claude-code') {
      return Orchestrator.defaultClaudeFactory;
    }
    const backend = getBackendRegistry().get(backendId);
    if (!backend) {
      console.warn(`[orchestrator] backend '${backendId}' not found in registry, falling back to claude-code`);
      return Orchestrator.defaultClaudeFactory;
    }
    // Wrap the adapter's createSession to accept ClaudeSession-shaped opts,
    // translating the fields that differ between the two interfaces.
    return (opts) => {
      const so = opts.sessionOptions ?? {};
      let systemPrompt: string | undefined;
      if (typeof so.systemPrompt === 'string') {
        systemPrompt = so.systemPrompt;
      } else if (so.systemPrompt && typeof so.systemPrompt === 'object' && 'append' in so.systemPrompt) {
        systemPrompt = (so.systemPrompt as { append?: string }).append;
      }
      return backend.createSession(
        {
          cwd: opts.cwd,
          systemPrompt,
          model: so.model,
          env: opts.envOverride,
          mcpServers: so.mcpServers as Record<string, unknown> | undefined,
          skills: Array.isArray(so.skills) ? so.skills : undefined,
          autoApproveScope: opts.autoApproveScope,
        },
        // BackendSessionEvent is structurally compatible with SessionEvent
        // (same kind discriminators, NormalizedMessage mirrors SDKMessage shape).
        opts.emit as (e: import('./backends/cli-backend.js').BackendSessionEvent) => void,
      );
    };
  }

  /** Default ClaudeSession factory, used as identity check for test overrides. */
  private static readonly defaultClaudeFactory: SessionFactory =
    (o) => new ClaudeSession(o) as unknown as BackendSession;

  private createHostGroup(id: string, backendId: string): HostGroup {
    const factory = this.buildSessionFactory(backendId);
    const hg = new HostGroup({
      id,
      backendId,
      emit: (e) => this.onHostGroupEvent(id, e),
      cwd: this.cwd,
      projectId: this.projectId,
      autoApproveScope: this.autoApproveScope,
      workerEnv: this.workerEnv,
      talkerModel: this.talkerModel,
      confirmDestructive: this.confirmDestructive,
      sessionFactory: factory,
      browserTabManager: this.browserTabManager,
      bridge: this,
      isClosed: () => this.closed,
      getSpeechFilterMode: () => (getSettings().speechFilterMode === 'off' ? 'off' : 'strict'),
    });
    this.hostGroups.set(id, hg);

    // Subscribe to cross-host messages targeting this group
    this.crossHostBus.subscribe(id, (msg) => {
      const host = hg.getHost();
      if (host) {
        host.sendUserText(`[cross-host from ${msg.from}] ${msg.text}`, 'normal');
      }
    });

    return hg;
  }

  /** Add a new host group to this meeting. Returns the host group id.
   *  The host's talker session is started asynchronously — the renderer shows
   *  a "Connecting…" placeholder until the session-ready event arrives. */
  addHost(backendId: string, hostId?: string): { ok: true; hostId: string } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: 'orchestrator is closed' };
    if (hostId && !/^[a-zA-Z0-9._-]{1,64}$/.test(hostId)) {
      return { ok: false, error: 'hostId must be alphanumeric with dots/hyphens/underscores, max 64 chars' };
    }
    const id = hostId ?? `${backendId}-host-${this.hostGroups.size}`;
    if (this.hostGroups.has(id)) {
      return { ok: false, error: `host group '${id}' already exists` };
    }
    const hg = this.createHostGroup(id, backendId);

    // Fire-and-forget the talker spawn. Without this the HostGroup sits idle
    // forever — the renderer shows "Connecting…" but no session ever starts.
    void (async () => {
      try {
        // Send a greeting so the new host's talker has something to respond to.
        // Without this, the session starts but receives no input and sits idle.
        const greeting = `你好！你已加入会议作为 ${backendId} 主持。请简要介绍自己并等待任务分配。`;
        await hg.start(greeting);
        if (!this.closed) {
          this.safeEmit({
            source: 'system',
            hostId: id,
            event: { kind: 'session-ready' },
          });
        }
      } catch (err: unknown) {
        console.error(`[orchestrator] failed to start host '${id}':`, err);
        this.safeEmit({
          source: 'system',
          hostId: id,
          event: {
            kind: 'session-start-failed',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();

    return { ok: true, hostId: id };
  }

  /** Remove a host group. Cannot remove the default host. */
  removeHost(hostId: string): { ok: true } | { ok: false; error: string } {
    if (hostId === DEFAULT_HOST_ID) {
      return { ok: false, error: 'cannot remove the default host group' };
    }
    const hg = this.hostGroups.get(hostId);
    if (!hg) {
      return { ok: false, error: `host group '${hostId}' not found` };
    }
    hg.end();
    this.hostGroups.delete(hostId);
    this.crossHostBus.unsubscribeHost(hostId);
    return { ok: true };
  }

  /** List all host groups with their ids and backend ids. */
  listHosts(): Array<{ id: string; backendId: string }> {
    return Array.from(this.hostGroups.entries()).map(([id, hg]) => ({
      id,
      backendId: hg.backendId,
    }));
  }

  /** Get the default host group (always present). */
  private defaultHost(): HostGroup {
    const hg = this.hostGroups.get(DEFAULT_HOST_ID);
    if (!hg) throw new Error('default host group missing — this is a bug');
    return hg;
  }

  /** Handle events from a HostGroup, tagging with hostId before re-emitting. */
  private onHostGroupEvent(hostId: string, e: OrchestratorEvent) {
    this.safeEmit({ ...e, hostId });
  }

  // ---------------------------------------------------------------------------
  // Public API (delegates to default host for backward compatibility)

  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
    for (const hg of this.hostGroups.values()) {
      hg.setAutoApproveScope(scope);
    }
  }

  private safeEmit(e: OrchestratorEvent) {
    if (this.closed) return;
    // Ensure hostId is always present; default to 'default' when absent.
    if (!e.hostId) e = { ...e, hostId: DEFAULT_HOST_ID };
    this.emit(e);
  }

  async start(greeting?: string) {
    await this.defaultHost().start(greeting);
  }

  sendUserText(text: string) {
    // Single entry point reached from the renderer IPC (session:user-text).
    // Routes to the default host. Multi-host routing (e.g. user picks a
    // specific host) is a Phase 4 concern.
    this.defaultHost().sendUserText(text);
  }

  sendUserImage(content: SDKUserMessage['message']['content']) {
    this.defaultHost().sendUserImage(content);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    // Try every active host group; only the one that issued the permission
    // request actually has a matching pending entry.
    for (const hg of this.hostGroups.values()) {
      hg.resolvePermission(id, decision, message);
    }
  }

  async interrupt() {
    const tasks: Promise<void>[] = [];
    for (const hg of this.hostGroups.values()) {
      tasks.push(hg.interrupt());
    }
    // B4: abort end-of-meeting recap if it's mid-flight. Recap runs after
    // `end()` so an interrupt arriving here may be the only signal to stop.
    if (this.recapHandle) tasks.push(this.recapHandle.abort());
    await Promise.allSettled(tasks);
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
    for (const hg of this.hostGroups.values()) {
      tasks.push(hg.setPermissionMode(mode));
    }
    await Promise.all(tasks);
  }

  end(): Promise<void> {
    if (this.endPromise) return this.endPromise;

    // Merge transcripts from all host groups for recap.
    const allTranscripts: import('./orchestrator-types.js').TalkerTurn[] = [];
    for (const hg of this.hostGroups.values()) {
      allTranscripts.push(...hg.getTranscript());
    }

    this.recapHandle = startRecap({
      transcript: allTranscripts,
      cwd: this.cwd,
      env: this.workerEnv,
      projectId: this.projectId,
      meetingId: this.meetingId,
    });

    // Flush any unfinished worker progress into one final talker line so the
    // user isn't left wondering what happened. Done BEFORE closing the gate.
    const dh = this.defaultHost();
    const dhHost = dh.getHost();
    if (dhHost) {
      const finalLines = dh.getScheduler().collectFinalBufferedLines();
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

    // End all host groups — wrap in try/finally so cleanup always runs.
    const errors: unknown[] = [];
    for (const hg of this.hostGroups.values()) {
      try { hg.end(); } catch (err) { errors.push(err); }
    }

    this.decisions.dispose();
    this.decisionMeta.clear();
    this.crossHostBus.dispose();
    Orchestrator.liveInstances.delete(this);

    if (errors.length > 0) {
      console.error('[orchestrator] errors during end():', errors);
    }

    // Currently only recap.done is async. If host group teardown grows async
    // cleanup later, push those Promises into this array.
    const cleanupPromises: Promise<void>[] = [];
    if (this.recapHandle) cleanupPromises.push(this.recapHandle.done);

    this.endPromise = Promise.all(cleanupPromises).then(() => undefined);
    return this.endPromise;
  }

  /** Manual entry point: renderer-side "Plan meeting" button. */
  async installPlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.defaultHost().getScheduler().installPlan(tasks);
  }

  // ===========================================================================
  // OrchestratorBridge — methods called from the MCP tool factories in
  // meeting-mcp.ts. These route to the default host's scheduler. In a full
  // multi-host setup, the bridge would be hostId-aware; for now the default
  // host handles all MCP tool callbacks.

  delegateSingleTask(description: string): { workerId: string; specialty: WorkerSpecialtyKind; reused: boolean } {
    return this.defaultHost().getScheduler().delegateSingleTask(description);
  }

  steerWorker(workerId: string, addendum: string): SteerResult {
    // Search across all host groups — worker IDs are unique.
    for (const hg of this.hostGroups.values()) {
      const result = hg.getScheduler().steerWorker(workerId, addendum);
      if (result.ok || result.reason !== 'unknown') return result;
    }
    return { ok: false, reason: 'unknown' };
  }

  hasWorker(workerId: string): boolean {
    for (const hg of this.hostGroups.values()) {
      if (hg.getScheduler().hasWorker(workerId)) return true;
    }
    return false;
  }

  activeWorkerIds(): string[] {
    const ids: string[] = [];
    for (const hg of this.hostGroups.values()) {
      ids.push(...hg.getScheduler().activeWorkerIds());
    }
    return ids;
  }

  describeWorkers(workerId?: string): string {
    return this.defaultHost().getScheduler().describeWorkers(workerId);
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
    this.defaultHost().getHost()?.sendUserText(`(you just spoke to the user) ${text}`, 'normal');
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

  /** Save a report-mode document to .vibe-docs/ and emit a document-saved
   *  event so the renderer can display it. Filename is derived from date + title. */
  async saveDocument(input: { title: string; content: string; spokenSummary: string }): Promise<{ ok: boolean; filename?: string; error?: string }> {
    try {
      const docsDir = await ensureDir(this.cwd, '.vibe-docs');
      if (!docsDir) return { ok: false, error: 'could not create .vibe-docs directory' };

      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      const safeTitle = input.title
        .replace(/[^a-zA-Z0-9一-鿿\s_-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40);
      const filename = `${dateStr}-${safeTitle}.md`;
      const filePath = path.join(docsDir, filename);

      // Prepend YAML front-matter with title for the renderer to display
      const header = `---\ntitle: ${input.title}\ncreated: ${now.toISOString()}\n---\n\n`;
      await fsp.writeFile(filePath, header + input.content, 'utf8');
      await maybeAppendGitignore(this.cwd, '.vibe-docs');

      // Emit event so the renderer can show the document
      this.safeEmit({
        source: 'talker',
        event: {
          kind: 'document-saved',
          title: input.title,
          filename,
          path: filePath,
        },
      });

      return { ok: true, filename };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[orchestrator] saveDocument failed:', msg);
      return { ok: false, error: msg };
    }
  }

  markWorkerTaskDone(workerId: string, summary: string): void {
    // Search across all host groups.
    for (const hg of this.hostGroups.values()) {
      if (hg.getScheduler().hasWorker(workerId)) {
        hg.getScheduler().markTaskDone(workerId, summary);
        return;
      }
    }
  }

  // Test-only proxy: forward session events to the scheduler for simulation.
  schedulerOnWorkerEvent(workerId: string, e: SessionEvent): void {
    this.defaultHost().getScheduler().onWorkerEvent(workerId, e);
  }

  submitWorkerDelivery(workerId: string, files: string[]): void {
    for (const hg of this.hostGroups.values()) {
      if (hg.getScheduler().hasWorker(workerId)) {
        hg.getScheduler().submitWorkerDelivery(workerId, files);
        return;
      }
    }
  }

  // ===========================================================================

  /**
   * Called from DecisionWatcher when the user fills in "✅ 确认结论". Pushes a
   * synthetic system message into the default host's talker so the model can
   * re-evaluate, and surfaces an activity entry to the renderer.
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
    this.defaultHost().getHost()?.sendUserText(
      `(decision update) 用户对"${question}"给出了结论：${condensed}\n\n如果这跟你之前推进的方向不一致，请马上调整：可以 delegate_to 现有 worker 让他改，或开新 worker 走另一条路；并简短告诉用户你怎么调整。`,
      'normal',
    );
    this.decisionMeta.delete(r.id);
    this.decisions.unwatch(r.path);

    // Cross-host notification: if other hosts exist, tell them about the decision.
    if (this.hostGroups.size > 1) {
      this.crossHostBus.publish({
        from: DEFAULT_HOST_ID,
        to: '*',
        text: `Decision resolved: "${question}" → ${condensed}`,
        meta: { kind: 'decision-resolved', payload: { decisionId: r.id, question, conclusion: condensed } },
      });
    }
  }
}
