# AhaMeet Orchestrator V2：问题解决与完整优化方案

状态：设计已完成 Grill，待实施
日期：2026-07-12
适用版本：从 0.14.0 直接全量升级，不保留运行时双轨

## 1. 执行摘要

当前故障不是单一的 Codex 登录问题，而是四层问题叠加：

1. 打包后的 Codex 原生二进制位于 `app.asar.unpacked`，SDK 可能以 `app.asar` 虚拟路径调用系统 `spawn()`，触发 `ENOTDIR`。
2. Claude 专用 shadow HOME 被传给所有 Backend，导致 Codex 看不到真实 `~/.codex` OAuth 凭据；各 Backend 已实现的 `buildEnv()` 实际没有被调用。
3. Host、Scheduler、MCP bridge、模型和生命周期仍带有单 Claude Host 假设。附加 Host 即使启动成功，也不能可靠参与编排。
4. Renderer 把任意 `talker ended` 当成整个 Meeting 结束，一个附加 Host 崩溃会错误关闭全局会话。

因此，本方案不做局部补丁，而是以 Orchestrator V2 全量替换当前多 Host 编排层。目标产品模型是：

- 一个 Meeting 同一时刻只有一个 Coordinator。
- 其他 CLI 作为专家 Host，通过内部通道给 Coordinator 提供意见。
- Meeting 拥有一个全局 Plan 和一个全局 WorkerScheduler。
- 每个任务选择执行 Backend；代码任务默认使用独立 Git worktree。
- Claude Code 与 Codex 第一阶段可担任 Coordinator；Kimi、Qoder 先作为专家或 Worker。
- Backend 差异由 Adapter 消化，上层只处理统一 `MeetingCommand` 和标准状态。
- 自动编排与危险工具权限完全分离。

## 2. 已确认的产品与架构决策

| 决策 | 结论 |
|---|---|
| 协作拓扑 | 单 Coordinator + 多专家 Host |
| Worker 管理 | Meeting 级全局 Scheduler，任务选择执行 Backend |
| Coordinator 故障 | 已有 Worker 继续；暂停新调度；用户确认接管；可选超时自动接管 |
| 跨 CLI 编排 | 统一 `MeetingCommand`；各 Backend Adapter 负责适配 |
| Plan 执行 | 普通模式需确认；自动编排模式直接启动；与工具权限分离 |
| 上下文共享 | 角色化最小上下文；附件显式共享范围；凭据完全隔离 |
| CLI 来源 | 应用内锁定版本为默认；系统/自定义 CLI 显式可选并做兼容检查 |
| Coordinator 白名单 | 第一阶段 Claude Code + Codex |
| Worker 文件隔离 | Git 项目每 Worker 独立 worktree；非 Git 目录使用写入范围锁 |
| 重启恢复 | 事件日志 + 快照；运行任务恢复为 `interrupted`，由用户决定 |
| 诊断 | 默认本地结构化日志；严格脱敏；用户主动选择才上传 |
| 上线 | 个人项目直接全量替换，不保留 V1/V2 产品双轨 |
| 发布门槛 | 真实 DMG 全链路测试 + 双 Coordinator + 故障接管 + 2 小时稳定性 |
| 资源预算 | 默认最多 3 Host、4 Worker；Meeting 和 Backend 双层并发限制 |

## 3. 已确认的根因与当前缺陷

### 3.1 P0：Codex 打包启动失败

`@openai/codex-sdk` 内部通过 `spawn(executablePath)` 启动 Codex。Electron 的 `fs` 可以读取 ASAR 虚拟路径，但操作系统不能执行：

```text
.../Resources/app.asar/node_modules/@openai/.../bin/codex
```

当前构建产物中原生文件实际位于：

```text
.../Resources/app.asar.unpacked/node_modules/@openai/
  codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
```

`CodexSession` 没有把已解析的真实路径传入 SDK 的 `codexPathOverride`。这解释了 OAuth 登录成功但应用持续 `spawn ENOTDIR`。

### 3.2 P0：Backend 环境与认证未接通

