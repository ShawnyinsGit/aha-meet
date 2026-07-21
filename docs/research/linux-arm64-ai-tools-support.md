# AI 编程 Agent / IDE 工具对 Linux ARM64 (aarch64) 支持核实

核实日期：2026-07-20
核实方式：GitHub Releases API（`gh api`）、npm registry（`npm view`）、官方安装脚本、官方下载端点 HTTP 探测
背景平台：瑞芯微 RK3588 类 ARM64 Linux（glibc，aarch64）

图例：✅ 官方明确支持（有官方预编译产物）｜⚠️ 可运行但有条件（解释型/跨平台运行时，或需自行编译）｜❌ 不支持

## 一、AI 编程 Agent / CLI 工具

| 工具 | 类型 | Linux ARM64 | 分发形式 | 证据 | 备注 |
|---|---|---|---|---|---|
| **OpenCode** (sst/opencode) | 终端 AI agent + 桌面 IDE | ✅ | 原生二进制 tarball（glibc + musl）；桌面版 AppImage/deb/rpm | release `v1.18.3`：`opencode-linux-arm64.tar.gz`、`opencode-linux-arm64-musl.tar.gz`；桌面：`opencode-desktop-linux-arm64.AppImage`、`.deb`、`opencode-desktop-linux-aarch64.rpm` | CLI 与桌面 IDE 都有官方 aarch64 构建，RK3588 上直接用 glibc 版即可 |
| **Claude Code** (@anthropic-ai/claude-code) | 终端 AI agent CLI | ✅ | npm 包 + 按平台拆分的原生二进制 optionalDependencies | npm `2.1.215` 的 optionalDeps 含 `@anthropic-ai/claude-code-linux-arm64` 和 `@anthropic-ai/claude-code-linux-arm64-musl`，版本与主包同步（2.1.215） | 官方明确支持 linux-arm64（glibc 和 musl 都有）；`npm i -g @anthropic-ai/claude-code` 自动选对二进制 |
| **Codex CLI** (openai/codex) | 终端 AI agent CLI（Rust） | ✅ | 原生二进制 tarball/zst（musl 静态）、npm 平台包、pip wheel | release `rust-v0.144.6`：`codex-aarch64-unknown-linux-musl.tar.gz`、npm 包 `codex-npm-linux-arm64-0.144.6.tgz`、wheel `openai_codex_cli_bin-0.144.6-py3-none-manylinux_2_17_aarch64.whl` | musl 静态链接意味着 glibc/musl 系统通吃。配套 `codex-app-server-aarch64-unknown-linux-musl` 也有 → VS Code 扩展（`openai.chatgpt`）的后端在 linux-arm64 可用；市场站点直连验证超时未完成，但 app-server 资产存在即为强证据 |
| **Hermes Agent** (NousResearch/hermes-agent) | Python AI agent | ⚠️（跨平台可运行） | pip（纯 Python wheel / sdist） | release `v2026.7.7.2` 只有 `hermes_agent-0.18.2-py3-none-any.whl` / `.tar.gz` —— `py3-none-any` 即平台无关 | Python 写的，只要有 ARM64 的 Python 3 就能跑（RK3588 发行版自带）；非"原生二进制"但也无障碍 |
| **OpenClaw** (openclaw/openclaw) | 个人 AI 助手（Node/TS） | ⚠️（跨平台可运行） | npm 包（Node >= 22.22.3 等）；release 桌面资产仅 mac dmg/zip、Windows exe、Android apk | npm `openclaw@2026.7.1-2`，`engines: node >=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0`，`bin: openclaw.mjs`（纯 JS 入口） | CLI 本体是 Node 脚本 → 装了 ARM64 Node 即可跑。但注意：release 里的**桌面/移动端打包产物没有 Linux ARM64**，只有 CLI 路线可用 |
| **Grok Build** (xai-org/grok-build) | 终端 AI agent CLI（Rust，2026-07 开源） | ✅ | 官方安装脚本 `https://x.ai/cli/install.sh`（识别 aarch64）；源码 cargo 构建 | 安装脚本明确包含 `arm64\|aarch64\|ARM64) arch="aarch64"` 分支，支持 macOS/Linux/Windows 预编译二进制 | 模型走 xAI 付费 API（客户端开源、模型闭源）。GitHub 仓库无 release assets，二进制由 install.sh 拉取 |
| **Pi Agent** (badlogic/pi-mono) | 终端 AI coding agent（TypeScript/Node） | ⚠️（跨平台可运行） | npm：`@earendil-works/pi-coding-agent`（仓库 README 现行名；旧名 `@mariozechner/pi-coding-agent` 仍在，0.73.1）；或 `curl -fsSL https://pi.dev/install.sh` | pi-mono 仓库 README 安装命令为 npm 全局安装，纯 Node 分发 | 无平台专属二进制，Node 能跑它就能跑；README 建议 `--ignore-scripts` |

