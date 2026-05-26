# 路线 A：macOS 本地 TTS 可行性报告

> 本机实测（macOS 26.4.1，`say -v ?` + `/System/Library/SpeechBase/Voices/`）+ Apple 文档 + Electron/Chromium 已知行为。

## 1. 默认安装的中文音色（开箱即用基线）

| Locale | 音色 | 质量层 | 主观打分 |
|--------|------|--------|----------|
| zh-CN  | Tingting 婷婷 | `.default` (Compact) | 3/10 机器味重 |
| zh-HK  | Sinji 善怡    | `.default` (Compact) | 3/10 |
| zh-TW  | Meijia 美佳   | `.default` (Compact) | 3/10 |

Sonoma / Sequoia / macOS 26 全系一致，**只有这三个 compact**。Li-Mu / Yu-Shu 等是引擎内部资源，不会出现在 `getVoices()`。

## 2. 需要用户手动下载才能拿到的高质量音色

入口：System Settings → Accessibility → Spoken Content → System Voice → **Manage Voices**。下载后立即出现在 Web Speech API `getVoices()` 里。

| 音色 | 质量 | 备注 |
|------|------|------|
| Tingting / Meijia / Sinji **(Enhanced)** | `.enhanced` | ~100MB，明显更自然 |
| Lili (zh-CN, Premium/Neural) | `.premium` | Neural，接近 Siri |
| **Voice 1/2/3/4 (zh-CN/HK/TW)** | `.premium` Neural | 这就是"Siri 同款" Neural 引擎，按性别+音色编号 |

**Siri 自身（"Siri Voice"）的语音 1/2/3/4 在 macOS 上至今对第三方 API 完全封闭**——`AVSpeechSynthesizer` / `say` / Web Speech API 都拿不到，只有 Siri 本体能用。能拿到的是 Spoken Content 里同名同源的 Neural 音色。

## 3. 三档现实预期（硬约束："装上就能用"）

| 档位 | 现实情况 | 体验 |
|------|----------|------|
| **最差（默认）** | 用户从未碰过设置 → Tingting Compact | 当前体验，机器味重 |
| **中等** | 用户下过 Enhanced（很少自发做） | 明显改善 |
| **最好** | 用户下过 Premium/Voice 1-4 Neural | 接近 Siri |

**结论：硬约束下没法保证中等及以上。** 不允许任何用户配置 = 你只能拿到 Tingting Compact。Apple 不提供任何编程触发下载的 API（试过 MDM、PKG、AssetCatalog 都不行；语音包走 MobileAsset 私有通道）。

## 4. 引擎一致性 & spawn `say` 有无收益

`say` / `AVSpeechSynthesizer` / Web Speech API **同一个引擎、同一份音色资源**。主进程 `spawn('say', ['-v', 'Tingting', '-o', '/tmp/x.aiff'])` 再回放：**音质零提升**，只多 200-500ms 延迟 + 磁盘 I/O + 失去 `onboundary` 事件。**不推荐**，除非要离线缓存或做后处理（变速/混响）。

## 5. 可行的引导 UX（推荐做，但不能依赖）

第一次启动时检测当前最佳 zh 音色质量；若全是 `.default`，弹一次**非阻塞** banner：

```ts
// Electron renderer
const voices = window.speechSynthesis.getVoices();
const bestZh = voices
  .filter(v => v.lang.toLowerCase().startsWith('zh') && !v.lang.includes('-HK'))
  .map(v => /premium|enhanced|neural|voice [1-4]/i.test(v.name) ? 2 : 0)
  .reduce((a,b)=>Math.max(a,b), 0);
if (bestZh === 0) showUpgradeBanner();
```

```ts
// Electron main —— 一键深链到正确设置面板（Sonoma+ 验证可用）
import { shell } from 'electron';
shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?Speech');
```

引导文案要明确："系统设置 → 辅助功能 → 朗读内容 → 系统语音 → 管理语音 → 普通话 → 下载 Voice 1（推荐）"。下载完成后 Chromium 会自动发 `voiceschanged`，现有 `voiceCache.clear()` 已正确处理。

## 6. Electron / Chromium 已知坑（除已修的之外）

- **已处理**：`getVoices()` 首次返空、`voiceschanged` 延迟、cancel 后 `resume()` 解锁队列、null voice 缓存 bug。
- **仍需注意**：
  - 长文本（>200 字符）Chromium 会**静默截断**，已有 `prepareForSpeech` 分句，OK。
  - macOS 静音切换 / 蓝牙设备切换会令队列卡死，建议在 `powerMonitor` `resume` 事件里 `cancelSpeech()`。
  - Sequoia 起 Web Speech API 受 `Speech Recognition` TCC 影响，**TTS 不需要权限**，但 mic 权限弹窗冲撞时 utterance 会丢；目前流程先拿 mic 再说话，OK。
  - `localService === false` 的远程音色（Eloquence / Google 等）在打分里已 -50，避免被选中，正确。

## 直接结论

**A 路线在"零配置开箱即用"硬约束下，天花板就是 Tingting Compact，不算"可用"水平。** 建议：

1. **短期**：保留 Web Speech API，加 §5 的一次性引导 banner + 深链。中文用户里愿意点一下的能拿到 7-8/10 音色，剩下的接受 3/10。
2. **不要**改 spawn `say`，零收益。
3. **中期**：若要保证全员高质量，必须放弃路线 A，走云端 TTS（Azure Neural / ElevenLabs / 火山 / MiniMax）或本地 Neural 模型（如 GPT-SoVITS 打包进 app，~500MB），那是路线 B/C 的范围。
