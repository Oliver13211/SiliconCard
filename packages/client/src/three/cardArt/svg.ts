/**
 * 程序化卡面 SVG 组装（M4-R3D5 第一阶段）—— 纯字符串构建，零 DOM、零外部资源。
 *
 * 输出一张 512×718 全幅透明底 SVG，含四个组合图层：
 *   1. 稀有度框饰（common/rare/epic/legendary 四档，legendary 明显高一档）；
 *   2. art 几何窗：派系图案母题（低透明度衬底）+ type 形制骨架（风扇阵/裸片/盘片/接口/板/散热/外设/波形/晶体）；
 *   3. 关键词角标行（七种，与 core Keyword 一一对应）。
 *
 * 契约：
 * - 只消费 derive.ts 的 FaceArtParams + color.ts 的 Palette，全部数值确定性派生；
 * - 禁外部引用（无 href / <image> / 网络字体），经 svgToDataUri → Image 内联进 Canvas；
 * - 关键节点带 data-* 标记（data-tier / data-skeleton / data-fan / data-motif / data-mark），
 *   供无头单测断言组合正确性。
 */

import { shade, type Palette } from './color'
import { ART_WINDOW, KEYWORD_ROW_Y, type FaceArtParams, type KeywordMarkKind, type RarityTier } from './derive'

const CARD_W = 512
const CARD_H = 718
/** 画布中心（角部饰件旋转基准） */
const CX = CARD_W / 2
const CY = CARD_H / 2

/** 数值格式化：两位小数封顶，保证同参数恒同串（测试断言字符串一致性） */
const f = (v: number): string => String(Math.round(v * 100) / 100)

// —— 1. 稀有度框饰 ——

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
    [CX, CARD_H - 22],
    [22, CY],
    [CARD_W - 22, CY],
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

function rarityFrame(tier: RarityTier, pal: Palette): { defs: string; body: string } {
  const p = pal.primary
  const a = pal.accent
  const soft = shade(p, 1.2)
  if (tier === 'legendary') {
    // 明显高一档：渐变辉光双带 + 内 hairline + 角部双 L + 顶冠 + 大菱钉
    const defs =
      `<linearGradient id="leg-grad" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${p}"/><stop offset="0.5" stop-color="${a}"/><stop offset="1" stop-color="${p}"/>` +
      `</linearGradient>` +
      `<filter id="fr-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>`
    const crest = [0, 1, 2]
      .map(
        (i) =>
          `<path d="M ${f(CX - 12 + i * 0)} ${f(32 + i * 6)} L ${CX} ${f(24 + i * 6)} L ${f(CX + 12)} ${f(32 + i * 6)}" fill="none" stroke="${f2c(i, a, p)}" stroke-width="${3 - i * 0.6}" stroke-linecap="round"/>`,
      )
      .join('')
    const body =
      `<g data-tier="legendary">` +
      `<rect x="19" y="19" width="${CARD_W - 38}" height="${CARD_H - 38}" rx="20" fill="none" stroke="url(#leg-grad)" stroke-width="8" opacity="0.5" filter="url(#fr-glow)"/>` +
      `<rect x="19" y="19" width="${CARD_W - 38}" height="${CARD_H - 38}" rx="20" fill="none" stroke="url(#leg-grad)" stroke-width="5"/>` +
      `<rect x="31" y="31" width="${CARD_W - 62}" height="${CARD_H - 62}" rx="14" fill="none" stroke="${a}" stroke-width="1.2" stroke-opacity="0.8"/>` +
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
      `<rect x="21" y="21" width="${CARD_W - 42}" height="${CARD_H - 42}" rx="18" fill="none" stroke="${a}" stroke-width="5" stroke-opacity="0.35" filter="url(#fr-glow)"/>` +
      `<rect x="21" y="21" width="${CARD_W - 42}" height="${CARD_H - 42}" rx="18" fill="none" stroke="${p}" stroke-width="2.5" stroke-opacity="0.85"/>` +
      `<rect x="28" y="28" width="${CARD_W - 56}" height="${CARD_H - 56}" rx="14" fill="none" stroke="${soft}" stroke-width="1.2" stroke-opacity="0.6"/>` +
      cornerTicks(21, 40, a, 2.4) +
      edgeStuds(10, a, true) +
      `</g>`
    return { defs, body }
  }
  if (tier === 'rare') {
    const body =
      `<g data-tier="rare">` +
      `<rect x="22" y="22" width="${CARD_W - 44}" height="${CARD_H - 44}" rx="18" fill="none" stroke="${p}" stroke-width="2" stroke-opacity="0.6"/>` +
      `<rect x="29" y="29" width="${CARD_W - 58}" height="${CARD_H - 58}" rx="14" fill="none" stroke="${soft}" stroke-width="1.2" stroke-opacity="0.5"/>` +
      cornerTicks(22, 34, a, 2) +
      `<rect x="${f(CX - 4)}" y="18" width="8" height="8" transform="rotate(45 ${CX} 22)" fill="${a}" fill-opacity="0.85"/>` +
      `<rect x="${f(CX - 4)}" y="${f(CARD_H - 26)}" width="8" height="8" transform="rotate(45 ${CX} ${CARD_H - 22})" fill="${a}" fill-opacity="0.85"/>` +
      `</g>`
    return { defs: '', body }
  }
  // common（starter 归此档）：单细线 + 短角饰
  const body =
    `<g data-tier="common">` +
    `<rect x="22" y="22" width="${CARD_W - 44}" height="${CARD_H - 44}" rx="18" fill="none" stroke="${p}" stroke-width="2" stroke-opacity="0.45"/>` +
    cornerTicks(22, 26, a, 2) +
    `</g>`
  return { defs: '', body }
}

