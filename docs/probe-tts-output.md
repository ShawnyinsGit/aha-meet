# 输出侧延迟排查：回复首 token → 扬声器首字

排查范围：仅 vibe-meet 的"talker 给出回复"到"音箱发出第一个字"这一段。
不动手改，只出结论。

---

## 1. 关键链路 + 各段耗时估算

| # | 阶段 | 代码位置 | 估算耗时（warm 状态） |
|---|---|---|---|
| 1 | Anthropic 模型出第一个 token → 出完一个完整 content block | `electron/claude-session.ts:158`（`includePartialMessages: false`） | **800 – 4000 ms+**（取决于回复长度。整段 2-3 句话的回复实测一般 1–3 s） |
| 2 | SDK 在 main 进程里 yield `'message'` 事件 → `safeEmit` | `electron/orchestrator.ts:493-504` | <1 ms |
| 3 | `webContents.send('session:event', …)` IPC → renderer | `electron/main.ts:197` | 1–3 ms |
| 4 | `MeetingStore.handleIncomingEvent` → `handleMessage` → `speakCallback?.(text)` | `src/lib/meeting-store.ts:558, 941` | <1 ms |
| 5 | `App.tsx` 的 `setSpeakCallback` 闭包 → `speakConversational(text, …)` | `src/App.tsx:429-445` | <1 ms |
| 6 | `cancel(true)` 在每次 speak 头部强制 supersede（无条件调用 `speechSynthesis.cancel()`） | `src/lib/speech-session.ts:71` | 5–50 ms（即使无在播任务，也会进 Web Speech 引擎做一次 cancel） |
| 7 | `prepareForSpeech` 同步切句、清洗 | `src/lib/speech-format.ts:238-247` | <2 ms |
| 8 | `loadVoices().then(start, …)` —— 等 voices ready 才开始 | `src/lib/speech-session.ts:153`、`voice-registry.ts:38-73` | warm: ~0（已 resolve 的 Promise，只是一次 microtask）<br>**cold first ever**: 可达 **1500 ms hard cap** |
| 9 | `window.speechSynthesis.resume()` + `speak(u)` 到扬声器实际出声 | `src/lib/speech-session.ts:138-139` | macOS Electron 上首句 **80–300 ms**；后续句 30–80 ms |

**Warm 路径总和（已开过一段会、voices 已缓存）：≈ 阶段 1 + 阶段 6 + 阶段 9 = 1000–4000 ms + 100–350 ms ≈ 1.1–4.3 s**

**输出侧延迟实际上 90%+ 来自阶段 1（等整段回复出完）；其余各段加起来 < 400 ms。**

---

## 2. 关键观察（按重要性排序）

### 2.1 ⚠️ TTS 不是流式的，等整段才播 ← 主要瓶颈

- `electron/claude-session.ts:158`：`includePartialMessages: false`
- `electron/recap.ts:111`：同样关闭

  SDK 因此只在每个 **完整 content block** 时 emit `'message'`，不会发送增量 delta。
- `src/lib/meeting-store.ts:855` 通过 `extractText(content)` 取出完整 text，第 941 行 `this.speakCallback?.(text)` 一次性把整段文本扔给 TTS。
- 也就是说：**模型已经在第 200 ms 吐出 "好的，我来"，但渲染端要到第 2500 ms 才拿到整段 "好的，我来帮你看一下 X，先这样办……" 然后才开始切句喂 TTS。** 哪怕后面的切句、播放队列都很顺，也救不回来这 1–4 秒。
- 切句逻辑 `splitSentences` 在 `src/lib/speech-format.ts:102` 已经写好，可以一句一句喂；只是上游不给它流式输入。

### 2.2 `speakConversational` 内部本身是流式的（这块不背锅）

- `src/lib/speech-session.ts:84-148` 的 `speakNext` 是真正的 per-utterance 队列：
  - 一句一个 `SpeechSynthesisUtterance`
  - `onend` → `setTimeout(speakNext, 40)`（句间 40 ms，可接受）
  - 有 watchdog 兜底（B30），不会卡死
- 一旦 `speakConversational(text)` 被调用，第一句到喇叭的延迟只有 ~阶段 6+8+9 ≈ 150–400 ms（warm）。
- 所以**问题在"什么时候才调用 speakConversational"，不在 speakConversational 内部**。

### 2.3 voice-registry 预热做得不错，cold-start 不是常态瓶颈

- `src/lib/voice-registry.ts:17-28`：构造函数里就调了一次 `getVoices()` 并把 `loadVoices()` 启动了。模块 import 时（即 App 加载时）就开始预热。
- `voice-registry.ts:38-73` 的 `loadVoices` 有 1500 ms hard cap，并且只 resolve 一次（settled.done 守卫），不会无限挂。
- `voicesChangedListener`（`voice-registry.ts:25-27`）持有引用、`dispose()` 时清理（`:31-36`），没有泄漏。
  - 注意：默认 singleton 的 `dispose()` **从未被调用**（这就是 singleton 的预期生命周期，正常）。
- `useVoices`（`src/hooks/useSpeech.ts:172-194`）每次组件 mount 都加一个 `voiceschanged` 监听并在 unmount 清理，干净。

**结论**：voice-registry 在 warm 路径上几乎零成本。冷启动（首句、首次 mic 授权后）仍可能多 100–800 ms，但这是单次现象。

### 2.4 `cancel(true)` 在每次 speak 头部无条件触发 ← 次要

