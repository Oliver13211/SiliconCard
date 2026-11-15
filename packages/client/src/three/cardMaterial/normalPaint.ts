/**
 * 法线贴图 Canvas 绘制器（P2-R3D1）—— 浏览器专用绘制层，纯代码生成。
 *
 * 实现路线（任务书红线：程序化派生、禁像素分析）：不读回任何位图像素、
 * 不做 Sobel/高度场滤波——直接用 Canvas 2D 把切线空间法线「画」出来：
 * - 平坦区填充 rgb(128,128,255)；
 * - 脊线坡面 = 均匀倾色带（物理上等高线坡面的法线恒定，颜色即编码倾斜方向）；
 * - 圆脊坡面 = 16 分扇弧段（每扇以其平分角方向编码，接缝处在游玩距离不可辨）。
 * 一次性生成 + 上层缓存（normalCache），运行时零重绘。
 *
 * 本模块同时导出低阶绘制原语（paintRidgeRectPath / paintRidgeCircle /
 * normalTiltColor），tableSkin 的台面织纹/槽位凹凸复用同一套编码（P2-R3D2），
 * 保证卡面与台面法线风格一致。
 */

import type { BackNormalSpec, CardNormalSpec, RidgeCircleSpec, RidgeRectSpec } from './normalSpec'

type Ctx = CanvasRenderingContext2D

/** 平坦法线色（切线空间 z+ 出屏） */
export const NORMAL_FLAT = '#8080ff'

/** 编码幅度（127 → 满偏；留 1 避免色带量化溢出） */
const AMP = 126

/**
 * 倾斜方向 → 编码色（纯函数）。dx/dy 为 canvas 空间单位倾斜方向
 * （x 右正、y 下正）；法线 G 通道对应 +v（= canvas −y），故 G 取 −dy。
 * s 为强度（可为负 = 反向倾，groove 用）。
 */
export function normalTiltColor(dx: number, dy: number, s: number): string {
  const r = Math.max(0, Math.min(255, Math.round(128 + dx * s * AMP)))
  const g = Math.max(0, Math.min(255, Math.round(128 - dy * s * AMP)))
  return `rgb(${r},${g},255)`
}

/** 判定坡面是否需要绘制（宽度与强度皆非零才画） */
function flankActive(width: number, s: number): boolean {
  return width > 0.01 && Math.abs(s) > 0.005
}

function fillRect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
}

/**
 * 圆角矩形脊线绘制：外坡（tilt 向外）+ 内坡（tilt 向内）+ 四角 45° 过渡环。
 * 直边用均匀色带、角用弧环（lineWidth = 坡宽，半径取坡带中线），
 * 两者在 r 处首尾相接，无重叠无缝隙（圆角衔接处近似）。
 */
export function paintRidgeRectPath(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  outer: number,
  inner: number,
  sOuter: number,
  sInner: number,
): void {
  // —— 外坡：向外倾（上边朝上 / 下边朝下 / 左右同理），负强度自动反向 ——
  if (flankActive(outer, sOuter)) {
    fillRect(ctx, x + r, y - outer, w - r * 2, outer, normalTiltColor(0, -1, sOuter))
    fillRect(ctx, x + r, y + h, w - r * 2, outer, normalTiltColor(0, 1, sOuter))
    fillRect(ctx, x - outer, y + r, outer, h - r * 2, normalTiltColor(-1, 0, sOuter))
    fillRect(ctx, x + w, y + r, outer, h - r * 2, normalTiltColor(1, 0, sOuter))
    // 四角：45° 外向环
    const ro = r + outer / 2
    const diag = Math.SQRT1_2
    const corners: [number, number, number, number][] = [
      // [圆心x, 圆心y, 起角, 止角]（canvas 角度：0=+x，顺时针增）
      [x + r, y + r, Math.PI, Math.PI * 1.5], // 左上
      [x + w - r, y + r, Math.PI * 1.5, Math.PI * 2], // 右上
      [x + w - r, y + h - r, 0, Math.PI * 0.5], // 右下
      [x + r, y + h - r, Math.PI * 0.5, Math.PI], // 左下
    ]
    const cornerDirs = [
      [-diag, -diag],
      [diag, -diag],
      [diag, diag],
      [-diag, diag],
    ]
    ctx.lineWidth = outer
    for (let i = 0; i < 4; i += 1) {
      const c = corners[i] as [number, number, number, number]
      const d = cornerDirs[i] as [number, number]
      ctx.strokeStyle = normalTiltColor(d[0] as number, d[1] as number, sOuter)
      ctx.beginPath()
      ctx.arc(c[0] as number, c[1] as number, ro, c[2] as number, c[3] as number)
      ctx.stroke()
    }
  }
  // —— 内坡：向内倾（朝矩形中心），负强度反向（槽壁朝脊线收拢） ——
  if (flankActive(inner, sInner)) {
    fillRect(ctx, x + r, y, w - r * 2, inner, normalTiltColor(0, 1, sInner))
    fillRect(ctx, x + r, y + h - inner, w - r * 2, inner, normalTiltColor(0, -1, sInner))
    fillRect(ctx, x, y + r, inner, h - r * 2, normalTiltColor(1, 0, sInner))
    fillRect(ctx, x + w - inner, y + r, inner, h - r * 2, normalTiltColor(-1, 0, sInner))
    const ri = Math.max(1, r - inner / 2)
    const diag = Math.SQRT1_2
    const corners: [number, number, number, number][] = [
      [x + r, y + r, Math.PI, Math.PI * 1.5],
      [x + w - r, y + r, Math.PI * 1.5, Math.PI * 2],
      [x + w - r, y + h - r, 0, Math.PI * 0.5],
      [x + r, y + h - r, Math.PI * 0.5, Math.PI],
    ]
    // 内坡角部方向 = 指向矩形中心的 45°
    const cornerDirs = [
      [diag, diag],
      [-diag, diag],
      [-diag, -diag],
      [diag, -diag],
    ]
    ctx.lineWidth = inner
    for (let i = 0; i < 4; i += 1) {
      const c = corners[i] as [number, number, number, number]
      const d = cornerDirs[i] as [number, number]
      ctx.strokeStyle = normalTiltColor(d[0] as number, d[1] as number, sInner)
      ctx.beginPath()
      ctx.arc(c[0] as number, c[1] as number, ri, c[2] as number, c[3] as number)
      ctx.stroke()
    }
  }
}

