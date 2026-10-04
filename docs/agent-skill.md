# 硅牌 SiliconCard · AI Agent 对战 Skill（规则速查 + 接口手册）

> 读者：第一次接触硅牌的 coding agent。本文**单独可读**：读完即可零人类干预打满一局。
> 规则的引擎级精确定义在 `docs/rules.md`（本文件是其面向 agent 的摘要），接口即本文 §5–§7。
> 版本 v1.0.1 · 对应 core `0.1.0`。

---

## 1. 这是什么 & 一行开局

硅牌：显卡硬件圈梗主题的 1v1 回合制卡牌对战。你（外部 agent）执 **P1 先手**，对手是内置 AI（执 P2）。

**一行开局（文件回合制，最省事，推荐；命令均在仓库根目录执行）：**

```bash
yarn workspace @siliconcard/cli play --mode file --seed 42
```

CLI 会在交换目录轮转写 `turn.json`；你写 `action.json` 回应；终局出 `gameover.json`。完整流程见 §5。

> **交换目录在哪**：默认固定在**仓库根下的 `silicon-card-game/`**（`yarn workspace` 会把进程 cwd 切到 packages/cli/，但默认目录不随之漂移）；**CLI 启动行会打印交换目录的绝对路径**，找不到直接看启动行。可用 `--dir <绝对路径|相对路径>` 自定义。查看帮助要带子命令（`yarn workspace @siliconcard/cli play --help`；顶层 `…cli --help` 会被 yarn 拦截报 Unknown Syntax Error）。

**备选：stdio JSON 行协议**（宿主程序/管道驱动）：

```bash
yarn workspace @siliconcard/cli play --mode stdio --seed 42
```

**观战**（可选，帮你建立直觉）：`yarn workspace @siliconcard/cli demo --seed 42`

---

## 2. 游戏目标（怎么赢）

- 双方各是一台 CPU：**体质 30 点**。一方体质被扣到 ≤0 → 对方胜。
- 认输（CONCEDE）立即判负；**牌库抽空后每次"抽牌"改为吃疲劳伤害**（第 1/2/3…次分别扣 1/2/3…点）——所以对局一定会自然结束，拖到后期疲劳会烧死牌库薄的一方。
- 双方同时归零 = 平局（罕见）。

## 3. 回合流程（轮到你时能做什么）

轮到你时，以下事情**任意次、任意顺序**做，直到你打出 `END_TURN`：

1. **供电（功耗）**：你的第 k 回合供电上限 = min(k×100, 1000)W，每回合初 +100W。出牌/用派系技能都要花功耗（W）。
2. **抽牌**：每回合开始自动抽 1 张（你的第 1 回合不抽——先手补偿）。手牌上限 10，回合结束超限自动烧牌。
3. **出牌 / 攻击 / 技能**：见下。
4. **结束回合**：打出 `END_TURN` 交出行动权。

关键限制：

- **单位入场当回合不能攻击**（"召唤失调"），有关键词 `charge`（超频）的除外；
- **场上每方最多 7 个单位**（扩展槽）；满员时不能上单位（显卡与配件都占槽，驱动法术不占）；
- **敌方有信仰充值（taunt）单位时，你的攻击必须先打它**；
- 你的每回合**派系技能只能用一次**（固定 200W）。

## 4. 卡牌类型与功耗经济

卡组 **30 张**，预组卡组见 `packages/content/decks/*.json`。所有费用 = 功耗（W），范围 **100–1000W**（多数卡名对应真实显卡的 TDP，比如 575W 的旗舰卡）。

| 类型 | 说明 |
|---|---|
| `gpu`（显卡） | 主战单位：有攻击/血量，入场后站场上互殴 |
| `driver`（驱动） | 法术：打出即结算效果，不占场上 |
| `accessory`（配件） | 打出后**进场上**，以 0/1 身板入场，不能攻击，可被效果指定，常带光环 |

**7 个关键词**（合法动作与错误都可能因它们出现，务必认识）：

| id | 显示名 | 效果 |
|---|---|---|
| `taunt` | 信仰充值 | 敌方攻击必须先指定它 |
| `divine_shield` | 三年质保 | 抵消下一次任何伤害（一次），触发即消失 |
| `charge` | 超频 | 入场当回合即可攻击 |
| `windfury` | 双芯 GPU | 每回合可攻击 2 次 |
| `deathrattle` | 蓝屏/传家宝 | 死亡时触发亡语效果 |
| `stealth` | 无输出亮机 | 它攻击前不可被敌方指定；攻击后现身 |
| `overload` | 跳闸 | 打出后你下回合部分功耗被锁定（牌面效果会写锁多少） |

**派系技能**（每回合一次，200W）：`nvidia` DLSS=己方单位攻+1（需指定目标）· `amd` 开光追试试=指定目标打 1 伤但 70% 才成功 · `intel` 驱动更新=抽 1 张 · `neutral` 清灰=指定目标打 1 伤。卡牌含义随时查 `turn.json` 的 `cardGlossary`（cardId → 名称/类型/身板/关键词/效果文本）。

---

## 5. 接口 · 文件模式（推荐）

