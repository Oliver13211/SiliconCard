/**
 * P2-UI2-2 沙箱演示驱动定向测试 v3（无头，纯逻辑；画布表现留给 WF-VISUAL 截图验收）。
 * v3 定稿（补齐授权 + 顺序约束）：双方预铺 neutral-gt-1030；P2 预铺卡于全局 T4
 * 攻击 P1 英雄一次破潜行；enemyUnits/allUnits chosen 类目标卡延至 T5 后打出。
 * 1. 演示卡组构成（目标 ×2 + 预铺 ×2 + 中性卡填满 30；P2 = 预铺 ×2 + 中性卡）；
 * 2. 三条件种子扫描 + 事件流含目标卡 CARD_PLAYED + 打出前/后快照；
 * 3. P2 动作纪律：仅预铺一打 + 至多一次攻击（攻击者=预铺卡）+ 其余全 END_TURN；
 * 4. 延迟类卡：playTurn=T5、P1 英雄被预铺卡打 2 点、效果事件落到 P2 预铺单位上
 *    （潜行真实解除，不只 playable=true）；
 * 5. 缓存幂等 + 全序列纯脚本两次构建逐字段相等；
 * 6. 90/90 全量扫描严格清零（不可演示卡=0），90 卡事件流全部以 CARD_PLAYED 开头。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DECK_SIZE,
  registerCardDefinitions,
  type CardDefinition,
  type GameEvent,
} from '@siliconcard/core'
import { loadCodexCards } from '../../codex/cardPool'
import {
  DEMO_PRELAY_CARD_ID,
  buildDemoDeck,
  buildDemoTimeline,
  clearDemoCache,
  getDemoTimeline,
  type DemoTimeline,
} from '../demoDriver'

// —— 引擎注册表注入：正式 content 卡池 + 两张 mock（己方单位目标 / 敌方单位目标） ——
const CARDS = loadCodexCards()
registerCardDefinitions(CARDS)

function mockDriverDef(id: string, name: string, pool: 'ownUnits' | 'enemyUnits'): CardDefinition {
  return {
    id,
    name,
    faction: 'neutral',
    type: 'driver',
    cost: 100,
    rarity: 'common',
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'chosen', pool }, amount: 2 }],
    },
  }
}
const MOCK_OWNONLY = mockDriverDef('mock-preview-ownonly', '只能砸自家随从', 'ownUnits')
const MOCK_ENEMYONLY = mockDriverDef('mock-preview-enemyonly', '只能砸对面随从', 'enemyUnits')
registerCardDefinitions([MOCK_OWNONLY, MOCK_ENEMYONLY])

const NEUTRAL_FILLERS = CARDS.filter((def) => def.faction === 'neutral')
const GT_1030 = DEMO_PRELAY_CARD_ID // 目标卡即预铺卡的特例
const SSD_990 = 'neutral-990-pro' // cost 200 driver，无单位目标 → T3 打出
// 延迟类（enemyUnits/allUnits chosen）三张受影响卡 + 落点断言的事件形态 + 期望打出回合
//（门控 T5 起；mana = 自身回合 ×100：T5=300W、T7=400W，apple 350W 落 T7）
const DELAYED_CARDS: readonly { id: string; landing: 'MINION_DIED' | 'DAMAGE_DEALT'; playTurn: number }[] = [
  { id: 'apple-t2-security', landing: 'MINION_DIED', playTurn: 7 }, // destroy chosen enemyUnits
  { id: 'arm-immortalis-g925', landing: 'DAMAGE_DEALT', playTurn: 5 }, // damage chosen enemyUnits 2
  { id: 'intel-av1-encode', landing: 'DAMAGE_DEALT', playTurn: 5 }, // damage chosen enemyUnits 2
]

beforeEach(() => {
  clearDemoCache()
})

/** P2 预铺单位实例 id（打出的前快照里唯一的 P2 方 GT 1030） */
function enemyPrelayIdOf(timeline: DemoTimeline): string | null {
  const unit = timeline.before?.board.find((u) => u.cardId === GT_1030 && u.ownerId === 'P2')
  return unit?.instanceId ?? null
}

