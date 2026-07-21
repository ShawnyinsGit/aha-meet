# Phase 2+ 技术方案：IDE 完整适配 + 掌机 UI + 陪伴屏（v3，grilling 决策整合版）

> 状态：v3。经三路红队评审（v2）+ grilling 逐题质询（8 项用户决策）整合
> 日期：2026-07-20
> 前置：`feature/opencode-ide-integration` 已合并（PR #5）。
> 核心理念（用户原话）：每个 CLI backend 都是一个数字员工，和你开会。默认会议模式，语音对话开会即可完成；详情展开为编辑器；掌机外接显示器时设备即 mini 主机。

---

## 〇、决策记录（grilling 会话，2026-07-20）

| # | 决策点 | 用户决定 |
|---|---|---|
| D1 | 掌机编辑器形态 | **App 内全屏 overlay**（会议语音 hooks 保活，底部迷你语音条）；桌面端维持独立窗口多开 |
| D2 | 外接显示器行为 | **外接即桌面模式**：会议 UI 自动移到外接屏；内置屏退化为陪伴屏（桌宠 + 状态提醒，vibebar 逻辑） |
| D3 | 陪伴屏形态 | **桌宠为主**：以 host（coordinator）backend 吉祥物为主体统筹整体状态展示与提醒，融合 vibebar；不做状态格子（与会议窗格信息重复） |
| D4 | 桌宠画面风格 | **像素风虚拟会议室**：数字小镇式画面，角色在虚拟会议室中的状态、进行中的任务、互相对话以游戏 NPC 气泡形式展示在参会人头像上；轻桌宠先行（状态机驱动，皮肤可后换） |
| D5 | 陪伴屏技术路线 | **自研 Phaser 3 + CC0 素材**（Star-Office-UI 素材非商用是雷区；ai-town 绑 Convex+LLM 太重） |
| D6 | 陪伴屏排期 | **独立 Phase 8，MVP 先行**；桌面版同样可用，不限掌机 |
| D7 | 语音链路 | **云端 ASR 优先，本地 whisper 断网兜底，本地内置 Mac/Win/Ubuntu 三平台** |
| D8 | 云端语音 provider | 用户未定 → 方案默认：**provider 可配置，默认 OpenAI-compatible 端点**（whisper-1 + tts-1），与现有 backend key 管理同构 |
| D9 | Linux 掌机包格式 | **Flatpak + AppImage**（SteamOS 系只读 rootfs 的原生路径是 Flatpak） |
| D10 | 签名与更新 | **未签名 + electron-updater**（GitHub Releases feed；签名暂缓） |

## 红队评审保留结论（v2 已修订，仍有效）

- R1 opencode 二进制不在包里（SDK 从 PATH spawn，`opencode-ai` 不在依赖）→ Phase 0 定案
- R2 SDK 默认 port 4096 固定 → 第二个参会者必撞车 → 显式端口分配
- R3/R8 renderer 直连 server 走不通（CSP 字面不匹配 + CORS + COEP）且无鉴权 server 是同机 RCE 入口 → **全流量主进程代理，renderer 永不持 serverUrl**
- R4 共享 server 必须 `sessionID` 过滤，与 registry 同 commit
- R5 掌机编辑器若做路由替换会杀死会议语音 → overlay 保活（即 D1）
- R6 掌机判定无物理尺寸信号 → 手动开关为主（外接显示器场景由 D2 的 display 事件驱动）
- R7 单机交叉打包不可能 → CI matrix 三 runner
- R9 PermissionBroker 需新建，fail-closed，接 `auto-approve-policy` + `nativeConfirmDestructive`
- R10 Linux TTS 可能失声 → getVoices() 检测 + 云端 TTS 兜底（由 D7/D8 覆盖）
- 现成漏洞先行修：`opencode-files` IPC（cwd:'/' 任意读文件）、`opencode-editor:open` 无校验、CSP handler 互相覆盖

---

## 一、Gap 分析（与 v2 一致，红队核实全部属实）

