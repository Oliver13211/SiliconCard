/**
 * 程序化卡面 SVG 组装（卡面大改版：SVG 主体升格卡面主视觉）—— 纯字符串构建，零 DOM、零外部资源。
 *
 * 输出一张 512×718 全幅透明底 SVG，含五个组合图层：
 *   1. 稀有度框饰（common/rare/epic/legendary 四档，legendary 明显高一档），
 *      升级金属质感：暗缘 + 顶部高光线；
 *   2. art 插画窗底板（渐变 + 派系色氛围 + 扫描线纹理，半透明与底色分级融合）；
 *   3. art 插画窗主体：派系图案母题（低透明度衬底）+ type 形制骨架主视觉
 *      （风扇阵/涡轮/裸片/盘片/接口/PCB/散热/外设/波形/晶体十大类，
 *      按已知 art.shape 子变体渲染——鼠标/椅子/内存条/散热塔……形体直白；
 *      morph 形态流驱动风扇扫掠角/纹样密度/几何变体，同骨架不同卡肉眼可辨）；
 *   4. 稀有度插画区层：rare 蓝 / epic 紫 / legendary 金环 + 放射威压层，
 *      稀有度在插画区内可读（data-art-tier / data-legendary）；
 *   5. 关键词角标行（七种，与 core Keyword 一一对应）。
 *
 * 契约：
 * - 只消费 derive.ts 的 FaceArtParams + color.ts 的 Palette，全部数值确定性派生；
 * - 禁外部引用（无 href / <image> / 网络字体），经 svgToDataUri → Image 内联进 Canvas；
 * - 关键节点带 data-* 标记（data-tier / data-art / data-art-tier / data-skeleton /
 *   data-variant / data-fan / data-motif / data-mark / data-legendary），
 *   供无头单测断言组合正确性。
 */

import { hslToHex, shade, type Palette } from './color'
import type { FaceArtParams, KeywordMarkKind, RarityTier } from './derive'
import { ART_WINDOW, FACE_H, FACE_W, KEYWORD_ROW_Y } from './layout'

/** 画布中心（角部饰件旋转基准） */
const CX = FACE_W / 2
const CY = FACE_H / 2
/** 插画窗中心（形制骨架/母题/威压层基准） */
const ACX = ART_WINDOW.x + ART_WINDOW.w / 2
const ACY = ART_WINDOW.y + ART_WINDOW.h / 2

const TAU = Math.PI * 2

/** 数值格式化：两位小数封顶，保证同参数恒同串（测试断言字符串一致性） */
const f = (v: number): string => String(Math.round(v * 100) / 100)

/** 极坐标点 */
function pt(cx: number, cy: number, ang: number, rad: number): [number, number] {
  return [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]
}

// —— 0. 静态 defs（渐变/图案/滤镜；全内部引用，无外部资源） ——

const RGB_HUES = [0, 70, 160, 220, 290] as const

function staticDefs(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const hue0 = params.seed % 360
  return (
    // 插画窗底与氛围（与 ground 底色分级融合：半透明底板 + 派系色氛围 + 暗角）
    `<linearGradient id="art-bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${shade(p, 0.5)}"/>` +
    `<stop offset="0.45" stop-color="#0a0f15"/>` +
    `<stop offset="1" stop-color="#06080c"/></linearGradient>` +
    `<radialGradient id="art-tint" cx="0.2" cy="0.08" r="0.95">` +
    `<stop offset="0" stop-color="${p}" stop-opacity="0.16"/>` +
    `<stop offset="1" stop-color="${p}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="art-vin" cx="0.5" cy="0.46" r="0.72">` +
    `<stop offset="0.62" stop-color="#000000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000000" stop-opacity="0.42"/></radialGradient>` +
    `<pattern id="art-scan" width="4" height="4" patternUnits="userSpaceOnUse">` +
    `<rect width="4" height="1.2" fill="#ffffff" fill-opacity="0.03"/></pattern>` +
    // 金属与材质
    `<linearGradient id="rim-grad" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset="0.5" stop-color="${p}"/><stop offset="1" stop-color="${shade(p, 0.4)}"/></linearGradient>` +
    `<linearGradient id="body-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${shade(p, 0.34)}"/><stop offset="0.42" stop-color="#0b0f14"/><stop offset="1" stop-color="#07090d"/></linearGradient>` +
    `<linearGradient id="blade-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${shade(s, 1.18)}"/><stop offset="0.55" stop-color="${s}"/><stop offset="1" stop-color="${shade(s, 0.5)}"/></linearGradient>` +
    `<linearGradient id="pin-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#f0d68a"/><stop offset="0.55" stop-color="#c39a3a"/><stop offset="1" stop-color="#8a661c"/></linearGradient>` +
    `<radialGradient id="die-grad" cx="0.4" cy="0.35" r="0.9">` +
    `<stop offset="0" stop-color="${shade(p, 1.15)}"/><stop offset="0.6" stop-color="${shade(p, 0.7)}"/><stop offset="1" stop-color="${shade(p, 0.42)}"/></radialGradient>` +
    `<linearGradient id="cyl-grad" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#5a636c"/><stop offset="0.5" stop-color="#23282e"/><stop offset="1" stop-color="#49525b"/></linearGradient>` +
    `<linearGradient id="gold-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#ffe7a8"/><stop offset="0.5" stop-color="#ffb84d"/><stop offset="1" stop-color="#9a6a16"/></linearGradient>` +
    `<linearGradient id="rgb-grad" x1="0" y1="0" x2="1" y2="0">` +
    RGB_HUES.map(
      (dh, i) => `<stop offset="${f(i / (RGB_HUES.length - 1))}" stop-color="${hslToHex((hue0 + dh) % 360, 0.8, 0.55)}"/>`,
    ).join('') +
    `</linearGradient>` +
    `<radialGradient id="sk-halo"><stop offset="0" stop-color="${a}" stop-opacity="0.55"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>`
  )
}

// —— 1. 稀有度框饰（金属质感升级） ——

/** 四角 L 形饰件（沿 inset 矩形四角，经旋转复用同一 path） */
function cornerTicks(inset: number, len: number, color: string, lw: number): string {
  const d = `M ${f(inset)} ${f(inset + len)} L ${f(inset)} ${f(inset + 4)} Q ${f(inset)} ${f(inset)} ${f(inset + 4)} ${f(inset)} L ${f(inset + len)} ${f(inset)}`
  return [0, 90, 180, 270]
    .map((a) => `<g transform="rotate(${a} ${CX} ${CY})"><path d="${d}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-linecap="round"/></g>`)
    .join('')
}

/** 四边中点菱形钉饰 */
function edgeStuds(size: number, color: string, glow: boolean): string {
  const pts: readonly (readonly [number, number])[] = [
    [CX, 22],
    [CX, FACE_H - 22],
    [22, CY],
    [FACE_W - 22, CY],
  ]
  const s = size
  return pts
    .map(([x, y]) => {
      const half = s / 2
      const gem = `<rect x="${f(x - half)}" y="${f(y - half)}" width="${f(s)}" height="${f(s)}" transform="rotate(45 ${x} ${y})" fill="${color}"/>`
      const core = `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s * 0.22)}" fill="#f2f5f7" fill-opacity="0.9"/>`
      return glow ? `<g filter="url(#fr-glow)">${gem}</g>${core}` : gem + core
    })
    .join('')
}

/** 顶部金属高光线（框饰带外沿的白色细线，金属「棱」感） */
function frameHiLine(y: number, opacity: number): string {
  return `<line x1="70" y1="${f(y)}" x2="${FACE_W - 70}" y2="${f(y)}" stroke="#ffffff" stroke-opacity="${f(opacity)}" stroke-width="1.5" stroke-linecap="round"/>`
}

