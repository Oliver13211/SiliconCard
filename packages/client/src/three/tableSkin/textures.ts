/**
 * 牌桌皮肤程序化纹理（tableSkin 绘制层）——零外部图片资产，全部 Canvas 2D 绘制。
 *
 * 纹理清单：
 * - getTableTopCanvas  台面：深色绒布战术区 + PCB 走线金属边框 + 槽位格线/牌堆区/中线徽记
 * - getBackdropCanvas  背景机架墙：雾中机架 + LED 指示灯 + 顶灯柔光
 * - getFloorCanvas     机房地板：防静电地板网格 + 走线 + 螺丝
 * - getSlotGlowCanvas  槽位柔光贴片：软边发光垫（加色混合，材质 color 负责派系染色）
 *
 * 性能与确定性红线：
 * - 每张纹理一次性生成 + 模块级懒缓存（禁每帧重绘）；
 * - 随机性全部来自固定种子 mulberry32（经 cardArt/color 复用），禁 Math.random/Date；
 * - document 守卫：无头环境返回 null（SceneManager 侧回落素色材质，可构造不炸）。
 */

import { mulberry32 } from '../cardArt/color'
import { SKIN_SEED, SKIN_TEXTURE_SIZE, backdropLayoutFor, pileMarksFor, playAreaFor, slotMarksFor, traceLayoutFor } from './params'

type Ctx = CanvasRenderingContext2D

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  return ctx ? { canvas, ctx } : null
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/** 手写圆角矩形路径（不依赖 ctx.roundRect，兼容更老运行时） */
function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 亮度颗粒（原地改写像素；亮度噪声而非彩噪，绒布/金属质感更真实） */
function paintGrain(ctx: Ctx, w: number, h: number, seed: number, amp: number): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const rnd = mulberry32(seed)
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amp
    d[i] = clamp255((d[i] as number) + n)
    d[i + 1] = clamp255((d[i + 1] as number) + n)
    d[i + 2] = clamp255((d[i + 2] as number) + n)
  }
  ctx.putImageData(img, 0, 0)
}

/** 轴对齐 PCB 走线 + 焊盘（低透明度铺底纹样，不抢主体） */
function paintTraces(ctx: Ctx, seed: number, w: number, h: number, count: number, inset: number, line: string, pad: string): void {
  const traces = traceLayoutFor(seed, w, h, count, inset)
  ctx.lineCap = 'round'
  ctx.lineWidth = 2
  ctx.strokeStyle = line
  for (const t of traces) {
    ctx.beginPath()
    ctx.moveTo(t.x1, t.y1)
    ctx.lineTo(t.x2, t.y2)
    ctx.stroke()
    if (t.pad) {
      ctx.beginPath()
      ctx.arc(t.x2, t.y2, 3, 0, Math.PI * 2)
      ctx.fillStyle = pad
      ctx.fill()
    }
  }
}

