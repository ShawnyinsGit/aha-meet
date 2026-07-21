# 市售 x86 掌机"二次开发生态"调研报告

> 目标：评估在掌机上运行自家 Electron 应用（AI 语音会议 + 编程 agent）的可 hack 性，
> 并为"未来可能换自研系统"选型。
> 调研时间：2026-07-20。Star 数均通过 `gh api` 实查（标注日期的除外）；查不到的标"未验证"。

---

## 0. 结论先行（TL;DR）

**推荐机型（按优先级）：**

1. **Steam Deck（LCD/OLED）** — 生态成熟度断层第一。SteamOS 官方开源组件链完整
   （gamescope / jupiter 内核 / Mesa），decky-loader 插件体系 7k+ star，Valve 对第三方
   Linux 发行版（Bazzite 也有 deck 镜像）完全开放。换自研系统的风险最低、文档最多。
   缺点：性能最弱（Van Gogh/Sephiroth APU），对 AI agent 类重负载是瓶颈。
2. **GPD Win Mini（2024/2025，8840U / HX370）** — GPD 是市售厂商中对开发者最友好的：
   官网直接提供每代机型的 BIOS、手柄固件、Windows 驱动包下载（gpd.hk），无加密锁；
   HHD、InputPlumber、ChimeraOS、Bazzite、Nobara 均有现成支持记录；有真实用户跑
   ChimeraOS/Nobara 的长测报告。性能强（HX370），适合跑本地 AI 负载。
   缺点：社区规模远小于 Deck；新款硬件 revisions 经常换 HID 编码，驱动要跟进。
3. **ASUS ROG Ally / Ally X** — 大厂硬件 + 一线社区支持：Bazzite/HHD/InputPlumber/SteamOS 3.7
   （"enhanced support"）全覆盖，asus-wmi 驱动已进主线内核，ASUS 官网提供 BIOS 下载。
   缺点：华硕固件闭源，EC 可控性不如 GPD；无键盘，做"编程 agent 主机"形态不如 GPD
   翻盖键盘形态顺手。

**不建议首选**：Ayaneo（Linux 驱动 2025 年才陆续进主线，社区小而贵）、MSI Claw
（Intel 平台，掌机 Linux 生态围绕 AMD，Intel 支持弱）、Legion Go（支持不错但形态
与 Ally 重复，且可拆卸手柄增加驱动复杂度；Go S 反而是 SteamOS 官方支持的三个设备之一）。

---

## 1. 各平台二次开发成熟度评分表

评分 1–5（5 最佳）。四维度：**驱动**（Linux 内核/平台驱动完善度）、**社区**（开源项目
规模与活跃度）、**文档**（官方/社区文档与教程）、**固件可控**（BIOS/EC 获取与可改性）。

| 平台 | 驱动 | 社区 | 文档 | 固件可控 | 综合 | 关键依据 |
|---|---|---|---|---|---|---|
| **Steam Deck** | 5 | 5 | 5 | 3 | **4.5** | Valve 官方维护 SteamOS 开源栈；decky-loader ★7047；recovery 镜像公开；BIOS 可进但 EC 闭源 |
| **GPD Win Mini / Win 4 / Win Max** | 4 | 3 | 3 | 5 | **3.75** | HHD/InputPlumber/ChimeraOS/Bazzite 全部支持；官网 BIOS+驱动包直接下载；手柄固件可刷可降级绕过 |
| **ROG Ally / Ally X** | 4 | 4 | 4 | 3 | **3.75** | asus-wmi 主线内核；SteamOS 3.7.8 官方"enhanced support"；Bazzite 文档完善；ASUS 官网 BIOS 下载 |
| **Legion Go / Go S** | 4 | 3 | 3 | 3 | **3.25** | Go S 是 SteamOS 官方支持 3 设备之一；HHD 双陀螺仪支持好；Lenovo BIOS 通过官网/LVFS（未验证 Go 是否上 LVFS） |
| **Ayaneo（Air/2S/Kun/Flip/3）** | 3 | 2 | 2 | 2 | **2.25** | ayaneo-platform 驱动（ShadowBlip, ★23）+ ayaneo-ec 2025-11 才投稿 LKML；ChimeraOS 46 起增强支持；固件获取不透明 |
| **OneXPlayer** | 3 | 2 | 2 | 2 | **2.25** | HHD/Bazzite 支持 F1/G1/X1；社区项目少，依赖 HHD 逆向 |
| **MSI Claw** | 2 | 2 | 2 | 2 | **2.0** | Intel 平台，Bazzite 有镜像但掌机 Linux 生态以 AMD 为中心；HHD 仅"some support" |

### 评分明细备注

