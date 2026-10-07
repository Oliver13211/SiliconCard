/**
 * 展示层小工具：卡牌定义读取（引擎注册表属环境配置，非对局状态）与类型/稀有度文案。
 */

import { getCardDefinition, type CardDefinition, type CardType, type Keyword, type PlayerView, type TargetRef } from '@siliconcard/core'
import { keywordLabel } from '../game/fallbackContent'

export function keywordLabelOf(id: Keyword): string {
  return keywordLabel(id)
}

export function cardDef(cardId: string): CardDefinition | undefined {
  return getCardDefinition(cardId)
}

export function cardDisplayName(cardId: string): string {
  return getCardDefinition(cardId)?.name ?? cardId
}

export const CARD_TYPE_LABELS: Record<CardType, string> = {
  gpu: '显卡',
  driver: '驱动',
  accessory: '配件',
}

export function typeLabel(type: CardType): string {
  return CARD_TYPE_LABELS[type]
}

/**
 * 稀有度 → CSS 修饰类（演出修正阶段二：2.5D 描边四档分级）。
 * starter/未定义归 is-common 档；与 hud.css 的 --rim 变量组配合。
 */
export function rarityClassName(rarity: string | undefined): string {
  switch (rarity) {
    case 'legendary':
      return 'is-legendary'
    case 'epic':
      return 'is-epic'
    case 'rare':
      return 'is-rare'
    default:
      return 'is-common'
  }
}

export function isUnitTarget(target: TargetRef): target is Extract<TargetRef, { kind: 'unit' }> {
  return target.kind === 'unit'
}

export function unitOf(view: PlayerView, instanceId: string) {
  return view.board.find((u) => u.instanceId === instanceId)
}
