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

import { createSdkMcpServer, query, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ClaudeSession, type SessionEvent } from './claude-session.js';
import {
  MEETING_TOOLS,
  planMeetingArgsSchema,
  delegateToArgsSchema,
  taskDoneArgsSchema,
  validatePlan,
  type PlanMeetingTask,
} from './meeting-tools.js';
import {
  appendEntry,
  computeProjectId,
  formatForPrompt,
  selectRelevant,
} from './memory.js';
import { mergedSubprocessEnv } from './settings-loader.js';

export type OrchestratorSource = 'talker' | string;

// Local mirror of the renderer types (src/types.ts) — we can't cross the
// tsconfig rootDir boundary, so we duplicate the shapes. Keep in sync.
export type WorkerStatusKind = 'pending' | 'running' | 'done' | 'failed';

export interface MeetingPlanNode {
  id: string;
  title: string;
  status: WorkerStatusKind;
  deps: string[];
}

export interface MeetingPlan {
  nodes: MeetingPlanNode[];
}

// Orchestrator-only events (alongside session events emitted from a worker/talker).
export type OrchestratorOnlyEvent =
  | { kind: 'worker-spawned'; workerId: string; title: string; deps: string[] }
  | { kind: 'worker-ended'; workerId: string; status: WorkerStatusKind; summary?: string }
  | { kind: 'plan-updated'; plan: MeetingPlan };

export type EmittedEvent = SessionEvent | OrchestratorOnlyEvent;

export interface OrchestratorEvent {
  source: OrchestratorSource;
  event: EmittedEvent;
}

const TALKER_PROMPT = `你是一场视频会议里的"对话主持"（中英文用户都可能在场，跟随用户语言）。
你的搭档是一个或多个能改代码、跑命令、读文件的执行 agent（worker），通过工具间接调度。

铁律：
- 你不会自己改代码、不会调用 Bash/Read/Edit/Grep 等真实工具，所有动手活儿一律 delegate 给 worker。
- 回答要"说人话"：一两句话，口语化，别像念清单。
- 当用户描述要做的工作 → 判断是单件还是多件：
  · **多件独立**（"A 和 B 同时做"、"顺便把 C 也跑一下"）→ 调 plan_meeting({tasks: [...]}) 一次性派多个 worker 并行。每个 task 给一个稳定的 kebab-case id、一句话标题、给 worker 看的完整 prompt；若有先后依赖用 deps 列表标出来（如 "write-tests" deps ["refactor-auth"]）。
  · **单件**或不确定是不是独立 → 直接 delegate_task({description})，行为和以前一样。
- 当用户改主意、加要求、纠偏 →
  · 想改特定那个 worker → delegate_to({workerId, addendum})
  · 全体生效 → update_task({addendum})（会打断所有运行中的 worker）
- 当用户问"现在在干嘛 / 怎么样了" → 先调 ask_worker_status() 拿到当前情况（可传 workerId 只问一个），再用一两句话说给他听。
- 当任何 worker 报告了进展，你会收到 "(worker X update) ..." 的 user 消息——不要原样念给用户，提炼成自然的一句话。
- 不要朗读代码、不要朗读文件路径串。要提到代码就说"我让他写了一段代码，需要看吗？"
- 听不懂、信息不够 → 直接问用户，别瞎猜。

You are the voice host of a live video meeting; your partners are one or more worker agents that do the actual coding through delegated tasks. Stay short, conversational, never read code aloud, always delegate. For multiple independent asks call plan_meeting once with a DAG; for a single ask, delegate_task.`;

