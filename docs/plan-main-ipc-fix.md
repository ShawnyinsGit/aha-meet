# vibe-meet 主进程 / IPC / 预热 修复方案

> 范围：基于 `docs/probe-renderer-ipc.md` 的探查结论，针对 `sessions:open`、`buildClaudeShadowHome`、`store.ts`、settings/memory 落盘、`documents:read` 五处给出具体可执行的改造方案。
>
> **现状基线（已读完代码确认）：**
> - `fix-top` 已经把 `transcripts:append` 改成 `ipcRenderer.send` + `ipcMain.on`，本方案不再涉及；只在末尾给一条 follow-up（renderer 侧 `Promise.resolve({ok:true})` 桥接可以彻底丢掉返回值）。
> - 其它四处全部未动，与 probe 报告描述一致。

---

## 1. `sessions:open` — 立即返回 sessionId，后台 start

### 现状
`electron/ipc/sessions.ts:105` 在 `ipcMain.handle('sessions:open', …)` 里 `await orch.start(greeting)`。`orchestrator.start` 内部要 spawn Claude Agent SDK 子进程 + meeting-mcp + 拉 memory + 等握手，实测 400–1200 ms。这段时间 renderer 的 `await sessions.open(...)` 一直挂着，UI 看到 "loading" 半秒到一秒以上。

启动失败的 fallback 也在 await 里：失败时 `registry.close(sessionId)` + 返回 `{ok:false}`。

### 目标状态
1. handler 走完 cwd 校验 + duplicate 检查 + `registry.open` + `setActive` 后立刻返回 `{ ok: true, sessionId, cwd, status: 'starting' }`。
2. 在背景 promise 里继续 `orch.start(greeting)`：
   - 成功：`ctx.emitToRenderer({ source:'system', sessionId, event:{ type:'session-ready', sessionId } })` + 调一次 `snapshotOpenTabs(ctx)` + `pushRecentCwd`（如果是真实用户输入）。
   - 失败：emit `{ type:'session-start-failed', sessionId, error }` + `registry.close(sessionId)` + `try { orch.end() } catch {}` + 再 snapshot 一次让 openTabs 一致。
3. 渲染端在 meeting-store 里新增 `slot.status: 'starting' | 'ready' | 'failed'`，收到 `session-ready` 转 `ready`；`useSpeech` / `sessionsApi.send` 在 `ready` 之前对该 slot 不发 talker 输入（要么静默丢，要么 buffer 一份等 ready 后回放——见下面"回归风险"）。

### 具体改动点
| 文件 | 改动 |
|------|-----|
| `electron/ipc/sessions.ts` | 把 `await orch.start(greeting)` 拆成 fire-and-forget，加 `void (async () => { ... emit ready/failed ... snapshotOpenTabs ... })()`。`pushRecentCwd` 移进成功分支。返回值里加 `status:'starting'`。 |
| `electron/ipc/context.ts` | `IpcEmittedEvent` 已带 sessionId，无需改；若复用现有 `session-ready` 类型不存在则在 `OrchestratorEvent` 联合里加一条 system-level 事件。 |
| `src/lib/meeting-store.ts` | `slots[id]` 新增 `status` 字段，默认 `'starting'`；`session-ready` 改 `'ready'`；`session-start-failed` 改 `'failed'` 并清掉 slot。 |
| `src/components/TabStrip.tsx` / `MeetingHeader.tsx` | 渲染 `status==='starting'` 时显示加载状态（旋转点 / 文案）；`status==='failed'` 显示重试按钮。 |
| `src/hooks/useSpeech.ts` / 任意调用 `sessions:send` 的入口 | 提前判断 `slot.status !== 'ready'` 则把用户输入暂存到 `slot.pendingInput`，`session-ready` 触发时回放并清空。 |

