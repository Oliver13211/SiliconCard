# P2-α 修复：回放界面打磨 + 落库反馈 + 端到端测试 · 任务书

任务执行者身份：先读 `.zcode/agents/client-ui.md`，以其身份与边界约束自己。工作目录：仓库根。

## 用户反馈（原话转述）

1. 「回放界面有点简陋」——ReplayScreen（回放库）与 ReplayPlayerScreen（播放器）观感需要打磨；
2. 「有几个按钮设计不统一」——按钮风格与全站设计体系不一致；
3. （主控补充）本地落库是纯静默的，用户无从确认回放是否已保存——需要轻量反馈。

## 现状事实（直接用）

- 设计体系：`ui/styles/tokens.css`（令牌与 sc-btn 按钮系/输入/滚动条基元）+ `motion.css`（动效关键帧）+ `hud.css`（@import 总入口，**禁改**）。统一按钮 = 用 tokens.css 里现成的 `sc-btn / sc-btn--primary / sc-btn--small` 类，不发明新按钮样式。
- 回放域文件（你的地盘）：`ui/replay/ReplayScreen.tsx`（回放库）、`ui/replay/ReplayPlayerScreen.tsx`（播放器）、`ui/replay/replayStore.ts`（store，含 recordFinishedMatch）、`ui/replay/replayDriver.ts`、`styles/replay.css`、`styles/replay-player.css`。
- 落库入口：`recordFinishedMatch`（AppRoot 注入 battleDriver sink 后调用；成功/失败目前只 console.warn——replayStore 内部，可改）。

## 交付

1. **按钮与观感统一**：回放库与播放器的全部按钮收敛到 sc-btn 体系（检查两屏内所有 button，凡自造样式的改用既有类 + 必要时 replay*.css 内的布局类）；面板走 tokens 玻璃拟态令牌；条目列表卡片化（hover 态、空态文案友好化——如「还没有对局存档，打完一局就会出现在这里」）；时间轴与图例样式对齐 tokens；动效用 motion.css 既有关键帧（入场滑入等），禁新增大型动画。
2. **落库反馈 toast**：replayStore 增加保存状态（如 saveState: 'idle'|'saved'|'failed' + 最近一条 meta 摘要），recordFinishedMatch 成功/失败置位；新组件 `ui/replay/ReplaySaveToast.tsx`（小 toast，文案如「✓ 本局回放已入柜」/「回放入柜失败（存储不可用）」，几秒自动消失，走 motion.css 进出场，aria-live polite）。**组件与 store 归你；AppRoot 挂载由主控接线**——汇报写清挂载方式（如 `<ReplaySaveToast />` 全局层）。对局零感知铁律不变：toast 展示不阻塞对局/结算。
3. **端到端集成测试**（锁本地链路）：新测试用例——gameStore.startBattle(seed) 按既有 gameStore.test.ts 的模拟打法推进到终局（可注入/触发认输 CONCEDE 快速终局），注册内存后端（configureReplayBackend）+ setMatchRecordingSink 真链路，断言后端恰有 1 条回放、meta 字段齐全、再来一局第二局后变 2 条。落 `ui/replay/__tests__/` 下新文件。

## 边界

独占 `ui/replay/**`、`styles/replay.css`、`styles/replay-player.css`、新 `ui/replay/ReplaySaveToast.tsx`；**禁碰** AppRoot.tsx（toast 挂载留主控）、screens/**、battleDriver.ts、ui/keybinds/**、ui/codex/**、ui/stats/**、three/**、hud.css、net/**（LAN 录制接线由另一代理并行做，勿交叉）。

## 验证与汇报

定向测试（你新增的用例 + 既有 replay 域测试全绿）；禁跑全仓；禁 git commit/push。
汇报四字段：files / summary（统一了哪些按钮、toast 状态机、集成测试覆盖点）/ checks / deviations（如实）。
