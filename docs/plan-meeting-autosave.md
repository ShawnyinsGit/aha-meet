# Plan — 会议结束自动保存记忆 (auto-recap → memory)

> **关键前提**：仓库里 **已经有** 一条完整的 "end-of-meeting → Haiku → memory.json" 管道
> （`electron/recap.ts` + `Orchestrator.end()` 触发）。本方案 **不是新建** 抽取器，
> 而是 **补齐** 它周围缺失的部分：素材源不全、去重缺失、UX 完全静默、失败不可见、
> 没有用户开关。下游 worker 在动手前先读这一段，避免重写已有逻辑。

---

## 0. 现状速读（避免重复造轮子）

| 维度 | 现状 | 文件:行 |
| --- | --- | --- |
| 单一触发点 | `Orchestrator.end()` — 所有关闭路径都经它 | `electron/orchestrator.ts:290` |
| 抽取器实现 | `startRecap()` — Haiku-4.5 + RECAP_PROMPT，JSON 数组输出 | `electron/recap.ts:46` |
| 抽取 Prompt | 4 分类 schema (`point/decision/todo/fact`)、严格 JSON、含 secret 排除指引 | `electron/orchestrator-prompts.ts:49` |
| 输入素材 | 仅 `talkerTranscript` (user+assistant 文本)，tail-cap 12000 chars，min 4 turns | `electron/recap.ts:84-90`、`orchestrator.ts:505-530` |
| 写入校验 | `appendEntry()` 已做 secret-pattern 过滤 + 500 字截断 + 10 tag 截断 + projectId 隔离 + 写锁 | `electron/memory.ts:166-205` |
| 多 tab 隔离 | 每个 Orchestrator 独立的 transcript / recap / sessionId；memory 写锁全局序列化 | `electron/orchestrator.ts:106,111` + `electron/memory.ts:82-91` |
| 已支持的取消 | `session:interrupt` 经 B4 路径能 abort 进行中的 recap | `electron/orchestrator.ts:263-266` |

**实际缺什么**：UX 完全静默；worker 交付不入料；决策文档不入料；无去重；失败不告知用户；无开关。

---

## 1. 触发点设计

### 1.1 单一 Choke Point：`Orchestrator.end()`

所有"会议结束"路径都汇聚到这里：

| 用户动作 | IPC / 事件 | 进入 `end()` 的路径 |
| --- | --- | --- |
| 关闭单个 tab（× 按钮） | `sessions:close` → `slot.orchestrator.end()` | `electron/ipc/sessions.ts:197` |
| 旧版 "结束会话" 按钮 | `session:end` → `slot.orchestrator.end()` | `electron/ipc/session.ts:112` |
| 关闭最后一个窗口 | `window-all-closed` → `shutdownAllSlots()` 遍历 `slot.orchestrator.end()` | `electron/main.ts:373` |
| Cmd-Q / 强退 | `before-quit` → 同上 + 等待 `endPromise`（5s cap） | `electron/main.ts:393` |
| Talker 子进程意外退出 | 内部 `onTalkerEvent` 触发 `void this.end()` | `electron/orchestrator.ts:501` |
| `sessions:open` 启动失败 / 重复 | 兜底 `orch.end()` | `electron/ipc/sessions.ts:127, 173` |

`endPromise` 缓存让重复调用幂等（`orchestrator.ts:291`），多次触发只跑一遍 recap。
**结论：触发器不用新增；只需要在 recap 完成 / 失败 / 跳过时，给 renderer 推一个新事件。**

### 1.2 多 Tab 行为

- 每个 SessionSlot 持有独立的 `Orchestrator` → 独立 `talkerTranscript` + 独立 `recapHandle` → 独立 recap pass。
- `emitToRenderer({ ..., sessionId })` 已经把每条事件预绑定到来源 tab（`main.ts:202-210`）。
- 渲染端的 toast / 预览只需要按 `event.sessionId` 路由到对应 MeetingState slot。
- Cmd-Q 时 N 个 tab → N 次并发 Haiku 调用。这是已有行为，且 `before-quit` 给 5s 上限再 `app.exit(0)`（`main.ts:403`）—— 长 transcript 的 recap 会被砍掉，新方案要尊重这点（**不能** 把超时拉得更长，否则阻塞退出）。

### 1.3 `beforeunload`

renderer 端没有显式的 `beforeunload` 处理；reload / 关窗都走 Electron 主进程的 `window-all-closed`。无须在 React 层加 hook。