当前编辑器窗口 220 行 vs OpenCode server 实际能力（session.diff/todo/revert、pty、file/find、vcs、lsp、20+ typed 事件）。12 项 Gap：G1 编辑器与会话脱节、G2 权限断裂、G3 无真实事件、G4 无终端、G5 文件绕路无编辑、G6 端口撞车、G7 无会话恢复、G8 无 IDE 抽象、G9 二进制不存在、G10 无响应式、G11 既有 IPC 漏洞、G12 server 无鉴权。

**定位：编辑器窗口是 OpenCode server 的"远程控制台"，不是另一个 IDE。**不自研编辑器内核，把 server 已有能力投到窗口 UI 并与会议会话同源。

---

## 二、IDE 适配层（Phase 0–4，与 v2 一致）

### 2.0 Phase 0 spike（一切之前）
1. 二进制分发定案：加 `opencode-ai` 依赖 + asarUnpack；注入路径倾向**自写 spawn**（~70 行，同时解决 binaryPath、port=0、exit 监听三个问题）
2. 端口分配：验证 `--port=0` 或主进程 `net` 探测；验收两个 OpenCode 参会者同会
3. server 鉴权实测：Origin/Host 校验、`OPENCODE_CONFIG_CONTENT` 鉴权配置、SSE/WS token；无鉴权则随机高端口 + 全代理 + 威胁模型入文档
4. PTY 协议 spike：帧格式、resize、初始缓冲

### 2.1–2.9 要点
- **全流量主进程代理**：事件流 server SSE → 主进程 → IPC fan-out；写操作全走带校验的 IPC；编辑器 CSP 收回 `connect-src 'self'`；补 window-open/导航防护
- **断线重连 = checkpoint-resync**：重订阅后全量拉 `session.messages/todo/diff` 对齐再增量消费
- **权限桥接**：新建 PermissionBroker；adapter 维护 pending permissionID 集合；allow/deny → once/reject 映射；broker 超时显式 deny；destructive 落 `nativeConfirmDestructive`；opencode→SAFE_BUILTIN_TOOLS 工具名映射表
- **server registry**：键 `(meetingId, cwd)`，sessionID 过滤为共享前置；崩溃孤儿回收 + exit 监听 + 状态灯
- **文件**：删自建 IPC（安全动机，Phase 1）；读走 server API，写走主进程 `fs.writeFile`（SDK 无写能力）
- **终端**：xterm + addon-fit（gz ~90KB），主进程 WS 代理，命名 `PtyPanel`
- **通用化**：ide-* 改名（~160 处，CSS class 与 preload API 保留旧名）；IDE registry 持久化，override 键为 hostId
- **会话恢复**：end 不 delete；server 自身持久化 + userData 映射；GC 策略；v1 恢复只读

---

## 三、掌机 UI 自适应（v3 按 D1/D2 重写）

### 3.1 设备模型与模式判定

掌机 = 6–7" Ubuntu/Windows 手持 PC，逻辑宽 640–1280px；**支持外接显示器，外接即 mini 主机**（D2）。

- **双屏模式（外接显示器连接时）**：会议 UI 在外接屏 = 完整桌面模式（编辑器恢复独立窗口多开）；内置屏 = 陪伴屏（见第四章）
- **单屏掌机模式（无外接）**：掌机布局 + 编辑器 overlay
- 判定信号：`screen` 模块 `display-added/removed/metrics-changed` 事件为主（这是硬信号，不依赖 DPI 猜测）；手动三档开关覆盖：自动（默认）/强制掌机/强制桌面
- CSS 断点在 `(pointer: coarse)` 与窗口所在屏逻辑宽组合下生效：desktop ≥1100 / compact 720–1100 / handheld <720

### 3.2 窗口迁移（D2 的落地）

- 外接屏插入：主窗口 `setBounds` 移到外接屏 workArea 并最大化；已开的编辑器独立窗口逐一迁移
- 外接屏拔出：所有窗口收拢回内置屏，编辑器独立窗口**自动转为 overlay 形态**（状态保留：打开的文件、滚动位置经 renderer 状态序列化恢复）
- 会议语音链路全程不断：窗口迁移只动 BrowserWindow  bounds，不重建 webContents

### 3.3 掌机模式布局（单屏）

