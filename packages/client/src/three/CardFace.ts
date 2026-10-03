/**
 * 程序化卡面绘制器（M1-R3D2）—— CanvasTexture 方案，零外部图片资产
 * （设计支柱 4 / design-report §2.8：派系色板 + 几何抽象形，数据驱动）。
 *
 * 数据来源：
 * - 美术参数 = CardDefinition.art（shape / palette / glow，content JSON 提供）；
 * - 数值 = cost（手牌为生效功耗）与 gpu 的 attack/health（场上单位可传当前值）；
 * - 派系色板：art.palette 为十六进制色时直接采用；否则查内置派系色表；
 *   未知名按字符串哈希确定性生成色相（数据驱动扩展：新增派系零改动）。
 *
 * 纯函数（resolvePalette / pickShapeKind / cardFaceCacheKey / hueOf）可无头测试；
 * drawCardFace 依赖 DOM canvas，只能在浏览器调用，禁止在模块顶层执行。
 */

import type { CardArt, CardDefinition } from '@siliconcard/core'
import * as THREE from 'three'

/** 卡面画布尺寸（约 5:7，与 layout.CARD_W/CARD_H 比例一致） */
export const FACE_W = 512
export const FACE_H = 718

/** 派系色板：与 App.tsx 派系列表同源；art.palette 优先于本表（内容包可覆盖） */
export const FACTION_COLORS: Record<string, string> = {
  nvidia: '#76b900',
  amd: '#ed1c24',
  intel: '#0068b5',
  apple: '#a2aaad',
  qualcomm: '#3253dc',
  arm: '#ffb400',
  neutral: '#8b949e',
}

