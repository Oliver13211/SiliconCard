/**
 * content 数据装载（M3-AGT1）。
 *
 * CLI 运行在 Node（vite-node 直呼），无法用 client 的 Vite import.meta.glob，
 * 改为启动时从磁盘遍历 packages/content/cards/**＋decks/*.json：
 * - 卡牌定义经 core 的 findCardDefinitionIssues 结构校验后 registerCardDefinitions 注入；
 * - 预组卡组按 decks JSON 的 { id, name, faction, cards } 约定解析（与 client deckLoader 同形）；
 * - --deck / --opponent-deck 既接受预组卡组 id，也接受任意卡组 JSON 文件路径。
 *
 * 数据仍是 content JSON 唯一事实源，CLI 不硬编码任何卡牌数值（架构铁律 4）。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findCardDefinitionIssues,
  getFactionSkill,
  registerCardDefinitions,
  type CardDefinition,
  type DeckSpec,
  type FactionId,
} from '@siliconcard/core'

/** cli 参数错误：退出码 2，错误信息带纠正指引 */
export class UsageError extends Error {}

export interface DeckFile {
  id: string
  name: string
  faction: FactionId
  cards: { cardId: string; count: number }[]
}

export interface DeckChoice {
  name: string
  faction: FactionId
  spec: DeckSpec
}

export interface ContentData {
  source: string
  cards: CardDefinition[]
  invalidCards: { cardId: string; issue: string }[]
  decks: DeckFile[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** content 目录：默认从本文件位置推导（packages/cli/src → packages/content），可用环境变量覆盖 */
export function defaultContentDir(): string {
  const envDir = process.env['SILICONCARD_CONTENT_DIR']
  if (envDir) return resolve(envDir)
  return resolve(repoRoot(), 'packages', 'content')
}

/**
 * 仓库根：从本文件位置推导（packages/cli/src → 上三级）。
 *
 * 为什么不依赖 cwd：`yarn workspace @siliconcard/cli play` 会把进程 cwd 切到
 * packages/cli/，且 yarn 4 的 INIT_CWD 实测也指向 workspace 目录——相对路径
 * 的默认值因此必须走位置推导，才能与文档「仓库根下的 silicon-card-game/」一致。
 */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

/** file 模式交换目录默认值：仓库根下的 silicon-card-game/（稳定，与文档一致） */
export function defaultGameDir(): string {
  return resolve(repoRoot(), 'silicon-card-game')
}

function walkJsonFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkJsonFiles(full))
    else if (name.endsWith('.json')) out.push(full)
  }
  return out.sort()
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new UsageError(`JSON 文件解析失败：${path}（${String(error)}）`)
  }
}

function parseDeckFile(raw: unknown, origin: string): DeckFile {
  if (!isRecord(raw)) throw new UsageError(`卡组文件不是 JSON 对象：${origin}`)
  const cards = raw['cards']
  if (typeof raw['faction'] !== 'string' || !Array.isArray(cards)) {
    throw new UsageError(
      `卡组文件缺少 faction 或 cards 字段：${origin}（约定 { "faction": "...", "cards": [{ "cardId": "...", "count": n }] }）`,
    )
  }
  const parsed: { cardId: string; count: number }[] = []
  for (const entry of cards) {
    if (!isRecord(entry) || typeof entry['cardId'] !== 'string' || typeof entry['count'] !== 'number') {
      throw new UsageError(`卡组 cards 条目需为 { cardId: string, count: number }：${origin}`)
    }
    parsed.push({ cardId: entry['cardId'], count: entry['count'] })
  }
  const id = typeof raw['id'] === 'string' ? raw['id'] : origin
  const name = typeof raw['name'] === 'string' ? raw['name'] : id
  return { id, name, faction: raw['faction'], cards: parsed }
}

/**
 * 装载并注册 content 卡池（幂等可重复调用；结构不合法的卡牌跳过并记录，
 * 规则语义仍由引擎 initGame 把关——与 client deckLoader 同一职责分层）。
 */
export function loadContent(contentDir: string = defaultContentDir()): ContentData {
  const cards: CardDefinition[] = []
  const invalidCards: { cardId: string; issue: string }[] = []
  for (const path of walkJsonFiles(resolve(contentDir, 'cards'))) {
    const raw = readJson(path)
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || !raw['id']) {
      invalidCards.push({ cardId: path, issue: '不是合法的卡牌定义对象（缺 id）' })
      continue
    }
    const issue = findCardDefinitionIssues(raw as unknown as CardDefinition)
    if (issue) {
      invalidCards.push({ cardId: raw['id'], issue })
      continue
    }
    cards.push(raw as unknown as CardDefinition)
  }
  if (cards.length > 0) registerCardDefinitions(cards)

  const decks: DeckFile[] = []
  const decksDir = resolve(contentDir, 'decks')
  if (existsSync(decksDir)) {
    for (const path of walkJsonFiles(decksDir)) {
      decks.push(parseDeckFile(readJson(path), path))
    }
  }
  return { source: contentDir, cards, invalidCards, decks }
}

/** 解析 --deck / --opponent-deck 参数：缺省 → 预组卡组 id / 任意卡组 JSON 路径 */
export function resolveDeckChoice(
  arg: string | undefined,
  fallbackDeckId: string,
  content: ContentData,
  side: 'deck' | 'opponent-deck',
): DeckChoice {
  const idOrPath = arg ?? fallbackDeckId
  let file: DeckFile
  if (idOrPath.endsWith('.json')) {
    const path = resolve(idOrPath)
    if (!existsSync(path)) {
      throw new UsageError(`--${side} 指向的卡组文件不存在：${idOrPath}`)
    }
    file = parseDeckFile(readJson(path), idOrPath)
  } else {
    const found = content.decks.find((d) => d.id === idOrPath)
    if (!found) {
      const known = content.decks.map((d) => d.id).join(' / ') || '（content 无预组卡组）'
      throw new UsageError(
        `--${side}「${idOrPath}」不是预组卡组 id。可用：${known}；或传卡组 JSON 文件路径（以 .json 结尾）。`,
      )
    }
    file = found
  }
  assertFactionPlayable(file.faction, `--${side}（${file.name}）`)
  return { name: file.name, faction: file.faction, spec: { cards: file.cards.map((c) => ({ ...c })) } }
}

/** 派系技能未注册时给出可读错误（engine 的 FACTION_UNREGISTERED 也会兜底） */
export function assertFactionPlayable(faction: string, label: string): void {
  if (!getFactionSkill(faction)) {
    throw new UsageError(
      `${label} 的派系「${faction}」没有可用的派系技能（当前内置：nvidia / amd / intel / neutral）。请换用内置四系的卡组。`,
    )
  }
}
