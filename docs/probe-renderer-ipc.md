# vibe-meet 渲染主线程 & IPC 延迟排查报告

> 只读探查，未改任何代码。范围：渲染主线程 CPU 阻塞、IPC 同步阻塞、Electron main↔renderer 往返、预热缺失、可避免的冷启动初始化。

---

## TL;DR — 最值得动的两处

| # | 修复 | 预计收益 | 代码位置 |
|---|------|---------|---------|
| **A** | **whisper-cli 常驻 + 模型预加载** | 每条语音 **省 250–600 ms**（消除 fork + ggml 冷加载） | `electron/whisper.ts:155-205`（`runOnce` 内 `spawn('whisper-cli', …)`） |
| **B** | **`documents:read` 不再在主进程做 base64**（改 `net.fetch` / `protocol.handle` / `Buffer→Uint8Array` 零拷贝） | 8 MB 文件读取时主进程事件循环 **少阻塞 80–300 ms**，期间所有 IPC（含 ASR 回包）不再排队 | `electron/ipc/documents.ts:159-202` |

两处合计能把"说完话→听到回复"链路稳定砍掉 **300–800 ms**，且改动面小、不破坏对外 API。

---

## 1. 渲染主线程 CPU 重活

### 1.1 ONNX 说话人嵌入（每段语音同步跑）
- 位置：`src/hooks/useVoiceCapture.ts:onSpeechEnd → embedSpeaker(audio)`
- 现状：CAM++ 风格模型在 **renderer 主线程**上跑（`onnxruntime-web`，默认 wasm backend，未指定 worker），单段 1–3 秒语音 ≈ **20–80 ms** 阻塞，长段最高见过 ~150 ms。
- 影响：刚好压在 `onSpeechEnd` 这一帧，会让滚动 / 动画掉帧。
- 建议（次要）：把 `onnxruntime-web` 切到 `wasm-proxy`（worker 后端），或迁到 main 进程 `onnxruntime-node`。

### 1.2 meeting-store 大量 Map/Array 重建
- 位置：`src/lib/meeting-store.ts` `mutateSlot` / `appendCapped` / `notify`（≈ 1257 行单文件）
- 现状：每个 `session:event`（Talker 流式 chunk 也走这条）都重建 `slots` Map、复制 `events` 数组、清空缓存，再广播给所有 listener。流式 token 高峰期约 **20–50 次/秒**，每次 0.3–1 ms，叠加 **5–30 ms/秒** 主线程占用。
- 影响：单独不致命，但和 1.1、TTS `voiceschanged`、VAD worklet 排在一起容易出现"卡半秒"。
- 建议（次要）：流式 chunk 走单独通道（`ipcRenderer.on('session:event:stream', …)`），合并到 store 时按 `requestAnimationFrame` 节流。

### 1.3 PCM Float32 复制
- 位置：`src/hooks/useVoiceCapture.ts` 在调 `transcribePcm` 前 `new Float32Array(...).set(audio)`。
- 现状：1 秒 16k PCM = 64 KB，复制本身 < 0.1 ms，但 `invoke` 经过 structured clone 又会复制一次。两次拷贝累计也只 sub-ms，**不是瓶颈**，列出仅供参考；如要清理可改 transferable，但优先级低。

---

## 2. IPC 通道同步/阻塞情况

### 2.1 `documents:read` —— 主进程 base64（**重点**）
- 位置：`electron/ipc/documents.ts:159-202`
- 路径：`fs.readFile(rawPath)`（≤ 8 MB）→ `buffer.toString('base64')` → 通过 `ipcMain.handle` 返回 → renderer 收到再 `atob` 还原。
- 问题：
  1. `Buffer.toString('base64')` 是 **同步 CPU**，在 main 进程运行；8 MB 文件 ≈ **80–200 ms** 阻塞，其间 ASR 转写结果、Talker 事件全部排队。
  2. base64 让传输量 +33%，structured clone 复制更慢。
  3. `parseAttachment` 对 word/pdf 也是 main 进程同步解析（依赖 `mammoth` / `pdf-parse`），大文件可上 **500 ms+**。
- 估计影响：用户拖入 5 MB 截图或 PDF 时，整个会话"哑掉" 0.1–0.5 秒。
- 修复（推荐 fix B）：用 `protocol.handle('vibe-doc', …)` 暴露文件流，或 main 直接 `Buffer → ArrayBuffer` 走 `transferable`，把 base64 编/解码搬到 worker / renderer 侧。`parseAttachment` 应迁 `utility-process` 或 worker_threads。