**目录**：默认固定在仓库根下的 `silicon-card-game/`（见 §1「交换目录在哪」），可用 `--dir` 覆盖。**轮转规则（带回执，绝不静默丢动作）**：

```
CLI 写 turn.json（seq 递增，lastSettled=上一次动作的裁决回执）
  ──→ 你发现 seq 变化后看 lastSettled：
        · lastSettled=null 或仍是上一个动作 → 你刚提交的还没被消费，继续等
        · accepted=true  → 已结算，可提交下一个动作
        · accepted=false → 被拒，按 lastError.hint 纠正后重写 action.json（对局状态未变）
  ──→ CLI 消费 action.json 并结算，重写 turn.json（seq+1）──→ …… ──→ 终局写 gameover.json
```

- **只在 turn.json 变化后行动**（用 `seq` 字段判断新旧；动作必须基于**最新**局面）。
- **action.json 内容**：`{ "action": <turn.json 里 legalActions 数组中任选一条的 action 对象，原样照抄> }`。
- **回执保证**：每个动作文件被消费后，CLI 一定用**下一次原子写入**（seq+1 的 turn.json）告知裁决——接受（`lastSettled.accepted=true`）或拒绝（`lastSettled.accepted=false`，`lastError` 与其同源、与 seq 同一次写入，绝不迟到）。**CLI 绝不静默丢弃动作文件**：若你在 CLI 结算/AI 回合期间提前写入，该动作会在下一个轮询周期被正常消费（局面已变时会被拒绝并出回执，纠正重发即可）。
- `gameover.json` 出现 = 对局结束：含 winner / finalState / **全程 `log`（人话）与 `events`（引擎原始事件，共 totalEvents 条）**，可复盘整局。
- `--seed 42`、`--difficulty easy|normal|hard`、`--deck <预组卡组id|JSON路径>`、`--opponent-deck <…>`、`--wait-timeout <秒>` 可选；同 seed+同动作序列整局可复现。

### turn.json 逐字段

| 字段 | 含义 |
|---|---|
| `protocol` / `message` | `"siliconcard.file/1"` / 恒 `"state"` |
| `seq` | 递增序号，用于判断这是不是新局面 |
| `you` / `waitingFor` | 你的执方（`"P1"`）；等谁行动 |
| `turn` / `phase` / `activePlayer` / `winner` / `endReason` | 顶层便捷字段，与 `state.*` 内的同名字段**同源**（保留冗余是为了免解嵌套）；`phase` 为 `"ended"` 时对局结束 |
| `state` | 你视角的战局（见下） |
| `legalActions` | **当前全部合法动作**，每条 = `{ action, kind, summary }`：`action` 原样回传即可执行，`summary` 是中文说明（已含卡名/功耗/目标） |
| `cardGlossary` | `{ cardId → { name, type, cost, attack?, health?, keywords?, effectText?, flavor? } }`，覆盖手牌与场上单位 |
| `heroPowers` | 双方派系技能说明 |
| `log` / `events` | 自上一条消息以来的事件（人话版 / 引擎原始事件） |
| `lastSettled` | **动作裁决回执**：`{ accepted: true, action }`=已结算；`{ accepted: false, action?, error }`=被拒；null=尚无裁决。提交动作后靠它确认「被拒/被接受/尚未消费」 |
| `lastError` | 上次被拒的原因与纠正指引（= `lastSettled.error` 的快捷视图，与 seq 同一次原子写入，null=无错） |
| `help` | 协议静态说明（含动作 schema 速查，忘起来翻这里） |

### state 视图（视角裁剪，规则保证）

- `state.you`：你的公开数值 + **完整手牌**。手牌条目是**轻量引用** `{uid, cardId, cost}`——`uid` 是出牌凭据（每局唯一），卡名/身板/效果文本**二次查 `cardGlossary[cardId]`**（`legalActions[].summary` 也已把卡名和效果翻成人话）；
- `state.opponent`：对手**只有计数**（handSize/deckSize/graveyardSize 等，永远看不到内容）；
- `state.board`：双方场上单位全量——**`ownerId: "P1"|"P2"` 标明该单位归谁（判定攻击目标、换血、斩杀时先看这个字段区分敌我）**，`instanceId` 是攻击/指定目标时用的引用 id，另有攻击力/血量/关键词/`attacksRemaining`（>0 才能攻击）。

## 6. 接口 · stdio 模式（宿主程序用）

- CLI → 你（stdout，每行一个 JSON）：`{"type":"hello", …}` → `{"type":"state", …turn.json 的全部字段…}` → 终局 `{"type":"gameover", …}`；
- 你 → CLI（stdin，每行一个 JSON）：`{"type":"action", "action":{…}}`（也接受 `{"action":{…}}` 或裸动作对象）；可选心跳 `{"type":"ping"}`；
- 其余语义（lastSettled/lastError 回执、seq、legalActions）与文件模式完全一致；stdout 只出协议 JSON，人读进度走 stderr。

## 7. 动作 schema（逐字段）

**永远优先照抄 `legalActions[].action`**——合法目标已全部展开，无需自行构造。手拼时按以下 schema（`playerId` 恒为 `"P1"`）：

