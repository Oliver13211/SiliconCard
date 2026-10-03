# 硅牌 SiliconCard · 规则书 v1.0（M0 定稿）

> 版本 v1.0 · 2026-10-01 · **本文件是跨包契约**
> 状态机、schema、事件目录、关键词、派系技能以本文为准；修改走 [WF-ENGINE](agents/workflows.md)（含下游通报 client-3d / client-ui / card-content / qa-balance）。
> 类型实现的唯一事实源：`packages/core/src/types/`，本文与类型一一对应。

---

## 1. 数值基线与常量

| 常量 | 值 | 含义 | core 导出 |
|---|---|---|---|
| `HERO_MAX_HEALTH` | 30 | CPU 体质上限 | ✓ |
| `MAX_MANA` | 1000 | 供电上限（W） | ✓ |
| `MANA_PER_TURN` | 100 | 每个自身回合的供电增长（W） | ✓ |
| `HAND_LIMIT` | 10 | 手牌上限，超出即烧牌 | ✓ |
| `BOARD_LIMIT` | 7 | 扩展槽（场上单位上限，双方各自计） | ✓ |
| `DECK_SIZE` | 30 | 标准卡组张数 | ✓ |
| `OPENING_HAND_SIZE` | 3 | 开局起手张数 | ✓ |
| `HERO_POWER_COST` | 200 | 派系技能功耗（W） | ✓ |
| `FIRST_PLAYER` | `'P1'` | 固定先手方 | ✓ |

## 2. 回合流程

1. **开局**（`initGame`）：校验双方卡组（总数 = `DECK_SIZE`，否则抛 `DECK_INVALID`）→ 各抽 `OPENING_HAND_SIZE` 张构成起手（P1 先抽，交替）→ `GAME_START` 事件 → 进入 P1 的第 1 回合；
2. **回合开始**（`TURN_START`）：`turn +1`；该玩家自身第 k 回合 → `maxMana = min(k × MANA_PER_TURN, MAX_MANA)`（即 +100W/回合，至 1000W）；结算跳闸：`mana = maxMana - lockedMana`，发出 `BURN_OUT`（若 `lockedMana > 0`），随后清零；`heroPowerUsed = false`；场上所有己方单位 `attacksRemaining` 重置（windfury = 2，其余 1）、`attackedThisTurn = false`；抽 1 张牌（先手 P1 的第 1 回合不抽，`drawCount: 0` 作为补偿规则）；上述序列完成后结算 `turnStart` 触发效果（M1-ENG6：全场双方单位按入场顺序，见 §5；触发致死于序列尾部再判胜负）；
3. **出牌阶段**：任意次 `PLAY_CARD` / `USE_HERO_POWER`（受功耗与合法性约束）；
4. **攻击**：己方单位可宣告攻击（入场当回合不可攻击，除非 charge）；
5. **回合结束**（`END_TURN`）：结算 `turnEnd` 触发效果（M1-ENG6：全场双方单位按入场顺序，见 §5；触发致死即在此收局，`GAME_END` 后不再烧牌/切换/进入对方回合）→ 手牌若 > `HAND_LIMIT`，从末尾烧牌（`CARD_BURNED`，烧掉的牌不进弃牌堆）→ 切换 `activePlayer`。

## 3. 动作与合法性（Action ⇄ RuleError）

| Action | 合法性条件 | 主要错误码 |
|---|---|---|
| `PLAY_CARD {uid, target?}` | 轮到你；手牌中有该 `uid`；`cost ≤ mana`；需要的 target 合法且可选（stealth 未现身的敌方单位、divine_shield 保护的…见 §7）；gpu 入场时己方场上 < `BOARD_LIMIT` | `NOT_YOUR_TURN` `CARD_NOT_IN_HAND` `INSUFFICIENT_MANA` `INVALID_TARGET` `BOARD_FULL` |
| `ATTACK {attackerId, target}` | 轮到你；attacker 在你场上且 `attacksRemaining > 0`；非入场当回合（charge 例外）；无 taunt 敌方在场时不可绕过 taunt；target 非潜行单位 | `NOT_YOUR_TURN` `UNIT_NOT_ON_BOARD` `UNIT_CANNOT_ATTACK` `TAUNT_BLOCKING` `INVALID_TARGET` |
| `USE_HERO_POWER {target?}` | 轮到你；`!heroPowerUsed`；`HERO_POWER_COST ≤ mana`；target 合法 | `NOT_YOUR_TURN` `INSUFFICIENT_MANA` `INVALID_TARGET` |
| `END_TURN` | 轮到你 | `NOT_YOUR_TURN` |
| `CONCEDE` | 对局未结束 | `GAME_ENDED` |

