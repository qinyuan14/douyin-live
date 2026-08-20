# 品牌命名映射（任务E：去「猫掌柜」绑定 · 大众化）

> 占位品牌名：**实景直播经营系统**（正式名待老板最终拍板，后改需重新打包）。
> 本文档是全仓品牌/命名的单一权威映射表；任何新代码不得再引入旧品牌词。

## 一、面向用户的品牌词

| 旧值（已废弃） | 新值（占位） | 出现位置 |
|---|---|---|
| 猫掌柜直播经营系统 | 实景直播经营系统 | 窗口标题、安装包名、数据根目录、错误弹窗、文档 |
| 猫掌柜 AI 实景直播经营系统 | 实景直播经营系统 | 网页标题、product 字段、文档 |
| 黑猫掌柜（IP 形象） | 小助手（视觉保留） | 输出屏字幕、图标 aria-label、语音试听文案 |
| 猫掌柜公司经营规则库 | 商家经营规则库 | 白名单知识证据标题 |
| 猫掌柜｜9:16 直播输出 | 实景直播｜9:16 直播输出 | 输出窗口标题 |
| 猫掌柜直播值班台 | 实景直播值班台 | 控制窗口标题 |

## 二、技术命名（占位）

| 旧值 | 新值 | 说明 |
|---|---|---|
| `mzg-live-commerce-system`（根包） | `liveops-system` | 根 package.json name |
| `@mzg/live-contracts` | `@liveops/live-contracts` | 子包 |
| `@mzg/live-core` | `@liveops/live-core` | 子包 |
| `@mzg/live-api` | `@liveops/live-api` | 子包 |
| `@mzg/live-desktop` | `@liveops/live-desktop` | 子包 |
| `com.mzg.live-commerce` | `com.liveops.desktop` | electron-builder appId |
| `MZG_*` 环境变量前缀 | `LIVE_*` | 如 `MZG_PROJECT_ROOT`→`LIVE_PROJECT_ROOT`、`MZG_DOCS_DIR`→`LIVE_DOCS_DIR`、`MZG_PACKAGED`→`LIVE_PACKAGED`、`MZG_CAPTURE_DIR`→`LIVE_CAPTURE_DIR`、`MZG_DESKTOP_DEV_URL`→`LIVE_DESKTOP_DEV_URL`、`MZG_OUTPUT_WIDTH/HEIGHT`→`LIVE_OUTPUT_WIDTH/HEIGHT`、`MZG_PNPM_BIN`→`LIVE_PNPM_BIN`、`MZG_STRESS_*`→`LIVE_STRESS_*` |
| `X-MZG-Local-Token`（HTTP 头） | `X-Live-Local-Token` | 本地守卫 token |
| `x-mzg-local-token`（常量） | `x-live-local-token` | `LOCAL_TOKEN_HEADER` 值 |
| `--mzg-local-token=`（命令行参数） | `--live-local-token=` | preload 注入 |
| `window.mzgDesktop`（preload 桥） | `window.liveDesktop` | 渲染层桥接 |
| `mzg-live-runtime-v1`（BroadcastChannel） | `live-runtime-v1` | 双窗口通信 |
| `MZG_LIVE_LOCAL_BACKUP`（备份 kind） | `LIVE_LOCAL_BACKUP` | backup.ts |
| 测试临时目录 `mzg-*` 前缀 | `live-*` | 测试 mkdtemp |

## 三、旧数据目录迁移

- 旧：`%APPDATA%\猫掌柜直播经营系统\`
- 新：`%APPDATA%\实景直播经营系统\`
- 迁移策略：当前无真实用户，首次发布版提供轻量迁移（检测旧目录存在则提示/复制），不强制。

## 四、仍待处理（见对应阶段）

- **业务硬编码去通用化**（服务区钟山/水城、商品类目洗护鞋、话术）：阶段 2
- **白名单知识内容**改通用合规模板 + SHA256 指纹联动：阶段 2
- **离线授权码机制**（可售卖）：阶段 3
- **README / 售卖文档**：阶段 4
