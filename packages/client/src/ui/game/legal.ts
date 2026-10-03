/**
 * 可交互性推导（M1-UI2 验收核心）—— 一切按钮/手牌的可点状态与禁用原因
 * 都从 viewFor + getLegalActions 推导，UI 不自维护对局事实（架构铁律 3）。
 *
 * 禁用原因原则（预设硬约束）：梗化但清晰——玩家读完知道"为什么不行、下一步干嘛"。
 */

import {
  BOARD_LIMIT,
  HERO_POWER_COST,
  getCardDefinition,
  getFactionSkill,
  type Action,
  type BoardUnit,
  type FactionId,
  type HandCard,
  type PlayerId,
  type PlayerView,
  type TargetRef,
} from '@siliconcard/core'

export interface Interactivity {
  ended: boolean
  yourTurn: boolean
  /** uid → 可选目标列表；空数组 = 无需目标即可打出 */
  playsByUid: ReadonlyMap<string, readonly TargetRef[]>
  /** attackerId → 可选攻击目标 */
  attacksByAttacker: ReadonlyMap<string, readonly TargetRef[]>
  /** null = 技能当前不可用；[] = 无需目标；非空 = 需要指定目标 */
  heroPowerTargets: readonly TargetRef[] | null
  canEndTurn: boolean
}

export function deriveInteractivity(view: PlayerView, legal: readonly Action[]): Interactivity {
  // 引擎展开的不变量：同一 uid 要么全部动作带 target（chosen 牌），要么全部不带。
  // 这里仍按条目记录 needsTarget 标记，防御未来契约变化时两类动作互相污染。
  const playEntries = new Map<string, { targets: TargetRef[]; needsTarget: boolean }>()
  const attacksByAttacker = new Map<string, TargetRef[]>()
  let heroPowerEntry: { targets: TargetRef[]; needsTarget: boolean } | null = null
  let canEndTurn = false

  for (const action of legal) {
    switch (action.type) {
      case 'PLAY_CARD': {
        const entry = playEntries.get(action.uid) ?? { targets: [], needsTarget: false }
        if (action.target) {
          entry.targets.push(action.target)
          entry.needsTarget = true
        }
        playEntries.set(action.uid, entry)
        break
      }
      case 'ATTACK': {
        const targets = attacksByAttacker.get(action.attackerId) ?? []
        targets.push(action.target)
        attacksByAttacker.set(action.attackerId, targets)
        break
      }
      case 'USE_HERO_POWER': {
        heroPowerEntry ??= { targets: [], needsTarget: false }
        if (action.target) {
          heroPowerEntry.targets.push(action.target)
          heroPowerEntry.needsTarget = true
        }
        break
      }
      case 'END_TURN':
        canEndTurn = true
        break
      case 'CONCEDE':
        break
    }
  }

  const playsByUid = new Map<string, readonly TargetRef[]>()
  for (const [uid, entry] of playEntries) {
    playsByUid.set(uid, entry.needsTarget ? entry.targets : [])
  }
  const heroPowerTargets = heroPowerEntry ? (heroPowerEntry.needsTarget ? heroPowerEntry.targets : []) : null

  return {
    ended: view.phase === 'ended',
    yourTurn: view.activePlayer === view.viewer && view.phase === 'main',
    playsByUid,
    attacksByAttacker,
    heroPowerTargets,
    canEndTurn,
  }
}

const NOT_YOUR_TURN = '还没轮到你——对面正在点亮机器'

export interface Availability {
  available: boolean
  reason?: string
}