`src/lib/speech-session.ts:71` 注释说要"silent supersede"，但即使当前没有任何 utterance 在播，`window.speechSynthesis.cancel()` 也会被调用一次。macOS Electron 上这是有副作用的引擎调用，单次 5–50 ms，**而且偶发会让下一个 `speak()` 的首字出声更晚**（已经在 138 行用 `resume()` 兜了一刀，证明开发者知道这个坑）。

### 2.5 `speechFilterMode` 不影响**触发时机**

`speechFilterMode`（`src/lib/speech-format.ts:15-16, 220-236`）只是 `prepareForSpeech` 内的同步过滤：
- 'strict' 模式只丢 worker 噪声行（`WORKER_NOISE_PATTERNS`），合法的 talker 回复不受影响。
- 不会延迟，也不会决定"等不等下一段再播"。

### 2.6 `aiSpeaking` / `cancelSpeech` 的 race 状况

读完 `App.tsx:289-301, 386-394, 421-447` 与 `speech-session.ts:39-55, 64-79`：

- `cancelSpeech(false)` 现在会**同步触发 `session.onAllDone()`**（39-54 行），所以 `aiSpeaking` 能跟着复位，旧的 B 列 bug 已修。
- `setSpeakCallback` 闭包里加了 safety-net（`App.tsx:434-438`）：发现 `speakingRef=true` 但 `!isSpeechActive()` 时强制复位，防漂移。
- `speakConversational` 内 `cancel(true)` 抑制旧 onDone（避免 B20 race）；新 session 的 onDone 才负责复位。逻辑正确。
- 唯一**潜在小 race**：阶段 6 的同步 `cancel(true)` 之后，立即开始 `loadVoices().then(start)`。如果在这段微任务窗口里又来了一条 message，新的 speakConversational 会再次 `cancel(true)`，把刚 enqueue 的 session 标记为 cancelled —— `start()` 的 `if (this.activeSession !== session) return` 守卫（82 行）能正确丢弃，不会出错，**但会导致前一条消息一个字都没读出来就被覆盖了**。当前因为 stream 是关的、每个 assistant message 之间间隔大，触发概率极低；一旦开启流式（见下文修复 1），会高频踩到。

---

## 3. 最值得动的 1–2 处修复（按 ROI 排序）

### 修复 1（最大单点收益）：把 talker 改成流式 + 按句喂 TTS

**改动面**：
- `electron/claude-session.ts:158` 把 talker 的 `includePartialMessages` 改成 `true`（仅 talker，worker 不需要）。
- `electron/orchestrator.ts:493-504` 增加对 SDK partial 事件的处理（具体事件名以 SDK 版本为准，通常是 `stream_event` 携带 delta）。
- `src/lib/meeting-store.ts:847-944` `handleMessage` 增加一条 partial 分支：维护一个 per-slot 的"已喂给 TTS 的前缀"，把新增的、跨过完整句子边界（`splitSentences` 的同款分隔符）的那一段切出来调 `speakConversational(prefix, …)`；并改用 **append 而不是 supersede** 的策略（即新增句子时不应该 cancel 当前队列，而是 push 一个新 utterance）。
- 配套：`src/lib/speech-session.ts` 需要新增一个 `enqueueConversational(chunk)` 接口（或让 `speakConversational` 在 `activeSession` 还在跑时把新 chunks 推进现有队列，而不是 `cancel(true)`）。语义上要区分"用户输入打断 → cancel + 重置"和"同一条回复的下一句 → enqueue"。

**预期收益**：阶段 1 的等待从 1–4 s 砍到 200–500 ms（第一句话出齐的时间），**端到端可减少 60–80% 的输出侧延迟**。

**风险**：
- 切句策略要保守，避免把"好的，"这种碎片当成完整句子读出去（splitSentences 已经按 `。！？!?.` 切，问题不大）。
- 必须先解决 2.6 提到的 race：partial 频繁触发时，原 `cancel(true)` 语义会反复打断自己。

### 修复 2（小成本辅助）：去掉 `speak` 入口处的无条件 `cancel`，或在首次会话时预热引擎

只做其中一个就行：

- **去无条件 cancel**：`src/lib/speech-session.ts:71`，仅当 `this.activeSession` 非空时才 `cancel(true)`；空时直接进入新 session。省下首句 5–50 ms 的引擎 cancel/resume 抖动。
- **会话开门时预热**：在 `App.tsx` 创建 meeting 时 speak 一个 `' '`（或 `volume = 0` 的极短 utterance）。macOS Electron 的 `speechSynthesis` 首句冷启动有 80–300 ms，预热可以让真正第一句回复直接以 30–80 ms 出声。

**预期收益**：每条回复首字早 50–250 ms。单看不显眼，但叠在修复 1 之上后，"开口几乎无感延迟"就有了。

---

## 4. 不需要动的地方（已经写得对，别动）

- `voice-registry` 的构造预热 + `voiceschanged` 注册 + `dispose` 路径。
- `speakConversational` 内部的 per-utterance 队列、watchdog（B30）、`utteranceSeq` 守卫（B20）。
- `cancelSpeech(silent=false)` 触发 `onAllDone` 同步复位 `aiSpeaking`。
- `setSpeakCallback` 闭包里那段 `isSpeechActive()` safety-net。

这些是过去几轮 B 列 bug 修出来的，迁动会回退已修复的 race。修复 1 只需要在它们之上"加 append 入口"，不要去重写。