---

## 2. 抽取策略

### 2.1 复用现有 Haiku 调用，**不再起第二次 LLM 调用**

`recap.ts` 已经做的事情 — **保留**：

- 模型：`claude-haiku-4-5`（便宜、快、足够）
- 无工具 / 无 MCP / 无 skills（纯 prompt-in JSON-out，杜绝意外副作用）
- Schema 等同于 `MemoryCategory`：`point | decision | todo | fact`
- 单条 ≤ 500 字、tags ≤ 10、secret patterns 全量过滤
- 失败安全：解析失败、数组为空、`isAborted` 都直接 return，不污染 memory.json

### 2.2 **补强输入素材**（核心改动）

当前 `recap.ts:84` 只用 `talkerTranscript`。下面三类信号要并入 prompt 输入，让 Haiku 看到完整画面：

| 信号 | 现在在哪 | 取法 | 处理方式 |
| --- | --- | --- | --- |
| **Talker 转录** | `Orchestrator.talkerTranscript: TalkerTurn[]` | 已有 `[...this.talkerTranscript]` snapshot | 主输入（保留现状） |
| **Worker 交付摘要** | `scheduler.markTaskDone` 用 `talker.sendUserText('(worker X done) ...', 'low')` 推回 Talker（`worker-scheduler.ts:297`），但 task_done summary 本身**只发往 Talker 的 user 队列**，未必能在 talkerTranscript 里完整体现 | 新增 `Orchestrator.workerDeliveries: Array<{ workerId, title, summary, ts }>`，在 `markWorkerTaskDone` 写入；`end()` 时一并 snapshot 传给 `startRecap` | 在 prompt 里拼一段 `## 本次会议交付` 列表（`- worker-X: <summary>`） |
| **决策文档** | `Orchestrator.decisionMeta: Map<id, { question, path }>` 已存活在内存（`orchestrator.ts:117`） | snapshot `[...decisionMeta.values()]`；如果对应 `.md` 里 `parseConclusion` 非空，把"问题 + 结论"拼进去 | 拼成 `## 本次会议决策` 段；让 Haiku 优先把这些标成 `decision` 类目 |

**注意**：拼接顺序固定为「Talker 转录 → 决策段 → 交付段」，便于 `RECAP_TRANSCRIPT_CHAR_CAP = 12_000` 的 **tail-truncate** 在素材稀缺时优先保留最新对话；如果决策 / 交付段总长 > 4 KB，做 head-truncate（决策更"重要"但旧）。**别加新 LLM**：所有三段一次性塞进同一次 Haiku 调用。

### 2.3 RECAP_PROMPT 微调（建议）

现 prompt 已经够清晰；加两行让 Haiku 知道新素材：

```
输入分三段：
1) 「## 对话」  Talker 与用户的逐字记录
2) 「## 决策」  本次会议生成的决策文档（含问题与结论；结论为空表示未拍板）
3) 「## 交付」  各 worker 完成时上报的一句话总结

如果一条决策有非空结论 → 必为 decision 类目，content 写"问题 → 结论"。
worker 交付里包含具体文件 / 模块名时 → 优先归 fact 或 todo，content 写一句"X 已完成 Y" / "X 待跟进 Y"。
```

---

## 3. 去重与叠加策略

`appendEntry` 现在是 **blind append**。三种最常见的重复：

| 重复类型 | 触发场景 | 处理建议 |
| --- | --- | --- |
| **几乎相同 content** | 用户两次会议都提到 "我是数据分析师" | 在新抽取的 `MemoryEntry` 写盘前，对同一 `projectId` 内已有 entry 做一遍**归一化字符串相似度**（小写、去标点、collapse 空白，Jaro-Winkler ≥ 0.92 即视为重复）。命中则 `updateEntry`：合并 tags（去重）、刷新 `updatedAt`、`sourceMeetingId` 改成本次。 |
| **同义但措辞不同** | "Talker 用 Haiku" vs "面向用户的模型选 Haiku 4.5" | 第一版**不处理**。Jaro-Winkler 解决不了语义同义；上语义需要 embedding，留作 v2。 |
| **类目搬家** | 上次抽成 `todo`，这次该是 `decision`（已经做了） | 命中相似度阈值时，若新类目是 `decision` 或 `fact`（更"硬"），覆盖旧类目；其他情况保留旧类目。 |

去重要点：