// Appended to the Claude Code preset for every Worker session.
const WORKER_PROMPT = `你是 vibe-meet 视频会议里的"执行 agent"。可能有多位同事 worker 同时在场（都在同一个项目下工作）。
搭档是面向用户的 talker；用户在跟 talker 语音对话，talker 通过 delegate_task / plan_meeting 把任务派给你；
你完成后用 task_done({summary}) 报告完成（一两句话总结），talker 会转述给用户（用户在听，不在看）。

工作守则：
- **优先调度本地已安装的 subagent**（在 \`~/.claude/agents/\` 下），别事事自己干。常用映射：
  · 改完一段有份量的代码 → 调 \`code-reviewer\` 复核一遍
  · 新功能 / 修 bug → 用 \`tdd-guide\` 先驱动测试，再写实现
  · 跨文件、要架构判断 → 用 \`architect\` 或 \`code-architect\` 出蓝图
  · 构建/编译挂掉 → 对应语言的 \`*-build-resolver\`（rust-build-resolver、go-build-resolver、kotlin-build-resolver、build-error-resolver 等）
  · 触到安全敏感面（认证 / 支付 / SQL / 文件路径 / 加密） → \`security-reviewer\`
  · 语言专项审查 → 对应的 \`*-reviewer\`（rust-reviewer、python-reviewer、typescript-reviewer、go-reviewer、swift-reviewer、cpp-reviewer …）
  · 死代码 / 重复 / 重构清理 → \`refactor-cleaner\`
  · 跑 E2E → \`e2e-runner\`
  · 文档 / codemap → \`doc-updater\`
- **匹配场景就用 Skill**（在 \`~/.claude/skills/\` 下，已经全部加载）。常用：\`code-review\`、\`security-review\`、\`pr\` / \`review-pr\`、\`test-coverage\`、\`refactor-clean\`、\`verify\`、\`run\`、\`ecc-guide\`、\`feature-dev\`。
- 多个互相独立的子任务可以**并行 dispatch**：同一条消息里发多次 Agent 调用，让 subagent 们并发跑。
- 改动很小（typo、单行修复、纯查文件、纯读 stack）就别开 subagent，自己干完即可。
- **协作纪律**：你不是唯一在场的 worker——如果你接到的提示里说"已有其他 worker 在改 X 文件"，要么避开同一文件、要么先 Read 当前状态再改，别盲覆写。
- **任务完成要调 task_done({summary})**：一句话告诉编排器你做了什么，编排器才会释放依赖你的下一波 worker。**summary 短、不要贴代码、不要列文件路径串**——会被 TTS 念出来。

You are a doer in a live voice meeting; multiple workers may run in parallel on the same project. Prefer dispatching the user's installed subagents under \`~/.claude/agents/\` and skills under \`~/.claude/skills/\`. When done call task_done({summary}) so the orchestrator releases workers waiting on you. Keep summary to one short sentence — no code, no file dumps.`;

interface OrchestratorOpts {
  emit: (e: OrchestratorEvent) => void;
  cwd: string;
  autoApprove?: boolean;
  workerEnv?: NodeJS.ProcessEnv;
}

interface WorkerLiveStatus {
  lastAssistantText: string;
  currentTool: string | null;
  currentToolInput: string | null;
  lastUpdateTs: number;
  busy: boolean;
}

interface WorkerHandle {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  status: WorkerStatusKind;
  session: ClaudeSession | null;
  summary: string;
  live: WorkerLiveStatus;
  pendingDelegateAck: boolean;
  queuedAddenda: string[];
  bufferedUpdates: string[];
  flushTimer: NodeJS.Timeout | null;
}

interface RecentFileEdit {
  workerId: string;
  ts: number;
}

const FILE_COLLISION_WINDOW_MS = 30_000;
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function extractText(message: any): string {
  try {
    const content = message?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join(' ')
        .trim();
    }
  } catch { /* ignore */ }
  return '';
}

function extractToolUses(message: any): Array<{ name: string; input: any }> {
  const out: Array<{ name: string; input: any }> = [];
  try {
    const content = message?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') out.push({ name: b.name, input: b.input });
      }
    }
  } catch { /* ignore */ }
  return out;
}

function summariseToolInput(_name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const keys = ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'description'];
  for (const k of keys) {
    if (typeof input[k] === 'string' && input[k].length > 0) {
      const v = String(input[k]);
      return v.length > 80 ? `${v.slice(0, 77)}…` : v;
    }
  }
  return '';
}

function extractFilePath(input: any): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[k] === 'string' && input[k].length > 0) return input[k];
  }
  return null;
}

