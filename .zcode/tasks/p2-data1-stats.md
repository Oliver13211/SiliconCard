# P2-DATA1 数值面板 UI · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`。验收标准：`docs/phase2-plan.md` §P2-DATA1。工作目录：仓库根。

## 数据源（只 import 不改）

- 全局：`packages/client/public/data/balance-stats.json` = { generatedAt, gamesTotal, factions[{faction,deckId,winRate,games}], cards[{cardId,name,played,playedWinRate}] }。再生成脚本 scripts/gen-balance-stats.mjs（只读参考）。注意 GitHub Pages 子路径部署——fetch 用相对路径 './data/balance-stats.json'。
- 个人：`packages/client/src/ui/replay/storage.ts` 与 replayStore.ts 公开接口（读回放元数据聚合；只 import，禁改）。

## 交付（ui/stats/ 新目录）

1. StatsScreen 两层切换：
   a. 全局模拟——派系胜率横向条形图（7 派系、50% 基准线，纯 CSS/Canvas 自绘禁引库）+ 卡牌出场率/打出胜率表（按派系筛选、按列排序）+ generatedAt/gamesTotal 口径标注；
   b. 个人历史——总场次/胜负/胜率、按派系分布、最近 10 局列表（对阵/结果/日期，点击跳转回放的约定写汇报）。
2. 数字容错：回放库空/IndexedDB 不可用显示空态；fetch 失败重试按钮。
3. 每个数字带口径 hover 提示。
4. 挂载约定：AppRoot 路由与主菜单「数值」入口由主控接线，汇报写 route 名。

## 边界（并行期严格隔离）

独占 `ui/stats/**` 与 `styles/stats.css`。**禁碰**：ui/replay/**（只 import 公开接口）、ui/keybinds/**、ui/codex/**、AppRoot.tsx、screens/**、three/**、core、content、hud.css、scripts/**。

## 验证与汇报

- 定向测试（聚合纯函数：胜负/派系分布统计、空态容错），禁跑全仓；禁 git commit/push。
- 汇报四字段：files / summary / checks / deviations（如实）。
