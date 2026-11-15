# P2-QA1 AI 复盘 · 任务书（双域授权：game-ai 主身份 + client-ui 报告 UI）

任务执行者身份：先读 `.zcode/agents/game-ai.md` 与 `.zcode/agents/client-ui.md`，以 game-ai 身份为主（评分引擎），client-ui 职责经主控双域授权扩展到 ui/replay 的报告 UI（先例：M4-SND1）。验收标准：`docs/phase2-plan.md` §P2-QA1。工作目录：仓库根。

## 背景与现状

- 回放播放器已上线：`ui/replay/replayDriver.ts` 一次性快放重建 states 时间线（含每动作后完整 state）、`ReplayPlayerScreen.tsx` 有时间轴/事件日志、`replayStore.ts` 有当前打开的回放（player.meta/body）。
- ENG1 已落地：P2 起手含电费抵扣券（cardId `siliconcard-voucher`，cost 0，打出 +300W 当回合）——复盘必须把券当普通手牌对待（AI 可选打出）。
- AI 现状：`packages/ai/src/player.ts`（createAiPlayer 三档难度，决策层含券启发式）、`evaluate.ts`（局面评估）、`matchup.ts`。**禁止改动 player.ts/evaluate.ts 的既有行为**（bench 口径依赖），你只新增模块。

## 交付

1. **评分引擎**（`packages/ai/src/review.ts` + 测试）：
   - 入口 `runMatchReview(recording: ReplayRecording, viewerId: PlayerId): MatchReview`——用公开四函数接口重建时间线（initGame → 逐步 applyAction），在 **viewer 侧每个决策点**（该 viewer 是 activePlayer 且对局未结束的动作步）：
     a. 取实际动作；
     b. 用 **Hard 难度** createAiPlayer 在同一局面求 AI 的选择（注入固定 seed 保证确定性）；
     c. 两者一致 → S；不一致 → 用既有 evaluate 对「实际动作后局面」与「AI 选择后局面」各评分一次，按分差分档 B/A/C（阈值自定并写明，如 |Δ|<0.5 A、<2 B、否则 C——以实测分布为准）；
     d. **漏斩检测**：对每个决策点枚举 viewer 合法动作，逐个模拟一步，若存在使对手（或对局判定）立即进入「viewer 胜利」的 GAME_END 而实际未走 → lethalMissed 标记该步（模拟深度 = 一步，plan 授权）；
   - 产出 `MatchReview`：{ viewerId, steps: [{ actionIndex, score: 'S'|'A'|'B'|'C', actual, aiChoice, evalDelta, note? }], scores: {S,A,B,C 计数}, overall(0-100 加权), topMisses: [{actionIndex, reason} ≤3], lethalMissedSteps: number[] }；
   - `MatchRecording` 类型从 client 侧来（ui/replay/types.ts）——**ai 包不得 import client**：在 ai 内定义结构同构的入参类型（seed/players/actions + viewer），client 传 plain 对象；或引擎重建所需最小字段。取舍汇报说明。
   - 性能红线：30 步对局 < 10s（Hard 每步全模拟较重——实测；若超，提供 options.depth 降档路径并默认自适应，汇报写明实测数据）；可取消由 UI 层负责（引擎侧提供同步函数即可，UI 用 worker 化的异步包裹——若复杂可简化为同步 + UI 提示「复盘计算中」，汇报说明取舍）。
2. **报告 UI**（`ui/replay/` 内，ReplayPlayerScreen 集成）：
   - 播放器控制条加「AI 复盘」按钮 → 异步计算（进行中状态可见、可关闭面板）→ 报告卡：总评 + S/A/B/C 分布条 + 逐步评分曲线（时间轴同款事件索引对齐）+ Top 失误列表（点击跳转对应回放位置——复用既有 seek 机制）+ 漏斩横幅；
   - 样式走 tokens 既有令牌 + replay-player.css（禁改 hud.css）；
   - 评分数据不落库（本地计算即用即弃）。
3. **测试**：评分引擎无头单测——构造局面：正常跟 AI = S、明显亏模动作 = C、漏斩检出（构造一击致死局面）、券在手时的决策、确定性（同输入两次结果全等）。

## 边界

独占：`packages/ai/src/review.ts`（+其测试）、`ui/replay/ReplayPlayerScreen.tsx`（仅复盘按钮与报告卡集成区）、`ui/replay/ReviewPanel.tsx`（新）、`styles/replay-player.css`（追加段）。**禁碰**：core/**、ai 的 player.ts/evaluate.ts/matchup.ts（只 import）、ui/replay 其余文件（replayDriver/store 只读 import）、content、server、cli、three/**、AppRoot、其他 ui 域。并行无其他代理（bench 校准由主控自行执行，你不必跑 bench）。

## 验证与汇报

定向测试（ai 包 + ui/replay 定向）；禁跑全仓；禁 git commit/push。
汇报四字段：files / summary（评分口径与阈值实测依据、漏斩判定、性能实测、契约取舍）/ checks / deviations（如实）。