function rarityFrame(tier: RarityTier, pal: Palette): { defs: string; body: string } {
  const p = pal.primary
  const a = pal.accent
  const soft = shade(p, 1.2)
  const dark = shade(p, 0.4)
  if (tier === 'legendary') {
    // 明显高一档：暗缘 + 渐变辉光双带 + 内 hairline + 角部双 L + 顶冠 + 大菱钉 + 金属高光
    const defs =
      `<linearGradient id="leg-grad" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${p}"/><stop offset="0.5" stop-color="${a}"/><stop offset="1" stop-color="${p}"/>` +
      `</linearGradient>` +
      `<filter id="fr-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>`
    const crest = [0, 1, 2]
      .map(
        (i) =>
          `<path d="M ${f(CX - 12 + i * 0)} ${f(32 + i * 6)} L ${CX} ${f(24 + i * 6)} L ${f(CX + 12)} ${f(32 + i * 6)}" fill="none" stroke="${i === 1 ? a : p}" stroke-width="${3 - i * 0.6}" stroke-linecap="round"/>`,
      )
      .join('')
    const body =
      `<g data-tier="legendary">` +
      `<rect x="15" y="15" width="${FACE_W - 30}" height="${FACE_H - 30}" rx="22" fill="none" stroke="${dark}" stroke-width="6" stroke-opacity="0.9"/>` +
      `<rect x="19" y="19" width="${FACE_W - 38}" height="${FACE_H - 38}" rx="20" fill="none" stroke="url(#leg-grad)" stroke-width="8" opacity="0.5" filter="url(#fr-glow)"/>` +
      `<rect x="19" y="19" width="${FACE_W - 38}" height="${FACE_H - 38}" rx="20" fill="none" stroke="url(#leg-grad)" stroke-width="5"/>` +
      frameHiLine(17.5, 0.28) +
      `<rect x="31" y="31" width="${FACE_W - 62}" height="${FACE_H - 62}" rx="14" fill="none" stroke="${a}" stroke-width="1.2" stroke-opacity="0.8"/>` +
      cornerTicks(19, 48, a, 3) +
      cornerTicks(31, 26, soft, 1.6) +
      crest +
      edgeStuds(13, a, true) +
      `</g>`
    return { defs, body }
  }
  if (tier === 'epic') {
    const defs = `<filter id="fr-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter>`
    const body =
      `<g data-tier="epic">` +
      `<rect x="17" y="17" width="${FACE_W - 34}" height="${FACE_H - 34}" rx="20" fill="none" stroke="${dark}" stroke-width="4" stroke-opacity="0.6"/>` +
      `<rect x="21" y="21" width="${FACE_W - 42}" height="${FACE_H - 42}" rx="18" fill="none" stroke="${a}" stroke-width="5" stroke-opacity="0.35" filter="url(#fr-glow)"/>` +
      `<rect x="21" y="21" width="${FACE_W - 42}" height="${FACE_H - 42}" rx="18" fill="none" stroke="${p}" stroke-width="2.5" stroke-opacity="0.85"/>` +
      frameHiLine(19.5, 0.2) +
      `<rect x="28" y="28" width="${FACE_W - 56}" height="${FACE_H - 56}" rx="14" fill="none" stroke="${soft}" stroke-width="1.2" stroke-opacity="0.6"/>` +
      cornerTicks(21, 40, a, 2.4) +
      edgeStuds(10, a, true) +
      `</g>`
    return { defs, body }
  }
  if (tier === 'rare') {
    const body =
      `<g data-tier="rare">` +
      `<rect x="22" y="22" width="${FACE_W - 44}" height="${FACE_H - 44}" rx="18" fill="none" stroke="${p}" stroke-width="2" stroke-opacity="0.6"/>` +
      frameHiLine(20.6, 0.14) +
      `<rect x="29" y="29" width="${FACE_W - 58}" height="${FACE_H - 58}" rx="14" fill="none" stroke="${soft}" stroke-width="1.2" stroke-opacity="0.5"/>` +
      cornerTicks(22, 34, a, 2) +
      `<rect x="${f(CX - 4)}" y="18" width="8" height="8" transform="rotate(45 ${CX} 22)" fill="${a}" fill-opacity="0.85"/>` +
      `<rect x="${f(CX - 4)}" y="${f(FACE_H - 26)}" width="8" height="8" transform="rotate(45 ${CX} ${FACE_H - 22})" fill="${a}" fill-opacity="0.85"/>` +
      `</g>`
    return { defs: '', body }
  }
  // common（starter 归此档）：单细线 + 短角饰
  const body =
    `<g data-tier="common">` +
    `<rect x="22" y="22" width="${FACE_W - 44}" height="${FACE_H - 44}" rx="18" fill="none" stroke="${p}" stroke-width="2" stroke-opacity="0.45"/>` +
    frameHiLine(20.6, 0.1) +
    cornerTicks(22, 26, a, 2) +
    `</g>`
  return { defs: '', body }
}

// —— 2. 派系图案母题（art 窗衬底，低透明度但可读） ——

function motifGroup(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const a = pal.accent
  const cy = ACY + params.motifShiftY
  // 插画窗升格主视觉：母题整体放大，透明度略升保持「可读」
  const tf = `translate(${f(ACX)} ${f(cy)}) rotate(${f(params.motifRot)}) scale(${f(params.motifScale * 1.18)})`
  let inner = ''
  switch (params.motif) {
    case 'nvidia': {
      // 三道斜切能量爪
      inner = [0, 1, 2]
        .map(
          (i) =>
            `<path d="M ${-114 + i * 70} 92 L ${-68 + i * 70} -92 L ${-28 + i * 70} -92 L ${-74 + i * 70} 92 Z" fill="${p}"/>`,
        )
        .join('')
      break
    }
    case 'amd': {
      // 三连箭标 chevron
      inner = [0, 1, 2]
        .map(
          (i) =>
            `<path d="M ${-104 + i * 62} 64 L ${-70 + i * 62} 0 L ${-104 + i * 62} -64 L ${-84 + i * 62} -64 L ${-50 + i * 62} 0 L ${-84 + i * 62} 64 Z" fill="${p}"/>`,
        )
        .join('')
      break
    }
    case 'intel': {
      // die 晶格阵列
      inner = [0, 1, 2, 3, 4]
        .map((r) =>
          [0, 1, 2, 3, 4, 5, 6, 7, 8]
            .map(
              (c) =>
                `<rect x="${-180 + c * 40 + 4}" y="${-100 + r * 40 + 4}" width="18" height="18" rx="3" fill="${p}" opacity="${0.4 + ((r + c) % 3) * 0.2}"/>`,
            )
            .join(''),
        )
        .join('')
      break
    }
    case 'apple': {
      // 同心圆环（极简）
      inner =
        `<circle r="98" fill="none" stroke="${p}" stroke-width="5"/>` +
        `<circle r="66" fill="none" stroke="${p}" stroke-width="4" opacity="0.7"/>` +
        `<circle r="36" fill="none" stroke="${a}" stroke-width="3"/>` +
        `<circle r="7" fill="${a}"/>`
      break
    }
    case 'qualcomm': {
      // 六边形象素簇 + 内环
      inner =
        `<path d="M 0 -86 L 74 -43 L 74 43 L 0 86 L -74 43 L -74 -43 Z" fill="none" stroke="${p}" stroke-width="4"/>` +
        `<path d="M 0 -50 L 43 -25 L 43 25 L 0 50 L -43 25 L -43 -25 Z" fill="none" stroke="${p}" stroke-width="2.5" opacity="0.6"/>` +
        `<circle r="9" fill="${a}"/>`
      break
    }
    case 'arm': {
      // 晶圆 + 放射走线
      const rays = [-2, -1, 0, 1, 2]
        .map((i) => `<line x1="0" y1="112" x2="${i * 66}" y2="${-96 + Math.abs(i) * 22}" stroke="${p}" stroke-width="2.5" opacity="0.8"/>`)
        .join('')
      inner =
        `<circle cy="-10" r="84" fill="none" stroke="${p}" stroke-width="3"/>` +
        `<line x1="-84" y1="-10" x2="84" y2="-10" stroke="${p}" stroke-width="1.5" opacity="0.5"/>` +
        `<line x1="0" y1="-94" x2="0" y2="74" stroke="${p}" stroke-width="1.5" opacity="0.5"/>` +
        rays
      break
    }
    default: {
      // neutral：点阵
      inner = [0, 1, 2, 3, 4]
        .map((r) =>
          [0, 1, 2, 3, 4, 5, 6, 7, 8]
            .map((c) => `<circle cx="${-160 + c * 40}" cy="${-80 + r * 40}" r="5" fill="${(r + c) % 4 === 0 ? a : p}" opacity="0.85"/>`)
            .join(''),
        )
        .join('')
    }
  }
  return `<g data-motif="${params.motif}" transform="${tf}" opacity="0.24">${inner}</g>`
}

// —— 3. type 形制骨架（插画窗主视觉） ——

/** 风扇单元（主视觉级）：金属外圈 + 曲面扇叶 + 毂盖，data-fan 每扇一个 */
function fanUnit(cx: number, cy: number, r: number, blades: number, pal: Palette, morph: number, tilt: number): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const step = TAU / blades
  const sweep = Math.min(0.55 + morph * 0.5, step * 0.8 * 0.92) // 扫掠角：形态流驱动，且不越过相邻叶片
  const trailing = step * 0.8
  const rh = r * 0.2
  const rt = r * 0.82
  const blade = (i: number): string => {
    const a0 = i * step
    const [hx, hy] = pt(cx, cy, a0, rh)
    const [c1x, c1y] = pt(cx, cy, a0 + sweep * 0.45, (rh + rt) * 0.54)
    const [tx, ty] = pt(cx, cy, a0 + sweep, rt)
    const [t2x, t2y] = pt(cx, cy, a0 + trailing, rt)
    const [c2x, c2y] = pt(cx, cy, a0 + (sweep + trailing) / 2, (rh + rt) * 0.5)
    const [h2x, h2y] = pt(cx, cy, a0 + trailing, rh)
    return (
      `<path d="M ${f(hx)} ${f(hy)} Q ${f(c1x)} ${f(c1y)} ${f(tx)} ${f(ty)} A ${f(rt)} ${f(rt)} 0 0 1 ${f(t2x)} ${f(t2y)} Q ${f(c2x)} ${f(c2y)} ${f(h2x)} ${f(h2y)} Z"` +
      ` fill="url(#blade-grad)" stroke="${shade(s, 1.4)}" stroke-width="0.8" stroke-opacity="0.4"/>`
    )
  }
  const hubR = rh * 1.12
  return (
    `<g data-fan="1" transform="rotate(${f(tilt)} ${f(cx)} ${f(cy)})">` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#0c1016" fill-opacity="0.94" stroke="url(#rim-grad)" stroke-width="${f(Math.max(3, r * 0.07))}"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.87)}" fill="none" stroke="${shade(p, 0.85)}" stroke-width="1.2" stroke-opacity="0.55"/>` +
    Array.from({ length: blades }, (_, i) => blade(i)).join('') +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(hubR)}" fill="#0a0e12" stroke="${a}" stroke-width="2.6"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(hubR * 0.45)}" fill="none" stroke="${shade(p, 1.2)}" stroke-width="1.2" stroke-opacity="0.8"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="2.6" fill="${a}"/>` +
    `</g>`
  )
}

