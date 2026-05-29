# ASR / Whisper 修复方案

> 目标：把"说完话 → 拿到 transcript"链路从冷启动 800–1500 ms 砍到 300–600 ms。
> 范围：whisper 进程常驻 + 贪心解码 + endpointing 阈值收紧 + 失败恢复。
> 状态：**只出方案，不动代码**。下游 `exec-whisper` 按这份执行。

---

## 0. 现状（实际读过代码，不依赖任何 probe 报告）

| 文件 | 行 | 现状 |
|---|---|---|
| `electron/whisper.ts` | 96-123 | `transcribePcm()` 每次都 spawn 新 `whisper-cli` 子进程 |
| `electron/whisper.ts` | 149-153 | `mkdtempSync` + `writeFileSync(wav)` 同步阻塞 main thread |
| `electron/whisper.ts` | 154-165 | 解码参数 `-bs 5 -bo 5`（beam=5, best-of=5，**未做贪心**）, `-t 4`, `-nt`, `--no-prints` |
| `electron/whisper.ts` | 82-94 | 单飞队列 (`inFlight`) + 上限 `MAX_QUEUE_DEPTH=8`；`disposeWhisper()` 只 SIGTERM 当前子进程 |
| `electron/main.ts` | 286-319 | `whenReady` 串行：建 shadow home → createWindow → 串行 askForMediaAccess；**没有任何 whisper 预热** |
| `electron/main.ts` | 345-381 | `window-all-closed` + `before-quit` 都调 `disposeWhisper()`；5s 超时 race 保住 quit |
| `electron/ipc/asr.ts` | 全文 | 薄包装，无状态；签名 `asr:transcribe(pcmBuffer, lang)` 走 `Float32Array.buffer` |
| `electron/preload.cjs` | 40-41 | `asrAvailable()` / `transcribePcm(buf, lang)` 走 `ipcRenderer.invoke`（**结构化复制一次**） |
| `src/hooks/useVoiceCapture.ts` | 236-243 | VAD: `positiveSpeechThreshold=0.55`, `negativeSpeechThreshold=0.4`, **`redemptionMs=384`**, `minSpeechMs=128`, `preSpeechPadMs=256` |
| `src/hooks/useVoiceCapture.ts` | 388-400 | onSpeechEnd → `transcribePcm`，**没有 renderer 端 overlap guard**，依赖 main 单飞 |
| `build/whisper/` | — | 已带 `whisper-cli` + `ggml-small-q5_1.bin`（190 MB） + 所有 ggml/metal 后端 dylib，**没有 `whisper-server`** |
| `scripts/fetch-whisper.mjs` | 259-284 | 只 copy 一个二进制 `whisper-cli`；brew 的同目录其实还有 `whisper-server` 可用 |

**没动过**：之前的所有提交都没有触碰 `whisper.ts`、`fetch-whisper.mjs` 或 useVoiceCapture 的阈值。下面所有改动都是净增量。

---

## 1. 总体策略：bundle `whisper-server` + 本地 HTTP

选 `whisper-server`（whisper.cpp 官方 HTTP server，brew `whisper-cpp` 已带）的理由：

1. 同一份 C++ + ggml 后端，所有现有 dylib 直接复用（已经过 install_name_tool 重定位 + ad-hoc codesign 流水）。
2. 模型只加载一次，常驻内存（small-q5_1 ~600 MB RSS，可接受）。
3. 协议是 `POST /inference` multipart，参数和 whisper-cli 一对一，节流/排队主进程侧自己掌控。
4. 失败回退路径明确：server 起不来或者跑挂了，直接回退到现有 per-call `whisper-cli`，**接口一行不改**。

不选的替代方案（备注，免得 reviewer 来回质疑）：

- `smart-whisper` / `whisper-node` Node 绑定：需要 native build chain（node-gyp + cmake），打包脚本要大改，blast radius 太大。
- `whisper-stream` 流式：依赖连续 PCM 注入，要重写 VAD → ASR 之间的管道，本轮不做。
- 改 `whisper-cli` 自己常驻：whisper-cli 没有 server 模式，需要 patch 上游，弃。

---

## 2. 文件级改动清单

### 2.1 `scripts/fetch-whisper.mjs` — 同时打包 whisper-server

**做什么**

