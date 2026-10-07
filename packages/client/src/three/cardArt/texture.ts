/**
 * 卡面质感层（卡面大改版·需求 2）—— 纯代码生成，零外部图片资源。
 *
 * 在底色分级（ground.faceGround）之上、外框/插画窗/文字之下，铺一层
 * 「看得出来但抢不了戏」的质感：
 * - grain       ：细颗粒纸纹/噪点（明暗双向微点，mulberry32 种子化）；
 * - microTraces ：细线电路纹理点缀（1px 直角短走线 + 过孔，四角短促出现）；
 * - vignette    ：暗角（边缘压暗，白字对比度只增不减）；
 * - innerShadow ：内阴影（贴框四边向内的暗渐变，卡面「沉」进桌面）；
 * - gloss       ：顶部光泽扫过高光条（斜向光带，'lighter' 叠加，随稀有度增亮）；
 * - frameMetal  ：稀有度金属框质感参数（高光/暗缘，主色派生）。
 *
 * 与底色四档分级融合而非覆盖：gloss/vignette/高光强度随 RarityTier 单调上调，
 * 不改动 ground.ts 的渐变停靠语义。确定性铁律：一切参数 = f(palette, tier, seed)
 * 纯函数派生（seed 来自 cardId FNV-1a），禁 Math.random / Date，同卡恒同图。
 *
 * faceTexture 为纯函数可无头测试；drawFaceTexture 依赖 DOM canvas 2D context，
 * 只能在浏览器调用，禁止在模块顶层执行。
 */

import { mulberry32, shade, type Palette } from './color'
import type { RarityTier } from './derive'

/** 质感层完整规格（纯数据，可 JSON 序列化，无头测试断言对象） */
export interface FaceTextureSpec {
  /** 细颗粒纸纹/噪点 */
  grain: { seed: number; count: number; lightAlpha: number; darkAlpha: number; maxSize: number }
  /** 顶部光泽扫过高光条（angle 单位 deg，bandWidth 为卡宽占比） */
  gloss: { y: number; height: number; angle: number; bandWidth: number; alpha: number }
  /** 内阴影（贴框内缩 inset，峰值 alpha） */
  innerShadow: { inset: number; alpha: number }
  /** 暗角（边缘压暗峰值 alpha） */
  vignette: { alpha: number }
  /** 金属框质感：高光色/强度 + 暗缘色/强度（edgeColor = shade(primary, 0.35)） */
  frameMetal: { hiColor: string; hiAlpha: number; edgeColor: string; edgeAlpha: number }
  /** 细线电路纹理点缀 */
  microTraces: { seed: number; count: number; alpha: number; color: string }
}

/** 各稀有度档的质感强度（唯一事实源；调质感只动这里） */
interface TierTexture {
  gloss: number
  vignette: number
  hi: number
  shadow: number
}

const TIER_TEXTURE: Record<RarityTier, TierTexture> = {
  common: { gloss: 0.05, vignette: 0.2, hi: 0.14, shadow: 0.32 },
  rare: { gloss: 0.065, vignette: 0.24, hi: 0.2, shadow: 0.34 },
  epic: { gloss: 0.08, vignette: 0.28, hi: 0.27, shadow: 0.36 },
  legendary: { gloss: 0.1, vignette: 0.33, hi: 0.36, shadow: 0.4 },
}

/** 质感规格派生（纯函数）：同 (pal, tier, seed) 恒同输出 */
export function faceTexture(pal: Palette, tier: RarityTier, seed: number): FaceTextureSpec {
  const t = TIER_TEXTURE[tier] ?? TIER_TEXTURE.common
  return {
    grain: {
      seed: (seed ^ 0x5bd1e995) >>> 0,
      count: 620 + (seed % 180), // 620..799 粒
      lightAlpha: 0.032,
      darkAlpha: 0.05,
      maxSize: 1.1,
    },
    gloss: {
      y: 84,
      height: 170,
      angle: -8 - (seed % 9), // -8..-16 deg，确定性斜向
      bandWidth: 0.56,
      alpha: t.gloss,
    },
    innerShadow: { inset: 22, alpha: t.shadow },
    vignette: { alpha: t.vignette },
    frameMetal: {
      hiColor: '#ffffff',
      hiAlpha: t.hi,
      edgeColor: shade(pal.primary, 0.35),
      edgeAlpha: 0.9,
    },
    microTraces: {
      seed: (seed ^ 0x85ebca6b) >>> 0,
      count: 4 + (seed % 3), // 4..6 条
      alpha: 0.08,
      color: pal.primary,
    },
  }
}

