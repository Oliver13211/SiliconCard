/**
 * 事件→动画映射表（M1-R3D4 建立；M4-R3D5 第二阶段全面升级）——
 * 渲染契约 = docs/rules.md §6 的 17 种 GameEvent。
 *
 * 铁律（预设硬约束）：动画一律由 GameEvent 驱动；新事件先补本映射再写动画。
 * 键集用映射类型 `{ [K in GameEvent['type']] }` 声明，引擎加事件而本表未补时
 * typecheck 即失败（先于任何运行时检查）。**无 exempt 条目、无 switch 默认吞事件**：
 * 17/17 全部是真动画；变体级取舍在对应 play 内注明。
 *
 * M4-R3D5 演出升级总览（出口均在 fx/stageFx 池化，low 档自动降级）：
 * - GAME_START        开局机位掠入（intro → table）
 * - TURN_START        回合横幅 + 回合方英雄位光环
 * - TURN_END          回合结束横幅（仅对手可见弱化，自己回合开始才是主演出）
 * - CARD_DRAWN        卡背弧线飞入手牌 + 沿途蓝光拖迹（source=fatigue 无卡可飞）
 * - CARD_PLAYED       出牌空翻弧线增强 + 落场冲击环；传说卡金焰拖迹 + 落场光柱；
 *                     【全屏演出】传说卡 / 高费卡（≥400W，FULLSCREEN_COST_THRESHOLD）
 * - CARD_BURNED       烧卡冒烟 + 余烬粒子上腾
 * - MINION_SUMMONED   普通卡：空投 + easeOutBack 弹性 + 落场尘土 + 冲击环；
 *                     **传说卡专属演出**：光柱 + 镜头微震 + 金色描边流光 +
 *                     传说金环 + 金色迸发粒子 + ⭐ 横幅，时长近普通版两倍；
 *                     【全屏演出】效果入场（source='effect'）的传说卡在此补齐
 * - MINION_DIED       死亡碎裂（3×3 碎片）+ 碎裂冲击环 + 黑烟
 * - ATTACK_DECLARED   蓄力后撤 → 弹冲，命中瞬间目标点冲击环 + 火花 + 镜头微震
 * - DAMAGE_DEALT      红飘字 + 命中火花 + 本体受击红闪（血条闪烁反馈）；
 *                     盾耗：金色涟漪 +「三年质保碎裂」；护甲吸收：灰白小涟漪；
 *                     【全屏演出】大额一次伤害（≥5，FULLSCREEN_BIG_DAMAGE）
 * - HEALING           绿飘字 + 上升治疗粒子
 * - KEYWORD_TRIGGERED 关键词脉冲 + 梗名飘字 + 金色迸发；
 *                     detail='光追失败'（amd 30% 失败借位契约，rules.md §5）：
 *                     红色电弧抽搐 + 灰尘 + 暗红失败飘字，明确区分成功演出
 * - HERO_POWER_USED   七系派系技能专属动画（SKILL_FACTION 分流，见下）；
 *                     未知技能（mod）回落通用蓝闪演出
 * - FATIGUE           疲劳红闪 + 英雄位冒烟 + 伤害飘字
 * - BURN_OUT          跳闸：黄色两连闪屏 + 折线电弧 ×3 + 镜头微震 + 锁定提示
 * - ARMOR_GAINED      护甲飘字 + 灰白涟漪 + 上浮护甲粒子
 * - GAME_END          结算机位 + 胜负横幅 + 定格闪屏 + 胜方彩带迸发 + 重震
 *
 * 强力时刻全屏演出（演出修正阶段一）：以上【全屏演出】标记的事件经可选出口
 * ctx.screenImpact 触发（fx/screenImpact.ScreenImpactFx：冲击波扩散 + 色偏一瞬 +
 * 边缘暗角脉冲，与镜头微震叠加）；AOE 以批次启发式判定（同批 ≥3 个不同目标受击，
 * isAoeDamageBatch，AnimationDirector.enqueueEvents 调用）——引擎事件不动。
 *
 * 派系技能专属动画（rules.md §8，skillId → faction 静态表）：
 * - nvidia dlss             DLSS 帧插值拖影：目标单位残影 ×3 依次淡出（帧生成的梗）
 * - amd ray_tracing_try     开光追：英雄位→目标红蓝光束（成败由后续事件承接：
 *                           成功=DAMAGE_DEALT，失败=KEYWORD_TRIGGERED「光追失败」）
 * - intel driver_update     驱动更新：22%→67%→99%→完成 分段进度条（蓝光完成环）
 * - neutral dust_off        清灰：目标位灰尘扬起 + 小吸尘涡环
 * - apple efficiency        能效比：绿色能效护盾环 + 上升绿粒子（不发热）
 * - qualcomm tops_marketing TOPS 营销：紫色 TOPS 迸发 + 连环数据环 + 微震（数字膨胀）
 * - arm reference_design    公版方案：召唤点传送光柱 + 蓝白粒子垂直下落
 *
 * play 函数只经 AnimationContext 操作场景（依赖倒置）；新出口全部可选调用，
 * 旧桩（M1 测试）不实现也安全 no-op。
 */

