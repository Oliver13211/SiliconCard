# P2-UI4 全卡图鉴 · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`。验收标准：`docs/phase2-plan.md` §P2-UI4。工作目录：仓库根。

## 数据与渲染基建（只 import 不改）

- `packages/content/glossary/effects-glossary.json` + README：白话翻译数据包；渲染语义基准 = `packages/core/src/content-tests/glossary.test.ts` 内 matchStep 注释（special > ops 优先级、占位符替换）。
- `packages/client/src/three/CardFace.ts` 导出面（resolvePalette / drawCardFace / composeCardFaceArt / TextureCache）：图鉴卡面必须同源渲染（同一函数同一参数，复用缓存，禁绕过）。
- `packages/client/public/data/balance-stats.json`：{ generatedAt, gamesTotal, factions[], cards[{cardId,name,played,playedWinRate}] }（86 卡有记录，无记录显示「暂无出场记录」）。

## 交付（ui/codex/ 新目录）

1. CodexScreen：90 卡瀑布网格（响应式列数），筛选（派系 ×7 / 稀有度 ×4 / 类型 gpu·driver·accessory / 费用区间）+ 排序（费用/名称/稀有度）。
2. 卡面同源渲染：Canvas 调 CardFace 既有函数出图，与对局内一致。
3. 详情面板：点卡出大图 + 白话解释（EffectSpec 按 glossary 语义逐 step 翻译成中文句，客户端实现 matchStep 同语义渲染器）+ 关键词解释 + flavor + 数值 + 平衡数据。
4. 挂载约定：AppRoot 路由与主菜单「图鉴」入口由主控接线，汇报写 route 名。

## 边界（并行期严格隔离）

独占 `ui/codex/**` 与 `styles/codex.css`（组件 import）。**禁碰**：ui/replay/**、ui/keybinds/**、ui/stats/**、AppRoot.tsx、screens/**、three/**（只 import）、core、content、hud.css。

## 验证与汇报

- 定向测试（筛选逻辑、翻译渲染与 matchStep 语义对齐、卡面缓存复用），禁跑全仓；禁 git commit/push。
- 汇报四字段：files / summary / checks / deviations（如实）。
