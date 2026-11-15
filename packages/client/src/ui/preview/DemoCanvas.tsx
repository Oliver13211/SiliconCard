/**
 * 演示画布（P2-UI2-2，v3）：2D 俯视示意——小尺寸 canvas 绘制双方英雄块 + 场地槽位，
 * 按「开局 → 预铺演出段（preludeEvents：双方 GT 1030 落场、P2 预铺卡攻击 P1 英雄
 * 破潜行）→ 打出目标卡批次（playEvents）」的时间线播放：MINION_SUMMONED 卡片落到
 * 槽位、DAMAGE_DEALT 伤害数字飘出、HEALING 绿字上浮、护甲/跳闸/关键词等按事件
 * type 简化示意；供电曲线经 TURN_START 事件逐步推进。
 *
 * 表现边界：
 * - 动效只经 requestAnimationFrame + 简易补间（禁引动画库），整轮 ≈3-5s 循环，
 *   支持 暂停/重播；
 * - prefers-reduced-motion 时不跑 rAF，静态展示终态 + 步骤文字列表；
 * - 颜色经 getComputedStyle 读 tokens.css 既有令牌（.sc-app 作用域，带同值兜底；
 *   派系色优先读 --sc-faction-<id>，令牌未覆盖的派系回退同源字面量表）；
 * - 模型只由引擎事件流 + 快照推导（展示用投影，不自维护对局事实；单位目标
 *   一律按事件载荷的 instanceId 精确对位）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getCardDefinition, type GameEvent } from '@siliconcard/core'
import type { DemoTimeline } from './demoDriver'

// —— 模型（事件流 + 快照的展示投影，纯函数推导） ——

type FloatTone = 'damage' | 'heal' | 'armor' | 'burn' | 'keyword' | 'info'

interface FloatSpec {
  /** 所在步骤（1..N）；0 为开局段 */
  step: number
  text: string
  tone: FloatTone
  /** 目标：英雄（按玩家）或场上单位（按 actor 下标）；都为 null 时不画 */
  hero: 'P1' | 'P2' | null
  unitIndex: number | null
}

interface UnitActor {
  instanceId: string
  cardId: string
  ownerId: 'P1' | 'P2'
  attack: number
  maxHealth: number
  keywords: string[]
  /** 扩展槽位（该方累计召唤序，死亡留空位不重排） */
  slot: number
  /** 入场步骤（-1 = 开局已在场，沙箱脚本下不出现，防御性保留） */
  spawnStep: number
  /** 死亡步骤（null = 存活） */
  deathStep: number | null
  /** 血量轨迹：hpPre[i]/hpPost[i] = 第 i 步开始/结算后的血量 */
  hpPre: number[]
  hpPost: number[]
  hitSteps: Set<number>
  healSteps: Set<number>
}

interface HeroTrack {
  label: string
  faction: string
  hpPre: number[]
  hpPost: number[]
  armorPre: number[]
  armorPost: number[]
  manaPre: number[]
  manaPost: number[]
  /** 供电上限轨迹（TURN_START 逐步推进；v3 预铺演出段横跨多个回合） */
  manaMaxPre: number[]
  manaMaxPost: number[]
  hitSteps: Set<number>
  healSteps: Set<number>
  armorSteps: Set<number>
  burnSteps: Set<number>
}

interface StepMeta {
  event: GameEvent | null
  label: string
  durationMs: number
}

interface DemoModel {
  steps: readonly StepMeta[]
  units: readonly UnitActor[]
  p1: HeroTrack
  p2: HeroTrack
  floats: readonly FloatSpec[]
  endStep: number | null
  endText: string | null
}

const OPENING_MS = 700
const TAIL_HOLD_MS = 1000

/** 主步骤时长（目标卡批次） */
const STEP_DURATIONS: Record<GameEvent['type'], number> = {
  GAME_START: 300,
  TURN_START: 200,
  TURN_END: 200,
  CARD_DRAWN: 180,
  CARD_PLAYED: 850,
  CARD_BURNED: 300,
  MINION_SUMMONED: 750,
  MINION_DIED: 650,
  ATTACK_DECLARED: 500,
  DAMAGE_DEALT: 800,
  HEALING: 700,
  KEYWORD_TRIGGERED: 750,
  HERO_POWER_USED: 500,
  FATIGUE: 400,
  BURN_OUT: 750,
  ARMOR_GAINED: 650,
  GAME_END: 900,
}