function eventTypes(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('P2-UI2-2 v3 演示卡组构建', () => {
  it('目标 ×2 + 预铺 ×2 + 中性卡填满 DECK_SIZE，DeckSpec 形状合法', () => {
    const deck = buildDemoDeck(SSD_990, NEUTRAL_FILLERS)
    const total = deck.cards.reduce((sum, entry) => sum + entry.count, 0)
    expect(total).toBe(DECK_SIZE)
    expect(deck.cards.find((entry) => entry.cardId === SSD_990)?.count).toBe(2)
    expect(deck.cards.find((entry) => entry.cardId === GT_1030)?.count).toBe(2)
    for (const entry of deck.cards) {
      expect(Number.isInteger(entry.count)).toBe(true)
      expect(entry.count).toBeGreaterThan(0)
      expect(NEUTRAL_FILLERS.some((def) => def.id === entry.cardId)).toBe(true)
    }
  })

  it('目标卡即预铺卡（gt-1030）：该 id 聚合为 4 张', () => {
    const deck = buildDemoDeck(GT_1030, NEUTRAL_FILLERS)
    expect(deck.cards.find((entry) => entry.cardId === GT_1030)?.count).toBe(4)
    const total = deck.cards.reduce((sum, entry) => sum + entry.count, 0)
    expect(total).toBe(DECK_SIZE)
  })

  it('同参数重复构建结果一致（确定性）', () => {
    expect(buildDemoDeck(SSD_990, NEUTRAL_FILLERS)).toEqual(buildDemoDeck(SSD_990, NEUTRAL_FILLERS))
  })
})

describe('P2-UI2-2 v3 种子扫描与脚本推进', () => {
  it('目标即预铺卡（gt-1030）：第 1 回合打出，无演出段，事件流 = CARD_PLAYED + MINION_SUMMONED', () => {
    const timeline = buildDemoTimeline(GT_1030)
    expect(timeline.playable).toBe(true)
    expect(timeline.seed).toBeGreaterThanOrEqual(1)
    expect(timeline.playTurn).toBe(1)
    expect(eventTypes(timeline.playEvents)).toEqual(['CARD_PLAYED', 'MINION_SUMMONED'])
    expect(timeline.preludeEvents).toHaveLength(0) // 循环在 P1 T1 收流，预铺段未及发生
    expect(timeline.openingSnapshot?.p1.health).toBe(30)
    expect(timeline.after?.board.some((u) => u.cardId === GT_1030 && u.ownerId === 'P1')).toBe(true)
    expect(timeline.after?.p1.mana).toBe(0) // 100W 恰好够打一张
  })

  it('无单位目标类（cost 200）：维持 T3 打出（预铺扣光 T1 供电后第 2 个自身回合）', () => {
    const timeline = buildDemoTimeline(SSD_990)
    expect(timeline.playable).toBe(true)
    expect(timeline.playTurn).toBe(3)
    expect(timeline.before?.p1.mana).toBe(200)
    // 打出前：双方各有一张预铺 GT 1030（预铺脚本生效的证明）
    expect(timeline.before?.board.filter((u) => u.cardId === GT_1030 && u.ownerId === 'P1').length).toBe(1)
    expect(timeline.before?.board.filter((u) => u.cardId === GT_1030 && u.ownerId === 'P2').length).toBe(1)
    // 演出段：双方预铺落场，无攻击（非延迟类在 T4 前已收流）
    expect(eventTypes(timeline.preludeEvents)).toEqual([
      'CARD_PLAYED',
      'MINION_SUMMONED',
      'TURN_START',
      'CARD_PLAYED',
      'MINION_SUMMONED',
      'TURN_START',
    ])
    expect(timeline.preludeEvents.some((event) => event.type === 'ATTACK_DECLARED')).toBe(false)
    expect(eventTypes(timeline.playEvents)[0]).toBe('CARD_PLAYED')
  })

  it('延迟类三卡逐一：playTurn=T5、P1 英雄被预铺卡打 2 点、效果落点事件命中 P2 预铺单位', () => {
    for (const { id, landing, playTurn } of DELAYED_CARDS) {
      const timeline = buildDemoTimeline(id)
      expect(timeline.playable, id).toBe(true)
      // 顺序约束：潜行解除在全局 T4，打出延至 T5 起（再按供电曲线取首个满足回合）
      expect(timeline.playTurn, id).toBe(playTurn)
      // 攻击真实结算：P1 英雄 30 → 28（GT 1030 攻击力 2）
      expect(timeline.before?.p1.health, id).toBe(28)
      // 演出段含攻击动作的对应事件（画布攻击演出）
      expect(timeline.preludeEvents.some((event) => event.type === 'ATTACK_DECLARED'), id).toBe(true)
      expect(
        timeline.preludeEvents.some(
          (event) => event.type === 'DAMAGE_DEALT' && event.target.kind === 'hero' && event.target.playerId === 'P1',
        ),
        id,
      ).toBe(true)
      // 潜行真实解除：效果落点事件命中 P2 预铺单位（不只 playable=true）
      const enemyId = enemyPrelayIdOf(timeline)
      expect(enemyId, id).toBeTruthy()
      const landed = timeline.playEvents.filter((event) => {
        if (event.type === 'DAMAGE_DEALT') return event.target.kind === 'unit' && event.target.instanceId === enemyId
        if (event.type === 'MINION_DIED') return event.unit.instanceId === enemyId
        return false
      })
      expect(landed.length, `${id} 落点事件`).toBeGreaterThan(0)
      expect(landed.some((event) => event.type === landing), `${id} 落点事件形态`).toBe(true)
    }
  })

  it('延迟类确定性：两次独立构建逐字段相等', () => {
    const a = buildDemoTimeline('intel-av1-encode')
    const b = buildDemoTimeline('intel-av1-encode')
    expect(a).toEqual(b)
  })

  it('ownUnits 类 chosen 卡：维持 T3 打出，伤害落在 P1 预铺单位', () => {
    const timeline = buildDemoTimeline(MOCK_OWNONLY.id)
    expect(timeline.playable).toBe(true)
    expect(timeline.playTurn).toBe(3)
    expect(eventTypes(timeline.playEvents)[0]).toBe('CARD_PLAYED')
    const damage = timeline.playEvents.find((event) => event.type === 'DAMAGE_DEALT')
    expect(damage && damage.type === 'DAMAGE_DEALT' ? damage.target.kind : null).toBe('unit')
  })

  it('P2 动作纪律：至多预铺一打 + 至多一次攻击（攻击者=预铺卡），其余全 END_TURN', () => {
    // 非延迟类（T3 收流，攻击未来及发生）
    const plain = buildDemoTimeline(SSD_990)
    for (const timeline of [plain, buildDemoTimeline('intel-av1-encode')] as const) {
      const p2Actions = timeline.scriptActions.filter((action) => action.playerId === 'P2')
      expect(p2Actions.length, 'P2 有动作').toBeGreaterThan(0)
      const p2Plays = p2Actions.filter((action) => action.type === 'PLAY_CARD')
      expect(p2Plays.length, 'P2 出牌仅预铺').toBeLessThanOrEqual(1)
      const p2Attacks = p2Actions.filter((action) => action.type === 'ATTACK')
      expect(p2Attacks.length, 'P2 攻击至多一次').toBeLessThanOrEqual(1)
      if (p2Attacks.length === 1) {
        const attack = p2Attacks[0]
        expect(attack?.type).toBe('ATTACK')
        if (attack?.type === 'ATTACK') {
          expect(attack.attackerId).toBe(enemyPrelayIdOf(timeline))
          expect(attack.target).toEqual({ kind: 'hero', playerId: 'P1' })
        }
      }
      expect(
        p2Actions.filter((action) => action.type !== 'END_TURN' && action.type !== 'PLAY_CARD' && action.type !== 'ATTACK'),
        'P2 其余动作全部 END_TURN',
      ).toHaveLength(0)
    }
    // 延迟类恰好一次攻击；非延迟类零攻击（T4 前已收流）
    expect(
      buildDemoTimeline('intel-av1-encode').scriptActions.filter((action) => action.playerId === 'P2' && action.type === 'ATTACK').length,
    ).toBe(1)
    expect(plain.scriptActions.some((action) => action.type === 'ATTACK')).toBe(false)
  })

  it('全序列纯脚本（无 AI）：scriptActions 仅含 PLAY_CARD / END_TURN / ATTACK 三种', () => {
    const timeline = buildDemoTimeline('intel-av1-encode')
    expect(timeline.scriptActions.every((action) => ['PLAY_CARD', 'END_TURN', 'ATTACK'].includes(action.type))).toBe(true)
  })

  it('开局事件合成（§2.1 裁决）：GAME_START + 首个 TURN_START', () => {
    const timeline = buildDemoTimeline(SSD_990)
    expect(timeline.openingEvents[0]?.type).toBe('GAME_START')
    expect(timeline.openingEvents[1]?.type).toBe('TURN_START')
  })
})

describe('P2-UI2-2 v3 缓存幂等', () => {
  it('同 cardId 幂等命中同一对象；clearDemoCache 后重建（内容相等、引用更新）', () => {
    const first = getDemoTimeline(GT_1030)
    const second = getDemoTimeline(GT_1030)
    expect(second).toBe(first)
    clearDemoCache()
    const rebuilt = getDemoTimeline(GT_1030)
    expect(rebuilt).not.toBe(first)
    expect(rebuilt).toEqual(first)
  })

  it('填充池缺预铺卡：明确降级不静默', () => {
    const noPrelay = NEUTRAL_FILLERS.filter((def) => def.id !== GT_1030)
    const timeline = buildDemoTimeline('intel-av1-encode', { fillers: noPrelay })
    expect(timeline.playable).toBe(false)
    expect(timeline.reason).toContain('预铺卡')
  })
})

describe('P2-UI2-2 v3 全卡池扫描（90/90 验收）', () => {
  it('content 全部卡可自动演示（降级清零）；事件流全部以目标卡 CARD_PLAYED 开头', () => {
    const undrivable: string[] = []
    for (const def of CARDS) {
      const timeline = getDemoTimeline(def.id)
      if (timeline.playable) {
        expect(timeline.playEvents.length, def.id).toBeGreaterThan(0)
        expect(eventTypes(timeline.playEvents)[0], def.id).toBe('CARD_PLAYED')
        expect(timeline.playEvents[0]?.type === 'CARD_PLAYED' ? timeline.playEvents[0].cardId : null, def.id).toBe(def.id)
      } else {
        undrivable.push(def.id)
      }
    }
    expect(undrivable, `降级清单应清零，实际：${undrivable.join(',')}`).toEqual([])
  })
})