import * as THREE from 'three'
import type { GameEvent, Keyword } from '@siliconcard/core'
import type { EventAnimationMap } from './types'
import { easeInCubic, easeOutBack, easeOutCubic, easeOutElastic } from './tween'
import { fxEnabled } from '../fx/quality'

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

/** 派系技能显示名（rules.md §8；mod 技能回落 skillId 原文） */
export const SKILL_DISPLAY: Record<string, string> = {
  dlss: 'DLSS 帧插值',
  ray_tracing_try: '开光追试试',
  driver_update: '驱动更新',
  dust_off: '清灰',
  efficiency: '能效比',
  tops_marketing: 'TOPS 营销',
  reference_design: '公版方案',
}

/** skillId → faction（rules.md §8 静态表；未知技能 → undefined → 通用演出） */
export const SKILL_FACTION: Record<string, string> = {
  dlss: 'nvidia',
  ray_tracing_try: 'amd',
  driver_update: 'intel',
  dust_off: 'neutral',
  efficiency: 'apple',
  tops_marketing: 'qualcomm',
  reference_design: 'arm',
}

const DANGER = '#ff5d4d'
const HEAL = '#4ade80'
const INFO = '#35d0ff'
const GOLD = '#ffc53d'
const LEGEND = '#ff9d2e'
const PALE = '#c8d4dd'

/** amd 光追失败的借位契约 detail（rules.md §5 定稿，勿改字面量——与 core 对齐） */
const RAY_TRACING_FAIL_DETAIL = '光追失败'

const v3 = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z)
/** 在 pos 基础上加偏移的新向量（不改入参） */
const offset = (pos: THREE.Vector3, x: number, y: number, z = 0): THREE.Vector3 =>
  pos.clone().add(v3(x, y, z))

/** MINION_SUMMONED：普通卡与传说卡共用入场本体补间的参数 */
const LEGENDARY_RARITY = 'legendary'

// —— 强力时刻全屏演出（演出修正阶段一，需求 3；引擎事件不动，渲染层自行判定） ——

/** 高费入场阈值：≥400W。依据：供电上限 MAX_MANA=1000W（core/constants）的 40%，
 *  内容包 90 张中仅 8 张达标 —— 后段大招才有的全场演出分量。 */
export const FULLSCREEN_COST_THRESHOLD = 400
/** 大额一次伤害阈值：≥5 点。依据：CPU 体质 HERO_MAX_HEALTH=30 的 1/6，
 *  单位攻击面板上限 8 —— 一拳打掉六分之一血才算「重锤」。 */
export const FULLSCREEN_BIG_DAMAGE = 5
/** AOE 批次全屏演出的染色（与直伤同色系，重入 fire 合并为一次演出） */
export const FULLSCREEN_AOE_COLOR = '#ff5d4d'

/**
 * AOE 批判定（纯函数）：同一批引擎事件中 ≥3 个**不同目标**的伤害。
 * 依据渲染契约：引擎不发 AOE 事件，范围效果以多条 DAMAGE_DEALT 逐目标落批；
 * 阈值取 3 以排除普通交换单挑（攻击 + 反击 = 同批 2 个目标）的误报。
 */
