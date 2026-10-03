/**
 * 黄金基线 fixtures（M1-ENG7，rules.md §12）—— 基线对局的卡池、对局配置与
 * **确定性探针**（同 M1-ENG1..6 黄金回放前例：动作序列由引擎 getLegalActions
 * 顺序确定性导出，同 seed 下探针结果恒定）。
 *
 * 基线文件：本目录下 `*.golden.json`（recording + 期望终局哈希 + 关键事件计数），
 * 进 git 锁定；golden.test.ts 逐一加载并 assertGoldenReplay，CI（yarn test）即门禁。
 *
 * 重生成方式（规则变更后的预期漂移归因，WF-ENGINE）：用本模块的 setup + probe
 * 重跑动作序列，比对旧基线事件流逐条归因后，一次性脚本写回 `*.golden.json`
 * （探针与卡池数据不变时输出逐字节稳定，哈希变化即规则语义变化）。
 *
 * 四局风格各异（结算路径 / 派系组合 / 结局类型全覆盖 §9）：
 *   1. combat.health-zero.nvidia-amd      —— 出牌+贪心攻击，战斗分胜负；
 *   2. fatigue.health-zero.intel-neutral  —— 纯 END_TURN，牌库枯竭疲劳分胜负；
 *   3. concede.amd-intel                  —— 技能互拼后 P2 认输（concede 结局）；
 *   4. draw.health-zero.neutral           —— 全场 30 点炸机，双方同时归零 → 平局。
 */

import type { CardDefinition } from '../types/cards'
import type { Action } from '../types/actions'
import type { GameSetup, GameState } from '../types/state'
import { DECK_SIZE } from '../constants'
import { serializeReplay } from '../testing/replaySerialize'
import { createEngine } from '../engine/index'
import { registerCardDefinitions } from '../engine/registry'
import type { AttackAction } from '../engine/combat'
import type { PlayCardAction } from '../engine/play'

export const GOLDEN_SEED = 20261001

// —— 卡池（gd- 前缀：golden deck；vitest 文件间注册表隔离，模块加载即注册）——

const COMBAT_CARDS: CardDefinition[] = [
  { id: 'gd-c-rusher', name: '基线冲锋卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 2 },
  { id: 'gd-c-taunt', name: '基线嘲讽塔', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 6, keywords: ['taunt'] },
  { id: 'gd-c-twin', name: '基线双芯', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2, keywords: ['windfury'] },
  { id: 'gd-c-overclock', name: '基线超频体', faction: 'neutral', type: 'gpu', cost: 200, attack: 4, health: 1, keywords: ['charge'] },
  { id: 'gd-c-warranty', name: '基线质保卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 3, keywords: ['divine_shield'] },
  { id: 'gd-c-ghost', name: '基线亮机卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2, keywords: ['stealth'] },
]

const FATIGUE_CARDS: CardDefinition[] = Array.from({ length: DECK_SIZE }, (_, i) => ({
  id: `gd-f-card-${i}`,
  name: `基线洗牌卡 ${i}`,
  faction: 'neutral',
  type: 'gpu',
  cost: 1,
  attack: 1,
  health: 1,
}))

const POWER_TOKEN: CardDefinition = {
  id: 'gd-p-token', name: '基线白板卡', faction: 'neutral', type: 'gpu', cost: 0, attack: 1, health: 1,
}

const DOOM_CARD: CardDefinition = {
  id: 'gd-doom', name: '全场炸机', faction: 'neutral', type: 'driver', cost: 100,
  effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'all', pool: 'anyCharacter' }, amount: 30 }] },
}

registerCardDefinitions([...COMBAT_CARDS, ...FATIGUE_CARDS, POWER_TOKEN, DOOM_CARD])

// —— 对局配置 ——

export function goldenCombatSetup(seed: number = GOLDEN_SEED): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: { cards: COMBAT_CARDS.map((c) => ({ cardId: c.id, count: 5 })) } },
      { id: 'P2', faction: 'amd', deck: { cards: COMBAT_CARDS.map((c) => ({ cardId: c.id, count: 5 })) } },
    ],
  }
}