对局结束后一切动作抛 `GAME_ENDED`。未知动作结构抛 `UNKNOWN_ACTION`。

**目标合法性总则**：`chosen` 选择器的 pool 决定可选集合；敌方**无输出亮机**（未攻击过）的单位不可被指定；`INVALID_TARGET` 的 detail 中必须携带原因（供 UI 提示 / Agent 重试）。

## 4. 卡牌 Schema 定稿（CardDefinition）

字段定义见 `packages/core/src/types/cards.ts`，要点：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✓ | 全局唯一，kebab-case，如 `rtx-5090` |
| `name` / `flavor` | string | name✓ | 展示名 / 风味梗文案 |
| `faction` | string | ✓ | 数据驱动派系 id（§8） |
| `type` | `gpu \| driver \| accessory` | ✓ | 显卡（随从）/ 驱动事件（法术）/ 配件 |
| `cost` | number | ✓ | 功耗（W），0–1000。**建议对齐真实 TDP 设计**（如 RTX 5090 → 575、RTX 4090 → 450、无外接供电小卡 → ≤75），费用曲线天然携带梗味 |
| `attack` / `health` | number | gpu 必填 | 仅 gpu；其余类型出现即 schema 违例 |
| `keywords` | Keyword[] | | §7 的稳定 id |
| `effect` | EffectSpec | | §5 |
| `rarity` | `starter…legendary` | | |
| `art` | `{shape, palette, glow?}` | | 程序化卡面参数（client-3d 消费） |
| `tags` | string[] | | 子类标记，如 `'miner'`（矿卡，供「矿难」筛选） |

**派系技能不是卡牌**——由 `factions/*.json` 定义 `{ factionId, skillName, skillId, cost: 200, effect: EffectSpec }`，引擎按 USE_HERO_POWER 结算；定义由宿主经 core 注册 API 注入（core 不读 content 包），**initGame 校验双方 faction 均已注册技能**（未注册 → `DECK_INVALID{reason:'faction_skill_unregistered'}`）。

**accessory 在场形态（M1-ENG2 边界裁定，v1.0）**：打出后**进场上**成为 BoardUnit——占扩展槽并计入 `BOARD_LIMIT`、以 0/1 身板入场（定义无攻血字段）、不可攻击（attacksRemaining 恒 0）、可被效果指定、可死亡（光环随之回收）；driver 不占槽。

## 5. 效果系统

- **声明式优先**：`EffectSpec.steps` 按**数组顺序**逐步结算；每步产生对应事件（伤害→`DAMAGE_DEALT` 等）；
- **12 种原语**（`EffectStep`）：`damage / heal / buff / grantKeyword / removeKeyword / draw / summon / destroy / revive / gainArmor / lockMana / handler`；`TargetSelector` 支持 `chosen / random / all` × `TargetPool`，并可携带**可选 `tag` 子类过滤**（M1-ENG6 additive：非空字符串时仅命中卡牌定义 `tags` 含该标记的场上单位，如 `'miner'` 供「矿难」筛选；英雄无 tags，tag 过滤下天然排除；chosen 的 tag 合法性随出牌闸门校验）；`destroy` 不被三年质保抵挡、经既有死亡管线结算（§7）；`revive` 从 `sourceOwner` 墓地捞回显卡（`pick: lastOwnedGpu | random`，复活为新实例：新 instanceId、召唤失调重置、keywords/身板按定义恢复；复活即离墓；场满与池空同为静默 no-op 且不消耗 RNG）；
- **命名 handler 逃生舱**：steps 表达不了的逻辑（如「开光追试试」的 30% 失败判定）在 `core/src/effects/` 按 `name` 注册，经 `{ op: 'handler', name }` 引用——注册处必须配单测；**光追失败事件暂定形态（M1-ENG5，待契约评审）**：经 `KEYWORD_TRIGGERED` 发出，keyword 字段暂借 `'overload'`、`detail:'光追失败'`、`instanceId` 用 skillId；评审通过后改专属事件类型并通报 client-ui / client-3d；
- **随机语义**：一切 `random` 选择与概率判定走引擎种子 RNG（§11），**顺序固定**：按步骤数组顺序、目标池的 board 顺序进行；
- **触发时点**（`EffectTrigger`）：`battlecry`（入场/出牌）、`deathrattle`（死亡后，进入墓地前）、`onPlay`、`aura`（配合 `AuraSpec` 常驻修正，accessory 主用）、`turnStart / turnEnd / onAttack / onDamaged`；`turnStart / turnEnd` 的作用范围为**全场双方单位**（M1-ENG6 裁定：规则书未按拥有者限定；按入场顺序单层队列结算，以结算开始时的在场名单为准——中途离场不触发、中途召唤不入队）；
- **结算嵌套**：效果触发效果时深度优先、单层队列，v1 不做无限连锁保护以外的复杂栈（规则书刻意简化）；
- **光环与 buff 叠加（M1-ENG2 边界裁定，v1.0）**：单位有效属性 ≡ 基础值 + 永久 buff + 当前在场光环贡献，加法叠加、互不覆盖；光环是**派生量**（不进 GameState），单位集合每次变化后按入场顺序重算；手牌 cost 按卡牌定义绝对重算（下限 0，AuraSpec.scope 决定作用方）；随机选择与概率判定的结算顺序见上文随机语义。
- **亡语结算语义（M1-ENG4 边界裁定，v1.0）**：deathrattle 以**阵亡时快照**结算（光环剥离前取快照），连锁深度优先、深度上限 100（超出响亮抛错）；质保完全抵挡与直接阵亡均不构成「受伤」（不触发 onDamaged）；效果触发型效果无玩家指定（chosen 恒空）；效果规格（effect.trigger）是机制事实源，关键词仅为展示标记。