/**
 * 预铺演出段节奏：压缩时长保持整轮紧凑（TURN_START 仅作供电推进过场；
 * ATTACK_DECLARED/DAMAGE_DEALT 构成 P2 预铺卡攻击 P1 英雄的演出）。
 */
const PRELUDE_DURATIONS: Partial<Record<GameEvent['type'], number>> = {
  CARD_PLAYED: 500,
  MINION_SUMMONED: 450,
  ATTACK_DECLARED: 300,
  DAMAGE_DEALT: 550,
  HEALING: 450,
  KEYWORD_TRIGGERED: 450,
  ARMOR_GAINED: 400,
  BURN_OUT: 450,
  TURN_START: 100,
}

function preludeDuration(event: GameEvent): number {
  return PRELUDE_DURATIONS[event.type] ?? 150
}

const KEYWORD_GLYPHS: Record<string, string> = {
  taunt: '嘲',
  divine_shield: '盾',
  charge: '超',
  windfury: '双',
  deathrattle: '亡',
  stealth: '隐',
  overload: '闸',
}

function nameOf(cardId: string): string {
  return getCardDefinition(cardId)?.name ?? cardId
}

function describeHero(playerId: 'P1' | 'P2'): string {
  return playerId === 'P1' ? '演示位 CPU' : '对面 CPU'
}

function stepLabel(event: GameEvent, unitName: (instanceId: string) => string): string {
  switch (event.type) {
    case 'CARD_PLAYED':
      return `打出「${nameOf(event.cardId)}」（${event.cost}W）`
    case 'CARD_DRAWN':
      return event.source === 'fatigue' ? '牌库空转（疲劳）' : '抽 1 张牌'
    case 'CARD_BURNED':
      return `手牌爆仓，「${nameOf(event.cardId)}」被烧掉`
    case 'MINION_SUMMONED':
      return event.source === 'effect'
        ? `效果召唤：「${nameOf(event.unit.cardId)}」落到扩展槽`
        : `「${nameOf(event.unit.cardId)}」入场（扩展槽）`
    case 'MINION_DIED':
      return `「${nameOf(event.unit.cardId)}」冒烟下岗`
    case 'ATTACK_DECLARED':
      return `「${nameOf(unitName(event.attackerId))}」发起攻击`
    case 'DAMAGE_DEALT': {
      const who = event.target.kind === 'hero' ? describeHero(event.target.playerId) : `「${nameOf(unitName(event.target.instanceId))}」`
      return `${who}受到 ${event.amount} 点伤害${event.armorAbsorbed ? `（护甲吸收 ${event.armorAbsorbed}）` : ''}`
    }
    case 'HEALING': {
      const who = event.target.kind === 'hero' ? describeHero(event.target.playerId) : `「${nameOf(unitName(event.target.instanceId))}」`
      return `${who}回血 ${event.amount} 点`
    }
    case 'KEYWORD_TRIGGERED':
      return event.detail === '光追失败' ? '开光追失败：机器当场跳闸，无事发生' : `关键词生效：${event.detail}`
    case 'HERO_POWER_USED':
      return '派系技能发动'
    case 'FATIGUE':
      return `疲劳伤害 ${event.damage} 点`
    case 'BURN_OUT':
      return `跳闸！下回合 ${event.lockedMana}W 功耗被锁`
    case 'ARMOR_GAINED':
      return `护甲 +${event.amount}`
    case 'GAME_END':
      return event.winner ? `${describeHero(event.winner)} 赢下演示局` : '平局'
    default:
      return '结算中'
  }
}

function heroTrackOf(playerId: 'P1' | 'P2', model: DemoModel): HeroTrack {
  return playerId === 'P1' ? model.p1 : model.p2
}

function makeHeroTrack(
  label: string,
  faction: string,
  health: number,
  armor: number,
  mana: number,
  maxMana: number,
  stepCount: number,
): HeroTrack {
  const size = stepCount + 1
  return {
    label,
    faction,
    hpPre: Array<number>(size).fill(health),
    hpPost: Array<number>(size).fill(health),
    armorPre: Array<number>(size).fill(armor),
    armorPost: Array<number>(size).fill(armor),
    manaPre: Array<number>(size).fill(mana),
    manaPost: Array<number>(size).fill(mana),
    manaMaxPre: Array<number>(size).fill(maxMana),
    manaMaxPost: Array<number>(size).fill(maxMana),
    hitSteps: new Set<number>(),
    healSteps: new Set<number>(),
    armorSteps: new Set<number>(),
    burnSteps: new Set<number>(),
  }
}