- 在 `ensureBinary()` 里把 `whisper-cli` 那一套 copy + otool + install_name_tool + codesign 抽成 `copyOneBinary(name)`。
- 依次 copy `whisper-cli` 和 `whisper-server`。
- `BREW_CANDIDATES` 增加 `…/bin/whisper-server` 两条。
- copyBinaryAndDylibs 的 `allBins` 自动包含两个新拷进来的二进制；dylib 集合本来就共享，无需重复。
- 缺失 `whisper-server`：不致命，只打 `log('warn: whisper-server not found — server mode will be disabled, falling back to per-call whisper-cli')`，让 dev 树照常跑。

**为什么单独列出来**：electron-builder.json `extraResources` 用的是整个 `build/whisper/**/*`，所以脚本侧塞进去就自动进 dmg，不需要改 builder 配置。

### 2.2 新增 `electron/whisper-server.ts` — server 生命周期管理

**导出**

```
startWhisperServer(): Promise<{ ok: true; port: number } | { ok: false; reason: string }>
stopWhisperServer(): Promise<void>     // SIGTERM + 1s wait + SIGKILL
isWhisperServerReady(): boolean
getWhisperServerPort(): number | null
```

**启动流程**

1. `resolvePaths()` 已经有，扩展返回 `{ bin, server, model }`；`server` 缺失则直接返回 `ok:false`。
2. 选端口：默认 `8723`；`EADDRINUSE` 时 +1 重试，上限 5 次（覆盖多实例 + 残留进程场景）。
3. spawn 参数（贪心 + 抑制非语音 token）：
   ```
   whisper-server
     -m <model>
     -t 4
     -bs 1                       # 贪心
     -bo 1                       # 贪心
     -nf                         # 关掉温度回退，避免 5x 串行解码
     -nt                         # 输出不带时间戳
     -sns                        # 抑制 [Music]/[BLANK_AUDIO] 这类非语音 token
     -fa                         # flash attention（默认 true，显式声明便于回归对照）
     -l auto                     # 默认 auto，每请求可覆盖
     --host 127.0.0.1
     --port <port>
     --inference-path /inference
   ```
   显式 **不开** `--vad`（renderer VAD 已经切段，server 再切一次会引入分段边界差异，且会再加一份 onnx VAD 模型的加载）。
4. 监听 stdout：等到出现 `whisper server listening at` 字样 resolve `{ok:true, port}`；20 s 超时 → kill + resolve `{ok:false, reason:'boot timeout'}`。
5. **dry-run 预热**：resolve 之后立刻 fire-and-forget 一次 `/inference`，提交 500 ms 静音 16 kHz WAV，把 Metal 着色器编译 + 模型张量 + page cache 都加热。这一步必须 await 完成才把 `isWhisperServerReady()` 翻 true——否则真实第一段还是冷。
6. 退出监听：`exit` 事件触发 `restartWithBackoff()`：
   - 60 s 滚动窗口里允许 3 次重启，间隔 250 ms / 1 s / 4 s。
   - 超阈值 → 标记 `serverDeadPermanently=true`，后续 `transcribePcm` 自动走 `whisper-cli` 回退路径，**不再尝试 server**，直到下次 app 重启。
7. 日志：boot/exit/restart 全部 `console.log('[whisper-server] …')`，方便 verify-latency worker 在日志里直接判断。

**停止流程**（`stopWhisperServer`）

- 已经 stopped 或 dead → 立即 resolve。
- 写 `serverDeadPermanently=true` 防止 exit 触发自动重启（避免和 quit 流程互踩）。
- `child.kill('SIGTERM')` → 等 1 s → 还活着则 `SIGKILL` → 等 200 ms → resolve。

### 2.3 重写 `electron/whisper.ts`

**保留**

- 公开签名 `transcribePcm(pcm, lang)` 返回 `{ok, text}` —— `electron/ipc/asr.ts` 和 renderer 一行不改。
- `isWhisperAvailable()` —— 但实现改为 "`whisper-cli` 存在 OR `whisper-server` 存在"。
- `encodeWavPcm16()` —— 服用，给 multipart body 用。
- `MAX_QUEUE_DEPTH=8` 上限 —— renderer 侧没有 overlap guard，必须保留这道阀。
- `disposeWhisper()` —— 改名 keep 兼容，内部委托给 `stopWhisperServer()` + SIGTERM 残留 whisper-cli 子进程。

**改写 `runOnce()`**

伪代码：