### 名称核实结论
- **Hermes Agent**：真实项目是 **NousResearch/hermes-agent**（"The agent that grows with you"，Python，~217k stars）。不是 hershel/hermes。
- **OpenClaw**：真实项目是 **openclaw/openclaw**（~383k stars，个人 AI 助手，🦞），Node/TypeScript。与经典游戏引擎 OpenClaw 同名不同物。
- **Grok Build**：真实存在，xAI 官方编程 CLI，仓库 **xai-org/grok-build**（Rust，~20k stars，2026-07-15 开源，Apache 2.0）。

## 二、完整 IDE 对照（防止与 agent CLI 混淆）

| IDE | 类型 | Linux ARM64 | 分发形式 | 证据 | 备注 |
|---|---|---|---|---|---|
| **VS Code** | 完整 IDE | ✅ | 官方 tarball / deb / rpm | `https://update.code.visualstudio.com/latest/linux-arm64/stable` 与 `.../linux-deb-arm64/stable` 均 302 到有效下载 | 官方明确支持 |
| **Zed** | 完整 IDE | ✅ | 官方 tarball + remote-server | zed-industries/zed `v1.11.3`：`zed-linux-aarch64.tar.gz`、`zed-remote-server-linux-aarch64.gz` | 官方明确支持 |
| **Cursor** | 完整 IDE（AI fork of VS Code） | ✅ | 官方 Linux Arm64 AppImage | 官方分发存在 `Cursor for Linux Arm64.AppImage`（如 2.6.x/3.x 系列，见 softking 收录页及社区更新器 udit-001/cursor-linux-release） | 官方有 arm64 AppImage，但 Linux 不自动更新、无固定 URL，体验弱于 mac/win |
| **Windsurf** | 完整 IDE | ✅ | 官方 deb 更新通道 | `https://windsurf.com/api/update/linux-arm64/deb/stable` 返回 200 | 官方明确支持 |

## 三、运行时栈对照

| 组件 | Linux ARM64 | 证据 | 备注 |
|---|---|---|---|
| **Node.js** | ✅ | `node-v22.17.0-linux-arm64.tar.xz` 官方 dist 存在（HTTP 200） | OpenClaw / Pi / Hermes 之外所有 Node 系 CLI 的底座 |
| **Electron** | ✅ | electron `v43.1.1`：`electron-v43.1.1-linux-arm64.zip` 等完整资产 | 自研设备上跑 Electron 壳（如本项目 Vibe Meet）有官方底座 |
| **whisper.cpp** (ggml-org/whisper.cpp) | ⚠️（源码编译，ARM 一等公民） | 最新 release `v1.9.1`；项目只发源码，无预编译 Linux 二进制 | ARM NEON 优化是官方长期维护路径，RK3588 上 cmake 编译即可；还可选 Vulkan（RK3588 Mali GPU 支持情况需实测） |

## 四、结论速览

**RK3588 ARM64 Linux 上可直接用的官方二进制 CLI**：OpenCode、Claude Code、Codex CLI、Grok Build。
**靠 Node/Python 跨平台运行**：OpenClaw（仅 CLI）、Pi Agent、Hermes Agent。
**完整 IDE 四个全都有 Linux ARM64 官方构建**：VS Code、Cursor、Windsurf、Zed。
**没有"未找到"的项目**：Hermes Agent、OpenClaw、Grok Build 均已定位到真实项目（名称见上）。