- `sessions:open` 为 Claude 构造 shadow HOME 后把它传给所有 Backend。
- Codex OAuth 位于真实 `~/.codex`，shadow HOME 下通常不存在。
- `CliBackend.buildEnv()` 在各 Adapter 中实现，但没有调用点。
- Backend 设置中的 API Key、Base URL、Model 因而不能可靠进入运行会话。
- Backend 可用性只检查“能找到路径”，没有执行、版本、架构、协议和认证探测。

### 3.3 P0：跨 Backend 模型污染

`HostGroup.start()` 对所有 Backend 默认传入 Claude 模型。Codex 可能最终收到 `--model claude-haiku-4-5`。模型必须由 Backend 配置或 Backend 默认值决定，上层不可持有 Claude 专用默认模型。

### 3.4 P0：虚假 Ready 与不可重连

- `BackendSession.start()` 返回 `void`。
- Codex 真正的初始化和首轮执行在异步函数中发生。
- Orchestrator 在真实 spawn/认证前发出 `session-ready`。
- `Reconnect` 没有建立新的 Session 生命周期。
- Codex `interrupt()` 当前调用 `end()`，会永久关闭会话而不是只中断当前 turn。
- Host 收到 `ended` 后没有清空 Session 引用，存活判断失真。

### 3.5 P0：Host 故障错误扩散为 Meeting 故障

Renderer 看到 `source === 'talker'` 的 `ended` 就把整个 Slot 设为 `running: false`。所有 Host 都使用 `talker` source，仅靠 `hostId` 区分。因此附加 Host 崩溃会禁用整个会议输入。

### 3.6 P0：Coordinator 实际不可切换

UI 只能添加、静音和删除非 default Host。主进程大量能力写死为 `defaultHost()`：

- 用户输入；
- Plan 安装；
- Worker 调度；
- 决策回传；
- Recap；
- Narration；
- Worker 描述。

当前没有 `coordinatorHostId`，也没有原子交接协议。

### 3.7 P0：多 Host 编排没有闭环

- 新 Host 加入后默认 Coordinator 不会收到成员变化。
- 没有 `list_hosts`、`ask_host`、`assign_to_host` 等 Host 级命令。
- CrossHostBus 主要用于少量广播，模型没有稳定入口。
- `buildTalkerMcp()` 是 Anthropic SDK 的 in-process MCP，不是通用跨 CLI 协议。
- Codex Adapter 接收 `mcpServers` 后未使用；Kimi 声明不支持 MCP。
- OrchestratorBridge 不带 hostId，附加 Host 即使触发 Plan，也可能路由到 default Scheduler。

### 3.8 P0：Renderer 构建失败

`PlanMeetingModal.tsx` 引用了未导出的 `PlanMeetingTaskInput`。手动 Plan 功能同时缺少完整 Renderer → preload → IPC → Orchestrator 调用链。

### 3.9 P1/P2：上一轮审计发现

- ASR IPC 缺少输入类型、大小、并发和超时限制。
- 嵌入式浏览器缺少完整导航、权限、下载与持久浏览数据策略。
- Browser bounds IPC 未限制 NaN、Infinity、负值和极大尺寸。
- 用户文本、头像、permission message 等 IPC 普遍缺少长度上限。
- safeStorage 不可用时 API Key 静默回退明文。
- XLSX/Markdown 富内容需要统一净化和 sandbox。
- 大目录逐文件串行 stat，缺少分页和取消。
- 设置文件使用固定临时名，缺少单实例与崩溃恢复。
- 大量吞错路径造成“无响应”而不是可操作诊断。
- 发布包未签名、公证；Windows/Linux 能打包不等于功能完整。
- 测试集中在少量 Worker 清理和 Skill URL 解析，缺少 IPC、Adapter、状态机和 DMG E2E。

## 4. 目标领域模型

### 4.1 核心实体