```
async runOnce(pcm, lang):
  if pcm.length < 1600: return {ok:true, text:''}
  if isWhisperServerReady():
     try: return await runOnServer(pcm, lang)
     catch (ECONNRESET | ECONNREFUSED | timeout):
        # server 挂了；返回失败让上层重试；server-mgr 同时收到 exit 事件触发自动重启
        return {ok:false, error:'whisper server lost — restart in flight'}
  return await runOnCli(pcm, lang)    # 原有 spawn-once 逻辑保留作回退
```

`runOnServer()` 细节：

- 用 Node 18+ 内建 `fetch` + `FormData` + `Blob` —— 不引新依赖。
- WAV buffer：用现有 `encodeWavPcm16`，包成 `new Blob([wav], { type: 'audio/wav' })`。
- 字段：
  - `file`：blob，filename `seg.wav`
  - `response_format`：`text`（whisper-server 直接返回纯文本）
  - `language`：`lang`
  - `temperature`：`0.0`
  - `no_timestamps`：`true`
- `AbortController` 设 **10 s** 硬超时（small-q5_1 在 M2 上 2 s 音频 ~600 ms，10 s 已经覆盖最坏 outlier）。
- 超时统计：60 s 滚动窗口超过 3 次 timeout → 主动 `stopWhisperServer()` + 让 restart 流程接手。
- 返回：trim 后回 `{ok:true, text}`。

`runOnCli()`：把当前 `runOnce` 原封不动搬过来，**只改 decode 参数**为贪心（见 §3），用于回退场景。

**移除 / 调整**

- `inFlight` 串行链：server 模式下 whisper-server **本身就是串行处理一个请求**，但为了保护内存（多段堆积时 form-data 内存暴涨）保留主进程侧 in-process serializer。改成 "排队但允许 server 自己内部串行"，本质和现在等价，只是把 `inFlight` 的语义改成 "限制并发 fetch 数量"。
- `cancelled` 旗标：保留，`disposeWhisper()` 仍然需要它来短路队列中已经入队但还没发的请求。

### 2.4 `electron/main.ts` — 接入启动 / 停止

- `whenReady` 内，**createWindow 之后、不 await**：
  ```
  void startWhisperServer().then(r => {
    if (!r.ok) console.warn('[whisper-server] disabled:', r.reason);
  });
  ```
  关键：**不放在 createWindow 前**，UI 先 paint；不放在 askForMediaAccess 之后，权限弹窗别拖累预热。
- `window-all-closed`：`disposeWhisper()` 不变（它内部会调 `stopWhisperServer()`）。
- `before-quit`：`shutdownAllSlots` 之后、`app.exit(0)` 之前调 `await stopWhisperServer()` —— `stopWhisperServer` 自己有 1.2 s 上限，跟现有 5 s race 不冲突。

### 2.5 `src/hooks/useVoiceCapture.ts` — 收紧 endpointing

只动两个数字（line 236-243）。**不改 UI、不改 callback 契约**：

| 参数 | 旧值 | 新值 | 理由 |
|---|---|---|---|
| `redemptionMs` | 384 | **240** | 这是说完话到 onSpeechEnd 之间纯等待，减 144 ms 就直接体现在端到端延迟里；240 ms 仍能盖住自然停顿（实测中文 200–250 ms 比较舒服） |
| `negativeSpeechThreshold` | 0.4 | **0.35** | 配合上面更短的 redemption，让真的"说完"判定更果断；过低会把句末擦音切掉，0.35 是经验上的拐点 |
| `positiveSpeechThreshold` | 0.55 | 保留 | 再低会被 TTS echo 触发，barge-in 误报回潮 |
| `minSpeechMs` | 128 | 保留 | 已经够 |
| `preSpeechPadMs` | 256 | 保留 | 砍这个会丢词首擦音，不划算 |
| `MIN_SAMPLES_FOR_BARGE_IN` (=4800) | 保留 | 保留 | 与 endpointing 正交，是 echo / 喉清门控 |
| `MIN_AVG_PROB_FOR_BARGE_IN` (=0.55) | 保留 | 保留 | 同上 |

### 2.6 不动的地方

- `electron/ipc/asr.ts` — 接口不变
- `electron/preload.cjs` — 接口不变
- `electron-builder.json` — `extraResources` 已经是整目录 glob
- renderer 其他 hook（`useAsr.ts` 等）— 模式判定逻辑不受影响