/** 十字螺丝 */
function screw(x: number, y: number, r: number, pal: Palette): string {
  const c = shade(pal.primary, 0.9)
  return (
    `<g>` +
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="#10151b" stroke="${c}" stroke-width="1.5"/>` +
    `<line x1="${f(x - r * 0.55)}" y1="${f(y - r * 0.55)}" x2="${f(x + r * 0.55)}" y2="${f(y + r * 0.55)}" stroke="${shade(pal.primary, 1.25)}" stroke-width="1.2"/>` +
    `<line x1="${f(x + r * 0.55)}" y1="${f(y - r * 0.55)}" x2="${f(x - r * 0.55)}" y2="${f(y + r * 0.55)}" stroke="${shade(pal.primary, 1.25)}" stroke-width="1.2"/>` +
    `</g>`
  )
}

/** 金属机身：渐变圆角矩形 + 顶棱高光 + 描边 */
function metalBody(x: number, y: number, w: number, h: number, r: number, pal: Palette, lw = 2.5): string {
  return (
    `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(r)}" fill="url(#body-grad)" stroke="${shade(pal.primary, 0.6)}" stroke-width="${f(lw)}"/>` +
    `<line x1="${f(x + r)}" y1="${f(y + 2)}" x2="${f(x + w - r)}" y2="${f(y + 2)}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>`
  )
}

/** 竖直散热鳍片列 */
function finsV(x: number, y0: number, y1: number, count: number, span: number, pal: Palette, lw = 3): string {
  const step = count > 1 ? span / (count - 1) : 0
  return Array.from({ length: count }, (_, i) => {
    const fx = x + i * step
    const bright = i % 4 === 0
    return `<line x1="${f(fx)}" y1="${f(y0)}" x2="${f(fx)}" y2="${f(y1)}" stroke="${bright ? shade(pal.primary, 1.3) : pal.primary}" stroke-width="${f(bright ? lw * 0.5 : lw)}" opacity="${bright ? 0.5 : 0.55}"/>`
  }).join('')
}

/** 水平散热鳍片列 */
function finsH(x0: number, x1: number, y: number, count: number, span: number, pal: Palette): string {
  const step = count > 1 ? span / (count - 1) : 0
  return Array.from({ length: count }, (_, i) => {
    const fy = y + i * step
    const bright = i % 4 === 0
    return `<rect x="${f(x0)}" y="${f(fy)}" width="${f(x1 - x0)}" height="3" fill="${bright ? shade(pal.primary, 1.35) : shade(pal.primary, 1.05)}" opacity="${bright ? 0.6 : 0.42}"/>`
  }).join('')
}

/** 金手指列（gold fingers）：count 根，从 (x, y) 起横向排布 */
function goldFingers(x: number, y: number, count: number, w: number, gap: number, longH: number, shortH: number, notchAt: number): string {
  return Array.from({ length: count }, (_, i) => {
    const fx = x + i * (w + gap)
    const isShort = notchAt >= 0 && i < notchAt
    const h = isShort ? shortH : longH
    return (
      `<rect x="${f(fx)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="url(#pin-grad)" stroke="#5a4413" stroke-width="0.6"/>` +
      `<line x1="${f(fx + w / 2)}" y1="${f(y + 2)}" x2="${f(fx + w / 2)}" y2="${f(y + h - 2)}" stroke="#6a5118" stroke-width="0.8" opacity="0.7"/>`
    )
  }).join('')
}

/** SMD 电容排 */
function capRow(x: number, y: number, count: number, w: number, h: number, gap: number, pal: Palette): string {
  return Array.from({ length: count }, (_, i) => {
    const cx2 = x + i * (w + gap)
    return `<rect x="${f(cx2)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="1.5" fill="#3a424b" stroke="${shade(pal.primary, 0.85)}" stroke-width="1"/>`
  }).join('')
}

/** die 芯片：硅片渐变 + 蚀刻纹 + 高光斜切 + 金三角标记 */
function dieUnit(x: number, y: number, w: number, h: number, pal: Palette, morph: number): string {
  const a = pal.accent
  const rows = 2 + Math.floor(morph * 2) // 2..3 行蚀刻块
  const cols = 3 + Math.floor(morph * 3) // 3..5 列
  const etch = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const bw = (w - 16) / cols
      const bh = (h - 16) / rows
      return `<rect x="${f(x + 8 + c * bw + 1)}" y="${f(y + 8 + r * bh + 1)}" width="${f(bw - 2)}" height="${f(bh - 2)}" fill="#0a0e12" opacity="${0.18 + ((r * cols + c) % 3) * 0.09}"/>`
    }).join(''),
  ).join('')
  return (
    `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="3" fill="url(#die-grad)" stroke="${a}" stroke-width="2"/>` +
    etch +
    `<polygon points="${f(x + w * 0.12)},${f(y + 2)} ${f(x + w * 0.12 + w * 0.22)},${f(y + 2)} ${f(x + w * 0.12 - w * 0.1)},${f(y + h * 0.9)} ${f(x + w * 0.12 - w * 0.16)},${f(y + h * 0.9)}" fill="#ffffff" opacity="0.14"/>` +
    `<polygon points="${f(x + 4)},${f(y + 4)} ${f(x + 14)},${f(y + 4)} ${f(x + 4)},${f(y + 14)}" fill="${a}"/>`
  )
}

/** U 形热管（铜管渐变 + 内高光） */
function heatPipe(x: number, yTop: number, yBottom: number, halfSpan: number): string {
  const d =
    `M ${f(x - halfSpan)} ${f(yBottom)} L ${f(x - halfSpan)} ${f(yTop + halfSpan)}` +
    ` A ${f(halfSpan)} ${f(halfSpan)} 0 0 1 ${f(x + halfSpan)} ${f(yTop + halfSpan)}` +
    ` L ${f(x + halfSpan)} ${f(yBottom)}`
  return (
    `<path d="${d}" fill="none" stroke="url(#gold-grad)" stroke-width="9" opacity="0.9"/>` +
    `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="2.2" opacity="0.25"/>`
  )
}

/** 软管（粗曲线 + 内高光） */
function hose(x0: number, y0: number, x1: number, y1: number, bend: number, pal: Palette): string {
  const d = `M ${f(x0)} ${f(y0)} C ${f(x0)} ${f(y0 + bend)} ${f(x1)} ${f(y1 + bend)} ${f(x1)} ${f(y1)}`
  return (
    `<path d="${d}" fill="none" stroke="${shade(pal.primary, 0.45)}" stroke-width="13" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="${shade(pal.primary, 1.2)}" stroke-width="4" stroke-linecap="round" opacity="0.5"/>`
  )
}

// —— 3.1 各形制渲染器 ——

/** gpu_fans：显卡正面照——金属罩 + 清晰可数的风扇阵 + 供电/挡板细节 */
function renderGpuFans(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const n = params.fanCount
  const r = n === 1 ? 116 : n === 2 ? 92 : 63
  const xs = n === 1 ? [256] : n === 2 ? [161, 351] : [117, 256, 395]
  const fans = xs
    .map((x, i) => {
      const tilt = (params.morph2 * 2 - 1) * 6 + (i - (n - 1) / 2) * 2
      return fanUnit(x, ACY, r, params.bladeCount, pal, params.morph, tilt)
    })
    .join('')
  const grooves =
    n > 1
      ? xs
          .slice(0, -1)
          .map((x, i) => {
            const mx = (x + (xs[i + 1] ?? x)) / 2
            return (
              `<line x1="${f(mx)}" y1="106" x2="${f(mx)}" y2="394" stroke="${shade(p, 0.7)}" stroke-width="2.5" opacity="0.4"/>` +
              `<line x1="${f(mx + 4)}" y1="106" x2="${f(mx + 4)}" y2="394" stroke="${shade(p, 1.3)}" stroke-width="1" opacity="0.25"/>`
            )
          })
          .join('')
      : ''
  const bracket = [140, 190, 240]
    .map((y) => `<rect x="34" y="${y}" width="12" height="26" fill="#20262c" stroke="${shade(p, 0.8)}" stroke-width="1.5"/>`)
    .join('')
  const power = [296, 336]
    .map((x) => `<rect x="${x}" y="72" width="34" height="16" rx="3" fill="url(#pin-grad)" stroke="${shade(p, 0.5)}" stroke-width="1.2"/>`)
    .join('')
  const screws = [
    [58, 96],
    [454, 96],
    [58, 404],
    [454, 404],
  ]
    .map(([x, y]) => screw(x ?? 0, y ?? 0, 4.5, pal))
    .join('')
  return metalBody(46, 84, 420, 332, 18, pal) + bracket + power + fans + grooves + screws
}

/** gpu_blower：涡轮卡——鳍片塔 + 单涡轮 + 底部出风槽 */
function renderGpuBlower(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const finCount = 12 + Math.floor(params.morph * 6) // 12..17
  const fins = finsV(84, 128, 372, finCount, 152, pal)
  const rails =
    `<rect x="76" y="108" width="168" height="20" rx="4" fill="${shade(p, 0.5)}" stroke="${shade(p, 0.8)}" stroke-width="1.5"/>` +
    `<rect x="76" y="372" width="168" height="20" rx="4" fill="${shade(p, 0.5)}" stroke="${shade(p, 0.8)}" stroke-width="1.5"/>`
  const exhaust =
    `<rect x="140" y="396" width="232" height="16" rx="8" fill="none" stroke="${pal.accent}" stroke-width="2.5"/>` +
    [0, 1, 2].map((i) => `<rect x="${f(160 + i * 70)}" y="401" width="46" height="6" rx="3" fill="${shade(p, 0.8)}" opacity="0.7"/>`).join('')
  const power = [330, 366]
    .map((x) => `<rect x="${x}" y="76" width="30" height="14" rx="3" fill="url(#pin-grad)" stroke="${shade(p, 0.5)}" stroke-width="1.2"/>`)
    .join('')
  return (
    metalBody(56, 88, 400, 324, 16, pal) +
    rails +
    fins +
    fanUnit(356, ACY, 104, params.bladeCount, pal, params.morph, (params.morph2 * 2 - 1) * 7) +
    exhaust +
    power +
    screw(70, 100, 4, pal) +
    screw(442, 400, 4, pal)
  )
}

