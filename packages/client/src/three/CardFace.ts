/**
 * 程序化卡面绘制器（M1-R3D2 建立；M4-R3D5 组合式图形系统；卡面大改版升格 SVG 主视觉）。
 *
 * 分层合成（同一 Canvas 纹理，自底向上）：
 * 1. 背景层（cardArt/background，纯代码）：按稀有度分级的派系底色对角渐变
 *    （cardArt/ground：common 素 → legendary 浓艳+金光）+ 电路走线/网格/噪声场
 *    按 cardId 确定性种子选配组合，按 art.palette 或派系色着色；
 * 2. 质感层（cardArt/texture，纯代码）：细颗粒纸纹/噪点、微线电路点缀、暗角、
 *    内阴影、顶部光泽扫过高光条——与底色分级融合，稀有度越高质感越强；
 * 3. 金属外框与底版层：派系色金属框（暗缘+渐变+顶部高光）、中央插画窗底板
 *    （SVG 主视觉区，竖向占比 ≥40%）、名称/类型/flavor 边框信息带、稀有度宝石；
 * 4. SVG 图形层（cardArt/svg，纯函数组装）：type 形制骨架主视觉 × 派系图案母题 ×
 *    稀有度框饰与插画区稀有度环 × 关键词角标，经 data URI → Image 内联渲染
 *    （禁外部资源/网络请求）；
 * 5. 角标层：费用与攻/血圆徽压在插画窗两角/底部两角（框上层，保持可读性）。
 *
 * 同步/异步协议：drawCardFace 同步产出「背景+质感+底版+角标」的完整可渲染卡面；
 * SVG 图形层由 composeCardFaceArt 异步补绘（懒生成，不卡主线程），完成后调用方
 * 对纹理 flip needsUpdate 即可原地刷新（见 TableRenderer.getFace）。
 *
 * 数据来源：
 * - 美术参数 = CardDefinition.art（shape / palette / glow，content JSON 提供）；
 * - 图形组合参数 = cardArt/derive 派生（cardId FNV-1a 确定性哈希，禁 Math.random/Date）；
 * - 布局锚点 = cardArt/layout（插画窗主视觉 + 边框信息带）；
 * - 数值 = cost（手牌为生效功耗）与 gpu 的 attack/health（场上单位可传当前值）；
 * - 派系色板：art.palette 为十六进制色时直接采用；否则查内置派系色表；
 *   未知名按字符串哈希确定性生成色相（数据驱动扩展：新增派系零改动）。
 *
 * 纯函数（resolvePalette / pickShapeKind / cardFaceCacheKey / hueOf 等）可无头测试；
 * drawCardFace / composeCardFaceArt 依赖 DOM canvas，只能在浏览器调用，禁止在模块顶层执行。
 */

import type { CardDefinition } from '@siliconcard/core'
import * as THREE from 'three'
import { drawFaceBackground } from './cardArt/background'
import { deriveFaceArt, rarityTierOf } from './cardArt/derive'
import {
  ART_WINDOW,
  COST_BADGE,
  FACE_H,
  FACE_W,
  FLAVOR_Y1,
  FLAVOR_Y2,
  GEM,
  NAME_Y,
  RARITY_GEM,
  STAT_R,
  STAT_X_IN,
  STAT_X_OUT,
  STAT_Y,
  TYPE_Y,
} from './cardArt/layout'
import { buildFaceArtSvg, svgToDataUri } from './cardArt/svg'
import { drawFaceTexture, faceTexture } from './cardArt/texture'

// —— 共享纯函数原语（M4-R3D5 迁至 cardArt/color，此处再导出保持既有 API 与测试兼容） ——

export { FACTION_COLORS, fnv1a, hslToHex, hueOf, resolvePalette, shade } from './cardArt/color'
export type { Palette } from './cardArt/color'
/** 画布尺寸常量移至 cardArt/layout（大改版布局锚点唯一事实源），再导出保持既有 API */
export { FACE_W, FACE_H }
import { fnv1a, resolvePalette, shade } from './cardArt/color'

/** 已知几何形体；未知 shape 名确定性映射到一种（数据驱动扩展零改动） */
export type ShapeKind = 'fan' | 'chip' | 'wave' | 'die' | 'connector' | 'mineral'
const SHAPE_KINDS: readonly ShapeKind[] = ['fan', 'chip', 'wave', 'die', 'connector', 'mineral']

export function pickShapeKind(shape: string | undefined): ShapeKind {
  const known = SHAPE_KINDS.find((k) => k === shape)
  if (known) return known
  return SHAPE_KINDS[fnv1a(shape ?? '') % SHAPE_KINDS.length] as ShapeKind
}

