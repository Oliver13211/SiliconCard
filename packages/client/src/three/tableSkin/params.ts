/**
 * 牌桌皮肤参数派生（tableSkin 纯函数层）——「暗色机房」牌桌背景的确定性参数源。
 *
 * 设计意图（用户需求：代码绘制、好看且有质感的牌桌背景）：
 * 主题走「暗色机房 / 电路霓虹」——台面是深色绒布战术区 + PCB 走线金属边框，
 * 背景是远处雾中的机架墙（LED 指示灯点点），地面为机房防静电地板网格，
 * 空气中漂浮微粒尘埃。全部参数由固定种子（SKIN_SEED）派生，同输入恒同输出。
 *
 * 本模块零 DOM、零 Three 依赖（仅引用 layout 常量数值），可无头单测；
 * Canvas 绘制在 textures.ts，场景装配在 SceneManager.ts，尘埃池在 dust.ts。
 */

import { mulberry32 } from '../cardArt/color'
import { mixHex, type TableThemeColors } from '../fx/theme'
import { BOARD_SLOT_DX, BOARD_Z, PILE, TABLE_D, TABLE_W } from '../layout'

// —— 固定种子：纹理 / 尘埃生成确定性（禁 Math.random / Date 泄入生成结果） ——
export const SKIN_SEED = {
  /** 台面织纹与走线 */
  tableTop: 0x51c0d01,
  /** 背景机架墙布局 */
  backdrop: 0x51c0d02,
  /** 地板走线与颗粒 */
  floor: 0x51c0d03,
  /** 环境尘埃初始分布 */
  dust: 0x51c0d04,
} as const

/** 纹理位图尺寸（一次性生成 + 模块级缓存，禁每帧重绘） */
export const SKIN_TEXTURE_SIZE = {
  /** 台面：与桌面 22×14 同纵横比（槽位/牌堆标记不变形） */
  tableTopW: 1024,
  tableTopH: Math.round((1024 * TABLE_D) / TABLE_W), // 652
  /** 背景机架墙（横向长幅） */
  backdropW: 1024,
  backdropH: 512,
  /** 机房地板（大半被雾吞掉，适度分辨率） */
  floorW: 768,
  floorH: 768,
  /** 槽位柔光贴片 */
  slotGlowW: 128,
  slotGlowH: 176,
} as const

// —— 世界坐标 → 台面画布像素映射（PlaneGeometry 旋转 -π/2：画布上方 = 场地远端） ——

export interface CanvasPoint {
  x: number
  y: number
}

/** 世界 (x, z) → 台面纹理画布像素。画布顶部 = 场地远端（z=-TABLE_D/2），底部 = 近侧。 */
export function worldToCanvas(x: number, z: number, w: number, h: number): CanvasPoint {
  return {
    x: ((x + TABLE_W / 2) / TABLE_W) * w,
    y: ((z + TABLE_D / 2) / TABLE_D) * h,
  }
}

/** 世界尺寸 (沿 x, 沿 z) → 画布像素尺寸（纵横比随台面纹理分辨率缩放） */
export function worldSizeToCanvas(sw: number, sd: number, w: number, h: number): { w: number; h: number } {
  return { w: (sw / TABLE_W) * w, h: (sd / TABLE_D) * h }
}

// —— 台面上的功能标记几何（槽位格线 / 牌堆区） ——

export interface RectMark {
  /** 左上角画布像素坐标 + 尺寸 */
  x: number
  y: number
  w: number
  h: number
}

/** 场上槽位世界尺寸（与 SceneManager 槽位 PlaneGeometry 一致，只读镜像） */
export const SLOT_WORLD = { w: 1.06, d: 1.46 } as const
/** 牌堆区世界尺寸（略大于牌堆薄盒 0.98×1.36） */
export const PILE_WORLD = { w: 1.5, d: 1.9 } as const

/**
 * 14 个场上槽位的台面格线标记（双方各 7 槽，位置由 BOARD_SLOT_DX / BOARD_Z 派生，
 * 布局常量改动时标记自动跟随，无第二份硬编码）。
 */
