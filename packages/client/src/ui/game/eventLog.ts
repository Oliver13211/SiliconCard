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

/**
 * 关键事件类别（P2-UI1）：驱动战报高亮（样式取 tokens 状态语义色）。
 * - lethal：斩杀一击（英雄被打到 0，随后必接 GAME_END）
 * - game-end：终局
 * - burn-out：跳闸（下回合功耗被锁，与"供电不足"同源语义）
 * - shield：质保（三年质保）挡下伤害
 * - legendary：传说卡入场
 */
export type LogKind = 'lethal' | 'game-end' | 'burn-out' | 'shield' | 'legendary'

export interface LogEntry {
  id: number
  text: string
  tone: LogTone
  /** 所属回合号（0 = 开局段）；由 TURN_START 事件流推进，供战报按回合分组 */
  turn?: number
  /** 关键事件类别（普通条目缺省）；渲染层据此挂高亮类 */
  kind?: LogKind | 'turn'
}

let nextLogId = 1

function entry(text: string, tone: LogTone, meta: { turn?: number; kind?: LogEntry['kind'] } = {}): LogEntry {
  return { id: nextLogId++, text, tone, ...meta }
}

function cardName(cardId: string): string {
  return getCardDefinition(cardId)?.name ?? cardId
}

function isLegendary(cardId: string): boolean {
  return getCardDefinition(cardId)?.rarity === 'legendary'
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
 * 同时为每条标注所属回合（TURN_START 推进）与关键事件类别（P2-UI1 分组/高亮）。
 */
export function eventsToLogEntries(view: PlayerView, events: readonly GameEvent[]): LogEntry[] {
  const entries: LogEntry[] = []
  // 回合追踪以结算后视图的回合号打底：store 按动作批次调用本函数，批次里不一定有
  // TURN_START（如托管 bot 每个动作一批）——若从 0 起算，这批事件会被错归"开局"。
  // TURN_START/TURN_END 自带 turn 字段，仍按事件覆盖推进。
  let currentTurn = view.turn ?? 0
  for (const event of events) {
    switch (event.type) {
      case 'GAME_START':
        currentTurn = 0
        entries.push(entry(`对局开始 · 种子 ${event.seed} · ${event.firstPlayer} 先手上电`, 'system', { turn: 0 }))
        break
      case 'TURN_START':
        currentTurn = event.turn
        entries.push(
          entry(`—— 第 ${event.turn} 回合 · ${playerName(view, event.playerId)} 的回合 ——`, 'system', {
            turn: event.turn,
            kind: 'turn',
          }),
        )
        break
      case 'TURN_END':
        entries.push(entry(`${playerName(view, event.playerId)} 回合结束`, 'system', { turn: event.turn }))
        break
      case 'CARD_DRAWN':
        // 普通抽牌不进战报（每回合都有，属于噪音）；疲劳抽牌由 FATIGUE 事件播报
        break
      case 'CARD_PLAYED':
        entries.push(
          entry(
            `${playerName(view, event.playerId)} 打出「${cardName(event.cardId)}」${targetText(view, event.target)}（${event.cost}W）`,
            'info',
            { turn: currentTurn, kind: isLegendary(event.cardId) ? 'legendary' : undefined },
          ),
        )
        break
      case 'CARD_BURNED':
        entries.push(
          entry(`${playerName(view, event.playerId)} 手牌爆仓，「${cardName(event.cardId)}」直接进火葬场`, 'info', {
            turn: currentTurn,
          }),
        )
        break
      case 'MINION_SUMMONED':
        if (event.source === 'effect') {
          entries.push(
            entry(`「${cardName(event.unit.cardId)}」被效果拉上机（扩展槽）`, 'info', {
              turn: currentTurn,
              kind: isLegendary(event.unit.cardId) ? 'legendary' : undefined,
            }),
          )
        }
        break
      case 'MINION_DIED':
        entries.push(entry(`「${cardName(event.unit.cardId)}」冒烟下岗`, 'combat', { turn: currentTurn }))
        break
      case 'ATTACK_DECLARED': {
        const attacker = view.board.find((u) => u.instanceId === event.attackerId)
        const attackerName = attacker ? cardName(attacker.cardId) : event.attackerId
        entries.push(
          entry(
            `${playerName(view, attacker?.ownerId ?? view.viewer)} 的「${attackerName}」撞向 ${describeTarget(view, event.target)}`,
            'combat',
            { turn: currentTurn },
          ),
        )
        break
      }
      case 'DAMAGE_DEALT': {
        if (event.shieldConsumed) {
          entries.push(entry(`${describeTarget(view, event.target)} 的三年质保生效，伤害整段被挡下`, 'combat', {
            turn: currentTurn,
            kind: 'shield',
          }))
          break
        }
        const armorNote = event.armorAbsorbed ? `（护甲吸收 ${event.armorAbsorbed}）` : ''
        const deadNote = event.remainingHealth <= 0 ? '，直接烧了' : ''
        // 斩杀一击：英雄（CPU）被打到 0——终局前的决定性伤害
        const lethal = event.target.kind === 'hero' && event.remainingHealth <= 0
        entries.push(
          entry(`${describeTarget(view, event.target)} 受到 ${event.amount} 点伤害${armorNote}${deadNote}`, 'combat', {
            turn: currentTurn,
            kind: lethal ? 'lethal' : undefined,
          }),
        )
        break
      }
      case 'HEALING':
        entries.push(entry(`${describeTarget(view, event.target)} 回血 ${event.amount} 点`, 'info', { turn: currentTurn }))
        break
      case 'KEYWORD_TRIGGERED':
        entries.push(
          entry(
            event.detail === '光追失败'
              ? '开光追失败：机器当场跳闸，无事发生（A 卡日常）'
              : `关键词生效：${event.detail}`,
            'info',
            { turn: currentTurn },
          ),
        )
        break
      case 'HERO_POWER_USED':
        entries.push(
          entry(
            `${playerName(view, event.playerId)} 发动技能「${skillNameOf(event.skillId)}」${targetText(view, event.target)}`,
            'info',
            { turn: currentTurn },
          ),
        )
        break
      case 'FATIGUE':
        entries.push(
          entry(`${playerName(view, event.playerId)} 牌库空转（第 ${event.fatigueCount} 次疲劳），掉 ${event.damage} 血`, 'combat', {
            turn: currentTurn,
          }),
        )
        break
      case 'BURN_OUT':
        entries.push(entry(`${playerName(view, event.playerId)} 跳闸！下回合 ${event.lockedMana}W 功耗被锁`, 'info', {
          turn: currentTurn,
          kind: 'burn-out',
        }))
        break
      case 'ARMOR_GAINED':
        entries.push(
          entry(`${playerName(view, event.playerId)} 护甲 +${event.amount}（当前 ${event.totalArmor}）`, 'info', {
            turn: currentTurn,
          }),
        )
        break
      case 'GAME_END': {
        if (!event.winner) {
          entries.push(entry('平局——两台机器同时烧了，握手言和', 'end', { turn: currentTurn, kind: 'game-end' }))
        } else {
          entries.push(
            entry(`🏁 ${playerName(view, event.winner)} 赢下对局！`, 'end', { turn: currentTurn, kind: 'game-end' }),
          )
        }
        break
      }
    }
  }
  return entries
}

/** 战报默认展开的最近回合数（P2-UI1：其余回合折叠） */
export const LOG_DEFAULT_OPEN_TURNS = 2

export interface LogTurnGroup {
  /** 回合号（0 = 开局段） */
  turn: number
  /** 回合头标题（取自 TURN_START 条目文案，去装饰线） */
  title: string
  /** 该回合全部条目（保留传入顺序——战报整体最新在上） */
  entries: readonly LogEntry[]
}

function turnTitleOf(text: string, turn: number): string {
  const stripped = text.replace(/——/g, '').trim()
  return stripped || (turn === 0 ? '开局' : `第 ${turn} 回合`)
}

/**
 * 把战报（最新在上）按回合合并成分组（纯函数，BattleLog 渲染折叠用）。
 * 按「回合值」归组而非按连续段——store 的开局 log 未反转（gameStore 现状）且
 * 动作批次各自 prepend，数组顺序不保证同回合连续；每回合至多一个分组是
 * BattleLog 折叠状态（按 turn 键控）的正确性前提。
 * 无 turn 标注的条目归入开局段（turn 0），防御旧数据/未标注路径。
 */
export function groupLogByTurn(log: readonly LogEntry[]): LogTurnGroup[] {
  const byTurn = new Map<number, { turn: number; title: string; entries: LogEntry[] }>()
  for (const item of log) {
    const turn = item.turn ?? 0
    let group = byTurn.get(turn)
    if (!group) {
      group = { turn, title: turn === 0 ? '开局' : `第 ${turn} 回合`, entries: [] }
      byTurn.set(turn, group)
    }
    group.entries.push(item)
    if (item.kind === 'turn') group.title = turnTitleOf(item.text, turn)
  }
  return [...byTurn.values()]
}

/** 终局事件判定：给 store 找 GAME_END（§9 收口保证：必为事件流最后一个且恰好一次） */
export function gameEndOf(events: readonly GameEvent[]): { winner: PlayerId | null; reason: 'health_zero' | 'concede' } | null {
  const last = events.at(-1)
  if (last && last.type === 'GAME_END') {
    return { winner: last.winner, reason: last.reason }
  }
  return null
}