/** 逐步携带（Pre[i] = Post[i-1]，Post[i] = Pre[i]）：事件只覆写 Post[i] */
function carryHero(track: HeroTrack, i: number): void {
  const hp = track.hpPost[i - 1] ?? 0
  const armor = track.armorPost[i - 1] ?? 0
  const mana = track.manaPost[i - 1] ?? 0
  const manaMax = track.manaMaxPost[i - 1] ?? 0
  track.hpPre[i] = hp
  track.hpPost[i] = hp
  track.armorPre[i] = armor
  track.armorPost[i] = armor
  track.manaPre[i] = mana
  track.manaPost[i] = mana
  track.manaMaxPre[i] = manaMax
  track.manaMaxPost[i] = manaMax
}

function carryUnit(unit: UnitActor, i: number): void {
  const hp = unit.hpPost[i - 1] ?? 0
  unit.hpPre[i] = hp
  unit.hpPost[i] = hp
}

/** 实例 → 卡名映射（先扫全部召唤事件，供步骤文字在召唤前也能解析目标名） */
function unitNameResolver(timeline: DemoTimeline): (instanceId: string) => string {
  const byInstance = new Map<string, string>()
  for (const unit of timeline.before?.board ?? []) byInstance.set(unit.instanceId, unit.cardId)
  for (const event of [...timeline.preludeEvents, ...timeline.playEvents]) {
    if (event.type === 'MINION_SUMMONED') byInstance.set(event.unit.instanceId, event.unit.cardId)
  }
  return (instanceId) => byInstance.get(instanceId) ?? instanceId
}

