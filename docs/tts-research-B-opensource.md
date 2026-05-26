# B 路线调研：开源 TTS 本地打包进 Electron

**目标**：替换 Web Speech API，本地中文 TTS，打包进 dmg，不联网。
**基线**：当前 dmg 384 MB（含 whisper-small-q5 196 MB + Electron + claude-defaults）。
**约束**：纯本地、无 Python、Apple Silicon、中文必须可用。

> 注：本机环境 WebSearch/WebFetch 不可用，以下基于截止 2026-01 的知识与项目公开 README/Release 历史。2026 年最新动态（标 ⚠️）建议落地前再核对一次 GitHub release。

## 候选对比表

| # | 方案 | 形态 | Runtime | 模型大小 | 总体积 | 首句延迟 (M1) | 中文音质 | 许可证 (代码/权重) | 集成难度 | dmg 膨胀 | 硬约束 |
|---|------|------|---------|----------|--------|---------------|----------|--------------------|----------|----------|--------|
| 1 | **Piper** `zh_CN-huayan-medium` | native bin + ONNX | piper bin (自带 onnxruntime) | 63 MB | ~75 MB | 80–200 ms | 6/10 | MIT / MIT | 2 | +75 MB | ✅ |
| 2 | **sherpa-onnx TTS** (VITS aishell3 / Matcha-zh) | C++ .dylib + Node 绑定 | `sherpa-onnx-node` (prebuilt) | 30–160 MB | 60–200 MB | 150–400 ms | 7–8/10 | Apache-2.0 / 多为 Apache/MIT | 2 | +120 MB | ✅ |
| 3 | **Kokoro-82M ONNX** | ONNX (transformers.js / ort-node) | onnxruntime-node | 80 MB (int8) / 326 MB (fp32) | ~120 MB | 300–700 ms | 6–7/10 ⚠️ | Apache-2.0 / Apache-2.0 | 4 | +120 MB | △（zh 需 misaki+jieba 分词依赖，纯 JS 实现可行但有坑） |
| 4 | ChatTTS | Python | — | — | — | — | ❌ 淘汰：官方仅 Python，社区 ONNX 不完整；**权重 CC BY-NC 4.0 禁商用** |
| 5 | CosyVoice / CosyVoice2 | Python (PyTorch) | — | 300 MB+ | — | — | ❌ 淘汰：尚无生产可用 ONNX/ggml 端口（sherpa-onnx 列表里至 2026-01 未稳定 release）；模型 Apache-2.0 但跑不脱 Python |
| 6 | GPT-SoVITS | Python | — | — | — | — | ❌ 淘汰：强依赖 PyTorch + Python，无 ONNX 单文件方案 |
| 7 | **espeak-ng** | native bin | 自带 | <5 MB | <10 MB | <50 ms | 2/10 共振峰机器音 | GPL-3.0 / GPL-3.0 | 1 | +5 MB | ✅（仅兜底，GPL 传染需注意，Electron 走子进程 fork+exec 即可隔离） |
| 8 | MeloTTS (MyShell) | Python | — | — | — | — | ❌ 淘汰：官方无 ONNX，社区端口尚未稳定 |
| 9 | VITS / Bert-VITS2 社区 ONNX | ONNX | onnxruntime-node 或 sherpa | 80–200 MB | 100–230 MB | 200–500 ms | 7–8/10 | 因模型而异，多为 MIT | 3 | +150 MB | △（已被 #2 sherpa 覆盖，单独走需自己写音素化） |
| 10 | Mimic 3 (Mycroft) | Python | — | — | — | — | ❌ 淘汰：是 Piper 思想的前身，Python 实现，已停更，Piper 是更新替代 |

## 硬约束过滤后剩余

按 **可打包难度 + 中文质量** 排序：

1. **sherpa-onnx TTS** — 质量最高（Matcha-zh / VITS-aishell3），有官方 `sherpa-onnx-node` npm 包（含 darwin-arm64 prebuilt .node），主进程 require 即可。
2. **Piper** — 集成最简单（一个二进制 spawn），huayan 音色尚可接受。
3. **espeak-ng** — 仅做 fallback，质量不可上线。

Kokoro 暂归"观察"——它的多语言模型对中文支持是 v1.0+ 才加入的，misaki phonemizer 的中文分支在 Node 上跑还需要自己 port jieba，工程量比 sherpa/piper 大不止一倍，不值。

## Top 2 集成方案

### 方案 A：sherpa-onnx + `matcha-icefall-zh-baker` 或 `vits-zh-hf-fanchen-wnj`（推荐）

**Runtime 位置**：主进程。`sherpa-onnx-node` 是原生模块，必须 `asarUnpack`。