export interface Palette {
  /** 主色（卡框 / 派系条） */
  primary: string
  /** 副色（几何形体） */
  secondary: string
  /** 点缀色（费用环 / 稀有度宝石底） */
  accent: string
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** FNV-1a 32 位字符串哈希（本地纯函数，与 core/testing 的 stableHash 用途不同勿混用） */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 未知色板名的确定性色相（0..360） */
export function hueOf(name: string): number {
  return fnv1a(name) % 360
}

/** hsl → hex（纯函数，保证跨浏览器一致的色值输出；端点例：hsl(0,1,.5)=#ff0000） */
export function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * 色板解析（纯函数）：art.palette 优先；十六进制直接用；
 * 派系名查表；未知名按哈希生成确定性三色。
 */
export function resolvePalette(art: CardArt | undefined, factionId: string): Palette {
  const named = art?.palette ?? factionId
  if (named && HEX_RE.test(named)) {
    return { primary: named, secondary: shade(named, 0.55), accent: shade(named, 1.35) }
  }
  const tabled = FACTION_COLORS[named.toLowerCase()]
  if (tabled) {
    return { primary: tabled, secondary: shade(tabled, 0.55), accent: shade(tabled, 1.35) }
  }
  const h = hueOf(named || factionId || 'neutral')
  return {
    primary: hslToHex(h, 0.62, 0.5),
    secondary: hslToHex((h + 24) % 360, 0.5, 0.32),
    accent: hslToHex((h + 180) % 360, 0.7, 0.6),
  }
}

/** 明度缩放（-1..∞，>1 提亮、<1 压暗），纯函数 */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => {
    const out = k <= 1 ? Math.round(v * k) : Math.round(v + (255 - v) * (k - 1))
    return Math.max(0, Math.min(255, out))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${ch((n >> 16) & 0xff)}${ch((n >> 8) & 0xff)}${ch(n & 0xff)}`
}

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

/** 几何抽象形：按 ShapeKind 画在 art 窗口中央（区域 x,y,w,h） */
function drawShape(
  ctx: CanvasRenderingContext2D,
  kind: ShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  pal: Palette,
  glow: string | undefined,
): void {
  const cx = x + w / 2
  const cy = y + h / 2
  ctx.save()
  if (glow) {
    ctx.shadowColor = glow
    ctx.shadowBlur = 28
  }
  ctx.strokeStyle = pal.primary
  ctx.fillStyle = pal.secondary
  ctx.lineWidth = 6
  switch (kind) {
    case 'fan': {
      // 显卡风扇：中心毂 + 7 叶
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * Math.PI * 2
        ctx.beginPath()
        ctx.ellipse(cx + Math.cos(a) * w * 0.24, cy + Math.sin(a) * w * 0.24, w * 0.16, w * 0.075, a, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(cx, cy, w * 0.14, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'chip': {
      // 裸片：矩形 + 引脚
      const cw = w * 0.5
      const chh = h * 0.42
      ctx.fillRect(cx - cw / 2, cy - chh / 2, cw, chh)
      ctx.strokeRect(cx - cw / 2, cy - chh / 2, cw, chh)
      for (let i = 0; i < 6; i += 1) {
        const px = cx - cw / 2 + ((i + 0.5) * cw) / 6
        ctx.beginPath()
        ctx.moveTo(px, cy - chh / 2 - 14)
        ctx.lineTo(px, cy - chh / 2)
        ctx.moveTo(px, cy + chh / 2)
        ctx.lineTo(px, cy + chh / 2 + 14)
        ctx.stroke()
      }
      break
    }
    case 'wave': {
      // 信号波：三条正弦
      for (let row = 0; row < 3; row += 1) {
        ctx.beginPath()
        for (let i = 0; i <= 48; i += 1) {
          const t = i / 48
          const px = x + t * w
          const py = cy + (row - 1) * h * 0.18 + Math.sin(t * Math.PI * 4 + row) * h * 0.09
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
      break
    }
    case 'die': {
      // 晶圆网格
      const n = 4
      const cell = Math.min(w, h) / (n + 1.6)
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if ((i + j) % 2 === 0) continue
          ctx.fillRect(cx - (n * cell) / 2 + i * cell, cy - (n * cell) / 2 + j * cell, cell * 0.86, cell * 0.86)
        }
      }
      ctx.strokeRect(cx - (n * cell) / 2, cy - (n * cell) / 2, n * cell, n * cell)
      break
    }
    case 'connector': {
      // PCIe 金手指
      const cw = w * 0.62
      ctx.fillRect(cx - cw / 2, cy - h * 0.16, cw, h * 0.34)
      ctx.strokeRect(cx - cw / 2, cy - h * 0.16, cw, h * 0.34)
      ctx.fillStyle = pal.accent
      for (let i = 0; i < 9; i += 1) {
        ctx.fillRect(cx - cw / 2 + 8 + i * ((cw - 16) / 9), cy + h * 0.1, (cw - 16) / 18, h * 0.08)
      }
      break
    }
    case 'mineral': {
      // 矿卡晶簇
      ctx.beginPath()
      ctx.moveTo(cx, cy - h * 0.3)
      ctx.lineTo(cx + w * 0.22, cy)
      ctx.lineTo(cx + w * 0.08, cy + h * 0.28)
      ctx.lineTo(cx - w * 0.18, cy + h * 0.2)
      ctx.lineTo(cx - w * 0.24, cy - h * 0.05)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      break
    }
  }
  ctx.restore()
}

/** 稀有度色（M1 简单映射；正式色板随 content 扩容） */
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

/**
 * 绘制整张卡面到新 canvas（浏览器专用）。画素布局：
 * 外框（派系色）→ 费用圆环（左上，W 角标）→ 稀有度宝石（右上）→
 * art 几何窗 → 名称 → 类型行 → 关键词梗名点 → 攻/血角标（gpu）。
 */
export function drawCardFace(p: CardFaceParams): HTMLCanvasElement {
  const { def } = p
  const canvas = document.createElement('canvas')
  canvas.width = FACE_W
  canvas.height = FACE_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('drawCardFace: 2D context 不可用')
  const pal = resolvePalette(def.art, def.faction)
  const isGpu = def.type === 'gpu'
  const cost = p.cost ?? def.cost
  const attack = p.attack ?? def.attack
  const health = p.health ?? def.health

  // 底色与渐变
  const bg = ctx.createLinearGradient(0, 0, 0, FACE_H)
  bg.addColorStop(0, '#101418')
  bg.addColorStop(1, '#05070a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, FACE_W, FACE_H)

  // 外框
  const m = 10
  roundRect(ctx, m, m, FACE_W - m * 2, FACE_H - m * 2, 26)
  ctx.lineWidth = 8
  ctx.strokeStyle = pal.primary
  ctx.stroke()
  roundRect(ctx, m + 10, m + 10, FACE_W - (m + 10) * 2, FACE_H - (m + 10) * 2, 20)
  ctx.lineWidth = 2
  ctx.strokeStyle = shade(pal.primary, 0.6)
  ctx.stroke()

  // art 几何窗
  const artX = 44
  const artY = 88
  const artW = FACE_W - artX * 2
  const artH = 268
  ctx.fillStyle = '#0a0e12'
  roundRect(ctx, artX, artY, artW, artH, 14)
  ctx.fill()
  drawShape(ctx, pickShapeKind(def.art?.shape), artX, artY, artW, artH, pal, def.art?.glow)
  ctx.strokeStyle = shade(pal.primary, 0.8)
  ctx.lineWidth = 2
  roundRect(ctx, artX, artY, artW, artH, 14)
  ctx.stroke()

  // 费用圆环（功耗 W）
  drawBadge(ctx, 74, 74, 44, String(cost), '#0c2a33', '#35d0ff')

  // 稀有度宝石
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

  // 名称
  ctx.fillStyle = '#f2f5f7'
  ctx.font = '800 40px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(truncate(ctx, def.name, artW - 24), FACE_W / 2, artY + artH + 44)

  // 类型行：类型 + 派系
  const typeName = def.type === 'gpu' ? '显卡' : def.type === 'driver' ? '驱动' : '外设'
  ctx.fillStyle = shade(pal.primary, 1.2)
  ctx.font = '600 24px "Segoe UI", "PingFang SC", sans-serif'
  ctx.fillText(`${typeName} · ${def.faction.toUpperCase()}`, FACE_W / 2, artY + artH + 84)

  // 关键词点（梗名不画小字，正式文案待 content 提供 KeywordManifest；先以点数示意）
  const kw = def.keywords ?? []
  if (kw.length > 0) {
    const dotR = 7
    const gap = 24
    const total = (kw.length - 1) * gap
    kw.forEach((_, i) => {
      ctx.beginPath()
      ctx.arc(FACE_W / 2 - total / 2 + i * gap, artY + artH + 122, dotR, 0, Math.PI * 2)
      ctx.fillStyle = pal.accent
      ctx.fill()
    })
  }

  // flavor（小字斜体，两行内截断）
  if (def.flavor) {
    ctx.fillStyle = '#8b98a5'
    ctx.font = 'italic 400 21px "Segoe UI", "PingFang SC", sans-serif'
    ctx.fillText(truncate(ctx, def.flavor, artW), FACE_W / 2, FACE_H - 150)
  }

  // 攻/血角标（gpu 专属）
  if (isGpu && attack !== undefined) {
    drawBadge(ctx, 78, FACE_H - 84, 40, String(attack), '#3a2a08', '#ffc53d')
  }
  if (isGpu && health !== undefined) {
    drawBadge(ctx, FACE_W - 78, FACE_H - 84, 40, String(health), '#33110f', '#ff5d4d')
  }

  return canvas
}

/** 单行截断（画布文本防溢出） */
function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
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
 * 纹理缓存（M1-R3D2/R3D4 验收项）：键 = cardFaceCacheKey。
 * put/get 分离以便测试注入假缓存；dispose 时统一清空。
 */
export class TextureCache {
  private map = new Map<string, THREE.CanvasTexture>()

  get(key: string): THREE.CanvasTexture | undefined {
    return this.map.get(key)
  }

  /** 缓存未命中时用 factory 绘制并入库 */
  getOrDraw(key: string, factory: () => HTMLCanvasElement): THREE.CanvasTexture {
    const hit = this.map.get(key)
    if (hit) return hit
    const tex = new THREE.CanvasTexture(factory())
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    this.map.set(key, tex)
    return tex
  }

  get size(): number {
    return this.map.size
  }

  dispose(): void {
    for (const tex of this.map.values()) tex.dispose()
    this.map.clear()
  }
}