/** chip_die：基板 + 四边金针 + 硅片（引脚/基板分明）；cpu_dieshot 变体 = 多 tile 晶圆照 */
function renderChipDie(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const subX = 78
  const subY = 138
  const subW = 356
  const subH = 224
  const pinCount = 13 + Math.floor(params.morph * 4) // 13..16
  const pinSpan = 312
  const pinsTopBottom = Array.from({ length: pinCount }, (_, i) => {
    const x = 100 + (i * pinSpan) / (pinCount - 1)
    return (
      `<rect x="${f(x - 3.5)}" y="118" width="7" height="20" rx="1.5" fill="url(#pin-grad)"/>` +
      `<rect x="${f(x - 3.5)}" y="${f(subY + subH)}" width="7" height="20" rx="1.5" fill="url(#pin-grad)"/>`
    )
  }).join('')
  const sidePins = Array.from({ length: 6 }, (_, i) => {
    const y = 172 + i * 30
    return (
      `<rect x="58" y="${f(y)}" width="20" height="7" rx="1.5" fill="url(#pin-grad)"/>` +
      `<rect x="${f(subX + subW)}" y="${f(y)}" width="20" height="7" rx="1.5" fill="url(#pin-grad)"/>`
    )
  }).join('')
  const caps = capRow(150, 156, 5, 14, 8, 16, pal) + capRow(190, 338, 5, 14, 8, 16, pal)
  let dies: string
  if (params.variant === 'cpu_dieshot') {
    // dieshot：3×3 tile 阵，亮度错落（确定性）
    dies = Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 3 }, (_, c) => {
        const tx = 172 + c * 62
        const ty = 180 + r * 60
        return (
          `<rect x="${f(tx)}" y="${f(ty)}" width="54" height="52" rx="3" fill="${shade(p, 0.55 + ((r * 3 + c) % 4) * 0.18)}" stroke="#0a0e12" stroke-width="1"/>` +
          `<rect x="${f(tx + 6)}" y="${f(ty + 6)}" width="42" height="40" fill="#0a0e12" opacity="0.16"/>`
        )
      }).join(''),
    ).join('')
  } else if (params.dieCount === 2) {
    dies = dieUnit(150, 190, 96, 120, pal, params.morph) + dieUnit(266, 190, 96, 120, pal, 1 - params.morph)
  } else {
    dies = dieUnit(196, 190, 120, 120, pal, params.morph)
  }
  return (
    `<rect x="${f(subX)}" y="${f(subY)}" width="${f(subW)}" height="${f(subH)}" rx="12" fill="#0d1218" stroke="${p}" stroke-width="3"/>` +
    `<rect x="${f(subX + 5)}" y="${f(subY + 5)}" width="${f(subW - 10)}" height="${f(subH - 10)}" rx="9" fill="none" stroke="${shade(p, 1.35)}" stroke-width="1" opacity="0.5"/>` +
    `<polygon points="${f(subX + 8)},${f(subY + 8)} ${f(subX + 20)},${f(subY + 8)} ${f(subX + 8)},${f(subY + 20)}" fill="${a}"/>` +
    pinsTopBottom +
    sidePins +
    caps +
    dies +
    `<circle cx="430" cy="152" r="4" fill="none" stroke="${s}" stroke-width="1.5"/>`
  )
}

/** disc：光驱盘片——盘体 + 数据环带 + 高光弧；spell_donut 变体 = 彩糖甜甜圈 */
function renderDisc(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  if (params.variant === 'spell_donut') {
    const sprinkle = (i: number): string => {
      const ang = (i * 137.5 + params.morph * 90) * (Math.PI / 180)
      const [sx, sy] = pt(ACX, ACY, ang, 118)
      const color = hslToHex((i * 29 + (params.seed % 360)) % 360, 0.75, 0.6)
      return `<rect x="${f(sx - 4)}" y="${f(sy - 1.5)}" width="8" height="3" rx="1.5" fill="${color}" transform="rotate(${f((i * 137.5 + params.morph * 90) % 360)} ${f(sx)} ${f(sy)})"/>`
    }
    return (
      `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="118" fill="none" stroke="url(#blade-grad)" stroke-width="64"/>` +
      `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="150" fill="none" stroke="${shade(s, 1.3)}" stroke-width="2.5" opacity="0.8"/>` +
      `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="86" fill="none" stroke="${shade(s, 0.6)}" stroke-width="2.5" opacity="0.8"/>` +
      Array.from({ length: 14 }, (_, i) => sprinkle(i)).join('') +
      `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="52" fill="#0d1116" stroke="${a}" stroke-width="3"/>` +
      `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="10" fill="${a}" opacity="0.9"/>`
    )
  }
  const ringCount = 9 + Math.floor(params.morph * 6) // 9..14
  const rings = Array.from({ length: ringCount }, (_, i) => {
    const rr = 62 + (i * 78) / (ringCount - 1)
    return `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="${f(rr)}" fill="none" stroke="${p}" stroke-width="1" opacity="${i % 3 === 0 ? 0.35 : 0.2}"/>`
  }).join('')
  return (
    `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="152" fill="#0d1116" fill-opacity="0.92" stroke="url(#rim-grad)" stroke-width="5"/>` +
    rings +
    `<path d="M ${f(ACX + 20)} ${f(ACY - 130)} A 132 132 0 0 1 ${f(ACX + 120)} ${f(ACY - 62)} L ${f(ACX + 96)} ${f(ACY - 40)} A 104 104 0 0 0 ${f(ACX + 22)} ${f(ACY - 100)} Z" fill="#ffffff" opacity="0.05"/>` +
    `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="56" fill="${shade(p, 0.3)}" fill-opacity="0.55" stroke="${p}" stroke-width="1.5"/>` +
    `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="30" fill="none" stroke="${shade(p, 1.2)}" stroke-width="1" opacity="0.5"/>` +
    `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="22" fill="#0a0e12" stroke="${a}" stroke-width="3"/>` +
    `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="7" fill="#05070a"/>` +
    `<path d="M ${f(ACX - 146)} ${f(ACY - 34)} A 150 150 0 0 1 ${f(ACX - 78)} ${f(ACY - 129)}" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.3" stroke-linecap="round"/>`
  )
}

/** connector：PCIe 金手指 / power_connector 供电插座 / display_out 视频输出口 */
function renderConnector(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const a = pal.accent
  if (params.variant === 'power_connector') {
    const sockets = [0, 1, 2, 3].map((r) =>
      [0, 1, 2, 3]
        .map((c) => {
          const sx = 178 + c * 42
          const sy = 178 + r * 62
          return (
            `<rect x="${f(sx)}" y="${f(sy)}" width="34" height="40" rx="6" fill="#05070a" stroke="${shade(p, 0.9)}" stroke-width="2"/>` +
            `<rect x="${f(sx + 9)}" y="${f(sy + 12)}" width="16" height="16" rx="2" fill="url(#pin-grad)"/>`
          )
        })
        .join(''),
    ).join('')
    const latch = `<rect x="336" y="238" width="26" height="24" rx="4" fill="#20262c" stroke="${shade(p, 0.8)}" stroke-width="1.5"/>`
    const wires = [0, 1, 2]
      .map(
        (i) =>
          `<path d="M ${f(200 + i * 56)} 150 Q ${f(196 + i * 56)} 118 ${f(212 + i * 56)} 96" fill="none" stroke="${shade(p, 0.7)}" stroke-width="7" stroke-linecap="round" opacity="0.85"/>`,
      )
      .join('')
    return metalBody(166, 150, 180, 190, 14, pal) + sockets + latch + wires
  }
  if (params.variant === 'display_out') {
    const shell = `<polygon points="146,190 366,190 366,300 178,300 146,268" fill="#0d1218" stroke="${p}" stroke-width="3"/>`
    const innerHdmi =
      `<rect x="176" y="214" width="160" height="62" rx="6" fill="#05070a" stroke="${a}" stroke-width="2"/>` +
      Array.from({ length: 10 }, (_, i) => `<rect x="${f(184 + i * 15.4)}" y="222" width="6" height="18" fill="url(#pin-grad)"/>`).join('') +
      Array.from({ length: 8 }, (_, i) => `<rect x="${f(196 + i * 13.6)}" y="248" width="6" height="18" fill="url(#pin-grad)"/>`).join('')
    const ribs = [0, 1, 2]
      .map((i) => `<line x1="${f(158 + i * 4)}" y1="200" x2="${f(158 + i * 4)}" y2="262" stroke="${shade(p, 0.8)}" stroke-width="2" opacity="0.6"/>`)
      .join('')
    return shell + innerHdmi + ribs + `<rect x="296" y="252" width="54" height="10" rx="4" fill="${shade(p, 0.55)}" stroke="${shade(p, 0.85)}" stroke-width="1.2"/>`
  }
  // 默认：PCIe 金手指
  const fingerCount = 15
  const fingers = goldFingers(142, 296, fingerCount, 9, 6.2, 96, 58, 6)
  const ribs = Array.from({ length: 8 }, (_, i) => `<line x1="${f(140 + i * 32)}" y1="140" x2="${f(140 + i * 32)}" y2="204" stroke="${shade(p, 0.8)}" stroke-width="2" opacity="0.35"/>`).join('')
  return (
    metalBody(128, 132, 256, 230, 10, pal) +
    ribs +
    `<rect x="240" y="118" width="32" height="16" rx="3" fill="#05070a" stroke="${p}" stroke-width="1.5"/>` +
    `<line x1="136" y1="288" x2="376" y2="288" stroke="${shade(p, 1.3)}" stroke-width="1.2" opacity="0.5"/>` +
    fingers +
    `<rect x="${f(142 + 6 * 15.2 - 2)}" y="288" width="18" height="12" fill="#0a0e12"/>`
  )
}

