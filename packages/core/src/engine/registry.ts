/**
 * 卡牌定义注册表 —— CardDefinition 的运行时注入点。
 *
 * content 包的 JSON 数据在宿主进程启动时 registerCardDefinitions() 进来，
 * 引擎按 cardId 查询基础数值（当前用途：抽牌时填充 HandCard.cost）。
 *
 * 注册表是环境配置而非对局状态：不进入 GameState、不随状态序列化；
 * 确定性不受影响（同一 content + 同一 seed + 同一动作序列 → 同一状态）。
 */

import type { CardDefinition, CardId } from '../types/cards'

const registry = new Map<CardId, CardDefinition>()

/** 批量注册卡牌定义；同 id 重复注册时后写覆盖（便于热更新/测试覆盖） */
export function registerCardDefinitions(defs: readonly CardDefinition[]): void {
  for (const def of defs) registry.set(def.id, def)
}

export function getCardDefinition(cardId: CardId): CardDefinition | undefined {
  return registry.get(cardId)
}

/** 清空注册表（测试隔离用） */
export function clearCardDefinitions(): void {
  registry.clear()
}