```jsonc
// TargetRef（指到一个单位或 CPU）：
//   { "kind": "unit", "instanceId": "u7" }     // instanceId 见 state.board
//   { "kind": "hero", "playerId": "P2" }        // 打对面的 CPU 本体

{ "type": "PLAY_CARD",     "playerId": "P1", "uid": "h1",  "target": {"kind":"unit","instanceId":"u3"} }
// uid 必须来自 state.you.hand；需要 target 的牌（战吼指定目标等）必须带 target

{ "type": "ATTACK",        "playerId": "P1", "attackerId": "u7", "target": {"kind":"hero","playerId":"P2"} }
// attackerId 必须是己方场上单位且 attacksRemaining>0；入场当回合不可攻击（charge 除外）

{ "type": "USE_HERO_POWER","playerId": "P1", "target": {"kind":"unit","instanceId":"u3"} }
// 200W，每回合一次；amd/neutral 技能需要 target，nvidia 需 target，intel 不需要

{ "type": "END_TURN",      "playerId": "P1" }   // 结束回合（必合法）
{ "type": "CONCEDE",       "playerId": "P1" }   // 认输
```

## 8. 常见错误与纠正（lastError.code → 怎么改）

| code | 原因 | 纠正方向 |
|---|---|---|
| `NOT_YOUR_TURN` | 轮不到你 | 等下一条 turn.json / state 消息 |
| `CARD_NOT_IN_HAND` | uid 不在手牌 | 只用最新 `state.you.hand` 的 uid；或照抄 legalActions |
| `INSUFFICIENT_MANA` | 功耗不够 | 剩余功耗 = `state.you.mana`；选 cost ≤ mana 的牌或 END_TURN |
| `INVALID_TARGET` | 目标不合法 | 看 `detail.reason`；合法目标已全部展开在 legalActions |
| `UNIT_NOT_ON_BOARD` | attackerId 不在你场上 | 只能攻己方在场单位且 `attacksRemaining>0` |
| `UNIT_CANNOT_ATTACK` | 次数用尽 / 召唤失调 | 换别的单位攻击，或 END_TURN |
| `TAUNT_BLOCKING` | 敌方有嘲讽 | 必须先打 taunt 单位（legalActions 里已过滤出合法目标） |
| `BOARD_FULL` | 场上 7 格已满 | 打 driver 法术或 END_TURN，下回合再说 |
| `HERO_POWER_USED` | 技能本回合已用 | 每回合一次；改出牌/攻击 |
| `UNKNOWN_ACTION` | 结构不合法 | 照抄 legalActions[].action，别手拼 |
| `DECK_INVALID` / `FACTION_UNREGISTERED` | 开局参数问题（卡组不是 30 张 / 派系技能未注册） | 检查 `--deck` / `--opponent-deck`：用 content 预组卡组 id（nvidia/amd/intel/neutral 四系）或合法卡组 JSON |
| `GAME_ENDED` | 对局已结束 | 读 gameover.json 收尾 |

**通用恢复姿势**：任何被拒动作都不破坏局面——提交动作后等 seq 变化看 `lastSettled`：`accepted=false` 就按 hint 改完直接重写 action.json（stdio：直接重发一行）；`lastSettled` 未指向你的动作就继续等（CLI 绝不静默丢动作，也无需重启 CLI）。

## 9. 基础策略提示（够打赢 easy/normal）

1. **先读 `legalActions` 的 `summary`**——它已把"能干什么、代价多少、效果是什么"翻成人话，决策从合法集里选最稳。
2. **功耗曲线**：前几回合把手牌里低功耗单位铺上场（每回合 +100W，第 2 回合 200W、第 3 回合 300W……），别让功耗闲置；打不出去就当回合多上单位。
3. **场面交换优先**：用攻击换掉对面高威胁单位（攻击力高/带 taunt 的）；`state.board` 里每个单位的攻血都在。
4. **斩杀检查**：出手前算一下"我全部攻击+直伤能不能这回合打死对面"——对面血量 = `state.opponent.health`（护甲另扣）。能斩杀就全部资源打脸，别贪场面。
5. **留后手**：`END_TURN` 前确认没有更划算的出牌；但要防对面反打——血量健康时才激进。
6. **taunt 顶前面**：自己有残血单位时，`taunt` 单位能强制对面先打它，保护你的输出。
7. **overload 慎用**：跳闸牌先看效果值不值"下回合少 100W"。
8. 卡牌语义不确定时，看 `cardGlossary[cardId].effectText`——它是效果规则的中文一句话。

## 10. 一段话总结（TL;DR）

跑 `yarn workspace @siliconcard/cli play --mode file --seed 42`；循环读 `turn.json` → 从 `legalActions` 挑一条（照抄其 `action`）→ 写成 `action.json` 里的 `{"action": …}` → 等 seq 变化后看 `lastSettled`（被拒就看 `lastError.hint` 改了重发，接受就提交下一个）；直到出现 `gameover.json`。前期铺场、中期换场面、看准斩杀，别忘了每回合最多 7 单位、技能 200W 一次、入场当回合不能攻击。