/** 卡面绘制入参：def 必给；cost/attack/health 缺省回落 def 数值 */
export interface CardFaceParams {
  def: CardDefinition
  /** 生效功耗（手牌受费用修正时与 def.cost 不同） */
  cost?: number
  attack?: number
  /** 当前血量（场上受伤单位与 def.health 不同） */
  health?: number
}

/** 纹理缓存键（纯函数）：一切影响画面的入参都进键，数值变动即可重绘 */
export function cardFaceCacheKey(p: CardFaceParams): string {
  const { def } = p
  return [
    def.id,
    p.cost ?? def.cost,
    p.attack ?? def.attack ?? -1,
    p.health ?? def.health ?? -1,
    def.art?.shape ?? '',
    def.art?.palette ?? '',
    def.art?.glow ?? '',
    def.rarity ?? '',
    (def.keywords ?? []).join(','),
  ].join('|')
}

// —— 画布绘制（浏览器专用） ——

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 稀有度宝石色（与 layout.RARITY_GEM / 插画区稀有度环同源） */
function rarityColor(rarity: string | undefined): string | null {
  return RARITY_GEM[rarityTierOf(rarity)]
}

/**
 * 圆徽（费用/攻/血）：外暗缘 + 主体 + 点缀环 + 内亮环 + 左上高光弧 + 数字。
 * 多位数字自动缩字，保证不出圆。
 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  text: string,
  bg: string,
  ring: string,
): void {
  // 外暗缘（沉底）
  ctx.beginPath()
  ctx.arc(x, y, r + 3, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(4,6,9,0.72)'
  ctx.fill()
  // 主体
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = ring
  ctx.stroke()
  // 内亮环
  ctx.beginPath()
  ctx.arc(x, y, r - 5, 0, Math.PI * 2)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.stroke()
  // 左上高光弧（金属「棱」感）
  ctx.beginPath()
  ctx.arc(x, y, r - 2.5, -2.5, -1.2)
  ctx.lineWidth = 2.2
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.lineCap = 'butt'
  // 数字（按位数缩字）
  const len = text.length
  const fs = Math.round(r * (len <= 2 ? 1.05 : len === 3 ? 0.8 : 0.62))
  ctx.fillStyle = '#ffffff'
  ctx.font = `900 ${fs}px "Segoe UI", "PingFang SC", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y + r * 0.06)
}

/** 单行截断（画布文本防溢出） */
function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/** flavor 两行折行（超出宽度在中位附近断开，第二行仍超宽则截断） */
function wrapFlavor(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): [string, string] {
  if (ctx.measureText(text).width <= maxWidth) return [text, '']
  let cut = Math.ceil(text.length / 2)
  while (cut > 1 && ctx.measureText(text.slice(0, cut)).width > maxWidth) cut -= 1
  let rest = text.slice(cut)
  if (ctx.measureText(rest).width > maxWidth) rest = truncate(ctx, rest, maxWidth)
  return [text.slice(0, cut), rest]
}

/** 派系金属外框：暗缘 → 主金属渐变 → 顶部高光 → 内 hairline */
function drawMetalFrame(
  ctx: CanvasRenderingContext2D,
  pal: { primary: string },
  hiColor: string,
  hiAlpha: number,
  edgeColor: string,
  edgeAlpha: number,
): void {
  const m = 10
  // 暗缘（外圈压暗，金属「厚」感）
  roundRect(ctx, m, m, FACE_W - m * 2, FACE_H - m * 2, 26)
  ctx.lineWidth = 9
  ctx.globalAlpha = edgeAlpha
  ctx.strokeStyle = edgeColor
  ctx.stroke()
  ctx.globalAlpha = 1
  // 主金属：纵向明→主色→暗渐变
  const g = ctx.createLinearGradient(0, 0, 0, FACE_H)
  g.addColorStop(0, shade(pal.primary, 1.3))
  g.addColorStop(0.35, pal.primary)
  g.addColorStop(1, shade(pal.primary, 0.62))
  roundRect(ctx, m + 3, m + 3, FACE_W - (m + 3) * 2, FACE_H - (m + 3) * 2, 23)
  ctx.lineWidth = 5
  ctx.strokeStyle = g
  ctx.stroke()
  // 顶部高光（只画上半段：clip）
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, FACE_W, FACE_H * 0.5)
  ctx.clip()
  roundRect(ctx, m + 4.5, m + 4.5, FACE_W - (m + 4.5) * 2, FACE_H - (m + 4.5) * 2, 22)
  ctx.lineWidth = 1.6
  ctx.globalAlpha = hiAlpha
  ctx.strokeStyle = hiColor
  ctx.stroke()
  ctx.restore()
  ctx.globalAlpha = 1
  // 内 hairline
  roundRect(ctx, m + 13, m + 13, FACE_W - (m + 13) * 2, FACE_H - (m + 13) * 2, 18)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = shade(pal.primary, 0.55)
  ctx.stroke()
}

