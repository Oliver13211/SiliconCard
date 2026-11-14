# P2-α 修复：局域网对局回放录制 · 任务书

任务执行者身份：先读 `.zcode/agents/net-dev.md`，以其身份与边界约束自己（协议改动走 WF-NET 精神：additive 不破坏旧客户端，下游逐个通报写入汇报）。工作目录：仓库根。

## 背景与根因（主控已审计）

用户实测：打完一局，回放没有自动入柜。审计结论：
- 本地/人机对局录制链路完好（battleDriver 录制钩子 → recordFinishedMatch → IndexedDB，测试覆盖）；
- **缺口：局域网对局完全无录制**——服务端持有权威 state 与全部动作却没记录，客户端 RemoteBattleDriver 也无钩子；客户端看不到对手的原始动作，故录制必须落服务端；
- plan 验收标准写明「本地/人机/局域网三种对局均可录可放」，本任务补齐这一缺口。

## 现状事实（已核实，直接用）

- 服务端 `packages/server/src/gameHost.ts`（251 行）：权威引擎实例，`applyAction` 在 194 行附近；AI 托管席（fillWithAi）的动作也在服务端结算；`room.ts` 有 60s 宽限 GC。
- 协议 `packages/server/src/protocol.ts`（283 行）：房间 state 里 `seed: number | null` 客户端可见；消息以 name 分支。
- 客户端 `packages/client/src/net/remoteDriver.ts`：对局结束判定 = `frame.view.phase === 'ended'`；`connection.ts`/`rooms.ts` 为连接与房间 API 层。
- 客户端落库入口 `packages/client/src/ui/replay/replayStore.ts` 的 `recordFinishedMatch(match)`（match 形状见 `ui/replay/types.ts` 的 MatchRecording：recording{seed,players,actions}/viewer/winner/reason/turns/startedAt/endedAt）+ `ui/replay/storage.ts` 的 IndexedDB 后端（id = stableHash(recording)）。

## 交付

1. **服务端录制**：gameHost（或 room 层，按其结构取舍）在每局开始时记录 startedAt/seed/双方 DeckSpec，权威 applyAction 逐动作追加（含 AI 席动作），GAME_END 时定格 winner/reason/turns/endedAt；每房间保存**最近一局**完赛录制即可（内存，房间 GC 时随房销毁）。
2. **协议（additive）**：
   - 客户端→服务端：`{ name: 'replay_fetch' }`；
   - 服务端→客户端：`{ name: 'replay_data', match: <MatchRecording 形状> }`（viewer 填请求席位的 playerId；startedAt 用本局开始时刻）；
   - 服务端无录制可给（房间刚重开/无完赛）时回 `{ name: 'replay_data', match: null }`，客户端静默不提示（或 console 留痕）。
3. **客户端**：检测到对局结束（phase ended）后发 replay_fetch，收到 replay_data 且 match 非 null 时调 `recordFinishedMatch` 落本地库（复用既有去重：同录制同 id）。落库确认反馈不归你（另一代理在做 toast），你只保证把 MatchRecording 送到 recordFinishedMatch。
4. **测试**：服务端——录制内容正确性（动作序列与 drift 测试同口径的镜像对局逐动作核对、AI 席动作入列、GAME_END 元数据、无完赛时 match:null）；协议回环测试。既有 drift100/reconnect 测试必须保持绿。

## 边界

- **禁改** packages/core（引擎与 MatchRecording 契约不动）；服务端录制是纯服务端职责；
- 协议只加不改：既有消息形状零变化（老客户端不受影响）；
- 客户端侧只准动 `net/**` 与 lanStore/LanScreen 中「对局结束 → 取回放」的接线点；**禁碰** ui/replay/**（除 import recordFinishedMatch）、ui/keybinds、AppRoot、three/**；
- 服务端改动限 packages/server/**。

## 验证与汇报

定向测试（server 全套本就小，可全跑 server 包测试）；禁跑 client 全仓；禁 git commit/push。
汇报四字段：files / summary（录制挂点、协议形状、席位 viewer 语义）/ checks / deviations（如实）。