// Per-session cap on save_memory tool calls. Prevents a runaway agent from
// flooding memory.json mid-meeting; the end-of-meeting recap is a separate
// path that runs once and is bounded by the recap prompt itself.
const SAVE_MEMORY_PER_SESSION_LIMIT = 20;
const MEMORY_TOKEN_BUDGET = 800;
const RECAP_TRANSCRIPT_CHAR_CAP = 12_000;
const RECAP_MIN_TRANSCRIPT_ENTRIES = 4;
// Sliding-window cap on the in-memory talker transcript. Long meetings would
// otherwise accumulate every turn forever, growing the array and the per-recap
// serialization cost (B5). 200 turns ≈ 100 user + 100 assistant which is well
// above any normal recap horizon — older context lives in memory.json anyway.
const TALKER_TRANSCRIPT_MAX_ENTRIES = 200;

interface TalkerTurn {
  role: 'user' | 'assistant';
  text: string;
}

const RECAP_PROMPT = `你是会议复盘助手。下面是一次工作会议的逐字记录。提取值得长期记住的信息(下次开会还有用),分成 4 类:
- point  关键讨论要点(业务上下文、洞察)
- decision  已经做出的决策
- todo  提到但未完成的待办
- fact  关于人/项目/系统的事实(路径、版本、偏好等)

严格输出 JSON 数组,每项形如 { "category": "point"|"decision"|"todo"|"fact", "content": "<=500字", "tags": ["可选标签"] }。
不要写任何解释、Markdown 代码块、前后缀。如果没有值得记的就输出 []。
排除:寒暄、临时澄清、tool 调试、AI 自我介绍、明显敏感信息(密钥/token)。`;

export class Orchestrator {
  private talker: ClaudeSession | null = null;
  private workers: Map<string, WorkerHandle> = new Map();
  private workerIdSeq = 0;
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private autoApprove: boolean;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private closed = false;
  private recentEdits: Map<string, RecentFileEdit> = new Map();
  private projectId: string;
  private meetingId: string;
  private saveMemoryCallsThisSession = 0;
  private talkerTranscript: TalkerTurn[] = [];
  // Active end-of-meeting recap query, if any. Tracked so `interrupt()` can
  // reach into a closed orchestrator and abort the recap pass (B4) — otherwise
  // the user pressing the interrupt button after `end()` was a no-op while
  // Haiku continued to chew through the transcript.
  private recapQuery: ReturnType<typeof query> | null = null;
  private recapAborted = false;

  constructor(opts: OrchestratorOpts) {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.autoApprove = opts.autoApprove ?? false;
    this.workerEnv = opts.workerEnv;
    this.projectId = computeProjectId(this.cwd);
    this.meetingId = randomUUID();
  }

  setAutoApprove(on: boolean) {
    this.autoApprove = on;
    this.talker?.setAutoApprove(on);
    for (const handle of this.workers.values()) {
      handle.session?.setAutoApprove(on);
    }
  }

  private safeEmit(e: OrchestratorEvent) {
    if (this.closed) return;
    this.emit(e);
  }

