/**
 * 回合机 —— 回合开始/结束序列与状态转移原语（docs/rules.md §2.2 / §2.5 / §9）。
 *
 * 本模块函数就地修改传入的 state（applyAction 已负责深拷贝隔离，initGame 构建全新状态），
 * 并按因果顺序向 events 追加事件（§6：单次动作的事件线性排列，只增不改）。
 *
 * M1-ENG2：抽牌/烧牌后调用 applyHandCosts 重算手牌 cost（cost 光环投影，见 aura.ts）；
 * 回合开始重置攻击次数时，配件与 0 攻单位重置为 0（不可攻击，ENG3 侧同样会拒绝）。
 */

import { FIRST_PLAYER, HAND_LIMIT, MANA_PER_TURN, MAX_MANA } from '../constants'
import type { DamageSource, GameEvent } from '../types/events'
import type { GameState, PlayerId, PlayerState } from '../types/state'
import { applyHandCosts } from './aura'
import type { Rng } from './prng'
import { getCardDefinition } from './registry'
import { resolveTurnPhaseTriggers } from './triggers'

/** 全局回合号 → 该玩家自身第几回合（先手固定 P1：奇数全局回合属 P1，偶数属 P2） */
export function ownTurnNumber(turn: number, playerId: PlayerId): number {
  return playerId === 'P1' ? Math.ceil(turn / 2) : Math.floor(turn / 2)
}

export function opponentOf(playerId: PlayerId): PlayerId {
  return playerId === 'P1' ? 'P2' : 'P1'
}

/**
 * 回合开始序列（§2.2，按序）：
 * turn +1 → 供电曲线 maxMana = min(k×MANA_PER_TURN, MAX_MANA)，mana = maxMana - lockedMana
 * → 跳闸结算（lockedMana > 0 发 BURN_OUT 后清零）→ heroPowerUsed = false
 * → 己方单位 attacksRemaining 重置（windfury=2，其余 1）、attackedThisTurn = false
 * → 抽 1 张（先手 P1 的第 1 回合不抽，TURN_START.drawCount = 0）
 * → turnStart 触发效果（M1-ENG6：§2.2 序列之后，全场双方单位按 board 顺序结算，
 *   作用范围裁定见 triggers.ts resolveTurnPhaseTriggers 与 M1-ENG6 汇报）。
 */
export function beginTurn(state: GameState, playerId: PlayerId, events: GameEvent[], rng: Rng): void {
  state.turn += 1
  const player = state.players[playerId]
  const ownTurn = ownTurnNumber(state.turn, playerId)
  const locked = player.lockedMana

  player.maxMana = Math.min(ownTurn * MANA_PER_TURN, MAX_MANA)
  player.mana = Math.max(0, player.maxMana - locked)

  const skipsDraw = playerId === FIRST_PLAYER && ownTurn === 1
  const drawCount = skipsDraw ? 0 : 1
  events.push({ type: 'TURN_START', turn: state.turn, playerId, maxMana: player.maxMana, drawCount })

  if (locked > 0) {
    events.push({ type: 'BURN_OUT', playerId, lockedMana: locked })
    player.lockedMana = 0
  }

  player.heroPowerUsed = false
  for (const unit of state.board) {
    if (unit.ownerId !== playerId) continue
    const isAccessory = getCardDefinition(unit.cardId)?.type === 'accessory'
    unit.attacksRemaining = isAccessory || unit.attack <= 0 ? 0 : unit.keywords.includes('windfury') ? 2 : 1
    unit.attackedThisTurn = false
  }

  if (drawCount > 0) drawCard(state, playerId, events)
  // 抽牌/疲劳伤害结算完毕后再判定胜负：保证 GAME_END 是本段事件的收尾
  checkGameEnd(state, events)
  // turnStart 触发（§2.2 序列之后）：对局已结束（如疲劳致死）则不再触发；
  // 触发效果可能致死，收尾再判一次胜负（幂等，phase=ended 时直接返回）
  resolveTurnPhaseTriggers(state, 'turnStart', events, rng)
  checkGameEnd(state, events)
}

/**
 * 抽 1 张：牌库头部入手（uid 取自全局实例计数，跨手牌唯一）；
 * 牌库为空 → 疲劳（§9）：fatigue +1、受伤 = fatigue 点（护甲先于体质），
 * 事件序 CARD_DRAWN{source:'fatigue'} → DAMAGE_DEALT → FATIGUE（FATIGUE 语义为"扣血后"）。
 */
