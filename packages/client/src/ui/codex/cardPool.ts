/**
 * 图鉴卡池（P2-UI4）—— 与 deckLoader 同一条 Vite 构建期 glob 数据源
 * （packages/content/cards 按派系分目录的全部 JSON），新卡入池零登记自动进图鉴
 * （验收标准）。
 *
 * 与引擎注册表的关系：
 * - 这里只读校验（findCardDefinitionIssues），不注册、不改引擎状态；
 * - {cardId} 占位符解析（召唤卡名）优先查引擎注册表 getCardDefinition
 *   （glossary/README.md「{cardId} 由客户端卡牌注册表解析」），查不到再回落本卡池。
 */

import { findCardDefinitionIssues, getCardDefinition, type CardDefinition } from '@siliconcard/core'

const cardModules = import.meta.glob<Record<string, unknown>>('../../../../content/cards/**/*.json', {
  eager: true,
  import: 'default',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 加载图鉴卡池：content/cards 下全部结构合法的定义，按 id 去重（后写覆盖，
 * 与 registerCardDefinitions 的注册表语义一致）。
 */
export function loadCodexCards(source: Record<string, Record<string, unknown>> = cardModules): CardDefinition[] {
  const byId = new Map<string, CardDefinition>()
  for (const raw of Object.values(source)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) continue
    const issue = findCardDefinitionIssues(raw as unknown as CardDefinition)
    if (issue) continue
    byId.set(raw.id, raw as unknown as CardDefinition)
  }
  return [...byId.values()]
}

/** 卡名解析器：引擎注册表优先（对局事实源），图鉴卡池兜底，最后原样输出 cardId */
export function makeCardNameResolver(pool: readonly CardDefinition[] = []): (cardId: string) => string {
  const poolNames = new Map(pool.map((def) => [def.id, def.name]))
  return (cardId) => getCardDefinition(cardId)?.name ?? poolNames.get(cardId) ?? cardId
}
