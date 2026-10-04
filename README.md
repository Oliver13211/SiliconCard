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

## 🤖 AI Agent 挑战

让任何 coding agent（Claude / Codex / …）来玩硅牌：**读 skill 文档 → 起一局 → 写动作**，三步接入，全程无需人类干预。

**① 让 agent 读规则速查**：[docs/agent-skill.md](docs/agent-skill.md)（单独可读：规则摘要 + 动作 schema + 错误纠正 + 策略提示）

**② 起一局**（文件回合制，外部 agent 执 P1 先手）：

```bash
yarn workspace @siliconcard/cli play --mode file --seed 42
```

CLI 在交换目录轮转写 `turn.json`（= 你视角的战局 + 全部合法动作，每条带中文说明）；agent 写 `action.json` 回应；终局出 `gameover.json`。交换目录默认固定在**仓库根下的 `silicon-card-game/`**（启动行会打印实际使用的绝对路径，`--dir` 可覆盖）。同 `--seed` + 同动作序列整局可复现；`--difficulty easy|normal|hard`、`--deck <预组卡组id|JSON路径>` 可选；子命令帮助看 `play --help`（顶层 `--help` 会被 yarn 拦截）。

**③ agent 写动作**：从 `turn.json` 的 `legalActions` 里挑一条，把其 `action` 对象原样写进 `action.json`：`{ "action": { … } }`。动作被拒时 `turn.json` 的 `lastError` 会给出纠正指引，改完重发即可。

20 行以内的 Node 驱动骨架（可运行的完整版在 [packages/cli/examples/simple-agent.mjs](packages/cli/examples/simple-agent.mjs)）：

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const dir = 'silicon-card-game'
let seenSeq = -1
while (!existsSync(`${dir}/gameover.json`)) {
  if (!existsSync(`${dir}/turn.json`)) continue
  const turn = JSON.parse(readFileSync(`${dir}/turn.json`, 'utf8'))
  if (turn.seq === seenSeq || turn.phase === 'ended') continue // 只对最新局面出招
  seenSeq = turn.seq
  const endTurn = turn.legalActions.find((l) => l.kind === 'END_TURN')
  const plays = turn.legalActions.filter((l) => l.kind === 'PLAY_CARD')
  const action = (plays[0] ?? endTurn).action // ← 你的策略：从 legalActions 挑一条
  writeFileSync(`${dir}/action.json`, JSON.stringify({ action }))
}
console.log('对局结束：', JSON.parse(readFileSync(`${dir}/gameover.json`, 'utf8')).winner)
```

其它玩法：`yarn workspace @siliconcard/cli play --mode stdio --seed 42`（JSON 行协议，宿主程序直驱）、`yarn workspace @siliconcard/cli demo --seed 42`（内置 AI 自对弈观战，输出对局事件流）、`yarn workspace @siliconcard/cli mcp`（MCP server：`silicon_start / silicon_view / silicon_act` 三工具，stdio JSON-RPC）。播完一局想复盘？`demo --seed` 同种子两遍输出逐行一致，确定性由引擎保证。

## License

[MIT](./LICENSE)