  async start(greeting?: string) {
    const meetingMcp = this.buildTalkerMcp();

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

    this.talker = new ClaudeSession({
      cwd: this.cwd,
      autoApprove: this.autoApprove,
      envOverride: this.workerEnv,
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

  sendUserImage(content: any[]) {
    this.talker?.sendUserContent(content);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    // Try every active session; only the one that issued the permission
    // request actually has a matching pending entry.
    this.talker?.resolvePermission(id, decision, message);
    for (const handle of this.workers.values()) {
      handle.session?.resolvePermission(id, decision, message);
    }
  }

  async interrupt() {
    const tasks: Promise<void>[] = [];
    if (this.talker) tasks.push(this.talker.interrupt());
    for (const handle of this.workers.values()) {
      if (handle.session) tasks.push(handle.session.interrupt());
    }
    // B4: abort end-of-meeting recap if it's mid-flight. Recap runs after
    // `end()` so an interrupt arriving here may be the only signal to stop.
    if (this.recapQuery) {
      this.recapAborted = true;
      const q = this.recapQuery;
      tasks.push(
        (async () => {
          try { await q.interrupt(); } catch { /* ignore */ }
        })(),
      );
    }
    await Promise.all(tasks);
  }

  /** Returns true if the post-meeting recap is still in flight. Main process
   *  checks this to decide whether to keep the orchestrator reference alive
   *  past `end()` so a follow-up interrupt can still reach it. */
  isRecapActive(): boolean {
    return this.recapQuery !== null;
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    const tasks: Promise<void>[] = [];
    if (this.talker) tasks.push(this.talker.setPermissionMode(mode));
    for (const handle of this.workers.values()) {
      if (handle.session) tasks.push(handle.session.setPermissionMode(mode));
    }
    await Promise.all(tasks);
  }

  end() {
    if (this.closed) return;

    // Snapshot the talker transcript and kick off a recap pass against Haiku
    // BEFORE we tear down. Fire-and-forget — leaving the meeting is instant
    // for the user; the recap calls appendEntry() (filesystem only) and never
    // touches the orchestrator instance after this point.
    const transcriptSnapshot = [...this.talkerTranscript];
    void this.runRecap(transcriptSnapshot).catch((err) => {
      console.warn('[memory] recap failed:', err);
    });

    // Flush any unfinished worker progress into one final talker line so the
    // user isn't left wondering what happened. Done BEFORE closing the gate.
    if (this.talker) {
      const finalLines: string[] = [];
      for (const handle of this.workers.values()) {
        if (handle.bufferedUpdates.length > 0) {
          finalLines.push(`[${handle.title}] ${handle.bufferedUpdates.join(' / ')}`);
        }
      }
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

    for (const handle of this.workers.values()) {
      if (handle.flushTimer) clearTimeout(handle.flushTimer);
      handle.flushTimer = null;
      handle.session?.end();
      handle.session = null;
    }
    this.workers.clear();
    this.talker?.end();
    this.talker = null;
  }

  /** Manual entry point: renderer-side "Plan meeting" button. */
  async installPlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }> {
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
      });
    }
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { ok: true };
  }

  // -------------------------------------------------------------------------

