# AI 语音编程终端 — 首发验证机调研（x86 掌机/掌上电脑）

> 调研日期：2026 年（基于下方标注的各来源日期）。价格均为公开渠道快照，下单前需以店铺实时页为准。
> 筛选标准：x86 CPU、屏幕 6–7.5"、2024–2026 在售可下单、Win11 + Ubuntu 双支持。

## 一、候选机型对比表

| 机型 | 屏幕 | 重量 | CPU | 大致价格（RMB） | 京东/淘宝渠道 | Win11 | Linux/Ubuntu | 官方 BIOS/驱动资料 |
|---|---|---|---|---|---|---|---|---|
| **GPD Win Mini 2025** | 7" 1920×1080 120Hz LTPS 触屏（横屏翻盖+全键盘） | 555g | Ryzen AI 9 HX 370 / AI 9 365 / 8840U | 淘宝约 ¥6999 起；京东 32G+2TB ¥8399 | 京东有售；淘宝有店（来源①②） | ✅ 预装 | ✅ 社区支持（Bazzite/HHD 支持 Win Mini；Ubuntu 可装，2025 款 WinControls 未集成） | ✅ 官网提供系统固件/驱动/BIOS（softwincn 固件下载页，来源③） |
| **GPD Win 4 (2025)** | 6" 1920×1080 60Hz 触屏（滑盖键盘） | 598g | Ryzen AI 9 HX 370 | 京东预售 ¥7499（32G+2TB，2024-12） | 京东官方预售（来源④） | ✅ 预装 | ✅ Bazzite/HHD 全型号支持 | ✅ 官网固件/驱动/BIOS |
| **GPD MicroPC 2** | 7" 1920×1080 60Hz 触屏（360° 翻转+全键盘） | 490g | Intel N250（4C4T，6–15W） | 京东 ¥2999（16+512G，2025-07 开售；标价 4299 活动价 2999） | 京东有售（来源⑤） | ✅ Win11 Pro | ✅ Intel 平台 Ubuntu 兼容好；HHD 对 GPD 全系列支持 | ✅ 官网固件/驱动/BIOS |
| **GPD Pocket 4** | 8.8" 2560×1600 144Hz（超出尺寸要求） | 770g | HX 370 / AI 9 365 / 8840U | 预售 ¥4999–8300；零售 ¥5800–9500 | 京东/淘宝有售（来源⑥） | ✅ | ✅ 社区可装 | ✅ 官网资料齐全 |
| **Ayaneo Flip 1S KB / DS** | 7" 1920×1080 144Hz **OLED**（KB=单屏+键盘；DS=双屏+4.5"副屏） | ~650g | Ryzen 7 8840U / Ryzen AI 9 HX 370 | KB ¥5299 起；DS ¥5499 起（2025-07 发布）；淘宝高配 32G+2T 标价 ¥10099 | 淘宝有店（来源⑦⑧） | ✅ 预装 | ⚠️ 社区支持一般（ChimeraOS/HHD 部分支持 Ayaneo；键盘/副屏驱动不如 GPD 成熟） | ⚠️ 官方仅提供 Windows 驱动包，无公开 BIOS/EC 资料 |
| **ROG Ally X (2024)** | 7" 1920×1080 120Hz VRR IPS 触屏（无键盘） | 678g | Ryzen Z1 Extreme | 京东首发到手 ¥5999（2024-08 促销）；2025 年日常 ¥4099–4299（Ally 一代） | 京东自营（来源⑨⑩） | ✅ 预装 | ✅ **Linux 生态最好**：Bazzite 官方适配、SteamOS 3.7+ 支持、HHD 支持 | ✅ 华硕官网提供 BIOS/驱动更新（MyASUS） |
| **ROG Xbox Ally / Ally X (2025)** | 7" 1080p 120Hz（无键盘） | ~670–715g | Ryzen Z2 A / Ryzen AI Z2 Extreme | 京东：Ally ¥4199（16+512）、Ally X ¥6299（24G+1TB，2025-10 发售） | 京东已上架（来源⑪） | ✅ 预装 | ✅ 已有 Bazzite 改装案例（tuxmachines 2025-10） | ✅ 华硕官方支持 |
| **Lenovo Legion Go S** | 8" 1920×1200 120Hz（略超尺寸） | 730g | Ryzen Z2 Go / Z1 Extreme | 京东 ¥3999，国补到手 ¥3173–3399 | 京东联想自营（来源⑫⑬） | ✅（白）/SteamOS（黑） | ✅ **唯一官方 SteamOS 第三方机型**；Bazzite/HHD 支持 | ✅ 联想官方 BIOS/驱动 |
| **MSI Claw 7 AI+ (2025)** | 7" 1920×1200 120Hz 触屏（无键盘） | 675g | Core Ultra 7 258V（Lunar Lake） | 京东旗舰店 ¥6999；拼多多百亿补贴 ≤¥5799 | 京东旗舰店（来源⑭） | ✅ 预装 | ⚠️ Lunar Lake 上 Ubuntu 可跑，但掌机控制（按键/TDP）社区支持弱于 AMD 机型 | ⚠️ 微星官网有 BIOS/驱动，无 EC 开发资料 |
| **OneXPlayer X1 mini** | 8.8" 2560×1600 144Hz（超出尺寸） | 710g | Ryzen 7 8840U | 天猫首发 ¥5699 起；京东 ¥5879–7199 | 京东自营（来源⑮⑯） | ✅ | ✅ HHD 支持 X1 系列 | ⚠️ 官方提供驱动，无 BIOS 公开资料 |
| **Ayaneo Pocket S** | — | — | **ARM（骁龙 G3x Gen 2）→ 排除** | — | — | ❌ | ❌ | — |
| **GPD Duo** | 13.3" 双屏（远超尺寸）→ 排除 | — | HX 370 | — | — | — | — | — |

