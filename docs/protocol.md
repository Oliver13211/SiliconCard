# 硅牌 LAN 协议 v1（M2-NET1..3 定稿）

> 本文档是 server（`packages/server`）与 client net 层（`packages/client/src/net`）的联机契约唯一事实源。
> **协议变更流程见 WF-NET：server 与 client 两侧的 `protocol.ts` 是双胞胎文件，必须同一提交修改，不兼容变更必须升版本号并在 UI 提示刷新。**

## 1. 总览

| 项 | 值 |
|---|---|
| 协议版本 | `1`（`PROTOCOL_VERSION`，两侧 `protocol.ts` 同步维护） |
| 传输 | WebSocket，文本帧，**每帧一条 JSON**（不支持二进制帧） |
| 服务端角色 | 权威节点：持有完整 `GameState`，客户端只见 `viewFor` 裁剪视图 |
| 对局上行 | **仅 `{ type: 'action' }`**（房间控制消息以 `{ type: 'room' }` 另列） |
| 服务发现 | mDNS 广播 `_siliconcard._tcp`（便利路径）+ **手动 IP:port 直连（硬性回退，永远可用）** |
| 断线重连 | `resume` op：按 `lastSeq` 续传席位日志 + 恒定一次全量对齐（sync） |

版本协商：连接建立后服务端首帧发 `welcome`（携带 `protocol`），客户端版本不符即断开（close 4003）；客户端每帧携带 `v` 字段，不符同样断开。

## 2. 帧信封与 seq 语义

### 2.1 客户端 → 服务端

```jsonc
// 对局上行（唯一的一种）
{ "v": 1, "type": "action", "action": { "type": "END_TURN", "playerId": "P1" } }

// 房间控制（另列，op 见 §3）
{ "v": 1, "type": "room", "op": { "name": "join", "code": "A4NLN5", "deck": { "...": "..." } } }
```

### 2.2 服务端 → 客户端

```jsonc
// 连接级帧（seq = null，不进席位日志、不回放）
{ "v": 1, "seq": null, "type": "welcome", "protocol": 1 }
{ "v": 1, "seq": null, "type": "error", "code": "RULE_VIOLATION", "message": "…", "ruleCode": "CARD_NOT_IN_HAND" }

// 席位帧（seq 非 null ⇒ 进入该席位回放日志，可随重连续传）
{ "v": 1, "seq": 1, "type": "room",  "op": { "name": "created", "code": "A4NLN5", "token": "…", "seat": "P1", "seats": { "…": "…" }, "phase": "lobby" } }
{ "v": 1, "seq": 2, "type": "sync",  "snapshot": { "…": "…，含 viewFor 视图与 legalActions…" } }
{ "v": 1, "seq": 3, "type": "events","events": [ { "type": "GAME_START", "…": "…" } ], "view": { "…": "…" }, "legalActions": [ ] }
```

### 2.3 seq 规则（重连的根基）

1. **每个席位一条独立递增计数**，从 1 起，对该席位所有 `seq !== null` 的帧 +1（两个客户端看到的 seq 各自成序，互不相干）；
2. `seq !== null` ⇔ 帧属于该席位的**可回放日志**（上限 4096 条，超出丢最旧）；`welcome` / `error` 恒为 `seq: null`；
3. 客户端持续追踪已见最大 seq（`lastSeq`）；重连时上报，服务端**回放所有 `seq > lastSeq` 的日志帧**，随后**恒定追加一次全量对齐（sync）**——日志无法覆盖（缺口）时只发 sync；
4. `lastSeq` 传 `null` 表示放弃续传，仅全量对齐；上报大于服务端日志末端的值按 null 处理；
5. 对局动作帧不单独编号：每动作产生的 `events` 帧承载状态推进，seq 保证两席位的帧序各自连续无缺口（测试锁定该不变量）。

### 2.4 全量对齐快照（sync.snapshot）

```jsonc
{
  "roomCode": "A4NLN5", "roomName": "客厅对战", "seat": "P1",
  "seats": { "P1": { "kind": "human", "connected": true },
             "P2": { "kind": "ai", "connected": true, "difficulty": "normal" } },
  "phase": "playing",              // lobby | playing | ended
  "seed": 424242,                  // 未开局为 null
  "view": { "…": "viewFor(state, seat) 视图，lobby 阶段为 null" },
  "legalActions": [ ]              // 仅轮到该席位且对局进行中非空；对手回合恒为空（不泄漏手牌可打性）
}
```