### 兼容 / 错误处理 / 回归风险
- **兼容**：返回 `{ ok:true, sessionId }` 的形状没破，旧 renderer 仍能拿到 sessionId；只是少了"start 已完成"的隐含语义。同 PR 一定要改 renderer 侧把 `ready` 当作门控。
- **错误处理**：start 失败现在变成 "先 ok 后 fail" 两段。renderer 必须在 `session-start-failed` 后把 tab 标 failed 而非默默回到 placeholder；并允许用户点 "Retry" 重新触发 `sessions:open`（带相同 cwd → 已 close 的 slot 不会触发 duplicate）。
- **回归风险 1（最严重）**：用户在 `ready` 之前对着麦说话。当前实现 `await start` 隐含等 SDK ready 才允许发送；改完之后必须确保 ASR 转写或者直接 talker 输入会被 `pendingInput` 缓冲。如果不做缓冲就直接发 `session:send`，orchestrator 这边没拿到 SDK handle，会抛 / 静默丢。**这是必须配套改 renderer 的硬约束。**
- **回归风险 2**：`snapshotOpenTabs` 的时机变了——以前 start 失败时绝不持久化 openTabs；改后我们要在 background 失败回调里再调一次 snapshot 才能让 openTabs 和真实 registry 一致。务必加上。
- **回归风险 3**：duplicate 路径仍然要立即 snapshot + setActive，逻辑不动。
- **回归风险 4**：测试要覆盖 "用户立即关闭刚开的 tab、还没 ready" 的路径——`sessions:close` 已经会 `orch.end()`，背景 start 里 `closed=true` 应该让 `safeEmit` 不再发事件，但要确认 `orch.start` 自己对 `end()` 中途调用的容忍度。

### 预期收益
新建 tab 体感时延 −400 ~ −1200 ms。

---

## 2. `buildClaudeShadowHome` — 移出 launch 关键路径

### 现状
`electron/claude-defaults.ts:50-121` 完全同步：
- 启动时先 `rmSync(shadowDotClaude, recursive:true, force:true)` 整树删除上一次的 shadow（全是 symlink，遍历仍然要 stat 上千次）。
- `mkdirSync` + 三轮 `readdirSync` + 每条 `symlinkSync`：典型一份 ECC 默认 60 agents + 75 commands + 181 skills/ecc + 用户自己的 ~/.claude 顶层 5–20 项 → 几百次 syscall。
- 全在 `app.whenReady().then(() => { ... createWindow() })` 之前跑（`electron/main.ts:286-305`）。测出来这一段 50–200 ms，纯阻塞，window 都还没创建。

dev mode 直接 return，没问题。

### 目标状态
1. **createWindow 先跑**：whenReady 里第一件事是 `createWindow()` + 触发 `loadURL` / `loadFile`，让 BrowserWindow 进程并行启 Chromium。
2. **shadow 构建后台跑**：`buildClaudeShadowHome()` 包成 `void Promise.resolve().then(() => { ... })`，结果写进一个 `claudeShadowHomeReady: Promise<string | null>`。
3. **`sessions:open` 在用到 shadow 前 `await` 一次**：`const shadow = await claudeShadowHomeReady;` 紧贴 `mergedSubprocessEnv()` 之前。绝大多数用户从看到 UI 到点 "Open" 至少需要 1–3 秒，shadow build 早就完成；await 是空等。
4. **省掉一次"每次启动全量重建"**：在 `userData/claude-shadow/.shadow-manifest.json` 记录上次构建时的 bundled root mtime + 用户 4 个 merge dir 的 mtime。下次启动 mtime 全部命中 → 直接返回上次的 `home`，跳过 rm + readdir + symlink。任一 mtime 变化 → 走老路径重建。

### 具体改动点
| 文件 | 改动 |
|------|-----|
| `electron/claude-defaults.ts` | 把整个函数体改成 `async function buildClaudeShadowHome(): Promise<ClaudeHomeResult>`，内部用 `fs.promises.*`。在函数入口加 manifest 检查：mtime 命中则直接返回缓存。把 `safeSymlink` 也改 async。 |
| `electron/main.ts:286` | `claudeShadowHomeReady = buildClaudeShadowHome().then(r => { claudeShadowHome = r.home; ... }, err => { ...; return null });`，**不 await**。后续 createWindow 紧接着调。 |
| `electron/ipc/context.ts` | `getClaudeShadowHome` 改成返回 `Promise<string | null>`（或新增 `awaitClaudeShadowHome()`）。 |
| `electron/ipc/sessions.ts:76` | `const shadow = await ctx.awaitClaudeShadowHome();` 替换现在的 sync getter。 |

