# TTS 分句流式合成与播放 — 修复方案

> 范围：把"talker 出完整段→才喂 TTS"改成"出一句→喂一句"，端到端首字延迟从 1–4 s 砍到 200–500 ms。
> 严禁动手改代码，本文只出方案。
> 配套阅读：`docs/probe-tts-output.md`（已确认瓶颈、风险、不动的地方）。

---

## 0. 现状速览（只读复核结论）

- **SDK 源头**：`electron/claude-session.ts:158` `includePartialMessages: false`，所以 talker 只在 content block 完整后才 yield `assistant` message。**这是 90% 延迟来源。**
- **TTS 引擎本身已是流式**：`src/lib/speech-session.ts:84-148` 的 `speakNext` 已经一句一个 `SpeechSynthesisUtterance`，句间 40 ms，有 watchdog（B30）、`utteranceSeq` 守卫（B20）、`cancel(silent=false)` 同步 fire `onAllDone` —— 这些都对，不要重写。
- **分句已有现成实现**：`src/lib/speech-format.ts:102` `splitSentences` 按 `。！？!?.` 切，>140 字再按 `，,；;` 二切，每句带 locale 标签。直接复用。
- **voice-registry 预热充分**：`src/lib/voice-registry.ts:17-28` 构造期就 `getVoices()` + `loadVoices()`，1500 ms hard cap。warm 路径下零成本。
- **`aiSpeaking` 闭环已修**：`cancelSpeech()` 同步 fire `onAllDone` → `App.tsx:451-454` 闭包复位；`App.tsx:445-448` 还有 `isSpeechActive()` safety-net 兜底漂移。
- **当前 race 风险点**：`speakConversational` 入口 `cancel(true)` 是无条件的（`speech-session.ts:75`）。一旦改成流式、每来一个 partial 都触发，会反复 cancel/重启自己。**必须先解决这个，再开流。**
- **多入口**：talker TTS 触发口不止 SDK message —— `narrateAssistantLine`（`orchestrator.ts:363`）、worker scheduler final buffered lines（`orchestrator.ts:295-300`）、tab 切回的 `pendingSpeak` 重放（`meeting-store.ts:513-525`）都是合成的 `assistant` event，**这些保留 supersede 语义**，只对真正的 SDK partial 走 append 路径。

---

## 1. 总体设计

把 TTS 调用语义从"一段一次性 speakConversational"拆成三种 mode：

| 入口 | 语义 | API | 触发场景 |
|------|------|-----|---------|
| `speakConversational(text)` | **supersede** — 砍掉旧 session，开新 session 喂完 text | 不变 | 一次性 narration：`narrateAssistantLine`、`pendingSpeak` 重放、worker scheduler final buffered line |
| `enqueueConversational(chunk, turnId)` | **append** — 同 turnId 时追加到当前 session 末尾；不同 turnId 隐式 supersede | **新增** | SDK stream_event 的每个新增完整句 |
| `cancelSpeech(silent?)` | **abort** — 砍 session，触发 onAllDone（除非 silent） | 不变 | 用户 barge-in、leave meeting、TTS 总开关关闭、enrollment 开始 |

关键不变量：**任意时刻只有一个 `activeSession`**。append 不开新 session，只在现有 session 的 `chunks[]` 后面 push，让 `speakNext` 的循环自然消费下一个。

---

## 2. 分句策略

### 2.1 切句的边界

- **主分隔符**（强信号，立刻切并送 TTS）：`。`、`！`、`？`、`.`、`!`、`?`、`\n\n`
- **次分隔符**（用于 >140 字长句二切）：`，`、`,`、`；`、`;`
- **不切**：单引号、括号、`:`、`、`、以及 `splitSentences` 当前没切的所有字符

直接复用 `splitSentences` 现有的正则：
```ts
text.split(/(?<=[。！？!?.])\s+|(?<=[。！？!?.])(?=[^\s])/u)
```
**不要改 `splitSentences` 的实现**，它是同步、纯函数、被 `speakConversational` 也用着，改了会牵到 supersede 路径。

### 2.2 最小长度门槛

- **首句**：≥ 6 个有效字符（去标点、空白后）才送。避免把"好的，"或单独 emoji 当一句读。
- **后续句**：≥ 4 个有效字符。第二句之后用户已经在听，短句反而连贯。
- **末尾 flush**：`content_block_stop` 到达时，无视长度门槛把残余 buffer 整段送出（即使只有 2 个字）。否则用户会听到回复中间被截。

