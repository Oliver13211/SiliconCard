/**
 * 图鉴筛选与排序（P2-UI4）—— 纯函数，卡池以参数注入（mock 注册表可测）。
 *
 * 筛选维度：派系 ×7 / 稀有度 / 类型 gpu·driver·accessory / 费用区间。
 * 派系与稀有度选项均从卡池数据派生（数据驱动铁律：新派系 / 新稀有度零改动），
 * 类型是引擎契约三值并集（CardType），费用区间为固定分档（对齐真实 TDP 曲线）。
 */

import type { CardDefinition, CardType, FactionId, Rarity } from '@siliconcard/core'

export type CostBand = 'all' | 'le100' | '101-300' | '301-500' | 'gt500'

export interface CodexFilters {
  faction: 'all' | FactionId
  rarity: 'all' | Rarity
  type: 'all' | CardType
  costBand: CostBand
}

export type CodexSort = 'cost' | 'name' | 'rarity'

export const DEFAULT_FILTERS: CodexFilters = { faction: 'all', rarity: 'all', type: 'all', costBand: 'all' }

/** 费用分档（W）：全部 / ≤100 / 101–300 / 301–500 / >500（低费驱动到信仰旗舰全盖住） */
export const COST_BANDS: readonly { id: CostBand; label: string; test: (cost: number) => boolean }[] = [
  { id: 'all', label: '全部功耗', test: () => true },
  { id: 'le100', label: '≤100W', test: (c) => c <= 100 },
  { id: '101-300', label: '101–300W', test: (c) => c >= 101 && c <= 300 },
  { id: '301-500', label: '301–500W', test: (c) => c >= 301 && c <= 500 },
  { id: 'gt500', label: '>500W（信仰档）', test: (c) => c > 500 },
]

export const TYPE_OPTIONS: readonly { id: 'all' | CardType; label: string }[] = [
  { id: 'all', label: '全部类型' },
  { id: 'gpu', label: '显卡' },
  { id: 'driver', label: '驱动' },
  { id: 'accessory', label: '外设' },
]

/** 稀有度排序权重（starter 最低 → legendary 最高； Rarity 契约并集） */
export const RARITY_ORDER: Record<Rarity, number> = {
  starter: 0,
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
}

export const RARITY_LABELS: Record<Rarity, string> = {
  starter: '初始',
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
}

/** 卡池中实际出现的派系（出现顺序 = 首次出现顺序，数据驱动零登记） */
export function factionsInPool(cards: readonly CardDefinition[]): FactionId[] {
  const seen: FactionId[] = []
  for (const card of cards) {
    if (!seen.includes(card.faction)) seen.push(card.faction)
  }
  return seen
}

/** 卡池中实际出现的稀有度（按 RARITY_ORDER 从低到高） */
export function raritiesInPool(cards: readonly CardDefinition[]): Rarity[] {
  const set = new Set<Rarity>()
  for (const card of cards) {
    if (card.rarity !== undefined) set.add(card.rarity)
  }
  return [...set].sort((a, b) => RARITY_ORDER[a] - RARITY_ORDER[b])
}

export function matchesFilters(card: CardDefinition, f: CodexFilters): boolean {
  if (f.faction !== 'all' && card.faction !== f.faction) return false
  if (f.rarity !== 'all' && (card.rarity ?? 'common') !== f.rarity) return false
  if (f.type !== 'all' && card.type !== f.type) return false
  if (f.costBand !== 'all') {
    const band = COST_BANDS.find((b) => b.id === f.costBand)
    if (band && !band.test(card.cost)) return false
  }
  return true
}

export function applyFilters(cards: readonly CardDefinition[], f: CodexFilters): CardDefinition[] {
  return cards.filter((card) => matchesFilters(card, f))
}

export function sortCards(cards: readonly CardDefinition[], sort: CodexSort): CardDefinition[] {
  const out = [...cards]
  switch (sort) {
    case 'cost':
      out.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, 'zh'))
      break
    case 'name':
      out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      break
    case 'rarity':
      // 稀有度从高到低（传说在前），同稀有度按费用升序
      out.sort(
        (a, b) =>
          RARITY_ORDER[b.rarity ?? 'common'] - RARITY_ORDER[a.rarity ?? 'common'] || a.cost - b.cost,
      )
      break
  }
  return out
}