- 密度：`--density-scale` 覆盖关键组件（不做 300+ 处 font-size 全量 token 化）
- 会议模式：stage 全宽顶部；gallery → 横向滑动 chip 条；聊天 → 底部抽屉；底栏 5 键 + 更多；**权限审批 = 底栏角标 + 模态卡**（最高频阻塞交互不收进抽屉）；MeetingHeader 折叠为图标行；横屏优先
- 触控：目标 ≥44px；22×22px hover 角标（编辑器入口）掌机下常显放大；hover-only 交互 `(pointer:coarse)` 下改常显/长按
- 编辑器 overlay：App 内全屏覆盖层，**不替换 App 渲染树**（useClaude/useAsr/useTtsWiring/useVoiceLock 保活）；底部迷你语音条（mic 状态/打断/返回）；顶部员工 chip 条切换多员工；三栏折叠为底部 tab（文件/代码/日志/终端）
- 其他窗口：设置 → 主窗口内全屏页；stage popout 掌机禁用；窗口默认尺寸取 `workAreaSize`，**不加 minWidth**，掌机 `maximize()`

### 3.4 平台与语音链路（v3 按 D7/D8/D9/D10 重写）

**语音（D7/D8）**：
- 云端优先：新增 `electron/voice/cloud-asr.ts` + `cloud-tts.ts`，provider 可配置（默认 OpenAI-compatible：whisper-1 + tts-1），key 管理复用现有 backend 设置；音频出本机 UI 明示
- 本地兜底：whisper 三平台内置（v1.9.1 官方预编译资产 + `whisperServerEnv` 按平台参数化 backend 文件名 + 模型首启按需下载 ~190MB）；断网检测（`net.isOnline()` + 云端失败降级）自动切本地
- TTS：启动 `getVoices()` 检测，空 → 云端 TTS；云端不可达 → 明确提示"语音播报不可用"（不静默）
- Linux 掌机 OSK 现实：风险是键盘不出现而非遮挡——语音优先交互 + 内嵌 web 键盘兜底 + `visualViewport` 适配

**打包（D9/D10 + R7）**：
- CI matrix 三 runner（macos/windows/ubuntu）是结构性前提，废弃单机 `dist:all`
- linux target：Flatpak（掌机发行版原生路径）+ AppImage（注明 FUSE2 依赖）；修剪未验证的 arm64 target
- win：仅 nsis（perMachine:false 免 UAC），砍 portable
- 未签名 + 安装文档写清 SmartScreen/Gatekeeper 绕过；接入 `electron-updater` + GitHub Releases feed（安全更新可触达）
- 麦克风：darwin 走 `systemPreferences`；win denied 引导 `ms-settings:privacy-microphone`；linux 直接 getUserMedia
- 显示服务器：ozone-platform-hint 策略 + XWayland 下分数缩放/触屏手势实测矩阵（Phase 6）

---

## 四、陪伴屏（Phase 8，D2/D3/D4/D5/D6）

### 4.1 概念

外接显示器时，掌机内置屏从"主屏"退化为**桌面外设**：一块提供情绪价值与全局状态感知的常亮屏。不是会议窗格的缩小版（信息重复），而是：

- **主体：host backend 吉祥物**（D3）——当前 coordinator 是谁，桌宠就是谁的形象；它统筹聚合所有数字员工的状态并对外提醒
- **画面：像素风虚拟会议室**（D4）——数字小镇式场景，每个参会员工一个角色与工位；角色状态（idle/工作中/卡住/完成庆祝/告警）映射动画；**进行中的任务与互相对话以 NPC 聊天气泡展示在角色头顶**（内容 = 真实会议消息摘要，非 LLM 编造）
- **提醒：vibebar 逻辑**——权限请求、交付完成、错误告警以 mascot 主动提醒 + 轻音效呈现

### 4.2 独特优势

同类项目（PixelAgents/Star-Office-UI）都要解析日志**推断**状态；AhaMeet 的 orchestrator 持有权威参会者状态与真实消息流——陪伴屏只是渲染层 + 状态→动画映射。

### 4.3 技术（D5）