---

## 3. 解码参数（贪心）

CLI 和 server 都用同一套：

| 参数 | 旧值 | 新值 | 说明 |
|---|---|---|---|
| `-bs` (beam-size) | 5 | **1** | 贪心，省 5× 解码 |
| `-bo` (best-of) | 5 | **1** | 贪心采样不再 multi-sample |
| `-nf` (no-fallback) | 未设 | **设** | 关闭 temperature fallback；否则单段失败会触发 0.0→0.2→…→1.0 重跑链，单段最坏 5× |
| `-tp` (temperature) | 未设（默认 0.0） | 保持 0.0 | 显式声明，配合 `-nf` |
| `-sns` (suppress-nst) | 未设 | **设** | 抑制 `[Music]` / `[Inaudible]` 之类非语音 token，对短人声段误识别有帮助 |
| `-t` (threads) | 4 | 保留 4 | M2 实测 4 threads 就到性能拐点 |
| `-fa` (flash-attn) | 默认 true | 显式 true | 不依赖默认值，便于将来回归对照 |
| `-nt` (no-timestamps) | 已设 | 保留 |
| `--no-prints` | 已设 | 保留 |

**实测预期**：small-q5_1 在 M2 上，2 s 音频从 beam5/bo5 ~ 600 ms → 贪心 ~ 280 ms（≈50% off）。配合 server 常驻省掉 150–400 ms 冷加载，总收益 ~400–700 ms / 句。

**风险**：贪心在噪声大、说话人不清晰时会比 beam-search 多 1–3% 字错率。当前会话场景（用户对着 Mac 麦克风正经说话 + AEC/NS/AGC 全开），这点劣化可以接受。

---

## 4. VAD endpointing 阈值汇总（再列一次，决断用）

```ts
positiveSpeechThreshold: 0.55     // 不变
negativeSpeechThreshold: 0.35     // 0.4 → 0.35
redemptionMs:            240      // 384 → 240   ← 这一项是延迟下降的大头
minSpeechMs:             128      // 不变
preSpeechPadMs:          256      // 不变
```

判定为完的阶段从 `~384 ms` 等待 → `~240 ms`，端到端 ASR 触发延迟直接 -144 ms。

---

## 5. 边界情况清单

| # | 场景 | 行为 |
|---|---|---|
| 1 | server 二进制缺失（dev 树没装 brew whisper-cpp 或 fetch 脚本失败） | `startWhisperServer` 返 `ok:false, reason:'binary missing'`；后续 `transcribePcm` 全部走 `runOnCli` 回退（即今天的行为）；renderer 无感 |
| 2 | server 启动超时（20 s 拿不到 "listening" 日志） | kill 子进程；同上回退 |
| 3 | server crash（exit code ≠ 0） | 60 s 滚动窗口内允许 3 次重启（250 ms / 1 s / 4 s 指数退避）；超过则 `serverDeadPermanently=true`，整轮回退到 CLI |
| 4 | server 卡死不响应（fetch 超 10 s） | AbortController abort；累计 3 次 timeout/60s → 主动 `stopWhisperServer()` 触发重启 |
| 5 | 在 in-flight 请求时 server 死 | fetch 抛 `ECONNRESET`；返回 `{ok:false, error:'whisper server lost — restart in flight'}`；renderer 现有错误显示链不变 |
| 6 | app quit 时 in-flight 请求 | `before-quit` → `stopWhisperServer()` 走 SIGTERM → SIGKILL；现有 5 s race 兜底 |
| 7 | renderer 高频出段（用户连珠炮） | `MAX_QUEUE_DEPTH=8` 保留；超限时返回 `{ok:false, error:'whisper queue saturated …'}`（今天就是这样） |
| 8 | 端口 8723 被占（残留进程 / 其他 app） | `EADDRINUSE` → +1 重试，上限 5 次（8723–8727）；都占用则视为启动失败回退 CLI |
| 9 | 模型文件缺失 | server 起不来（whisper-server 自己会 exit 1）→ 视为启动失败回退 CLI（CLI 也会失败，但错误面和今天一致） |
| 10 | 用户切换 lang（zh ↔ en ↔ auto） | server 每请求带 `language` 字段，**零成本**，不需要重启 server |
| 11 | dev HMR / renderer reload | server 是 main 进程子进程，不受 renderer 重载影响；保持常驻 |
| 12 | macOS 内存压力下系统回收 Metal residency set（180 s 空闲自动 trim） | 下次请求会有 ~50 ms 重加载抖动；接受现状，不做 keep-alive ping |
| 13 | 多 tab 多 session 并发说话 | 单 server 共享，靠主进程 `MAX_QUEUE_DEPTH` 排队；今天就是这样 |
| 14 | 用户麦克风权限拒绝 | 与 server 无关；server 照常 warm，不浪费用户感知（VAD 不发音频，server 闲着） |
| 15 | dry-run 预热失败 | 不致命；只是首句仍冷；记 `console.warn('[whisper-server] warmup failed — first segment will be cold')` |

