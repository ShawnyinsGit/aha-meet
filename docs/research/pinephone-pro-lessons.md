# PinePhone Pro 前车之鉴 —— Linux 移动设备可行性 & 风险清单

> 来源：用户提供的调研纪要（PINE64 官方月报 2022-01、postmarketOS issue #2016、Pine64 论坛长期评测），2026-07-20 归档
> 用途：AhaStation 自研硬件（RK3588 + Linux）的风险参照系

## PPP 概况

- 硬件：RK3399S（6 核 big.LITTLE，≤4GB LPDDR4）、可拆后盖、硬件 kill switch、USB-C 视频输出（convergence），约 $399，定位"开发者设备"
- 软件：不绑定单一系统，postmarketOS / Mobian / Manjaro ARM / SailfishOS 共存，Phosh 最成熟，Tow-Boot 统一引导

## 社区实测五大核心问题（按严重度）

1. **通话音频（callaudio）是最大 show-stopper**：挂起状态来电麦克风音量骤降；PipeWire 路由通话音频频繁失败 —— 发布两年后仍未完全修复
2. **电源管理**：suspend 唤醒失败、待机一晚掉电 ~20%、扩展坞输出 15–30 分钟耗光
3. **Modem 依赖社区固件**：原厂 Quectel 固件 suspend 下漏接电话，必须刷 Biktorgj 社区开源 modem 固件
4. **应用适配**：标称 adaptive 的应用多数实际不可用；缩放比例两难
5. **商业**：EU 定价高 80%+ 引发不满；供应链/售后能力有限

## 做对了的事

预期管理（"开发者设备"写在最显眼处）、开放多发行版而非自建 OS、kill switch + 可维修设计、convergence 是最超预期亮点、wiki 文档质量高

## 对 AhaStation 的启示

- **不自己做基带通话**：PPP 的死穴全在"电话"（callaudio + modem 固件 + VoLTE），纯数据设备可整体绕开
- **电源管理优先于性能**：SoC 的 suspend-resume 主线内核成熟度是第一筛选条件
- **站在社区生态上**：postmarketOS/Mobian/Armbian，单发行版 + 单 DE 做深，别多线维护
- **convergence（外接显示器变桌面）做主打场景** —— 与已确认的决策 #2（外接显示器自动桌面模式 + 掌机屏退化为陪伴屏）完全吻合
- **刷机恢复路径（SD 卡兜底启动）开箱可用**，是开发者设备生命线
- 文档与预期管理即护城河；配件结构件提前锁定
