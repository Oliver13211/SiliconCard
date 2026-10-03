/**
 * 集成接线测试（集成检查员）：content 卡池注册 + 预组卡组接入 + 选卡组界面接线。
 * 防回归点：卡池 JSON 增删 / decks/ 结构变化 / glob 断链时在此第一时间失败。
 */

import { describe, expect, it } from 'vitest'
import { DECK_SIZE, getCardDefinition } from '@siliconcard/core'
import { RANDOM_DECK_ID, deckOptions, ensureContentRegistered, resolveDeckChoice } from '../game/deckLoader'

const FACTIONS = ['nvidia', 'amd', 'intel', 'neutral'] as const

describe('集成接线：content 卡池与预组卡组（M1 四线整合）', () => {
  it('启动注册：四批正式卡池全部注册且零结构违例', () => {
    const report = ensureContentRegistered()
    expect(report.source).toBe('content')
    expect(report.registeredCards).toBe(60)
    expect(report.invalidCards).toEqual([])
  })

  it('预组卡组：每派系一套、展开恰为 30 张、每张卡已在注册表', () => {
    const report = ensureContentRegistered()
    expect(report.decksAvailable).toBe(true)
    for (const faction of FACTIONS) {
      const deck = report.contentDecks.find((d) => d.faction === faction)
      expect(deck, `缺 ${faction} 预组卡组`).toBeTruthy()
      const total = (deck?.cards ?? []).reduce((sum, c) => sum + c.count, 0)
      expect(total, `${deck?.id} 展开总数`).toBe(DECK_SIZE)
      for (const entry of deck?.cards ?? []) {
        expect(getCardDefinition(entry.cardId), `${entry.cardId} 未注册`).toBeTruthy()
      }
    }
  })

  it('选卡组界面：预组卡组进下拉且不标降级，随机项保留可选', () => {
    const options = deckOptions()
    const decks = options.filter((o) => o.id !== RANDOM_DECK_ID)
    expect(decks.length).toBeGreaterThanOrEqual(4)
    expect(decks.every((d) => !d.degraded)).toBe(true)
    const random = options.find((o) => o.id === RANDOM_DECK_ID)
    expect(random).toBeTruthy()
  })

  it('resolveDeckChoice：按 id 命中预组卡组；未命中回退随机组卡', () => {
    const report = ensureContentRegistered()
    const first = report.contentDecks[0]
    expect(first).toBeTruthy()
    const hit = resolveDeckChoice(first?.id, 42, report)
    expect(hit.label).toBe(first?.name)
    expect(hit.spec.cards.reduce((s, c) => s + c.count, 0)).toBe(DECK_SIZE)
    const miss = resolveDeckChoice('no-such-deck', 42, report)
    expect(miss.label).toContain('随机')
    expect(miss.spec.cards.reduce((s, c) => s + c.count, 0)).toBe(DECK_SIZE)
  })
})