export function drawCard(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  const player = state.players[playerId]
  const entry = player.deck[0]
  if (!entry) {
    player.fatigue += 1
    const damage = player.fatigue
    events.push({ type: 'CARD_DRAWN', playerId, cardId: null, source: 'fatigue' })
    damageHero(state, playerId, damage, { kind: 'fatigue' }, events)
    events.push({ type: 'FATIGUE', playerId, fatigueCount: player.fatigue, damage })
    return
  }
  player.deck = player.deck.slice(1)
  const uid = `h${state.nextInstanceId}`
  state.nextInstanceId += 1
  // 未注册定义的卡按 cost 0 处理（initGame 已校验注册；此处兜底防御）
  const cost = getCardDefinition(entry.cardId)?.cost ?? 0
  player.hand = [...player.hand, { uid, cardId: entry.cardId, cost }]
  applyHandCosts(state) // cost 光环对新手牌同样生效（绝对重算，见 aura.ts）
  events.push({ type: 'CARD_DRAWN', playerId, cardId: entry.cardId, source: 'deck' })
}

/** 对 CPU 本体结算伤害：护甲先于体质（§9）；血量下限截断为 0。
 * 注意：本函数只结算伤害本身；胜负判定由调用方在完整结算序列结束后调
 * checkGameEnd（保证 GAME_END 收尾于事件流，M1-ENG6 效果系统沿用同一约定）。 */
export function damageHero(
  state: GameState,
  playerId: PlayerId,
  amount: number,
  source: DamageSource,
  events: GameEvent[],
): void {
  if (amount <= 0) return
  const player = state.players[playerId]
  const armorAbsorbed = Math.min(player.armor, amount)
  player.armor -= armorAbsorbed
  player.health = Math.max(0, player.health - (amount - armorAbsorbed))
  events.push({
    type: 'DAMAGE_DEALT',
    source,
    target: { kind: 'hero', playerId },
    amount,
    remainingHealth: player.health,
    ...(armorAbsorbed > 0 ? { armorAbsorbed } : {}),
  })
}

function isHeroDown(player: PlayerState): boolean {
  return player.health + player.armor <= 0
}

/** 胜负判定（§9）：任一方倒下即终局；同时归零 → winner null（平局） */
export function checkGameEnd(state: GameState, events: GameEvent[]): void {
  if (state.phase === 'ended') return
  const p1Down = isHeroDown(state.players.P1)
  const p2Down = isHeroDown(state.players.P2)
  if (!p1Down && !p2Down) return
  state.phase = 'ended'
  state.winner = p1Down && p2Down ? null : p1Down ? 'P2' : 'P1'
  state.endReason = 'health_zero'
  events.push({ type: 'GAME_END', winner: state.winner, reason: 'health_zero' })
}

/**
 * 回合结束的 turnEnd 触发效果结算（§2.5：TURN_END → turnEnd 效果 → 手牌烧牌，
 * M1-ENG6 接通）：全场双方单位按 board 顺序结算（范围与时序裁定见
 * triggers.ts resolveTurnPhaseTriggers 与 M1-ENG6 汇报）。胜负判定由动作层
 * （apply.ts END_TURN 分支）在本调用后收尾，保证 GAME_END 收尾于事件流。
 */
export function applyTurnEndEffects(
  state: GameState,
  playerId: PlayerId,
  events: GameEvent[],
  rng: Rng,
): void {
  void playerId // turnEnd 触发全场结算（范围裁定见 resolveTurnPhaseTriggers），非行动方单位同样触发
  resolveTurnPhaseTriggers(state, 'turnEnd', events, rng)
}

/** 手牌超限：从末尾烧牌（§2.5）。烧掉的牌不进弃牌堆（与弃牌不同） */
export function burnExcessHand(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  const player = state.players[playerId]
  let burned = false
  while (player.hand.length > HAND_LIMIT) {
    const last = player.hand.at(-1)
    if (!last) break
    player.hand = player.hand.slice(0, -1)
    burned = true
    events.push({ type: 'CARD_BURNED', playerId, cardId: last.cardId, reason: 'hand_full' })
  }
  if (burned) applyHandCosts(state) // cost 光环重算（剩余手牌的 cost 仍按定义绝对校正）
}