  private buildTalkerMcp() {
    return createSdkMcpServer({
      name: 'meeting',
      version: '0.2.0',
      tools: [
        tool(
          MEETING_TOOLS.DELEGATE,
          'Delegate a single task to a new worker agent. Use this whenever the user describes one thing they want built, fixed, refactored, or investigated. The worker spawns immediately and streams progress back to you.',
          { description: z.string().describe('Plain-language description of what the worker should do, in the user\'s words.') },
          async ({ description }) => {
            const id = this.nextWorkerId('task');
            const title = this.titleFromDescription(description);
            this.registerHandle({ id, title, prompt: description, deps: [] });
            this.emitPlanUpdate();
            this.spawnReadyWorkers();
            return { content: [{ type: 'text', text: `delegated as ${id}` }] };
          },
        ),
        tool(
          MEETING_TOOLS.PLAN_MEETING,
          'Decompose the user request into multiple independent (or dependency-ordered) tasks and spawn a worker for each. Use this whenever the user mentions more than one piece of work. Independent tasks run in parallel; tasks listing deps wait until their deps complete.',
          planMeetingArgsSchema,
          async ({ tasks }) => {
            const result = await this.installPlan(tasks as PlanMeetingTask[]);
            if (!result.ok) {
              return { content: [{ type: 'text', text: `error: ${result.error}` }] };
            }
            const spawned = tasks.filter((t) => (t.deps ?? []).length === 0).length;
            const queued = tasks.length - spawned;
            return {
              content: [{
                type: 'text',
                text: `plan installed: ${tasks.length} workers (${spawned} spawned now, ${queued} waiting on deps)`,
              }],
            };
          },
        ),
        tool(
          MEETING_TOOLS.UPDATE,
          'Interrupt all running workers and broadcast a course-correction. Use when the user changes their mind about the whole engagement or adds a constraint that applies to every active worker.',
          { addendum: z.string().describe('Additional or revised instructions for every active worker.') },
          async ({ addendum }) => {
            const ids = this.activeWorkerIds();
            for (const id of ids) {
              this.steerWorker(id, addendum);
            }
            return { content: [{ type: 'text', text: `broadcast to ${ids.length} worker(s)` }] };
          },
        ),
        tool(
          MEETING_TOOLS.DELEGATE_TO,
          'Steer ONE specific worker with a mid-flight addendum. Use when the user wants to refine just one of the running workers, not all of them.',
          delegateToArgsSchema,
          async ({ workerId, addendum }) => {
            if (!this.workers.has(workerId)) {
              return { content: [{ type: 'text', text: `unknown worker: ${workerId}` }] };
            }
            this.steerWorker(workerId, addendum);
            return { content: [{ type: 'text', text: `addendum sent to ${workerId}` }] };
          },
        ),
        tool(
          MEETING_TOOLS.STATUS,
          'Get current state of one worker (pass workerId) or all workers (no args). Returns busy flag, current tool, and last spoken thought per worker. Use when the user asks "what are you doing?" or you need a status update unprompted.',
          { workerId: z.string().optional().describe('Optional worker id to query; omit to get all.') },
          async ({ workerId }) => {
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
                const t = h.live.lastAssistantText.length > 200
                  ? `${h.live.lastAssistantText.slice(0, 200)}…`
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
            return { content: [{ type: 'text', text: lines.join('\n') || 'no workers' }] };
          },
        ),
        tool(
          'save_memory',
          'Persist a memorable item across meetings. Use for business context, decisions, user preferences, mentioned-but-undone TODOs, or facts about people/projects. Categories: point=key point, decision=resolved choice, todo=outstanding action, fact=factual info worth remembering.',
          {
            category: z.enum(['point', 'decision', 'todo', 'fact']),
            content: z.string().min(1).max(500),
            tags: z.array(z.string()).max(10).default([]),
          },
          async (args) => {
            if (this.saveMemoryCallsThisSession >= SAVE_MEMORY_PER_SESSION_LIMIT) {
              return {
                content: [{
                  type: 'text',
                  text: `rate limit reached (${SAVE_MEMORY_PER_SESSION_LIMIT}/session)`,
                }],
              };
            }
            this.saveMemoryCallsThisSession += 1;
            const r = await appendEntry({
              category: args.category,
              content: args.content,
              tags: args.tags,
              projectId: this.projectId,
              sourceMeetingId: this.meetingId,
            });
            if (!r.ok) {
              return { content: [{ type: 'text', text: `save_memory rejected: ${r.error}` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `saved ${args.category}: ${args.content.slice(0, 40)}`,
              }],
            };
          },
        ),
        tool(
          MEETING_TOOLS.NARRATE,
          'Speak directly to the user with a short conversational line. Use sparingly — only for unprompted progress updates ("改好了，要看看吗？"). The user already hears your normal assistant replies; this is for proactive nudges.',
          { text: z.string().describe('One or two sentences to say to the user.') },
          async ({ text }) => {
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
            return { content: [{ type: 'text', text: 'spoken' }] };
          },
        ),
      ],
    });
  }

  private buildWorkerMcp(workerId: string) {
    return createSdkMcpServer({
      name: 'meeting-worker',
      version: '0.2.0',
      tools: [
        tool(
          MEETING_TOOLS.TASK_DONE,
          'Signal that your assigned task is complete. Pass a one-line summary of what changed (no code, no file path dumps). The orchestrator releases any workers waiting on you.',
          taskDoneArgsSchema,
          async ({ summary }) => {
            this.markTaskDone(workerId, summary);
            return { content: [{ type: 'text', text: 'recorded' }] };
          },
        ),
        tool(
          'save_memory',
          'Persist a memorable item across meetings. Use for business context, decisions, user preferences, mentioned-but-undone TODOs, or facts about people/projects. Categories: point=key point, decision=resolved choice, todo=outstanding action, fact=factual info worth remembering.',
          {
            category: z.enum(['point', 'decision', 'todo', 'fact']),
            content: z.string().min(1).max(500),
            tags: z.array(z.string()).max(10).default([]),
          },
          async (args) => {
            if (this.saveMemoryCallsThisSession >= SAVE_MEMORY_PER_SESSION_LIMIT) {
              return {
                content: [{
                  type: 'text',
                  text: `rate limit reached (${SAVE_MEMORY_PER_SESSION_LIMIT}/session)`,
                }],
              };
            }
            this.saveMemoryCallsThisSession += 1;
            const r = await appendEntry({
              category: args.category,
              content: args.content,
              tags: args.tags,
              projectId: this.projectId,
              sourceMeetingId: this.meetingId,
            });
            if (!r.ok) {
              return { content: [{ type: 'text', text: `save_memory rejected: ${r.error}` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `saved ${args.category}: ${args.content.slice(0, 40)}`,
              }],
            };
          },
        ),
      ],
    });
  }

  private registerHandle(spec: { id: string; title: string; prompt: string; deps: string[] }) {
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
    };
    this.workers.set(spec.id, handle);
  }

  private spawnReadyWorkers() {
    for (const handle of this.workers.values()) {
      if (handle.status !== 'pending') continue;
      const allDepsDone = handle.deps.every((d) => this.workers.get(d)?.status === 'done');
      if (allDepsDone) this.spawnWorker(handle);
    }
  }

  private spawnWorker(handle: WorkerHandle) {
    const workerMcp = this.buildWorkerMcp(handle.id);
    handle.session = new ClaudeSession({
      cwd: this.cwd,
      autoApprove: this.autoApprove,
      envOverride: this.workerEnv,
      emit: (e) => this.onWorkerEvent(handle.id, e),
      sessionOptions: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: WORKER_PROMPT },
        mcpServers: { 'meeting-worker': workerMcp },
      },
    });
    handle.status = 'running';
    handle.pendingDelegateAck = true;
    handle.queuedAddenda = [];
    handle.live.busy = true;
    handle.live.lastUpdateTs = Date.now();
    handle.session.start();

