# agent.md — 硅牌 SiliconCard 项目 agent 指引

本文件是所有 AI agent（以及人类协作者）在本仓库工作的最高优先级操作指引。完整设计背景见 [docs/design-report.md](docs/design-report.md)。

## 项目一句话

显卡与硬件圈热梗主题的 1v1 回合制卡牌对战网页游戏：炉石式规则骨架 + Three.js 3D 牌桌 + React HUD；无头规则内核驱动三种对局来源（内置人机 / 外部 AI Agent / 局域网真人）。

## 设计支柱（一切决策的判断标准）

1. **梗即玩法**——机制源自真实硬件痛点，不做贴皮装饰；
2. **规则即双关**——关键词全部梗化命名，规则书本身是段子；
3. **引擎无头**——规则内核与渲染零耦合；
4. **内容数据驱动**——卡牌与派系全部 JSON 定义，可无限扩展。

## 仓库结构

| 路径 | 包 | 职责 |
|---|---|---|
| `packages/core` | @siliconcard/core | **无头规则引擎**：纯 TS、零运行时依赖，全项目唯一事实源 |
| `packages/content` | @siliconcard/content | 卡牌/派系/关键词 JSON 数据包（可 mod，不碰引擎） |
| `packages/ai` | @siliconcard/ai | 内置人机（启发式，只走公开接口，禁止读完整 state 作弊） |
| `packages/client` | @siliconcard/client | 网页端：React 19 + Three.js + Vite |
| `packages/server` | @siliconcard/server | LAN 对战 ws 权威服务端（持有完整 state） |
| `packages/cli` | @siliconcard/cli | Agent 对战 CLI（JSON 行协议） |
| `docs/` | — | 设计报告、规则书、任务拆分、agent 预设与 workflow |
| `.zcode/agents/` | — | 项目级 agent 注册（9 个，与 docs/agents/presets.md 同步维护） |

## 常用命令

| 命令 | 作用 |
|---|---|
| `yarn install` | 安装依赖（Yarn 4，版本由仓库锁定） |
| `yarn dev` | 启动 client 开发服务器（http://localhost:5173） |
| `yarn build` | 全仓构建（client 走 Vite） |
| `yarn test` | 全仓测试（vitest） |
| `yarn typecheck` | 全仓 `tsc --noEmit` |
| `yarn lint` | ESLint |
| `yarn workspace @siliconcard/<pkg> <script>` | 单包执行任意脚本 |

## 架构铁律（违反即打回）

1. `core` **零运行时依赖**；`GameState` 必须是可 JSON 序列化的纯数据；
2. **确定性**：一切随机经引擎种子 RNG，`seed + 动作序列` 可复现整局；
3. 引擎产出**事件流**；UI / AI / 网络只消费事件与 `viewFor` 视图，禁止绕过接口读完整 state；
4. 卡牌数值、文案、美术参数全部在 `content` JSON 中，禁止硬编码进逻辑；
5. 事件目录与卡牌 schema 是跨包契约，改动必须走 [WF-ENGINE](docs/agents/workflows.md)（含下游逐个通报）。

## Agent 体系

- **任务清单**：[docs/task-breakdown.md](docs/task-breakdown.md)——任务 ID、执行预设、依赖、验收标准；
- **预设完整人设**：[docs/agents/presets.md](docs/agents/presets.md)；**已注册项目级 agent**：`.zcode/agents/`；
- **标准流程**：[docs/agents/workflows.md](docs/agents/workflows.md)——改引擎走 WF-ENGINE，加卡走 WF-CARD，画面改动走 WF-VISUAL，联机协议走 WF-NET，Agent 接口走 WF-AGENT，数值走 WF-BALANCE，发布走 WF-RELEASE；
- 多 agent 并行时按预设「允许范围」隔离改动；跨包需求在汇报中提案，不自行扩散。

## 代码与协作规约

- TypeScript strict；所有逻辑包 `yarn typecheck` 必须干净；
- 测试是完成的一部分：core 关键路径单测 + 黄金回放；新卡三件套（JSON + 效果注册 + 单测）；
- 梗文案守则：圈内自嘲向全开（A 卡光追、烧接口等），红线是不攻击真实个人；口吻参考 design-report §2；
- Commit 遵循 Conventional Commits（`feat/fix/docs/chore/test/refactor` + 范围）；
- CI 绿才可合并（M0-INF3 落地后生效）。

## 当前状态与下一步

- 里程碑顺序（已拍板）：**M0 基建 → M1 可玩 MVP → M3 Agent 接口 → M2 局域网对战 → M4 内容量与平衡**；
- 下一步任务与验收标准见 [docs/task-breakdown.md](docs/task-breakdown.md)；
- 修改本文件的条件：架构铁律、包结构或工作流发生变化时，在 PR 中说明理由后更新。