---

## 6. 跟其他 worker 的边界（避免改同一个文件）

| Worker | 可能改的文件 | 我这边动 | 是否冲突 |
|---|---|---|---|
| `exec-tts` | `src/lib/speech-session.ts`, `src/App.tsx`（speak callback） | 都不动 | 否 |
| `exec-llm` | `electron/orchestrator.ts`, `electron/claude-session.ts` | 都不动 | 否 |
| `exec-main-ipc` | `electron/main.ts`, `electron/preload.cjs`, `electron/ipc/*` | `main.ts` 加 2 行启停调用 | **可能轻微冲突**：main.ts 的 `whenReady`、`before-quit`、`window-all-closed`。约定：exec-whisper 只在这三个 hook 内 append 调用，不重排现有顺序 |
| `exec-whisper` | `electron/whisper.ts`, `electron/whisper-server.ts`（新增）, `scripts/fetch-whisper.mjs`, `src/hooks/useVoiceCapture.ts` 阈值 3 行 | 同 | 与 main-ipc 在 main.ts 重叠风险见上 |
| `verify-latency*` | 不写代码 | — | 否 |

**写入冲突预案**：动 `main.ts` 前 `git diff main.ts` 一下，看看 main-ipc worker 是否已经动了；冲突就先 Read 当前文件再用 Edit 局部 append，不要 Write 全文。

---

## 7. 验证（exec 完执行）

1. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.electron.json` —— 必须静默退出。
2. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` —— 同上。
3. `npm run dist:dmg`（或最少 `npm run build`），确认 `release/.../Resources/whisper/whisper-server` 存在且 codesign 合法（`codesign -dv` 不报错）。
4. 手测：
   - 启动后看 `[whisper-server]` 日志：boot → listening → warmup done，**应在 5 s 内全部出现**。
   - 说一句 ~1 s 中文，观察从 endpoint（VAD 报 `[barge-in]` 之类） → `useVoiceCapture` 拿到 transcript 的 wallclock 差，应 ≤ 500 ms。
   - kill 掉 whisper-server PID（`pkill whisper-server`）；下一句话应触发重启日志且 transcribe 成功（≤ 3 s 含重启）。
   - 连说 8+ 段超快，期望看到 `whisper queue saturated` 错误（确认背压还在）。
5. 把 dmg 装到一台干净的 Mac，验证 server 二进制能正常 spawn（codesign / dylib 路径都对）。

---

## 8. 不在本轮范围

- 切换到 node binding（`smart-whisper` / `nodejs-whisper`）：等 HTTP overhead 测出来超过 20 ms / 段再说。
- 流式 whisper（边说边解码）：要重写 VAD ↔ ASR 之间的管道，且当前段长度 1–4 s，收益小于风险。
- ONNX 说话人 embedding 移到 worker：不在 ASR 链路上，归 perf 清单。
- `documents:read` 主进程 base64 改造：归 `exec-main-ipc`。

---

## 9. 估算收益

| 维度 | 现状 | 方案后 | 收益 |
|---|---|---|---|
| 模型冷加载 / 段 | 150–400 ms | 0（常驻 + warmup） | **-150–400 ms** |
| 解码 beam→greedy / 段（2 s 音频） | ~600 ms | ~280 ms | **-320 ms** |
| VAD endpointing redemptionMs | 384 ms | 240 ms | **-144 ms** |
| 主进程 sync IO（mkdtemp + writeFileSync） | 几 ms / 段 | 0（in-memory blob） | -几 ms |
| **端到端（说完 → transcript 到 renderer）** | **800–1500 ms** | **300–600 ms** | **-500–900 ms** |