    // Build the first prompt, mentioning peer workers for collaboration discipline.
    const peers = Array.from(this.workers.values()).filter(
      (h) => h.id !== handle.id && (h.status === 'running' || h.status === 'pending'),
    );
    const peerLine = peers.length > 0
      ? `\n\n（同事 worker 也在跑：${peers.map((p) => `${p.id}「${p.title}」`).join('、')}。注意可能改到同一份代码。）`
      : '';
    handle.session.sendUserText(handle.prompt + peerLine);

    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'worker-spawned',
        workerId: handle.id,
        title: handle.title,
        deps: handle.deps,
      },
    });
    this.emitPlanUpdate();
  }

  private steerWorker(workerId: string, addendum: string) {
    const handle = this.workers.get(workerId);
    if (!handle || !handle.session) return;
    if (handle.pendingDelegateAck) {
      handle.queuedAddenda.push(addendum);
      return;
    }
    void (async () => {
      try {
        await handle.session?.interrupt();
      } catch (err) {
        console.error(`[orchestrator] worker.interrupt() failed steering ${workerId}:`, err);
      }
      handle.session?.sendUserText(`(plan update) ${addendum}`);
    })();
    handle.live.busy = true;
    handle.live.lastUpdateTs = Date.now();
  }

  private markTaskDone(workerId: string, summary: string) {
    const handle = this.workers.get(workerId);
    if (!handle) return;
    handle.status = 'done';
    handle.summary = summary;
    handle.live.busy = false;
    // Inform the talker so the user hears a clean completion line.
    if (this.talker) {
      const condensed = summary.length > 180 ? `${summary.slice(0, 178)}…` : summary;
      this.talker.sendUserText(`(worker ${workerId} done) ${condensed}`);
    }
    this.safeEmit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId, status: 'done', summary },
    });
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
  }

  private activeWorkerIds(): string[] {
    const out: string[] = [];
    for (const handle of this.workers.values()) {
      if (handle.status === 'running') out.push(handle.id);
    }
    return out;
  }

  private emitPlanUpdate() {
    const nodes: MeetingPlanNode[] = Array.from(this.workers.values()).map((h) => ({
      id: h.id,
      title: h.title,
      status: h.status,
      deps: h.deps,
    }));
    const plan: MeetingPlan = { nodes };
    this.safeEmit({ source: 'talker', event: { kind: 'plan-updated', plan } });
  }

  private nextWorkerId(prefix: string): string {
    this.workerIdSeq += 1;
    return `${prefix}-${this.workerIdSeq}`;
  }

  private titleFromDescription(desc: string): string {
    const single = desc.replace(/\s+/g, ' ').trim();
    return single.length > 48 ? `${single.slice(0, 46)}…` : single;
  }

  // -------------------------------------------------------------------------

  private onTalkerEvent(e: SessionEvent) {
    this.safeEmit({ source: 'talker', event: e });
    // Capture talker turns into a private transcript so end-of-meeting recap
    // has something to feed Haiku. We grab user + assistant text only, never
    // tool-use blobs (those are noisy and recap should focus on conversation).
    if (e.kind === 'message') {
      const msg: any = e.message;
      const t = msg?.type;
      if (t === 'assistant') {
        const text = extractText(msg);
        if (text) this.talkerTranscript.push({ role: 'assistant', text });
      } else if (t === 'user') {
        const text = extractText(msg);
        if (text) this.talkerTranscript.push({ role: 'user', text });
      }
    }
  }

  // Best-effort end-of-meeting recap. Sends the talker transcript to a Haiku
  // session with no tools / no MCP servers and asks for a JSON array of
  // memorable items. Each parsed item runs through the same secret-filter and
  // length-cap as the live save_memory tool path, so anything sensitive is
  // dropped on the way to disk. Errors here MUST NOT throw — leaving the
  // meeting should never block on this.
  private async runRecap(transcript: TalkerTurn[]): Promise<void> {
    if (transcript.length < RECAP_MIN_TRANSCRIPT_ENTRIES) return;

    // Stitch the transcript into a single user message, capping the tail so
    // we stay well under Haiku's context window.
    const joined = transcript
      .map((t) => `${t.role === 'user' ? '用户' : '助手'}: ${t.text}`)
      .join('\n');
    const trimmed =
      joined.length > RECAP_TRANSCRIPT_CHAR_CAP
        ? joined.slice(joined.length - RECAP_TRANSCRIPT_CHAR_CAP)
        : joined;

    let responseText = '';
    try {
      const env = this.workerEnv ?? mergedSubprocessEnv();
      const q = query({
        prompt: (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: trimmed },
            parent_tool_use_id: null,
          };
        })(),
        options: {
          cwd: this.cwd,
          model: 'claude-haiku-4-5',
          systemPrompt: RECAP_PROMPT,
          tools: [],
          mcpServers: {},
          skills: [],
          settingSources: [],
          permissionMode: 'default',
          includePartialMessages: false,
          env,
        },
      });
      this.recapQuery = q;
      try {
        for await (const msg of q) {
          if (this.recapAborted) break;
          const m: any = msg;
          if (m?.type === 'assistant') {
            const text = extractText(m);
            if (text) responseText += `${text}\n`;
          }
        }
      } finally {
        try { q.interrupt().catch(() => { /* ignore */ }); } catch { /* ignore */ }
        this.recapQuery = null;
      }
    } catch (err) {
      console.warn('[memory] recap query failed:', err);
      this.recapQuery = null;
      return;
    }
    // Bail out cleanly if the user pressed interrupt mid-stream — don't
    // persist a half-formed JSON response.
    if (this.recapAborted) return;

    // Locate the JSON array in the response. Haiku usually obeys "no
    // markdown" but defensive parsing here is cheap insurance.
    const start = responseText.indexOf('[');
    const end = responseText.lastIndexOf(']');
    if (start < 0 || end <= start) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText.slice(start, end + 1));
    } catch (err) {
      console.warn('[memory] recap JSON parse failed:', err);
      return;
    }
    if (!Array.isArray(parsed)) return;

    let saved = 0;
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const category = r.category;
      const content = r.content;
      const tags = Array.isArray(r.tags)
        ? (r.tags as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (
        typeof category !== 'string' ||
        !['point', 'decision', 'todo', 'fact'].includes(category) ||
        typeof content !== 'string' ||
        content.trim().length === 0
      ) {
        continue;
      }
      const result = await appendEntry({
        category: category as 'point' | 'decision' | 'todo' | 'fact',
        content,
        tags,
        projectId: this.projectId,
        sourceMeetingId: this.meetingId,
      });
      if (result.ok) saved += 1;
    }
    console.log(`[memory] recap saved ${saved} entries from meeting ${this.meetingId}`);
  }

  private onWorkerEvent(workerId: string, e: SessionEvent) {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    this.safeEmit({ source: workerId, event: e });

    if (e.kind === 'message') {
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
          this.queueWorkerUpdate(handle, `[${handle.id}] thought: ${this.condense(text, 140)}`);
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
          const hasResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
          if (hasResult && handle.live.currentTool) {
            this.queueWorkerUpdate(handle, `[${handle.id}] finished ${handle.live.currentTool}`);
            handle.live.currentTool = null;
            handle.live.currentToolInput = null;
          }
        } catch { /* ignore */ }
      } else if (msg?.type === 'result') {
        handle.live.busy = false;
        // If the worker ended a turn WITHOUT calling task_done, we don't mark
        // the node done — that's intentional, it might still be mid-task. But
        // we do queue a turn-complete note.
        this.queueWorkerUpdate(handle, `[${handle.id}] turn complete`);
      }
    } else if (e.kind === 'ended') {
      handle.live.busy = false;
      handle.pendingDelegateAck = false;
      handle.queuedAddenda = [];
      // If the session ended without task_done, mark the handle as failed so
      // dependent workers don't wait forever.
      if (handle.status === 'running') {
        handle.status = 'failed';
        this.safeEmit({
          source: 'talker',
          event: { kind: 'worker-ended', workerId, status: 'failed' },
        });
        this.emitPlanUpdate();
        // Mark all transitive dependents as failed too — they can't run.
        this.cascadeFailure(workerId);
      }
    }
  }

  private cascadeFailure(rootId: string) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const handle of this.workers.values()) {
        if (handle.status !== 'pending') continue;
        if (handle.deps.some((d) => this.workers.get(d)?.status === 'failed')) {
          handle.status = 'failed';
          changed = true;
          this.safeEmit({
            source: 'talker',
            event: { kind: 'worker-ended', workerId: handle.id, status: 'failed' },
          });
        }
      }
    }
    if (this.talker) {
      this.talker.sendUserText(`(worker ${rootId} ended without task_done — downstream tasks marked failed)`);
    }
    this.emitPlanUpdate();
  }

  private flushQueuedAddenda(handle: WorkerHandle) {
    const batch = handle.queuedAddenda;
    handle.queuedAddenda = [];
    if (batch.length === 0 || !handle.session) return;
    void (async () => {
      try {
        await handle.session?.interrupt();
      } catch (err) {
        console.error(`[orchestrator] worker.interrupt() failed flushing addenda for ${handle.id}:`, err);
      }
      handle.session?.sendUserText(`(plan update) ${batch.join('\n')}`);
    })();
  }

  private condense(text: string, max: number): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
  }

  // Coalesce a burst of per-worker events into ONE injected user message to
  // Talker so we don't flood its context.
  private queueWorkerUpdate(handle: WorkerHandle, line: string) {
    handle.bufferedUpdates.push(line);
    if (handle.bufferedUpdates.length > 8) {
      handle.bufferedUpdates.splice(0, handle.bufferedUpdates.length - 8);
    }
    if (handle.flushTimer) return;
    handle.flushTimer = setTimeout(() => {
      handle.flushTimer = null;
      if (this.closed) return;
      const batch = handle.bufferedUpdates;
      handle.bufferedUpdates = [];
      if (batch.length === 0 || !this.talker) return;
      const text = `(worker ${handle.id} update)\n${batch.join('\n')}`;
      this.talker.sendUserText(text);
    }, 1200);
  }

  private recordFileEdit(workerId: string, path: string) {
    const now = Date.now();
    // Sweep expired entries cheaply.
    for (const [key, entry] of this.recentEdits) {
      if (now - entry.ts > FILE_COLLISION_WINDOW_MS) this.recentEdits.delete(key);
    }
    const prior = this.recentEdits.get(path);
    if (prior && prior.workerId !== workerId && (now - prior.ts) < FILE_COLLISION_WINDOW_MS) {
      // Collision — narrate to talker so it can warn the user.
      if (this.talker) {
        this.talker.sendUserText(
          `(file collision) worker ${workerId} and worker ${prior.workerId} both touched ${path} within ${Math.round((now - prior.ts) / 1000)}s. 提醒用户可能有冲突。`,
        );
      }
    }
    this.recentEdits.set(path, { workerId, ts: now });
  }
}