```ts
type MeetingStatus =
  | 'starting'
  | 'ready'
  | 'scheduling-paused'
  | 'recovering'
  | 'ending'
  | 'ended'
  | 'failed';

type HostStatus =
  | 'created'
  | 'resolving-runtime'
  | 'spawning'
  | 'authenticating'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'reconnecting'
  | 'failed'
  | 'ended';

interface Meeting {
  id: string;
  status: MeetingStatus;
  coordinatorHostId: string | null;
  hosts: Map<string, Host>;
  plan: MeetingPlan;
  scheduler: MeetingScheduler;
  budget: MeetingBudget;
  context: MeetingContext;
}

interface Host {
  id: string;
  backendId: string;
  role: 'coordinator' | 'expert';
  status: HostStatus;
  capabilities: EffectiveCapabilities;
  session: BackendSession | null;
}

interface MeetingTask {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  executorBackendId: string;
  status: 'draft' | 'pending' | 'running' | 'interrupted' | 'done' | 'failed' | 'cancelled';
  workspace: TaskWorkspace;
}
```

### 4.2 不变量

以下规则由主进程强制，而不是依赖提示词：

1. 一个非终止 Meeting 最多一个 Coordinator。
2. 只有 `ready` 且具备 `coordinate` 能力的 Host 可成为 Coordinator。
3. 只有 Coordinator 可以提交可执行 Plan；专家只能提交建议。
4. Meeting 只有一个 Scheduler 和一个权威 Plan。
5. 自动编排权限不改变任何工具执行权限。
6. Host 失败不直接改变 Meeting 为 ended。
7. Coordinator 失败时只暂停新的调度；已有 Worker 默认继续。
8. Backend 凭据和 HOME 按 Backend 隔离。
9. 所有跨进程输入先经过 schema、大小和权限校验。
10. 重启后任何曾经 running 的副作用任务都变成 interrupted，不自动重放。

## 5. 目标模块架构

```text
Renderer
  └─ Meeting UI / Host UI / Plan confirmation / Recovery UI
       │ typed IPC
Main Process
  ├─ MeetingService                 对外窄接口，Meeting 生命周期
  ├─ CoordinatorController          主持权、交接、故障恢复
  ├─ HostManager                    Host 启停、重连、健康状态
  ├─ MeetingCommandGateway          命令校验、身份检查、执行
  ├─ MeetingScheduler               全局 Plan、依赖、预算、Worker
  ├─ WorkspaceManager               worktree、共享目录锁、合并
  ├─ ContextBroker                  角色化上下文与附件共享范围
  ├─ RuntimeResolver                bundled/system/custom CLI
  ├─ CredentialBroker               Backend 隔离认证与安全环境
  ├─ MeetingRepository              event log、snapshot、恢复
  ├─ DiagnosticLogger               本地结构化脱敏日志
  └─ Backend Adapters
       ├─ ClaudeAdapter
       ├─ CodexAdapter
       ├─ KimiAdapter
       └─ QoderAdapter
```

每个模块应具备“小接口、深实现”的边界，避免 Orchestrator 再次成为持有所有状态和行为的巨型对象。

## 6. Backend 契约

### 6.1 Runtime 与启动

```ts
interface BackendRuntime {
  source: 'bundled' | 'system' | 'custom';
  executablePath: string;
  realPath: string;
  version: string;
  architecture: string;
  compatible: boolean;
}

interface BackendAdapter {
  probeRuntime(request: RuntimeRequest): Promise<RuntimeProbe>;
  probeAuth(runtime: BackendRuntime, auth: BackendAuth): Promise<AuthProbe>;
  buildEnvironment(input: EnvironmentInput): Promise<NodeJS.ProcessEnv>;
  createSession(config: BackendSessionConfig): BackendSession;
  capabilities(runtime: BackendRuntime): EffectiveCapabilities;
}

interface BackendSession {
  start(signal: AbortSignal): Promise<BackendReadyInfo>;
  send(input: HostInput, signal: AbortSignal): Promise<void>;
  interruptTurn(): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: BackendEvent) => void): () => void;
}
```

### 6.2 Codex 专项修复

