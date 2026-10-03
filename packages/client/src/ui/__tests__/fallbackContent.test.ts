import { beforeEach, describe, expect, it } from 'vitest'
import { DECK_SIZE, findCardDefinitionIssues, getCardDefinition, getFactionSkill, type CardDefinition } from '@siliconcard/core'
import { FACTION_DISPLAY, PLACEHOLDER_CARDS } from '../game/fallbackContent'
import { buildFallbackDeck, ensureContentRegistered, isCardRegistered, resolveDeckChoice } from '../game/deckLoader'

/** 强制 demo 池分支：注入空 content（隔离真实卡池落地进度对测试的影响） */
beforeEach(() => {
  ensureContentRegistered({ cards: {}, decks: {} })
})

describe('占位内容（content 缺失期间的最后兜底）', () => {
  it('全部占位卡通过引擎结构校验（initGame 的 DECK_INVALID 门槛）', () => {
    for (const def of PLACEHOLDER_CARDS) {
      expect(findCardDefinitionIssues(def), `卡牌 ${def.id}`).toBeNull()
    }
  })

  it('占位卡 id 全部带 demo- 前缀，与正式 content 卡牌 id 永不冲突', () => {
    expect(PLACEHOLDER_CARDS.length).toBeGreaterThan(0)
    for (const def of PLACEHOLDER_CARDS) {
      expect(def.id.startsWith('demo-'), def.id).toBe(true)
    }
  })

  it('展示表覆盖内置四系，且技能均已在 core 注册（initGame 开箱即用）', () => {
    expect(FACTION_DISPLAY.map((f) => f.id)).toEqual(['nvidia', 'amd', 'intel', 'neutral'])
    for (const faction of FACTION_DISPLAY) {
      const skill = getFactionSkill(faction.id)
      expect(skill, faction.id).toBeDefined()
      expect(skill?.cost).toBe(200)
    }
  })
})

describe('卡池注册与随机组卡（deckLoader）', () => {
  it('降级分支：注入空 content → demo 占位池注册（幂等）', () => {
    const first = ensureContentRegistered({ cards: {}, decks: {} })
    expect(first.source).toBe('fallback')
    expect(first.registeredCards).toBe(PLACEHOLDER_CARDS.length)
    expect(isCardRegistered('demo-rtx-5090')).toBe(true)
    const second = ensureContentRegistered({ cards: {}, decks: {} })
    expect(second.registeredCards).toBe(first.registeredCards)
  })

  it('content 分支：合法定义注册、非法定义跳过并记录', () => {
    const good = PLACEHOLDER_CARDS[0] as CardDefinition
    const bad = {
      id: 'bad-card',
      name: '坏卡',
      faction: 'nvidia',
      type: 'gpu',
      cost: 50, // gpu 缺 attack/health → findCardDefinitionIssues 应拒绝
    }
    const report = ensureContentRegistered({
      cards: {
        'good.json': good as unknown as Record<string, unknown>,
        'bad.json': bad as unknown as Record<string, unknown>,
      },
      decks: {},
    })
    expect(report.source).toBe('content')
    expect(report.invalidCards).toHaveLength(1)
    expect(report.invalidCards[0]?.cardId).toBe('bad-card')
    expect(isCardRegistered(good.id)).toBe(true)
    expect(isCardRegistered('bad-card')).toBe(false)
  })

  it('随机组卡：恰好 30 张、同种子逐字节相同、不同种子不同', () => {
    const a = buildFallbackDeck(1234, PLACEHOLDER_CARDS)
    const b = buildFallbackDeck(1234, PLACEHOLDER_CARDS)
    expect(a.cards.reduce((sum, c) => sum + c.count, 0)).toBe(DECK_SIZE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(buildFallbackDeck(2, PLACEHOLDER_CARDS))).not.toBe(JSON.stringify(a))
  })

  it('随机组卡带低费曲线：保底含 ≤100W 的卡（首回合 100W 必有牌可出）', () => {
    for (const seed of [1, 7, 42, 999]) {
      const deck = buildFallbackDeck(seed, PLACEHOLDER_CARDS)
      const cheapest = Math.min(
        ...deck.cards.map((c) => getCardDefinition(c.cardId)?.cost ?? Number.MAX_SAFE_INTEGER),
      )
      expect(cheapest, `seed=${seed}`).toBeLessThanOrEqual(100)
    }
  })

  it('resolveDeckChoice：随机项返回 30 张降级牌组', () => {
    const choice = resolveDeckChoice('__random__', 42)
    expect(choice.spec.cards.reduce((sum, c) => sum + c.count, 0)).toBe(DECK_SIZE)
    expect(choice.label).toContain('随机')
  })

  it('resolveDeckChoice：注入预组卡组后按 id 命中', () => {
    const report = ensureContentRegistered({
      cards: {},
      decks: {
        'nvidia-starter.json': {
          id: 'nvidia-starter',
          name: 'NVIDIA 开荒组',
          faction: 'nvidia',
          cards: [{ cardId: 'demo-rtx-5090', count: 2 }],
        } as unknown as Record<string, unknown>,
      },
    })
    const choice = resolveDeckChoice('nvidia-starter', 42, report)
    expect(choice.label).toBe('NVIDIA 开荒组')
    expect(choice.faction).toBe('nvidia')
    expect(choice.spec.cards).toEqual([{ cardId: 'demo-rtx-5090', count: 2 }])
  })
})
