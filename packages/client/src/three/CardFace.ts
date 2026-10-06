/**
 * 程序化卡面绘制器（M1-R3D2 建立，M4-R3D5 第一阶段升级为组合式图形系统）。
 *
 * 分层合成（同一 Canvas 纹理，自底向上）：
 * 1. 背景层（cardArt/background，纯代码）：对角渐变 + 电路走线/网格/噪声场按
 *    cardId 确定性种子选配组合，按 art.palette 或派系色着色；
 * 2. SVG 图形层（cardArt/svg，纯函数组装）：type 形制骨架 × 派系图案母题 ×
 *    稀有度框饰 × 关键词角标，经 data URI → Image 内联渲染（禁外部资源/网络请求）；
 * 3. Canvas 底版与角标层：外框、art 窗口底板、名称/类型/flavor 文本、
 *    稀有度宝石、费用与攻/血圆徽。
 *
 * 同步/异步协议：drawCardFace 同步产出「背景层+底版+角标」的完整可渲染卡面；
 * SVG 图形层由 composeCardFaceArt 异步补绘（懒生成，不卡主线程），完成后调用方
 * 对纹理 flip needsUpdate 即可原地刷新（见 TableRenderer.getFace）。
 *
 * 数据来源：
 * - 美术参数 = CardDefinition.art（shape / palette / glow，content JSON 提供）；
 * - 图形组合参数 = cardArt/derive 派生（cardId FNV-1a 确定性哈希，禁 Math.random/Date）；
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
import { deriveFaceArt } from './cardArt/derive'
import { buildFaceArtSvg, svgToDataUri } from './cardArt/svg'

// —— 共享纯函数原语（M4-R3D5 迁至 cardArt/color，此处再导出保持既有 API 与测试兼容） ——

export { FACTION_COLORS, fnv1a, hslToHex, hueOf, resolvePalette, shade } from './cardArt/color'
export type { Palette } from './cardArt/color'
import { fnv1a, resolvePalette, shade } from './cardArt/color'

/** 卡面画布尺寸（约 5:7，与 layout.CARD_W/CARD_H 比例一致） */
export const FACE_W = 512
export const FACE_H = 718

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

function rarityColor(rarity: string | undefined): string | null {
  switch (rarity) {
    case 'legendary':
      return '#ff9d2e'
    case 'epic':
      return '#b45cff'
    case 'rare':
      return '#3f9dff'
    default:
      return null
  }
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  text: string,
  bg: string,
  ring: string,
): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 5
  ctx.strokeStyle = ring
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `900 ${Math.round(r * 1.25)}px "Segoe UI", "PingFang SC", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y + r * 0.08)
}

/** 单行截断（画布文本防溢出） */
function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/**
 * 底版层：背景层 + 外框 + art 窗口底板 + 名称/类型/flavor + 稀有度宝石。
 * （M4-R3D5：几何图形主体移交 SVG 图形层，关键词点阵移交 SVG 角标行；本层可重复调用。）
 */
function drawFaceInto(ctx: CanvasRenderingContext2D, p: CardFaceParams): void {
  const { def } = p
  const pal = resolvePalette(def.art, def.faction)
  const params = deriveFaceArt(def)

  // 1. 背景层（对角渐变 + 走线/网格/噪声组合，确定性）
  drawFaceBackground(ctx, FACE_W, FACE_H, params.bg, pal)

  // 2. 外框（派系色，保留 M1 双线规格）
  const m = 10
  roundRect(ctx, m, m, FACE_W - m * 2, FACE_H - m * 2, 26)
  ctx.lineWidth = 8
  ctx.strokeStyle = pal.primary
  ctx.stroke()
  roundRect(ctx, m + 10, m + 10, FACE_W - (m + 10) * 2, FACE_H - (m + 10) * 2, 20)
  ctx.lineWidth = 2
  ctx.strokeStyle = shade(pal.primary, 0.6)
  ctx.stroke()

  // 3. art 几何窗底板（SVG 形制骨架 × 派系母题异步叠绘于此）
  const artX = 44
  const artY = 88
  const artW = FACE_W - artX * 2
  const artH = 268
  ctx.fillStyle = '#0a0e12'
  roundRect(ctx, artX, artY, artW, artH, 14)
  ctx.fill()
  ctx.strokeStyle = shade(pal.primary, 0.8)
  ctx.lineWidth = 2
  roundRect(ctx, artX, artY, artW, artH, 14)
  ctx.stroke()

  // 4. 稀有度宝石（右上；框饰档位由 SVG 层承担）
  const rc = rarityColor(def.rarity)
  if (rc) {
    ctx.save()
    ctx.shadowColor = rc
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.arc(FACE_W - 74, 74, 16, 0, Math.PI * 2)
    ctx.fillStyle = rc
    ctx.fill()
    ctx.restore()
  }

  // 5. 名称
  ctx.fillStyle = '#f2f5f7'
  ctx.font = '800 40px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(truncate(ctx, def.name, artW - 24), FACE_W / 2, artY + artH + 44)

  // 6. 类型行：类型 + 派系
  const typeName = def.type === 'gpu' ? '显卡' : def.type === 'driver' ? '驱动' : '外设'
  ctx.fillStyle = shade(pal.primary, 1.2)
  ctx.font = '600 24px "Segoe UI", "PingFang SC", sans-serif'
  ctx.fillText(`${typeName} · ${def.faction.toUpperCase()}`, FACE_W / 2, artY + artH + 84)

  // 7. flavor（小字斜体，两行内截断）
  if (def.flavor) {
    ctx.fillStyle = '#8b98a5'
    ctx.font = 'italic 400 21px "Segoe UI", "PingFang SC", sans-serif'
    ctx.fillText(truncate(ctx, def.flavor, artW), FACE_W / 2, FACE_H - 150)
  }
}

/** 角标层：费用圆环 + 攻/血徽（压在 SVG 框饰之上，保持可读性） */
function drawFaceOverlay(ctx: CanvasRenderingContext2D, p: CardFaceParams): void {
  const { def } = p
  const isGpu = def.type === 'gpu'
  const cost = p.cost ?? def.cost
  const attack = p.attack ?? def.attack
  const health = p.health ?? def.health
  drawBadge(ctx, 74, 74, 44, String(cost), '#0c2a33', '#35d0ff')
  if (isGpu && attack !== undefined) {
    drawBadge(ctx, 78, FACE_H - 84, 40, String(attack), '#3a2a08', '#ffc53d')
  }
  if (isGpu && health !== undefined) {
    drawBadge(ctx, FACE_W - 78, FACE_H - 84, 40, String(health), '#33110f', '#ff5d4d')
  }
}

/**
 * 绘制整张卡面（同步部分，浏览器专用）。
 * 产出「背景层 + 底版 + 角标」的完整卡面；SVG 图形层（形制骨架×派系母题×
 * 稀有度框饰×关键词角标）由 composeCardFaceArt 异步补绘。
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
