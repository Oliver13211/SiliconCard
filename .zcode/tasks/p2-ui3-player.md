# P2-UI3 回放播放器 · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`。验收标准与背景：`docs/phase2-plan.md` 的 §P2-UI3。工作目录：仓库根。

## 现状（第一波已交付，你的地盘）

- `packages/client/src/ui/replay/**`：ReplayRecording 存储（IndexedDB，LRU-50）、JSON 导出导入（schemaVersion+stableHash 校验）、ReplayScreen 回放库屏、replayStore。
- `packages/client/src/ui/game/battleDriver.ts`：对局驱动器与 3D 演出接线（含录制钩子）。
- `packages/core/src/testing/replay.ts`：ReplayRecording 结构；`packages/core/src/engine/index.ts`：initGame/applyAction/getLegalActions/viewFor 四函数接口。
- `packages/client/src/ui/keybinds/commands.ts`：回放命令注册（replay_play_pause / replay_step / replay_speed）。

## 交付

1. `ui/replay/` 内新建 ReplayPlayerScreen：按录制动作序列重驱引擎（initGame(setup) → 逐步 applyAction），每步事件流驱动 3D 演出与音效。方案自选（复用 battleDriver 注入模式或独立回放驱动器），取舍写进汇报。
2. 控制条：播放/暂停、变速 0.5×/1×/2×/4×、逐事件步进、时间轴拖动（seek = 引擎从头快放至目标事件索引）、关键事件着色标记（攻击/召唤/传说入场/跳闸）可点跳转。
3. 上帝视角：双方手牌全量可见。viewFor 会裁剪对手手牌——用重放重建的完整 GameState 自行构造双方视角切片；**不许改 core**（确需 core 辅助函数时写提案进 deviations 并用现有能力绕行）。
4. 事件日志侧栏与时间轴双向联动；退出返回回放库屏；hash 校验失败的回放只读开放并提示「与当前卡池版本不符」。
5. 接入 ui/keybinds 的回放命令键位。

## 边界（并行期严格隔离）

独占 `ui/replay/**`（可改造 ReplayScreen）。**禁碰**：AppRoot.tsx、screens/**、battleDriver.ts、ui/keybinds/**、ui/codex/**、ui/stats/**、three/**、hud.css、packages/core、content。样式写自己的组件或新增 `styles/replay-player.css` 由组件 import。AppRoot 路由由主控统一接线——汇报里写清挂载约定（route 名与参数）。

## 验证与汇报

- 只跑定向测试（重放后 stableHash 对齐、seek 幂等、视角切片断言），禁跑全仓。
- 禁止 git commit/push。
- 汇报四字段：files / summary（重驱方案、上帝视角取舍、挂载约定）/ checks / deviations（如实）。