/** board：主板 / 内存条 / 笔记本盖板 / 楔形机身 / 迷你主机 / 交换机 / 延长线 / 裸板 */
function renderBoard(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const v = params.variant
  if (v === 'ram_stick') {
    const chips = [0, 1, 2, 3].map((c) =>
      [0, 1]
        .map((r) => {
          const cx2 = 192 + c * 38
          const cy2 = 250 + r * 46
          return (
            `<rect x="${f(cx2)}" y="${f(cy2)}" width="30" height="36" rx="2" fill="#151a20" stroke="${shade(p, 0.7)}" stroke-width="1.2"/>` +
            `<circle cx="${f(cx2 + 15)}" cy="${f(cy2 + 18)}" r="3" fill="${shade(p, 1.2)}" opacity="0.7"/>`
          )
        })
        .join(''),
    ).join('')
    const fingers = goldFingers(184, 396, 24, 4.5, 1.5, 16, 16, 7)
    return (
      metalBody(176, 96, 160, 300, 6, pal) +
      `<rect x="184" y="104" width="144" height="14" rx="3" fill="url(#rgb-grad)" opacity="0.92"/>` +
      `<rect x="184" y="124" width="144" height="110" rx="4" fill="url(#body-grad)" stroke="${shade(p, 0.6)}" stroke-width="1.5"/>` +
      [0, 1, 2, 3, 4]
        .map((i) => `<line x1="${f(192 + i * 28)}" y1="128" x2="${f(176 + i * 34)}" y2="230" stroke="${shade(p, 1.1)}" stroke-width="2" opacity="0.3"/>`)
        .join('') +
      `<rect x="192" y="180" width="128" height="44" rx="3" fill="none" stroke="${shade(p, 0.9)}" stroke-width="1" opacity="0.6"/>` +
      `<line x1="200" y1="194" x2="312" y2="194" stroke="${shade(p, 1.2)}" stroke-width="2" opacity="0.5"/>` +
      `<line x1="200" y1="206" x2="288" y2="206" stroke="${shade(p, 1.2)}" stroke-width="2" opacity="0.35"/>` +
      chips +
      fingers
    )
  }
  if (v === 'macbook_pro_lid') {
    return (
      `<rect x="98" y="88" width="316" height="320" rx="30" fill="url(#cyl-grad)" stroke="${p}" stroke-width="2.5"/>` +
      `<rect x="108" y="98" width="296" height="300" rx="24" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1.5"/>` +
      `<circle cx="256" cy="240" r="70" fill="url(#sk-halo)" opacity="0.35"/>` +
      `<circle cx="256" cy="240" r="40" fill="${a}" fill-opacity="0.18" stroke="${a}" stroke-width="3"/>` +
      `<circle cx="256" cy="116" r="3" fill="${a}" opacity="0.8"/>` +
      `<rect x="150" y="404" width="212" height="10" rx="4" fill="#20262c" stroke="${shade(p, 0.8)}" stroke-width="1"/>`
    )
  }
  if (v === 'macbook_air_wedge') {
    return (
      `<polygon points="96,248 416,248 442,332 70,332" fill="url(#cyl-grad)" stroke="${p}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<line x1="100" y1="254" x2="412" y2="254" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1.5"/>` +
      `<line x1="120" y1="332" x2="392" y2="332" stroke="${a}" stroke-width="3" opacity="0.7"/>` +
      `<circle cx="256" cy="292" r="8" fill="${a}" opacity="0.5"/>` +
      `<rect x="66" y="288" width="10" height="26" fill="#05070a" stroke="${p}" stroke-width="1"/>` +
      `<rect x="436" y="288" width="10" height="26" fill="#05070a" stroke="${p}" stroke-width="1"/>`
    )
  }
  if (v === 'mini_pc') {
    const vents = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 6 }, (_, c) => `<circle cx="${f(164 + c * 16)}" cy="${f(200 + r * 26)}" r="2.4" fill="${shade(p, 1.1)}" opacity="0.45"/>`).join(''),
    ).join('')
    const ports = [0, 1, 2]
      .map((i) => `<rect x="330" y="${f(196 + i * 30)}" width="34" height="18" rx="2" fill="#05070a" stroke="${shade(p, 0.85)}" stroke-width="1.5"/>`)
      .join('')
    return (
      metalBody(136, 150, 240, 210, 16, pal) +
      `<rect x="136" y="150" width="240" height="26" rx="13" fill="#ffffff" opacity="0.05"/>` +
      vents +
      ports +
      `<circle cx="347" cy="306" r="9" fill="none" stroke="${a}" stroke-width="2"/>` +
      `<circle cx="347" cy="306" r="2.5" fill="${a}"/>`
    )
  }
  if (v === 'switch_pcb') {
    const ports = Array.from({ length: 8 }, (_, i) => {
      const x = 84 + i * 46
      return (
        `<rect x="${f(x)}" y="170" width="40" height="44" rx="3" fill="#0a0e12" stroke="${shade(p, 0.9)}" stroke-width="2"/>` +
        `<rect x="${f(x + 6)}" y="176" width="28" height="14" fill="#05070a"/>` +
        Array.from({ length: 4 }, (_, c) => `<rect x="${f(x + 7 + c * 7)}" y="208" width="4.5" height="6" fill="url(#pin-grad)"/>`).join('') +
        `<rect x="${f(x + 8)}" y="164" width="5" height="4" fill="${a}"/>` +
        `<rect x="${f(x + 16)}" y="164" width="5" height="4" fill="${s}"/>`
      )
    }).join('')
    return (
      `<rect x="62" y="150" width="388" height="190" rx="10" fill="#0d1418" stroke="${p}" stroke-width="3"/>` +
      `<rect x="70" y="158" width="372" height="174" rx="7" fill="none" stroke="${shade(p, 1.3)}" stroke-width="1" opacity="0.4"/>` +
      ports +
      `<rect x="352" y="248" width="70" height="52" rx="4" fill="${p}" fill-opacity="0.8" stroke="${a}" stroke-width="1.5"/>` +
      `<line x1="80" y1="300" x2="200" y2="300" stroke="${shade(p, 1.1)}" stroke-width="1.5" opacity="0.4"/>` +
      `<line x1="80" y1="308" x2="160" y2="308" stroke="${shade(p, 1.1)}" stroke-width="1.5" opacity="0.3"/>`
    )
  }
  if (v === 'riser_pcb') {
    const fingers = goldFingers(124, 310, 26, 6, 3.6, 22, 22, -1)
    return (
      metalBody(116, 120, 280, 190, 10, pal) +
      `<rect x="140" y="150" width="232" height="26" rx="4" fill="url(#body-grad)" stroke="${a}" stroke-width="2"/>` +
      `<rect x="262" y="156" width="14" height="14" fill="#0a0e12"/>` +
      capRow(150, 210, 4, 16, 9, 18, pal) +
      `<circle cx="348" cy="230" r="12" fill="none" stroke="${shade(p, 0.9)}" stroke-width="2"/>` +
      `<path d="M 150 246 L 230 246 L 246 262 L 360 262" fill="none" stroke="${shade(p, 1.1)}" stroke-width="1.5" opacity="0.4"/>` +
      fingers
    )
  }
  if (v === 'gpu_bare_board') {
    const vram = Array.from({ length: 6 }, (_, i) => {
      const x = 120 + i * 48
      return `<rect x="${f(x)}" y="150" width="38" height="30" rx="2" fill="#151a20" stroke="${shade(p, 0.7)}" stroke-width="1.2"/>`
    }).join('')
    return (
      metalBody(66, 104, 380, 296, 10, pal) +
      dieUnit(216, 214, 116, 96, pal, params.morph) +
      vram +
      goldFingers(116, 386, 20, 9, 6.8, 16, 16, 6) +
      `<rect x="66" y="150" width="14" height="90" fill="#20262c" stroke="${shade(p, 0.8)}" stroke-width="1.2"/>` +
      [0, 1, 2, 3].map((i) => `<circle cx="${f(108 + i * 28)}" cy="336" r="6" fill="none" stroke="${a}" stroke-width="1.6"/>`).join('') +
      screw(84, 122, 4.5, pal) +
      screw(428, 122, 4.5, pal)
    )
  }
  // 默认：ATX/mATX 主板
  const matx = v === 'motherboard_matx'
  const scale = matx ? 0.88 : 1
  const inner = (g: string): string =>
    matx ? `<g transform="translate(256 250) scale(${f(scale)}) translate(-256 -250)">${g}</g>` : g
  const boardBody =
    `<rect x="64" y="102" width="384" height="296" rx="10" fill="#0d1418" stroke="${p}" stroke-width="3"/>` +
    `<rect x="72" y="110" width="368" height="280" rx="7" fill="none" stroke="${shade(p, 1.3)}" stroke-width="1" opacity="0.4"/>` +
    // CPU 插座
    `<rect x="110" y="132" width="104" height="104" rx="4" fill="#0a0e12" stroke="${a}" stroke-width="2"/>` +
    Array.from({ length: 4 }, (_, r) =>
      Array.from({ length: 4 }, (_, c) => `<rect x="${f(120 + c * 23)}" y="${f(142 + r * 23)}" width="12" height="12" fill="${shade(p, 0.9)}" opacity="0.6"/>`).join(''),
    ).join('') +
    `<line x1="218" y1="138" x2="218" y2="230" stroke="${s}" stroke-width="3"/>` +
    // 内存槽
    [0, 1, 2]
      .map(
        (i) =>
          `<rect x="${f(300 + i * 26)}" y="124" width="16" height="150" rx="2" fill="${s}" fill-opacity="0.7" stroke="${p}" stroke-width="1.5"/>` +
          `<rect x="${f(306 + i * 26)}" y="130" width="4" height="10" fill="#0a0e12"/>`,
      )
      .join('') +
    // PCIe 槽
    `<rect x="104" y="298" width="220" height="14" rx="2" fill="${s}" fill-opacity="0.7" stroke="${p}" stroke-width="1.5"/>` +
    `<rect x="104" y="326" width="170" height="12" rx="2" fill="${s}" fill-opacity="0.7" stroke="${p}" stroke-width="1.5"/>` +
    // 芯片组散热片
    `<rect x="330" y="280" width="84" height="84" rx="6" fill="url(#body-grad)" stroke="${p}" stroke-width="2"/>` +
    finsH(338, 406, 290, 5, 62, pal) +
    // IO 挡板
    `<rect x="64" y="132" width="34" height="120" fill="#20262c" stroke="${shade(p, 0.8)}" stroke-width="1.5"/>` +
    [0, 1, 2]
      .map((i) => `<rect x="70" y="${f(142 + i * 38)}" width="22" height="26" fill="#05070a" stroke="${shade(p, 0.7)}" stroke-width="1"/>`)
      .join('') +
    capRow(96, 258, 6, 12, 8, 14, pal) +
    `<path d="M 150 240 L 220 240 L 240 260 L 330 260" fill="none" stroke="${shade(p, 1.1)}" stroke-width="2" opacity="0.3"/>` +
    `<path d="M 150 262 L 200 262 L 220 282 L 320 282" fill="none" stroke="${shade(p, 1.1)}" stroke-width="2" opacity="0.25"/>` +
    screw(84, 122, 4.5, pal) +
    screw(428, 122, 4.5, pal) +
    screw(84, 378, 4.5, pal) +
    screw(428, 378, 4.5, pal)
  return inner(boardBody)
}