- **scope 必须 == projectId**：不同项目里的同句话是不同事实。
- **不要跨类目去重**：`todo` 和 `decision` 即便 content 一样也是不同信息状态。
- 实现位置：新增 `electron/memory.ts:mergeOrAppend(entry, opts?: { simThreshold })`，recap 调它而不是直接 `appendEntry`。MCP `save_memory` 工具也切到这个新函数（保证 Talker 主动 save 时同样不会复制），同时保留 `appendEntry` 给已有调用方。
- 单次 recap 内最多写 **15 条**（防一次会议噪声炸库）；超过按 Haiku 输出顺序截断（它的输出本来按重要度排）。

---

## 4. UX 决策

### 4.1 默认行为：**静默保存 + 完成 toast**（推荐）

理由：

- 用户在语音会议里离场，**根本不会回头看预览面板**。强行弹窗 = 流程中断。
- 已有 secret-pattern 过滤 + 500 字截断 + 项目隔离，"误存"的破坏面很小。
- 错存的也容易在 MemoryPanel 里删 / 改（`MemoryPanel.tsx` 已有 inline edit + delete）。

落地：

- recap 完成时 emit 新事件 `{ kind: 'recap-done', savedCount, mergedCount, skipped: false }`。
- renderer 在对应 tab 关闭后弹一条**全局 toast**（不绑定 tab，因为 tab 已经没了）：
  - 成功：`📝 已记住 N 条要点 · 查看`（"查看"打开 MemoryPanel 并 filter 到 `sourceMeetingId == <thisMeetingId>`）
  - 全跳过：`这次没找到值得记的`（meeting < 4 turns 或 Haiku 返回 `[]`）
  - 失败：`没能整理记忆：<reason> · 重试`（重试调一个新 IPC `memory:recap-retry({ meetingId })`，从 transcript-store 的 jsonl 重新取料）

### 4.2 可选：高级用户的 "保存前预览"

`SettingsMenu` 新增一项 `会议结束时`：

- `自动保存（默认）`
- `先预览再保存`
- `不抽取`

只有选了"先预览再保存"，recap 完成后才弹一个**可拖动的小卡片**列出抽到的 N 条，每条带 ✓（保留）/ ✏️（编辑）/ ✗（丢弃）。10 秒无操作 → 默认全部保留（fail-open，因为整个特性默认是要"记住"）。

### 4.3 失败兜底

- Haiku 调用失败 / 网络断 / API 配额 → 当前是 `console.warn` 静默。改成 emit `{ kind: 'recap-done', error: '<msg>' }`，UI 弹 toast 并提供"重试"。
- 重试入口：用 transcript-store 里持久化的 `${projectId}.jsonl`（已有）reconstruct transcript → 重跑 recap。注意：worker deliveries / decisionMeta 是内存态，meeting 关闭后没法重建；retry 只能基于 transcript。说明在 toast 文案里写清楚。

### 4.4 离线 / 无 API key 场景

- `authMode === 'apikey'` 但 `anthropicApiKey` 空 → recap 调用会立即失败。`recap.ts` 入口先检查 `getSettings()`，缺 key 时直接 `return null` 并 emit `{ kind: 'recap-done', skipped: true, reason: 'no-auth' }`。
- 不要在 toast 里反复念叨这个；首次该状态 emit 一次"未配置 Anthropic 凭证，会议记忆已停用 · 去设置"，之后同一会话不再提示。

---

## 5. 边界与限制