### 2.3 "完整句"的判定

在 partial 累积过程中，**只有当 splitSentences 切出的最后一个元素之后还有更多 input**，才认为前面那些 elements 是"已完成"的句子。换句话说：

```
accumulated = "好的，我来帮你看一下 X，先这样办。然后再"
splitSentences → ["好的，我来帮你看一下 X，先这样办。", "然后再"]
// 最后一个 "然后再" 后面还可能有 delta，所以只取前 N-1 个作为"完成句"
ready = ["好的，我来帮你看一下 X，先这样办。"]
remaining = "然后再"  // 等下一波 delta
```

`content_block_stop` 到达时，`remaining` 也一起 flush（无门槛）。

### 2.4 跨语言切换

`splitSentences` 已经给每句打 locale 标签（`detectLocale(part)`），TTS 端按 locale 取 voice —— 这部分**不动**。流式只是更频繁地走同一条路径。

---

## 3. 消费 LLM 流式 token 的接口

### 3.1 SDK 层（main 进程）

**改动**：`electron/claude-session.ts:158`
- 仅 talker session 把 `includePartialMessages` 改成 `true`。
- worker / recap 维持 `false`（worker 没人听、recap 是 Haiku 总结，没 TTS 价值）。

实现方式：在 `ClaudeSession` 构造参数加 `includePartialMessages?: boolean`，默认 `false`；`orchestrator.ts:213` 创建 talker 时显式传 `true`。

SDK 会开始 yield `SDKPartialAssistantMessage`：
```ts
{ type: 'stream_event',
  event: BetaRawMessageStreamEvent,   // content_block_start / _delta / _stop / message_start / _stop
  parent_tool_use_id: null,
  uuid, session_id, ttft_ms? }
```
（类型来自 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3292`）

`ClaudeSession.start()` 的 `for await (const msg of this.q!)` 循环**不改**，照样 emit `{ kind: 'message', message: msg }`，SDK 已经把 stream_event 当成 SDKMessage 的一种。

### 3.2 Orchestrator 层

**改动**：`electron/orchestrator.ts:493-504` `onTalkerEvent` 里 capture 用的 `appendTalkerTurn` 只看 `t === 'assistant' | 'user'`，不会被 stream_event 污染 —— **不需要改**。stream_event 自然透传到 renderer（`safeEmit({ source: 'talker', event: e })`）。

唯一可考虑的小改动：把 `narrateAssistantLine`、worker final buffered lines、talker-exit 那条合成消息打一个 `synthetic: true` 标记，让 renderer 区分"这是 SDK 真出的"还是"我们伪造的 assistant"，前者走流式 append，后者走 supersede。**但更简单的办法**：renderer 看 `msg.type === 'stream_event'` 就是流式，看 `msg.type === 'assistant'` 就是 supersede / 终态 —— 不需要额外字段。

### 3.3 IPC 层

**不改**。`electron/main.ts:197` `webContents.send('session:event', { ...e.event, source, sessionId })` 已经透传任意 message 形状。流式 chunk 会让这条通道每秒触发 30–50 次 —— 这是次要问题（见 `docs/probe-renderer-ipc.md` §1.2、§2.5），本方案不一并处理。

### 3.4 Renderer / meeting-store 层

**改动**：`src/lib/meeting-store.ts:847` `handleMessage` 里增加 `type === 'stream_event'` 分支。

每个 slot 新增一块 streaming 状态：
```ts
interface StreamingTurn {
  turnId: string;          // 用 SDK 给的 message.uuid（message_start 时拿到）
  buffer: string;          // 累积的全文（仅 text content blocks）
  fedUpTo: number;         // buffer 已经 enqueue 给 TTS 的前缀长度
  cancelledByBarge: boolean;  // 用户 barge-in 了，剩余 delta 静默吞掉
}
```
挂在 `SlotInternal` 上（不挂到 React state，避免每个 delta 都 re-render），用一个 `currentTurn: StreamingTurn | null` 字段。

**事件分派**（仅 source === 'talker'）：

| SDK event | 动作 |
|-----------|------|
| `message_start` | 新建 `currentTurn`（turnId = event.message.id），`cancelledByBarge = false` |
| `content_block_start` with `content_block.type === 'text'` | 记下 block index，开始接收该 block 的 delta |
| `content_block_delta` with `delta.type === 'text_delta'` | append `delta.text` 到 buffer；调下面的 `flushReadySentences` |
| `content_block_stop` (text block) | flush 剩余 buffer（无门槛），enqueue |
| `message_stop` | 等价于"turn 结束"，把 `currentTurn` 置 null；**不立即** fire onAllDone（见 §4.4） |
| `assistant` (终态，type !== 'stream_event') | de-dup：若 `text === slot.lastSpoken` 则跳过 speakCallback；否则按现有 supersede 路径走（容错） |

`flushReadySentences(slot)` 伪代码：
```
turn = slot.currentTurn
if turn.cancelledByBarge: return
ready = splitSentences(turn.buffer)         // 同款分隔符
if ready.length <= 1: return                 // 最后一句还可能继续，不送
toSend = ready.slice(0, -1)                  // 除最后一句外都已完成
joined = toSend.map(c => c.text).join('')
newPrefix = turn.buffer.indexOf(joined) + joined.length
if newPrefix <= turn.fedUpTo: return         // 没有新进度
slice = turn.buffer.slice(turn.fedUpTo, newPrefix)
turn.fedUpTo = newPrefix
slot.lastSpoken = turn.buffer.slice(0, newPrefix)   // 滚动更新，用于终态 de-dup
enqueueConversational(slice, turn.turnId)    // 注意：是 slice，不是整个 buffer
```

**门槛检查**在 `enqueueConversational` 里做（首句 ≥ 6、后续 ≥ 4），不要污染 store。

terminal flush（`content_block_stop`）：
```
remaining = turn.buffer.slice(turn.fedUpTo)
if remaining.trim().length > 0:
  enqueueConversational(remaining, turn.turnId, { flush: true })   // bypass 门槛
  turn.fedUpTo = turn.buffer.length
  slot.lastSpoken = turn.buffer