1. `RuntimeResolver` 在 packaged 模式解析 `app.asar.unpacked` 真实二进制。
2. electron-builder 显式解包所有目标平台的 Codex native package。
3. 创建 SDK 时传入 `codexPathOverride: runtime.realPath`。
4. Bundled runtime 优先；system/custom 需版本兼容探测。
5. Codex 使用真实 HOME，读取真实 `~/.codex`。
6. `startThread` 时设置 working directory、sandbox、approval 等稳定选项；不传 Claude 模型。
7. 每次 turn 使用独立 AbortController；`interruptTurn()` 只 abort 当前 turn。
8. close 后禁止继续使用；重连必须创建新 Session 并注入 Context Package。
9. 在真实 DMG 内测试，不接受仅 dev 环境通过。

### 6.3 能力门控

```ts
interface EffectiveCapabilities {
  coordinate: boolean;
  structuredCommands: boolean;
  multiTurn: boolean;
  interruptTurn: boolean;
  resumeContext: boolean;
  images: boolean;
  tools: boolean;
}
```

第一阶段：

- Claude：满足契约测试后可 Coordinator。
- Codex：满足契约测试后可 Coordinator。
- Kimi/Qoder：默认 `coordinate: false`，可作为专家/Worker；逐个通过契约后开放。

## 7. 统一 MeetingCommand 协议

```ts
type MeetingCommand =
  | { kind: 'propose-plan'; tasks: ProposedTask[] }
  | { kind: 'revise-plan'; changes: PlanChange[] }
  | { kind: 'ask-host'; hostId: string; question: string }
  | { kind: 'broadcast-hosts'; question: string }
  | { kind: 'steer-worker'; workerId: string; addendum: string }
  | { kind: 'request-decision'; decision: DecisionInput }
  | { kind: 'save-memory'; entry: MemoryInput }
  | { kind: 'speak'; text: string };
```

命令处理顺序：

```text
Adapter output
→ parse
→ schema validation
→ capability validation
→ actor/Coordinator validation
→ Meeting state validation
→ budget and permission validation
→ execute
→ append event
→ emit renderer update
→ return structured result to Host
```

Claude 可由原生 tool/MCP 映射到命令；Codex 使用稳定结构化输出或支持的 MCP transport；其他 Backend 可使用 tool call/JSONL。任何适配方式都不得绕过 `MeetingCommandGateway`。

专家 Host 只能产生建议类结果。Coordinator 收到建议后决定是否创建或修改 Plan，避免多主重复调度。

## 8. Coordinator 生命周期与故障接管

### 8.1 正常切换

```text
用户选择新 Coordinator
→ 验证 Host ready + coordinate capability
→ pause new scheduling
→ 生成 Handoff Package
→ 新 Host 确认接收并完成握手
→ 原子更新 coordinatorHostId/roles
→ 通知全体 Host
→ resume scheduling
```

Handoff Package 包含：会议目标、已确认决策、Plan、任务状态、专家 Host 能力、最近必要对话、未解决问题和权限摘要。凭据、无关聊天和无关附件不包含在内。

### 8.2 故障接管

```text
Coordinator failed
→ Meeting = scheduling-paused
→ running Workers continue
→ 选择健康且具备 coordinate 能力的候选 Host
→ UI 显示诊断与接管建议
→ 用户确认，或配置的 15s 超时后自动确认
→ 执行正常切换流程
```

原 Coordinator 恢复后以专家身份加入，不自动夺回主持权。

## 9. 全局 Scheduler 与 Workspace

### 9.1 调度职责

- 全局 DAG 校验：未知依赖、自依赖、环依赖、重复 ID。
- Meeting 总并发默认 4。
- Host 总数默认最多 3。
- Backend 独立并发上限，默认 Claude 2、Codex 2，允许配置。
- 达到限流时指数退避；达到硬预算时暂停新任务。
- Worker 状态变化统一写入事件日志。
- 专家 Host 建议不能直接修改 Scheduler。

### 9.2 Git 代码任务

每个 Worker 创建：