## 3. 房间控制 op（`{ type: 'room', op }`）

| op（客户端→服务端） | 载荷 | 成功回执（op.name） | 失败错误码 |
|---|---|---|---|
| `create` | `roomName?`、`deck`、`fillWithAi?` | `created`（含 `code`/`token`/`seat:'P1'`） | `ALREADY_SEATED` `ROOM_FULL`(房间数上限) `DECK_INVALID` |
| `join` | `code`、`deck` | `joined`（含 `token`/`seat:'P2'`） | `ROOM_NOT_FOUND` `ROOM_FULL` `ALREADY_SEATED` `DECK_INVALID` |
| `start` | `seed?`（缺省服务端取时钟派生） | `started`（双方各一份）+ 双方 `sync` | `NOT_HOST` `ROOM_NOT_FULL` `GAME_ALREADY_STARTED` |
| `add_ai` | `difficulty?`、`faction?` | `ai_added` + 双方 `sync` | `NOT_HOST` `AI_SEAT_TAKEN` `GAME_ALREADY_STARTED` |
| `resume` | `code`、`token`、`lastSeq` | `resumed`（含 `seat`/`replayed`）→ 回放帧 → `sync` | `ROOM_NOT_FOUND` `INVALID_TOKEN` `ALREADY_SEATED` |
| `leave` | 无 | `left`（随后断开连接） | `PROTOCOL_ERROR`(未就座) |

回执与广播（`started` / `ai_added` / `seat_update` / `resumed`）均走席位日志（seq 编号），重连时随之回放。

**断线语义**：socket 断开不等于弃权——席位保留，服务端向其余人类席位广播 `seat_update`（`connected:false`，联机 UI 重连提示的数据源）。全部人类席位断开超过宽限期（默认 60s，`--grace-ms` 可调）房间才销毁；销毁即撤销 mDNS 广播。注意：**create/join 回执若丢失（连接过早断开），客户端没有 token，只能重新 join**——resume 只服务于「已拿到凭据」的连接。

**卡组 DTO**（`deck`）：`{ faction, heroName?, cards: [{ cardId, count }] }`。结构在房间层校验（未注册卡牌 / 派系技能未注册 → `DECK_INVALID`），规则语义（张数等）由引擎 `initGame` 把关（两层校验职责分离，对齐 rules.md §12）。AI 席位卡组由服务端注入 `@siliconcard/ai` 合成卡池，无需上传。

## 4. 对局帧（events）

每个动作（人类或 AI）结算后，服务端向**每个人类席位**发一帧：

```jsonc
{ "v": 1, "seq": 3, "type": "events",
  "events": [ /* GameEvent[]（core 事件目录 v1，17 种） */ ],
  "view": { /* viewFor(state, 该席位)——对手手牌内容/牌库顺序/rng 永不出现（rules.md §10） */ },
  "legalActions": [ /* 该席位当前合法动作；非其回合为 [] */ ] }
```

- 客户端**零引擎逻辑**：视图与合法动作直接来自服务端，动作原样上行即可；
- 上行动作校验链：连接已就座 → `action.playerId` 必须等于席位（否则 `WRONG_SEAT`）→ 引擎结算；引擎 `RuleError` 转 `RULE_VIOLATION` 错误帧（原错误码放 `ruleCode`），**状态不动、对局继续**；
- `events` 帧也承载对局结束（`view.phase === 'ended'`，无独立帧型）。

## 5. AI 虚拟玩家托管（M2-NET3）

- 建房时 `fillWithAi: true`（人机房，空位即由 AI 填充）或房主 `add_ai`；
- AI 用 `@siliconcard/ai` 的 `createAiPlayer`（difficulty 缺省 `normal`），决策种子由对局 seed 确定性派生（`deriveAiSeed`）——同 seed → 同对局；
- AI 回合与服务端同步自动演进，其动作与人类动作走**同一结算管线**，人类席位照常收到 `events` 帧；
- `seats` 元数据标明 `{ kind: 'ai', difficulty }`；AI 席位无 socket、不产席位帧、不可 resume。

## 6. 服务发现与直连回退（M2-NET2）

### 6.1 mDNS（便利路径）