export function slotMarksFor(w: number, h: number): RectMark[] {
  const size = worldSizeToCanvas(SLOT_WORLD.w, SLOT_WORLD.d, w, h)
  const marks: RectMark[] = []
  for (const z of [BOARD_Z.P1, BOARD_Z.P2]) {
    for (let i = 0; i < 7; i += 1) {
      const c = worldToCanvas((i - 3) * BOARD_SLOT_DX, z, w, h)
      marks.push({ x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h })
    }
  }
  return marks
}

/**
 * 4 个牌堆区标记：PILE 常量只定义视角方的 deck/graveyard（对侧镜像复用），
 * 台面纹理按四角对称绘制（观战双方看到的区域一致）。
 */
export function pileMarksFor(w: number, h: number): RectMark[] {
  const size = worldSizeToCanvas(PILE_WORLD.w, PILE_WORLD.d, w, h)
  const marks: RectMark[] = []
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const c = worldToCanvas(PILE.deck.x * sx, PILE.deck.z * sz, w, h)
      marks.push({ x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h })
    }
  }
  return marks
}

/** 台面战术区（绒布主区）的世界范围：覆盖双方单位排 + 手牌排 + 中央徽记 */
export const PLAY_AREA_WORLD = { halfW: 6.2, halfD: 4.9 } as const

/** 战术区在台面画布上的矩形（左上角 + 尺寸，画布像素；画布顶部 = 远端） */
export function playAreaFor(w: number, h: number): RectMark {
  const tl = worldToCanvas(-PLAY_AREA_WORLD.halfW, -PLAY_AREA_WORLD.halfD, w, h)
  const size = worldSizeToCanvas(PLAY_AREA_WORLD.halfW * 2, PLAY_AREA_WORLD.halfD * 2, w, h)
  return { x: tl.x, y: tl.y, w: size.w, h: size.h }
}

// —— 背景机架墙布局（确定性派生） ——

/** LED 指示灯色板（电路霓虹点缀；饱和度克制，不抢卡牌主体） */
export const LED_PALETTE = ['#35d0ff', '#4ade80', '#ffb14d', '#ff6a4d'] as const

export interface RackSpec {
  /** 画布像素：左上角 + 尺寸 */
  x: number
  y: number
  w: number
  h: number
  /** 机架内单位数（决定横格栅行数） */
  units: number
}

export interface LedSpec {
  x: number
  y: number
  color: string
  /** 亮度/光晕系数 0.5..1 */
  glow: number
}

export interface LightShaftSpec {
  x: number
  w: number
  alpha: number
}

export interface BackdropLayout {
  racks: RackSpec[]
  leds: LedSpec[]
  shafts: LightShaftSpec[]
}

/**
 * 机架墙布局：横向均分网格 + 确定性抖动错位（8 台机架，高度参差），
 * 每单位随机 1..3 颗 LED；另有 3 道竖向柔光（机房顶灯余晖）。
 */
export function backdropLayoutFor(seed: number, w: number, h: number): BackdropLayout {
  const rnd = mulberry32(seed)
  const rackCount = 8
  const margin = w * 0.03
  const cell = (w - margin * 2) / rackCount
  const racks: RackSpec[] = []
  const leds: LedSpec[] = []
  for (let i = 0; i < rackCount; i += 1) {
    const rw = cell * (0.55 + rnd() * 0.25)
    const rh = h * (0.42 + rnd() * 0.3)
    const x = margin + cell * i + (cell - rw) / 2 + (rnd() - 0.5) * cell * 0.1
    const y = h - rh - h * (0.04 + rnd() * 0.1)
    const units = Math.max(4, Math.round(rh / (h * 0.075)))
    racks.push({ x, y, w: rw, h: rh, units })
    for (let u = 0; u < units; u += 1) {
      const ledN = 1 + Math.floor(rnd() * 3)
      for (let k = 0; k < ledN; k += 1) {
        leds.push({
          x: x + rw * (0.12 + rnd() * 0.76),
          y: y + (rh / units) * (u + 0.5),
          color: LED_PALETTE[Math.floor(rnd() * LED_PALETTE.length)] as (typeof LED_PALETTE)[number],
          glow: 0.5 + rnd() * 0.5,
        })
      }
    }
  }
  const shafts: LightShaftSpec[] = []
  for (let i = 0; i < 3; i += 1) {
    shafts.push({
      x: w * (0.18 + 0.64 * (i / 2)) + (rnd() - 0.5) * w * 0.05,
      w: w * (0.08 + rnd() * 0.06),
      alpha: 0.04 + rnd() * 0.04,
    })
  }
  return { racks, leds, shafts }
}

