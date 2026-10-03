/**
 * 卡组与卡牌定义加载（M1-UI1..3）。
 *
 * 数据来源优先级：
 * 1. packages/content/cards/ 下按派系分目录的全部 .json（正式卡池，M1-CNT 批次产出，
 *    经构建期 glob 注入并注册进引擎注册表）+ packages/content/decks/ 的预组卡组
 *    （M1-CNT4 交付）；
 * 2. 降级：PLACEHOLDER_CARDS（demo- 前缀占位卡池，见 fallbackContent.ts）
 *    + 按种子生成的随机牌组。
 *
 * decks JSON 约定（提案，供 card-content / 集成检查员对齐）：
 *   { "id": "nvidia-starter", "name": "NVIDIA 开荒组", "faction": "nvidia",
 *     "cards": [{ "cardId": "rtx-5090", "count": 2 }] }
 * 结构校验只在客户端做「能不能用」的过滤；规则语义（总数 30、定义已注册）
 * 仍由引擎 initGame 把关（两层校验职责分离，对齐 rules.md §12 精神）。
 *
 * 注入式参数（cards/decks 覆盖 glob 结果）仅供测试，运行时不传。
 */

import {
  DECK_SIZE,
  findCardDefinitionIssues,
  getCardDefinition,
  registerCardDefinitions,
  type CardDefinition,
  type DeckSpec,
  type FactionId,
} from '@siliconcard/core'
import { PLACEHOLDER_CARDS } from './fallbackContent'

/** packages/content/decks/*.json 的约定形状 */
export interface DeckFile {
  id: string
  name: string
  faction: FactionId
  cards: readonly { cardId: string; count: number }[]
}

export interface ContentReport {
  /** content：注册了正式卡池；fallback：正式卡池缺失，注册 demo 占位池 */
  source: 'content' | 'fallback'
  /** 注册的卡牌定义数 */
  registeredCards: number
  /** 未通过引擎结构校验、被跳过的 content 卡牌（id + 原因），控制台可见 */
  invalidCards: { cardId: string; issue: string }[]
  contentDecks: DeckFile[]
  /** 预组卡组是否就位（未就位时菜单提示「随机组卡」） */
  decksAvailable: boolean
}

export interface InjectedContent {
  cards?: Record<string, Record<string, unknown>>
  decks?: Record<string, Record<string, unknown>>
}

export const RANDOM_DECK_ID = '__random__'
export const RANDOM_DECK_OPTION = { id: RANDOM_DECK_ID, name: '随机牌组（从当前卡池组卡）' } as const

// —— Vite 构建期 glob：decks/ 尚未落地 → 空对象，随机组卡兜底 ——
const deckModules = import.meta.glob<Record<string, unknown>>(
  '../../../../content/decks/**/*.json',
  { eager: true, import: 'default' },
)
const cardModules = import.meta.glob<Record<string, unknown>>(
  '../../../../content/cards/**/*.json',
  { eager: true, import: 'default' },
)

/** 注册表当前生效的随机组卡池（ensureContentRegistered 后指向正式池或 demo 池） */
let activePool: readonly CardDefinition[] = PLACEHOLDER_CARDS

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseDeckFile(path: string, raw: Record<string, unknown>): DeckFile | null {
  const cards = raw.cards
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string') return null
  if (typeof raw.faction !== 'string' || !Array.isArray(cards)) return null
  const parsed: { cardId: string; count: number }[] = []
  for (const entry of cards) {
    if (!isRecord(entry)) return null
    if (typeof entry.cardId !== 'string' || typeof entry.count !== 'number') return null
    if (!Number.isInteger(entry.count) || entry.count <= 0) return null
    parsed.push({ cardId: entry.cardId, count: entry.count })
  }
  return { id: raw.id, name: raw.name, faction: raw.faction, cards: parsed }
}

function readDecks(source: Record<string, Record<string, unknown>>): DeckFile[] {
  const decks: DeckFile[] = []
  for (const [path, raw] of Object.entries(source)) {
    const deck = parseDeckFile(path, raw)
    if (deck) decks.push(deck)
  }
  return decks
}

function readValidCards(source: Record<string, Record<string, unknown>>): {
  valid: CardDefinition[]
  invalid: { cardId: string; issue: string }[]
} {
  const valid: CardDefinition[] = []
  const invalid: { cardId: string; issue: string }[] = []
  for (const [path, raw] of Object.entries(source)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
      invalid.push({ cardId: path, issue: '不是合法的卡牌定义对象（缺 id）' })
      continue
    }
    const issue = findCardDefinitionIssues(raw as unknown as CardDefinition)
    if (issue) {
      invalid.push({ cardId: raw.id, issue })
      continue
    }
    valid.push(raw as unknown as CardDefinition)
  }
  return { valid, invalid }
}