**Steam Deck**
- 开源链：SteamOS（Arch 基底）、[ValveSoftware/gamescope](https://github.com/ValveSoftware/gamescope)、
  jupiter 内核、Mesa RADV 均公开开发。
- 插件生态：[decky-loader](https://github.com/SteamDeckHomebrew/decky-loader) ★7047 ——
  在 Gaming Mode 里注入 CEF/Tab 的插件加载器，是"在掌机上跑自家 Web UI"的最成熟先例。
- 换系统：Bazzite/ChimeraOS/Jovian-NixOS 均有 Deck 专用镜像；Valve 提供官方 recovery 镜像，刷机可回退。
- 固件可控性扣分：BIOS 菜单开放（可调显存等），但无公开 BIOS 二进制下载通道，EC 闭源。

**GPD**
- 官方固件开放度市售第一：[gpd.hk/download](https://www.gpd.hk/download) 按机型列出
  BIOS / 手柄固件 / 完整 Windows 驱动包；社区甚至有绕过手柄固件降级保护的 patch
  （nullsum.net 有详细 writeup）。历史上 GPD 还为 WIN 2 / Pocket 2 提供过官方
  Ubuntu MATE 镜像（见 gpd.hk WIN2 固件页），说明其不排斥 Linux。
- Linux 实机记录：ChimeraOS 46 起官方设备支持含 Win Mini 风扇控制（GamingOnLinux 报道）；
  Nobara/ChimeraOS 长测博客（s31bz.com）；Bazzite 官方 Handheld Wiki 列 GPD 全系。
- 注意坑：Win Mini 2023→2024（7840U→8840U）换了内部 USB 路由和 L4/R4 的 HID hex 编码，
  InputPlumber 需要新配置（[issue #555](https://github.com/ShadowBlip/InputPlumber/issues/555)）。
  **每代小改版都可能 break 输入映射** —— 这是 GPD 生态最大的维护成本。
- 串口/GPIO：Win Mini 无暴露 UART/GPIO 的公开文档（未验证；GPD MicroPC 有 RS-232 但那是另一条产品线）。

**ROG Ally**
- SteamOS 3.7.8（2025-05）官方支持 ROG Ally / Legion Go（"enhanced"），Legion Go S 为全官方支持
  —— 意味着 Valve 自己在维护这些设备的上游兼容性。
- asus-wmi 在内核主线；HHD 的 gyro 需要内核 IMU patch（hhd 文档有说明）。
- ASUS 官网提供 BIOS/驱动下载；Secure Boot 可关（Bazzite 安装文档明确要求先关）。

**Ayaneo**
- 转折点在 2025：Antheas Kapenekakis 的 ayaneo-ec 平台驱动 2025-11 进入 LKML 评审
  （LWN 报道），AYANEO 3 有专门驱动工作（Phoronix 2025-10）。在此之前全靠
  [ShadowBlip/ayaneo-platform](https://github.com/ShadowBlip/ayaneo-platform)（★23）社区逆向。
- 厂商层面未见 BIOS/EC 公开下载（未验证有官方渠道）。

---

## 2. Linux 支持生态全景（关键开源项目）

| 项目 | 作用 | Star（2026-07-20 实查） | 链接 |
|---|---|---|---|
| Bazzite (ublue-os) | Fedora Atomic 游戏发行版，掌机覆盖面最广（20+ 机型） | **8790** | https://github.com/ublue-os/bazzite |
| decky-loader | Steam Deck 插件加载器（Gaming Mode 注入 Web 插件） | **7047** | https://github.com/SteamDeckHomebrew/decky-loader |
| ChimeraOS | Arch 基底 Steam BPM 沙发游戏 OS，device-quirks 覆盖 GPD/Ayaneo/OXP | **1989** | https://github.com/ChimeraOS/chimeraos |
| Jovian-NixOS | SteamOS 式体验的 NixOS 模块（jovian = SteamOS 内部代号） | **987** | https://github.com/Jovian-Experiments/Jovian-NixOS |
| InputPlumber (ShadowBlip) | 输入路由/重映射守护进程，把各厂手柄统一成标准输入 | **525** | https://github.com/ShadowBlip/InputPlumber |
| HHD – Handheld Daemon | 掌机配置守护（TDP/手柄模拟/RGB），Bazzite 的掌机支持底座 | **386** | https://github.com/hhd-dev/hhd |
| gamescope-session (ChimeraOS) | 基于 gamescope 的用户会话（ChimeraOS/Bazzite deck 会话基础） | **221** | https://github.com/ChimeraOS/gamescope-session |
| pyWinControls (pelrun) | GPD Win Mini/Win 4 手柄配置的 Python 移植 | **49** | https://github.com/pelrun/pyWinControls |
| ayaneo-platform (ShadowBlip) | Ayaneo RGB/旁路充电 sysfs 驱动 | **23** | https://github.com/ShadowBlip/ayaneo-platform |
| hhd-decky | HHD 的 Decky 插件前端 | **17** | https://github.com/hhd-dev/hhd-decky |
| hhd-ui | HHD 桌面配置 UI | **12** | https://github.com/hhd-dev/hhd-ui |
| device-quirks (ChimeraOS) | 各机型 quirks/workaround 配置库 | **11** | https://github.com/ChimeraOS/device-quirks |

其他实查：hhd-dev/adjustor ★7（TDP 调节，已并入 hhd 4.x）；ublue-os/hwe ★190（ASUS 硬件 Fedora 变体）。
ValveSoftware/SteamOS 无独立主仓库（组件分散在 gamescope/SteamOS-devkit 等，star 数未验证）。

**HHD 设备支持**（readme 原文）：Lenovo、ASUS、GPD、OneXPlayer、Ayn 支持好；
Ayaneo、Anbernic、MSI 为部分支持。Bazzite 官方 Handheld Wiki：除 Steam Deck 外所有
掌机都靠 HHD 做手柄/TDP 支持。

**发行版支持度速查**（GPD Win Mini 为例）：
- Bazzite：官方支持 ✅（文档有 GPD 专页）
- ChimeraOS：✅（46 版起含 Win Mini 风扇控制）
- Nobara：✅ 社区实测可用（s31bz.com 长测），但属"社区测试非主要目标"
- SteamOS：❌ 不在 Valve 支持列表
- 通用 Fedora/Arch + HHD：✅（HHD 有 AUR/COPR 包）

---

## 3. 硬件开放度对比

| 项目 | Steam Deck | GPD | ROG Ally | Legion Go | Ayaneo |
|---|---|---|---|---|---|
| BIOS 下载 | recovery 镜像级，无独立 BIOS 二进制 | ✅ 官网逐机型下载 | ✅ 官网下载 | ✅ 官网/LVFS（LVFS 未验证） | 未验证（未见官方渠道） |
| EC/手柄固件 | 闭源 | ✅ 手柄固件公开可刷，社区可 patch 降级 | 随 Armoury Crate/BIOS 更新 | 随官网包更新 | 未验证 |
| Secure Boot / bootloader | 可关，无锁 | 可关，无锁 | 可关（装 Bazzite 必须） | 可关 | 未验证 |
| 串口/GPIO | 无（有隐藏 UART 焊盘，未验证） | Win Mini 未见公开文档（未验证） | 无 | 无 | 未验证 |
| 存储可换 | M.2 2230 可换 | M.2 2230 可换 | M.2 2280（Ally X）可换 | M.2 2242 可换 | 多数可换 |

**结论**：GPD 的"固件可直接下载 + 无锁 bootloader + 历史上给过 Ubuntu 镜像"组合，
在市售厂商里对"以后换自研系统"最友好；Valve 其次（靠生态而非固件开放）；
ASUS/Lenovo 是大厂标准水平；Ayaneo/OneXPlayer 最封闭。

---

## 4. Electron 应用在掌机 Linux 上的已知坑

### 4.1 输入路径（这是本项目最大的技术风险点）

掌机手柄在 Linux 下是 evdev/xinput 设备，Chromium **不会** 自动把手柄变成鼠标/键盘。
可行路径：

1. **HHD / InputPlumber 的手柄模拟层**：把手柄模拟成虚拟键鼠 + 虚拟手柄（DualSense/Xbox
   Elite 模拟），Electron 应用侧收键盘鼠标事件即可。HHD 4.x 支持 desktop layout，
   双击侧键呼出 overlay。——**推荐路径**，与游戏发行版解耦，纯 Fedora/Arch 也能用。
2. **Steam Input**：把 Electron 应用加为非 Steam 游戏，用 Steam 的手柄→键鼠映射。
   零代码但绑死 Steam，且 Gaming Mode 下非 Steam 窗口管理混乱。
3. **Gamepad API**：Chromium 原生支持 W3C Gamepad API，Electron 里直接 `navigator.getGamepads()`。
   适合应用内手柄导航 UI，需要自己写映射逻辑。

### 4.2 触摸屏

- Electron 触屏事件有历史 issue：[#8125](https://github.com/electron/electron/issues/8125)
  （touch events 不支持/滚动问题）、[#17552](https://github.com/electron/electron/issues/17552)
  （多点触摸后 touch event 失效）、[#8725](https://github.com/electron/electron/issues/8725)
  （触屏 click 事件异常）。多为 Windows/旧版本，**Linux 下现代 Electron + Wayland 的
  触屏支持状况未验证**，建议真机验证。
- **屏幕旋转是掌机特色坑**：多数掌机面板原生竖屏（portrait），Linux 下需要旋转 90°。
  实测记录：Nobara 上 GPD Win Mini 需手动设置 "Portrait Left"；ChimeraOS/device-quirks
  已内置修正。Wayland 下触摸坐标随旋转映射由 compositor 处理，X11 下需
  `xinput Coordinate Transformation Matrix` 同步旋转，**漏配则触摸坐标错位**。
- 屏幕键盘：Linux 无系统级统一 OSK 自动呼出。选项：GNOME 的 caribou/maliit、KDE
  虚拟键盘，或应用内自建（Web 端做自定义键盘组件最可控）。

### 4.3 gamescope / Wayland 注意事项

- gamescope 作为 Wayland client 运行时有已知问题：trackpad scrolling 失效
  （gamescope #1399）、Wayland backend 下鼠标进出窗口崩溃（#1434，已修）、
  GNOME 49 Wayland 下无法启动（Arch BBS 2025-10）等。
- **建议：自研应用不要跑在 gamescope 会话里**。gamescope-session 是为游戏设计的
  （独占全屏、FSR、帧率限制）。自家 Electron 应用应跑在常规 Wayland 桌面会话
  （GNOME/KDE mobile-ish 配置）或 cage/weston kiosk compositor 下，把 gamescope
  留给游戏。Bazzite 的 desktop 模式（KDE Plasma Wayland）即可满足。
- HiDPI/小屏：7" 1080p/1200p 屏，Electron 需处理 fractional scaling；Wayland 下
  Chromium 的 `ozone` + `wp-fractional-scale-v1` 已可用，但建议在真机验证字体渲染。

---

## 5. 采购建议与落地路径

**短期（跑通 Electron 应用）**：买 1 台 **GPD Win Mini 2025（HX370）** + 1 台
**Steam Deck OLED** 做双端验证。
- Win Mini 上装 **Bazzite（或 Nobara，若需要可变系统做开发）** + HHD：
  桌面模式跑 Electron，手柄走 HHD desktop layout 模拟键鼠，触屏直连。
- Deck 上验证 decky-loader 形态（如果产品形态允许寄生于 Steam Gaming Mode，
  这是触达 Deck 存量用户的低成本路径）。

**中期（自研系统 PoC）**：基于 **Bazzite/ublue-os 的 OCI 镜像定制**（Universal Blue
体系就是为"fork 一个自己的原子化发行版"设计的），或基于 **ChimeraOS 的 frzr/own
channel** 做整机镜像。GPD 为首选硬件，因为 BIOS/驱动包可离线获取，量产刷机不依赖
厂商在线服务。

**关键待验证项**（建议真机测试清单）：
1. Electron 触屏事件在当前版本 Electron + Wayland 下的完整性（单击/长按/滑动/多点）
2. HHD desktop layout 的键鼠模拟延迟与稳定性
3. 竖屏面板的旋转 + 触摸坐标映射
4. 应用内 OSK 方案
5. Win Mini 2025（G1617-03?）InputPlumber 配置是否已合并（2024 款的 #555 刚修）
6. 麦克风阵列/音频在低 TDP 下的表现（AI 语音会议场景特有，无公开资料，未验证）

---

## 附：主要信息来源

- Bazzite Handheld Wiki：https://docs.bazzite.gg/Handheld_and_HTPC_edition/Handheld_Wiki/
- HHD：https://github.com/hhd-dev/hhd（readme 含各设备 caveat）
- InputPlumber GPD Win Mini 2024 issue：https://github.com/ShadowBlip/InputPlumber/issues/555
- GPD 官方下载页：https://www.gpd.hk/download
- GPD 手柄固件降级绕过 writeup：https://nullsum.net/posts/downgrading_gpd_win2_gamepad_firmware/
- ChimeraOS 46 发布说明（GPD/Ayaneo/OXP 支持）：https://www.gamingonlinux.com/2024/07/chimeraos-46-brings-major-upgrades-and-enhanced-handheld-support-for-gpd-ayaneo-onexplayer/
- ayaneo-ec 进 LKML：https://lwn.net/Articles/1047241/
- AYANEO 3 驱动：https://www.phoronix.com/news/AYANEO-3-Linux-Platform-Driver
- SteamOS 3.7.8 第三方掌机支持：https://www.notebookcheck.net/Valve-releases-major-new-SteamOS-update-with-Asus-ROG-Ally-Lenovo-Legion-Go-and-Legion-Go-S-support.1023166.0.html
- Linux on GPD Win Mini 长测：https://www.s31bz.com/linux-gpd-win-mini
- Electron 触屏 issues：electron/electron #8125 / #8725 / #17552
- gamescope issues：ValveSoftware/gamescope #1399 / #1434 / #1807

*未验证项汇总：Legion Go LVFS 固件通道、Ayaneo 官方 BIOS 下载、各机型 UART 引脚、
Electron 新版在 Wayland 下触屏完整性、掌机麦克风/音频子系统在 Linux 下的表现。*