/** 绒布织纹：两组对角细线（极低透明度，凑近看才有经纬感） */
function paintWeave(ctx: Ctx, w: number, h: number, step: number): void {
  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.014)'
  for (let x = -h; x < w + h; x += step) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + h, h)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.05)'
  for (let x = -h; x < w + h; x += step) {
    ctx.beginPath()
    ctx.moveTo(x + h, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  ctx.restore()
}

/** 径向暗角（中心透明 → 边缘压暗，聚焦牌桌主体） */
function paintVignette(ctx: Ctx, w: number, h: number, innerR: number, outerR: number, alpha: number): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, innerR, w / 2, h / 2, outerR)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, `rgba(0,0,0,${alpha})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

// —— 台面 ——

let tableTopCache: HTMLCanvasElement | null = null

/** 台面纹理：绒布战术区 + PCB 边框 + 槽位/牌堆/中线标记（1024×652，与桌面同纵横比） */
export function getTableTopCanvas(): HTMLCanvasElement | null {
  if (tableTopCache) return tableTopCache
  const w = SKIN_TEXTURE_SIZE.tableTopW
  const h = SKIN_TEXTURE_SIZE.tableTopH
  const made = makeCanvas(w, h)
  if (!made) return null
  const { canvas, ctx } = made

  // 1. 基底：近侧略亮的深灰蓝绒布
  const bg = ctx.createLinearGradient(0, h, 0, 0)
  bg.addColorStop(0, '#11181e')
  bg.addColorStop(1, '#090d12')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  paintWeave(ctx, w, h, 7)

  // 2. 战术区内光池（顶灯落在牌桌中央）
  const pool = ctx.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, h * 0.62)
  pool.addColorStop(0, 'rgba(125,165,195,0.09)')
  pool.addColorStop(1, 'rgba(125,165,195,0)')
  ctx.fillStyle = pool
  ctx.fillRect(0, 0, w, h)

  // 3. PCB 边框区（战术区之外的环形带）：走线 + 焊盘 + 角部螺丝
  const play = playAreaFor(w, h)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  roundRectPath(ctx, play.x, play.y, play.w, play.h, 26)
  ctx.clip('evenodd')
  paintTraces(ctx, SKIN_SEED.tableTop, w, h, 110, 6, 'rgba(66,112,132,0.17)', 'rgba(118,188,208,0.22)')
  // 边框角落的机箱螺丝
  const screws: [number, number][] = [
    [play.x * 0.45, play.y * 0.5],
    [w - play.x * 0.45, play.y * 0.5],
    [play.x * 0.45, h - play.y * 0.5],
    [w - play.x * 0.45, h - play.y * 0.5],
  ]
  for (const [sx, sy] of screws) {
    ctx.beginPath()
    ctx.arc(sx, sy, 9, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(26,32,40,0.9)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(150,170,190,0.25)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(sx - 5, sy)
    ctx.lineTo(sx + 5, sy)
    ctx.stroke()
  }
  ctx.restore()

  // 4. 战术区描边（双线勾边）
  roundRectPath(ctx, play.x, play.y, play.w, play.h, 26)
  ctx.strokeStyle = 'rgba(138,198,232,0.20)'
  ctx.lineWidth = 3
  ctx.stroke()
  roundRectPath(ctx, play.x + 9, play.y + 9, play.w - 18, play.h - 18, 20)
  ctx.strokeStyle = 'rgba(138,198,232,0.09)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // 5. 槽位格线：14 槽圆角框 + 四角 L 形亮角标 + 极淡内填充
  const slots = slotMarksFor(w, h)
  for (const s of slots) {
    roundRectPath(ctx, s.x, s.y, s.w, s.h, 7)
    ctx.fillStyle = 'rgba(92,170,228,0.05)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(150,215,255,0.28)'
    ctx.lineWidth = 2.5
    ctx.stroke()
    const tick = Math.min(s.w, s.h) * 0.2
    ctx.strokeStyle = 'rgba(205,240,255,0.36)'
    ctx.lineWidth = 3
    for (const [cx, cy, dx, dy] of [
      [s.x, s.y, 1, 1],
      [s.x + s.w, s.y, -1, 1],
      [s.x, s.y + s.h, 1, -1],
      [s.x + s.w, s.y + s.h, -1, -1],
    ] as const) {
      ctx.beginPath()
      ctx.moveTo(cx + dx * tick, cy)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx, cy + dy * tick)
      ctx.stroke()
    }
  }

  // 6. 中线（战场地界）+ 中央六角螺母徽记
  ctx.save()
  ctx.strokeStyle = 'rgba(53,208,255,0.20)'
  ctx.lineWidth = 5
  ctx.setLineDash([24, 18])
  ctx.beginPath()
  ctx.moveTo(play.x + 24, h / 2)
  ctx.lineTo(play.x + play.w - 24, h / 2)
  ctx.stroke()
  ctx.restore()
  const hex = (r: number): void => {
    ctx.beginPath()
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 6 + (i * Math.PI) / 3
      const px = w / 2 + Math.cos(a) * r
      const py = h / 2 + Math.sin(a) * r
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(53,208,255,0.15)'
  ctx.lineWidth = 3
  hex(30)
  ctx.strokeStyle = 'rgba(53,208,255,0.10)'
  ctx.lineWidth = 2
  hex(19)

  // 7. 牌堆区：四角对称虚线框 + 角标括号
  const piles = pileMarksFor(w, h)
  ctx.save()
  ctx.setLineDash([10, 8])
  ctx.strokeStyle = 'rgba(168,190,210,0.16)'
  ctx.lineWidth = 2
  for (const p of piles) {
    roundRectPath(ctx, p.x, p.y, p.w, p.h, 9)
    ctx.stroke()
  }
  ctx.restore()

  // 8. 暗角 + 颗粒
  paintVignette(ctx, w, h, h * 0.34, h * 0.94, 0.5)
  paintGrain(ctx, w, h, SKIN_SEED.tableTop ^ 0x9e37, 9)

  tableTopCache = canvas
  return tableTopCache
}

// —— 背景机架墙 ——

let backdropCache: HTMLCanvasElement | null = null

/** 背景机架墙：中亮度中性灰阶绘制（最终明暗/色相由材质 color 派系染色决定） */
export function getBackdropCanvas(): HTMLCanvasElement | null {
  if (backdropCache) return backdropCache
  const w = SKIN_TEXTURE_SIZE.backdropW
  const h = SKIN_TEXTURE_SIZE.backdropH
  const made = makeCanvas(w, h)
  if (!made) return null
  const { canvas, ctx } = made

  // 1. 基底：上亮下暗（顶灯余晖 → 墙脚没入黑暗）
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#8996a5')
  bg.addColorStop(0.55, '#5b6673')
  bg.addColorStop(1, '#39424e')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  const layout = backdropLayoutFor(SKIN_SEED.backdrop, w, h)

  // 2. 竖向柔光（机房顶灯在墙上的余晖）
  for (const s of layout.shafts) {
    const g = ctx.createLinearGradient(s.x - s.w, 0, s.x + s.w, 0)
    g.addColorStop(0, 'rgba(235,245,255,0)')
    g.addColorStop(0.5, `rgba(235,245,255,${s.alpha})`)
    g.addColorStop(1, 'rgba(235,245,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(s.x - s.w, 0, s.w * 2, h)
  }

  // 3. 机架：深色柜体 + 横格栅 + 把手线
  for (const r of layout.racks) {
    ctx.fillStyle = 'rgba(28,34,43,0.62)'
    ctx.fillRect(r.x, r.y, r.w, r.h)
    ctx.strokeStyle = 'rgba(14,18,23,0.7)'
    ctx.lineWidth = 3
    ctx.strokeRect(r.x, r.y, r.w, r.h)
    const unitH = r.h / r.units
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(16,20,26,0.55)'
    for (let u = 1; u < r.units; u += 1) {
      const uy = r.y + unitH * u
      ctx.beginPath()
      ctx.moveTo(r.x + 3, uy)
      ctx.lineTo(r.x + r.w - 3, uy)
      ctx.stroke()
    }
    // 每单位左侧一条微亮「面板缝」
    ctx.strokeStyle = 'rgba(168,182,198,0.16)'
    for (let u = 0; u < r.units; u += 1) {
      const uy = r.y + unitH * (u + 0.72)
      ctx.beginPath()
      ctx.moveTo(r.x + r.w * 0.08, uy)
      ctx.lineTo(r.x + r.w * 0.34, uy)
      ctx.stroke()
    }
  }

  // 4. LED 指示灯：光晕 + 亮核（颜色已烘进纹理，乘算染色后依旧可辨）
  for (const led of layout.leds) {
    const g = ctx.createRadialGradient(led.x, led.y, 0.5, led.x, led.y, 5.5 * led.glow)
    g.addColorStop(0, led.color)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.5 * led.glow
    ctx.fillStyle = g
    ctx.fillRect(led.x - 6, led.y - 6, 12, 12)
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.arc(led.x, led.y, 1.4, 0, Math.PI * 2)
    ctx.fillStyle = led.color
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // 5. 墙脚压暗（与雾中地板衔接）+ 顶部收边
  const fade = ctx.createLinearGradient(0, h * 0.72, 0, h)
  fade.addColorStop(0, 'rgba(5,8,12,0)')
  fade.addColorStop(1, 'rgba(5,8,12,0.92)')
  ctx.fillStyle = fade
  ctx.fillRect(0, h * 0.72, w, h * 0.28)
  paintVignette(ctx, w, h, w * 0.18, w * 0.62, 0.42)

  // 6. 颗粒
  paintGrain(ctx, w, h, SKIN_SEED.backdrop ^ 0x2545, 7)

  backdropCache = canvas
  return backdropCache
}

// —— 机房地板 ——

let floorCache: HTMLCanvasElement | null = null

/** 机房地板：防静电地板网格 + 走线 + 螺丝（中亮度灰阶，材质 color 负责压暗与染色） */
export function getFloorCanvas(): HTMLCanvasElement | null {
  if (floorCache) return floorCache
  const w = SKIN_TEXTURE_SIZE.floorW
  const h = SKIN_TEXTURE_SIZE.floorH
  const made = makeCanvas(w, h)
  if (!made) return null
  const { canvas, ctx } = made

  // 1. 基底
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#87919c')
  bg.addColorStop(1, '#6e7781')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // 2. 地板网格（6×6）+ 单板受光边
  const tiles = 6
  const tw = w / tiles
  for (let i = 0; i <= tiles; i += 1) {
    ctx.strokeStyle = 'rgba(22,27,33,0.55)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(i * tw, 0)
    ctx.lineTo(i * tw, h)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i * tw)
    ctx.lineTo(w, i * tw)
    ctx.stroke()
  }
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  for (let i = 0; i < tiles; i += 1) {
    for (let j = 0; j < tiles; j += 1) {
      ctx.strokeRect(i * tw + 3, j * tw + 3, tw - 6, tw - 6)
    }
  }

  // 3. 板间走线 + 焊盘
  paintTraces(ctx, SKIN_SEED.floor, w, h, 90, 10, 'rgba(70,105,125,0.12)', 'rgba(108,158,182,0.16)')

  // 4. 板角螺丝（网格交点）
  for (let i = 0; i <= tiles; i += 1) {
    for (let j = 0; j <= tiles; j += 1) {
      const x = i * tw
      const y = j * tw
      ctx.beginPath()
      ctx.arc(x, y, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(18,22,27,0.6)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x - 1.4, y - 1.4, 1.6, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(205,215,225,0.22)'
      ctx.fill()
    }
  }

  // 5. 暗角 + 颗粒
  paintVignette(ctx, w, h, w * 0.2, w * 0.72, 0.5)
  paintGrain(ctx, w, h, SKIN_SEED.floor ^ 0x71f3, 8)

  floorCache = canvas
  return floorCache
}

// —— 槽位柔光贴片 ——

let slotGlowCache: HTMLCanvasElement | null = null

/**
 * 槽位柔光：软边发光垫（透明底；叠在槽位加色混合材质上，
 * 光色由材质 color（派系槽位染色）乘算，纹理只负责形状与柔和过渡）。
 */
export function getSlotGlowCanvas(): HTMLCanvasElement | null {
  if (slotGlowCache) return slotGlowCache
  const w = SKIN_TEXTURE_SIZE.slotGlowW
  const h = SKIN_TEXTURE_SIZE.slotGlowH
  const made = makeCanvas(w, h)
  if (!made) return null
  const { canvas, ctx } = made

  const inset = 13
  const r = 12
  // 内填充（上亮下微亮的极淡渐变）
  const fill = ctx.createLinearGradient(0, inset, 0, h - inset)
  fill.addColorStop(0, 'rgba(255,255,255,0.13)')
  fill.addColorStop(1, 'rgba(255,255,255,0.03)')
  roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, r)
  ctx.fillStyle = fill
  ctx.fill()
  // 由外向内的三层柔边 + 一条锐利内线（加色混合下呈「呼吸灯垫」）
  for (const [lw, alpha] of [
    [14, 0.06],
    [7, 0.13],
    [3, 0.3],
    [1.2, 0.55],
  ] as const) {
    roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, r)
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`
    ctx.lineWidth = lw
    ctx.stroke()
  }

  slotGlowCache = canvas
  return slotGlowCache
}
