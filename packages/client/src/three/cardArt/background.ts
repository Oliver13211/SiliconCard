/**
 * 卡面背景层绘制（M4-R3D5 第一阶段）—— 纯代码生成，零外部图片资产。
 *
 * 在 SVG 图形层之下铺一层确定性背景，四种元素按 FaceArtParams.bg 选配组合：
 * - diagonal：对角渐变（恒开，底色）——暗色基调 + 派系副色微染；
 * - traces  ：电路走线——种子化直角折线 + 过孔节点；
 * - grid    ：细网格——横竖线场；
 * - noise   ：噪声场——种子化散点。
 *
 * 全部位置/密度经 mulberry32 子种子派生（禁 Math.random/Date），同一张卡恒同图。
 * 依赖 DOM canvas 2D context，只能在浏览器调用，禁止在模块顶层执行。
 */

import { mulberry32, shade, type Palette } from './color'
import type { BgLayers } from './derive'

/** 绘制背景层（铺满 0,0..w,h）。调用方保证 ctx 有效。 */
export function drawFaceBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: BgLayers,
  pal: Palette,
): void {
  if (bg.diagonal) drawDiagonal(ctx, w, h, pal)
  if (bg.traces) drawTraces(ctx, w, h, bg.traceSeed, pal)
  if (bg.grid) drawGrid(ctx, w, h, pal)
  if (bg.noise) drawNoise(ctx, w, h, bg.noiseSeed, pal)
}

/** 对角渐变底：暗色基调 + 副色微染（保持 M1 的深色卡面基调） */
function drawDiagonal(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette): void {
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, shade(pal.secondary, 0.5))
  g.addColorStop(0.45, '#101418')
  g.addColorStop(1, '#05070a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/** 电路走线：左侧起点的直角折线束 + 过孔（种子化，低透明度不抢主体） */
function drawTraces(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  pal: Palette,
): void {
  const rng = mulberry32(seed)
  const count = 7 + Math.floor(rng() * 5) // 7..11 条
  ctx.save()
  ctx.strokeStyle = pal.primary
  ctx.globalAlpha = 0.13
  ctx.lineWidth = 2
  ctx.lineJoin = 'miter'
  for (let i = 0; i < count; i += 1) {
    let x = -6
    let y = 24 + rng() * (h - 48)
    ctx.beginPath()
    ctx.moveTo(x, y)
    const bends = 2 + Math.floor(rng() * 3) // 2..4 段
    for (let b = 0; b < bends; b += 1) {
      x += w * (0.18 + rng() * 0.24)
      ctx.lineTo(x, y)
      const dy = (rng() * 2 - 1) * h * 0.16
      y = Math.max(16, Math.min(h - 16, y + dy))
      ctx.lineTo(x, y)
    }
    ctx.lineTo(w + 6, y)
    ctx.stroke()
    // 过孔：折点小方 + 端点圆
    ctx.globalAlpha = 0.22
    ctx.fillStyle = pal.accent
    ctx.fillRect(x - 3, y - 3, 6, 6)
    ctx.beginPath()
    ctx.arc(x, y, 4.5, 0, Math.PI * 2)
    ctx.strokeStyle = pal.accent
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.globalAlpha = 0.13
    ctx.strokeStyle = pal.primary
    ctx.lineWidth = 2
  }
  ctx.restore()
}

/** 细网格：32px 横竖线场，每 4 格加重一道（低透明度） */
function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette): void {
  ctx.save()
  ctx.strokeStyle = pal.primary
  ctx.lineWidth = 1
  for (let x = 32; x < w; x += 32) {
    ctx.globalAlpha = (x / 32) % 4 === 0 ? 0.085 : 0.045
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let y = 32; y < h; y += 32) {
    ctx.globalAlpha = (y / 32) % 4 === 0 ? 0.085 : 0.045
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  ctx.restore()
}

/** 噪声场：种子化散点（白/点缀色混合，模拟传感器噪点） */
function drawNoise(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  pal: Palette,
): void {
  const rng = mulberry32(seed)
  const count = 180 + Math.floor(rng() * 120) // 180..299 粒
  ctx.save()
  for (let i = 0; i < count; i += 1) {
    const x = rng() * w
    const y = rng() * h
    const r = 0.6 + rng() * 1.4
    const accentHit = rng() < 0.12
    ctx.globalAlpha = accentHit ? 0.16 : 0.05 + rng() * 0.05
    ctx.fillStyle = accentHit ? pal.accent : '#ffffff'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