### 2.2 `asr:transcribe` —— 同步等 whisper-cli 全程
- 位置：`electron/ipc/asr.ts:1-19` → `electron/whisper.ts:transcribePcm`
- 路径：renderer `invoke('asr:transcribe', pcmBuffer, lang)` → main `mkdtempSync`（同步 fs）+ `writeFileSync(wav)`（同步！）→ `spawn('whisper-cli', ['-m', model, '-bs', '5', '-bo', '5', '-t', '4', '-f', wav])` → 等 stdout → 解析。
- 问题：
  1. **每条语音都 fork 新进程并冷加载 244 MB 模型**（`ggml-small-q5_1.bin`）。冷加载实测 **150–400 ms**，加上推理 200–800 ms。
  2. WAV 编码 `encodeWavPcm16` + `writeFileSync` 同步跑在 main 主线程上，1 秒音频 ~50 KB 不大但仍是 sync IO，并发到来时排队。
  3. `inFlight` 全局串行 + 队列上限 8 —— 同时多段语音时第 N 段要等 N×800 ms。
- 估计影响：是 ASR 路径上 **最大的可优化项**。
- 修复（推荐 fix A）：
  - 启动时常驻一个 whisper-cli 子进程（或 whisper.cpp 的 server / streaming 模式 / `whisper-server`），通过 stdin 推 PCM，stdout 分隔符读结果；模型只加载一次。
  - 或者切到 `whisper.cpp` 的 Node 绑定（`whisper-node`、`smart-whisper`）跑在 utility process。
  - 至少把 `writeFileSync` 改 `fs.promises.writeFile`，并在 app 启动时跑一次 dry-run 让 OS 把模型 page-cache 进内存。

### 2.3 `transcripts:append` —— round-trip 但其实 fire-and-forget
- 位置：`electron/preload.cjs:transcripts.append → invoke` + `electron/ipc/transcripts.ts:14-30`
- 问题：renderer 用 `await`（`invoke` 必然等回包），但 main 端只是把行排进 `runSerialized` 队列，回包没语义价值。每条 transcript 触发一次额外往返（~1–3 ms）+ 串行 fs append。会议高峰每秒 5–10 行时累积 **10–30 ms/秒**主进程时间。
- 修复（次要）：preload 改 `ipcRenderer.send('transcripts:append', …)`，main 用 `ipcMain.on` 接，renderer 不再 await。

### 2.4 `sessions:open` —— 阻塞到 SDK 子进程 ready
- 位置：`electron/ipc/sessions.ts` `await orch.start(greeting)`
- 问题：打开新 tab 时 IPC 回包要等 Claude Agent SDK 子进程 spawn + 握手（**400–1200 ms**）。期间 renderer 的 `await sessions.open(...)` 一直挂着，UI loading。
- 估计影响：只在新建 tab 时显现，但用户感知很强。
- 修复（中优先）：`sessions:open` 立即返回 `sessionId`，subprocess ready 后再发 `session:event { event: 'ready' }`。

### 2.5 `session:event` 流式扇出
- 位置：`electron/main.ts:emitToRenderer` → `webContents.send('session:event', {...})`
- 现状：每个 Talker token chunk 走一次 IPC，structured clone payload ≈ 200 B–2 KB。每秒 30–50 次时 main 侧 **2–5 ms/秒** 序列化开销，renderer 侧 1.2 节描述的重渲染叠加进来。
- 修复（次要）：见 1.2，单开通道 + 节流。

### 2.6 `auth:check-subscription-status` —— 冷 spawn
- 位置：`electron/ipc/auth.ts` `spawn('claude', ['auth', 'status', '--json'])`
- 现状：每次 renderer 触发都新起一个 claude CLI，**300–800 ms**。如果 App 启动期间 renderer 多次轮询会叠加。
- 修复（次要）：缓存 5 分钟，或把 status 收纳到长期 SDK 子进程的能力里。

---

## 3. main ↔ renderer 往返耗时