/** 绘制质感层（铺满 0,0..w,h；调用方保证 ctx 有效）。顺序：微走线 → 纸纹 → 暗角 → 内阴影 → 光泽 */
export function drawFaceTexture(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: FaceTextureSpec,
): void {
  drawMicroTraces(ctx, w, h, spec.microTraces)
  drawGrain(ctx, w, h, spec.grain)
  drawVignette(ctx, w, h, spec.vignette.alpha)
  drawInnerShadow(ctx, w, h, spec.innerShadow)
  drawGloss(ctx, w, h, spec.gloss)
}

/** 细颗粒纸纹：明暗双向 1px 微点（mulberry32 种子化，同卡恒同分布） */
function drawGrain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  grain: FaceTextureSpec['grain'],
): void {
  const rng = mulberry32(grain.seed)
  ctx.save()
  for (let i = 0; i < grain.count; i += 1) {
    const x = rng() * w
    const y = rng() * h
    const s = 0.5 + rng() * grain.maxSize
    const light = rng() < 0.5
    ctx.globalAlpha = light ? grain.lightAlpha : grain.darkAlpha
    ctx.fillStyle = light ? '#ffffff' : '#000000'
    ctx.fillRect(x, y, s, s)
  }
  ctx.restore()
}

/** 细线电路纹理点缀：四角短促 1px 直角走线 + 过孔（低透明度，不与 bg.traces 抢戏） */
function drawMicroTraces(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  traces: FaceTextureSpec['microTraces'],
): void {
  const rng = mulberry32(traces.seed)
  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = traces.color
  for (let i = 0; i < traces.count; i += 1) {
    const corner = i % 4
    const bx = corner % 2 === 0 ? 24 + rng() * 60 : w - 24 - rng() * 60
    const by = corner < 2 ? 24 + rng() * 60 : h - 24 - rng() * 60
    const dx = corner % 2 === 0 ? 1 : -1
    const dy = corner < 2 ? 1 : -1
    const runX = (50 + rng() * 80) * dx
    const runY = (36 + rng() * 60) * dy
    ctx.globalAlpha = traces.alpha
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(bx + runX, by)
    ctx.lineTo(bx + runX, by + runY)
    ctx.stroke()
    // 过孔：折点小圆
    ctx.globalAlpha = traces.alpha * 1.6
    ctx.beginPath()
    ctx.arc(bx + runX, by + runY, 2, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

/** 暗角：中心透明 → 边缘压暗（浅色文字对比度只增不减） */
function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  const rg = ctx.createRadialGradient(w / 2, h * 0.44, Math.min(w, h) * 0.32, w / 2, h * 0.44, Math.max(w, h) * 0.72)
  rg.addColorStop(0, 'rgba(0,0,0,0)')
  rg.addColorStop(1, `rgba(0,0,0,${alpha})`)
  ctx.save()
  ctx.fillStyle = rg
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

/** 内阴影：贴框四边向内的暗渐变（卡面「沉」进桌面） */
function drawInnerShadow(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  shadow: FaceTextureSpec['innerShadow'],
): void {
  const { inset, alpha } = shadow
  const d = 26
  ctx.save()
  roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, 24)
  ctx.clip()
  const edges: [number, number, number, number, CanvasGradient][] = [
    // [x, y, w, h, gradient]：上/下/左/右
    [inset, inset, w - inset * 2, d, grad(ctx, 0, inset, 0, inset + d, alpha)],
    [inset, h - inset - d, w - inset * 2, d, grad(ctx, 0, h - inset, 0, h - inset - d, alpha)],
    [inset, inset, d, h - inset * 2, grad(ctx, inset, 0, inset + d, 0, alpha)],
    [w - inset - d, inset, d, h - inset * 2, grad(ctx, w - inset, 0, w - inset - d, 0, alpha)],
  ]
  for (const [x, y, gw, gh, g] of edges) {
    ctx.fillStyle = g
    ctx.fillRect(x, y, gw, gh)
  }
  ctx.restore()
}

function grad(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  alpha: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1)
  g.addColorStop(0, `rgba(0,0,0,${alpha})`)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  return g
}

/** 顶部光泽扫过高光条：斜向光带（'lighter' 叠加，随稀有度增亮，alpha ≤ 0.1 不抢主体） */
function drawGloss(ctx: CanvasRenderingContext2D, w: number, _h: number, gloss: FaceTextureSpec['gloss']): void {
  ctx.save()
  ctx.translate(w / 2, gloss.y + gloss.height / 2)
  ctx.rotate((gloss.angle * Math.PI) / 180)
  const bw = w * gloss.bandWidth
  const lg = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0)
  lg.addColorStop(0, 'rgba(255,255,255,0)')
  lg.addColorStop(0.5, `rgba(255,255,255,${gloss.alpha})`)
  lg.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = lg
  ctx.fillRect(-bw / 2 - 40, -gloss.height / 2, bw + 80, gloss.height)
  ctx.restore()
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