```text
worktree: <app-data>/worktrees/<meeting>/<task>
branch:   ahameet/<meeting-short>/<task-id>
```

流程：

1. 检测用户工作区是否为 Git 仓库及是否存在未提交修改。
2. 记录安全基线，不覆盖用户修改。
3. 从任务允许的基线创建 worktree。
4. Worker 只在自己的 worktree 工作。
5. 完成后生成 diff、测试结果、提交和交付清单。
6. 按 DAG 顺序集成；依赖任务基于已集成前置结果启动。
7. 冲突进入 `needs-resolution`，禁止静默覆盖。
8. 失败/取消后安全清理 worktree；保留诊断和可选分支。

### 9.3 非 Git/文档任务

- 任务声明预计读取和写入范围。
- Scheduler 使用路径锁检测冲突。
- 冲突任务串行或等待用户决策。
- 写入采用临时文件 + 原子 rename。
- 未声明路径的写入进入权限确认。

## 10. ContextBroker 与安全边界

默认上下文：

- Coordinator：会议目标、必要对话、Plan、决策和任务状态。
- 专家 Host：目标、指定问题、相关决策和材料。
- Worker：任务、依赖摘要、授权材料和隔离工作区。

附件共享范围：

```ts
type ShareScope =
  | { kind: 'coordinator-only' }
  | { kind: 'selected'; actorIds: string[] }
  | { kind: 'all-agents' };
```

安全要求：

- UI 明示内容将发送给哪些 Backend/服务。
- API Key、OAuth token 和其他 Backend 配置不进入 Context Package。
- 每个 Backend 使用最小环境变量白名单。
- Claude shadow HOME 只允许 Claude Adapter 使用。
- safeStorage 不可用时默认不持久化明文密钥。
- 设置文件和事件日志权限设为用户私有。

## 11. 持久化与恢复

采用 append-only event log + snapshot：

```text
meetings/<meeting-id>/events.jsonl
meetings/<meeting-id>/snapshot.json
meetings/<meeting-id>/diagnostics/*.jsonl
```

事件至少包含：

- Meeting 创建/状态变化；
- Host 添加、状态变化、角色变化；
- Coordinator 交接；
- Plan 提议、确认、修改；
- Task/Worker 状态变化；
- Workspace 创建、提交、合并、冲突；
- 决策和恢复操作。

重启时：

1. 读取 snapshot 并重放后续事件。
2. 将所有 running Host 标记为 disconnected。
3. 将所有 running Worker 标记为 interrupted。
4. 检查 worktree、Git 状态和交付物。
5. 重置危险工具自动批准为关闭。
6. UI 让用户选择继续、重跑、完成或放弃。
7. 不自动重放任何可能产生外部副作用的操作。

旧数据升级前先创建只读备份；迁移失败保留原数据并输出诊断。产品代码不保留 V1 运行路径。

## 12. IPC、浏览器和通用安全整改

建立共享 schema 包，所有 IPC 参数以 `unknown` 接收并验证：

- ID、文本、URL、数组数量和嵌套深度设上限。
- ASR 验证 ArrayBuffer、4 字节对齐、语言白名单、时长、大小、并发和超时。
- 头像仅允许 PNG/JPEG/WebP，验证 base64 和原始字节，上限 1–2 MB。
- Browser bounds 必须为有限数字，并限制在窗口范围。
- 用户文本、Plan、addendum、permission message 都设合理上限。
- 错误使用稳定 error code，不把原始内部异常直接显示给 Renderer。

嵌入式浏览器：

- 拦截 `will-navigate`、`will-redirect`、`window.open`。
- 只允许 HTTP(S)。
- 默认拒绝摄像头、麦克风、通知、屏幕捕获等权限。
- 下载必须显式确认并限制危险扩展名。
- 提供清除 Cookie/Storage 的入口。
- 执行 JavaScript 必须经过工具权限和审计。

富内容：

- Markdown/XLSX HTML 使用成熟 sanitizer。
- iframe 使用严格 sandbox，不开放脚本。
- 文档解析限制文件大小、sheet 数、单元格数量和解析时间。