/**
 * 底版层：背景 + 质感层 + 金属外框 + 插画窗底板 + 边框信息带（名称/类型/flavor）
 * + 稀有度宝石。（几何主体移交 SVG 图形层，关键词点阵移交 SVG 角标行；本层可重复调用。）
 */
function drawFaceInto(ctx: CanvasRenderingContext2D, p: CardFaceParams): void {
  const { def } = p
  const pal = resolvePalette(def.art, def.faction)
  const params = deriveFaceArt(def)

  // 1. 背景层（按稀有度分级的派系底色 + 走线/网格/噪声组合，确定性）
  drawFaceBackground(ctx, FACE_W, FACE_H, params.bg, pal, params.rarityTier)

  // 2. 质感层（纸纹/微走线/暗角/内阴影/顶部光泽，随稀有度分级）
  const tex = faceTexture(pal, params.rarityTier, params.seed)
  drawFaceTexture(ctx, FACE_W, FACE_H, tex)

  // 3. 金属外框（派系色，暗缘 + 渐变 + 顶部高光）
  drawMetalFrame(ctx, pal, tex.frameMetal.hiColor, tex.frameMetal.hiAlpha, tex.frameMetal.edgeColor, tex.frameMetal.edgeAlpha)

  // 4. 插画窗底板（SVG 主视觉异步叠绘于此；竖向占比 ≥40%）
  const { x: artX, y: artY, w: artW, h: artH, r: artR } = ART_WINDOW
  ctx.fillStyle = '#0a0e12'
  roundRect(ctx, artX, artY, artW, artH, artR)
  ctx.fill()
  ctx.strokeStyle = shade(pal.primary, 0.55)
  ctx.lineWidth = 3
  roundRect(ctx, artX, artY, artW, artH, artR)
  ctx.stroke()
  ctx.save()
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = shade(pal.primary, 1.4)
  ctx.lineWidth = 1
  roundRect(ctx, artX + 3, artY + 3, artW - 6, artH - 6, Math.max(4, artR - 3))
  ctx.stroke()
  ctx.restore()

  // 5. 稀有度宝石（右上，压在插画窗角上；插画区稀有度环由 SVG 层呼应）
  const rc = rarityColor(def.rarity)
  if (rc) {
    ctx.save()
    ctx.shadowColor = rc
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.arc(GEM.x, GEM.y, GEM.r, 0, Math.PI * 2)
    ctx.fillStyle = rc
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.arc(GEM.x, GEM.y, GEM.r, 0, Math.PI * 2)
    ctx.lineWidth = 2
    ctx.strokeStyle = shade(rc, 0.45)
    ctx.stroke()
    ctx.globalAlpha = 0.75
    ctx.beginPath()
    ctx.arc(GEM.x - GEM.r * 0.3, GEM.y - GEM.r * 0.3, GEM.r * 0.28, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // 6. 边框信息带：名称 / 类型 / flavor（深色区白字，对比度安全）
  ctx.fillStyle = '#f2f5f7'
  ctx.font = '800 38px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(truncate(ctx, def.name, artW - 12), FACE_W / 2, NAME_Y)

  const typeName = def.type === 'gpu' ? '显卡' : def.type === 'driver' ? '驱动' : '外设'
  ctx.fillStyle = shade(pal.primary, 1.2)
  ctx.font = '600 22px "Segoe UI", "PingFang SC", sans-serif'
  ctx.fillText(`${typeName} · ${def.faction.toUpperCase()}`, FACE_W / 2, TYPE_Y)

  if (def.flavor) {
    ctx.fillStyle = '#8b98a5'
    ctx.font = 'italic 400 19px "Segoe UI", "PingFang SC", sans-serif'
    const [l1, l2] = wrapFlavor(ctx, def.flavor, artW - 20)
    ctx.fillText(l1, FACE_W / 2, FLAVOR_Y1)
    if (l2 !== '') ctx.fillText(l2, FACE_W / 2, FLAVOR_Y2)
  }
}

/** 角标层：费用圆徽（压插画窗左上角）+ 攻/血徽（底部两角），压在 SVG 框饰之上保持可读性 */
function drawFaceOverlay(ctx: CanvasRenderingContext2D, p: CardFaceParams): void {
  const { def } = p
  const isGpu = def.type === 'gpu'
  const cost = p.cost ?? def.cost
  const attack = p.attack ?? def.attack
  const health = p.health ?? def.health
  drawBadge(ctx, COST_BADGE.x, COST_BADGE.y, COST_BADGE.r, String(cost), '#0c2a33', '#35d0ff')
  if (isGpu && attack !== undefined) {
    drawBadge(ctx, STAT_X_IN, STAT_Y, STAT_R, String(attack), '#3a2a08', '#ffc53d')
  }
  if (isGpu && health !== undefined) {
    drawBadge(ctx, STAT_X_OUT, STAT_Y, STAT_R, String(health), '#33110f', '#ff5d4d')
  }
}

/**
 * 绘制整张卡面（同步部分，浏览器专用）。
 * 产出「背景 + 质感 + 底版 + 角标」的完整卡面；SVG 图形层（形制骨架主视觉×
 * 派系母题×稀有度框饰/插画区环×关键词角标）由 composeCardFaceArt 异步补绘。
 */
export function drawCardFace(p: CardFaceParams): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_W
  canvas.height = FACE_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('drawCardFace: 2D context 不可用')
  drawFaceInto(ctx, p)
  drawFaceOverlay(ctx, p)
  return canvas
}

/** SVG data URI → Image 内联加载（无网络请求；data URI 属内联资源） */
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('composeCardFaceArt: SVG data URI 加载失败'))
    img.src = svgToDataUri(svg)
  })
}