export function isAoeDamageBatch(events: readonly GameEvent[]): boolean {
  const seen = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'DAMAGE_DEALT') continue
    const t = ev.target
    seen.add(t.kind === 'unit' ? `u:${t.instanceId}` : `h:${t.playerId}`)
  }
  return seen.size >= 3
}

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
      // 回合方英雄位起一圈本方色光环（可感知「现在谁在操作」）
      const heroPos = ctx.getHero(ev.playerId)?.getWorldPosition(v3())
      if (heroPos) ctx.ringAt?.(heroPos, mine ? INFO : PALE, 1.7, 0.6)
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
      // 沿途拖迹：按进度节流发射（每 0.14 进度一小撮蓝光）；发射位置按同一插值式
      // 同步计算（group.position 由实体 update 落后一帧，快进时会是原点）
      let lastEmit = 0
      const trailPos = v3()
      ctx.timeline.add({
        duration: 0.5,
        ease: easeOutCubic,
        onUpdate: (p) => {
          const cx = from.x + (to.x - from.x) * p
          const cy = from.y + (to.y - from.y) * p + Math.sin(p * Math.PI) * 0.9
          const cz = from.z + (to.z - from.z) * p
          ghost.setBase({ x: cx, y: cy, z: cz })
          ghost.opacity = p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2
          if (p - lastEmit > 0.11) {
            lastEmit = p
            trailPos.set(cx, cy, cz)
            ctx.particles?.(trailPos, 'drawStreak', 1.3)
          }
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
      const legendary = ctx.getCardRarity?.(ev.cardId) === LEGENDARY_RARITY
      // 强力时刻全屏演出：传说卡 / 高费卡（≥400W）入场——冲击波 + 色偏 + 暗角脉冲
      if (legendary) {
        ctx.screenImpact?.(LEGEND, 1.1)
        ctx.shakeCamera?.(0.3)
      } else if (ev.cost >= FULLSCREEN_COST_THRESHOLD) {
        ctx.screenImpact?.(INFO, 0.9)
        ctx.shakeCamera?.(0.25)
      }
      const ghost = ctx.spawnGhost(card?.faceTexture ?? null)
      ghost.setBase({ x: from.x, y: from.y, z: from.z })
      const to = ctx.boardCenter(ev.playerId)
      // 弧线增强：弧顶更高 + 全程空翻一周（出牌的「拍上桌」感）
      const arc = legendary ? 1.5 : 1.0
      let lastEmit = 0
      const trailPos = v3()
      const land = v3(to.x, 0.15, to.z)
      ctx.timeline.add({
        duration: legendary ? 0.52 : 0.42,
        ease: easeInCubic,
        onUpdate: (p) => {
          const cx = from.x + (to.x - from.x) * p
          const cy = from.y + (to.y - from.y) * p + Math.sin(p * Math.PI) * arc
          const cz = from.z + (to.z - from.z) * p
          ghost.setBase({ x: cx, y: cy, z: cz })
          ghost.fxRotY = Math.PI * 2 * p // 空翻一周
          ghost.fxScale = 1 - 0.2 * p
          ghost.opacity = p < 0.72 ? 1 : 1 - (p - 0.72) / 0.28
          if (legendary && p - lastEmit > 0.1) {
            lastEmit = p
            trailPos.set(cx, cy, cz) // 同步插值位置（见 CARD_DRAWN 注）
            ctx.particles?.(trailPos, 'legendSpark', 0.75)
          }
        },
        onDone: () => {
          ghost.fxRotY = 0
          // 落场冲击环 + 尘土；驱动/外设（法术位）不落场，环弱一档
          ctx.ringAt?.(land, legendary ? LEGEND : INFO, legendary ? 2.2 : 1.5, 0.5)
          ctx.particles?.(land, 'dust', 1.0)
          ctx.releaseGhost(ghost)
        },
      })
    },
  },

  CARD_BURNED: {
    kind: 'animation',
    play: (ctx, ev) => {
      // 手牌超限：烧的是手牌区末端 —— 手牌锚点即近似冒烟位置
      const pos = ctx.handAnchor(ev.playerId)
      ctx.smokeAt(pos, 12)
      ctx.particles?.(offset(pos, 0, 0.2), 'ember', 1.3)
      ctx.floatText(offset(pos, 0, 0.6), { text: '烧卡！', color: '#ffb14d', size: 52 })
    },
  },

  MINION_SUMMONED: {
    kind: 'animation',
    play: (ctx, ev) => {
      const unit = ctx.getUnit(ev.unit.instanceId)
      if (!unit) return
      const pos = unit.getWorldPosition(v3())
      const legendary = ctx.getCardRarity?.(ev.unit.cardId) === LEGENDARY_RARITY

      if (legendary) {
        // —— 传说卡专属入场（验收硬标准）：光柱 + 镜头微震 + 描边流光 ——
        // 全屏演出由同批 CARD_PLAYED(source='play') 承担；效果入场（source='effect'
        // 亡语/增益等）无 CARD_PLAYED，在此补齐，重入 fire 自动合并
        if (ev.source === 'effect') ctx.screenImpact?.(LEGEND, 1.1)
        ctx.pillarAt?.(v3(pos.x, 0, pos.z), LEGEND, 1.3)
        ctx.shakeCamera?.(0.45)
        ctx.particles?.(pos, 'legendSpark', 1.3)
        ctx.ringAt?.(v3(pos.x, 0.4, pos.z), LEGEND, 2.6, 0.95)
        unit.flash(LEGEND) // 金色描边流光（update 内衰减）
        ctx.floatText(offset(pos, 0, 1.5), { text: '⭐ 传说降临', color: LEGEND, size: 60, life: 1.4 })
        // 本体：更高更慢的空投 + 大幅弹性，与普通卡明显区分
        unit.fxScale = 0.5
        unit.fxOffset.set(0, 3.2, 0)
        unit.opacity = 0
        ctx.timeline.sequence([
          {
            duration: 0.55,
            ease: easeInCubic,
            onUpdate: (p) => {
              unit.fxOffset.set(0, 3.2 * (1 - p), 0)
              unit.opacity = Math.min(1, p * 2.2)
            },
          },
          {
            duration: 0.45,
            ease: easeOutBack,
            onUpdate: (p) => {
              unit.fxScale = 0.5 + 0.5 * p
            },
            onDone: () => {
              unit.fxScale = 1
              unit.fxOffset.set(0, 0, 0)
              unit.opacity = 1
            },
          },
        ])
        return
      }

      // —— 普通卡：空投 + 弹性 + 召唤光柱（短促一束）+ 落场尘土与冲击环 ——
      unit.fxScale = 0.55
      unit.fxOffset.set(0, 2.1, 0)
      unit.opacity = 0
      ctx.pillarAt?.(v3(pos.x, 0, pos.z), INFO, 0.55)
      ctx.particles?.(v3(pos.x, 0.2, pos.z), 'dust', 1.3)
      ctx.ringAt?.(v3(pos.x, 0.4, pos.z), INFO, 1.4, 0.45)
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
      ctx.ringAt?.(v3(pos.x, 0.4, pos.z), PALE, 2.0, 0.6)
      ctx.smokeAt(pos, 7)
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
      // 命中反馈只在弹冲段触发一次（闭包标记，不重复播）
      let impacted = false
      const hitPos = targetPos.clone()
      // 冲击向量复用同一次分配（每帧 copy+scale，禁 per-frame new）
      const push = new THREE.Vector3()
      const impact = () => {
        if (impacted) return
        impacted = true
        ctx.ringAt?.(v3(hitPos.x, 0.4, hitPos.z), DANGER, 1.7, 0.45)
        ctx.particles?.(offset(hitPos, 0, 0.35), 'hitSpark', 1.3)
        ctx.shakeCamera?.(0.24)
        const victim = ev.target.kind === 'unit' ? ctx.getUnit(ev.target.instanceId) : null
        victim?.flash(DANGER) // 受击红闪（血条闪烁的 3D 反馈）
      }
      ctx.timeline.sequence([
        {
          // 蓄力后撤
          duration: 0.16,
          ease: easeOutCubic,
          onUpdate: (p) => attacker.fxOffset.copy(push.copy(dir).multiplyScalar(-0.45 * p)),
        },
        {
          // 弹冲过目标点再回弹；冲过半程即触发命中演出
          duration: 0.34,
          ease: easeOutElastic,
          onUpdate: (p) => {
            if (!impacted && p > 0.45) impact()
            attacker.fxOffset.copy(push.copy(dir).multiplyScalar(1.1 * (1 - p)))
          },
          onDone: () => {
            impact()
            attacker.fxOffset.set(0, 0, 0)
          },
        },
      ])
    },
  },

  DAMAGE_DEALT: {
    kind: 'animation',
    play: (ctx, ev) => {
      const pos = ctx.targetPosition(ev.target)
      if (!pos) return
      // 强力时刻全屏演出：大额一次伤害（≥5 且未被三年质保完全格挡）
      if (ev.amount >= FULLSCREEN_BIG_DAMAGE && !ev.shieldConsumed) ctx.screenImpact?.(DANGER, 0.85)
      const at = offset(pos, 0, 0.7)
      ctx.floatText(at, { text: `-${ev.amount}`, color: DANGER, size: 84 })
      ctx.particles?.(offset(pos, 0, 0.35), 'hitSpark', 1.15)
      const victim = ev.target.kind === 'unit' ? ctx.getUnit(ev.target.instanceId) : null
      // 英雄本体受击：红色暗角闪（铭牌数值由 syncView 刷新，此处补「挨打了」的体感）
      if (ev.target.kind === 'hero') ctx.screenFlash(DANGER, 0.14, 2.0)
      if (ev.shieldConsumed) {
        // 三年质保碎裂：金色涟漪 + 质保提示
        ctx.ringAt?.(v3(pos.x, pos.y - 0.3, pos.z), GOLD, 1.7, 0.5)
        victim?.flash(GOLD)
        ctx.floatText(offset(pos, 0, 1.25), { text: '三年质保碎裂', color: GOLD, size: 46 })
      } else if (ev.armorAbsorbed !== undefined && ev.armorAbsorbed > 0) {
        // 护甲格挡涟漪：灰白小圈，区分于直伤
        ctx.ringAt?.(v3(pos.x, pos.y - 0.3, pos.z), PALE, 1.1, 0.4)
        victim?.flash(PALE)
        ctx.floatText(offset(pos, 0.5, 1.1), { text: `甲 -${ev.armorAbsorbed}`, color: PALE, size: 40 })
      } else {
        victim?.flash(DANGER)
      }
    },
  },

  HEALING: {
    kind: 'animation',
    play: (ctx, ev) => {
      const pos = ctx.targetPosition(ev.target)
      if (!pos) return
      ctx.floatText(offset(pos, 0, 0.7), { text: `+${ev.amount}`, color: HEAL, size: 72 })
      ctx.particles?.(offset(pos, 0, 0.2), 'healMote', 1.3)
    },
  },

  KEYWORD_TRIGGERED: {
    kind: 'animation',
    play: (ctx, ev) => {
      // amd 光追失败（rules.md §5 借位契约：keyword='overload' + detail='光追失败'）
      if (ev.detail === RAY_TRACING_FAIL_DETAIL) {
        const unit = ctx.getUnit(ev.instanceId)
        const pos = unit?.getWorldPosition(v3()) ?? v3(0, 0.6, -1.0)
        const top = offset(pos, 0, 2.4)
        // 红色电弧抽搐两道 + 一撮灰（「开着开着就灭了」）
        ctx.boltBetween?.(top, offset(pos, 0.3, 0.4), '#ff4b3a')
        ctx.boltBetween?.(offset(top, -0.5, 0.3), offset(pos, -0.2, 0.4), '#ff4b3a')
        ctx.particles?.(pos, 'dustClean', 1.0)
        ctx.floatText(offset(pos, 0, 1.2), {
          text: '光追失败 · 回去等驱动吧',
          color: '#b3453c',
          size: 48,
          life: 1.3,
        })
        return
      }

      const unit = ctx.getUnit(ev.instanceId)
      if (!unit) return
      const pos = unit.getWorldPosition(v3())
      // 本体脉冲 + 金色迸发
      ctx.timeline.sequence([
        { duration: 0.14, ease: easeOutCubic, onUpdate: (p) => (unit.fxScale = 1 + 0.22 * p) },
        {
          duration: 0.22,
          ease: easeOutCubic,
          onUpdate: (p) => (unit.fxScale = 1.22 - 0.22 * p),
          onDone: () => (unit.fxScale = 1),
        },
      ])
      ctx.particles?.(offset(pos, 0, 0.4), 'goldBurst', 1.0)
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
      const heroPos = hero?.getWorldPosition(v3()) ?? v3(0, 0.6, 0)
      const skillName = SKILL_DISPLAY[ev.skillId] ?? ev.skillId

      // —— 七系派系技能专属演出（rules.md §8）——
      switch (SKILL_FACTION[ev.skillId]) {
        case 'nvidia': {
          // DLSS 帧插值拖影：目标单位的残影 ×3 依次错位淡出（帧生成的梗；low 档关闭拖影）
          const target = ev.target?.kind === 'unit' ? ctx.getUnit(ev.target.instanceId) : null
          const base = target?.getWorldPosition(v3()) ?? heroPos
          const tex = target?.faceTexture ?? null
          for (let i = 0; i < (fxEnabled('trails') ? 3 : 0); i += 1) {
            const ghost = ctx.spawnGhost(tex, target?.group.rotation.y ?? 0)
            ghost.setBase({ x: base.x - (i + 1) * 0.42, y: base.y, z: base.z })
            ghost.opacity = 0.8 - i * 0.2
            ghost.fxScale = target ? 1 : 0.6
            ctx.timeline.add({
              duration: 0.55,
              delay: 0.08 * i,
              ease: easeOutCubic,
              onUpdate: (p) => {
                ghost.opacity = (0.8 - i * 0.2) * (1 - p)
                ghost.fxOffset.x = 0.5 * p // 残影向前滑动（插值帧追赶本体）
              },
              onDone: () => ctx.releaseGhost(ghost),
            })
          }
          ctx.particles?.(base, 'drawStreak', 1.8)
          ctx.floatText(offset(base, 0, 1.2), { text: `${skillName} · 帧数 +1`, color: INFO, size: 52 })
          break
        }
        case 'amd': {
          // 开光追：英雄位 → 目标红蓝光束；成败由后续事件承接（成功=伤害/失败=KEYWORD 光追失败）
          const to = ev.target ? (ctx.targetPosition(ev.target) ?? heroPos) : heroPos
          ctx.beamTo?.(offset(heroPos, 0, 0.4), offset(to, 0, 0.4), '#ff2a2a')
          ctx.screenFlash('#ff4038', 0.12, 2.2)
          ctx.floatText(offset(heroPos, 0, 1.0), { text: `${skillName}…`, color: '#ff6a5e', size: 52 })
          break
        }
        case 'intel': {
          // 驱动更新：分段进度条（22%→67%→99%→完成）+ 完成光环
          ctx.progressBarAt?.(heroPos, 0.95)
          ctx.ringAt?.(v3(heroPos.x, 0.4, heroPos.z), INFO, 1.5, 0.7)
          ctx.floatText(offset(heroPos, 0, 1.0), { text: `${skillName} · 抽 1 张`, color: INFO, size: 52 })
          break
        }
        case 'neutral': {
          // 清灰：目标位灰尘扬起 + 小吸尘涡环
          const to = ev.target ? (ctx.targetPosition(ev.target) ?? heroPos) : heroPos
          ctx.particles?.(to, 'dustClean', 1.3)
          ctx.ringAt?.(v3(to.x, to.y - 0.3, to.z), PALE, 1.0, 0.45)
          ctx.floatText(offset(to, 0, 1.0), { text: `${skillName} · 吹走 1 点`, color: PALE, size: 48 })
          break
        }
        case 'apple': {
          // 能效比：绿色能效护盾环 + 上升绿粒子（不发热=散热好）
          ctx.ringAt?.(v3(heroPos.x, 0.4, heroPos.z), HEAL, 2.0, 0.8)
          ctx.ringAt?.(v3(heroPos.x, 0.4, heroPos.z), HEAL, 1.2, 0.5)
          ctx.particles?.(heroPos, 'healMote', 1.5)
          ctx.floatText(offset(heroPos, 0, 1.0), { text: `${skillName} · +2 护甲`, color: HEAL, size: 52 })
          break
        }
        case 'qualcomm': {
          // TOPS 营销：紫色数据迸发 + 连环营销环 + 微震（数字即正义）
          ctx.particles?.(heroPos, 'topsBurst', 1.3)
          ctx.ringAt?.(v3(heroPos.x, 0.4, heroPos.z), '#6f8bff', 1.3, 0.4)
          ctx.ringAt?.(v3(heroPos.x, 0.4, heroPos.z), '#6f8bff', 2.0, 0.6)
          ctx.shakeCamera?.(0.18)
          ctx.floatText(offset(heroPos, 0, 1.0), { text: `${skillName} · TOPS↑`, color: '#8fa2ff', size: 52 })
          break
        }
        case 'arm': {
          // 公版方案：召唤点传送光柱 + 蓝白垂直粒子（参考设计从天而降）
          const land = ctx.boardCenter(ev.playerId)
          ctx.pillarAt?.(v3(land.x, 0, land.z), '#7fd8ff', 0.8)
          ctx.particles?.(v3(land.x, 1.6, land.z), 'teleport', 1.3)
          ctx.ringAt?.(v3(land.x, 0.4, land.z), INFO, 1.4, 0.5)
          ctx.floatText(offset(heroPos, 0, 1.0), { text: `${skillName} · 部署中`, color: INFO, size: 48 })
          break
        }
        default: {
          // 未知技能（mod）：通用蓝闪演出，绝不让技能无演出
          ctx.screenFlash(INFO, 0.16)
          ctx.ringAt?.(v3(heroPos.x, 0.4, heroPos.z), INFO, 1.4, 0.5)
          ctx.floatText(offset(heroPos, 0, 1.0), { text: `技能 ${skillName}`, color: INFO, size: 56 })
        }
      }
    },
  },

  FATIGUE: {
    kind: 'animation',
    play: (ctx, ev) => {
      const hero = ctx.getHero(ev.playerId)
      if (!hero) return
      const pos = hero.getWorldPosition(v3())
      // 疲劳红闪 + 冒烟 + 伤害飘字（CARD_DRAWN(fatigue) 无卡可飞，全部演出在此）
      ctx.screenFlash(DANGER, 0.22, 1.6)
      ctx.floatText(offset(pos, 0, 0.9), { text: `疲劳 -${ev.damage}`, color: DANGER, size: 72 })
      ctx.smokeAt(pos, 6)
      ctx.particles?.(offset(pos, 0, 0.3), 'ember', 0.9)
    },
  },

  BURN_OUT: {
    kind: 'animation',
    play: (ctx, ev) => {
      // 跳闸：黄色两连闪屏 + 三道折线电弧 + 镜头微震 + 锁定提示
      ctx.screenFlash('#ffd23d', 0.7, 1.8)
      ctx.boltBetween?.(v3(-2.6, 2.4, 0.8), v3(-0.8, 0.4, 0.5), '#ffd23d')
      ctx.boltBetween?.(v3(2.6, 2.2, 0.8), v3(0.9, 0.5, 0.5), '#ffd23d')
      ctx.boltBetween?.(v3(0, 2.8, 0.9), v3(0.4, 0.6, 0.6), '#fff2b8')
      ctx.shakeCamera?.(0.5)
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
      // 护甲格挡涟漪 + 上浮护甲粒子
      ctx.ringAt?.(v3(pos.x, 0.4, pos.z), PALE, 1.6, 0.55)
      ctx.particles?.(offset(pos, 0, 0.2), 'armorUp', 1.3)
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
      // 胜负定格：重震 + 染色闪屏；胜方加彩带迸发与金色光柱
      ctx.screenFlash(ev.winner === ctx.viewerId ? '#ffd23d' : '#ff5d4d', 0.4, 1.2)
      ctx.shakeCamera?.(ev.winner === ctx.viewerId ? 0.5 : 0.3)
      if (ev.winner === ctx.viewerId) {
        ctx.particles?.(v3(0, 1.2, 0.8), 'confetti')
        ctx.pillarAt?.(v3(0, 0, 0.8), GOLD, 1.4)
      }
    },
  },
}