/**
 * 注册卡牌定义进引擎注册表（幂等）：
 * 正式卡池存在 → 注册 content（跳过结构不合法并记录，池切换为正式卡）；
 * 否则 → 注册 demo 占位池。返回报告供菜单页展示降级状态。
 */
export function ensureContentRegistered(injected?: InjectedContent): ContentReport {
  const deckSource = injected?.decks ?? deckModules
  const cardSource = injected?.cards ?? cardModules
  const contentDecks = readDecks(deckSource)
  const { valid, invalid } = readValidCards(cardSource)

  if (valid.length > 0) {
    registerCardDefinitions(valid)
    activePool = valid
    return { source: 'content', registeredCards: valid.length, invalidCards: invalid, contentDecks, decksAvailable: contentDecks.length > 0 }
  }
  registerCardDefinitions(PLACEHOLDER_CARDS)
  activePool = PLACEHOLDER_CARDS
  return { source: 'fallback', registeredCards: PLACEHOLDER_CARDS.length, invalidCards: [], contentDecks, decksAvailable: contentDecks.length > 0 }
}

// —— 确定性 LCG（牌组组合随机只影响开局配置，不进引擎状态；引擎内随机仍走 seed RNG） ——

function nextRandom(seed: number): { value: number; nextSeed: number } {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return { value: next / 0x100000000, nextSeed: next }
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  let s = seed >>> 0
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const r = nextRandom(s)
    s = r.nextSeed
    const j = Math.floor(r.value * (i + 1))
    const tmp = pool[i] as T
    pool[i] = pool[j] as T
    pool[j] = tmp
  }
  return pool
}

/**
 * 随机牌组：卡池按功耗排序后保底取 6 张最低费（开局供电曲线保障），
 * 其余从洗牌后的池循环补齐，总数恰为 DECK_SIZE（同种子结果相同）。
 */
export function buildFallbackDeck(seed: number, pool: readonly CardDefinition[] = activePool): DeckSpec {
  if (pool.length === 0) throw new Error('卡池为空：请先 ensureContentRegistered()')
  const byCost = [...pool].sort((a, b) => a.cost - b.cost)
  const curve = byCost.slice(0, Math.min(6, byCost.length))
  const rest = shuffled(pool, seed)
  const picks: string[] = [...curve.map((c) => c.id)]
  let index = 0
  while (picks.length < DECK_SIZE) {
    const def = rest[index % rest.length] as CardDefinition
    picks.push(def.id)
    index += 1
  }
  const cards: { cardId: string; count: number }[] = []
  for (const cardId of picks) {
    const existing = cards.find((c) => c.cardId === cardId)
    if (existing) existing.count += 1
    else cards.push({ cardId, count: 1 })
  }
  return { cards }
}

export interface DeckChoice {
  spec: DeckSpec
  label: string
  faction?: FactionId
}

/**
 * 解析菜单里的卡组选择：content 预组卡组按 id 命中；
 * 命不中 / 显式选随机 / 无预组卡组 → 随机组卡（正式池或 demo 池）。
 */
export function resolveDeckChoice(
  deckId: string | undefined,
  seed: number,
  report?: ContentReport,
): DeckChoice {
  const decks = report ? report.contentDecks : readDecks(deckModules)
  const found = deckId && deckId !== RANDOM_DECK_ID ? decks.find((d) => d.id === deckId) : undefined
  if (found) {
    return {
      spec: { cards: found.cards.map((c) => ({ cardId: c.cardId, count: c.count })) },
      label: found.name,
      faction: found.faction,
    }
  }
  return { spec: buildFallbackDeck(seed), label: RANDOM_DECK_OPTION.name }
}

/** 菜单页卡组下拉项：content 预组卡组（如有）+ 永远可用的随机组卡项 */
export function deckOptions(report?: ContentReport): { id: string; name: string; degraded: boolean }[] {
  const decks = (report ? report.contentDecks : readDecks(deckModules)).map((d) => ({
    id: d.id,
    name: d.name,
    degraded: false,
  }))
  return [...decks, { ...RANDOM_DECK_OPTION, degraded: decks.length === 0 }]
}

/** 诊断：某张卡是否已在引擎注册表（供 setup 页提示降级状态） */
export function isCardRegistered(cardId: string): boolean {
  return getCardDefinition(cardId) !== undefined
}