/**
 * 异步补绘 SVG 图形层（懒生成，不卡主线程）：
 * 等待 data URI 图像解码后，在同一位图上按「底版 → SVG 图形层 → 角标」
 * 顺序整面重绘。调用方（TableRenderer）随后对 CanvasTexture flip needsUpdate。
 * 失败不致命：同步底版仍完整可渲染，调用方应 catch 吞掉。
 */
export async function composeCardFaceArt(canvas: HTMLCanvasElement, p: CardFaceParams): Promise<void> {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('composeCardFaceArt: 2D context 不可用')
  const pal = resolvePalette(p.def.art, p.def.faction)
  const params = deriveFaceArt(p.def)
  const svg = buildFaceArtSvg(params, pal)
  const img = await loadSvgImage(svg)
  drawFaceInto(ctx, p)
  ctx.drawImage(img, 0, 0, FACE_W, FACE_H)
  drawFaceOverlay(ctx, p)
}

/** 通用卡背（全卡共用一张纹理） */
export function drawCardBack(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_W
  canvas.height = FACE_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('drawCardBack: 2D context 不可用')
  const bg = ctx.createLinearGradient(0, 0, FACE_W, FACE_H)
  bg.addColorStop(0, '#0d1420')
  bg.addColorStop(1, '#070a10')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, FACE_W, FACE_H)
  // 电路走线
  ctx.strokeStyle = '#1d3a2f'
  ctx.lineWidth = 3
  for (let i = 0; i < 12; i += 1) {
    ctx.beginPath()
    const y = 40 + i * ((FACE_H - 80) / 11)
    ctx.moveTo(30, y)
    ctx.lineTo(FACE_W / 2 - 60 + (i % 3) * 40, y)
    ctx.lineTo(FACE_W / 2 - 30 + (i % 3) * 40, y + 36)
    ctx.lineTo(FACE_W - 30, y + 36)
    ctx.stroke()
  }
  // 中央硅牌徽记
  ctx.strokeStyle = '#35d0ff'
  ctx.lineWidth = 8
  ctx.strokeRect(FACE_W / 2 - 84, FACE_H / 2 - 84, 168, 168)
  ctx.font = '900 64px "Segoe UI", "PingFang SC", sans-serif'
  ctx.fillStyle = '#35d0ff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('硅', FACE_W / 2, FACE_H / 2 + 4)
  return canvas
}

/**
 * 纹理缓存（M1-R3D2/R3D4 验收项；M4-R3D5 增补 put 以支持异步补绘）：
 * 键 = cardFaceCacheKey / TableRenderer 的 cardFaceKey。
 * put/get 分离以便测试注入假缓存；dispose 时统一清空。
 */
export class TextureCache {
  private map = new Map<string, THREE.CanvasTexture>()

  get(key: string): THREE.CanvasTexture | undefined {
    return this.map.get(key)
  }

  /** 已绘制画布直接入库（drawCardFace 同步产出 → composeCardFaceArt 异步补绘场景） */
  put(key: string, canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    this.map.set(key, tex)
    return tex
  }

  /** 缓存未命中时用 factory 绘制并入库 */
  getOrDraw(key: string, factory: () => HTMLCanvasElement): THREE.CanvasTexture {
    const hit = this.map.get(key)
    if (hit) return hit
    return this.put(key, factory())
  }

  get size(): number {
    return this.map.size
  }

  dispose(): void {
    for (const tex of this.map.values()) tex.dispose()
    this.map.clear()
  }
}
