# P2-UI1 界面可读性改版 · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`。验收标准：`docs/phase2-plan.md` §P2-UI1。工作目录：仓库根。

## 用户目标

「React 界面风格和样式更可读」——信息层级清晰、不用眯眼看。

## 现状事实

- 样式体系：`ui/styles/tokens.css`（设计令牌）→ `hud.css`（@import 总入口）→ `screens.css` / `battle.css` / `motion.css` / `replay.css` / `keybinds.css` / `codex.css` / `stats.css` / `replay-player.css`。
- 对局 HUD 组件：`components/PlayerPanel.tsx`（血条/功耗条/派系点缀/AnimatedNumber）、`components/HandCardView.tsx`（手牌卡，含功耗徽标与牌名布局）、`components/UnitCardView.tsx`、`components/AudioControls.tsx`、战报日志组件（找 BattleScreen 里事件日志的渲染处）。
- 对局屏：`screens/BattleScreen.tsx`；`gameStore` 的 legal/lastError 语义已有（可打/禁用/供电不足 reason）。

## 交付

1. **全局可读性基线**：正文字号/行高/对比度整体上调（WCAG AA 起步：正文 ≥4.5:1，大字 ≥3:1）；tokens.css 令牌层面调（派生色一并核），不逐处魔法数。
2. **HUD 数值区**：血量/功耗数值加大加粗（与 AnimatedNumber 脉冲兼容）；状态语义色统一收敛到 tokens（可打/禁用/供电不足/低血危险——与现有 starved 红脉冲语义接续，不发明新语义）。
3. **手牌区**：收窄装饰、留白让位牌名与费用；**长牌名截断策略**（两行内 ellipsis + title tooltip 全名；核对功耗徽标不盖字——之前修过一次几何，别回退）。
4. **战报日志**：按回合分组折叠（回合头可点收起/展开，默认展开最近 2 回合、其余折叠）；关键事件高亮（斩杀/GAME_END/跳闸 BURN_OUT/质保破 shieldConsumed/传说入场——按事件 type/关键字段判定，样式走 tokens 语义色）。
5. **对比度验收**：改完用工具核（node 脚本算主要前景/背景组合对比度并打印表格，脚本放 scripts/check-contrast.mjs 或测试内断言，选择留汇报）——产出报告进汇报。

## 边界（并行期严格隔离）

独占：`styles/tokens.css`、`styles/battle.css`、`styles/screens.css`、`components/PlayerPanel.tsx`、`components/HandCardView.tsx`、`components/UnitCardView.tsx`、战报日志组件（BattleScreen 内日志段或其组件文件）、`BattleScreen.tsx` 中日志分组相关改动、`scripts/check-contrast.mjs`（新）。**禁碰**：`ui/codex/**`、`ui/replay/**`、`ui/preview/**`（另一代理在建）、`ui/stats/**`、`ui/keybinds/**`、AppRoot.tsx、`three/**`、core、content、hud.css（import 结构不动）。gameStore 只读（starved 等语义已存在，不加字段）。
注意：`ui/preview/**` 是并行代理的新目录，BattleScreen 的预览入口接线由主控收口做——你不动 BattleScreen 的预览相关区域。

## 验证与汇报

定向测试（既有 ui 测试保持绿 + 若日志分组加了纯函数则配单测）；可跑 ui 相关定向测试，禁跑全仓；禁 git commit/push。
汇报四字段：files / summary（改了哪些层级、语义色收敛表、对比度核验结果）/ checks / deviations（如实）。
