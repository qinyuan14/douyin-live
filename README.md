# 实景直播经营系统（liveops-system）

基于 Electron + NestJS 的抖音直播经营辅助系统，提供**录屏播放、话术预生成音频、火山引擎 TTS 语音合成**等能力。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面端 | Electron 43 + React 19 + Vite 8 + TypeScript |
| 后端 | NestJS 11 + Express 5 + WebSocket |
| 数据存储 | PGlite（本地嵌入式 PostgreSQL，数据位于 `.data/`） |
| 包管理 | pnpm 11 monorepo |

## 环境要求

- **Node.js**：>= 24.16.0（< 25）
- **pnpm**：11.5.0（`npm i -g pnpm@11.5.0`）
- **系统**：Windows（打包产物为 Windows 安装包）

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 开发模式启动（自动拉起 API、渲染进程、Electron 桌面端）
pnpm dev

# 3. 生产模式启动（需先构建）
pnpm build
pnpm start
```

启动后桌面应用会自动连接本地 API（`127.0.0.1:3188`），Web 渲染页在 `http://127.0.0.1:5173`。

## 直接使用安装包（无需源码运行）

仓库 `release/` 目录已附带打包好的安装程序：

- `release/实景直播经营系统-v0.1.0-x64.exe` — 安装版（93 MB）
- `release/实景直播经营系统-v0.1.0-便携版.exe` — 便携版（免安装，93 MB）

下载后直接运行即可，无需安装 Node / pnpm。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 开发模式（热更新） |
| `pnpm build` | 构建全部包 |
| `pnpm start` | 生产模式启动 |
| `pnpm test` | 运行测试 |
| `pnpm lint` | 代码检查 |
| `pnpm typecheck` | 类型检查 |
| `pnpm --filter @liveops/live-desktop package` | 打包 Windows 安装包 |

## 项目结构

```
apps/
  api/        # NestJS 后端服务（端口 3188）
  desktop/    # Electron 桌面端（React + Vite 渲染层 + 主进程）
packages/
  contracts/  # 前后端共享类型契约
  core/       # 核心业务逻辑
docs/         # 产品文档（产品规格、架构评审、发布回滚方案等）
scripts/      # 构建/打包/压测脚本
.data/        # 运行时数据（PGlite 数据库、测试截图等，已随仓库共享）
release/      # 打包产物（安装包）
```

## 数据说明

- 运行数据（PGlite 数据库、话术库、截图等）位于 `.data/`，已随仓库共享，克隆后可直接使用。
- `runtime-token`、私钥（`*.pem`）等敏感凭证**不会**进入仓库，首次运行由系统自动生成。
- `node_modules`、`build/`、`release-bak-*`（历史发布备份）不纳入版本控制，`pnpm install` 会自动重建依赖。

## 许可

私有项目，未经授权请勿用于商业用途。
