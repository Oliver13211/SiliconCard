# 硅牌 SiliconCard

> 显卡与硬件梗主题的 1v1 卡牌对战 Web 游戏 — Three.js + React

把显卡和硬件圈的百态搬上牌桌：旗舰卡烧接口、A 卡光追、矿卡重生、信仰充值……
组建你的硬件牌组，与对手一决高下。

## 技术栈

- **React** — UI 与状态管理
- **Three.js** — 卡牌与对局场景的 3D 渲染
- **TypeScript** — 类型安全
- **Vite** — 开发与构建工具链

## 开发状态

🚧 M0 立项基建进行中：设计已定稿（[设计报告](docs/design-report.md)），脚手架就绪。

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
- [Agent 预设](docs/agents/presets.md) / [Workflow](docs/agents/workflows.md) / [项目 agent 指引](agent.md)

## License

[MIT](./LICENSE)