### 兼容 / 错误处理 / 回归风险
- **兼容**：shadow 构建结果对外只有一处消费（`sessions:open`），把那一处改 await 即可；其它地方不接触。
- **错误处理**：manifest 文件损坏 / 解析失败 → fall back 到全量重建路径（不要因为 manifest 解析挂掉就崩 app）。symlink 失败仍然走 `safeSymlink` 静默忽略。
- **回归风险 1**：用户在 shadow 还没建完时极速点 "Open"——会被 `await claudeShadowHomeReady` 阻塞 50–200 ms，但比当前 100% 启动阻塞好。
- **回归风险 2**：manifest 缓存命中但用户在 app 退出后手动 `rm -rf ~/Library/Application Support/.../claude-shadow` → next launch 因为 manifest 还在但目录已删，`safeSymlink` 走老 target 失效。**对策**：manifest 校验时额外 `fs.access(shadowDotClaude)`，不存在就走全量。
- **回归风险 3**：用户在 `~/.claude/agents/` 新增 / 删除文件后启动 app，mtime 校验必须能感知。Node 的 `fs.stat(dir).mtime` 在文件增删时会更新，方向上靠得住；但跨文件系统 atime/mtime 行为差异——保守一点同时校验 `mtime` + `birthtime` + 顶层 `ls` 长度（写进 manifest）。
- **回归风险 4**：用户把整个 `~/.claude` 软链到其他目录，realpath 可能跳出 mtime 感知范围——manifest 失败时落回全量重建。

### 预期收益
冷启动首屏 −50 ~ −200 ms（首次仍 100–250 ms，含 mkdir/readdir + manifest 写入；二次启动 < 5 ms）。

---

## 3. `store.ts` — 写入异步化 + openTabs 写入合并

### 现状
`electron/store.ts:112-119` 持久化是 `writeFileSync(tmp, ...) + renameSync(tmp, p)`，全同步。调用方包括：
- `pushRecentCwd` —— `sessions:open` 成功后调一次。
- `setOpenTabs` —— `snapshotOpenTabs` 调，`sessions:open/close/set-active` 每次都调。新建 3 个 tab + 切换 1 次焦点 = 4 次同步 fs 往返，几毫秒主线程时间。
- `updateSettings` —— voice-print 录入 / voice-lock 切换 / voice-pref 修改时触发。
- `clearVoicePrint`。

`getSettings()` 用同步 `readFileSync` 首次加载，之后命中 cache，正常路径不阻塞。

### 目标状态
1. **`persist()` 改 `fs.promises.writeFile + rename`**：返回 `Promise<void>`。
2. **单尾 promise 串行写**：模仿 `memory.ts` 的 `withWriteLock`，加一个 `let writeQueue: Promise<unknown> = Promise.resolve();`，避免两次并发 `updateSettings` 在 rename 阶段互踩（macOS APFS 上罕见，但 Linux ext4 上真实）。
3. **`updateSettings` / `pushRecentCwd` / `setOpenTabs` / `clearVoicePrint` 改返回 `Promise<Settings>`**：调用方原本就是 `await` 上下文（sessions:open / settings:set-* 都在 `ipcMain.handle` 的 async 回调里），改异步不破签名语义；但要把 sessions.ts:120 那段 `try { pushRecentCwd(resolvedCwd); } catch (err) { ... }` 改成 `pushRecentCwd(resolvedCwd).catch(err => console.error(...))`，因为方案 1 改完后这一段已经在 background。
4. **`snapshotOpenTabs` 内置 100 ms debounce**：renderer 一次性开 N 个 tab 时（lobby 恢复 / 多 tab 拖入），写盘合并成 1 次。debounce 在 `sessions.ts` 里实现：维护一个 timer，每次调 reset，触发时取最新 snapshot 写。
5. **`getSettings()` 保持同步**：cache 命中，零成本，调用方很多（`sessions:list-restore` 等）不必改 async 链。