| 边界 | 处理 |
| --- | --- |
| **空会议**（< `RECAP_MIN_TRANSCRIPT_ENTRIES = 4`） | 已经跳过；新增 emit `{ skipped: true, reason: 'too-short' }`，UI **不弹 toast**（避免每次空开都骚扰）。 |
| **超长 transcript** | 已有 `RECAP_TRANSCRIPT_CHAR_CAP = 12_000` tail-truncate。新增决策段 / 交付段后，整体输入控在 16 KB 以内（≈ 5K Haiku tokens）。多了切尾。 |
| **Cmd-Q 超时被 SIGKILL** | `before-quit` 给 5s。N 个 tab 并发 recap 在 5s 内大概率跑完（Haiku 短 prompt 通常 1-2s）。**不要** 把超时拉到 10s+；交给"下次启动时检测未完成的 jsonl 转录 → 主动 retry"是更稳的兜底（不在本版本范围）。 |
| **与现有 `request_user_decision` 流冲突** | 决策文档已经在 `~/Documents/AhaMeet/decisions/` 写盘了，recap 不再生成它；recap 只**读** decisionMeta（内存）+ 可选 `parseConclusion()`（如果决策 md 还在）来把结论入 memory。两个流不要互相调用。 |
| **与现有 `narrate_to_user`、`(worker X done)` 注入冲突** | 这些都已经走 Talker → 落到 `talkerTranscript`；新方案的"worker 交付段"会和 talker 末尾的 `（会话结束前各 worker 最后动作）` 段（`orchestrator.ts:308-325`）部分重复。**接受**这种冗余 — Haiku 会自然去重；强行剔除复杂度大于收益。 |
| **MCP `save_memory` 仍然可被 Talker / Worker 主动调用** | 保留。recap 是被动兜底，不取代主动 save。两条路径都走新 `mergeOrAppend` 即可避免双写。 |
| **memory.json 体积** | 现仅做 `MAX_CONTENT_CHARS` + `MAX_TAGS` 限流，无总条数上限。引入 recap 后增速变高。**本版本不动**；超过 5000 条时再加 LRU 淘汰（独立 task）。 |
| **secret 泄漏** | 现有 5 个 secret regex + `appendEntry` 拦截 + RECAP_PROMPT 末尾"排除... 明显敏感信息"。**够用，不动**。 |

---

## 6. 文件级拆解表

| 文件 | 改动性质 | 由谁 |
| --- | --- | --- |
| `electron/recap.ts` | 改 `RecapOpts` 增加 `workerDeliveries` 和 `decisions` 两个可选字段；改 `runRecap()` 把三段拼接成 prompt input；调用 `mergeOrAppend` 替代 `appendEntry` | **exec-autosave-extractor** |
| `electron/orchestrator-prompts.ts` | 在 `RECAP_PROMPT` 末尾追加"输入分三段"说明 + 决策 / 交付的归类指引 | **exec-autosave-extractor** |
| `electron/orchestrator-helpers.ts` | 可能需要 `RECAP_DELIVERIES_CHAR_CAP = 4000` 等新常量 | **exec-autosave-extractor** |
| `electron/memory.ts` | 新增 `mergeOrAppend(entry, opts?)`：projectId+category 内做归一化 + Jaro-Winkler，命中阈值则 `updateEntry`，否则 `appendEntry` | **exec-autosave-extractor** |
| `electron/orchestrator.ts` | (1) 新增 `private workerDeliveries: Array<{ workerId, title, summary, ts }> = []`；(2) `markWorkerTaskDone` 同步 push 进去；(3) `end()` 时一并 snapshot 传给 `startRecap`；(4) 把 `decisionMeta` 也 snapshot 传进去；(5) recap 完成后 emit `{ source: 'system', event: { kind: 'recap-done', ... } }` | **exec-autosave-trigger** |
| `electron/orchestrator-types.ts` | 新增 `RecapDoneEvent` 类型加入 `SystemEvent` union（`{ kind: 'recap-done'; savedCount: number; mergedCount: number; skipped?: boolean; reason?: string; error?: string; meetingId: string }`） | **exec-autosave-trigger** |
| `electron/ipc/memory.ts` | 新增 `memory:recap-retry({ meetingId })` 处理器（读 transcript-store jsonl，无 deliveries / decisions，重跑 recap） | **exec-autosave-trigger** |
| `electron/preload.cjs` | 暴露 `memory.recapRetry(meetingId)` | **exec-autosave-trigger** |
| `electron/store.ts` | `Settings` 新增 `recapMode?: 'silent' \| 'preview' \| 'off'`（默认 `'silent'`） | **exec-autosave-ui** |
| `src/components/SettingsMenu.tsx` | 新增"会议结束时"段，三选一 radio | **exec-autosave-ui** |
| `src/lib/meeting-store.ts` | 监听 `recap-done` 事件 → 推入新的 `recapToasts: RecapToast[]` 队列；同时在 `recapMode==='preview'` 时存 `pendingRecap: PreviewState` 让 UI 弹卡片 | **exec-autosave-ui** |
| `src/components/MemoryPanel.tsx` | 支持 URL/state 入口 `?meeting=<id>` 自动 filter `sourceMeetingId`（toast 的 "查看" 链接到这里） | **exec-autosave-ui** |
| `src/components/RecapToast.tsx`（新文件） | 全局 toast UI：成功 / 跳过 / 失败三态；带"查看" / "重试"按钮 | **exec-autosave-ui** |
| `src/components/RecapPreview.tsx`（新文件，仅 preview 模式） | 列出待保存条目，逐条 ✓ ✏️ ✗，10s 默认全收 | **exec-autosave-ui** |
| `src/App.tsx` | mount `<RecapToast />` 全局；preview 模式下条件 mount `<RecapPreview />` | **exec-autosave-ui** |
| `src/types.ts` | 镜像 `RecapDoneEvent` 类型 | **exec-autosave-ui** |
| 构建 + 冒烟 | `npm run build` + 开两个 tab → 各说几句 → 各自关闭 → 验证 toast；Cmd-Q → 验证 memory.json 真有新条目；改 settings 为 preview → 验证卡片；删 anthropic key → 验证 `no-auth` 路径 | **verify-autosave** |

