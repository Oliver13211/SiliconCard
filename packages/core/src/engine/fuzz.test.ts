/**
 * 模糊冒烟（M1-ENG2 起常驻）：测试侧以确定性伪随机挑选 getLegalActions 动作自对弈，
 * 守护引擎全局不变量——
 *   - getLegalActions 枚举的动作全部可被 applyAction 接受（无幽灵动作）；
 *   - 光环投影下单位属性恒非负（attack ≥ 0、health ≥ 0、maxHealth ≥ 1）；
 *   - 状态始终满足 canonicalJson 约束（纯 JSON、无 NaN/Infinity）；
 *   - 有限动作内必然终局（疲劳兜底）。
 * 覆盖 PLAY_CARD 全部已实装原语与 accessory 光环的长期叠加场景；ENG3+ 扩展动作类型后同步扩充。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { Action } from '../types/actions'
import type { DeckSpec } from '../types/state'
import { canonicalJson } from '../testing/hash'
import { createEngine } from './index'
import { registerCardDefinitions } from './registry'

const FUZZ_CARDS: CardDefinition[] = [
  { id: 'fz-bolt', name: '电击', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'random', pool: 'anyCharacter' }, amount: 2 }] } },
  { id: 'fz-buff', name: '增益', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'random', pool: 'ownUnits' }, attack: 1, health: 1 }] } },
  { id: 'fz-shrink', name: '减益', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'all', pool: 'allUnits' }, attack: -1, health: -1 }] } },
  { id: 'fz-draw', name: '抽牌', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'draw', player: 'sourceOwner', count: 2 }] } },
  { id: 'fz-summon', name: '召唤', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'summon', cardId: 'fz-token', count: 2 }] } },
  { id: 'fz-armor', name: '护甲', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'gainArmor', player: 'sourceOwner', amount: 2 }] } },
  { id: 'fz-heal', name: '治疗', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'heal', target: { kind: 'random', pool: 'anyCharacter' }, amount: 3 }] } },
  { id: 'fz-token', name: '衍生物', faction: 'neutral', type: 'gpu', cost: 0, attack: 1, health: 1 },
  { id: 'fz-gpu', name: '白板显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2 },
  { id: 'fz-big', name: '大显卡', faction: 'neutral', type: 'gpu', cost: 300, attack: 6, health: 6 },
  { id: 'fz-stealth', name: '潜行显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 1, keywords: ['stealth'] },
  { id: 'fz-shield', name: '质保显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2, keywords: ['divine_shield'] },
  { id: 'fz-aura', name: '攻击光环', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'attack', delta: 1, scope: 'ownUnits' } } },
  { id: 'fz-aura-cost', name: '费用光环', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'cost', delta: -30, scope: 'allUnits' } } },
]
registerCardDefinitions(FUZZ_CARDS)

function fuzzDeck(): DeckSpec {
  const nonToken = FUZZ_CARDS.filter((c) => c.id !== 'fz-token').map((c) => ({ cardId: c.id, count: 2 }))
  return { cards: [...nonToken, { cardId: 'fz-token', count: 4 }] }
}

const MAX_ACTIONS_PER_GAME = 160

describe('模糊冒烟：随机合法动作自对弈（M1-ENG2）', () => {
  it('30 局随机对局：无崩溃、无幽灵动作、光环属性非负、状态可序列化、必然终局', () => {
    const engine = createEngine()
    for (let seed = 1; seed <= 30; seed++) {
      let state = engine.initGame({
        seed: seed * 7919,
        players: [
          { id: 'P1', faction: 'nvidia', deck: fuzzDeck() },
          { id: 'P2', faction: 'amd', deck: fuzzDeck() },
        ],
      })
      let guard = 0
      while (state.phase === 'main' && guard++ < MAX_ACTIONS_PER_GAME) {
        const legal = engine.getLegalActions(state, state.activePlayer)
        expect(legal.length).toBeGreaterThan(0)
        // 测试侧固定种子挑选动作（分布确定，与引擎 RNG 链路互不干扰）
        const pick = legal[(seed * guard) % legal.length] as Action
        const result = engine.applyAction(state, pick)
        state = result.state
        expect(() => canonicalJson(state)).not.toThrow()
        for (const unit of state.board) {
          expect(unit.attack).toBeGreaterThanOrEqual(0)
          expect(unit.health).toBeGreaterThanOrEqual(0)
          expect(unit.maxHealth).toBeGreaterThanOrEqual(1)
        }
      }
      expect(state.phase).toBe('ended') // 疲劳兜底：有限动作内必分胜负
    }
  })
})
