/**
 * P2-UI4 图鉴定向测试（无头，纯逻辑；卡面绘制本体留给 WF-VISUAL 截图验收）：
 * 1. 筛选/排序全组合正确 + 新卡入池零登记自动进图鉴（mock 卡注册表验证）；
 * 2. 白话解释渲染器与 core matchStep 同语义（全卡池可解释 + special>ops + 负向对照 + 占位符替换）；
 * 3. 卡面缓存复用：同卡同键只绘一次，与对局内卡面同函数同参数（CardFace.cacheKey 等价断言）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { CardDefinition, EffectSpec } from '@siliconcard/core'
import { cardFaceCacheKey, TextureCache, type CardFaceParams } from '../../../three/CardFace'
import { loadCodexCards, makeCardNameResolver } from '../cardPool'
import {
  applyFilters,
  factionsInPool,
  matchesFilters,
  raritiesInPool,
  sortCards,
  DEFAULT_FILTERS,
  type CodexFilters,
} from '../filters'
import { explainEffectSpec, glossary, type EffectsGlossary } from '../glossaryRender'
import { ensureCodexFace, codexFaceParams } from '../face'

// —— mock 卡注册表（覆盖派系/稀有度/类型/费用各档） ——

function mockDef(partial: Partial<CardDefinition> & { id: string; name: string }): CardDefinition {
  return {
    faction: 'neutral',
    type: 'gpu',
    cost: 100,
    rarity: 'common',
    ...partial,
  }
}

const MOCK_POOL: CardDefinition[] = [
  mockDef({ id: 'mock-a', name: '甲卡', faction: 'nvidia', cost: 50, rarity: 'starter' }),
  mockDef({ id: 'mock-b', name: '乙卡', faction: 'nvidia', cost: 575, rarity: 'legendary' }),
  mockDef({ id: 'mock-c', name: '丙卡', faction: 'amd', cost: 200, type: 'driver', rarity: 'rare' }),
  mockDef({ id: 'mock-d', name: '丁卡', faction: 'amd', cost: 350, type: 'accessory', rarity: 'epic' }),
  mockDef({ id: 'mock-e', name: '戊卡', faction: 'intel', cost: 150, rarity: 'common' }),
  mockDef({ id: 'mock-f', name: '己卡', faction: 'intel', cost: 100 }), // 无 rarity → 按 common 处理
]

describe('P2-UI4 筛选与排序（纯函数 × mock 卡池）', () => {
  it('派系 ×7 / 稀有度 / 类型 / 费用区间逐维筛选正确', () => {
    expect(applyFilters(MOCK_POOL, { ...DEFAULT_FILTERS, faction: 'nvidia' }).map((c) => c.id)).toEqual(['mock-a', 'mock-b'])
    expect(applyFilters(MOCK_POOL, { ...DEFAULT_FILTERS, rarity: 'common' }).map((c) => c.id)).toEqual(['mock-e', 'mock-f'])
    expect(applyFilters(MOCK_POOL, { ...DEFAULT_FILTERS, type: 'driver' }).map((c) => c.id)).toEqual(['mock-c'])
    expect(applyFilters(MOCK_POOL, { ...DEFAULT_FILTERS, costBand: 'gt500' }).map((c) => c.id)).toEqual(['mock-b'])
    expect(applyFilters(MOCK_POOL, { ...DEFAULT_FILTERS, costBand: 'le100' }).map((c) => c.id)).toEqual(['mock-a', 'mock-f'])
  })

  it('筛选全组合（派系∧类型∧费用区间同时生效）', () => {
    const combo: CodexFilters = { faction: 'amd', rarity: 'all', type: 'accessory', costBand: '301-500' }
    expect(applyFilters(MOCK_POOL, combo).map((c) => c.id)).toEqual(['mock-d'])
    // 组合无命中 → 空结果而非报错
    expect(applyFilters(MOCK_POOL, { ...combo, type: 'gpu' })).toEqual([])
  })

  it('排序：费用升序（同费按名）/ 名称 / 稀有度降序（无稀有度按 common）', () => {
    expect(sortCards(MOCK_POOL, 'cost').map((c) => c.id)).toEqual(['mock-a', 'mock-f', 'mock-e', 'mock-c', 'mock-d', 'mock-b'])
    expect(sortCards(MOCK_POOL, 'rarity').map((c) => c.id)[0]).toBe('mock-b') // legendary 在前
    const names = sortCards(MOCK_POOL, 'name').map((c) => c.name)
    expect([...names].sort((a, b) => a.localeCompare(b, 'zh'))).toEqual(names)
  })

  it('派系/稀有度选项由卡池派生（数据驱动，新派系零改动）', () => {
    expect(factionsInPool(MOCK_POOL)).toEqual(['nvidia', 'amd', 'intel'])
    expect(raritiesInPool(MOCK_POOL)).toEqual(['starter', 'common', 'rare', 'epic', 'legendary'])
  })

  it('新卡入池零登记自动进图鉴：mock 新卡追加后筛选结果立即可见', () => {
    const newCard = mockDef({ id: 'mock-new', name: '新卡', faction: 'arm', cost: 400, rarity: 'epic', type: 'gpu' })
    const pool = [...MOCK_POOL, newCard]
    expect(matchesFilters(newCard, { faction: 'arm', rarity: 'epic', type: 'gpu', costBand: '301-500' })).toBe(true)
    expect(factionsInPool(pool)).toContain('arm')
    expect(sortCards(pool, 'rarity')[0]?.id).toBe('mock-b') // epic 仍排在 legendary 之后
  })
})

describe('P2-UI4 白话解释渲染器（与 core matchStep 同语义）', () => {
  const cards = loadCodexCards()

  it('content 卡池 ≥ 90 张（图鉴主体），全部带效果卡的 EffectSpec 均可解释（零漏网同口径）', () => {
    expect(cards.length).toBeGreaterThanOrEqual(90)
    const failures = cards
      .filter((def): def is CardDefinition & { effect: EffectSpec } => def.effect !== undefined)
      .map((def) => ({ id: def.id, problems: explainEffectSpec(def.effect, (id) => id).problems }))
      .filter((entry) => entry.problems.length > 0)
      .map((entry) => `${entry.id}: ${entry.problems.join('；')}`)
    expect(failures).toEqual([])
  })

  it('special > ops：revive 走 special 短语并替换 {count}，删掉 ops.revive 仍可解释', () => {
    const spec = {
      trigger: 'battlecry',
      steps: [{ op: 'revive', pick: 'lastOwnedGpu', to: 'sourceOwnerBoard', count: 2 }],
    } as const
    const result = explainEffectSpec(spec, (id) => id)
    expect(result.ok).toBe(true)
    expect(result.sentences[0]).toContain('2') // {count} = 2 张
    // 克隆词条删除属测试注入，非合法 glossary 形态，断言用 unknown 双重转接（与 core 测试同法）
    const withoutReviveOp = { ...glossary, ops: { ...glossary.ops, revive: undefined } } as unknown as EffectsGlossary
    expect(explainEffectSpec(spec, (id) => id, withoutReviveOp).ok).toBe(true)
  })

  it('负向对照：删词条后必须显式报缺（证明匹配非空洞）', () => {
    const spec = {
      trigger: 'battlecry',
      steps: [{ op: 'buff', target: { kind: 'chosen', pool: 'ownUnits' }, attack: 1 }],
    } as const
    expect(explainEffectSpec(spec, (id) => id).ok).toBe(true)
    const withoutOp = { ...glossary, ops: { ...glossary.ops, buff: undefined } } as unknown as EffectsGlossary
    expect(explainEffectSpec(spec, (id) => id, withoutOp).problems.length).toBeGreaterThan(0)
    const withoutSelector = {
      ...glossary,
      selectors: Object.fromEntries(Object.entries(glossary.selectors).filter(([key]) => key !== 'chosen|ownUnits')),
    } as unknown as EffectsGlossary
    expect(explainEffectSpec(spec, (id) => id, withoutSelector).problems.length).toBeGreaterThan(0)
  })

  it('占位符替换：数值进句、{cardId} 由注册表解析为卡名、buff 未写维度渲染「不变」、光环 {delta} 带符号', () => {
    const damage = explainEffectSpec(
      { trigger: 'battlecry', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 3 }] },
      (id) => id,
    )
    expect(damage.sentences[0]).toContain('3点伤害')

    const summon = explainEffectSpec(
      { trigger: 'onPlay', steps: [{ op: 'summon', cardId: 'rtx-5090', count: 2 }] },
      (id) => (id === 'rtx-5090' ? 'RTX 5090' : id),
    )
    expect(summon.sentences[0]).toContain('RTX 5090')

    const buff = explainEffectSpec(
      { trigger: 'battlecry', steps: [{ op: 'buff', target: { kind: 'chosen', pool: 'ownUnits' }, attack: 1 }] },
      (id) => id,
    )
    expect(buff.sentences[0]).toContain('+1')
    expect(buff.sentences[0]).toContain('不变')

    const aura = explainEffectSpec({ trigger: 'aura', aura: { stat: 'attack', delta: -1, scope: 'allUnits' } })
    expect(aura.sentences[0]).toContain('-1')
    expect(aura.triggerLabel).toBe(glossary.triggers.aura)
  })

  it('触发前缀词条在句集之外单独暴露（UI 按「触发时点：句子」拼装）', () => {
    const result = explainEffectSpec(
      { trigger: 'deathrattle', steps: [{ op: 'gainArmor', player: 'sourceOwner', amount: 5 }] },
      (id) => id,
    )
    expect(result.triggerLabel).toBe(glossary.triggers.deathrattle)
    expect(result.sentences).toHaveLength(1)
  })

  it('makeCardNameResolver：注册表优先，卡池兜底，未知名原样返回 cardId', () => {
    const pool = [mockDef({ id: 'mock-only-pool', name: '只进图鉴的卡' })]
    const resolve = makeCardNameResolver(pool)
    expect(resolve('mock-only-pool')).toBe('只进图鉴的卡')
    expect(resolve('unknown-id')).toBe('unknown-id')
  })
})

describe('P2-UI4 卡面同源渲染与缓存复用', () => {
  const def: CardDefinition = mockDef({
    id: 'mock-face',
    name: '缓存测试卡',
    attack: 3,
    health: 4,
    rarity: 'rare',
    keywords: ['taunt'],
  })

  it('图鉴参数与对局内满血新手牌完全同参（cacheKey 等价断言，同一渲染函数的前提）', () => {
    const codex = cardFaceCacheKey(codexFaceParams(def))
    const battle: CardFaceParams = { def, cost: def.cost, attack: def.attack, health: def.health }
    expect(codex).toBe(cardFaceCacheKey(battle))
    expect(codex).toBe(cardFaceCacheKey({ def }))
  })

  it('TextureCache 复用：同卡两次取面只绘制一次，不同卡各绘一次', () => {
    const cache = new TextureCache()
    const draw = vi.fn(() => ({}) as unknown as HTMLCanvasElement)
    const first = ensureCodexFace(cache, def, draw)
    const second = ensureCodexFace(cache, def, draw)
    expect(first.drawn).toBe(true)
    expect(second.drawn).toBe(false)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(second.texture).toBe(first.texture)
    expect(cache.size).toBe(1)

    const other = mockDef({ id: 'mock-face-2', name: '另一张卡' })
    const third = ensureCodexFace(cache, other, draw)
    expect(third.drawn).toBe(true)
    expect(third.texture).not.toBe(first.texture)
    expect(cache.size).toBe(2)
    cache.dispose()
    expect(cache.size).toBe(0)
  })
})