- 服务类型：`_siliconcard._tcp`（bonjour-service）；**每房间一条服务**；
- 实例名：`SiliconCard <房间名> #<房间码>`（服务名带房间信息）；
- TXT：`v=<协议版本>`、`code=<房间码>`、`room=<房间名>`；
- 浏览：`Discovery.browse(timeoutMs)` 返回 `{ instanceName, host, port, roomCode, roomName, protocolVersion }`；多播被禁/超时→空结果，不抛错不阻塞。

### 6.2 手动 IP:port 直连（硬性回退，预设硬约束）

- 直连 `ws://<IP>:<端口>` 即可用全部协议（建房/加入/重连），**不依赖 mDNS**；
- 配套发现：同端口 HTTP `GET /siliconcard/rooms` → `{ v, rooms: [{ code, name, phase, seats, openSeats }] }`（带 CORS 头，网页客户端可直接拉取）；
- 服务端启动横幅会打印全部局域网 IPv4 的直连地址（`--host 0.0.0.0` 时）。

### 6.3 HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /siliconcard/rooms` | 房间列表（上）；其余 404 |
| WebSocket 升级 | 同端口，任意路径 |

## 7. 服务端启动与模拟客户端（E2E 验收直用）

```bash
# 服务端（默认端口 49321；--no-mdns 关广播；--port/--host/--grace-ms/--max-rooms/--content-dir 可调）
yarn workspace @siliconcard/server start --port 49321

# 模拟客户端（随机合法动作策略，--seed 可复现；--fill-ai 人机房；--concede-after N 限长）
yarn workspace @siliconcard/server sim:host --port 49321 --seed 42
yarn workspace @siliconcard/server sim:join --port 49321 --code XXXXXX --seed 42
yarn workspace @siliconcard/server sim:join --port 49321 --auto          # 只知道 IP:port：HTTP 房间列表挑房
# 断线重连演练：kill 掉任一 sim 进程后按其打印的凭据重连
yarn workspace @siliconcard/server sim:join --resume CODE TOKEN LASTSEQ --seed 42
```

协议级验收测试（全部在 `packages/server`，`yarn workspace @siliconcard/server test`）：
`drift100.test.ts`（双客户端真实 ws 对跑 **100 局**：双方 viewFor / 事件流 / 独立引擎逐动作重放三重对账零漂移 + seq 连续性）、`rooms.test.ts`（房间生命周期/HTTP 列表/GC）、`protocol.test.ts`（垃圾帧/版本/越权动作/非法动作不改状态）、`reconnect.test.ts`（杀连接 30s 内恢复、seq 回放保真、lastSeq=null、伪造 token、双人局对手断线）、`aiSeat.test.ts`（AI 托管）、`discovery.test.ts`（mDNS 广播/浏览 + 关闭 mDNS 的直连回退）。

## 8. 关闭码与错误码

| close code | 含义 |
|---|---|
| 4002 | 协议违规（帧不可解析/二进制帧/超限/未知类型） |
| 4003 | 协议版本不符 |

`error.code`（`ProtocolErrorCode`）全集：`VERSION_MISMATCH` `PROTOCOL_ERROR` `ROOM_NOT_FOUND` `ROOM_FULL` `ROOM_NOT_FULL` `INVALID_TOKEN` `ROOM_GONE` `NOT_HOST` `ALREADY_SEATED` `SEAT_EMPTY` `AI_SEAT_TAKEN` `DECK_INVALID` `GAME_ALREADY_STARTED` `GAME_NOT_STARTED` `WRONG_SEAT` `NOT_IN_GAME` `RULE_VIOLATION`。

## 9. 版本化与兼容（WF-NET）

1. 消息形状/语义的任何改动：**server 与 client 两侧 `protocol.ts` 同一提交**，本文档同步更新；
2. 不兼容变更（旧客户端无法互通）必须 `PROTOCOL_VERSION + 1`，客户端按 `welcome.protocol` 校验并提示刷新；
3. additive 扩容（新增错误码 / op 字段）可保持版本号不变，但必须在本文档登记且旧客户端不得因未知字段崩溃（解析宽容：未知 op → `PROTOCOL_ERROR` 断开，未知字段忽略）；
4. 每次协议变更必须重跑双客户端 100 局零漂移测试与重连场景（WF-NET 第 3 步）。
