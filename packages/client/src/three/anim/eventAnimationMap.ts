/**
 * 事件→动画映射表（M1-R3D4）—— 渲染契约 = docs/rules.md §6 的 17 种 GameEvent。
 *
 * 铁律（预设硬约束）：动画一律由 GameEvent 驱动；新事件先补本映射再写动画。
 * 键集用映射类型 `{ [K in GameEvent['type']] }` 声明，引擎加事件而本表未补时
 * typecheck 即失败（先于任何运行时检查）。
 *
 * 覆盖情况（17/17 全部有真动画，无豁免条目；变体级取舍在对应 play 内注明）：
 *  GAME_START        开局机位掠入（intro → table）
 *  TURN_START        回合横幅
 *  TURN_END          回合结束横幅（仅对手可见弱化，自己回合开始才是主演出）
 *  CARD_DRAWN        卡背从牌库飞入手牌（source=fatigue 时无事发生：
 *                    牌库已空无卡可飞，疲劳演出由 FATIGUE 事件承担 —— rules.md §6）
 *  CARD_PLAYED       手牌幽灵飞向场中淡出（落场由 MINION_SUMMONED 承接）
 *  CARD_BURNED       烧卡冒烟（手牌方向）
 *  MINION_SUMMONED   落场：从空中砸下 + easeOutBack 弹性
 *  MINION_DIED       死亡碎裂（3×3 碎片 + 重力坠落，先隐藏本体）
 *  ATTACK_DECLARED   攻击冲撞：后撤蓄力 → 弹冲 → 归位
 *  DAMAGE_DEALT      红色伤害飘字（盾耗尽附加「三年质保」，护甲吸收附加护甲字）
 *  HEALING           绿色治疗飘字
 *  KEYWORD_TRIGGERED 关键词特效：本体脉冲 + 梗名飘字（显示名占位表见下）
 *  HERO_POWER_USED   派系技能：英雄位蓝光飘字 + 技能名
 *  FATIGUE           疲劳：英雄位红色伤害飘字 + 冒烟
 *  BURN_OUT          跳闸闪屏（全屏黄色两连闪）+ 锁定功耗提示
 *  ARMOR_GAINED      护甲飘字（青白色）
 *  GAME_END          结算机位 + 胜负横幅 + 收尾闪屏
 *
 * play 函数只经 AnimationContext 操作场景（依赖倒置），可无头桩测。
 */

import * as THREE from 'three'
import type { Keyword } from '@siliconcard/core'
import type { EventAnimationMap } from './types'
import { easeInCubic, easeOutBack, easeOutCubic, easeOutElastic } from './tween'

/** 关键词显示名占位（rules.md §7 的梗名）——content 提供 KeywordManifest 后替换为数据驱动 */
export const KEYWORD_DISPLAY: Record<Keyword, string> = {
  taunt: '信仰充值',
  divine_shield: '三年质保',
  charge: '超频',
  windfury: '双芯 GPU',
  deathrattle: '蓝屏/传家宝',
  stealth: '无输出亮机',
  overload: '跳闸',
}

const DANGER = '#ff5d4d'
const HEAL = '#4ade80'
const INFO = '#35d0ff'
const GOLD = '#ffc53d'
const PALE = '#c8d4dd'

const v3 = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z)
/** 在 pos 基础上加偏移的新向量（不改入参） */
const offset = (pos: THREE.Vector3, x: number, y: number, z = 0): THREE.Vector3 =>
  pos.clone().add(v3(x, y, z))

