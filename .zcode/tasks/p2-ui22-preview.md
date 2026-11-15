# P2-UI2-2 沙箱效果预览面板 · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`。验收标准：`docs/phase2-plan.md` §P2-UI2-2。工作目录：仓库根。

## 背景

一期基建齐全：白话解释数据包 `packages/content/glossary/effects-glossary.json`（渲染语义基准 = `packages/core/src/content-tests/glossary.test.ts` 内 matchStep 注释，special > ops 优先级）+ 图鉴侧已有渲染器 `ui/codex/glossaryRender.ts`（直接复用）。本任务给卡牌效果做**可播放的沙箱迷你演示**——无头引擎的杀手级应用，零逐卡内容成本。

## 交付

1. **沙箱演示引擎**（`ui/preview/demoDriver.ts`，纯无头）：
   - 输入 cardId → 组演示卡组（目标卡 ×2 + 任选中性卡填满 30，全走引擎 DeckSpec 校验）→ **确定性种子扫描**（seed 从 1 递增，用 `viewFor` 查 P1 起手含目标卡即停——引擎毫秒级，扫描开销可忽略）；
   - 脚本推进：P2 每回合直接 END_TURN（对手零行动保持确定性），P1 在累计供电 ≥ cost 的首个回合打出目标卡（目标牌取第一个合法候选，走 getLegalActions 公开接口）；
   - 产出：开局事件 + 打出该卡批次的完整事件流 + 关键状态快照（打出前/后 HP、场上单位、供电）；
   - 结果缓存（同 cardId 幂等），全部走 core 公开四函数接口，禁读完整 state 做演示以外的用途（事件流与 view 是合法数据源）。
2. **演示画布**（`ui/preview/DemoCanvas.tsx`，2D 俯视示意）：小尺寸 canvas，绘制双方英雄块 + 场地槽位；按事件流播放：MINION_SUMMONED 卡片落到槽位、DAMAGE_DEALT 伤害数字飘出、HEALING 绿字上浮、护甲/跳闸/召唤光柱等按事件 type 简化示意；循环播放（约 3-5s 一轮）+ 暂停/重播按钮；动效用 requestAnimationFrame + 简易补间（禁引动画库），prefers-reduced-motion 时静态展示终态 + 步骤文字。
3. **预览面板**（`ui/preview/PreviewPanel.tsx`）：大图（复用图鉴 face 渲染路径的公开导出，禁复制实现）+ 白话解释（复用 `ui/codex/glossaryRender.ts`，import 不改）+ 关键词解释 + DemoCanvas + flavor。
4. **图鉴集成**（`ui/codex/CodexDetail.tsx` 是你的）：详情面板「演示」按钮从禁用占位改为真实展开 PreviewPanel（codex 域内改动允许——该目录现归你）。
5. **对战屏入口挂载约定**（接线留主控，你禁碰 BattleScreen）：导出 `PreviewPanel` 与触发所需的最小组件/props（如 `PreviewTrigger` 包裹或 `openPreview(cardId)`），汇报写清约定。
6. 样式：`styles/preview.css` 新文件由组件 import（禁改 hud.css）。

## 边界（并行期严格隔离）

独占：`ui/preview/**`、`styles/preview.css`、`ui/codex/CodexDetail.tsx`（仅「演示」按钮区域；codex 其余文件只读 import）。**禁碰**：`ui/codex/**` 其余文件、`ui/replay/**`、`ui/keybinds/**`、`ui/stats/**`、BattleScreen.tsx 与战报日志区（另一代理在做可读性）、PlayerPanel/HandCardView/UnitCardView、AppRoot.tsx、`three/**`、core、content、tokens.css（可读性代理专属）。
颜色/间距一律用 tokens.css 既有令牌（只读），不改令牌本身。

## 验证与汇报

定向测试：demoDriver 纯逻辑（种子扫描命中、事件流含目标卡 CARD_PLAYED、P2 零行动确定性、缓存幂等、cost>100 的卡在后续回合才打出）；禁跑全仓；禁 git commit/push。
汇报四字段：files / summary（演示引擎方案、画布表现、挂载约定）/ checks / deviations（如实——特别是 90 卡里有没有演示驱动不了的构造，如需对手目标的效果怎么处理）。