/** cooler：散热塔 / 冷排 + 水泵 / 散热罩 */
function renderCooler(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const a = pal.accent
  const v = params.variant
  if (v === 'aio_radiator') {
    const finCount = 20 + Math.floor(params.morph * 6)
    const fins = finsV(78, 120, 276, finCount, 356, pal, 2.5)
    return (
      metalBody(62, 108, 388, 180, 10, pal) +
      `<rect x="70" y="116" width="372" height="164" rx="6" fill="none" stroke="${shade(p, 1.3)}" stroke-width="1" opacity="0.35"/>` +
      fins +
      hose(120, 288, 236, 372, 44, pal) +
      hose(392, 288, 276, 372, 44, pal) +
      `<circle cx="256" cy="378" r="38" fill="url(#body-grad)" stroke="url(#rim-grad)" stroke-width="4"/>` +
      `<circle cx="256" cy="378" r="26" fill="none" stroke="${a}" stroke-width="2"/>` +
      `<path d="M 244 372 A 14 14 0 0 1 268 378" fill="none" stroke="${shade(p, 1.3)}" stroke-width="2.5" opacity="0.7"/>` +
      `<circle cx="256" cy="378" r="4" fill="${a}"/>`
    )
  }
  if (v === 'cooler_shroud') {
    const finsL = finsV(84, 140, 370, 5, 66, pal)
    const finsR = finsV(362, 140, 370, 5, 66, pal)
    return (
      metalBody(70, 110, 372, 292, 14, pal) +
      finsL +
      finsR +
      fanUnit(256, 254, 96, params.bladeCount, pal, params.morph, (params.morph2 * 2 - 1) * 7) +
      heatPipe(200, 330, 380, 13) +
      heatPipe(312, 330, 380, 13) +
      screw(88, 128, 4.5, pal) +
      screw(424, 128, 4.5, pal)
    )
  }
  // 默认：塔式散热器
  const finCount = 13 + Math.floor(params.morph * 5) // 13..17
  const pipes = [0, 1, 2, 3].map((i) => heatPipe(190 + i * 40, 116, 354, 12)).join('')
  return (
    metalBody(150, 352, 212, 30, 6, pal) +
    pipes +
    finsH(150, 362, 118, finCount, 226, pal) +
    `<rect x="150" y="112" width="212" height="4" fill="${shade(p, 0.6)}" opacity="0.8"/>` +
    `<rect x="150" y="104" width="212" height="12" rx="4" fill="url(#body-grad)" stroke="${p}" stroke-width="1.5"/>`
  )
}

/** peripheral：外设五变体——形体直白（椅/鼠/键盘/柜台/质保卡） */
function renderPeripheral(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const v = params.variant
  if (v === 'gaming_chair') {
    const base = [0, 1, 2, 3, 4]
      .map((i) => {
        const ang = (i * 72 - 90) * (Math.PI / 180)
        const [ex, ey] = pt(256, 384, ang, 58)
        return `<line x1="256" y1="384" x2="${f(ex)}" y2="${f(ey)}" stroke="${shade(p, 0.8)}" stroke-width="5" stroke-linecap="round"/>` + `<circle cx="${f(ex)}" cy="${f(ey)}" r="6" fill="#0a0e12" stroke="${p}" stroke-width="1.5"/>`
      })
      .join('')
    return (
      // 靠背 + 侧翼
      `<rect x="176" y="92" width="160" height="188" rx="24" fill="url(#body-grad)" stroke="${p}" stroke-width="3"/>` +
      `<rect x="160" y="120" width="26" height="130" rx="12" fill="${shade(p, 0.45)}" stroke="${p}" stroke-width="2"/>` +
      `<rect x="326" y="120" width="26" height="130" rx="12" fill="${shade(p, 0.45)}" stroke="${p}" stroke-width="2"/>` +
      `<rect x="196" y="102" width="120" height="38" rx="14" fill="${shade(p, 0.55)}" stroke="${p}" stroke-width="1.5"/>` +
      `<line x1="242" y1="100" x2="242" y2="270" stroke="${a}" stroke-width="6" opacity="0.8"/>` +
      `<line x1="270" y1="100" x2="270" y2="270" stroke="${a}" stroke-width="6" opacity="0.8"/>` +
      // 坐垫
      `<rect x="150" y="274" width="212" height="52" rx="18" fill="url(#body-grad)" stroke="${p}" stroke-width="3"/>` +
      // 气杆 + 五星脚
      `<polygon points="246,326 266,326 262,384 250,384" fill="${shade(p, 0.5)}" stroke="${p}" stroke-width="1.5"/>` +
      base
    )
  }
  if (v === 'keyboard_deck') {
    const keys = [0, 1, 2, 3]
      .map((r) =>
        Array.from({ length: 10 }, (_, c) => {
          const kx = 116 + c * 29
          const ky = 136 + r * 40
          const accentKey = r === 0 && c === 0
          return `<rect x="${f(kx)}" y="${f(ky)}" width="25" height="34" rx="4" fill="${accentKey ? a : shade(p, 0.4)}" fill-opacity="${accentKey ? 0.85 : 0.9}" stroke="${shade(p, 0.9)}" stroke-width="1.2"/>`
        }).join(''),
      )
      .join('')
    return (
      metalBody(96, 118, 320, 236, 12, pal) +
      keys +
      `<rect x="196" y="296" width="120" height="34" rx="5" fill="${shade(p, 0.4)}" stroke="${shade(p, 0.9)}" stroke-width="1.2"/>` +
      `<line x1="106" y1="344" x2="406" y2="344" stroke="${a}" stroke-width="4" opacity="0.85"/>` +
      `<line x1="106" y1="344" x2="406" y2="344" stroke="${a}" stroke-width="10" opacity="0.2"/>`
    )
  }
  if (v === 'genius_counter') {
    return (
      // 招牌
      `<rect x="146" y="100" width="220" height="96" rx="12" fill="url(#body-grad)" stroke="${p}" stroke-width="3"/>` +
      `<rect x="158" y="112" width="196" height="72" rx="8" fill="none" stroke="${a}" stroke-width="1.5" stroke-dasharray="6 4"/>` +
      `<line x1="176" y1="132" x2="336" y2="132" stroke="${shade(p, 1.2)}" stroke-width="7" opacity="0.75"/>` +
      `<line x1="176" y1="152" x2="308" y2="152" stroke="${shade(p, 1.2)}" stroke-width="7" opacity="0.5"/>` +
      `<line x1="176" y1="172" x2="326" y2="172" stroke="${shade(p, 1.2)}" stroke-width="7" opacity="0.35"/>` +
      `<circle cx="352" cy="196" r="12" fill="none" stroke="${a}" stroke-width="2.5"/>` +
      // 柜台
      `<rect x="86" y="248" width="340" height="56" rx="8" fill="url(#cyl-grad)" stroke="${p}" stroke-width="2.5"/>` +
      `<rect x="106" y="304" width="300" height="76" rx="6" fill="${shade(p, 0.35)}" stroke="${p}" stroke-width="2"/>` +
      `<line x1="120" y1="330" x2="392" y2="330" stroke="${shade(p, 1.1)}" stroke-width="2" opacity="0.4"/>` +
      `<line x1="120" y1="352" x2="392" y2="352" stroke="${shade(p, 1.1)}" stroke-width="2" opacity="0.3"/>` +
      // 工牌
      `<rect x="238" y="222" width="36" height="26" rx="4" fill="${s}" stroke="${a}" stroke-width="1.5"/>`
    )
  }
  if (v === 'warranty_card') {
    const tilt = (params.morph3 * 2 - 1) * 3
    return (
      `<g transform="rotate(${f(tilt)} 256 250)">` +
      `<rect x="126" y="130" width="260" height="240" rx="12" fill="#0d1218" stroke="${p}" stroke-width="3"/>` +
      `<polygon points="386,130 386,162 354,130" fill="${a}" opacity="0.85"/>` +
      `<line x1="148" y1="164" x2="300" y2="164" stroke="${shade(p, 1.2)}" stroke-width="4" opacity="0.7"/>` +
      `<line x1="148" y1="186" x2="268" y2="186" stroke="${shade(p, 1.2)}" stroke-width="4" opacity="0.5"/>` +
      `<line x1="148" y1="208" x2="288" y2="208" stroke="${shade(p, 1.2)}" stroke-width="4" opacity="0.35"/>` +
      // 印章
      `<circle cx="330" cy="298" r="46" fill="none" stroke="${a}" stroke-width="4" opacity="0.85"/>` +
      `<circle cx="330" cy="298" r="34" fill="none" stroke="${a}" stroke-width="1.5" opacity="0.6"/>` +
      `<path d="M 306 298 L 326 282 L 342 310 L 354 290" fill="none" stroke="${a}" stroke-width="3" opacity="0.85" stroke-linecap="round"/>` +
      // 条码
      Array.from({ length: 12 }, (_, i) => `<rect x="${f(148 + i * 7)}" y="318" width="${i % 3 === 0 ? 3 : 1.6}" height="34" fill="${shade(p, 1.15)}" opacity="0.75"/>`).join('') +
      `</g>`
    )
  }
  // 默认（gaming_mouse 等）：游戏鼠标俯视——形体直白
  const wheelY = 176 + Math.round(params.morph3 * 8)
  return (
    `<path d="M 256 122 C 350 122 366 240 352 330 C 340 392 172 392 160 330 C 146 240 162 122 256 122 Z" fill="url(#body-grad)" stroke="${p}" stroke-width="3"/>` +
    `<line x1="256" y1="126" x2="256" y2="240" stroke="${shade(p, 0.8)}" stroke-width="2" opacity="0.7"/>` +
    `<path d="M 170 250 Q 256 268 342 250" fill="none" stroke="${shade(p, 0.7)}" stroke-width="1.5" opacity="0.5"/>` +
    `<rect x="246" y="${f(wheelY)}" width="20" height="46" rx="9" fill="#0a0e12" stroke="${a}" stroke-width="2.5"/>` +
    Array.from({ length: 4 }, (_, i) => `<line x1="250" y1="${f(wheelY + 8 + i * 9)}" x2="262" y2="${f(wheelY + 8 + i * 9)}" stroke="${shade(p, 1.2)}" stroke-width="1.2" opacity="0.7"/>`).join('') +
    `<path d="M 176 356 Q 256 386 336 356" fill="none" stroke="${a}" stroke-width="9" opacity="0.25"/>` +
    `<path d="M 176 356 Q 256 386 336 356" fill="none" stroke="${a}" stroke-width="3.5" opacity="0.95"/>` +
    `<circle cx="220" cy="300" r="3" fill="${s}"/>`
  )
}