/**
 * 圆形脊线绘制（角标圆币 / 宝石穹顶 / 螺丝）：坡面环带按 16 分扇绘制，
 * 每扇用其平分角方向的均匀倾色（外坡朝外、内坡朝内，负强度反向）。
 */
export function paintRidgeCircle(
  ctx: Ctx,
  cx: number,
  cy: number,
  r: number,
  outer: number,
  inner: number,
  sOuter: number,
  sInner: number,
): void {
  const OCT = 16
  const step = (Math.PI * 2) / OCT
  if (flankActive(outer, sOuter)) {
    ctx.lineWidth = outer
    for (let k = 0; k < OCT; k += 1) {
      const mid = (k + 0.5) * step
      ctx.strokeStyle = normalTiltColor(Math.cos(mid), Math.sin(mid), sOuter)
      ctx.beginPath()
      ctx.arc(cx, cy, r + outer / 2, k * step, (k + 1) * step)
      ctx.stroke()
    }
  }
  if (flankActive(inner, sInner)) {
    ctx.lineWidth = inner
    for (let k = 0; k < OCT; k += 1) {
      const mid = (k + 0.5) * step
      ctx.strokeStyle = normalTiltColor(-Math.cos(mid), -Math.sin(mid), sInner)
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(1, r - inner / 2), k * step, (k + 1) * step)
      ctx.stroke()
    }
  }
}

/** 六边形脊线（台面中央螺母徽记）：外环向外倾、内环向内倾，逐边定向绘制 */
export function paintRidgeHexagon(
  ctx: Ctx,
  cx: number,
  cy: number,
  rMid: number,
  band: number,
  s: number,
): void {
  const vertsAt = (radius: number): [number, number][] => {
    const vs: [number, number][] = []
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 6 + (i * Math.PI) / 3
      vs.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius])
    }
    return vs
  }
  // 外坡环（半径外偏 band/2）与内坡环各 6 条边，方向 = 边中点的外向/内向法线
  for (const [radius, dirSign] of [
    [rMid + band / 2, 1],
    [Math.max(1, rMid - band / 2), -1],
  ] as const) {
    const vs = vertsAt(radius)
    ctx.lineWidth = band
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 6 + ((i + 0.5) * Math.PI) / 3
      ctx.strokeStyle = normalTiltColor(Math.cos(a) * dirSign, Math.sin(a) * dirSign, s)
      ctx.beginPath()
      const p0 = vs[i] as [number, number]
      const p1 = vs[(i + 1) % 6] as [number, number]
      ctx.moveTo(p0[0] as number, p0[1] as number)
      ctx.lineTo(p1[0] as number, p1[1] as number)
      ctx.stroke()
    }
  }
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  return ctx ? { canvas, ctx } : null
}

function drawRidgeRect(ctx: Ctx, s: RidgeRectSpec): void {
  paintRidgeRectPath(ctx, s.x, s.y, s.w, s.h, s.r, s.outer, s.inner, s.sOuter, s.sInner)
}

function drawRidgeCircle(ctx: Ctx, s: RidgeCircleSpec): void {
  paintRidgeCircle(ctx, s.cx, s.cy, s.r, s.outer, s.inner, s.sOuter, s.sInner)
}

/**
 * 绘制卡面法线贴图（浏览器专用；无头环境返回 null，上层回落无浮雕材质）。
 * 顺序：平坦底 → 外框 → 高光带 → hairline → 插画窗 → 稀有度环 → 角标（后画者覆盖重叠区）。
 */
export function paintCardNormalCanvas(spec: CardNormalSpec): HTMLCanvasElement | null {
  const made = makeCanvas(spec.w, spec.h)
  if (!made) return null
  const { canvas, ctx } = made
  ctx.fillStyle = NORMAL_FLAT
  ctx.fillRect(0, 0, spec.w, spec.h)
  ctx.lineCap = 'butt'
  drawRidgeRect(ctx, spec.frame)
  if (spec.topBand) drawRidgeRect(ctx, spec.topBand)
  drawRidgeRect(ctx, spec.hairline)
  drawRidgeRect(ctx, spec.windowPit)
  if (spec.rarityRing) drawRidgeRect(ctx, spec.rarityRing)
  drawRidgeCircle(ctx, spec.costBadge)
  if (spec.gem) drawRidgeCircle(ctx, spec.gem)
  return canvas
}

/** 绘制卡背法线贴图（边框 + 中央徽记 + 走线细脊；无头环境返回 null） */
export function paintCardBackNormalCanvas(spec: BackNormalSpec): HTMLCanvasElement | null {
  const made = makeCanvas(spec.w, spec.h)
  if (!made) return null
  const { canvas, ctx } = made
  ctx.fillStyle = NORMAL_FLAT
  ctx.fillRect(0, 0, spec.w, spec.h)
  ctx.lineCap = 'butt'
  drawRidgeRect(ctx, spec.frame)
  drawRidgeRect(ctx, spec.emblem)
  for (const t of spec.traces) drawRidgeRect(ctx, t)
  return canvas
}
