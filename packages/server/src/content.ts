/**
 * 服务端 content 装载（M2-NET1）——与 packages/cli/src/content.ts 同一职责分层：
 * 数据唯一事实源是 packages/content 的 JSON，服务端不硬编码任何卡牌数值
 * （架构铁律 4）。Node 侧无法用 client 的 Vite import.meta.glob，按 cli 同款
 * 方案启动时从磁盘遍历 cards/ 与 decks/，经 core 结构校验后注册进引擎注册表。
 *
 * 与 cli 的差异：server 额外提供 AI 席位卡组（@siliconcard/ai 的合成卡池，
 * 覆盖全部关键词与费用曲线，见 ai/src/cardPool.ts——ai 预设声明该池供
 * 「server 虚拟玩家」复用）。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findCardDefinitionIssues,
  getCardDefinition,
  getFactionSkill,
  registerCardDefinitions,
  type CardDefinition,
} from '@siliconcard/core'
import { makeAiDeckSpec, registerAiCardPool } from '@siliconcard/ai'
import type { DeckDto } from './protocol'

export interface DeckFile {
  id: string
  name: string
  faction: string
  cards: { cardId: string; count: number }[]
}

export interface ServerContent {
  source: string
  cards: CardDefinition[]
  invalidCards: { cardId: string; issue: string }[]
  decks: DeckFile[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** content 目录：默认从本文件位置推导（packages/server/src → packages/content），可被环境变量/参数覆盖 */
export function defaultServerContentDir(): string {
  const envDir = process.env['SILICONCARD_CONTENT_DIR']
  if (envDir) return resolve(envDir)
  return resolve(serverRepoRoot(), 'packages', 'content')
}

/** 仓库根：从本文件位置推导，不依赖 cwd（yarn workspace 会切换进程目录） */
export function serverRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

// 供 main.ts 输出 LAN 地址列表等使用（与 content 解耦的路径工具统一放这里导出）
export { serverRepoRoot as repoRoot }

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
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseDeckFile(raw: unknown, origin: string): DeckFile | null {
  if (!isRecord(raw) || !Array.isArray(raw['cards'])) return null
  const cards: { cardId: string; count: number }[] = []
  for (const entry of raw['cards']) {
    if (!isRecord(entry) || typeof entry['cardId'] !== 'string' || typeof entry['count'] !== 'number') return null
    cards.push({ cardId: entry['cardId'], count: entry['count'] })
  }
  const id = typeof raw['id'] === 'string' ? raw['id'] : origin
  const name = typeof raw['name'] === 'string' ? raw['name'] : id
  const faction = typeof raw['faction'] === 'string' ? raw['faction'] : ''
  if (!faction) return null
  return { id, name, faction, cards }
}

/**
 * 装载并注册 content 卡池（幂等可重复调用；结构不合法的卡牌跳过并记录，
 * 规则语义（张数、派系技能注册）仍由引擎 initGame 把关——两层校验职责分离）。
 */
export function loadServerContent(contentDir: string = defaultServerContentDir()): ServerContent {
  const cards: CardDefinition[] = []
  const invalidCards: { cardId: string; issue: string }[] = []
  for (const path of walkJsonFiles(resolve(contentDir, 'cards'))) {
    let raw: unknown
    try {
      raw = readJson(path)
    } catch {
      invalidCards.push({ cardId: path, issue: 'JSON 解析失败' })
      continue
    }
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
      try {
        const deck = parseDeckFile(readJson(path), path)
        if (deck) decks.push(deck)
      } catch {
        // 预组卡组解析失败不阻断服务端启动，只是不出现在可选列表里
      }
    }
  }
  return { source: contentDir, cards, invalidCards, decks }
}

/** 结构 + 注册表预检：卡组里出现未注册卡牌 / 派系技能未注册 → 给出可读错误（引擎语义校验仍在 initGame）。
 *  以 core 注册表为准（含 AI 合成卡池等已注册定义），不区分卡池来源。 */
export function validateDeckDto(deck: DeckDto): string | null {
  for (const entry of deck.cards) {
    if (!getCardDefinition(entry.cardId)) {
      return `卡组引用了未注册的卡牌「${entry.cardId}」`
    }
  }
  if (!getFactionSkill(deck.faction)) {
    return `派系「${deck.faction}」没有可用的派系技能（当前内置：nvidia / amd / intel / neutral）`
  }
  return null
}

/**
 * AI 席位卡组：注册 ai 包合成卡池并返回卡组 spec（幂等）。
 * 派系决定英雄技能：缺省 amd，房主若已选 amd 则镜像 nvidia（与自对弈验收同构）。
 */
export function aiSeatDeck(hostFaction?: string): { faction: string; cards: { cardId: string; count: number }[] } {
  registerAiCardPool()
  const spec = makeAiDeckSpec()
  return {
    faction: hostFaction === 'amd' ? 'nvidia' : 'amd',
    cards: spec.cards.map((entry) => ({ ...entry })),
  }
}