/** 把时间线编译成带逐步轨迹的展示模型（纯函数；null = 不可自动演示） */
function buildDemoModel(timeline: DemoTimeline): DemoModel | null {
  if (!timeline.playable || !timeline.before) return null
  const before = timeline.before
  const unitName = unitNameResolver(timeline)

  // 步骤序列：开局 → 预铺演出段（P1/P2 落场、P2 预铺卡攻击破潜行）→ 打出目标卡批次
  const steps: StepMeta[] = [{ event: null, label: '开局上电 · 演示位先手', durationMs: OPENING_MS }]
  for (const event of timeline.preludeEvents) {
    steps.push({ event, label: stepLabel(event, unitName), durationMs: preludeDuration(event) })
  }
  for (const event of timeline.playEvents) {
    steps.push({ event, label: stepLabel(event, unitName), durationMs: STEP_DURATIONS[event.type] ?? 300 })
  }
  const stepCount = steps.length - 1

  // 轨迹起点 = 开局快照（满血空场；prelude 演出在其上推进；无快照则退回 before）
  const start = timeline.openingSnapshot ?? before
  const p1 = makeHeroTrack('演示位 P1', start.p1.faction, start.p1.health, start.p1.armor, start.p1.mana, start.p1.maxMana, stepCount)
  const p2 = makeHeroTrack('靶机 P2', start.p2.faction, start.p2.health, start.p2.armor, start.p2.mana, start.p2.maxMana, stepCount)
  const units: UnitActor[] = []
  const floats: FloatSpec[] = []
  const model: DemoModel = { steps, units, p1, p2, floats, endStep: null, endText: null }
  const slotsUsed: Record<'P1' | 'P2', number> = { P1: 0, P2: 0 }

  const spawnActor = (unit: {
    instanceId: string
    cardId: string
    ownerId: string
    attack: number
    health: number
    maxHealth: number
    keywords: readonly string[]
  }, spawnStep: number): UnitActor => {
    const side: 'P1' | 'P2' = unit.ownerId === 'P2' ? 'P2' : 'P1'
    const hpFuture = Array<number>(stepCount + 1).fill(unit.health)
    for (let j = 0; j < spawnStep; j++) hpFuture[j] = 0
    const actor: UnitActor = {
      instanceId: unit.instanceId,
      cardId: unit.cardId,
      ownerId: side,
      attack: unit.attack,
      maxHealth: unit.maxHealth,
      keywords: [...unit.keywords],
      slot: slotsUsed[side],
      spawnStep,
      deathStep: null,
      hpPre: [...hpFuture],
      hpPost: [...hpFuture],
      hitSteps: new Set<number>(),
      healSteps: new Set<number>(),
    }
    slotsUsed[side] += 1
    units.push(actor)
    return actor
  }

  // 开局已在场的单位：v3 时间线的预铺单位经 prelude 演出事件落场（动态生成动画），
  // 仅在无演出段的时间线上按快照静态预置（防御性兼容路径）
  if (timeline.preludeEvents.length === 0) {
    for (const unit of before.board) {
      spawnActor(unit, -1)
    }
  }

  for (let i = 1; i <= stepCount; i++) {
    const event = steps[i]?.event
    if (!event) continue
    // 1. 携带：全部轨迹进入第 i 步
    carryHero(p1, i)
    carryHero(p2, i)
    for (const unit of units) carryUnit(unit, i)

    // 2. 按事件类型覆写 Post[i]（纯展示投影，数值全部取自事件载荷）
    switch (event.type) {
      case 'TURN_START': {
        // 供电曲线推进（display 近似：mana = maxMana；BURN_OUT 锁定不在演示时间线内出现）
        const track = heroTrackOf(event.playerId, model)
        track.manaPre[i] = event.maxMana
        track.manaPost[i] = event.maxMana
        track.manaMaxPre[i] = event.maxMana
        track.manaMaxPost[i] = event.maxMana
        break
      }
      case 'CARD_PLAYED': {
        if ('playerId' in event) {
          const track = heroTrackOf(event.playerId, model)
          track.manaPost[i] = Math.max(0, (track.manaPost[i] ?? 0) - event.cost)
        }
        break
      }
      case 'MINION_SUMMONED': {
        spawnActor(event.unit, i)
        break
      }
      case 'MINION_DIED': {
        const unit = units.find((candidate) => candidate.instanceId === event.unit.instanceId)
        if (unit && unit.deathStep === null) {
          unit.deathStep = i
          unit.hpPost[i] = 0
        }
        break
      }
      case 'DAMAGE_DEALT': {
        const targetRef = event.target
        if (targetRef.kind === 'hero') {
          const track = heroTrackOf(targetRef.playerId, model)
          track.hpPost[i] = event.remainingHealth
          if (event.armorAbsorbed) {
            track.armorPost[i] = Math.max(0, (track.armorPost[i] ?? 0) - event.armorAbsorbed)
          }
          if (!event.shieldConsumed) track.hitSteps.add(i)
          floats.push({
            step: i,
            text: event.shieldConsumed ? '质保挡下' : `-${event.amount}`,
            tone: event.shieldConsumed ? 'keyword' : 'damage',
            hero: targetRef.playerId,
            unitIndex: null,
          })
        } else {
          const index = units.findIndex((candidate) => candidate.instanceId === targetRef.instanceId)
          if (index >= 0) {
            const unit = units[index] as UnitActor
            unit.hpPost[i] = event.remainingHealth
            unit.hitSteps.add(i)
            floats.push({ step: i, text: `-${event.amount}`, tone: 'damage', hero: null, unitIndex: index })
          }
        }
        break
      }
      case 'HEALING': {
        const targetRef = event.target
        if (targetRef.kind === 'hero') {
          const track = heroTrackOf(targetRef.playerId, model)
          track.hpPost[i] = event.resultingHealth
          track.healSteps.add(i)
          floats.push({ step: i, text: `+${event.amount}`, tone: 'heal', hero: targetRef.playerId, unitIndex: null })
        } else {
          const index = units.findIndex((candidate) => candidate.instanceId === targetRef.instanceId)
          if (index >= 0) {
            const unit = units[index] as UnitActor
            unit.hpPost[i] = event.resultingHealth
            unit.healSteps.add(i)
            floats.push({ step: i, text: `+${event.amount}`, tone: 'heal', hero: null, unitIndex: index })
          }
        }
        break
      }
      case 'ARMOR_GAINED': {
        const track = heroTrackOf(event.playerId, model)
        track.armorPost[i] = event.totalArmor
        track.armorSteps.add(i)
        floats.push({ step: i, text: `甲 +${event.amount}`, tone: 'armor', hero: event.playerId, unitIndex: null })
        break
      }
      case 'BURN_OUT': {
        const track = heroTrackOf(event.playerId, model)
        track.burnSteps.add(i)
        floats.push({ step: i, text: `跳闸 ${event.lockedMana}W`, tone: 'burn', hero: event.playerId, unitIndex: null })
        break
      }
      case 'KEYWORD_TRIGGERED': {
        const detail = event.detail.length > 10 ? `${event.detail.slice(0, 10)}…` : event.detail
        const index = units.findIndex((candidate) => candidate.instanceId === event.instanceId)
        floats.push({
          step: i,
          text: detail,
          tone: 'keyword',
          hero: null,
          unitIndex: index >= 0 ? index : null,
        })
        break
      }
      case 'GAME_END': {
        model.endStep = i
        model.endText = event.winner ? `${describeHero(event.winner)} 赢下演示局` : '平局——同时烧机'
        break
      }
      default:
        break // CARD_DRAWN 等无场上投影：仅占短步骤与文字标签
    }
  }

  return model
}