---

## 7. 并行工作分割（worker 协作守则）

| Worker | 改的文件 | 是否会撞车 |
| --- | --- | --- |
| exec-autosave-extractor | `recap.ts`、`memory.ts`、`orchestrator-prompts.ts`、`orchestrator-helpers.ts` | 与 trigger 在 `orchestrator.ts` 不冲突；与 ui 在 `types.ts` 字段加法上需要协调字段名 |
| exec-autosave-trigger | `orchestrator.ts`、`orchestrator-types.ts`、`ipc/memory.ts`、`preload.cjs` | **与 ui worker 在 `orchestrator-types.ts` / `preload.cjs` 会撞**，建议它先合 `RecapDoneEvent` 类型再让 ui worker 拉取 |
| exec-autosave-ui | `store.ts`、`SettingsMenu.tsx`、`meeting-store.ts`、`MemoryPanel.tsx`、`App.tsx`、`types.ts`、两个新组件 | 等 trigger worker 把 `RecapDoneEvent` 加好再开工 UI 监听；新组件文件不撞 |
| verify-autosave | 不写代码 | 最后跑 |

**字段约定**（提前固定，避免三个 worker 拼字段名拼错）：

```ts
interface RecapDoneEvent {
  kind: 'recap-done';
  meetingId: string;        // Orchestrator.meetingId
  savedCount: number;       // new entries written
  mergedCount: number;      // entries updated via mergeOrAppend
  skipped?: boolean;        // true when too-short / no-auth / aborted
  reason?: 'too-short' | 'no-auth' | 'aborted' | 'empty-result';
  error?: string;           // present iff Haiku call failed; mutually exclusive with skipped
}
```

---

## 8. 验收清单（verify-autosave 跑）

- [ ] `npm run build` 两套 tsconfig 都过（`tsconfig.json` + `tsconfig.electron.json`）
- [ ] 单 tab：说 6+ 句 → 关 tab → toast "已记住 N 条要点" → 点"查看"进入 MemoryPanel 看到本次条目
- [ ] 多 tab：开 2 个 tab 各说几句 → Cmd-Q → 重启 → memory.json 两个 projectId 都有新条目
- [ ] 空会议：开 tab → 不说话 → 关 tab → **无 toast**
- [ ] 去重：同一项目连开两次会都说"我是 X 角色" → memory.json 里同 projectId+category 没有两条几乎相同的 entry，`updatedAt` 被刷新
- [ ] 决策入料：用 `request_user_decision` 出一份决策 md → 填结论 → 关 tab → memory 里有一条 `decision` 类目记录"问题 → 结论"
- [ ] 失败路径：临时把 `anthropicApiKey` 清空 → 关 tab → toast "未配置 Anthropic 凭证..."，**只显示一次**
- [ ] preview 模式：设置切到 preview → 关 tab → 卡片出现 → ✗ 一条 → 剩余条目落盘
- [ ] interrupt 路径：开始关 tab 后立刻按 interrupt → recap 中止，memory.json 无写入，toast 显示 "已取消"

---

## 9. 显式不做的（避免范围蔓延）

- 不引入 embedding-based 语义去重（v2）
- 不做跨项目记忆迁移
- 不改 `MemoryPanel` 现有交互（仅加入 URL filter 入口）
- 不动 `request_user_decision` / `createDecisionDoc` 流程
- 不引入 LRU 淘汰 memory.json（独立 task）
- 不改 `RECAP_TRANSCRIPT_CHAR_CAP` / `RECAP_MIN_TRANSCRIPT_ENTRIES`（先观察新素材接入后效果）
- 不在 `before-quit` 加长 5s 超时