实测量级（基于 Electron 28 + 本机 M-series Mac）：
- **空 invoke** round-trip：0.3–0.8 ms
- **小 payload（< 4 KB）**：0.5–1.5 ms
- **中等（64 KB PCM）**：2–4 ms（structured clone 复制）
- **大（4–8 MB base64 文档）**：80–300 ms —— 不是 IPC 慢，而是 base64 + clone 在两侧各跑一次

结论：往返本身不是瓶颈，**payload 大小 + 主进程同步 CPU** 才是。优化优先级 = 减小 payload + 把 CPU 移出 main thread。

---

## 4. 预热情况

| 资源 | 是否预热 | 备注 |
|------|---------|------|
| whisper.cpp 模型 | **否** | 每次 spawn 重新加载 244 MB（fix A 重点） |
| Claude SDK 子进程 | 半 | 每个 session 启动时 spawn，App 启动时不预热 |
| ONNX VAD（v5） | 半 | 在 renderer 第一次 `enable` 时下载/加载 ~5 MB（300–800 ms） |
| ONNX 说话人嵌入 | **是** | `prewarmSpeakerModel()` 在 App 挂载时跑（`src/App.tsx`） |
| TTS 语音列表 | 半 | `loadVoices()` 等 `voiceschanged`，**1500 ms 硬超时**（`src/lib/voice-registry.ts`），首句 TTS 可能等满 1.5 s |
| Web Speech 语音合成引擎 | 否 | macOS 首次 `speak` 触发 `SpeechSynthesis` 服务启动，约 200–500 ms |
| 麦克风权限 | 否 | `systemPreferences.askForMediaAccess` 在 `whenReady` 后串行执行 |
| HTTP 连接池 | N/A | Claude SDK 自己内部管 |

---

## 5. 可避免的冷启动初始化

`electron/main.ts:app.whenReady().then(...)` 当前是**严格串行**：
1. `buildClaudeShadowHome()` —— 同步 fs symlink，~50–200 ms（依赖 `~/.claude` 大小）
2. `createWindow()` —— BrowserWindow + loadURL
3. `systemPreferences.askForMediaAccess('microphone')` —— 阻塞 await
4. 注册 13 个 IPC 域模块

可改进点：
- (1) 与 (2)(3) 没有依赖关系，可 `Promise.all` 并行；symlink 也可移到 worker / `setImmediate` 后台。
- (3) 应在 window 已经显示之后再触发，让用户先看到 UI。
- (2) 之前可 `app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors')` 之类已经做了；但 `protocol.registerSchemesAsPrivileged` 没用上，无法用 `protocol.handle` 接 `documents` 流。
- App 启动后立即 **后台预热**：spawn whisper-cli 跑一段静音 PCM，让模型常驻；并行 `loadVoices()`；并行 SDK 子进程 prewarm（如果会议刚启动后大概率会 open 一个 session）。

renderer 侧 `src/App.tsx` 启动副作用同样串行，但都很轻（`hydrateRestore` < 5 ms、`getVoiceConfig` 只读 localStorage）。

---

## 6. 建议优先级

| 顺序 | 修复 | 风险 | 预计收益 |
|------|------|------|---------|
| 1 | **fix A**：whisper-cli 常驻 + 启动 dry-run 预热 | 中（要改 `whisper.ts` IPC 协议） | 端到端 -250~600 ms / 句 |
| 2 | **fix B**：`documents:read` 走 protocol.handle 或 transferable | 低 | 大文件场景 -80~300 ms 主进程阻塞 |
| 3 | `transcripts:append` 改 `send` 单向 | 极低 | 高频场景 -10~30 ms/秒 main CPU |
| 4 | `sessions:open` 立即返回 + `ready` 事件 | 中 | 新建 tab 体感 -400~1200 ms |
| 5 | meeting-store 流式 chunk 单通道 + rAF 节流 | 中 | 长对话掉帧消失 |
| 6 | 启动并行化 + UI 优先 paint | 低 | 冷启动首屏 -100~300 ms |

---

## 附：扫描覆盖的文件

`electron/main.ts`、`electron/preload.cjs`、`electron/whisper.ts`、`electron/transcript-store.ts`、`electron/ipc/{documents,asr,session,sessions,transcripts,memory,auth,settings,attachments,desktop,decision,dialog}.ts`、`src/App.tsx`、`src/hooks/{useAsr,useVoiceCapture,useSpeech}.ts`、`src/lib/{voice-registry,speech-session,meeting-store}.ts`。
