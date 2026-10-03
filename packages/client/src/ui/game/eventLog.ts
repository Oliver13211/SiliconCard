/**
 * 事件 → 战报（M1-UI1）：唯一驱动源是 GameEvent 事件流（架构铁律 3）。
 * 文案梗化但不牺牲可读性（预设硬约束）；对局事实一律取自事件载荷与展示用注册表。
 */

import {
  getCardDefinition,
  getFactionSkill,
  type GameEvent,
  type PlayerId,
  type PlayerView,
  type TargetRef,
} from '@siliconcard/core'
import { describeTarget, playerName } from './legal'

export type LogTone = 'info' | 'combat' | 'system' | 'end'

export interface LogEntry {
  id: number
  text: string
  tone: LogTone
}

let nextLogId = 1

function entry(text: string, tone: LogTone): LogEntry {
  return { id: nextLogId++, text, tone }
}

function cardName(cardId: string): string {
  return getCardDefinition(cardId)?.name ?? cardId
}

function targetText(view: PlayerView, target: TargetRef | null): string {
  return target ? ` → ${describeTarget(view, target)}` : ''
}

function skillNameOf(skillId: string): string {
  return getFactionSkill(skillId)?.skillName ?? skillId
}

/**
 * 把一批引擎事件转成战报条目（按因果顺序）。view 是结算后的最新视图，
 * 目标描述（单位名等）以它为准；单位已死亡时 describeTarget 优雅降级。
 */
export function eventsToLogEntries(view: PlayerView, events: readonly GameEvent[]): LogEntry[] {
  const entries: LogEntry[] = []
  for (const event of events) {
    switch (event.type) {
      case 'GAME_START':
        entries.push(entry(`对局开始 · 种子 ${event.seed} · ${event.firstPlayer} 先手上电`, 'system'))
        break
      case 'TURN_START':
        entries.push(entry(`—— 第 ${event.turn} 回合 · ${playerName(view, event.playerId)} 的回合 ——`, 'system'))
        break
      case 'TURN_END':
        entries.push(entry(`${playerName(view, event.playerId)} 回合结束`, 'system'))
        break
      case 'CARD_DRAWN':
        // 普通抽牌不进战报（每回合都有，属于噪音）；疲劳抽牌由 FATIGUE 事件播报
        break
      case 'CARD_PLAYED':
        entries.push(
          entry(
            `${playerName(view, event.playerId)} 打出「${cardName(event.cardId)}」${targetText(view, event.target)}（${event.cost}W）`,
            'info',
          ),
        )
        break
      case 'CARD_BURNED':
        entries.push(entry(`${playerName(view, event.playerId)} 手牌爆仓，「${cardName(event.cardId)}」直接进火葬场`, 'info'))
        break
      case 'MINION_SUMMONED':
        if (event.source === 'effect') {
          entries.push(entry(`「${cardName(event.unit.cardId)}」被效果拉上机（扩展槽）`, 'info'))
        }
        break
      case 'MINION_DIED':
        entries.push(entry(`「${cardName(event.unit.cardId)}」冒烟下岗`, 'combat'))
        break
      case 'ATTACK_DECLARED': {
        const attacker = view.board.find((u) => u.instanceId === event.attackerId)
        const attackerName = attacker ? cardName(attacker.cardId) : event.attackerId
        entries.push(entry(`${playerName(view, attacker?.ownerId ?? view.viewer)} 的「${attackerName}」撞向 ${describeTarget(view, event.target)}`, 'combat'))
        break
      }
      case 'DAMAGE_DEALT': {
        if (event.shieldConsumed) {
          entries.push(entry(`${describeTarget(view, event.target)} 的三年质保生效，伤害整段被挡下`, 'combat'))
          break
        }
        const armorNote = event.armorAbsorbed ? `（护甲吸收 ${event.armorAbsorbed}）` : ''
        const deadNote = event.remainingHealth <= 0 ? '，直接烧了' : ''
        entries.push(entry(`${describeTarget(view, event.target)} 受到 ${event.amount} 点伤害${armorNote}${deadNote}`, 'combat'))
        break
      }
      case 'HEALING':
        entries.push(entry(`${describeTarget(view, event.target)} 回血 ${event.amount} 点`, 'info'))
        break
      case 'KEYWORD_TRIGGERED':
        entries.push(
          entry(
            event.detail === '光追失败'
              ? '开光追失败：机器当场跳闸，无事发生（A 卡日常）'
              : `关键词生效：${event.detail}`,
            'info',
          ),
        )
        break
      case 'HERO_POWER_USED':
        entries.push(entry(`${playerName(view, event.playerId)} 发动技能「${skillNameOf(event.skillId)}」${targetText(view, event.target)}`, 'info'))
        break
      case 'FATIGUE':
        entries.push(entry(`${playerName(view, event.playerId)} 牌库空转（第 ${event.fatigueCount} 次疲劳），掉 ${event.damage} 血`, 'combat'))
        break
      case 'BURN_OUT':
        entries.push(entry(`${playerName(view, event.playerId)} 跳闸！下回合 ${event.lockedMana}W 功耗被锁`, 'info'))
        break
      case 'ARMOR_GAINED':
        entries.push(entry(`${playerName(view, event.playerId)} 护甲 +${event.amount}（当前 ${event.totalArmor}）`, 'info'))
        break
      case 'GAME_END': {
        if (!event.winner) {
          entries.push(entry('平局——两台机器同时烧了，握手言和', 'end'))
        } else {
          entries.push(entry(`🏁 ${playerName(view, event.winner)} 赢下对局！`, 'end'))
        }
        break
      }
    }
  }
  return entries
}

/** 终局事件判定：给 store 找 GAME_END（§9 收口保证：必为事件流最后一个且恰好一次） */
export function gameEndOf(events: readonly GameEvent[]): { winner: PlayerId | null; reason: 'health_zero' | 'concede' } | null {
  const last = events.at(-1)
  if (last && last.type === 'GAME_END') {
    return { winner: last.winner, reason: last.reason }
  }
  return null
}