/** wave：示波器 / 闪电 / RGB 灯带 / 波形 */
function renderWave(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const a = pal.accent
  const v = params.variant
  if (v === 'spell_bolt') {
    const bolt = `M 296 84 L 218 226 L 262 226 L 190 420 L 268 262 L 224 262 L 318 128 Z`
    return (
      `<path d="${bolt}" fill="${a}" fill-opacity="0.16" stroke="${a}" stroke-width="10" stroke-linejoin="round" opacity="0.3"/>` +
      `<path d="${bolt}" fill="${a}" fill-opacity="0.95" stroke="${shade(a, 1.3)}" stroke-width="1.5" stroke-linejoin="round"/>` +
      `<polyline points="262,226 310,266 292,296" fill="none" stroke="${a}" stroke-width="3" opacity="0.7" stroke-linecap="round"/>` +
      `<circle cx="340" cy="150" r="3" fill="${a}" opacity="0.7"/>` +
      `<circle cx="180" cy="140" r="2.2" fill="${a}" opacity="0.5"/>`
    )
  }
  if (v === 'rgb_strip') {
    const segs = Array.from({ length: 12 }, (_, i) => {
      const x = 76 + i * 30.6
      const color = hslToHex((i * 30 + (params.seed % 360)) % 360, 0.8, 0.55)
      return (
        `<rect x="${f(x)}" y="226" width="24" height="32" rx="4" fill="${color}" opacity="0.92"/>` +
        `<circle cx="${f(x + 12)}" cy="222" r="2.2" fill="${color}"/>`
      )
    }).join('')
    return (
      `<rect x="64" y="216" width="384" height="52" rx="14" fill="#0b0f14" stroke="${p}" stroke-width="2.5"/>` +
      segs +
      `<line x1="40" y1="242" x2="64" y2="242" stroke="${shade(p, 0.7)}" stroke-width="4"/>` +
      `<line x1="448" y1="242" x2="472" y2="242" stroke="${shade(p, 0.7)}" stroke-width="4"/>` +
      `<rect x="448" y="226" width="20" height="32" rx="4" fill="#05070a" stroke="${p}" stroke-width="1.5"/>`
    )
  }
  if (v === 'voltage_curve') {
    const grid =
      Array.from({ length: 10 }, (_, i) => `<line x1="${f(100 + i * 32)}" y1="120" x2="${f(100 + i * 32)}" y2="380" stroke="${p}" stroke-width="1" opacity="0.12"/>`).join('') +
      Array.from({ length: 8 }, (_, i) => `<line x1="88" y1="${f(132 + i * 30)}" x2="424" y2="${f(132 + i * 30)}" stroke="${p}" stroke-width="1" opacity="0.12"/>`).join('')
    const amp = 52 + params.morph2 * 28
    const freq = 28 + params.morph * 22
    const pts: string[] = []
    for (let x = 92; x <= 420; x += 12) {
      pts.push(`${f(x)} ${f(250 + Math.sin((x - 92) / freq) * amp)}`)
    }
    const wave = `<polyline points="${pts.join(' ')}" fill="none" stroke="${a}" stroke-width="9" opacity="0.22" stroke-linejoin="round"/>` + `<polyline points="${pts.join(' ')}" fill="none" stroke="${a}" stroke-width="3.5" stroke-linejoin="round"/>`
    return (
      `<rect x="76" y="108" width="360" height="284" rx="12" fill="#081018" stroke="${p}" stroke-width="3"/>` +
      grid +
      `<line x1="88" y1="250" x2="424" y2="250" stroke="#ffffff" stroke-width="1" opacity="0.2" stroke-dasharray="6 4"/>` +
      wave +
      `<rect x="88" y="120" width="52" height="14" rx="3" fill="${shade(p, 0.55)}" stroke="${shade(p, 0.9)}" stroke-width="1"/>` +
      `<circle cx="94" cy="127" r="2.5" fill="${a}"/>`
    )
  }
  // 默认：多行波形流光
  const rows = [-88, -30, 30, 88]
  return rows
    .map((o, i) => {
      const amp = (30 + params.morph * 30) * (i === 1 || i === 2 ? 1.15 : 0.8)
      const freq = 24 + params.morph2 * 14
      const pts: string[] = []
      for (let x = 56; x <= 456; x += 20) {
        pts.push(`${f(x)} ${f(ACY + o + Math.sin((x - 56) / freq + i * 1.7) * amp)}`)
      }
      const color = i === 1 || i === 2 ? a : p
      const op = i === 1 || i === 2 ? '0.95' : '0.6'
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="3" opacity="${op}" stroke-linejoin="round"/>`
    })
    .join('')
}

/** crystal：圆柱主机 / 统一内存封装 / 多面晶体 */
function renderCrystal(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const v = params.variant
  if (v === 'mac_pro_cylinder') {
    const holes = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 7 }, (_, c) => {
        const hx = 148 + c * 36
        const hy = 196 + r * 26
        return `<circle cx="${f(hx)}" cy="${f(hy)}" r="2.8" fill="#0a0e12" opacity="0.65"/>`
      }).join(''),
    ).join('')
    return (
      `<path d="M 108 168 L 108 330 A 148 40 0 0 0 404 330 L 404 168 Z" fill="url(#cyl-grad)" stroke="${p}" stroke-width="2.5"/>` +
      holes +
      `<ellipse cx="256" cy="168" rx="148" ry="40" fill="${shade(p, 0.55)}" stroke="${p}" stroke-width="2.5"/>` +
      `<ellipse cx="256" cy="168" rx="118" ry="30" fill="none" stroke="${shade(p, 1.2)}" stroke-width="1.2" opacity="0.5"/>` +
      `<rect x="216" y="104" width="80" height="18" rx="9" fill="none" stroke="${p}" stroke-width="4"/>` +
      `<line x1="130" y1="200" x2="130" y2="330" stroke="#ffffff" stroke-opacity="0.1" stroke-width="4"/>`
    )
  }
  if (v === 'unified_memory') {
    const balls = Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => `<circle cx="${f(166 + c * 26)}" cy="${f(346 + r * 13)}" r="3.5" fill="url(#pin-grad)"/>`).join(''),
    ).join('')
    return (
      `<rect x="146" y="168" width="220" height="164" rx="12" fill="#0d1218" stroke="${p}" stroke-width="3"/>` +
      dieUnit(166, 192, 80, 80, pal, params.morph) +
      dieUnit(266, 192, 80, 80, pal, 1 - params.morph) +
      `<rect x="166" y="296" width="180" height="20" rx="4" fill="none" stroke="${shade(p, 0.9)}" stroke-width="1" opacity="0.6"/>` +
      `<line x1="176" y1="306" x2="316" y2="306" stroke="${shade(p, 1.2)}" stroke-width="3" opacity="0.5"/>` +
      balls +
      `<line x1="150" y1="150" x2="166" y2="128" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/>` +
      `<line x1="162" y1="158" x2="144" y2="148" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/>`
    )
  }
  // 默认：多面晶体
  return (
    `<polygon points="256,110 336,170 322,300 226,318 176,226 206,144" fill="url(#die-grad)" stroke="${p}" stroke-width="3" stroke-linejoin="round"/>` +
    `<line x1="256" y1="110" x2="256" y2="318" stroke="${p}" stroke-width="1.5" opacity="0.5"/>` +
    `<line x1="176" y1="226" x2="336" y2="170" stroke="${p}" stroke-width="1.5" opacity="0.4"/>` +
    `<polygon points="256,110 336,170 282,196" fill="#ffffff" opacity="0.1"/>` +
    `<polygon points="352,196 392,238 374,298 324,288" fill="${s}" fill-opacity="0.55" stroke="${p}" stroke-width="2.5"/>` +
    `<line x1="150" y1="140" x2="166" y2="118" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/>` +
    `<line x1="140" y1="152" x2="118" y2="142" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/>`
  )
}

/** 骨架分发（data-skeleton + data-variant 标记 + glow 辉光衬底） */
function skeletonGroup(params: FaceArtParams, pal: Palette): string {
  let inner = ''
  switch (params.skeleton) {
    case 'gpu_fans':
      inner = renderGpuFans(params, pal)
      break
    case 'gpu_blower':
      inner = renderGpuBlower(params, pal)
      break
    case 'chip_die':
      inner = renderChipDie(params, pal)
      break
    case 'disc':
      inner = renderDisc(params, pal)
      break
    case 'connector':
      inner = renderConnector(params, pal)
      break
    case 'board':
      inner = renderBoard(params, pal)
      break
    case 'cooler':
      inner = renderCooler(params, pal)
      break
    case 'peripheral':
      inner = renderPeripheral(params, pal)
      break
    case 'wave':
      inner = renderWave(params, pal)
      break
    case 'crystal':
      inner = renderCrystal(params, pal)
      break
  }
  const halo = params.glow ? `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="170" fill="url(#sk-halo)" opacity="0.3"/>` : ''
  const vAttr = params.variant !== '' ? ` data-variant="${params.variant}"` : ''
  return `<g data-skeleton="${params.skeleton}"${vAttr}>${halo}${inner}</g>`
}

// —— 4. 稀有度插画区层（稀有度在插画区内可读） ——

/** 插画窗四角圆弧饰 */
function winCorners(inset: number, len: number, color: string, lw: number, opacity: number): string {
  const { x, y, w, h } = ART_WINDOW
  const c = len
  const corner = (sx: number, sy: number): string =>
    `<path d="M ${f(sx + c)} ${f(sy)} Q ${f(sx)} ${f(sy)} ${f(sx)} ${f(sy + c)}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-opacity="${f(opacity)}" stroke-linecap="round"/>`
  return (
    corner(x + inset, y + inset) +
    corner(x + w - inset - c, y + inset) +
    corner(x + inset, y + h - inset - c) +
    corner(x + w - inset - c, y + h - inset - c)
  )
}

/** 威压层：legendary 金色放射（衬在主体之后） */
function tierBackdrop(params: FaceArtParams): string {
  if (params.rarityTier === 'legendary') {
    const rays = Array.from({ length: 12 }, (_, i) => {
      const a1 = ((i * 30 - 7) * Math.PI) / 180
      const a2 = ((i * 30 + 7) * Math.PI) / 180
      const [x1, y1] = pt(ACX, ACY, a1, 300)
      const [x2, y2] = pt(ACX, ACY, a2, 300)
      return `<path d="M ${f(ACX)} ${f(ACY)} L ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)} Z" fill="#ff9d2e"/>`
    }).join('')
    return `<g data-legendary="1" opacity="0.12">${rays}</g>`
  }
  if (params.rarityTier === 'epic') {
    return `<circle cx="${f(ACX)}" cy="${f(ACY)}" r="175" fill="url(#sk-halo)" opacity="0.22"/>`
  }
  return ''
}

/** 插画区稀有度环（前景）：rare 蓝 / epic 紫 / legendary 金双环 + 角饰 */
function tierForeground(params: FaceArtParams, pal: Palette): string {
  const { x, y, w, h, r } = ART_WINDOW
  const ring = (inset: number, color: string, lw: number, opacity: number): string =>
    `<rect x="${f(x + inset)}" y="${f(y + inset)}" width="${f(w - inset * 2)}" height="${f(h - inset * 2)}" rx="${f(Math.max(4, r - inset))}" fill="none" stroke="${color}" stroke-width="${lw}" stroke-opacity="${f(opacity)}"/>`
  switch (params.rarityTier) {
    case 'legendary':
      return (
        `<g data-art-tier="legendary">` +
        ring(6, 'url(#leg-grad)', 2.6, 1) +
        ring(11, '#ff9d2e', 1, 0.55) +
        winCorners(6, 26, '#ff9d2e', 2.2, 0.8) +
        `</g>`
      )
    case 'epic':
      return (
        `<g data-art-tier="epic">` +
        ring(6, '#b45cff', 2, 0.45) +
        ring(6, '#b45cff', 5, 0.22) +
        winCorners(6, 22, '#b45cff', 1.8, 0.6) +
        `</g>`
      )
    case 'rare':
      return `<g data-art-tier="rare">${ring(6, '#3f9dff', 1.5, 0.5)}</g>`
    default:
      return `<g data-art-tier="common">${ring(6, shade(pal.primary, 0.95), 1.2, 0.35)}</g>`
  }
}

// —— 5. 关键词角标行 ——

function markGlyph(kind: KeywordMarkKind, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const dark = '#0b0f14'
  switch (kind) {
    case 'shield':
      return `<path d="M0 -8 L7 -4.5 L7 1 Q4 7 0 8.5 Q-4 7 -7 1 L-7 -4.5 Z" fill="${p}"/>`
    case 'halo_shield':
      return (
        `<ellipse cy="-11" rx="7.5" ry="2.4" fill="none" stroke="${a}" stroke-width="1.4"/>` +
        `<path d="M0 -6.5 L5.8 -3.6 L5.8 1.2 Q3.3 6.2 0 7.4 Q-3.3 6.2 -5.8 1.2 L-5.8 -3.6 Z" fill="${p}"/>`
      )
    case 'bolt':
      return `<polygon points="2.5,-8.5 -5.5,1.5 -1,1.5 -2.5,8.5 5.5,-1.5 1,-1.5" fill="${a}"/>`
    case 'dual_core':
      return (
        `<rect x="-7.5" y="-6" width="6.5" height="10" rx="1" fill="${p}"/>` +
        `<rect x="1" y="-6" width="6.5" height="10" rx="1" fill="${p}"/>` +
        `<line x1="-1" y1="-1" x2="1" y2="-1" stroke="${a}" stroke-width="1.6"/>`
      )
    case 'bsod':
      return (
        `<rect x="-7.5" y="-6" width="15" height="12" rx="1.5" fill="${p}" opacity="0.92"/>` +
        `<polyline points="-5,-3 -1,0 -4,3.5" fill="none" stroke="${dark}" stroke-width="1.4"/>` +
        `<rect x="2.5" y="2" width="3.5" height="2.6" fill="${dark}"/>`
      )
    case 'ghost':
      return (
        `<path d="M-6.5 3 Q-6.5 -7.5 0 -7.5 Q6.5 -7.5 6.5 3 L4 0.8 L2 3 L0 0.8 L-2 3 L-4 0.8 Z" fill="${s}" stroke="${p}" stroke-width="1.2"/>` +
        `<circle cx="-2.2" cy="-2.5" r="1.1" fill="${dark}"/>` +
        `<circle cx="2.2" cy="-2.5" r="1.1" fill="${dark}"/>`
      )
    case 'trip':
      return (
        `<polyline points="-8,3 -3.5,-4.5 0.5,2 4,-3.5" fill="none" stroke="${a}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<line x1="5.5" y1="-4" x2="8" y2="-6.5" stroke="${a}" stroke-width="2" stroke-linecap="round"/>` +
        `<circle cx="7.5" cy="-1.5" r="1.2" fill="${a}"/>`
      )
  }
}

function keywordRow(marks: KeywordMarkKind[], pal: Palette): string {
  const n = marks.length
  if (n === 0) return ''
  const gap = 36
  const x0 = CX - ((n - 1) * gap) / 2
  return marks
    .map((m, i) => {
      const x = x0 + i * gap
      return (
        `<g data-mark="${m}" transform="translate(${f(x)} ${KEYWORD_ROW_Y})">` +
        `<circle r="14" fill="#0b0f14" stroke="${shade(pal.primary, 1.15)}" stroke-width="1.5"/>` +
        markGlyph(m, pal) +
        `</g>`
      )
    })
    .join('')
}

// —— 组装 ——

/**
 * 组装整张卡面 SVG（纯函数）。
 * 同参数恒同串；不含任何外部引用（无 href / <image> / 网络字体）。
 */
export function buildFaceArtSvg(params: FaceArtParams, pal: Palette): string {
  const frame = rarityFrame(params.rarityTier, pal)
  const { x, y, w, h, r } = ART_WINDOW
  const defs =
    frame.defs +
    staticDefs(params, pal) +
    `<clipPath id="art-clip"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>`
  const body =
    frame.body +
    `<g clip-path="url(#art-clip)">` +
    // 插画窗底板（半透明，与 ground 底色分级融合）
    `<g data-art="1">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#art-bg)" fill-opacity="0.86"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#art-tint)"/>` +
    `</g>` +
    motifGroup(params, pal) +
    tierBackdrop(params) +
    skeletonGroup(params, pal) +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#art-scan)"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#art-vin)"/>` +
    tierForeground(params, pal) +
    `</g>` +
    keywordRow(params.marks, pal)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FACE_W}" height="${FACE_H}" viewBox="0 0 ${FACE_W} ${FACE_H}"><defs>${defs}</defs>${body}</svg>`
}

/** SVG → data URI（encodeURIComponent 全量转义；禁外部资源 → 无网络请求） */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