### 具体改动点
| 文件 | 改动 |
|------|-----|
| `electron/store.ts` | `persist` 改 async；加 `withWriteLock`；所有写入函数返回 Promise；cache 在 `await fs.rename` 后赋值。 |
| `electron/ipc/sessions.ts` | `snapshotOpenTabs` 改为内部带 debounce 的版本：第一次调 100 ms 后写，期间新调用只刷新 pending 数据。`pushRecentCwd` 改 await（或 `.catch` log）。 |
| `electron/ipc/settings.ts` | `await updateSettings(...)` —— 已经是 async handler，加 `await` 即可。 |
| `electron/main.ts:before-quit` | `await Promise.race([shutdownAllSlots(), sleepMs(5000)])` 之后再加 `await flushSettingsWrites()`（store 暴露的"等待 writeQueue 排空"helper），避免最后一次 openTabs 没落盘。 |

### 兼容 / 错误处理 / 回归风险
- **兼容**：调用方都在 async 上下文里；返回类型从 `Settings` → `Promise<Settings>`，TS 编译期会逼出每一处忘加 await 的地方，迁移可控。
- **错误处理**：写盘失败 console.error，不抛——和现有行为一致。`withWriteLock` 内部失败仍要让 chain 继续，参考 memory.ts 的实现。
- **回归风险 1**：debounce 100 ms 期间 app 突然 crash → openTabs 落盘比 registry 落后 100 ms。`before-quit` 路径手动 flush 一次（取消 timer + sync 一次最新 snapshot）规避正常退出场景；硬 crash 场景接受 100 ms 损失。
- **回归风险 2**：`snapshotOpenTabs` 现在在 `sessions:close` 后返回前调；改 debounce 后，handler 返回时盘上还没写。如果有任何"close 后立即重启 app 验证 openTabs"的测试，会失败。**对策**：close handler 里手动 `flushOpenTabsNow()`。
- **回归风险 3**：`voicePrint` 录入完成的"已保存"toast 现在等 sync 写入完成；改 async 后要 `await updateSettings(...)` 后再发 toast，否则会出现"toast 出现但磁盘还没落"的视感。`settings.ts:18-25` 加 await 即可。

### 预期收益
高峰打开 4 个 tab 场景，settings.json 写盘从 4 次 → 1 次，main 主线程释放 5–15 ms。voice-print enroll 写入不再卡住事件循环 1–3 ms（极小，但顺手）。

---

## 4. `memory.ts` — 同样的 sync → async 改造

### 现状
`electron/memory.ts:144-151` `persist()` 用 `writeFileSync + renameSync`。`withWriteLock` 已经实现得对，把 read-modify-write 串行化了；但每次 write 仍是同步阻塞主线程。memory 写入触发点：
- `mcp__meeting-worker__save_memory` 在 talker 回合结束时调用，单次 1 条；
- `appendEntry` 在 recap 之后 batch 写入若干条 → 当前实现是逐条 await persist，每条都 sync 写，最坏 10 条就是 10 次同步 fs。

`listEntries` / `selectRelevant` 是纯读，命中 cache 后零成本。

### 目标状态
1. **`persist()` 同样改 `fs.promises.*`**，cache 赋值放在 rename 完成之后。
2. **batch 写优化（次要）**：`appendEntry` 现在只能一条条 chain 进 `withWriteLock`，如果 recap 一次性写 N 条，可考虑加 `appendEntries(entries[])`：单次 lock 内 N 条 push + 1 次 persist。
3. **`readFromDisk()` 也改 async（可选）**：影响面很大（`selectRelevant`、`listEntries` 都要 await 化），不推荐第一轮做；先只动 persist。

### 具体改动点
| 文件 | 改动 |
|------|-----|
| `electron/memory.ts` | `persist` 改 async；所有调用 `persist(...)` 的位置加 await。 |
| 调用方 (`appendEntry` / `updateEntry` / `deleteEntry`) | 已经在 `withWriteLock` 的 async fn 里，加 await 即可。返回类型不变。 |
| `electron/meeting-mcp.ts` (`save_memory` handler) | 已 await `appendEntry`，无需改。 |

### 兼容 / 错误处理 / 回归风险
- **兼容**：返回类型不变。
- **错误处理**：unchanged。
- **回归风险**：极低。withWriteLock 的串行语义 + 单 cache 设计已经把唯一可能的竞态封住了。

