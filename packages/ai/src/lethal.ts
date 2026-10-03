/**
 * 直伤估计与斩杀线检测（纯函数，M1-AI1「直伤择优」）。
 *
 * 口径：只统计「合法动作里能直接打到敌方 CPU 的伤害」——攻击打脸 + 手牌驱动/
 * 战吼直伤（可指定敌方的部分）+ 派系技能直伤。估计值全部来自 getLegalActions
 * 展开出的动作与公开注册表（卡牌定义 / 派系技能定义属游戏数据，等同牌面文字），
 * 不读完整 state。
 *
 * 斩杀判定：可用打脸伤害合计 ≥ 对方（血量 + 护甲）即视为有斩杀——估计保守
 * （只数枚举出的合法动作），宁可漏杀不可误判后空过。
 */

import {
  getCardDefinition,
  getFactionSkill,
  type Action,
  type EffectStep,
  type PlayerView,
  type TargetRef,
} from '@siliconcard/core'

/** handler 逃生舱步骤的直伤估计：按「1 点伤害 × 70% 成功率」口径（对齐光追类技能） */
const HANDLER_FACE_DAMAGE_ESTIMATE = 0.7

function isEnemyHeroRef(target: TargetRef | null | undefined, view: PlayerView): boolean {
  return target !== undefined && target !== null && target.kind === 'hero' && target.playerId === view.opponent.id
}

/** 效果步骤组的打脸伤害合计（只数可指定敌方的 chosen 直伤与 handler 估计） */
function stepsFaceDamage(steps: readonly EffectStep[] | undefined): number {
  let damage = 0
  for (const step of steps ?? []) {
    if (step.op === 'damage') {
      const pool = step.target.pool
      if (step.target.kind === 'chosen' && (pool === 'anyCharacter' || pool === 'enemyHero')) {
        damage += step.amount
      }
    } else if (step.op === 'handler') {
      damage += HANDLER_FACE_DAMAGE_ESTIMATE
    }
  }
  return damage
}

/** 单个动作能直接打到敌方 CPU 的伤害估计（非直伤动作返回 0） */
export function actionFaceDamage(action: Action, view: PlayerView): number {
  switch (action.type) {
    case 'ATTACK': {
      if (!isEnemyHeroRef(action.target, view)) return 0
      const attacker = view.board.find((unit) => unit.instanceId === action.attackerId)
      return attacker ? attacker.attack : 0
    }
    case 'PLAY_CARD': {
      const card = view.you.hand.find((c) => c.uid === action.uid)
      if (!card) return 0
      const def = getCardDefinition(card.cardId)
      if (!def) return 0
      return stepsFaceDamage(def.effect?.steps)
    }
    case 'USE_HERO_POWER': {
      if (!isEnemyHeroRef(action.target, view)) return 0
      const skill = getFactionSkill(view.you.faction)
      if (!skill) return 0
      return stepsFaceDamage(skill.effect.steps)
    }
    default:
      return 0
  }
}

/**
 * 本回合可用打脸伤害合计。
 * PLAY_CARD 按 uid 去重（同一张牌多目标展开只计一次）、技能去重；
 * ATTACK 按动作计（双芯 GPU 的两次攻击各计一次）。
 */
export function estimateAvailableFaceDamage(view: PlayerView, legal: readonly Action[]): number {
  let total = 0
  const countedUids = new Set<string>()
  let heroPowerCounted = false
  for (const action of legal) {
    switch (action.type) {
      case 'ATTACK':
        total += actionFaceDamage(action, view)
        break
      case 'PLAY_CARD':
        if (!countedUids.has(action.uid)) {
          countedUids.add(action.uid)
          total += actionFaceDamage(action, view)
        }
        break
      case 'USE_HERO_POWER':
        if (!heroPowerCounted) {
          heroPowerCounted = true
          total += actionFaceDamage(action, view)
        }
        break
      default:
        break
    }
  }
  return total
}

/** 斩杀线检测：合计打脸伤害能清空对方（血量 + 护甲）即有斩杀 */
export function isLethalAvailable(view: PlayerView, legal: readonly Action[]): boolean {
  if (view.phase !== 'main') return false
  return estimateAvailableFaceDamage(view, legal) >= view.opponent.health + view.opponent.armor
}

/** 斩杀模式下的候选：所有能对敌方 CPU 造成直伤的合法动作 */
export function lethalCandidateActions(view: PlayerView, legal: readonly Action[]): Action[] {
  return legal.filter((action) => actionFaceDamage(action, view) > 0)
}