/** 顶冠三连 chevron 的颜色序列（legendary 专用） */
function f2c(i: number, accent: string, primary: string): string {
  return i === 1 ? accent : primary
}

// —— 2. 派系图案母题（art 窗衬底，低透明度） ——

function motifGroup(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const a = pal.accent
  const cy = ART_WINDOW.y + ART_WINDOW.h / 2 + params.motifShiftY
  const tf = `translate(${CX} ${f(cy)}) rotate(${f(params.motifRot)}) scale(${f(params.motifScale)})`
  let inner = ''
  switch (params.motif) {
    case 'nvidia': {
      // 三道斜切能量爪
      inner = [0, 1, 2]
        .map(
          (i) =>
            `<path d="M ${-150 + i * 70} 92 L ${-104 + i * 70} -92 L ${-64 + i * 70} -92 L ${-110 + i * 70} 92 Z" fill="${p}"/>`,
        )
        .join('')
      break
    }
    case 'amd': {
      // 三连箭标 chevron
      inner = [0, 1, 2]
        .map(
          (i) =>
            `<path d="M ${-142 + i * 62} 64 L ${-108 + i * 62} 0 L ${-142 + i * 62} -64 L ${-122 + i * 62} -64 L ${-88 + i * 62} 0 L ${-122 + i * 62} 64 Z" fill="${p}"/>`,
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
  return `<g data-motif="${params.motif}" transform="${tf}" opacity="0.2">${inner}</g>`
}

// —— 3. type 形制骨架（art 窗主体） ——

/** 风扇组（gpu_fans / gpu_blower 共用）：毂 + 叶片阵 + 外圈 */
function fanGroup(cx: number, cy: number, r: number, bladeCount: number, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const blades = Array.from({ length: bladeCount }, (_, i) => {
    const ang = (i / bladeCount) * Math.PI * 2
    const bx = cx + Math.cos(ang) * r * 0.52
    const by = cy + Math.sin(ang) * r * 0.52
    const deg = f((ang * 180) / Math.PI)
    return `<ellipse cx="${f(bx)}" cy="${f(by)}" rx="${f(r * 0.34)}" ry="${f(r * 0.15)}" transform="rotate(${deg} ${f(bx)} ${f(by)})" fill="${s}" opacity="0.95"/>`
  }).join('')
  return (
    `<g data-fan="1">` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#0d1116" fill-opacity="0.55" stroke="${p}" stroke-width="4"/>` +
    blades +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.2)}" fill="#0a0e12" stroke="${a}" stroke-width="3"/>` +
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="3" fill="${a}"/>` +
    `</g>`
  )
}

function skeletonGroup(params: FaceArtParams, pal: Palette): string {
  const p = pal.primary
  const s = pal.secondary
  const a = pal.accent
  const cx = CX
  const cy = ART_WINDOW.y + ART_WINDOW.h / 2
  let inner = ''
  switch (params.skeleton) {
    case 'gpu_fans': {
      const n = params.fanCount
      const r = n === 1 ? 96 : n === 2 ? 86 : 62
      const xs = n === 1 ? [256] : n === 2 ? [158, 354] : [118, 256, 394]
      inner =
        xs.map((x) => fanGroup(x, cy, r, params.bladeCount, pal)).join('') +
        (n > 1
          ? xs.slice(0, -1).map((x, i) => `<line x1="${f((x + (xs[i + 1] ?? x)) / 2)}" y1="${cy - r - 8}" x2="${f((x + (xs[i + 1] ?? x)) / 2)}" y2="${cy + r + 8}" stroke="${p}" stroke-width="2" opacity="0.5"/>`).join('')
          : '') +
        // 散热罩四角螺丝
        [[96, 116], [416, 116], [96, 328], [416, 328]]
          .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${softStroke(pal)}" stroke-width="1.5"/>`)
          .join('')
      break
    }
    case 'gpu_blower': {
      // 涡轮卡：右侧单风扇 + 左侧鳍片 + 底部出风槽
      const fins = Array.from({ length: 9 }, (_, i) => `<line x1="${102 + i * 17}" y1="140" x2="${102 + i * 17}" y2="300" stroke="${p}" stroke-width="3" opacity="0.6"/>`).join('')
      inner =
        `<rect x="90" y="128" width="170" height="184" rx="8" fill="#0d1116" fill-opacity="0.6" stroke="${p}" stroke-width="3"/>` +
        fins +
        fanGroup(348, cy - 12, 78, params.bladeCount, pal) +
        `<rect x="140" y="322" width="232" height="18" rx="9" fill="none" stroke="${a}" stroke-width="2.5"/>`
      break
    }
    case 'chip_die': {
      const dw = params.dieCount === 2 ? 92 : 122
      const dx = params.dieCount === 2 ? [256 - 62, 256 + 62] : [256]
      const dies = dx
        .map((x) => {
          const grid = [1, 2]
            .map((i) => `<line x1="${x - dw / 2 + (dw * i) / 3}" y1="${cy - 42}" x2="${x - dw / 2 + (dw * i) / 3}" y2="${cy + 42}" stroke="#0a0e12" stroke-width="1.5" opacity="0.5"/>`)
            .join('')
          return (
            `<rect x="${x - dw / 2}" y="${cy - 42}" width="${dw}" height="84" rx="4" fill="${p}" fill-opacity="0.85" stroke="${a}" stroke-width="2"/>` + grid
          )
        })
        .join('')
      const pins = [0, 1, 2, 3, 4, 5, 6, 7]
        .map((i) => {
          const x = 256 - 96 + i * 27.5
          return `<line x1="${f(x)}" y1="${cy - 78}" x2="${f(x)}" y2="${cy - 96}" stroke="${s}" stroke-width="3"/><line x1="${f(x)}" y1="${cy + 78}" x2="${f(x)}" y2="${cy + 96}" stroke="${s}" stroke-width="3"/>`
        })
        .join('')
      inner =
        `<rect x="${256 - 110}" y="${cy - 78}" width="220" height="156" rx="10" fill="#0d1116" fill-opacity="0.6" stroke="${p}" stroke-width="3"/>` +
        pins +
        dies
      break
    }
    case 'disc': {
      inner =
        `<circle cx="${cx}" cy="${cy}" r="94" fill="#0d1116" fill-opacity="0.6" stroke="${p}" stroke-width="4"/>` +
        `<circle cx="${cx}" cy="${cy}" r="64" fill="none" stroke="${p}" stroke-width="1.5" opacity="0.45"/>` +
        `<circle cx="${cx}" cy="${cy}" r="44" fill="none" stroke="${p}" stroke-width="1.5" opacity="0.3"/>` +
        `<path d="M ${cx + 58} ${cy - 68} A 90 90 0 0 1 ${cx + 90} ${cy + 14}" fill="none" stroke="${a}" stroke-width="3" opacity="0.65"/>` +
        `<circle cx="${cx}" cy="${cy}" r="20" fill="#0a0e12" stroke="${a}" stroke-width="3"/>` +
        `<circle cx="${cx}" cy="${cy}" r="8" fill="${a}" opacity="0.85"/>`
      break
    }
    case 'connector': {
      const fingers = Array.from({ length: 9 }, (_, i) => `<rect x="${206 + i * 12.5}" y="222" width="5.5" height="60" fill="${a}" opacity="0.85"/>`).join('')
      inner =
        `<rect x="196" y="160" width="120" height="132" rx="6" fill="#0d1116" fill-opacity="0.6" stroke="${p}" stroke-width="3"/>` +
        fingers +
        `<rect x="236" y="150" width="40" height="12" fill="#05070a" stroke="${p}" stroke-width="1.5"/>` +
        `<rect x="206" y="132" width="100" height="14" rx="4" fill="${s}" fill-opacity="0.5" stroke="${p}" stroke-width="2"/>`
      break
    }
    case 'board': {
      const slots =
        `<rect x="146" y="150" width="122" height="14" rx="3" fill="${s}" fill-opacity="0.7" stroke="${p}" stroke-width="1.5"/>` +
        `<rect x="146" y="176" width="92" height="12" rx="3" fill="${s}" fill-opacity="0.7" stroke="${p}" stroke-width="1.5"/>`
      const screws = [[140, 136], [372, 136], [140, 308], [372, 308]]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${a}" stroke-width="2"/>`)
        .join('')
      inner =
        `<rect x="126" y="122" width="260" height="200" rx="10" fill="#0d1116" fill-opacity="0.65" stroke="${p}" stroke-width="3"/>` +
        `<path d="M 150 240 L 220 240 L 240 260 L 330 260" fill="none" stroke="${p}" stroke-width="2" opacity="0.35"/>` +
        `<path d="M 150 262 L 200 262 L 220 282 L 320 282" fill="none" stroke="${p}" stroke-width="2" opacity="0.3"/>` +
        slots +
        `<rect x="296" y="236" width="64" height="50" rx="4" fill="${p}" fill-opacity="0.8" stroke="${a}" stroke-width="1.5"/>` +
        screws +
        `<rect x="146" y="304" width="220" height="10" fill="${a}" opacity="0.8"/>`
      break
    }
    case 'cooler': {
      const fins = Array.from({ length: 8 }, (_, i) => `<line x1="172" y1="${166 + i * 17}" x2="340" y2="${166 + i * 17}" stroke="${p}" stroke-width="3" opacity="0.6"/>`).join('')
      const pipes = [-24, 0, 24]
        .map(
          (o) =>
            `<path d="M ${f(190 + o * 0.6)} 298 Q ${f(256 + o)} 118 ${f(322 + o * 0.6)} 298" fill="none" stroke="${a}" stroke-width="4" opacity="0.8"/>`,
        )
        .join('')
      inner =
        `<rect x="158" y="150" width="196" height="150" rx="8" fill="#0d1116" fill-opacity="0.6" stroke="${p}" stroke-width="3"/>` +
        fins +
        pipes +
        fanGroup(206, 292, 34, 7, pal)
      break
    }
    case 'peripheral': {
      inner =
        `<rect x="166" y="132" width="180" height="180" rx="42" fill="#0d1116" fill-opacity="0.6" stroke="${p}" stroke-width="3"/>` +
        `<circle cx="${cx}" cy="${cy - 14}" r="26" fill="none" stroke="${a}" stroke-width="3"/>` +
        `<circle cx="${cx}" cy="${cy + 44}" r="10" fill="${s}"/>` +
        `<path d="M 346 158 Q 384 196 358 248" fill="none" stroke="${p}" stroke-width="3" opacity="0.7"/>`
      break
    }
    case 'wave': {
      const rows = [-66, -22, 22, 66]
      inner = rows
        .map((o, i) => {
          const pts: string[] = []
          for (let x = 60; x <= 452; x += 24) {
            pts.push(`${f(x)} ${f(cy + o + Math.sin((x - 60) / 24) * 18)}`)
          }
          const color = i === 1 || i === 2 ? a : p
          const op = i === 1 || i === 2 ? '0.95' : '0.6'
          return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="3" opacity="${op}" stroke-linejoin="round"/>`
        })
        .join('')
      break
    }
    case 'crystal': {
      inner =
        `<polygon points="256,120 330,180 312,290 224,306 178,220 210,150" fill="${s}" fill-opacity="0.8" stroke="${p}" stroke-width="3"/>` +
        `<line x1="256" y1="120" x2="256" y2="306" stroke="${p}" stroke-width="1.5" opacity="0.5"/>` +
        `<line x1="178" y1="220" x2="330" y2="182" stroke="${p}" stroke-width="1.5" opacity="0.4"/>` +
        `<polygon points="352,196 392,238 374,298 324,288" fill="${s}" fill-opacity="0.55" stroke="${p}" stroke-width="2.5"/>` +
        `<line x1="176" y1="140" x2="166" y2="118" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/>` +
        `<line x1="168" y1="150" x2="148" y2="142" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/>`
      break
    }
  }
  const halo = params.glow
    ? `<circle cx="${cx}" cy="${cy}" r="120" fill="url(#sk-halo)" opacity="0.35"/>`
    : ''
  return `<g data-skeleton="${params.skeleton}">${halo}${inner}</g>`
}

function softStroke(pal: Palette): string {
  return shade(pal.primary, 0.8)
}

// —— 4. 关键词角标行 ——

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
    `<clipPath id="art-clip"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>` +
    `<radialGradient id="sk-halo"><stop offset="0" stop-color="${pal.accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${pal.accent}" stop-opacity="0"/></radialGradient>`
  const body =
    frame.body +
    `<g clip-path="url(#art-clip)">${motifGroup(params, pal)}${skeletonGroup(params, pal)}</g>` +
    keywordRow(params.marks, pal)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}"><defs>${defs}</defs>${body}</svg>`
}

/** SVG → data URI（encodeURIComponent 全量转义；禁外部资源 → 无网络请求） */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