// —— 几何与补间 ——

const LOGICAL_W = 360
const LOGICAL_H = 224
const SLOTS = 7
const SLOT_W = 42
const SLOT_H = 46
const SLOT_GAP = 4
const SLOT_X0 = (LOGICAL_W - (SLOTS * SLOT_W + (SLOTS - 1) * SLOT_GAP)) / 2
const ROW_Y: Record<'P1' | 'P2', number> = { P2: 50, P1: 114 }
const HERO_W = 156
const HERO_H = 34
const HERO_Y: Record<'P1' | 'P2', number> = { P2: 8, P1: 168 }
const DIVIDER_Y = 106

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
const easeOutBack = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t))
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(clamped - 1, 3) + c1 * Math.pow(clamped - 1, 2)
}

// —— 画布颜色（tokens.css 既有令牌，兜底为同值字面量） ——

interface DemoColors {
  text: string
  dim: string
  accent: string
  danger: string
  mana: string
  gold: string
  panel: string
  line: string
  lineStrong: string
  backdrop: string
  faction: (faction: string) => string
}

const FACTION_FALLBACK: Record<string, string> = {
  nvidia: '#86d322',
  amd: '#ff5f54',
  intel: '#3f95ff',
  neutral: '#9aa5b8',
  apple: '#e8e8ed',
  qualcomm: '#325dc8',
  arm: '#0091bd',
}