- **Phaser 3 + CC0 素材**（Kenney 等）或 AI 生成像素素材；**不用 Star-Office-UI 素材**（非商用授权）
- 状态机：每员工 {idle, working, blocked, celebrate, alert} × 动画集；BFS 寻路走位（参考 PixelAgents 思路，MIT 代码可参考）
- 数据：主进程 IPC 推送 participant 状态 + 消息摘要；陪伴屏 renderer 不持有任何 server 凭据
- 形态：内置屏上无边框常亮 BrowserWindow（`alwaysOnTop` 可选），开机自起可配

### 4.4 MVP 范围（D6）

固定像素会议室一张地图 + N 个角色工位 + 状态动画 + 头顶气泡（真实对话摘要）+ mascot 提醒。**不做**：走位漫游、多房间、互动点击、养成系统（后续迭代）。桌面版同样可用（不限掌机）。

---

## 五、分期路线（v3 全表）

| Phase | 内容 | 验收 |
|---|---|---|
| **0** | spike：opencode 二进制分发、端口、鉴权、PTY 协议 | 干净环境 dev 包起 server；双 OpenCode 参会者同会 |
| **1** | 安全修复：删 opencode-files IPC、editor:open 加校验、CSP handler 收敛 | 漏洞 case 回归 |
| **2** | 编辑器接真实会话（全代理+resync）、权限桥接（fail-closed）、Diff/Todo 面板 | 会中改文件实时可见 tool/diff/todo；审批继续；断流不丢 |
| **3** | ide-* 通用化、server registry、IDE registry 持久化、Settings 真实数据 | 第二 IDE 只需实现接口；默认 IDE 持久 |
| **4** | xterm 终端 + 文件编辑保存 + shiki 高亮 | 终端可用；保存后 find 可搜 |
| **5** | 掌机 2d1：密度、会议布局、触控、审批模态 | 720px 下会议全流程可操作 |
| **6** | 掌机 2d2 + 跨平台：编辑器 overlay（hooks 保活）、双屏迁移、CI matrix、云端语音、whisper 三平台、Flatpak、electron-updater、Wayland/OSK 实测 | Ubuntu x64 掌机全链路；插拔外接屏会议不断；编辑器 overlay↔独立窗形态切换状态保留 |
| **7** | 会话恢复 + 三平台打包闭环 | 重启可 re-attach 只读；三包全链路 smoke |
| **8** | 陪伴屏 MVP：Phaser 3 像素会议室 + 状态机 + 气泡 + mascot 提醒 | 外接屏开会时内置屏实时呈现员工状态与对话气泡；权限请求 mascot 提醒 |

## 六、明确不做

- 不自研编辑器内核、不上 Monaco；不用 Star-Office-UI 非商用素材；不嵌 ai-town
- 编辑器窗口只读 + 审批（写归会议 orchestrator）；不多文件 tab
- 不做 gamepad；不做 Linux ARM；不做 Hermes/Pi 真实集成（只留接口）
- 陪伴屏不做走位漫游/互动/养成（MVP 外）
- 暂不签名（electron-updater 先行）；云端语音 provider 第一版只做 OpenAI-compatible 一家

## 七、风险（v3 合并）

| 风险 | 等级 | 缓解 |
|---|---|---|
| opencode server 无鉴权 | 高 | Phase 0 实测；随机端口；全代理 |
| 权限桥接 fail-open | 高 | 超时显式 deny；nativeConfirmDestructive |
| 事件断流丢权限/日志 | 高 | checkpoint-resync |
| 单机交叉打包不可能 | 高 | CI matrix |
| 云端 ASR 隐私与成本 | 中 | UI 明示音频出本机；provider 可配置；本地兜底 |
| whisper 三平台工作量 | 中 | v1.9.1 官方资产；非首发阻塞（云端优先） |
| Linux 掌机无 OSK | 中 | 语音优先；内嵌 web 键盘 |
| 陪伴屏素材授权 | 中 | CC0/AI 生成；禁用 Star-Office-UI 素材 |
| 双屏迁移状态丢失 | 中 | renderer 状态序列化；迁移不重建 webContents |
| ide-* 改名 churn | 低 | 保留 CSS/preload 旧名；单独 commit |
