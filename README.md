# 硅牌 SiliconCard

[![CI](https://github.com/Oliver13211/SiliconCard/actions/workflows/ci.yml/badge.svg)](https://github.com/Oliver13211/SiliconCard/actions/workflows/ci.yml)
[![Deploy Pages](https://github.com/Oliver13211/SiliconCard/actions/workflows/deploy.yml/badge.svg)](https://github.com/Oliver13211/SiliconCard/actions/workflows/deploy.yml)

> 显卡与硬件梗主题的 1v1 卡牌对战 Web 游戏 — Three.js + React

把显卡和硬件圈的百态搬上牌桌：旗舰卡烧接口、A 卡光追、矿卡重生、信仰充值……
组建你的硬件牌组，与对手一决高下。

## 技术栈

- **React** — UI 与状态管理
- **Three.js** — 卡牌与对局场景的 3D 渲染
- **TypeScript** — 类型安全
- **Vite** — 开发与构建工具链

## 开发状态

✅ **M1 可玩 MVP 完成**（2026-10-04）——**线上可玩：<https://oliver13211.github.io/SiliconCard/>**，打开链接即可与内置 AI 完整打一局。

已交付：无头规则引擎（`@siliconcard/core`，60 张梗卡 + 4 套预组卡组）、Three.js 3D 牌桌 + React HUD、内置人机（Easy/Normal/Hard 三档启发式）、GitHub Pages 自动部署（push main 即上线）、CI 覆盖率门禁（core ≥85%）。

后续里程碑：M3 Agent 接口 → M2 局域网对战 → M4 内容量与平衡（见[任务拆分](docs/task-breakdown.md)）。

## 快速开始

```bash
yarn install        # 任意 yarn ≥1.22 均可引导，项目内自动切换到锁定的 Yarn 4
yarn dev            # 开发服务器 http://localhost:5173
yarn build          # 全仓构建
yarn test           # 测试（vitest）
yarn typecheck      # 类型检查
yarn lint           # ESLint
```

## 文档

- [设计报告](docs/design-report.md) — 规则、架构、里程碑基线
- [任务拆分](docs/task-breakdown.md) — M0→M4 全量 WBS
- [Agent 预设](docs/agents/presets.md) / [Workflow](docs/agents/workflows.md) / [项目 agent 指引](AGENTS.md)

## License

[MIT](./LICENSE)
