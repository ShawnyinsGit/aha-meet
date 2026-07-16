# Qoder Agent 化方案与 AhaMeet Harness 优化研究

日期：2026-07-16  
范围：Qoder Quest / Experts / CLI / Agent SDK / Cloud Agents / Repo Wiki / Context Engineering，以及 AhaMeet 面向“与 Agent 开会并交付代码项目与 work”的 Harness 设计。

## 0. 证据边界

- 主线程已通过微信文章的公开 HTML 正文读取用户提供的文章：[《国内 AI 编程市场第一份成绩单出炉！近 50% 营收流向阿里，Qoder 做对了什么？》](https://mp.weixin.qq.com/s/XmtXg88xceD-7RO0oUQphA)。文章属于媒体商业分析，不是产品协议或独立技术评测；本文只吸收其可验证的产品设计线索，不以市场份额、用户量或厂商效果数字作为架构依据。
- 文章与 Harness 直接相关的线索包括：Quest 将任务管理、状态追踪、产物审查和知识调用放进统一工作台；跨项目多任务并行；CLI / Mobile / Cloud Agent 扩展执行入口；QoderWake 强调岗位职责、长期记忆和任务边界；最终目标从单点补全转向需求理解、实现、测试和持续交付闭环。下文用 Qoder 官方文档逐项核验这些产品事实。
- 产品和协议事实以 Qoder 官方文档、官方博客和官方 npm 包为准。
- Qoder 官方博客中的效果数字均来自 Qoder 自有基准，不等于独立第三方评测；本文只用它们解释其设计取向，不据此承诺 AhaMeet 的效果。
- 以下建议包含基于官方能力与当前 AhaMeet 代码的工程推论，推论均明确标识为“建议”或“判断”。

## 1. 执行结论

AhaMeet 不应把目标定义为“把多个 CLI 塞进一个聊天室”，而应定义为：

> 一个以 Meeting 为人机对齐界面、以 Delivery Run 为执行单元、以可验证产物为结束条件的多 Backend 工程交付控制平面。

对 Qoder 的最优接法不是继续模拟终端，而是分两层：

1. **近期：改成官方 Qoder Agent SDK adapter。** 使用 `query()`、异步事件流、多轮 Session、`interrupt()` / `close()`、权限回调、checkpoint、subagent 和稳定的认证接口，移除猜测式 CLI 协议。
2. **中期：增加 Qoder Cloud Agents adapter（可选）。** 将云端 Session、SSE、`Last-Event-ID` 恢复、Webhook、GitHub Repository Resource 和 Managed Agents 作为远程执行能力，而不是取代 AhaMeet 的会议级 Scheduler。

最重要的边界是：

- **AhaMeet Coordinator** 持有用户意图、全局 Plan、跨 Backend DAG、预算、权限和最终验收权。
- **Qoder Agent / Experts** 是一个任务执行 Backend。默认只接收边界清晰的 Work Order，并返回 Work Report。
- 只有当一个子任务内部高度耦合、适合 Qoder 自己分解时，才把它作为一个“复合 Worker”交给 Qoder Experts；AhaMeet 不应同时微管理其内部每个子 Agent。

否则会出现两个 Leader、两个 DAG、两套重试和两套上下文源，状态不可解释，接管也无法原子化。

## 2. Qoder 的 Agent 化能力：官方事实

### 2.1 Quest：从对话转为委派与交付

Qoder 将 Quest 定义为独立的 agent-first 工作区：支持任务状态、进度、产物审查、多任务并行以及 Agent / Experts 两种执行模式。Agent Mode 面向单 Agent 端到端交付，Experts Mode 面向多 Agent 协作。Quest 的结果区包含 Spec、变更摘要、Diff、逐文件拒绝、Commit、Push 和 PR，而不是只展示聊天消息。[Qoder Quest Overview](https://docs.qoder.com/user-guide/quest/overview)

Qoder 对长任务采用“Spec First → Action Flow → Task Report”结构：先形成可编辑 Spec，再异步执行，遇到歧义进入 Action Required，最后给出任务概览、验证步骤和变更清单。[Quest Mode: Task Delegation to Agents](https://qoder.com/en/blog/quest-mode)

对 AhaMeet 的启示不是复制 Quest UI，而是把以下对象升级为一等实体：`Spec`、`Run`、`ActionRequired`、`Evidence`、`ChangeSet`、`Review`、`Delivery`。

### 2.2 Experts：单中枢、角色分工、异步回报

Qoder 官方披露的 Experts 架构与 AhaMeet 已选择的“单 Coordinator + 多专家 Host”高度一致：

- Leader 负责拆解、调度、进度与汇总，不亲自实现；
- 子任务可声明依赖，组成轻量 DAG；
- 独立专家默认异步并行；
- 专家之间不直接点对点协商，所有信息经 Leader 中枢流转；
- 专家完成后通过 callback 进入 Leader mailbox，由 Leader 在下一轮决策；
- 内置角色围绕 research、coding、QA / verification、review、browser 等工程环节组织，而非按“同一个通用 Agent 复制 N 份”组织。[Inside Experts Mode](https://qoder.com/blog/experts-mode-tech)

这验证了 AhaMeet 当前拓扑的方向，但还需补上三个工程约束：

1. Coordinator 的职责必须在运行时强制为“决策与编排”，不能只靠提示词约束其不写代码。
2. Expert 不能直接修改同一工作区；代码 Worker 使用独立 worktree，结果经显式集成阶段合入。
3. 专家回报不能只是自然语言；必须符合统一的 `WorkReport` schema，并带验证证据和产物引用。

### 2.3 Qoder CLI：已经具备 headless、会话和 worktree 能力

官方 CLI 支持：

- `-p` / `--print` 非交互运行与 `text/json/stream-json` 输出；
- `-w` 指定 workspace，`-r` 恢复指定 Session，`-c` 延续最近 Session；
- tool allow / deny、最大 turn、独立 `--worktree`；
- `AGENTS.md`、项目/用户 memory、`/compact`、`/review`、`/quest` 和 subagent。[Qoder CLI Usage](https://docs.qoder.com/en/cli/using-cli)

官方登录流程是启动 `qodercli` 后执行 `/login`，或通过 `QODER_PERSONAL_ACCESS_TOKEN` 做自动化认证；官方安装方式是安装脚本并以 `qodercli --version` 验证。[Qoder CLI Quick Start](https://docs.qoder.com/en/cli/quick-start)

因此，不应再靠“找到 binary 即视为已登录”，也不应假设存在 `qoder auth login` 这样的命令。

### 2.4 Agent SDK：AhaMeet 最合适的本地接入面

官方 TypeScript SDK `@qoder-ai/qoder-agent-sdk` 的主入口是 `query()`。它启动并管理 qodercli，将 Agent 消息以 AsyncGenerator 返回，并允许宿主应用配置 cwd、工具、权限、MCP、Hooks 和交互式 Session。[Qoder Agent SDK Quick Start](https://docs.qoder.com/en/cli/sdk/quick-start) [npm package](https://www.npmjs.com/package/%40qoder-ai/qoder-agent-sdk)

与 AhaMeet 直接相关的能力包括：

- 多轮 Session；`interrupt()` 只停止当前 turn，`close()` 结束整个 Session；[Multi-turn Conversation](https://docs.qoder.com/en/cli/sdk/multi-turn-conversation)
- 主动指定 Session ID、resume、continue、fork，并可用独立 `QODER_CONFIG_DIR` 隔离 Backend 数据；[Session Control](https://docs.qoder.com/en/cli/sdk/session-control)
- `includePartialMessages` 输出文本、thinking marker 和 tool 参数的增量事件；[Streaming Output](https://docs.qoder.com/en/cli/sdk/streaming-output)
- `canUseTool` 把工具审批交给宿主 UI，并支持 `plan`、`default`、`acceptEdits`、`dontAsk` 等权限模式、工具 allow / deny；[Permission Control](https://docs.qoder.com/en/cli/sdk/permissions)
- 文件 checkpoint 和按用户消息 rewind；[File Checkpoint and Rewind](https://docs.qoder.com/en/cli/sdk/checkpoint)
- 运行时注入具备独立 prompt、model、tools、permissions、MCP、skills、maxTurns 的 subagent；subagent 上下文隔离，主 Agent 只接收最终回报。[SDK Reference](https://docs.qoder.com/en/cli/sdk/references)

截至研究时，npm 显示最新版本为 `1.0.14`；AhaMeet 当前锁定 `^1.0.11`。版本变化很快，发布包应锁定精确版本并执行协议契约测试，不应仅追随 semver range 自动升级。[npm package](https://www.npmjs.com/package/%40qoder-ai/qoder-agent-sdk)

### 2.5 Cloud Agents：适合异步、恢复和 API 集成

Qoder Cloud Agents 提供 Agent、Environment、Session、Event 四类核心对象。Session 运行在隔离容器中，宿主经 API 发消息，并通过 SSE 获取状态、消息和工具事件；官方将它定位于长任务、API 集成、批处理和定时任务。[Cloud Agents Overview](https://docs.qoder.com/cloud-agents/overview.md)

与 AhaMeet 的恢复模型尤其契合：

- Session 有 `idle/running/rescheduling/terminated` 状态机；cancel 只中止当前 turn，之后回到 idle 并可继续；
- running 状态继续发送用户消息会返回 409，因此 AhaMeet 必须排队或先 cancel；
- SSE 支持 `Last-Event-ID` 断线续传；`session.status_idle` 表示当前 turn 完成，连接应保持；
- GitHub repository 可作为 Session Resource 挂载，Agent 可在容器中修改、提交、推送并创建 PR；
- Webhook 是至少一次投递，AhaMeet 必须按 event ID 幂等消费。[Cloud Sessions](https://docs.qoder.com/cloud-agents/sessions.md) [Session Event Stream](https://docs.qoder.com/cloud-agents/events-stream.md) [GitHub Repositories](https://docs.qoder.com/cloud-agents/github-repositories.md) [Webhooks](https://docs.qoder.com/cloud-agents/webhooks.md)

Cloud Managed Agents 又提供 coordinator thread、child thread、mailbox、异步 `create_agent`、同步 `Agent`、`send_to_agent` 和 `send_to_parent`，单 Session 内的线程分别保有 Agent snapshot、历史和执行上下文。[Managed Agents](https://docs.qoder.com/cloud-agents/managed-agents.md)

**判断：** Cloud Managed Agents 可以作为 Qoder Backend 内部实现，但不应直接成为 AhaMeet 全局 Coordinator。AhaMeet 还要协调 Codex、Claude、Kimi、Qoder、本地文件、会议权限与用户接管，这些不属于单一 Qoder Session 的权威边界。

### 2.6 Repo Wiki、Rules 与知识引擎

Repo Wiki 根据代码生成结构化架构与实现文档，保存在 `.qoder/repowiki`，可提交共享，并随代码变化提示更新。Qoder 官方称其生成过程包含代码索引与多 Agent 分析。[Repo Wiki](https://qoder.com/blog/repo-wiki-surfacing-implicit-knowledge)

Qoder 还支持：

- 增量代码索引，默认尊重 `.gitignore` 与 `.qoderignore`；[Indexing](https://docs.qoder.com/user-guide/indexing)
- `.qoder/rules` 以及 `AGENTS.md` 兼容；规则可 always-on、manual、model-decision 或 file-scoped；[Rules](https://docs.qoder.com/user-guide/rules)
- Knowledge Card 将架构、代码规范、技术栈压缩为高密度知识单元，并随 commit 更新；[Knowledge Cards](https://docs.qoder.com/user-guide/knowledge-engine/knowledge-cards)
- 对长会话做有损 compact，或在切换任务时开启新会话。[Context Compression](https://docs.qoder.com/user-guide/chat/smart-context-control)

Qoder 官方对 Harness Engineering 的描述涵盖环境设计、意图规范、反馈循环、可观测性、架构约束和上下文工程；其知识引擎组合 Commit Graph、Repo Wiki、Memory、Code Chunk、Code Graph，并强调从完成任务和新 commit 中持续更新知识。[Engineering Knowledge Engine](https://qoder.com/blog/engineering-knowledge-engine)

**对 AhaMeet 的关键取舍：** Qoder 的索引和 Repo Wiki 是 Backend 加速器，不应成为跨 Backend 唯一事实源。AhaMeet 的长期事实应落在 provider-neutral、可版本控制的 `AGENTS.md`、ADR、Spec、验收记录和 Delivery Report；Qoder、Codex、Claude 都从这套事实源构造各自最小上下文。

## 3. 当前 AhaMeet Qoder adapter 的确定性问题

审计文件：`electron/backends/qoder-adapter.ts`、`package.json`、本地已安装 SDK export。

### P0-1：声明使用 SDK，实际完全没有使用

代码定义了 `loadQoderSdk()` 和一个假想的 `QoderAgent.run()` 接口，但 `createSession()` 始终返回 `QoderSubprocessSession`，`loadQoderSdk()` 没有调用点。官方 SDK 实际导出的是 `query()`、`qodercliAuth()`、`accessTokenFromEnv()` 等，不导出 `QoderAgent`。

影响：当前实现无法获得 SDK 的 Session、权限回调、checkpoint、结构化消息、subagent、Hooks 和关闭语义；代码注释与实际能力相反。

### P0-2：CLI 参数与官方协议不一致

当前 adapter 使用 `--cwd`，官方参数是 `-w`；它把启动参数称为“best-effort based on common CLI patterns”。这类猜测不能作为 Backend 协议。CLI 版本更新后也没有契约测试。

影响：启动即失败、cwd 未生效或行为随版本漂移；上层只能收到不透明的进程退出。

### P0-3：认证探测是假阳性

`checkAuthStatus()` 只要找到 binary 就返回 `loggedIn: true`；`loginOAuth()` 调用官方文档未定义的 `auth login`。官方流程是 TUI `/login` 或 `QODER_PERSONAL_ACCESS_TOKEN`。

影响：UI 会把“已安装”误显示为“已登录”，实际首轮任务才暴露 401 / auth error；与此前 Codex、Kimi 的安装/认证状态混淆属于同一类状态建模缺陷。

### P0-4：能力声明与真实能力相反

当前 `QODER_CAPABILITIES` 将 `permissions`、`skills` 标记为 false，但官方 SDK 明确支持权限回调、Skills、MCP、Hooks、subagent、checkpoint 和多轮会话。

影响：Scheduler 无法基于真实能力选择 Backend；Qoder 被降级为只能收发文本的哑进程。

### P0-5：打包运行时没有形成可验证闭环

项目依赖 `@qoder-ai/qoder-agent-sdk`，但当前工作区 SDK 主目录没有可执行的 bundled qodercli，下载后的大文件出现在 `node_modules/.ignored/.../dist/_bundled/qodercli`；同时 Finder 启动的 Electron 不继承用户 shell PATH。这与此前 Codex 的 ASAR / executable path 问题属于同一风险族。

影响：开发 shell 能运行不代表 DMG 能运行。发布前必须验证 `Resources/app.asar.unpacked` 中的 runtime、执行权限、CPU 架构、版本和 SDK 实际选择的路径。

### P1：错误与生命周期仍按“进程文本”建模

当前 parser 只识别少量猜测式 JSON shape，无法稳定区分：认证失效、权限等待、工具执行、API retry、context compact、task progress、正常 idle、turn interrupt、session closed。官方 SDK 的 `SDKMessage` 已提供这些结构化类型。

## 4. 推荐的目标 Harness

```text
Meeting（人机对齐与治理）
  ├─ CoordinatorController（唯一全局决策者）
  ├─ DeliveryPlan / Task DAG（唯一全局计划）
  ├─ ContextBroker（事实、附件、角色上下文）
  ├─ PermissionBroker（工具权限，独立于自动编排）
  ├─ MeetingScheduler（预算、并发、依赖、接管）
  ├─ Evidence & Quality Gates（验证、评审、验收）
  └─ Backend Runtime
       ├─ Claude adapter
       ├─ Codex adapter
       ├─ Kimi adapter
       └─ Qoder adapter
            ├─ Local SDK profile（默认）
            ├─ Local Experts profile（复合 Worker，可选）
            └─ Cloud Session profile（异步远程，可选）
```

### 4.1 Meeting 不是执行上下文，Delivery Run 才是

一次会议可产生零到多个 `DeliveryRun`。聊天消息只表达意图，不直接等于可执行任务。

```ts
interface DeliveryRun {
  id: string;
  meetingId: string;
  specRevision: string;
  sourceRevision: string;
  status:
    | 'aligning' | 'awaiting-plan-approval' | 'queued'
    | 'running' | 'action-required' | 'verifying'
    | 'reviewing' | 'ready-to-integrate' | 'delivered'
    | 'interrupted' | 'failed' | 'cancelled';
  tasks: DeliveryTask[];
  evidence: EvidenceRef[];
  changeSets: ChangeSetRef[];
  report?: DeliveryReport;
}
```

这样“Host 说完了”“turn idle”“Worker 退出”“Meeting 结束”“代码已交付”不再混为一个 `ended`。

### 4.2 Work Order：把口头安排变成执行合同

Coordinator 发给任意 Backend 的任务都应符合相同 schema：

```ts
interface WorkOrder {
  taskId: string;
  goal: string;
  nonGoals: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  inputs: ContextManifest;
  sourceRevision: string;
  workspace: { type: 'worktree' | 'shared-locked' | 'readonly'; path: string };
  allowedWriteScopes: string[];
  toolPolicyId: string;
  dependencyOutputs: ArtifactRef[];
  budget: { maxTurns?: number; maxCost?: number; deadline?: string };
  requiredEvidence: EvidenceRequirement[];
}
```

Qoder 的 Spec-first 经验说明：复杂任务最先需要收敛的不是 prompt，而是需求、边界与验收标准。AhaMeet 应在普通模式要求用户确认 Spec/Plan；自动编排模式可自动进入执行，但高风险工具仍由 PermissionBroker 单独判定。

### 4.3 Work Report：结果必须可机器验收

```ts
interface WorkReport {
  taskId: string;
  outcome: 'completed' | 'partial' | 'blocked' | 'failed';
  summary: string;
  changes: Array<{ path: string; purpose: string }>;
  commands: Array<{ command: string; exitCode: number; logRef: string }>;
  tests: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; evidenceRef?: string }>;
  acceptance: Array<{ criterionId: string; status: 'met' | 'not-met' | 'unknown'; evidenceRefs: string[] }>;
  risks: string[];
  unresolved: string[];
  artifacts: ArtifactRef[];
  suggestedNextActions: string[];
}
```

这应成为所有 Backend 的统一返回物。聊天区只显示摘要；完整证据进入共享区和 Delivery Review。

### 4.4 单 Coordinator 与 Qoder Experts 的边界

推荐两种 Qoder profile：

| Profile | 谁分解任务 | AhaMeet 可见粒度 | 适用场景 |
|---|---|---|---|
| `qoder-single`（默认） | AhaMeet Coordinator | 每个 DeliveryTask | 跨 Backend 协作、可控改动、明确模块任务 |
| `qoder-experts` | Qoder 内部 Leader | 一个复合 Task + 内部进度投影 | 同一代码域内的研究→实现→QA→Review 闭环 |

规则：

- 一个 Task 一旦选择 `qoder-experts`，AhaMeet 不再同时把其内部模块分给其他可写 Worker。
- Qoder 内部 child event 可投影为只读 `subtask-progress`，但 AhaMeet 的权威状态仍只有父 Task。
- 跨 Backend 依赖、预算暂停、用户接管、最终合并仍由 AhaMeet 管理。
- 第一阶段继续遵守既定决策：Qoder 仅担任 Expert / Worker，不进入 Coordinator 白名单。

### 4.5 工具与权限：从提示词要求升级为宿主强制

Qoder SDK 的 `canUseTool` 应直接接入 AhaMeet `PermissionBroker`：

```ts
const q = query({
  prompt: workOrderPrompt,
  options: {
    auth,
    cwd: worktreePath,
    tools: capabilityProfile.visibleTools,
    allowedTools: capabilityProfile.preApprovedTools,
    disallowedTools: capabilityProfile.deniedTools,
    permissionMode: 'default',
    enableFileCheckpointing: true,
    canUseTool: (toolName, input, meta) =>
      permissionBroker.decide({ taskId, backendId: 'qoder', toolName, input, meta }),
  },
});
```

必须保持：

- Plan 自动批准不等于 Bash / 网络 / Git push 自动批准；
- Expert 的工具集按角色最小化；研究、QA、Review 默认只读；
- 写权限同时受 SDK tool policy 和 worktree / path boundary 约束；
- `bypassPermissions` / `yolo` 不能由模型或 Coordinator 自行开启；
- secret 不进入 prompt、日志、附件或子 Agent context。

### 4.6 Qoder SDK adapter 的正确结构

移除当前 `QoderSubprocessSession` 主路径，改为 SDK typed adapter：

```ts
class QoderSdkSession implements BackendSession {
  private query: Query | null = null;
  private sessionId: string | null = null;

  async start(): Promise<BackendReady> {
    // capability + auth + runtime handshake；收到 SDK init 后才 ready
  }

  async sendUserContent(content: BackendContent[]): Promise<void> {
    // 写入 multi-message AsyncIterable；同一 session 串行 turn
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt(); // turn-level interrupt
  }

  async end(): Promise<void> {
    await this.query?.close(); // session-level close
  }
}
```

适配层需要把 SDK 事件映射成 provider-neutral 事件：

| Qoder SDK / Cloud event | AhaMeet event |
|---|---|
| init / session ID | `backend.session.ready` |
| assistant text delta | `agent.output.delta` |
| tool_use | `tool.requested` |
| permission callback | `permission.required` |
| task progress / subagent | `task.progress` / `subtask.progress` |
| API retry | `backend.retrying` |
| result success | `turn.completed` |
| interrupt | `turn.interrupted` |
| auth failure | `auth.required`（不可自动重试） |
| process transport close | `backend.disconnected`（不等于 Meeting ended） |

### 4.7 认证与 runtime readiness

Backend 设置页应拆成五个独立状态，不能再用“已安装/未配置”二值表示：

1. `installed`：能解析到 runtime；
2. `compatible`：版本、架构、协议符合 app lockfile；
3. `authenticated`：完成真实最小握手；
4. `ready`：能创建 Session 并收到 init；
5. `healthy`：近期 turn / transport 无持续错误。

Qoder 本地支持两种认证策略：

- `qodercliAuth()`：复用真实用户目录中的 CLI 登录；应用不得用 shadow HOME 覆盖它；
- `accessTokenFromEnv()`：PAT 存入系统安全存储，按 Session 注入，严禁写配置文件或日志。

登录按钮应打开官方 TUI `/login` 流程或引导 PAT；流程结束后必须重新执行 handshake，不能以终端窗口打开、安装命令退出 0 或 binary 存在作为成功条件。

发布包应执行：

- SDK 与 qodercli 精确版本 pin；
- runtime 置于 `app.asar.unpacked`，验证真实文件、`+x`、CPU 架构；
- 显式把 executable path 传给 SDK/transport，不依赖 Finder PATH；
- DMG 安装后的真实 `query('reply READY only')` smoke test；
- 401 / token revoked、runtime missing、协议不兼容、断线和进程崩溃的故障注入。

### 4.8 上下文：角色化最小包，而不是同步整场聊天

建议将上下文拆为五层：

| 层 | 内容 | 权威来源 | 注入策略 |
|---|---|---|---|
| Project Facts | 构建命令、模块边界、约束 | `AGENTS.md` / ADR / repo | 按角色与路径检索 |
| Delivery Spec | 目标、非目标、验收标准 | Spec revision | 所有参与 Task 必带 |
| Task Context | 依赖产物、相关文件、变更范围 | ContextManifest | 仅当前 Worker |
| Evidence | 日志、测试、截图、Diff | Artifact store | Verify / Review 按需 |
| Secrets | PAT、API key、tokens | CredentialBroker | 永不进入模型上下文 |

每次 compaction 产生一个有版本、hash 和来源引用的 `ContextSnapshot`，而不是只留下不可审计的自然语言摘要。恢复时重建 Snapshot + Task 状态，不重放可能产生副作用的运行中命令。

Repo Wiki 可作为 Qoder 专用检索索引，但稳定决策应回写到 provider-neutral 文档。任务完成后的“记忆沉淀”必须经过以下门禁：

1. 事实仍可由代码、测试或用户确认验证；
2. 不是一次性进度；
3. 不包含 secret / PII；
4. 指明适用范围和失效条件；
5. 进入 Git review 或用户确认后才成为共享知识。

### 4.9 验证与交付：Agent 自证不等于验收

每个代码任务至少经过：

```text
Implementation Worker
  → deterministic checks（typecheck / unit / build / lint）
  → independent Verify Worker
  → independent Review Worker
  → acceptance mapping
  → user review / auto gate
  → integrate / commit / push / PR
```

- Worker 的“测试通过”只有附带命令、退出码和日志引用才算 Evidence。
- Verify 与 Review 使用独立上下文，避免实现者自己的叙事污染审查。
- 前端交付需要 browser / screenshot / interaction evidence；非 UI 任务不强制视觉步骤。
- 未运行、环境不支持、被跳过必须显示为 `unknown/skipped`，不能折叠为成功。
- Commit / Push / PR 是 Delivery action，不是“代码写完”的自然后续；始终受权限与发布门槛约束。

### 4.10 观测、恢复与评估

事件日志应记录 provider-neutral envelope，同时可选择保存严格脱敏后的 Backend raw reference：

```ts
interface HarnessEvent {
  eventId: string;
  meetingId: string;
  runId?: string;
  taskId?: string;
  hostId?: string;
  backendId?: string;
  sessionId?: string;
  turnId?: string;
  type: string;
  timestamp: string;
  payload: unknown;
  causationId?: string;
  correlationId?: string;
}
```

Cloud SSE 用 `Last-Event-ID`；Webhook 按 event ID 幂等；本地 SDK 用 Session ID resume，但应用重启后所有原 `running` Task 仍先转为 `interrupted`，由用户选择继续、fork 或放弃。

Harness 评估不能只看“模型说完成了”，至少跟踪：

- acceptance criterion pass rate；
- 首次交付通过率、返工轮次、revert 率；
- 验证失败发现阶段（实现期 / QA / Review / 用户验收）；
- auth/runtime/tool/transport 错误率；
- Action Required 的响应与等待时间；
- 每个成功 Task 的 token / cost / wall time；
- 上下文命中、过期知识导致的错误、压缩后的回归；
- 多 Worker 冲突率和集成失败率。

## 5. 推荐实施顺序

### Phase 0：先让 Qoder 成为“可信 Backend”

- 删除假 SDK interface 与 dead `loadQoderSdk()`；
- 使用官方 `query()` 实现 `QoderSdkSession`；
- 接通 typed event、真实 ready、turn interrupt、session close、resume；
- 修正登录为 `qodercliAuth()` / PAT，并做真实 auth handshake；
- 更正 capabilities；
- pin SDK + runtime，增加 DMG executable smoke test；
- 禁止在 SDK 不可用时静默退回猜测式 CLI；若保留 fallback，必须按锁定版本单独做契约测试并在 UI 明示 degraded。

**完成标准：** DMG 中可连续完成 10 轮多轮 Session；中断一轮后可继续；撤销 token 只出现一次 `auth.required`；重连不重复用户消息或工具调用。

### Phase 1：把聊天任务升级为 Delivery Run

- 引入 `WorkOrder`、`WorkReport`、`Evidence`、`DeliveryRun`；
- 将 Coordinator 输出的 Plan 编译为 DAG，不直接从自由文本触发副作用；
- 为每 Task 建独立 worktree 与 ContextManifest；
- 实现 Action Required、验证、Review、Integrate 状态；
- Chat 展示沟通，Shared Area 展示 Spec、进度、Diff、Evidence、Report。

**完成标准：** 任一“已交付”任务都能回答：改了什么、为什么、基于哪个 revision、谁执行、跑了什么验证、哪些标准通过、有哪些残余风险、产物在哪里。

### Phase 2：质量门禁与知识闭环

- 独立 Verify / Review Worker；
- 测试命令与证据收集器；
- `AGENTS.md` / ADR / Spec / Delivery Report 的 provider-neutral 知识层；
- 任务结束后的候选记忆提炼与人工/规则门禁；
- 上下文 snapshot、来源引用、过期检测与成本指标。

**完成标准：** 相同任务在 Claude、Codex、Qoder Worker 间切换时，核心规范、验收和证据格式不变；Provider 私有 memory 丢失不影响项目事实。

### Phase 3：Qoder Experts 与 Cloud Agents（显式 Opt-in）

- `qoder-experts` 复合 Worker profile；
- child progress 只读投影；
- Cloud Session adapter、SSE replay、Webhook 幂等、cancel / resume；
- GitHub Resource 使用短期最小权限 token；
- 本地与云端统一 Work Order / Report，不统一底层实现。

**完成标准：** 本地进程退出、网络中断或 app 重启后，云 Task 状态可从 Session + event cursor 精确恢复；不会重复创建 branch、commit 或 PR。

## 6. 必须新增的测试矩阵

### Adapter contract

- SDK init 前不得 `ready`；
- 多轮顺序与 Session ID 稳定；
- `interrupt()` 不关闭 Session，`close()` 才终止；
- permission allow once / deny / cancel / timeout；
- auth missing / expired 不重试风暴；
- runtime not found / wrong arch / wrong version / protocol mismatch；
- partial event、tool event、result、API retry 映射；
- checkpoint + rewind；
- app restart + resume / fork。

### Scheduler / delivery

- 单 Coordinator 不变量；
- Coordinator 崩溃：已有 Worker 继续，新任务暂停；
- 用户接管与超时自动接管的原子性；
- DAG dependency、预算与 Backend 并发上限；
- qoder-experts 父 Task 与内部子任务不发生双重调度；
- Worker worktree 冲突、取消、清理、集成失败；
- running → interrupted 恢复，不自动重放副作用。

### Security / release

- PAT 不出现在 event log、crash log、prompt、截图和 child context；
- tool deny 优先于 allow；
- path escape、symlink escape、超范围写入；
- Git push / PR 单独权限；
- DMG Finder 启动（最小 PATH）下 Qoder runtime、认证、10 轮会话、interrupt、reconnect；
- Qoder、Codex、Claude 并发时 HOME / config / credentials 完全隔离。

## 7. 最终建议

AhaMeet 可以借鉴 Qoder 的不是“多开几个 Agent”，而是以下完整闭环：

1. **Spec 是对齐协议；**
2. **Task Runtime 是执行边界；**
3. **单 Coordinator + mailbox + DAG 是协作边界；**
4. **角色工具集、权限和 worktree 是安全边界；**
5. **Evidence、Verify、Review、Diff 和 Report 是交付边界；**
6. **Repo facts、commit、ADR 与审慎记忆是知识边界；**
7. **结构化事件、cursor、snapshot 和 interrupted 恢复是可靠性边界。**

因此，下一步最高优先级不是开放 Qoder 担任 Coordinator，也不是继续完善自然语言 MeetingCommand，而是：**先把 Qoder 官方 SDK 接成一个真实、可恢复、可审批、可验证的 Worker Backend，再把整个 Meeting 输出收敛到可审查的 Delivery Run。**
