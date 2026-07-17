# Claude Code、Kimi Code、Codex Harness 官方接入契约研究

> 调研日期：2026-07-16（Asia/Singapore）
> 范围：认证、无头运行、流式协议、会话恢复、权限/审批、MCP、图片、多轮、打包/运行时、错误分类。
> 证据标准：仅采用官方文档、官方仓库、官方发布包及本机已安装官方 CLI 的帮助信息。

## 1. 结论摘要

三方都不是“只能抓终端文本”的 CLI，但 AhaMeet 当前不应对它们采用同一种接入深度。

| Backend | 官方最合适的嵌入面 | 与 Qoder 类问题是否同类 | Coordinator 建议 |
|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` 的长驻流式 `query()` | **否，主体不同类。** 已使用正式 SDK；主要风险是 AhaMeet 没有完整消费它的权限、恢复、错误、图片和运行时契约 | 第一阶段可继续担任 Coordinator，但必须补齐动态能力协商与完整生命周期 |
| Kimi Code | `kimi acp`，stdio 上的 ACP JSON-RPC | **部分同类，风险最高。** `--prompt --output-format stream-json` 是批处理转录面，不是完整嵌入面；会截断权限、图片、MCP、取消和会话控制 | 完成 ACP adapter 和隔离验证前，只做专家或 Worker，不担任 Coordinator |
| Codex CLI | 基础场景用 `@openai/codex-sdk`；完整 UI/Harness 用 `codex app-server` stdio JSON-RPC | **基础调用不同类，Coordinator 层面部分同类。** SDK 是正式实现，但公开面偏浅，不能承载完整的双向审批和认证管理 | 当前可在受控策略下担任 Coordinator；中期迁移 app-server 后再宣称完整能力 |

核心判断不是“能不能返回一句话”，而是 Backend 是否能在同一个、可恢复的会话里明确表达：已就绪、正在执行、需要审批、工具结果、认证失效、可重试错误、终止完成和产物变化。

## 2. 本项目与官方版本基线

调研时项目/本机版本如下：

- `@anthropic-ai/claude-agent-sdk`：项目锁定 `0.3.150`，其平台原生包也为 `0.3.150`。
- `@openai/codex-sdk` 与 `@openai/codex`：项目锁定 `0.144.1`。
- Kimi Code：本机独立二进制 `0.24.1`，路径为 `~/.kimi-code/bin/kimi`。
- Claude Code：本机 `2.1.201`。
- Codex CLI：本机 `0.144.1`。

这些版本必须进入运行时握手、日志和快照；不能只记录 AhaMeet adapter 版本。Kimi ACP 和 Codex app-server 都有版本协商或版本相关 schema，未记录 Backend 版本会让恢复和故障归因失去依据。

## 3. 官方能力矩阵

| 契约维度 | Claude Agent SDK | Kimi Code ACP | Codex SDK | Codex app-server |
|---|---|---|---|---|
| 传输 | SDK 管理的长驻子进程；异步消息流 | stdio JSON-RPC（ACP） | SDK 启动 `codex exec`，stdin/stdout JSONL | stdio JSON-RPC；WebSocket 明确为实验性 |
| 多轮 | 流式输入 `AsyncIterable<SDKUserMessage>` | `session/new` / `session/load` / `session/prompt` | 同一 `Thread` 重复 `run()` | `thread/start/resume` + 多次 `turn/start`，并支持 `turn/steer` |
| 恢复 | `session_id`、`resume`、`continue`、fork、持久化开关 | `loadSession=true`、session list、历史回放 | `resumeThread(id)`，保存在 `~/.codex/sessions` | `thread/resume`、`thread/read`、`thread/fork` |
| 中断 | `Query.interrupt()`、AbortController、`close()` | `session/cancel` | 每 turn 的 AbortSignal | `turn/interrupt`，终态为 `interrupted` |
| 权限 | `canUseTool` 双向回调、permission modes、sandbox | `session/request_permission`；ACP 可回传审批 | 只有 approval policy/sandbox 选项，无公开审批回调 | 服务端向客户端发审批 request，客户端显式答复 |
| MCP | SDK 配置、动态增删、状态、重连、elicitation | ACP 转发 http/sse/stdio MCP；权限共用统一审批 | 可产生 MCP item，但 SDK 没有专用动态管理接口 | MCP 状态、OAuth、elicitation、工具审批事件 |
| 图片 | `SDKUserMessage.message` 使用 Claude `MessageParam` 内容块 | `promptCapabilities.image=true`，base64 + MIME | `local_image` | data URL `image` 与 `localImage` |
| 认证管理 | CLI `auth`；SDK 有账户信息、认证状态和类型化认证错误 | `kimi login` 设备码；ACP `initialize` 返回 auth methods | SDK 构造器可传 API key，但无完整登录状态机 | `account/read/login/start/login/completed/updated/logout` |
| 错误语义 | 类型化 assistant error、API retry、result subtype | JSON-RPC 错误；官方未承诺完整领域错误枚举 | `ThreadError` 主要是 message 字符串 | `codexErrorInfo` 含 Unauthorized、UsageLimit、Sandbox、连接/流错误等 |
| 运行时 | SDK 带平台原生 CLI 包；可显式传可执行文件路径 | 官方可安装独立原生二进制，也可 npm 安装 | SDK 依赖并包装同版本 `@openai/codex` | 同一 Codex CLI 中的 `app-server` 子命令 |

来源：Claude Agent SDK [官方仓库与 README](https://github.com/anthropics/claude-agent-sdk-typescript)、[Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)；Kimi Code [ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)、[`kimi` command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)；Codex [TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)、[app-server protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。以上均访问于 2026-07-16。

## 4. Claude Code：SDK 路径正确，但能力消费不足会造成“假完整”

### 4.1 官方契约

Claude Agent SDK 的 `query()` 返回同时是异步生成器和控制接口的 `Query`。官方 `0.3.150` 类型定义支持：

- 以 `AsyncIterable<SDKUserMessage>` 做持续、多轮输入；
- `interrupt()`、`close()`、AbortController；
- `resume`、`continue`、`forkSession`、指定 `sessionId`、`persistSession`；
- `canUseTool` 回调，返回 allow/deny 及 session 级权限更新；
- `mcpServers`、运行中 `setMcpServers()`、MCP 状态、重连及 elicitation；
- `accountInfo()`、初始化结果、模型/命令/agent 列表；
- `maxTurns`、`maxBudgetUsd`、token task budget；
- 类型化 `SDKAssistantMessageError`：`authentication_failed`、`billing_error`、`rate_limit`、`invalid_request`、`model_not_found`、`server_error` 等；
- `api_retry` 事件包含 attempt、delay、HTTP status；result 明确区分 success、执行失败、最大轮次、最大预算和结构化输出重试耗尽。

精确 API 以项目锁定版本的官方 npm 包为准：[Claude Agent SDK 0.3.150](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.150)。概览见 [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)。（访问于 2026-07-16）

Claude Code CLI 还提供机器可读的 `claude auth status --json`；官方认证支持 Claude/Console 登录，并可由 Bedrock、Vertex 等外部凭据体系提供后端。认证路径不应通过“某个文件存在”推断。参见 [Claude Code authentication](https://docs.anthropic.com/en/docs/claude-code/authentication)。（访问于 2026-07-16）

图片方面，SDK 的用户消息直接承载 Claude Messages API 的 `MessageParam`，可用 image content block；参见 [Vision](https://platform.claude.com/docs/en/build-with-claude/vision)。（访问于 2026-07-16）

### 4.2 与 Qoder 类问题的关系

Claude 不存在“伪造 SDK 调用路径”或“猜测一次性 CLI 输出协议”这一主体问题。这里的风险是 **AhaMeet adapter 把深 SDK 压扁成浅聊天流**：如果只提取 assistant text，而忽略 session state、permission request、tool result、API retry、typed auth error、usage 和 session id，外部表现仍会与 Qoder 故障相似——启动后突然退出、权限请求悬挂、恢复后丢上下文、能力表与真实行为不一致——但根因不同。

### 4.3 优化方案

1. **保留 Agent SDK，升级事件映射，不改回 CLI 文本解析。**
2. 启动完成必须以 SDK initialization 成功、账户可读、MCP 状态收敛、首个 session id 已获得为准；不能以“子进程 spawn 成功”或模型先说一句欢迎词为准。
3. 把 `canUseTool` 接入 AhaMeet 的统一审批 UI；审批 request 必须带 backend session、turn、tool use id、命令/路径和持久化建议。
4. 把 `SDKAssistantMessageError`、`api_retry`、result subtype 原样映射到统一错误分类，不再依赖字符串正则。
5. 保存 `session_id`，重启时用 `resume`；正在执行的 turn 仍按产品决策进入 `interrupted`，不能静默自动重放副作用。
6. 图片输入通过 `MessageParam` image block 传入，附件共享范围先由 AhaMeet 校验，再交给 SDK。
7. 启用预算映射：Meeting 剩余预算下推为 `maxBudgetUsd`/task budget 的 backend 限额；收到 rate-limit 事件后暂停该 backend 新调度。
8. 打包时显式定位 SDK 的平台二进制。官方 README 特别说明虚拟文件系统中的 bundler 不能依赖 `require.resolve`，应把二进制提取到真实路径并传 `pathToClaudeCodeExecutable`。对 Electron `asar`，应采用相同原则：放入 `app.asar.unpacked`，启动前校验存在、可执行、架构和版本。这是依据官方 Bun 打包限制做出的 Electron 工程推论。[官方 README](https://github.com/anthropics/claude-agent-sdk-typescript#compiled-binaries-bun-build---compile)（访问于 2026-07-16）

## 5. Kimi Code：应从一次性 stream-json 迁移到 ACP

### 5.1 官方契约

Kimi Code 同时提供两种机器接口，但用途不同：

- `kimi -p ... --output-format stream-json` 是单 prompt 的非交互执行。官方明确：prompt mode 默认采用 `auto` permission policy，不向人请求常规工具审批；thinking 和进度仍可能写到 stderr。它适合脚本/CI，不适合承担完整的交互式 Host Harness。[`kimi` command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)（访问于 2026-07-16）
- `kimi acp` 是为 IDE/外部客户端设计的 stdio JSON-RPC 服务。它启动后不打印 banner，先等待 `initialize`，日志写 stderr，协议通道保持干净。[ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)（访问于 2026-07-16）

当前官方 ACP capability 声明包括：

- 图片 prompt（base64 + MIME）；
- embedded resource context；
- HTTP、SSE MCP，并在 session 创建/加载时转发 stdio MCP；
- session load、session list、历史回放；
- prompt、cancel、tool approval、文件读写 reverse RPC；
- `session/update` 流式 agent message、tool call、plan、配置和命令变化；
- `session/request_permission` 作为工具审批与问题 elicitation 通道。

官方同时披露限制：terminal reverse RPC 尚未连接，shell 命令仍由 Kimi 本地执行；不稳定扩展面大多未实现。因此 ACP 解决“协议可控性”，**不会自动替代 AhaMeet 的 worktree、写入锁和 OS 级执行隔离**。[ACP capability matrix](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html#capability-matrix)（访问于 2026-07-16）

认证方面，`kimi login` 使用 RFC 8628 device-code flow，失败/取消返回 1，成功返回 0；OAuth token 写入 Kimi data root 并由 CLI 自动加载/刷新。也支持 Platform API key 和其他 provider 配置。[Getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html)、[Providers and models](https://moonshotai.github.io/kimi-code/en/configuration/providers.html)、[Data locations](https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html)（访问于 2026-07-16）

会话由 Kimi 持久化到 `$KIMI_CODE_HOME/sessions`，支持指定 ID 恢复并回放历史；恢复还会带回 session 级审批状态和额外目录。[Sessions and context](https://moonshotai.github.io/kimi-code/en/guides/sessions.html)（访问于 2026-07-16）

### 5.2 与 Qoder 类问题的关系

当前若继续用“每轮启动一次 `kimi --prompt`、从 JSONL 抽 assistant text、用 session id 串接下一轮”，就与 Qoder 的浅层接入问题 **部分同类**：

- 使用了官方存在的命令，不是假实现；
- 但选择的是批处理 facade，而非官方为 IDE/Harness 提供的双向 ACP；
- prompt mode 默认 auto permission，AhaMeet 无法逐项承接常规审批；
- 图片、MCP、计划、工具进度、取消和 elicitation 被 adapter 主动降维；
- 每轮重启进程让“backend ready”“session alive”“turn complete”三种状态混在一起；
- 认证文件存在只说明曾经登录，不说明 token 当前可用于请求。

因此 Kimi 是三方里最应优先换接入面的 backend。

### 5.3 优化方案

1. **新增 `KimiAcpAdapter`，以 `kimi acp` stdio 为主路径。** 旧 stream-json adapter 保留为明确标注的 compatibility fallback，只允许低风险 one-shot Worker。
2. 实现 ACP `initialize` 版本协商，以响应 capability 生成有效能力；禁止静态宣称 images/MCP/permissions。
3. 走 ACP auth methods 或 `kimi login` 设备码流程，以退出码和后续 initialize/session 创建确认认证；不读取、复制或解析 OAuth token。
4. `session/new/load/list/prompt/cancel` 与 AhaMeet meeting/session/turn 状态一一映射，持久化 Kimi session id 和 Kimi CLI 版本。
5. `session/request_permission` 接入统一审批 UI。由于 shell 仍本地执行，外层必须继续使用独立 worktree、工作目录白名单、环境变量白名单和 OS 进程约束。
6. 通过 ACP image content block 传图片；通过 session 创建参数转发由 Meeting 明确授权的 MCP，不能继承用户全局所有 MCP。
7. Kimi 官方文档未承诺稳定、完整的领域错误枚举。adapter 应保留 JSON-RPC code/message/data、stderr 和进程退出原因，在 AhaMeet 层保守映射为 auth、permission、rate-limit、transport、protocol、backend-crash、unknown；无法确认的不得猜测。
8. 应用内 bundle 固定版本的官方独立二进制并关闭 bundle 内自升级，或显式选择系统 CLI。启动前校验 `--version`、`acp --help`、架构、可执行权限及 capability；版本不兼容时禁止承担 Coordinator。

## 6. Codex：SDK 真实可用，但 Coordinator 应升级到 app-server

### 6.1 官方 TypeScript SDK 的边界

`@openai/codex-sdk` 是官方 SDK，并非 HTTP API 的薄伪装；它明确包装同版本 `@openai/codex` CLI，通过 stdin/stdout JSONL 通信。它支持：

- 同一 Thread 多轮 `run()` / `runStreamed()`；
- thread id 与 `resumeThread()`；
- 每 turn AbortSignal；
- structured output；
- text + `local_image`；
- working directory、additional directories、sandbox、approval policy、network、web search；
- command/file/MCP/web search/reasoning/todo/error 等结构化 item。

参见 [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) 和项目锁定版本 [@openai/codex-sdk 0.144.1](https://www.npmjs.com/package/@openai/codex-sdk/v/0.144.1)。（访问于 2026-07-16）

但它的公开类型没有：

- 登录/登出/刷新/账户变化状态机；
- 收到审批请求后由应用回传 allow/deny 的回调；
- 动态 MCP 设置、OAuth/elicitation 状态管理；
- 丰富错误枚举（SDK `ThreadError` 主要只暴露 message）。

所以它适合“预先决定 sandbox + approval policy 后执行一轮”的 Worker/自动化调用，不足以单独支撑 AhaMeet 的完整交互式 Coordinator UI。

### 6.2 app-server 是更深的官方接入面

官方 `codex app-server` 使用 stdio JSON-RPC，要求 `initialize` 握手，支持：

- `thread/start/resume/read/fork`；
- `turn/start/steer/interrupt`；
- text、data URL image、local image；
- server-to-client 的 command/file/MCP/permission approval request；
- MCP 启动状态、OAuth login、elicitation；
- `account/read`、ChatGPT/API key/device-code login、login completed/updated、logout、rate limit；
- `turn/completed` 的 completed/interrupted/failed；
- `codexErrorInfo`：ContextWindowExceeded、SessionBudgetExceeded、UsageLimitExceeded、HTTP/stream connection failure、Unauthorized、SandboxError、InternalServerError 等。

官方还提供 `codex app-server generate-ts` 和 `generate-json-schema`，输出与当前 CLI 版本严格匹配。WebSocket transport 被明确标为 experimental/unsupported，因此桌面应用应使用 stdio，不应为方便而改用 WebSocket。[Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)（访问于 2026-07-16）

### 6.3 与 Qoder 类问题的关系

Codex 当前使用官方 SDK，所以不存在“命令/事件名凭猜测实现”的主体问题；打包同版本 native CLI 后，运行时闭环也比系统 PATH 可靠。

但如果 AhaMeet 静态宣称 permissions/MCP 完整可用、实际又只传 `approvalPolicy` 并过滤 SDK 事件，Coordinator 层仍会出现与 Qoder 类似的 **能力高报和生命周期降维**。尤其是：

- SDK 的 approval policy 不是应用可交互审批能力；
- SDK 能产出 MCP item，不等于 adapter 已完成 MCP 配置、认证和 elicitation；
- 本地 thread 不持久化到 Meeting snapshot，就无法在应用重启后恢复；
- 仅匹配 `401` 字符串会丢失 app-server 已提供的类型化 Unauthorized/transport/usage-limit 信息。

### 6.4 优化方案

1. **短期保留 SDK adapter，修正能力声明。** 只有真正传入并消费的能力才为 true；图片直接使用 SDK `local_image`，不可丢弃附件；保存 thread id 并支持 `resumeThread()`。
2. **中期新增 `CodexAppServerAdapter`。** 使用 stdio JSON-RPC 的稳定核心方法；每个锁定 CLI 版本在构建时运行 `generate-ts`/`generate-json-schema`，adapter 只依赖随包生成的 schema。
3. 认证 UI 改用 `account/*` 状态机。`account/read` 用于初始状态，`account/login/completed` 和 `account/updated` 驱动 UI；运行中收到 Unauthorized 时立即将 backend 标记为 `auth-required`，停止该 backend 新 turn，避免重复 401/reconnect 刷屏。
4. 用 app-server 的 approval requests 接入 Meeting 统一审批；sandbox 和审批保持为两个独立维度，禁止用“跳过审批”顺带关闭 sandbox。
5. `turn/steer` 用于会议中追加指令，`turn/interrupt` 用于接管/取消；必须等 `turn/completed: interrupted` 才认定中断完成。
6. 由 Meeting 显式传递 MCP server 范围，并消费 startup/OAuth/elicitation 状态；不要默认继承全部用户 MCP。
7. 错误映射优先使用 `codexErrorInfo` 与 http status，message 只用于展示和 unknown fallback。
8. 继续把同版本 `@openai/codex` native binary 放在 `app.asar.unpacked`，传绝对 `codexPathOverride`；启动前做 `--version`、`app-server --help`、schema version 和 auth/account preflight。

### 6.5 2026-07-16 实施进度与 app-server 迁移判定

本轮已在 SDK 路径落地以下止血项：事件映射改为直接依赖锁定版官方 TypeScript 类型；修正 command/file/MCP/reasoning/web-search/todo 的字段映射；能力表不再高报 MCP 与交互审批；Host 固定为 `read-only + never`；图片使用单 turn 的 `0600` 临时文件转成 `local_image` 并在完成、失败或中断后清理；捕获 thread id、提供 `resumeThread()` adapter seam，并把原生 session 引用写入 Meeting Host 快照。应用重启后的用户确认与端到端恢复入口仍属于后续恢复切片，当前不得宣称已经自动恢复。

同时用本机官方 Codex CLI `0.144.1` 实测了 `codex app-server --help` 和 `generate-ts --experimental`。当前 CLI 明确提供 stdio transport、`initialize`、`account/read`、`thread/start/resume`、`turn/start/steer/interrupt`、审批请求及结构化通知；一次生成 671 个 TypeScript schema 文件。这证明迁移路径可行，也说明不能在现有 SDK adapter 内零散手写 JSON-RPC 字段。

因此后续采用独立 `CodexAppServerTransport`：构建期按锁定 CLI 生成 schema 并做版本指纹，运行期只加载与 bundled CLI 匹配的 bindings；先交付 `initialize → account/read → thread/start/resume → turn/start/interrupt` 的纵向切片，再接审批和 MCP。完成该切片之前，SDK adapter 保持受控 Coordinator 能力，但 `mcp=false`、`permissions=false`、`executeTasks=false`，不以静态产品愿望冒充运行时能力。

2026-07-16 后续实现已完成上述稳定核心：生产 Host 默认走 stdio
app-server，真实 `0.144.1` OAuth 探针在不发送模型 turn 的情况下完成
account + thread 握手；SDK 路径保留为受限兼容 fixture。审批与 Meeting MCP
尚未桥通，因此三项能力仍保持 false，不因换了 transport 就提前放开 Worker。
当前纵向切片还会拒绝非 `0.144.1` app-server，并把 backend/protocol version
与 thread id 一起持久化；系统 CLI 升级造成协议漂移时会在 Coordinator 启动
前硬失败，而不是继续解析未知事件。

### 6.6 Kimi ACP 与 Claude checkpoint 实施状态

Kimi 生产 Expert 路径已从 stream-json 切换到 ACP 1：initialize 返回的
`agentInfo.version=0.24.1` 和 capability 经过验证，authenticate、session
new/resume、prompt、cancel、image block、只读文件 reverse-RPC 和 permission
request 均走长驻 JSON-RPC。Host 强制设为 Kimi 原生 `plan` mode，且仍保持
`coordinate=false`、`executeTasks=false`、`mcp=false`，直到 WorkReport/MCP
交付闭环完成。认证 UI 改用 ACP authenticate 权威探针，不再以 credential
文件存在作为登录成功。
最终探针进一步执行真实 `session/new`，防止 initialize/authenticate 成功但
会话实际不可用时仍显示“已配置”。ACP 文件 reverse-RPC 会解析真实路径后
再检查 workspace 边界，阻断符号链接逃逸；首轮多模态消息也会携带角色提示。

Claude 默认生产路径已统一经过 `ClaudeCodeBackend`；SDK 精确 pin 为
`0.3.150`，system init 的 session id 会写入 Meeting snapshot，恢复时下推
`Options.resume`。当前测试机 `claude auth status --json` 为 loggedIn=false，
所以真实云端 smoke 被正确门禁为 auth-required，没有用模拟成功替代。

## 7. 三方统一 Harness 设计

三方 adapter 不应被强迫输出相同的底层事件，但必须实现同一个最小、可验证的 Meeting Backend Contract。

### 7.1 建议接口

```ts
interface MeetingBackendDriver {
  probe(): Promise<BackendProbe>
  beginLogin(method: AuthMethod): AsyncIterable<AuthEvent>
  openSession(request: OpenSessionRequest): Promise<BackendSessionHandle>
  resumeSession(snapshot: BackendSessionSnapshot): Promise<BackendSessionHandle>
  sendTurn(input: MeetingInput): Promise<TurnHandle>
  steerTurn?(turnId: string, input: MeetingInput): Promise<void>
  interruptTurn(turnId: string): Promise<void>
  resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>
  setMcpScope?(servers: ScopedMcpServer[]): Promise<McpApplyResult>
  close(reason: CloseReason): Promise<void>
}
```

`probe()` 必须返回运行时事实，而不是产品愿望：

```ts
interface BackendProbe {
  installed: boolean
  executablePath: string
  backendVersion: string
  protocol: "claude-agent-sdk" | "acp" | "codex-sdk" | "codex-app-server"
  protocolVersion?: string
  auth: "ready" | "required" | "expired" | "checking" | "unsupported"
  capabilities: {
    coordinator: boolean
    interactiveApprovals: boolean
    resume: boolean
    steer: boolean
    images: boolean
    mcp: boolean
    structuredErrors: boolean
  }
  blockers: ProbeBlocker[]
}
```

### 7.2 统一事件

至少规范化以下事件，同时保留 `raw` 供脱敏日志和故障分析：

- `session.ready` / `session.requires_action` / `session.idle` / `session.closed`
- `turn.started` / `turn.interrupted` / `turn.completed` / `turn.failed`
- `assistant.delta` / `assistant.completed`
- `tool.proposed` / `tool.started` / `tool.progress` / `tool.completed`
- `approval.requested` / `approval.resolved`
- `artifact.changed`
- `mcp.status_changed` / `mcp.auth_required`
- `usage.updated` / `budget.exhausted`
- `auth.changed`
- `backend.retrying` / `backend.crashed`

禁止把“子进程仍活着”当作 session ready，禁止把“SDK/CLI 返回一条 assistant 文本”当作 turn completed。

### 7.3 认证状态机

统一采用：

`unknown -> checking -> ready -> expired/auth-required -> authenticating -> ready`

规则：

1. 配置文件/credential 文件存在最多只能把状态变成 `checking`。
2. 必须使用 Backend 官方 status/account/initialize 接口确认。
3. 运行中类型化 Unauthorized/authentication_failed 的权威性高于启动前 status；收到后立即断路，不能无限重启 Host。
4. 重新认证成功后创建新 turn 前再次 probe；不得把其他 Backend 的 auth tab 或 token 混入当前 Backend。
5. 凭据永不进入 MeetingCommand、附件、角色上下文、事件日志或 Worker 环境快照。

### 7.4 Coordinator 能力门槛

Backend 只有同时满足以下条件才能担任 Coordinator：

- 官方结构化双向协议已握手；
- 支持多轮且 session id 可持久化/恢复；
- 能确定 turn 终态与中断终态；
- 所有可能阻塞执行的审批都能在 AhaMeet UI 中呈现并答复，或明确采用不需要交互审批的受控策略；
- 认证失效可被类型化或可靠地断路；
- 实际能力与 capability handshake 一致；
- 打包运行时已做架构、版本、可执行权限和 schema/协议兼容检查。

按此门槛：Claude Agent SDK 可较快通过；Codex SDK 只能在“预设受控权限”模式通过，完整模式需 app-server；Kimi stream-json 不通过，Kimi ACP 通过验证后才有资格。

## 8. 分阶段落地顺序

### P0：阻止错误扩散与能力高报

1. 引入 `BackendProbe` 和动态 capability，Coordinator 资格由 probe 决定。
2. 三方 auth 不再由文件存在判定；Unauthorized/authentication_failed 触发 backend 级断路。
3. 保存 Claude session id、Kimi session id、Codex thread id、backend version、protocol version。
4. 未接通图片/MCP/审批的 adapter 将对应 capability 设为 false。
5. 启动 Host 不再发送会产生欢迎语和费用的“Ready prompt”；使用协议 initialize/account/capability 握手。

### P1：接入正确协议面

1. Kimi：实现 ACP adapter，旧 stream-json 降级为 compatibility worker。
2. Claude：补齐 canUseTool、typed errors、image、MCP 状态、resume 和 budget。
3. Codex：先补 SDK image/resume/完整 item；并行建立 app-server stdio adapter 的稳定核心。

### P2：统一治理与恢复

1. 三方接入统一审批、MCP scope 和附件 scope。
2. 事件日志 + 快照保存 backend handle；重启后任务进入 interrupted，由用户决定 resume/fork/retry。
3. 使用 Meeting 总预算和 backend 并发限额控制新 turn；后台工具/子任务单独计数。
4. 加入协议录制回放测试，避免 CLI 升级后 parser/schema 漂移。

## 9. 发布门槛与契约测试

每个 Backend、每个平台、每个打包形态都必须通过下列测试，不能只在开发 shell 通过：

| 场景 | 期望 |
|---|---|
| 未安装 | probe 返回 installed=false；不 spawn Host |
| 二进制路径是目录/不可执行/架构错误 | preflight 明确报 runtime-incompatible，不出现 `spawn ENOTDIR` |
| 未登录 | auth-required；不会创建 Meeting Host，不会自动重启刷屏 |
| 凭据文件存在但 token 失效 | 首次权威 auth/turn 错误后断路；只显示一次可操作错误 |
| 正常启动 | 只产生 session.ready，不产生模型欢迎语 |
| 多轮 | 后续 turn 使用同一 backend session/thread，历史一致 |
| 审批 allow/deny | UI 可见、请求相关 ID 完整、Backend 正确继续或拒绝 |
| 图片 | Backend 收到真实图片内容，不是文件名占位；能力不足时启动前拒绝 |
| MCP 未认证 | 显示具体 server auth-required，不把整个 Host 误判为崩溃 |
| interrupt | 等权威 interrupted 终态；已有 Worker 按会议接管策略继续 |
| 应用崩溃重启 | 恢复 session id 和产物；执行中 turn 标记 interrupted，不自动重放副作用 |
| Backend 升级 | schema/capability 兼容测试失败则禁止 Coordinator，可降级 Worker |
| DMG 安装后 | 从 `app.asar.unpacked`/应用内路径运行，PATH 和用户 shell 配置不影响默认 Backend |

建议用每个官方协议录制一套脱敏 fixture：正常一轮、工具调用、审批、图片、MCP、401、限流、断流、取消、进程退出、恢复。adapter 的 CI 测试先回放 fixture，再用真实 CLI 做少量 smoke test。

## 10. 当前代码审计：确定性缺口与修复切片

本节把官方契约与当前实现逐项对照。结论不是“功能尚不丰富”，而是已有若干声明与真实行为相反的发布阻断项。

### 10.1 P0：必须先阻断错误扩散

| 缺口 | 代码证据 | 影响 | 修复切片 |
|---|---|---|---|
| Claude 认证假阳性 | `electron/backends/claude-code-adapter.ts:204-209` 只判断 binary；本机 `claude auth status` 实测为未登录 | UI 可显示已配置，启动后却以 Host crash 结束 | 统一执行 `claude auth status --json`；运行中 `authentication_failed` 只发一次 `auth-required` |
| Claude 新旧认证真值割裂 | 默认 Claude 在 `electron/orchestrator.ts:213-215` 绕过 backend adapter；Backend UI 写入的新配置不会进入 legacy `mergedSubprocessEnv()` | “保存成功”不代表 Session 使用该 key/model | 所有 Claude Session 统一经过完整的 `ClaudeCodeBackend`；迁移后删除双写/双读 |
| Codex 事件协议字段错误 | adapter 在 `electron/backends/codex-adapter.ts:58-115` 手写 SDK 类型；当前官方 SDK 实际使用 `aggregated_output`、`changes[]`、`server/tool/arguments`，adapter 却读 `output`、`path/diff`、`name/string arguments` | 命令输出、文件变化、MCP 工具会丢失或伪造成空事件，与旧 Qoder“猜协议”同类 | 直接 import 官方 `ThreadEvent`/`ThreadItem`；exhaustive switch；用官方 shape 的 golden fixture 替换自证式测试 |
| Codex/Kimi Worker 无完成闭环 | Scheduler 在 `electron/worker-scheduler.ts:813-845` 注入 `meeting-worker` MCP；两 adapter 都不消费 `config.mcpServers` | Worker 无法可靠调用 `task_done`，DAG 卡住或误判失败 | 完成信号改为 provider-neutral `WorkReport`；Claude MCP 可作快路径，Codex app-server/Kimi ACP 映射同一命令与 ack |
| 凭据跨 Backend 串线 | `electron/ipc/sessions.ts:110-122` 先生成 Claude env；`electron/orchestrator.ts:246-252` 只改 HOME，保留 `ANTHROPIC_*`/`CLAUDE_*` 后传给 Codex/Kimi | 违反“凭据完全隔离”；其他 Agent 子进程可读取不属于它的 token/base URL | `CredentialBroker` 从空白最小环境按 backend allowlist 构造；增加 canary secret 隔离测试 |
| Ready 不是同一语义 | Claude start 在协议初始化前返回；Codex auth failure 被吞后 start 仍 resolve；Kimi start 等一次完整模型 turn | UI 会在未认证时显示 Ready，或启动即产生欢迎语、费用和竞态 | `start(signal): Promise<BackendReadyInfo>`；只允许 initialize/account/session-id 握手产生 Ready，auth failure 必须 reject/断路 |
| Coordinator 白名单可绕过 | `electron/orchestrator.ts:179-197` 直接把 default Backend 建成默认 Coordinator；只有后续 `setCoordinator()` 才限制 Claude/Codex | 把 Kimi 设为默认即可绕过第一阶段决策 | 创建会议和交接共用 `effectiveCapabilities.coordinate` 门禁；不满足时拒绝启动，不得静默 fallback |
| Talker 权限只靠提示词 | Codex 固定 `workspace-write` 且忽略 `tools: []`；Kimi prompt 模式也没有宿主审批桥 | Coordinator 本应只协调，却可能直接改代码 | `OpenSessionRequest.role` 决定强制工具/沙箱 profile；Talker 默认 readonly + 禁写，自动编排与工具权限继续分离 |

另外，当前 Codex 0.144.1 的登录入口是 `codex login`，而 adapter 调用 `codex auth login`（`electron/backends/codex-adapter.ts:493-520`）。必须从锁定 runtime 的 capability/help 生成登录命令契约，不能继续写死错误子命令。

### 10.2 P1：三方各自的正确实现

**Claude Code**

1. 保留官方 Agent SDK，删除 adapter/session 两份重复 runtime resolver。
2. adapter 完整映射 `systemPrompt/model/mcpServers/skills`，再让默认 Claude 走同一入口。
3. 记录 initialization、session id、typed auth/API retry/result/usage；保存 session checkpoint，恢复时先进入 `interrupted`。
4. SDK 版本从 `^0.3.150` 改为精确 pin；模型与能力由初始化结果生成，不用静态过期列表。

**Codex**

1. 短期修正 SDK 类型、真实 item 字段、图片临时文件（0600 + turn 后清理）、thread id 和 `resumeThread()`。
2. SDK 模式在真正桥通前将 interactive permissions/MCP 标为 false；对隔离 worktree 采用显式、不可由模型修改的 sandbox/approval profile。
3. Coordinator 主路径迁到 `codex app-server` stdio；构建时用随包的 `generate-ts`/JSON schema 生成协议类型，接通 account、approval、MCP、steer、interrupt 和结构化错误。
4. 移除启动用的 `Ready. Awaiting instructions.` 模型 turn；协议握手 Ready 后再接收真实用户输入。

**Kimi Code**

1. 用 `kimi acp` 长驻 stdio JSON-RPC 替换每 turn 一个 `--prompt --output-format stream-json` 进程；旧路径只保留为明确的低风险 compatibility Worker。
2. ACP initialize 做协议/能力协商，接通 session new/load/prompt/cancel、permission、image、MCP 和 session update。
3. credential 文件存在只能表示 `checking`；登录成功必须经 initialize/session handshake 确认，401/过期只发一次 `auth-required`。
4. 应用管理的固定版本 runtime 优先，系统 CLI 只能显式选择；当前 PATH 可能命中 `~/.ahakey/bin/kimi` 包装器，兼容探测必须记录 real path、版本和 wrapper 来源。

### 10.3 P2：用一个深模块收口三种差异

不要继续让 `Orchestrator`、`WorkerScheduler`、UI 分别理解三家的 session 细节。以 `MeetingBackendDriver` 作为 transport/control seam，以现有 `DeliveryHarness` 作为交付 seam：

```text
Meeting / Coordinator
  -> DeliveryHarness (Spec, WorkOrder, Evidence, Verify, Review, Integrate)
      -> AgentRouter
          -> ClaudeAgentSdkDriver
          -> KimiAcpDriver
          -> CodexAppServerDriver (CodexSdkDriver 作为受限 profile)
```

关键不变量：

- `session.ready`、`turn.completed`、`work.completed`、`delivery.accepted` 是四个不同状态；
- Worker 自报完成只进入 verifying，不直接交付；
- 每次执行绑定 backend/runtime/protocol/session id/spec revision/baseline/worktree；
- 未通过能力握手的 Backend 不得担任 Coordinator，也不得被 Scheduler 选中执行需要其缺失能力的任务；
- 未知 Backend 硬失败，禁止静默回退 Claude 后仍把产物归因给原 Backend。

### 10.4 推荐实施批次与验收

1. **Batch A（P0，共用底座）**：CredentialBroker、BackendProbe、真实 Ready、Coordinator/Worker capability gate、统一 auth circuit breaker。完成后先消除假登录、假 Ready、凭据串线和错误 Backend 调度。
2. **Batch B（Codex 修真）**：官方类型映射、正确登录、图片/resume、受限权限 profile；随后接 app-server。Codex 重新通过门槛前可保留 Host 对话，但暂停其代码 Worker。
3. **Batch C（Kimi ACP）**：ACP driver、认证/权限/session/MCP；在完成 WorkReport 闭环前继续限定 Expert，代码 Worker 仅开放到独立试验开关。
4. **Batch D（Claude 统一）**：合并认证真值与 session 路径，typed errors/resume/budget；验证 Claude/Codex 双向 Coordinator 接管。
5. **Batch E（发布）**：真实 DMG Finder 最小 PATH、未登录/撤销 token、10 轮、多图片、审批 allow/deny、interrupt 后继续、kill/restart/interrupted、3 Host/4 Worker、两小时稳定性。

Batch A-D 每批都必须跑 renderer/electron typecheck、现有测试、三方 adapter contract fixture、真实锁定 CLI smoke 和安装后 DMG smoke。当前 55 个测试全绿只能证明既有自定义接口内部一致，不能替代官方协议契约测试。

## 11. 来源清单

以下来源均于 2026-07-16 访问：

### Anthropic

- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK TypeScript official repository](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK 0.3.150 package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.150)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Claude Code authentication](https://docs.anthropic.com/en/docs/claude-code/authentication)
- [Claude vision/image content](https://platform.claude.com/docs/en/build-with-claude/vision)

### Moonshot AI

- [Kimi Code getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html)
- [Kimi command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)
- [Kimi ACP reference and capability matrix](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)
- [Kimi sessions and context](https://moonshotai.github.io/kimi-code/en/guides/sessions.html)
- [Kimi MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp.html)
- [Kimi providers and OAuth](https://moonshotai.github.io/kimi-code/en/configuration/providers.html)
- [Kimi data locations](https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html)
- [MoonshotAI/kimi-cli official repository](https://github.com/MoonshotAI/kimi-cli)

### OpenAI

- [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Codex SDK 0.144.1 package](https://www.npmjs.com/package/@openai/codex-sdk/v/0.144.1)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex official repository](https://github.com/openai/codex)
