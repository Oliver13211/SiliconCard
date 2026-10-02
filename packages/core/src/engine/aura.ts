/**
 * 光环（AuraSpec）投影 —— 派生量重算（docs/rules.md §5 / M1-ENG2）。
 *
 * 契约约束：光环不得引入新 state 字段，全部折叠进现有字段。本模块维护的不变量：
 *   - BoardUnit.attack / health / maxHealth ≡ 基础值 + 永久 buff + 当前在场光环贡献；
 *   - HandCard.cost ≡ 卡牌定义 cost + 当前在场 cost 光环贡献（下限 0）。
 *
 * 「基础值 + 永久 buff」无独立存储，只能由原语就地增量维护，因此单位光环采用
 * 「先剥离、再投影」两段式重算（shiftUnitAuras ±）；手牌 cost 的基础值恒可从
 * 卡牌定义取得，采用绝对重算（applyHandCosts），手牌增删无需成对剥离。
 *
 * 纪律（后续 ENG 必须遵守，否则光环贡献会漂移）：
 *   - 任何改变场上单位集合（入场 / 离场）的修改必须经 withBoardAuras() 包裹；
 *   - 任何手牌集合变化（抽牌 / 出牌 / 烧牌）之后调用 applyHandCosts()；
 *   - withBoardAuras 禁止嵌套调用（无重入保护）；
 *   - 除本模块外，任何代码不得直接增减光环量。
 *
 * scope → 手牌的映射（规则书未定义，按最贴近语义实现）：stat === 'cost' 时
 * ownUnits 作用于源拥有者手牌、enemyUnits 作用于对手手牌、allUnits 作用于双方。
 */

import type { AuraSpec } from '../types/cards'
import type { BoardUnit, GameState, PlayerId } from '../types/state'
import { getCardDefinition } from './registry'

interface AuraSource {
  unit: BoardUnit
  aura: AuraSpec
}

/** 收集当前在场光环源（按 board 顺序 = 入场顺序，确定性遍历） */
function collectAuraSources(state: GameState): AuraSource[] {
  const sources: AuraSource[] = []
  for (const unit of state.board) {
    const aura = getCardDefinition(unit.cardId)?.effect?.aura
    if (aura) sources.push({ unit, aura })
  }
  return sources
}

function unitInScope(unit: BoardUnit, sourceOwner: PlayerId, scope: AuraSpec['scope']): boolean {
  switch (scope) {
    case 'ownUnits':
      return unit.ownerId === sourceOwner
    case 'enemyUnits':
      return unit.ownerId !== sourceOwner
    case 'allUnits':
      return true
  }
}

function handInScope(handOwner: PlayerId, sourceOwner: PlayerId, scope: AuraSpec['scope']): boolean {
  switch (scope) {
    case 'ownUnits':
      return handOwner === sourceOwner
    case 'enemyUnits':
      return handOwner !== sourceOwner
    case 'allUnits':
      return true
  }
}

/** 按 sign 剥离（-1）/ 投影（+1）全部单位光环贡献（cost 光环只作用于手牌，跳过） */
function shiftUnitAuras(state: GameState, sign: 1 | -1): void {
  for (const { unit: source, aura } of collectAuraSources(state)) {
    if (aura.stat === 'cost' || aura.delta === 0) continue
    for (const unit of state.board) {
      if (!unitInScope(unit, source.ownerId, aura.scope)) continue
      if (aura.stat === 'attack') {
        unit.attack += sign * aura.delta
      } else {
        unit.health += sign * aura.delta
        unit.maxHealth += sign * aura.delta
      }
    }
  }
}

/**
 * 手牌 cost 绝对重算：cost = 定义 cost + Σ cost 光环贡献（下限 0）。
 * 基础值来自注册表，与增量历史无关——手牌增删后调用即可，无需先剥离。
 */
export function applyHandCosts(state: GameState): void {
  const costAuras = collectAuraSources(state).filter((s) => s.aura.stat === 'cost')
  for (const playerId of ['P1', 'P2'] as const) {
    const player = state.players[playerId]
    player.hand = player.hand.map((card) => {
      let cost = getCardDefinition(card.cardId)?.cost ?? 0
      for (const { unit: source, aura } of costAuras) {
        if (handInScope(playerId, source.ownerId, aura.scope)) cost += aura.delta
      }
      cost = Math.max(0, cost)
      return cost === card.cost ? card : { ...card, cost }
    })
  }
}

/**
 * 包裹一次改变场上单位集合的修改：先剥离全部光环贡献（恢复基础值），
 * 执行 mutate（入场 / 离场 / 阵亡移除等），再按修改后的在场源重新投影。
 * 不改变单位集合的整批刷新可传空 mutate（剥离/投影互相抵消，手牌 cost 仍被校正）。
 * 禁止嵌套调用（无重入保护）。
 */
export function withBoardAuras(state: GameState, mutate: () => void): void {
  shiftUnitAuras(state, -1)
  mutate()
  shiftUnitAuras(state, 1)
  applyHandCosts(state)
}