export function goldenFatigueSetup(seed: number = GOLDEN_SEED): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'intel', deck: { cards: FATIGUE_CARDS.map((c) => ({ cardId: c.id, count: 1 })) } },
      { id: 'P2', faction: 'neutral', deck: { cards: FATIGUE_CARDS.map((c) => ({ cardId: c.id, count: 1 })) } },
    ],
  }
}

export function goldenConcedeSetup(seed: number = GOLDEN_SEED): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'amd', deck: { cards: [{ cardId: POWER_TOKEN.id, count: DECK_SIZE }] } },
      { id: 'P2', faction: 'intel', deck: { cards: [{ cardId: POWER_TOKEN.id, count: DECK_SIZE }] } },
    ],
  }
}

export function goldenDrawSetup(seed: number = GOLDEN_SEED): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'neutral', deck: { cards: [{ cardId: DOOM_CARD.id, count: DECK_SIZE }] } },
      { id: 'P2', faction: 'neutral', deck: { cards: [{ cardId: DOOM_CARD.id, count: DECK_SIZE }] } },
    ],
  }
}

// —— 确定性探针（同 ENG 前例：getLegalActions 顺序导出，同 seed 恒定） ——

/** combat 探针：每回合出 ≤2 张牌、贪心攻击 ≤6 次、END_TURN；对局结束即停 */
export function goldenCombatProbe(seed: number = GOLDEN_SEED, maxRounds = 60): Action[] {
  const engine = createEngine()
  let state: GameState = engine.initGame(goldenCombatSetup(seed))
  const actions: Action[] = []
  for (let round = 0; round < maxRounds; round++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    for (let plays = 0; plays < 2; plays++) {
      const next = engine.getLegalActions(state, active).find((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
    }
    for (let attacks = 0; attacks < 6; attacks++) {
      const next = engine.getLegalActions(state, active).find((a): a is AttackAction => a.type === 'ATTACK')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return actions
}

/** fatigue 探针：纯 END_TURN 直到疲劳终局（P2 先耗尽牌库、先疲劳，P1 获胜）。
 * 动作序列与 seed 无关（不消费引擎 RNG 的探针侧选择），故不携带 seed 形参。 */
export function goldenFatigueProbe(): Action[] {
  return Array.from({ length: 69 }, (_, i): Action => ({
    type: 'END_TURN',
    playerId: i % 2 === 0 ? 'P1' : 'P2',
  }))
}

/** concede 探针：8 回合出牌+技能互拼（不点 CPU），随后 P2 认输 */
export function goldenConcedeProbe(seed: number = GOLDEN_SEED, rounds = 8): Action[] {
  const engine = createEngine()
  let state: GameState = engine.initGame(goldenConcedeSetup(seed))
  const actions: Action[] = []
  for (let round = 0; round < rounds; round++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    for (let plays = 0; plays < 2; plays++) {
      const next = engine.getLegalActions(state, active).find((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
    }
    if (state.phase !== 'main') break
    const power = engine.getLegalActions(state, active).find((a): a is Action => a.type === 'USE_HERO_POWER')
    if (power) {
      actions.push(power)
      state = engine.applyAction(state, power).state
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  actions.push({ type: 'CONCEDE', playerId: 'P2' })
  return actions
}

/** draw 探针：固定单动作——打出全场 30 点炸机，双方同时归零（平局） */
export function goldenDrawProbe(): Action[] {
  return [{ type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' }]
}

/**
 * 基线 recording 段规范化：经 serializeReplay 校验+canonical 化后还原为对象嵌入
 * 基线 JSON——基线的 recording 即**序列化存档形态**（schemaVersion+seed+players+
 * actions），从基线文件整段拷出即合法回放存档（§12 录制格式与存档格式同源）。
 */
export function goldenArchive(setup: GameSetup, actions: readonly Action[]): unknown {
  return JSON.parse(serializeReplay({ seed: setup.seed, players: setup.players, actions }))
}