function readColors(): DemoColors {
  const scope = typeof document !== 'undefined' ? (document.querySelector('.sc-app') ?? document.documentElement) : null
  const cs = scope ? getComputedStyle(scope) : null
  const token = (name: string, fallback: string): string => cs?.getPropertyValue(name).trim() || fallback
  return {
    text: token('--sc-text', '#dce4f2'),
    dim: token('--sc-dim', '#8d97ad'),
    accent: token('--sc-accent', '#58e6a8'),
    danger: token('--sc-danger', '#ff6b5e'),
    mana: token('--sc-mana', '#4da3ff'),
    gold: token('--sc-gold', '#ffc857'),
    panel: token('--sc-panel-solid', '#12161f'),
    line: token('--sc-line', 'rgba(150, 166, 197, 0.14)'),
    lineStrong: token('--sc-line-strong', 'rgba(150, 166, 197, 0.3)'),
    backdrop: token('--sc-bg', '#0a0d13'),
    faction: (faction: string) => token(`--sc-faction-${faction}`, FACTION_FALLBACK[faction] ?? '#9aa5b8'),
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function slotRect(side: 'P1' | 'P2', slot: number): { x: number; y: number } {
  const clamped = Math.min(Math.max(slot, 0), SLOTS - 1)
  return { x: SLOT_X0 + clamped * (SLOT_W + SLOT_GAP), y: ROW_Y[side] }
}

function heroRect(side: 'P1' | 'P2'): { x: number; y: number; w: number; h: number } {
  return { x: (LOGICAL_W - HERO_W) / 2, y: HERO_Y[side], w: HERO_W, h: HERO_H }
}

function truncated(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 步骤中间的血量显示：前半段显示步骤前值，后半段显示结算后值（配飘字表意） */
function stepValue(pre: readonly number[], post: readonly number[], stepIdx: number, p: number): number {
  if (stepIdx <= 0) return pre[0] ?? 0
  return p < 0.5 ? (pre[stepIdx] ?? 0) : (post[stepIdx] ?? 0)
}

function drawUnit(
  ctx: CanvasRenderingContext2D,
  unit: UnitActor,
  colors: DemoColors,
  opts: { alpha: number; scale: number; hp: number; flash: 'damage' | 'heal' | null; flashAlpha: number },
): void {
  const { x, y } = slotRect(unit.ownerId, unit.slot)
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, opts.alpha))
  ctx.translate(x + SLOT_W / 2, y + SLOT_H / 2)
  ctx.scale(opts.scale, opts.scale)
  ctx.translate(-(x + SLOT_W / 2), -(y + SLOT_H / 2))

  roundRect(ctx, x, y, SLOT_W, SLOT_H, 6)
  ctx.fillStyle = colors.panel
  ctx.fill()
  ctx.strokeStyle = opts.flash === 'damage' ? colors.danger : opts.flash === 'heal' ? colors.accent : colors.lineStrong
  ctx.lineWidth = 1
  ctx.stroke()

  if (opts.flash) {
    ctx.save()
    ctx.globalAlpha = opts.flashAlpha * 0.45
    ctx.fillStyle = opts.flash === 'damage' ? colors.danger : colors.accent
    roundRect(ctx, x, y, SLOT_W, SLOT_H, 6)
    ctx.fill()
    ctx.restore()
  }

  ctx.fillStyle = colors.text
  ctx.font = '9px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(truncated(nameOf(unit.cardId), 7), x + SLOT_W / 2, y + 5)
  if (unit.keywords.length > 0) {
    ctx.fillStyle = colors.dim
    ctx.font = '8px sans-serif'
    ctx.fillText(unit.keywords.slice(0, 3).map((k) => KEYWORD_GLYPHS[k] ?? '').join(' '), x + SLOT_W / 2, y + 17)
  }
  ctx.font = 'bold 13px sans-serif'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = colors.gold
  ctx.textAlign = 'left'
  ctx.fillText(String(unit.attack), x + 5, y + SLOT_H - 4)
  ctx.fillStyle = opts.hp < unit.maxHealth ? colors.danger : colors.accent
  ctx.textAlign = 'right'
  ctx.fillText(String(opts.hp), x + SLOT_W - 5, y + SLOT_H - 4)
  ctx.restore()
}

function drawHero(
  ctx: CanvasRenderingContext2D,
  side: 'P1' | 'P2',
  track: HeroTrack,
  stepIdx: number,
  rawP: number,
  colors: DemoColors,
): void {
  const p = easeOutCubic(rawP)
  const { x, y, w, h } = heroRect(side)
  const hp = stepValue(track.hpPre, track.hpPost, stepIdx, p)
  const armor = stepValue(track.armorPre, track.armorPost, stepIdx, p)
  const mana = stepIdx <= 0 ? (track.manaPre[0] ?? 0) : (track.manaPost[stepIdx] ?? 0)
  const maxMana = stepIdx <= 0 ? (track.manaMaxPre[0] ?? 0) : (track.manaMaxPost[stepIdx] ?? 0)

  roundRect(ctx, x, y, w, h, 8)
  ctx.fillStyle = colors.panel
  ctx.fill()
  ctx.strokeStyle = colors.faction(track.faction)
  ctx.lineWidth = 2
  ctx.stroke()

  // 受击红晕 / 回血绿晕 / 护甲蓝晕 / 跳闸黄晕（当前步内渐隐）
  let flashColor: string | null = null
  if (track.hitSteps.has(stepIdx)) flashColor = colors.danger
  else if (track.healSteps.has(stepIdx)) flashColor = colors.accent
  else if (track.armorSteps.has(stepIdx)) flashColor = colors.mana
  else if (track.burnSteps.has(stepIdx)) flashColor = colors.gold
  if (flashColor && stepIdx > 0) {
    ctx.save()
    ctx.globalAlpha = 0.6 * (1 - p)
    ctx.strokeStyle = flashColor
    ctx.lineWidth = 4
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 10)
    ctx.stroke()
    ctx.restore()
  }

  // 左侧：名称（上）+ 护甲（下）；右侧两行：HP 数值（上）/ 供电（下）——避免横向挤压重叠
  ctx.textBaseline = 'middle'
  ctx.fillStyle = colors.dim
  ctx.font = '10px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(track.label, x + 10, y + 11)

  ctx.textAlign = 'right'
  ctx.font = 'bold 14px sans-serif'
  const hpText = String(hp)
  const hpWidth = ctx.measureText(hpText).width
  ctx.fillStyle = hp > 0 && hp < 15 ? colors.danger : colors.text
  ctx.fillText(hpText, x + w - 8, y + 11)
  ctx.font = '8px sans-serif'
  ctx.fillStyle = colors.dim
  ctx.fillText('HP', x + w - 8 - hpWidth - 4, y + 11)

  if (armor > 0) {
    ctx.textAlign = 'left'
    ctx.fillStyle = colors.mana
    ctx.font = 'bold 11px sans-serif'
    ctx.fillText(`甲${armor}`, x + 10, y + h - 9)
  }

  ctx.textAlign = 'right'
  ctx.fillStyle = colors.mana
  ctx.font = 'bold 10px sans-serif'
  ctx.fillText(`${mana}/${maxMana}W`, x + w - 8, y + h - 9)
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  model: DemoModel,
  stepIdx: number,
  rawP: number,
  colors: DemoColors,
): void {
  const p = easeOutCubic(rawP)
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H)
  ctx.fillStyle = colors.backdrop
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H)

  // 场地槽位 + 中线
  ctx.strokeStyle = colors.line
  ctx.lineWidth = 1
  for (const side of ['P2', 'P1'] as const) {
    for (let slot = 0; slot < SLOTS; slot++) {
      const { x, y } = slotRect(side, slot)
      roundRect(ctx, x, y, SLOT_W, SLOT_H, 6)
      ctx.stroke()
    }
  }
  ctx.save()
  ctx.setLineDash([4, 5])
  ctx.beginPath()
  ctx.moveTo(12, DIVIDER_Y)
  ctx.lineTo(LOGICAL_W - 12, DIVIDER_Y)
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = colors.dim
  ctx.font = '8px "PingFang SC", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText('对面场地', 12, ROW_Y.P2 - 2)
  ctx.fillText('我方场地', 12, ROW_Y.P1 - 2)

  // 召唤光柱（当前步召唤的单位，随进度收束）
  for (const unit of model.units) {
    if (unit.spawnStep === stepIdx && stepIdx > 0) {
      const { x, y } = slotRect(unit.ownerId, unit.slot)
      const gradient = ctx.createLinearGradient(0, y - 34, 0, y + SLOT_H)
      gradient.addColorStop(0, 'rgba(88, 230, 168, 0)')
      gradient.addColorStop(0.7, colors.accent)
      gradient.addColorStop(1, colors.accent)
      ctx.save()
      ctx.globalAlpha = 0.45 * (1 - p)
      ctx.fillStyle = gradient
      ctx.fillRect(x + 6, y - 34, SLOT_W - 12, SLOT_H + 34)
      ctx.restore()
    }
  }

  // 单位（入场缩放落位 / 死亡淡出）
  for (const unit of model.units) {
    if (unit.spawnStep > stepIdx) continue
    if (unit.deathStep !== null && stepIdx > unit.deathStep) continue
    let alpha = 1
    let scale = 1
    if (unit.spawnStep === stepIdx && stepIdx > 0) {
      alpha = p
      scale = 0.4 + 0.6 * easeOutBack(rawP)
    } else if (unit.deathStep === stepIdx) {
      alpha = 1 - p
    }
    const hp = stepValue(unit.hpPre, unit.hpPost, stepIdx, p)
    const flash = unit.hitSteps.has(stepIdx) ? 'damage' : unit.healSteps.has(stepIdx) ? 'heal' : null
    drawUnit(ctx, unit, colors, { alpha, scale, hp, flash, flashAlpha: 1 - p })
  }

  // 英雄块
  drawHero(ctx, 'P1', model.p1, stepIdx, rawP, colors)
  drawHero(ctx, 'P2', model.p2, stepIdx, rawP, colors)

  // 飘字（当前步：上浮渐隐）
  for (const float of model.floats) {
    if (float.step !== stepIdx || stepIdx === 0) continue
    let fx: number
    let fy: number
    if (float.hero) {
      const rect = heroRect(float.hero)
      fx = rect.x + rect.w / 2
      fy = rect.y - 6
    } else if (float.unitIndex !== null) {
      const unit = model.units[float.unitIndex]
      if (!unit) continue
      const rect = slotRect(unit.ownerId, unit.slot)
      fx = rect.x + SLOT_W / 2
      fy = rect.y - 6
    } else {
      continue
    }
    const toneColor: Record<FloatTone, string> = {
      damage: colors.danger,
      heal: colors.accent,
      armor: colors.mana,
      burn: colors.gold,
      keyword: colors.text,
      info: colors.dim,
    }
    ctx.save()
    ctx.globalAlpha = p < 0.75 ? 1 : (1 - p) / 0.25
    ctx.font = 'bold 14px "PingFang SC", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    const offsetY = -22 * p
    ctx.lineWidth = 3
    ctx.strokeStyle = colors.backdrop
    ctx.strokeText(float.text, fx, fy + offsetY)
    ctx.fillStyle = toneColor[float.tone]
    ctx.fillText(float.text, fx, fy + offsetY)
    ctx.restore()
  }

  // 当前步骤文字（可读性底线）
  const label = model.steps[stepIdx]?.label ?? ''
  ctx.fillStyle = colors.dim
  ctx.font = '11px "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText(label, LOGICAL_W / 2, LOGICAL_H - 4)

  // 终局横幅
  if (model.endStep === stepIdx && model.endText) {
    ctx.save()
    ctx.globalAlpha = p < 0.85 ? 1 : (1 - p) / 0.15
    ctx.fillStyle = 'rgba(10, 13, 19, 0.82)'
    ctx.fillRect(0, LOGICAL_H / 2 - 22, LOGICAL_W, 40)
    ctx.fillStyle = colors.accent
    ctx.font = 'bold 16px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(model.endText, LOGICAL_W / 2, LOGICAL_H / 2 - 2)
    ctx.restore()
  }
}