## 二、来源

① [淘宝 GPD WIN MINI 2025 商品页 ¥6999（2025-08）](https://www.taobao.com/list/item/737020473015.htm)
② [什么值得买：GPD win mini 2025 京东 32G+2TB ¥8399（2025-05）](https://m.smzdm.com/p/148972578/)
③ [GPD 官网固件/驱动/BIOS 下载页（含 Win Mini 2025、Win 4 2025、MicroPC 2、Pocket 4）](http://www.softwincn.com/gjxz/)
④ [IT之家：GPD WIN 4（2025）京东预售 ¥7499（2024-12-23）](https://www.msn.cn/zh-cn/news/other/gpd-win-4-2025-%E6%B8%B8%E6%88%8F%E6%8E%8C%E6%9C%BA%E9%A2%84%E5%94%AE-%E9%94%90%E9%BE%99-ai-9-hx-370-7499-%E5%85%83/ar-AA1vA83V)
⑤ [IT之家：GPD MicroPC 2 京东 ¥2999（2025-07-10）](https://www.ithome.com/0/867/190.htm)
⑥ [快科技/新浪：GPD Pocket 4 预售 ¥4999–9500（2024-12-02）](https://finance.sina.com.cn/tech/discovery/2024-12-02/doc-incxzvkq8821360.shtml)
⑦ [IT之家：AYANEO FLIP 1S 系列发布，5299 元起（2025-07-11）](https://www.ithome.com/0/867/340.htm)
⑧ [淘宝 AYANEO Flip 1S DS 评价页 ¥10099（2025-12）](https://pingjia.taobao.com/TkY0ODZLajVjdUQxN3pMVkV4R05zdz09.html)
⑨ [搜狐/网易：京东电脑节 ROG 掌机 X 到手 ¥5999、Ally ≤¥4299（2024-08-20）](https://www.sohu.com/a/802130025_121124376)
⑩ [什么值得买：ROG Ally 京东 ¥4099（2025-01）](https://www.smzdm.com/p/138331680/)
⑪ [腾讯新闻：ROG Xbox Ally ¥4199 / Ally X ¥6299 上架京东（2025-09-27）](https://news.qq.com/rain/a/20250927A01WHJ00)
⑫ [超能网：Legion Go S 京东 ¥3999、国补 ¥3399.15（2025-04-12）](https://www.expreview.com/99237.html)
⑬ [IT之家：Legion Go S 国补新低 ¥3173（2026-05-31）](https://www.ithome.com/0/957/741.htm)
⑭ [快科技：微星 CLAW 7/8 AI+ 上市，京东 ¥6999/7999，拼多多 ≤¥5799（2025-01-22）](https://finance.sina.com.cn/tech/roll/2025-01-22/doc-inefvuvy8780925.shtml)
⑮ [IT之家：OneXPlayer X1 mini 天猫 ¥5699 起（2024-06-19）](https://m.ithome.com/html/776275.htm)
⑯ [什么值得买：X1 mini 京东 ¥5879（2025-03）](https://www.smzdm.com/p/143772774/)
⑰ [HHD（Handheld Daemon）支持设备列表（Gitee，2025-12 更新）](https://gitee.com/honjow/hhd)
⑱ [少数派：SteamOS 3.7.8 支持其他 AMD 掌机；ROG Ally 实测（2025-06）](http://mp.weixin.qq.com/s?__biz=MzU4Mjg3MDAyMQ==&mid=2650493768&idx=2&sn=6c1da68593ca03a21903227914676ac8)（注：链接可能失效，以 SteamOS 3.7 更新日志为准）
⑲ [tuxmachines：Xbox Ally 刷 Bazzite（2025-10-23）](https://news.tuxmachines.org/n/2025/10/23/Modders_install_Bazzite_Linux_on_Microsoft_s_Xbox_Ally_for_a_be.shtml)
⑳ [GPD WIN Mini 2025 Indiegogo 规格页（7" 1080P@120Hz, 555g）](https://www.indiegogo.com/projects/gpd-win-mini-2025-120hz-vrr-landscape-game-console)