```

---

## 4. 播放队列设计

### 4.1 数据结构

`SpeakSession` 现有结构（`speech-session.ts:9-14`）保留，**新增字段**：

```ts
interface SpeakSession {
  cancelled: boolean;
  current: SpeechSynthesisUtterance | null;
  utteranceSeq: number;
  onAllDone?: () => void;

  // === 新增 ===
  turnId?: string;            // 流式 session 才有；supersede 调用 (speakConversational) 不设
  chunks: Array<{ text: string; locale: Locale }>;  // 待播放队列，append 直接 push
  index: number;              // 已消费到第几个 chunk
  drainHoldTimer: number | null;  // 见 §4.4
  fedAnyChunk: boolean;       // 首句门槛追踪
}
```

把现有 `speakConversational` 内部的 `chunks` / `i` 局部变量提到 session 上。

### 4.2 `enqueueConversational(raw, turnId, opts?)`

```
chunks = prepareForSpeech(raw, this.filterMode)
// 应用最小长度门槛
filtered = chunks.filter(c => {
  const len = meaningfulLen(c.text)
  if (opts?.flush) return len >= 1                   // 末尾 flush 无门槛
  return session.fedAnyChunk ? len >= 4 : len >= 6
})
if (filtered.length === 0) return

current = this.activeSession
if (current && current.turnId === turnId && !current.cancelled) {
  // 同一 turn，append
  current.chunks.push(...filtered)
  if (current.drainHoldTimer != null) {
    clearTimeout(current.drainHoldTimer)
    current.drainHoldTimer = null
  }
  // 如果 speakNext 已停（index >= chunks.length 但 session 没被关掉），重新踢一次
  if (!current.current && current.index >= current.chunks.length - filtered.length) {
    // session 进入了 drain-hold，唤醒它
    this.kickQueue(current)
  }
  return
}