## 13. 可观测性与错误体验

每次启动生成 `launchAttemptId`，本地结构化记录：

- Meeting/Host/Backend/角色；
- App、Adapter、SDK、CLI 版本；
- bundled/system/custom 来源；
- 解析路径、realpath、架构和执行权限；
- cwd 检查；
- HOME/XDG 等变量的来源但不记录值；
- 状态变化和耗时；
- spawn 的 code/errno/syscall/path；
- 退出码、signal 和脱敏 stderr 尾部。

禁止记录 API Key、OAuth token、完整 prompt、附件和用户文件内容。日志默认本地滚动保存，用户主动提交反馈时才上传。

错误 UI 必须给出：

- 发生在哪个 Host；
- 当前 Meeting 是否仍可继续；
- 根因分类；
- 可执行操作：重新检测、重连、切换 runtime、重新登录、接管 Coordinator、复制诊断。

`spawn ENOTDIR` 应被分类为 `runtime-path-not-executable`，而不是建议用户重复登录。

## 14. 实施路线与阻塞关系

### 阶段 A：建立可测试的 Backend 基础层

1. 定义 BackendRuntime、BackendSession、BackendEvent、Capability 契约。
2. 实现 RuntimeResolver 和 CredentialBroker。
3. 修复 electron-builder 解包与 manifest。
4. 重写 Codex Adapter：真实路径、真实 HOME、异步 Ready、AbortController。
5. 重写 Claude Adapter 以满足同一契约。
6. 增加 Backend 契约测试和 packaged runtime 测试。

阻塞：所有后续 Host 与 Coordinator 工作。

### 阶段 B：替换 Orchestrator 核心

1. 实现 MeetingService 和显式领域状态。
2. 实现 HostManager 和独立 Host 状态机。
3. 实现 CoordinatorController。
4. 实现 ContextBroker 和 Handoff Package。
5. 删除 `defaultHost()` 隐式路由。
6. Renderer 改为 hostId + coordinatorHostId 驱动。

依赖：阶段 A。

### 阶段 C：统一命令与全局调度

1. 定义 MeetingCommand schema 与结果协议。
2. 实现 MeetingCommandGateway。
3. 将 Claude MCP 映射为 MeetingCommand。
4. 为 Codex 实现可靠结构化命令适配。
5. 抽出唯一 MeetingScheduler。
6. 修复手动 Plan IPC 和 `PlanMeetingTaskInput`。
7. 实现普通确认/自动编排两种 Plan 流程。

依赖：阶段 B。

### 阶段 D：Workspace 隔离与恢复

1. 实现 Git WorktreeManager。
2. 实现非 Git PathLockManager。
3. 实现合并、冲突和清理流程。
4. 实现 MeetingRepository event log + snapshot。
5. 实现 interrupted 恢复 UI。

依赖：阶段 C 的 Task 状态契约。

### 阶段 E：多 Host 协作与故障接管

1. 实现专家请求/回复协议。
2. 实现 Host 加入/离开通知。
3. 实现参会人列表设为 Coordinator、重试、替换。
4. 实现用户确认接管和可选超时接管。
5. 验证 Claude↔Codex 双向 Coordinator 组合。

依赖：阶段 B、C、D。

### 阶段 F：通用安全、性能与发布

1. IPC schema 与负载上限。
2. ASR、浏览器、富内容加固。
3. 设置原子写、单实例、密钥策略。
4. 本地结构化诊断和错误 UI。
5. 签名、公证和发布制品校验。
6. 完成测试矩阵与 2 小时稳定性测试。

## 15. 测试策略

### 15.1 单元测试

- Runtime 路径解析：dev、ASAR、ASAR unpacked、system、custom。
- Backend 环境隔离：真实 HOME、Claude shadow HOME、凭据不串线。
- 状态机非法迁移。
- MeetingCommand schema、身份和能力拒绝。
- Plan DAG：重复、未知依赖、环、自依赖。
- Coordinator 切换不变量。
- 预算和 Backend 并发限制。
- Context Package 最小披露。
- Event replay 与 snapshot。