### 预期收益
recap 阶段 10 条 memory 写入 → 主线程阻塞从 ~20 ms → 0。

---

## 5. `documents:read` — 取消 main 端 base64，改 Uint8Array + Blob URL

### 现状
`electron/ipc/documents.ts:159-202` image / video / word / pdf 全部 `buffer.toString('base64')` 在 main 进程同步跑。8 MB 图片 80–200 ms 阻塞；同时间 ASR `asr:transcribe` 回包 / talker `session:event` 全部排队。

renderer 侧 `src/components/DocumentStage.tsx:264` 直接 `<img src={\`data:${mediaType};base64,${dataBase64}\`}>`，没有 `atob`。Word/pdf 是 main 端用 `parseAttachment` 解析成 text 再回，base64 只是中转给 `parseAttachment`（fn 自己内部解码）——这一段尤其浪费。

### 目标状态
1. **Image / video：返回 `Uint8Array` 而非 base64**。
   - 返回类型新增 `data: Uint8Array | ArrayBuffer; mediaType: string`，标 deprecated 同时保留 `dataBase64`（一个版本过渡）。
   - structured clone 对 Uint8Array 是零拷贝（v8 transfers underlying ArrayBuffer）——payload 缩小 33%，main 端 base64 编码完全省掉。
   - renderer 侧：把字节包成 `Blob` → `URL.createObjectURL(blob)` → `<img src={blobUrl}>`，组件 unmount 时 `URL.revokeObjectURL(url)`。这是浏览器原生路径，图片解码走 GPU，不占主线程。
2. **Word / pdf：main 端不要先 `buffer.toString('base64')` 再让 `parseAttachment` 解回**。
   - `parseAttachment` 现在接收 `dataBase64`；新增重载 `parseAttachmentBuffer(buf: Buffer | Uint8Array)`，直接喂二进制给 mammoth / pdf-parse。
   - 进一步：把 `parseAttachment` 整段移到 `utilityProcess.fork`（next step），main 端只走 fs.readFile + IPC 转发。第一轮可以先只把 base64 去掉，utility-process 放到 follow-up。
3. **大文件 (> MAX_TEXT_BYTES 的 text，或多媒体)：考虑 `protocol.handle('vibe-doc', …)`**（follow-up，非本轮必做）。需要 `protocol.registerSchemesAsPrivileged` 在 `app.whenReady` 前注册；URL 形如 `vibe-doc://<sessionId>/<encoded-abs-path>`，handler 复用 `isUnderCwd` 校验；renderer `<img src="vibe-doc:///..." />` 直接走 net 栈零拷贝。

### 具体改动点
| 文件 | 改动 |
|------|-----|
| `electron/ipc/documents.ts` | image/video 分支：`return { ok:true, ..., data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), mediaType }`。删 `dataBase64`（或保留一个版本，标 deprecated）。word/pdf 分支：直接传 buffer 给 `parseAttachmentBuffer`，不再 `toString('base64')`。 |
| `electron/attachments/parse.ts` | 加 `parseAttachmentBuffer(buf, name, mime, sizeBytes)`，复用现有解析逻辑但跳过 base64 decode。`parseAttachment` 保留作为 wrapper。 |
| `src/types.ts` | `DocumentReadResult` 加 `data?: Uint8Array; mediaType?: string`。`dataBase64?` 保留兼容。 |
| `src/components/DocumentStage.tsx` | image / video 分支：`useMemo(() => doc.data ? URL.createObjectURL(new Blob([doc.data], { type: doc.mediaType })) : null, [doc.data, doc.mediaType])`，组件卸载时 `URL.revokeObjectURL`。退化 fallback：`dataBase64` 仍可用。 |
| `electron/preload.cjs` | 不用动，`documents.read` 通道传 Uint8Array 走的就是同一个 invoke。 |