## 6. 事件目录定稿（17 种，渲染契约）

| 事件 | payload 要点 | 发出时机 | 主要消费 |
|---|---|---|---|
| `GAME_START` | seed, firstPlayer | initGame 完成 | 3D 开局演出 |
| `TURN_START` | turn, playerId, maxMana, drawCount | §2.2 | 功耗条刷新 |
| `TURN_END` | turn, playerId | §2.5 | 回合切换演出 |
| `CARD_DRAWN` | playerId, cardId\|null, source(`deck`/`fatigue`) | 每次抽牌 | 抽牌动画（source=fatigue 时播疲劳） |
| `CARD_PLAYED` | playerId, uid, cardId, cost, target | 扣费入结算前 | 出牌落场/法术特效 |
| `CARD_BURNED` | playerId, cardId, reason | 手牌超限烧牌 | 烧牌动画 |
| `MINION_SUMMONED` | unit, source(`play`/`effect`) | 单位入场 | 落场动画 |
| `MINION_DIED` | unit, cause | 移入场外前 | 死亡碎裂 → 亡语 |
| `ATTACK_DECLARED` | attackerId, target | 攻击判定前 | 冲撞动画 |
| `DAMAGE_DEALT` | source, target, amount, remainingHealth, armorAbsorbed?, shieldConsumed? | 每次伤害结算后 | 飘字/质保碎裂 |
| `HEALING` | target, amount, resultingHealth | 治疗后 | 绿色飘字 |
| `KEYWORD_TRIGGERED` | keyword, instanceId, detail | 关键词生效 | 关键词特效 |
| `HERO_POWER_USED` | playerId, skillId, target | 技能结算前 | 派系技能演出 |
| `FATIGUE` | playerId, fatigueCount, damage | 疲劳扣血后 | 疲劳演出 |
| `BURN_OUT` | playerId, lockedMana | 跳闸锁定结算时 | 闪屏+锁定提示 |
| `ARMOR_GAINED` | playerId, amount, totalArmor | 护甲增加后 | 护甲音效 |
| `GAME_END` | winner\|null, reason | 胜负判定 | 结算画面 |

**事件顺序规范**：单次 applyAction 的事件按因果顺序线性排列；事件只增不改；渲染层不得依赖未在目录内的事件。

## 7. 关键词精确定义（7 个，M1 全部实装）