/** 时间轴定位：elapsed → 步骤下标与局部进度（尾部停顿计入循环总长） */
function locate(model: DemoModel, elapsed: number): { index: number; progress: number } {
  let acc = 0
  for (let i = 0; i < model.steps.length; i++) {
    const duration = model.steps[i]?.durationMs ?? 0
    if (elapsed < acc + duration) return { index: i, progress: (elapsed - acc) / Math.max(1, duration) }
    acc += duration
  }
  const lastIndex = Math.max(0, model.steps.length - 1)
  return { index: lastIndex, progress: 1 }
}

function totalDuration(model: DemoModel): number {
  return model.steps.reduce((sum, step) => sum + step.durationMs, 0) + TAIL_HOLD_MS
}

/** DPR 感知背衬层尺寸：按容器宽缩放，逻辑坐标恒为 LOGICAL_W×LOGICAL_H */
function backingStore(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const cssW = canvas.clientWidth || LOGICAL_W
  const dpr = window.devicePixelRatio || 1
  const pixelW = Math.max(1, Math.round(cssW * dpr))
  if (canvas.width !== pixelW) {
    canvas.width = pixelW
    canvas.height = Math.max(1, Math.round(cssW * (LOGICAL_H / LOGICAL_W) * dpr))
  }
  const scale = pixelW / LOGICAL_W
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return ctx
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia !== undefined
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

// —— 组件 ——

export function DemoCanvas({ timeline }: { timeline: DemoTimeline }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const model = useMemo(() => buildDemoModel(timeline), [timeline])
  const [reduced, setReduced] = useState(prefersReducedMotion)
  const [paused, setPaused] = useState(false)
  const [restartTick, setRestartTick] = useState(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const colors = useMemo(readColors, [])

  // 跟随系统动效偏好切换
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 动画模式：rAF 循环播放（暂停冻结时钟、重播重置时钟）
  useEffect(() => {
    if (reduced || !model) return
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    let elapsed = 0
    let last = performance.now()
    const total = totalDuration(model)
    const frame = (now: number) => {
      // 上限 1s：吸收后台标签页暂停/截图停顿；headless 截图密集时避免时间被截断失真
      const dt = Math.min(1000, now - last)
      last = now
      if (!pausedRef.current) elapsed += dt
      const { index, progress } = locate(model, total > 0 ? elapsed % total : 0)
      const ctx = backingStore(canvas)
      if (ctx) drawScene(ctx, model, index, progress, colors)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [model, reduced, colors, restartTick])

  // 静态模式（prefers-reduced-motion）：终态一帧 + 随容器尺寸重绘
  useEffect(() => {
    if (!reduced || !model) return
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const ctx = backingStore(canvas)
      if (ctx) drawScene(ctx, model, Math.max(0, model.steps.length - 1), 1, colors)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [model, reduced, colors])

  const replay = () => {
    setPaused(false)
    setRestartTick((tick) => tick + 1)
  }

  if (!model) {
    return (
      <div className="sc-preview-unplayable" role="note">
        <p className="sc-preview-unplayable-title">该卡暂不支持自动演示</p>
        <p>{timeline.reason ?? '沙箱脚本无法自动结算该效果'}</p>
      </div>
    )
  }

  const stepLabels = model.steps.map((step, index) => ({ index, label: step.label }))

  return (
    <div className="sc-preview-canvas-block">
      <canvas ref={canvasRef} className="sc-preview-canvas" role="img" aria-label={`效果演示画布：${nameOf(timeline.cardId)}`} />
      {!reduced && (
        <div className="sc-preview-controls">
          <button
            type="button"
            className="sc-btn sc-btn--small"
            aria-pressed={paused}
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? '播放' : '暂停'}
          </button>
          <button type="button" className="sc-btn sc-btn--small" onClick={replay}>
            重播
          </button>
          <span className="sc-preview-controls-note">循环播放 · 简化示意，实际结算以规则引擎为准</span>
        </div>
      )}
      {reduced && (
        <ol className="sc-preview-steps" aria-label="演示步骤">
          {stepLabels.map((step) => (
            <li key={step.index}>{step.label}</li>
          ))}
        </ol>
      )}
    </div>
  )
}