export const eventAnimationMap: EventAnimationMap = {
  GAME_START: {
    kind: 'animation',
    play: (ctx) => {
      ctx.cameraSnap('intro')
      ctx.timeline.add({
        duration: 1.3,
        delay: 0.35,
        ease: easeOutCubic,
        onDone: () => ctx.cameraMove('table'),
      })
    },
  },

  TURN_START: {
    kind: 'animation',
    play: (ctx, ev) => {
      const mine = ev.playerId === ctx.viewerId
      ctx.banner(`回合 ${ev.turn} · ${mine ? '你的回合' : '对方回合'}`, mine ? INFO : PALE)
    },
  },

  TURN_END: {
    kind: 'animation',
    play: (ctx, ev) => {
      if (ev.playerId === ctx.viewerId) ctx.banner('回合结束', PALE)
    },
  },

  CARD_DRAWN: {
    kind: 'animation',
    play: (ctx, ev) => {
      // source=fatigue：牌库已空，无卡可飞（疲劳演出由 FATIGUE 事件承担，rules.md §6）
      if (ev.source === 'fatigue') return
      const ghost = ctx.spawnGhost(null, ev.playerId === 'P1' ? 0 : Math.PI)
      const from = ctx.deckAnchor(ev.playerId)
      const to = ctx.handAnchor(ev.playerId)
      ghost.setBase({ x: from.x, y: from.y, z: from.z })
      ctx.timeline.add({
        duration: 0.5,
        ease: easeOutCubic,
        onUpdate: (p) => {
          ghost.setBase({
            x: from.x + (to.x - from.x) * p,
            y: from.y + (to.y - from.y) * p + Math.sin(p * Math.PI) * 0.9,
            z: from.z + (to.z - from.z) * p,
          })
          ghost.opacity = p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2
        },
        onDone: () => ctx.releaseGhost(ghost),
      })
    },
  },

  CARD_PLAYED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const card = ctx.getHandCard(ev.uid)
      const from = card ? card.getWorldPosition(v3()) : ctx.handAnchor(ev.playerId)
      if (card) card.hide()
      const ghost = ctx.spawnGhost(card?.faceTexture ?? null)
      ghost.setBase({ x: from.x, y: from.y, z: from.z })
      const to = ctx.boardCenter(ev.playerId)
      ctx.timeline.add({
        duration: 0.42,
        ease: easeInCubic,
        onUpdate: (p) => {
          ghost.setBase({
            x: from.x + (to.x - from.x) * p,
            y: from.y + (to.y - from.y) * p + Math.sin(p * Math.PI) * 0.5,
            z: from.z + (to.z - from.z) * p,
          })
          ghost.fxScale = 1 - 0.25 * p
          ghost.opacity = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3
        },
        onDone: () => ctx.releaseGhost(ghost),
      })
    },
  },

  CARD_BURNED: {
    kind: 'animation',
    play: (ctx, ev) => {
      // 手牌超限：烧的是手牌区末端 —— 手牌锚点即近似冒烟位置
      const pos = ctx.handAnchor(ev.playerId)
      ctx.smokeAt(pos, 9)
      ctx.floatText(offset(pos, 0, 0.6), { text: '烧卡！', color: '#ffb14d', size: 52 })
    },
  },

  MINION_SUMMONED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const unit = ctx.getUnit(ev.unit.instanceId)
      if (!unit) return
      unit.fxScale = 0.55
      unit.fxOffset.set(0, 2.1, 0)
      unit.opacity = 0
      ctx.timeline.sequence([
        {
          duration: 0.34,
          ease: easeOutCubic,
          onUpdate: (p) => {
            unit.fxOffset.set(0, 2.1 * (1 - p), 0)
            unit.opacity = Math.min(1, p * 2.4)
          },
        },
        {
          duration: 0.3,
          ease: easeOutBack,
          onUpdate: (p) => {
            unit.fxScale = 0.55 + 0.45 * p
          },
          onDone: () => {
            unit.fxScale = 1
            unit.fxOffset.set(0, 0, 0)
            unit.opacity = 1
          },
        },
      ])
    },
  },

  MINION_DIED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const unit = ctx.getUnit(ev.unit.instanceId)
      if (!unit) return
      const pos = unit.getWorldPosition(v3())
      ctx.shatterAt(pos, unit.faceTexture, unit.group.rotation.y)
      unit.hide()
    },
  },

  ATTACK_DECLARED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const attacker = ctx.getUnit(ev.attackerId)
      const targetPos = ctx.targetPosition(ev.target)
      if (!attacker || !targetPos) return
      const from = attacker.getWorldPosition(v3())
      const dir = targetPos.clone().sub(from)
      dir.y = 0
      if (dir.lengthSq() < 1e-6) return
      dir.normalize()
      ctx.timeline.sequence([
        {
          // 蓄力后撤
          duration: 0.16,
          ease: easeOutCubic,
          onUpdate: (p) => attacker.fxOffset.copy(dir.clone().multiplyScalar(-0.45 * p)),
        },
        {
          // 弹冲过目标点再回弹
          duration: 0.34,
          ease: easeOutElastic,
          onUpdate: (p) => attacker.fxOffset.copy(dir.clone().multiplyScalar(1.1 * (1 - p))),
          onDone: () => attacker.fxOffset.set(0, 0, 0),
        },
      ])
    },
  },

  DAMAGE_DEALT: {
    kind: 'animation',
    play: (ctx, ev) => {
      const pos = ctx.targetPosition(ev.target)
      if (!pos) return
      const at = offset(pos, 0, 0.7)
      ctx.floatText(at, { text: `-${ev.amount}`, color: DANGER, size: 84 })
      if (ev.shieldConsumed) {
        ctx.floatText(offset(pos, 0, 1.25), { text: '三年质保碎裂', color: GOLD, size: 46 })
      } else if (ev.armorAbsorbed !== undefined && ev.armorAbsorbed > 0) {
        ctx.floatText(offset(pos, 0.5, 1.1), { text: `甲 -${ev.armorAbsorbed}`, color: PALE, size: 40 })
      }
    },
  },

  HEALING: {
    kind: 'animation',
    play: (ctx, ev) => {
      const pos = ctx.targetPosition(ev.target)
      if (!pos) return
      ctx.floatText(offset(pos, 0, 0.7), { text: `+${ev.amount}`, color: HEAL, size: 72 })
    },
  },

  KEYWORD_TRIGGERED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const unit = ctx.getUnit(ev.instanceId)
      if (!unit) return
      const pos = unit.getWorldPosition(v3())
      // 本体脉冲
      ctx.timeline.sequence([
        { duration: 0.14, ease: easeOutCubic, onUpdate: (p) => (unit.fxScale = 1 + 0.22 * p) },
        {
          duration: 0.22,
          ease: easeOutCubic,
          onUpdate: (p) => (unit.fxScale = 1.22 - 0.22 * p),
          onDone: () => (unit.fxScale = 1),
        },
      ])
      ctx.floatText(offset(pos, 0, 1.1), {
        text: ev.detail || KEYWORD_DISPLAY[ev.keyword],
        color: GOLD,
        size: 56,
      })
    },
  },

  HERO_POWER_USED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const hero = ctx.getHero(ev.playerId)
      if (!hero) return
      const pos = hero.getWorldPosition(v3())
      ctx.screenFlash(INFO, 0.16)
      ctx.floatText(offset(pos, 0, 1.0), { text: `技能 ${ev.skillId}`, color: INFO, size: 56 })
    },
  },

  FATIGUE: {
    kind: 'animation',
    play: (ctx, ev) => {
      const hero = ctx.getHero(ev.playerId)
      if (!hero) return
      const pos = hero.getWorldPosition(v3())
      ctx.floatText(offset(pos, 0, 0.9), { text: `疲劳 -${ev.damage}`, color: DANGER, size: 72 })
      ctx.smokeAt(pos, 4)
    },
  },

  BURN_OUT: {
    kind: 'animation',
    play: (ctx, ev) => {
      ctx.screenFlash('#ffd23d', 0.7, 1.8)
      ctx.floatText(v3(0, 2.4, 0.6), {
        text: `跳闸！下回合 ${ev.lockedMana}W 被锁定`,
        color: GOLD,
        size: 64,
        life: 1.5,
        rise: 0.3,
      })
    },
  },

  ARMOR_GAINED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const hero = ctx.getHero(ev.playerId)
      if (!hero) return
      const pos = hero.getWorldPosition(v3())
      ctx.floatText(offset(pos, 0, 0.9), { text: `+${ev.amount} 护甲`, color: PALE, size: 60 })
    },
  },

  GAME_END: {
    kind: 'animation',
    play: (ctx, ev) => {
      ctx.cameraMove('gameEnd')
      const text =
        ev.winner === null
          ? '平局 · 双双烧毁'
          : ev.winner === ctx.viewerId
            ? '胜利！R.I.P 对面烧了'
            : '败北 · 你的卡阵亡了'
      ctx.banner(text, ev.winner === ctx.viewerId ? GOLD : ev.winner === null ? PALE : DANGER)
      ctx.screenFlash(ev.winner === ctx.viewerId ? '#ffd23d' : '#ff5d4d', 0.4, 1.2)
    },
  },
}