**打包步骤**：
1. `npm i sherpa-onnx-node`（自带 `prebuilds/darwin-arm64/*.node`）。
2. 写 `scripts/fetch-tts.mjs`：从 huggingface `csukuangfj/sherpa-onnx-*` 下载模型 tarball 到 `build/tts/`，校验 sha256（脚本运行在 build 机，用户机不联网）。
3. `electron-builder.json`：
   ```json
   "asarUnpack": ["**/node_modules/@anthropic-ai/**/*", "**/node_modules/sherpa-onnx-node/**/*"],
   "extraResources": [{ "from": "build/tts", "to": "tts", "filter": ["**/*"] }]
   ```
4. `package.json` 加 `prebuild:tts` 钩到 `dist` 脚本里，和 `prebuild:whisper` 并列。
5. 主进程 `tts/service.ts`：单例 `OfflineTts`，初始化时读 `process.resourcesPath/tts/{model.onnx, lexicon.txt, tokens.txt}`。
6. IPC：`ipcMain.handle('tts:speak', async (_, text) => { const { samples, sampleRate } = await tts.generate({ text, sid: 0, speed: 1.0 }); return { samples: Buffer.from(samples.buffer), sampleRate }; })`，返回 Float32 PCM。
7. Renderer：用 `AudioContext.decodeAudioData` 不行（PCM 不是容器格式），改用 `AudioBuffer` + `createBuffer(1, len, sr)` 直接灌 Float32 后 `BufferSource` 播放。

**dmg 影响**：+约 120 MB（runtime .node ≈ 25 MB + Matcha 模型 ≈ 90 MB）→ 384 → ~500 MB。

### 方案 B：Piper（最低风险）

**Runtime 位置**：主进程 `child_process.spawn`。

**打包步骤**：
1. `scripts/fetch-piper.mjs`：抓 `rhasspy/piper` releases 的 `piper_macos_aarch64.tar.gz`，解压到 `build/piper/`；抓 `zh_CN-huayan-medium.onnx` + `.onnx.json` 到 `build/piper/voices/`。
2. `extraResources` 加一项 `{ "from": "build/piper", "to": "piper" }`。
3. 主进程：`spawn(piperBin, ['--model', voicePath, '--output-raw'])`，stdin 写文本，stdout 拿 16-bit 22050 Hz PCM。
4. IPC：流式把 stdout chunk 通过 `webContents.send('tts:pcm-chunk', buf)` 推给 renderer，做 progressive 播放（比一次性返回延迟低）。
5. macOS 注意：从 release 下载的二进制是 ad-hoc 签名，dmg 公证时需要在 `electron-builder` 里把它放到 `extraResources` 并在打包后 `codesign --force --sign - piper`，否则 Gatekeeper 拦截 spawn。

**dmg 影响**：+75 MB → 384 → ~460 MB。

## 直接结论

- **B 路线最佳选择：sherpa-onnx + Matcha-zh-baker**。理由：原生 Node 绑定省掉 spawn / stdio 解析，质量比 Piper huayan 高一档（韵律自然、长句不破），许可证 Apache-2.0 全清，dmg 仅 +120 MB（约 +31%）。
- **保守二选：Piper**。如果嫌 sherpa 模型 90 MB 太大，Piper huayan 也能上，但音质对比 macOS Tingting/Lili 是"可听 vs 自然"的差距。
- **dmg 膨胀**：384 MB → ~500 MB（sherpa）或 ~460 MB（Piper）。
- **质量能压过 Tingting/Lili 吗？**
  - Piper huayan：**压不过**。Tingting 是 Apple neural TTS，huayan 是单 speaker VITS medium 档，韵律明显机械。
  - sherpa Matcha-zh-baker / VITS-aishell3：**接近持平**，长句和数字念法甚至更稳，但 Tingting 在情感语调上仍略胜。
  - 真要超过 Tingting，得上 CosyVoice2 / GPT-SoVITS 级别——目前都没脱 Python，B 路线做不到。

**落地建议**：先按方案 A 接 sherpa-onnx，留 Piper 作为"低配模型"开关，espeak-ng 不进包（用户能听懂的下限就是 Piper）。

## 相关文件路径

- `/Users/weixun/projects/vibe-meet/electron-builder.json` — 加 `asarUnpack` 和 `extraResources`
- `/Users/weixun/projects/vibe-meet/package.json` — 加 `prebuild:tts` 脚本
- `/Users/weixun/projects/vibe-meet/scripts/fetch-whisper.mjs` — 可作为 `fetch-tts.mjs` 的模板
- `/Users/weixun/projects/vibe-meet/build/whisper/` — 参考 196 MB 二进制 + 模型的现有打包结构
