/**
 * 场上单位原语 —— 召唤 / 离场 / 伤害 / 治疗 / 增益（M1-ENG2）。
 *
 * 本模块函数就地修改传入的 state（applyAction 已负责深拷贝隔离），并按因果顺序
 * 向 events 追加事件。凡是改变场上单位集合的操作（召唤 / 阵亡移除）一律经
 * withBoardAuras 包裹，保证光环贡献不漂移（见 aura.ts 的纪律说明）。
 *
 * 阵亡流程（§6 / §5）：快照单位（光环剥离前）→ MINION_DIED（移出场外前）→
 * 移出场并重算光环 → 进墓地。deathrattle 结算点见 removeUnitFromBoard 的 TODO。
 */

import { BOARD_LIMIT } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { DamageSource, GameEvent } from '../types/events'
import type { BoardUnit, GameState, PlayerId, TargetRef } from '../types/state'
import { withBoardAuras } from './aura'

export function findUnit(state: GameState, instanceId: string): BoardUnit | undefined {
  return state.board.find((u) => u.instanceId === instanceId)
}

export function countOwnUnits(state: GameState, playerId: PlayerId): number {
  return state.board.filter((u) => u.ownerId === playerId).length
}

/** 从卡牌定义构建场上实例（instanceId 取自全局计数；配件按 0/1 入场，见汇报边界取舍） */
export function createBoardUnit(state: GameState, def: CardDefinition, ownerId: PlayerId): BoardUnit {
  const instanceId = `u${state.nextInstanceId}`
  state.nextInstanceId += 1
  const health = def.health ?? 1
  return {
    instanceId,
    cardId: def.id,
    ownerId,
    attack: def.attack ?? 0,
    health,
    maxHealth: health,
    keywords: [...(def.keywords ?? [])],
    summonedOnTurn: state.turn,
    // 召唤失调：入场当回合不可攻击；charge 的攻击侧豁免在攻击结算判定（M1-ENG3）
    attacksRemaining: 0,
    attackedThisTurn: false,
  }
}

/**
 * 召唤单位到拥有者场上末尾（board = 入场顺序）。己方场上已满（BOARD_LIMIT）时
 * 返回 null 且不产生任何效果（效果召唤静默截断；出牌路径在合法性闸门已拦截）。
 * 事件在光环投影完成后发出，unit 载荷为投影后的最终值。
 */
export function summonUnit(
  state: GameState,
  ownerId: PlayerId,
  def: CardDefinition,
  events: GameEvent[],
  source: 'play' | 'effect',
): BoardUnit | null {
  if (countOwnUnits(state, ownerId) >= BOARD_LIMIT) return null
  const unit = createBoardUnit(state, def, ownerId)
  withBoardAuras(state, () => {
    state.board = [...state.board, unit]
  })
  events.push({ type: 'MINION_SUMMONED', unit: { ...unit }, source })
  return unit
}

/**
 * 单位离场：MINION_DIED（移出场外前，载荷为阵亡时快照）→ 移出并重算光环 → 进墓地。
 * 阵亡快照在光环剥离前取得，保留阵亡时刻的可见数值。
 */
export function removeUnitFromBoard(
  state: GameState,
  unit: BoardUnit,
  cause: 'damage' | 'destroy' | 'sacrifice',
  events: GameEvent[],
): void {
  const snapshot: BoardUnit = { ...unit, keywords: [...unit.keywords] }
  withBoardAuras(state, () => {
    events.push({ type: 'MINION_DIED', unit: snapshot, cause })
    state.board = state.board.filter((u) => u.instanceId !== unit.instanceId)
  })
  // TODO(M1-ENG4/M1-ENG6): deathrattle 在此结算（§5：死亡后、进入墓地前，一次死亡只触发
  // 一次，被 destroy 同样触发）——需要效果上下文（actorId = unit.ownerId），届时由调用方传入。
  const owner = state.players[unit.ownerId]
  owner.graveyard = [...owner.graveyard, { instanceId: unit.instanceId, cardId: unit.cardId }]
}

/**
 * 对场上单位结算伤害（§7 三年质保）：圣盾抵消任意金额的下一次伤害并消失，
 * 发出 DAMAGE_DEALT{shieldConsumed:true} + KEYWORD_TRIGGERED；血量下限截断为 0，
 * 血量归零即阵亡移场。注意：本函数不判定胜负，由动作层收尾统一 checkGameEnd。
 */
export function damageUnit(
  state: GameState,
  unit: BoardUnit,
  amount: number,
  source: DamageSource,
  events: GameEvent[],
): void {
  if (amount <= 0) return
  const target: TargetRef = { kind: 'unit', instanceId: unit.instanceId }
  if (unit.keywords.includes('divine_shield')) {
    unit.keywords = unit.keywords.filter((k) => k !== 'divine_shield')
    events.push({
      type: 'DAMAGE_DEALT',
      source,
      target,
      amount,
      remainingHealth: unit.health,
      shieldConsumed: true,
    })
    events.push({
      type: 'KEYWORD_TRIGGERED',
      keyword: 'divine_shield',
      instanceId: unit.instanceId,
      detail: '三年质保已消耗，本次伤害被完全抵挡',
    })
    return
  }
  unit.health = Math.max(0, unit.health - amount)
  events.push({ type: 'DAMAGE_DEALT', source, target, amount, remainingHealth: unit.health })
  if (unit.health <= 0) removeUnitFromBoard(state, unit, 'damage', events)
}

/** 治疗场上单位：上限 maxHealth（含光环贡献）；无实际回复时不发事件。 */
export function healUnit(unit: BoardUnit, amount: number, events: GameEvent[]): boolean {
  if (amount <= 0) return false
  const before = unit.health
  unit.health = Math.min(unit.maxHealth, unit.health + amount)
  if (unit.health === before) return false
  events.push({
    type: 'HEALING',
    target: { kind: 'unit', instanceId: unit.instanceId },
    amount,
    resultingHealth: unit.health,
  })
  return true
}

/** 治疗 CPU：上限 maxHealth；护甲不参与治疗；无实际回复时不发事件。 */
export function healHero(state: GameState, playerId: PlayerId, amount: number, events: GameEvent[]): boolean {
  if (amount <= 0) return false
  const player = state.players[playerId]
  const before = player.health
  player.health = Math.min(player.maxHealth, player.health + amount)
  if (player.health === before) return false
  events.push({
    type: 'HEALING',
    target: { kind: 'hero', playerId },
    amount,
    resultingHealth: player.health,
  })
  return true
}

/**
 * 永久增益（可负，如「矿难」-2/-2）：attack 下限 0；health/maxHealth 同步增减，
 * maxHealth 下限 1；血量 ≤ 0 即阵亡（按伤害死亡处理）。
 * buff 无对应事件（§6 目录未收录，改动经状态可见；如需动画由 WF-ENGINE 提案）。
 */
export function buffUnit(
  state: GameState,
  unit: BoardUnit,
  attackDelta: number,
  healthDelta: number,
  events: GameEvent[],
): void {
  if (attackDelta === 0 && healthDelta === 0) return
  if (attackDelta !== 0) unit.attack = Math.max(0, unit.attack + attackDelta)
  if (healthDelta === 0) return
  unit.maxHealth = Math.max(1, unit.maxHealth + healthDelta)
  unit.health += healthDelta
  if (unit.health <= 0) {
    unit.health = 0
    removeUnitFromBoard(state, unit, 'damage', events)
  }
}