/** 手牌可打性 + 禁用原因（按 §3 校验次序给梗化解释） */
export function handCardStatus(
  view: PlayerView,
  interactivity: Interactivity,
  card: HandCard,
): Availability {
  if (interactivity.ended) return { available: false, reason: '对局已结束' }
  if (!interactivity.yourTurn) return { available: false, reason: NOT_YOUR_TURN }

  const legalTargets = interactivity.playsByUid.get(card.uid)
  if (legalTargets) return { available: true }

  // 引擎没为这张牌展开动作——按 §3 顺序反推原因（只读展示用的定义注册表，非对局状态）
  if (card.cost > view.you.mana) {
    return {
      available: false,
      reason: `供电不够：这张卡要 ${card.cost}W，余电只剩 ${view.you.mana}W`,
    }
  }
  const def = getCardDefinition(card.cardId)
  if (!def) return { available: false, reason: '卡牌定义未注册（宿主环境异常）' }
  const ownUnits = view.board.filter((u) => u.ownerId === view.viewer).length
  if (def.type !== 'driver' && ownUnits >= BOARD_LIMIT) {
    return { available: false, reason: `扩展槽插满了（${ownUnits}/${BOARD_LIMIT}），先拔一个再上` }
  }
  return { available: false, reason: '这牌需要目标，但当前场上没有可选目标' }
}

/** 场上单位（自己的）可攻击性 + 禁用原因 */
export function attackStatusOf(
  view: PlayerView,
  interactivity: Interactivity,
  unit: BoardUnit,
): Availability {
  if (interactivity.ended) return { available: false, reason: '对局已结束' }
  if (unit.ownerId !== view.viewer) return { available: false, reason: '这不是你的显卡' }
  if (!interactivity.yourTurn) return { available: false, reason: NOT_YOUR_TURN }
  if (interactivity.attacksByAttacker.has(unit.instanceId)) return { available: true }
  if (unit.attacksRemaining <= 0) {
    return { available: false, reason: '本回合攻击次数用完了' }
  }
  if (unit.summonedOnTurn === view.turn && !unit.keywords.includes('charge')) {
    return { available: false, reason: '刚插上还没点亮（召唤失调），下回合才能上' }
  }
  return { available: false, reason: '当前没有可攻击的目标' }
}

/** 技能功耗（技能定义在引擎注册表，非对局状态；未注册时按基线 200W 提示） */
export function heroPowerCost(faction: FactionId): number {
  return getFactionSkill(faction)?.cost ?? HERO_POWER_COST
}

/** 派系技能按钮可用性 + 禁用原因 */
export function heroPowerStatus(view: PlayerView, interactivity: Interactivity): Availability {
  if (interactivity.ended) return { available: false, reason: '对局已结束' }
  if (!interactivity.yourTurn) return { available: false, reason: NOT_YOUR_TURN }
  if (interactivity.heroPowerTargets) return { available: true }
  if (view.you.heroPowerUsed) {
    return { available: false, reason: '本回合的技能已经交了（每回合一次）' }
  }
  const cost = heroPowerCost(view.you.faction)
  if (cost > view.you.mana) {
    return { available: false, reason: `供电不够：技能要 ${cost}W，余电只剩 ${view.you.mana}W` }
  }
  return { available: false, reason: '技能当前没有可用目标' }
}

/** 结束回合按钮（永远渲染；非你回合禁用并说明） */
export function endTurnStatus(interactivity: Interactivity): Availability {
  if (interactivity.ended) return { available: false, reason: '对局已结束' }
  if (!interactivity.yourTurn) return { available: false, reason: NOT_YOUR_TURN }
  return { available: interactivity.canEndTurn, reason: interactivity.canEndTurn ? undefined : '当前不能结束回合' }
}

// —— 目标描述（目标选择高亮 + 战报共用） ——

export function targetKey(target: TargetRef): string {
  return target.kind === 'unit' ? `unit:${target.instanceId}` : `hero:${target.playerId}`
}

export function describeTarget(view: PlayerView, target: TargetRef): string {
  if (target.kind === 'hero') {
    const player = target.playerId === view.viewer ? view.you : view.opponent
    const side = target.playerId === view.viewer ? '你的' : '对面的'
    return `${side} CPU ${player.heroName}`
  }
  const unit = view.board.find((u) => u.instanceId === target.instanceId)
  const name = unit ? (getCardDefinition(unit.cardId)?.name ?? unit.cardId) : '下岗显卡'
  return name
}

export function playerName(view: PlayerView, playerId: PlayerId): string {
  if (playerId === view.viewer) return `你（${view.you.heroName}）`
  return `对面（${view.opponent.heroName}）`
}