| id | 显示名 | 精确规则 |
|---|---|---|
| `taunt` | 信仰充值 | 敌方 ATTACK 的 target 必须是 taunt 单位（若存在多个任选其一）；**taunt + stealth 冲突**：stealth 现身前 taunt 无效 |
| `divine_shield` | 三年质保 | 抵消下一次受到的任何伤害（金额不限），触发即消失并发出 `DAMAGE_DEALT{shieldConsumed:true}`；**重复获得不叠层（去重）**，耗尽后重新获得可再生效；不抵挡 destroy/移除类效果 |
| `charge` | 超频 | 入场当回合即可攻击（`summonedOnTurn` 失调豁免） |
| `windfury` | 双芯 GPU | 每回合 `attacksRemaining` 重置为 2；与 charge 叠加无冲突 |
| `deathrattle` | 蓝屏/传家宝 | 死亡时结算 `effect.trigger='deathrattle'`；一次死亡只触发一次；被 destroy 同样触发 |
| `stealth` | 无输出亮机 | 攻击前不可被敌方**指定**（攻击/target 选择均不可）；该单位攻击后立即现身；taunt 交互见上 |
| `overload` | 跳闸 | 携带该效果的牌打出后 `lockedMana += N`；**N 由该牌 onPlay/battlecry 触发的 lockMana 步骤给出，无有效步骤按 `DEFAULT_OVERLOAD_LOCK = 100` 兜底**（非出牌时点的 lockMana 不构成 N 来源）；可叠加（多张/多步累加），下回合 §2.2 生效后清零 |

## 8. 派系与技能 v1（M1 实装前四系）

| factionId | 技能 | skillId | EffectSpec 语义 |
|---|---|---|---|
| `nvidia` | DLSS | `dlss` | buff：chosen ownUnits，attack +1 |
| `amd` | 开光追试试 | `ray_tracing_try` | damage：chosen anyCharacter，amount 1，**命中判定**：handler 按 RNG < 0.7 成功，失败发 `KEYWORD_TRIGGERED{detail:'光追失败'}` 且无事发生 |
| `intel` | 驱动更新 | `driver_update` | draw：sourceOwner，count 1 |
| `neutral` | 清灰 | `dust_off` | damage：chosen anyCharacter，amount 1 |
| `apple` | 能效比 | `efficiency` | gainArmor：sourceOwner，2（M4） |
| `qualcomm` | TOPS 营销 | `tops_marketing` | buff：random ownUnits，+1/+1（M4） |
| `arm` | 公版方案 | `reference_design` | summon：1/1「亮机卡」token（M4） |

派系数据驱动扩展：新增派系只需新增 `factions/<id>.json` + 卡池，不改引擎。

## 9. 胜负、疲劳与平局

- 任一玩家 `health + armor 受击后 ≤ 0` → 对方胜（`GAME_END{reason:'health_zero'}`）；**同时归零 → winner: null（平局）**；
- `CONCEDE` → 对方胜（`reason:'concede'`）；
- **疲劳**：deck 为空时抽牌 → `fatigue +1`，受到等同 fatigue 点的疲劳伤害（1,2,3,…），发出 `CARD_DRAWN{source:'fatigue'}` + `FATIGUE`。

## 10. 视角裁剪（viewFor）

- 自己：完整 `hand`（uid/cardId/cost）+ 全部公开数值；
- 对手：仅 `PublicPlayerState`（**handSize/deckSize/graveyardSize 计数，不含内容**）；
- 双方：`board` 全量（场上单位本就公开）；
- **永不泄露**：对手手牌内容、牌库顺序、`rng.state`。

## 11. 确定性规范

- PRNG：mulberry32；`rng.state` 是 `GameState` 的一部分，随状态序列化；
- 同一 `seed + 动作序列` 重放，产出**逐字节一致**的状态（canonicalJson 意义下）与事件序列；
- 状态哈希：`canonicalJson(state)` → FNV-1a 32 位（`stableHash`），禁止引入浮点运算污染；
- 引擎状态中禁止 Map/Set/函数/NaN/Infinity（canonicalJson 遇到即抛错）。

## 12. 黄金回放

- 录制格式：`ReplayRecording { seed, players: [PlayerSetup, PlayerSetup], actions[] }`；
- 校验：`assertGoldenReplay(engine, recording, expectedHash)`——哈希不匹配即"黄金回放漂移"；
- **快照基线**：`packages/core/src/__golden__/`（M1-ENG7 落地，至少 3 局完整对局）；
- 规则变更后：漂移逐条归因为「预期变更（更新快照）/ 意外回归（修复）」，流程见 WF-ENGINE。

## 13. 版本化

- 本规则书 v1.0 对应 core 包 `0.0.x`；规则语义变更必须同时更新本文、类型与快照，并在 PR 描述中列出下游影响；
- `EventCatalog` / `CardDefinition` schema 的破坏性变更需要升 core minor 版本并通报全部下游预设。