### 15.2 Adapter 契约测试

所有 Coordinator 候选必须通过：

- runtime/auth probe；
- start 只有握手后 Ready；
- 连续多轮；
- 结构化 MeetingCommand；
- interrupt 当前 turn 后可继续；
- close 幂等；
- 错误可分类；
- Context Package 恢复。

### 15.3 集成测试

- 附加 Host 失败不结束 Meeting。
- Coordinator 失败暂停新任务、已有 Worker 继续。
- 用户确认接管后 Plan 不丢失。
- 普通 Plan 确认和自动编排权限分离。
- Worktree 创建、依赖合并、冲突和失败清理。
- 重启后 running → interrupted 且不重复副作用。
- 3 Host/4 Worker 预算和排队。

### 15.4 打包 E2E

必须在安装后的真实 DMG 应用内验证：

1. Claude 单 Coordinator。
2. Codex bundled CLI + OAuth 单 Coordinator。
3. Codex system CLI 模式。
4. Claude Coordinator + Codex 专家。
5. Codex Coordinator + Claude 专家。
6. UI 手动切换 Coordinator。
7. 杀死附加 Host 子进程，Meeting 继续。
8. 杀死 Coordinator，Worker 继续并完成接管。
9. 应用强制退出、重启和 interrupted 恢复。
10. 两小时、至少 2 Host + 4 Worker 稳定性运行。

## 16. 发布验收标准

全部满足才算完成：

- Renderer 与 Electron 两套 TypeScript 检查通过。
- 单元、契约、集成和 packaged E2E 全部通过。
- Claude/Codex 均能担任 Coordinator。
- 双向组合、手动切换和故障接管通过。
- Bundled/system Codex 与 OAuth 都通过。
- 附加 Host 崩溃不影响 Meeting。
- 自动编排不改变工具权限。
- Worktree 隔离与依赖合并可靠。
- 重启不重复执行副作用。
- 错误界面可以定位 runtime、auth、model、protocol、cwd 等类别。
- 2 小时运行无孤儿进程、明显内存增长、跨 Meeting 串线或状态死锁。
- 正式发布完成 macOS 签名、公证和制品校验。

## 17. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 全量替换范围大 | 按阶段提交；每阶段保持可测试；开发分支可回退 |
| CLI 协议升级 | Bundled 锁定版本；system/custom 兼容探测；Adapter 契约测试 |
| 多 Host 消息循环 | 只有 Coordinator 可调度和对用户汇总；专家请求带 correlationId/TTL |
| 模型输出非法命令 | Schema + capability + actor + state 四层验证 |
| Worktree 合并复杂 | DAG 顺序集成；冲突显式进入 needs-resolution |
| OAuth/凭据泄露 | Backend 环境隔离；ContextBroker；日志严格脱敏 |
| 崩溃后重复副作用 | running → interrupted；用户确认后恢复 |
| 资源/成本失控 | Meeting/Backend 双层预算；默认 3 Host/4 Worker；超限暂停 |
| UI 与主进程状态漂移 | 主进程为唯一权威；事件带 revision；Renderer 只投影状态 |

## 18. 第一条可验证的纵向切片

第一条实施切片应尽可能小，但贯穿真实发布链路：

> 在打包后的 DMG 中，用 bundled Codex runtime 和真实 `~/.codex` OAuth 启动一个单 Coordinator Meeting；只有在首个 Codex thread 事件成功后显示 Ready；能够连续完成两轮对话；中断当前 turn 后仍可继续；关闭后无孤儿进程；错误时生成脱敏诊断。

这条切片暂不包含多 Host 和 Worker，但会一次验证最关键的 RuntimeResolver、CredentialBroker、BackendSession 契约、真实 Ready、AbortController、诊断日志和 DMG 测试基础。完成后再向上搭建 CoordinatorController 和全局 Scheduler，可以避免再次在不可靠的 Backend 基础上堆 UI 和编排逻辑。