### 兼容 / 错误处理 / 回归风险
- **兼容**：保留 `dataBase64` 字段一个版本，renderer 在两个字段都能消费就行；下个版本再删 base64。
- **错误处理**：unchanged；`fs.readFile` 失败仍走 `read-failed` 分支。
- **回归风险 1**：CSP。当前 `media-src 'self' blob: data:`、`img-src 'self' data: blob:` 都已包含 `blob:`（`electron/main.ts:91-105`），Blob URL 不会被拦——已确认。
- **回归风险 2**：Blob URL 不 revoke 会泄漏。DocumentStage 现在 stage 内重新 fetch 文档时要 revoke 上一个 URL，否则长会话泄漏。`useMemo` + `useEffect cleanup` 配对解决。
- **回归风险 3**：Uint8Array 跨 IPC 走 structured clone。Electron 文档承诺 ArrayBuffer 是 transferable（零拷贝），但实际行为视版本而定；如果实测仍然是 copy，至少省掉了 base64 编码 + 33% 体积，仍是净赢。
- **回归风险 4**：word/pdf 现在 main 端同步跑 mammoth/pdf-parse，本轮不动；下一轮 follow-up 必须移到 utility-process，否则 5 MB pdf 仍然能卡 main 500 ms+。在方案里先标记。

### 预期收益
8 MB 图片 / 视频读取，main 主线程阻塞 80–200 ms → < 5 ms；IPC payload 缩小 33%。说话→听到回复链路在用户拖文件时不再被打断。

---

## 6. 已落地（fix-top）—— `transcripts:append` 单向化 follow-up

`electron/ipc/transcripts.ts:38` 已经是 `ipcMain.on`，`electron/preload.cjs:68` 已 `ipcRenderer.send`。本轮无需再动。

**可选 follow-up（非阻塞）**：preload 桥接里 `append: (cwd, entry) => { ipcRenderer.send(...); return Promise.resolve({ok:true}); }` 这个 `Promise.resolve` 兼容垫片，等所有 renderer 调用方都不再 `await transcripts.append(...)` 后可以删；当前保留无副作用。grep 一下 `transcripts.append(` 的所有调用方，确认全部不依赖返回值即可。

---

## 执行顺序建议

下面这个顺序基于"风险×收益"和"和并行 worker 改动的冲突面"打分。其它 worker 正在改的文件：`exec-whisper`（`whisper.ts`）、`exec-llm`（`orchestrator.ts` / talker 流式）、`exec-tts`（`speech-session.ts` / `useSpeech.ts`）、`exec-main-ipc`（**本方案目标文件**）。本方案的 §1 / §3 都会动到 `sessions.ts`、§3 会动到 `settings.ts`，与 `exec-main-ipc` 自己即将动的范围有重叠——执行时务必同一个 worker 内顺序做，或者抢前先 read 当前状态。

| 顺序 | 项 | 阻塞依赖 | 与并行 worker 冲突面 |
|------|----|---------|--------------------|
| 1 | §2 buildClaudeShadowHome | 无 | 仅 `claude-defaults.ts` + `main.ts:286` 几行，冲突小 |
| 2 | §5 documents.read | 无 | `documents.ts` 没人动 |
| 3 | §3 store.ts 异步化 + debounce | 无 | `sessions.ts` 写入合并需要与 §1 同一 PR |
| 4 | §1 sessions:open 立即返回 | renderer 同步改 meeting-store/TabStrip/useSpeech | `meeting-store.ts` 也在 `exec-tts` / `exec-llm` 改动范围；最后做，read 后再写 |
| 5 | §4 memory.ts persist 异步化 | 无 | `memory.ts` 没人动 |

§5、§4 可并行；§1 放最后做，避免和正在动 meeting-store 的 worker 写互踩。

---

## 不在本方案内（明确不做）

- `whisper.ts` 常驻化、贪心解码：归 `exec-whisper`。
- talker 流式 / 模型路由：归 `exec-llm`。
- TTS 分句流式：归 `exec-tts`。
- ONNX speaker embedding 切 worker 后端：probe 报告 §1.1，本轮不做。
- meeting-store 流式 chunk 单通道 + rAF 节流：probe 报告 §1.2 / §2.5，本轮不做，留给后续 renderer 优化轮。
- `documents:read` 走 `protocol.handle('vibe-doc')`：上面 §5 已列为 follow-up。
- `auth:check-subscription-status` 冷 spawn 缓存：probe 报告 §2.6，本轮不做。