// 不同 turn 或没 session → 隐式 supersede（语义同 speakConversational，但带 turnId）
this.cancel(true)
const session = { ...new session with turnId, chunks: filtered, ... }
this.activeSession = session
this.startQueue(session)
```

### 4.3 `speakConversational` 入口去掉无条件 cancel

按 `docs/probe-tts-output.md` §3 修复 2 第一项：
```
// before:
this.cancel(true)
// after:
if (this.activeSession) this.cancel(true)
```
原因：空闲时也调 `cancel()` 会让 Web Speech 引擎做一次 5–50 ms 的 round-trip，**partial 频繁时这是放大器**。`activeSession === null` 直接进新 session，省一次抖动。

同时把 supersede 路径的 `chunks` 也搬到 session 上，统一让 `speakNext` 从 `session.chunks[session.index]` 取，而不是闭包变量。

### 4.4 drain-hold（最关键的 race 解法）

问题：append 模式下，LLM 出句速度可能比 TTS 播速度慢。`speakNext` 把现有 chunks 全念完后，下一个 delta 还没到 —— 这时若直接 fire `onAllDone`，会：
- 复位 `aiSpeaking=false` → useAsr 撤掉 mic suppression → 用户开始听到自己的回声进 mic
- 200 ms 后下一句 delta 到了 → enqueueConversational → 新 session 触发 → `aiSpeaking=true` → mic 又被 mute
- mic 状态 200 ms 抖一次，体验灾难

解法：**只要 turnId 对应的 turn 还没收到 `message_stop`**，drain 不 fire onAllDone。

实现：在 `speakNext` 里发现 `index >= chunks.length`：
```
if (session.turnId && !session.turnCompleted) {
  // 流式 session，turn 还没结束 —— 进入 drain-hold
  session.drainHoldTimer = setTimeout(() => {
    // 兜底超时：5s 内没有新 chunk 也没 message_stop，强制收尾
    // 防止 SDK 卡死时 aiSpeaking 一直挂着
    session.drainHoldTimer = null
    finalizeSession(session)
  }, 5000)
  return  // 不 fire onAllDone
}
finalizeSession(session)   // 一次性 / 末尾 flush 的路径走这里
```

`finalizeSession(session)`：
```
if (this.activeSession === session) this.activeSession = null
session.onAllDone?.()
```

renderer 在 `message_stop` 时调一个新 API `markTurnComplete(turnId)`：
```
markTurnComplete(turnId) {
  const session = this.activeSession
  if (!session || session.turnId !== turnId) return
  session.turnCompleted = true
  // 如果队列已空就立即收尾；还有 chunks 在播则等 speakNext 自然走到尾
  if (session.index >= session.chunks.length && !session.current) {
    if (session.drainHoldTimer) {
      clearTimeout(session.drainHoldTimer)
      session.drainHoldTimer = null
    }
    finalizeSession(session)
  }
}
```

这样：
- LLM 出句快、TTS 念得慢：chunks 始终非空，speakNext 一句接一句，message_stop 到达时还在念第 N 句，turnCompleted=true 标记，后面 speakNext 念到末尾自然 finalize → onAllDone → aiSpeaking 复位。
- LLM 出句慢、TTS 念得快：speakNext 念完进入 drain-hold（带 5s 兜底超时），下一句 delta 通过 enqueueConversational push 进来并 `kickQueue` 把 speakNext 重新启动。aiSpeaking 全程不复位。
- LLM 全段念完（短回复）：单次 enqueue → 念完 → 没有后续 → drain-hold 等到 message_stop 立即 finalize。

### 4.5 `aiSpeaking` 复位时机

**不改 App.tsx 的逻辑。** `speakConversational(text, () => setAiSpeaking(false))` 这种闭包模式在流式下也要工作：

新 API：`enqueueConversational(raw, turnId, opts?, onDone?)`。
- onDone 只在 session **真正 finalize**（drain-hold 结束 + turnCompleted）时 fire 一次。
- 同 turnId 多次 enqueue：第二次起 onDone 被忽略（已经登记过一个）；或者每次覆盖（取最后一个登记），二选一，**推荐覆盖**，更符合"meeting-store 每次都传当前的 setAiSpeaking 回调"的习惯。

App.tsx 端的 useEffect 不动；meeting-store 在 stream_event 分发时透传给 speakCallback。

为了避免大改 `speakCallback` 的签名，**推荐方案**：在 meeting-store 里把流式当成"对外 API 不变，对内分支不同"：
```
// 在 handleMessage 的 stream_event 分支里
this.speakCallback?.__enqueue?.(slice, turnId, opts)   // 如果 callback 支持
// 否则降级 supersede
?? this.speakCallback?.(slice)
```
具体做法：`setSpeakCallback` 的 callback 类型扩成对象 `{ enqueue, supersede, markTurnComplete, cancel }`，App.tsx 把这四个方法都从 useSpeech 透传过来。**这是唯一一处对外 API 的小破坏面**，必要。

### 4.6 watchdog / utteranceSeq

`speech-session.ts:107-150` 的 watchdog 和 `utteranceSeq` 守卫**完全保留**，append 模式下它们的作用只增不减：
- watchdog 用每个 utterance 自己的 `text.length` 算 budget，append 不影响。
- `utteranceSeq` 只关心当前 session 的最新 utterance，是否 append 与它无关。

---

## 5. 打断场景处理

### 5.1 用户语音 barge-in（最常见）

当前路径（`src/App.tsx:397-403`）：
```
onBargeIn = () => {
  if (speakingRef.current) {
    cancelSpeech()        // 砍 TTS
    speakingRef.current = false
    setAiSpeaking(false)
  }
}
```

**新增动作**（在 meeting-store 里）：barge-in 还要标记 `slot.currentTurn.cancelledByBarge = true`，让后续到达的 delta 静默吞掉（不 enqueue）。

实现：暴露一个 `meetingStore.markBargeIn()` 方法，App.tsx onBargeIn 里同时调用。这个方法只设 flag、不动 React state，廉价。

不需要 interrupt SDK：SDK 继续生成不会有听感影响，反正 delta 被吞掉；终态 `assistant` event 到达时 `lastSpoken` 仍会被更新（用于下一条 de-dup）但不喂 speakCallback（因为 `text === slot.lastSpoken`？不一定 —— 见下）。

**注意**：barge-in 时 `lastSpoken` 通常已经累积到 buffer 中已 enqueue 的部分（如 "好的，我来帮你看一下 X，"），但 buffer 后续 delta 还在累积。终态到达时 text 是完整段，**不等于** lastSpoken。所以需要在 `cancelledByBarge` 为 true 时，把 `lastSpoken` 也同步更新为最终 text，强制 de-dup —— 否则终态会触发一次完整的 supersede speak，把用户已经打断的内容又念一遍。

```
// 终态 assistant 分支补一段
if (slot.currentTurn?.cancelledByBarge && text === slot.currentTurn.buffer) {
  slot.lastSpoken = text   // 强制 de-dup
  // shouldSpeak 自然就 false
}
```

### 5.2 用户主动结束会议 / leave / TTS 总开关关掉

现有路径（`App.tsx:432-437, 488-491`）：`cancelSpeech()` + 重置 ref + setAiSpeaking(false)。

**改动**：cancelSpeech 接受可选参数 `{ resetStreaming: true }`，传进 meeting-store 让所有 slot 的 currentTurn 清掉。或者更简单：cancelSpeech 触发后，meeting-store 收到下一个 SDK partial 时 turnId 比对失败 → 自然丢弃（因为 `activeSession` 已经被 cancel，turnId 不匹配）。**推荐后者**，不要给 cancelSpeech 加状态依赖。

### 5.3 同一会话内串行的新一轮回复

用户连说两句的时候：
1. 第一轮 message_start (turnId=A) → enqueue 几句 → message_stop → drain → onAllDone → aiSpeaking 复位
2. 用户 200 ms 后又说话 → 触发新一轮 SDK turn (turnId=B)
3. enqueueConversational(slice, 'B') 看到 `activeSession === null`（被上一轮 finalize 掉了）→ 开新 session

无 race，自然走通。

如果第一轮没念完用户就插话：barge-in 走 §5.1 路径，第二轮的 turnId=B 与已被 cancel 掉的 session（turnId=A 已不在 activeSession 里）无关 → 直接开新 session。

### 5.4 `narrateAssistantLine`（MCP tool）夹在流式中间

talker 自己调用 `speak_to_user` MCP tool 时，`narrateAssistantLine` 会 synth 一个 assistant event（`orchestrator.ts:363`，type='assistant'，不是 stream_event）。

meeting-store 现有逻辑会走 `assistant` 分支 → speakCallback(text)。在新设计里，应该用 **supersede**（speakConversational）而不是 enqueue —— 因为这通常是 talker 想"插话"说一些主动播报，应该立刻打断当前流式输出。

实现：App.tsx 的 speakCallback 默认走 supersede。stream_event 走的是新的 enqueue 路径，是分开的。两者不冲突。

### 5.5 enrollment 开始

`App.tsx:308 cancelSpeech()` —— 不变，按 §5.2 同样处理（后续 delta 静默吞掉）。

### 5.6 tab 切换时的 pendingSpeak 重放

`meeting-store.ts:513-525` 在 setActive 时把 pendingSpeak 的 text 直接 `speakCallback(text)` —— 这是 supersede 一次性播放，不需要走流式（流式数据已经过去了）。**不动。**

---

## 6. 复用现有机制 / 不引入 race 的检查表

| 既有机制 | 是否改动 | 备注 |
|---------|---------|------|
| `cancelSpeech(silent=false)` 同步 fire onAllDone | **不改** | 仍是 supersede / barge-in 的复位路径 |
| `cancelSpeech(silent=true)` 内部用于 supersede 时抑制 onDone | **不改** | enqueueConversational 走"不同 turnId"路径时也用它 |
| `utteranceSeq` (B20) | **不改** | 每个 utterance 自带 myId 比对，append 不影响 |
| watchdog (B30) | **不改** | budget 按单 utterance text.length 算 |
| `loadVoices()` 1500 ms hard cap | **不改** | 启动一次即可，后续 cache hit |
| `voicesChangedListener` dispose 路径 | **不改** | 现有正确 |
| `isSpeechActive()` safety-net (App.tsx:445-448) | **不改** | drain-hold 期间 isActive 仍返回 true（session 还在），符合预期 |
| `pendingSpeak` 跨 tab 重放 | **不改** | 走 supersede |
| voice-registry 选音 | **不改** | enqueue 出的每个 chunk 仍走 `ensureVoice(locale)` |
| `setSpeechFilterMode` / `prepareForSpeech` | **不改** | enqueue 内部也调它，slice 不带 markdown 的概率高，scrubToolNoise 也照跑 |

**新引入的 race 风险点 + 防御**：

| 风险 | 防御 |
|------|------|
| message_start 前 content_block_delta 抢到（SDK 不保证顺序？） | 实测 SDK 严格按 message_start → block_start → delta → block_stop → message_stop 顺序。即使乱了，没有 currentTurn 时收到 delta 直接丢弃即可。 |
| 同一时刻两个 turn 并行（不应该，但防御性） | activeSession 单例 + turnId 比对：不同 turnId 直接 supersede。 |
| drain-hold 期间 cancelSpeech 来了 | cancel 走现有路径，清 timer 在 session 销毁分支顺手做：`if (session.drainHoldTimer) clearTimeout(session.drainHoldTimer)`。 |
| message_stop 比最后一个 delta 还早到 | 不可能，SDK 协议保证。 |
| splitSentences 在 buffer 末尾切出来的"最后一句"恰好以句号结尾 → 永远不会被算作"completed" | 该场景下 ready.length === 1（整 buffer 就一句），slice(0,-1)=[]，正确等下一个 delta 或 block_stop。content_block_stop 时 flush 路径无门槛，会念出来。 |
| `indexOf(joined)` 拼接后字符串若包含被 `prepareForSpeech` 改写的字符（如代码块占位符 `[[CODE_BLOCK]]` 被替换成"我写了大概 X 行代码"），buffer.indexOf(joined) 会找不到 | **不能用 indexOf**。改：累积 `fedUpTo` 用原始 buffer 长度记，不依赖字符串匹配。即 `newPrefix = sum(prepareForSpeech 之前的源 chunk 文本长度)`。**对策**：splitSentences 返回的每个元素都来自原 buffer 的连续切片，记 `lastFedEndIndex = 上一次切出的"完成句"在原 buffer 中的 end`，下一次从这里继续取 substr。最干净的实现是让分句逻辑直接返回 `{start, end, text, locale}`，但**这又改了 splitSentences 签名**。**折中**：在 store 这层做"已 enqueue 的句子总长度 = sum(c.text.length for c in toSend)"，下次 splitSentences 输入用 `buffer.slice(fedUpToInBuffer)` 而不是全 buffer。这样 fedUpToInBuffer 就是原始 byte 偏移。 |

**最后这条特别关键**，重写伪代码：
```
const remainingInput = turn.buffer.slice(turn.fedUpToInBuffer)
const ready = splitSentences(remainingInput)
if (ready.length <= 1) return                   // 最后一句还可能继续
const toSend = ready.slice(0, -1)
const consumedText = toSend.map(c => c.text).join(' ')  // splitSentences 已 trim
// 用消耗的字符数（按 splitSentences 切完前的原始顺序）推进 cursor
// splitSentences 内部 split + trim，长度未必严格等于原始 substring 长度
// 因此 cursor 推进的"安全"做法：找 ready[-1] 在 remainingInput 里的起始位置
const lastIdx = remainingInput.lastIndexOf(ready[ready.length-1].text)
if (lastIdx <= 0) return  // 防御
turn.fedUpToInBuffer += lastIdx
// 把 toSend 直接传给 enqueueConversational（注意 enqueue 接收 raw string；这里要拼回去）
const sliceText = remainingInput.slice(0, lastIdx)
enqueueConversational(sliceText, turn.turnId)
```

简单可靠，不依赖 splitSentences 内部行为。

---

## 7. 不动的地方（明确列出）

- `speech-format.ts` 全部函数。
- `voice-registry.ts` 全部。
- `useSpeech.ts` 的 `useVoices`、`useContinuousSpeech`。
- `cancelSpeech / aiSpeaking / speakingRef` 闭环逻辑。
- worker（非 talker）的所有 TTS 相关路径 —— worker 本来就不该出声音。
- `recap.ts` 的 `includePartialMessages: false`。

---

## 8. 实施顺序（给执行 worker 的）

1. **先改 speech-session.ts**：拆 SpeakSession 字段、把 chunks/index 提到 session 上、写 `enqueueConversational` + `markTurnComplete` + drain-hold + `finalizeSession`。**不开 SDK 流式**，先用单元测试 / 手工调 enqueueConversational 验通这块。
2. **去掉 speakConversational 入口的无条件 cancel**（`if (this.activeSession) this.cancel(true)`）。
3. **扩 setSpeakCallback 的 API**：从 `(text) => void` 改成 `{ supersede, enqueue, markTurnComplete }` 对象。App.tsx 适配。
4. **改 meeting-store**：加 StreamingTurn 字段、handleMessage 增加 stream_event 分支、终态 de-dup、barge-in flag。
5. **最后才开 SDK 流式**：claude-session.ts 的 talker 那一路 `includePartialMessages: true`。
6. **回归测试**：
   - 短回复（单句）：应该正常播放，aiSpeaking 一次开一次关。
   - 长回复（5+ 句）：第一句应在 SDK 出第 N 个 token 时就开播，前几句一句接一句。
   - barge-in 中段：当前句念完句末，后续 delta 静默吞掉，终态不复播。
   - narrateAssistantLine 夹在流式中：流式被打断，主动话播完后会议正常继续。
   - tab 切换：背景 tab 的 partial 不出声，pendingSpeak 在切回时按 supersede 重放。

---

## 9. 与其它正在并行 worker 的协作面

- **`exec-tts` / `fix-tts-streaming`**：本方案的 §4 + §5 是给他们的实现规范。speech-session.ts 是冲突高发区，建议 §4 的改动**单 PR、单一 owner**。
- **`exec-llm` / `plan-llm`**：talker 模型/队列修正可能也要改 claude-session.ts，§3.1 的 `includePartialMessages: true` 与他们没冲突，但建议两人协商把这行改动合到同一个 PR。
- **`exec-main-ipc`**：可能在 main.ts/preload.cjs 加 stream 单通道，本方案当前继续走 `session:event`，不阻塞；他们之后要加专用 channel 时只需在 meeting-store 增加另一个 onEvent 订阅，分发逻辑同。
- **`exec-whisper`**：与 TTS 路径完全无关，无冲突。

---

## 10. 收益估算复核

- 阶段 1（等整段回复）：1000–4000 ms → 200–500 ms（首句到位）
- 阶段 6（无条件 cancel）：5–50 ms → 0–5 ms
- 阶段 9（macOS 首句）：80–300 ms → 不变（warmupTTS 已经处理）

**首字延迟净改善：≈ 800–3500 ms / 句，即 60–80% 输出侧延迟。**

后续句节奏：取决于 LLM 出句速度。LLM 慢于 TTS 时由 drain-hold 兜住，不抖 mic；LLM 快于 TTS 时队列自然堆，按 40 ms 句间正常播。