// —— PCB 走线段（台面边框 / 地板共用生成器，不同种子） ——

export interface TraceSpec {
  /** 轴对齐线段（画布像素） */
  x1: number
  y1: number
  x2: number
  y2: number
  /** 末端是否带焊盘圆点 */
  pad: boolean
}

/** 确定性走线段：横竖折线 + 焊盘（count 条，范围钳制在 [inset, size-inset]） */
export function traceLayoutFor(seed: number, w: number, h: number, count: number, inset = 0): TraceSpec[] {
  const rnd = mulberry32(seed)
  const traces: TraceSpec[] = []
  for (let i = 0; i < count; i += 1) {
    const vertical = rnd() > 0.5
    const len = Math.min(w, h) * (0.06 + rnd() * 0.18)
    const x = inset + rnd() * Math.max(1, w - inset * 2)
    const y = inset + rnd() * Math.max(1, h - inset * 2)
    const clamp = (v: number, max: number) => Math.max(inset, Math.min(max - inset, v))
    const x2 = vertical ? x : clamp(x + (rnd() > 0.5 ? len : -len), w)
    const y2 = vertical ? clamp(y + (rnd() > 0.5 ? len : -len), h) : y
    traces.push({ x1: x, y1: y, x2, y2, pad: rnd() > 0.35 })
  }
  return traces
}

// —— 派系染色融合（与 fx/theme.tableThemeFor 共存：纹理亮部 × 材质染色） ——

/**
 * 融合方式：tableSkin 纹理一律画成「中亮度的中性灰阶 + 已烘好的 LED 彩点」，
 * 派系色经材质 color（乘算）上色——SceneManager tick 内 lerp 现有目标色即可，
 * 两侧派系平滑过渡逻辑零改动。中性档（无主题/低配回落）用以下基线。
 */
export const NEUTRAL_WALL_TINT = '#454f5c'
export const NEUTRAL_FLOOR_TINT = '#262e38'

/** 墙面染色强度（向双方派系均色靠拢的比例；墙面横跨全场，两侧对称） */
const WALL_FUSE = 0.35
/** 地板染色强度 */
const FLOOR_FUSE = 0.3

function avgHex(a: string, b: string): string {
  return mixHex(a, b, 0.5)
}

/** 背景机架墙材质染色（纯函数；theme=null → 中性基线） */
export function wallTintFor(theme: TableThemeColors | null): string {
  if (!theme) return NEUTRAL_WALL_TINT
  return mixHex(NEUTRAL_WALL_TINT, avgHex(theme.nearLight, theme.farLight), WALL_FUSE)
}

/** 机房地板材质染色（纯函数；theme=null → 中性基线） */
export function floorTintFor(theme: TableThemeColors | null): string {
  if (!theme) return NEUTRAL_FLOOR_TINT
  return mixHex(NEUTRAL_FLOOR_TINT, avgHex(theme.nearLight, theme.farLight), FLOOR_FUSE)
}

// —— 背景几何常量（SceneManager buildBackdrop 装配用；镜头三机位已验算覆盖） ——

export const BACKDROP_GEOMETRY = {
  /** 机房地板平面（台面之外的延伸，远端没入雾中） */
  floorW: 64,
  floorD: 40,
  floorY: -0.1,
  /** 机架墙平面（z=-11.5 距默认机位约 21.6，落在雾近端内，雾色=派系背景色自动融合） */
  wallW: 64,
  wallH: 11,
  wallY: 4.4,
  wallZ: -11.5,
} as const
