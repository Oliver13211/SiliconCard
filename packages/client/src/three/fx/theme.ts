/**
 * 牌桌主题纯函数（M4-R3D5 需求 5：场景灯光/环境色响应双方派系）。
 *
 * 派系 id → 两侧灯光 / 背景 / 雾 / 槽位染色。零 DOM、零 Three 依赖
 * （输出 hex 字符串，SceneManager 负责着色与平滑过渡），可无头测试。
 * 色源与卡面同源：resolvePalette（art.palette 优先逻辑在卡面层，此处按派系表）。
 */

import { resolvePalette } from '../cardArt/color'

export interface TableThemeColors {
  /** 近侧（视角方）灯光色 */
  nearLight: string
  /** 远侧（对手）灯光色 */
  farLight: string
  /** 场景背景 / 雾色（向两侧派系色各染一点后的暗色） */
  background: string
  /** 近侧槽位染色 */
  slotNear: string
  /** 远侧槽位染色 */
  slotFar: string
}

/** hex 线性插值（纯函数；两端都须为 #rrggbb） */
export function mixHex(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16)
  const nb = parseInt(b.slice(1), 16)
  const ch = (va: number, vb: number) =>
    Math.max(0, Math.min(255, Math.round(va + (vb - va) * t)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch((na >> 16) & 0xff, (nb >> 16) & 0xff)}${ch((na >> 8) & 0xff, (nb >> 8) & 0xff)}${ch(na & 0xff, nb & 0xff)}`
}

/** 场景基线暗色（SceneManager 初始 clear/fog 同色） */
export const THEME_BASE_BG = '#04070a'
/** 槽位基线色（SceneManager buildTable 的原始槽位色） */
const THEME_BASE_SLOT = '#1d5a44'

/**
 * 双方派系 → 牌桌主题色（纯函数，同输入恒同输出）。
 * 未知派系名走 resolvePalette 的确定性色相兜底，新增派系零改动。
 */
export function tableThemeFor(factionSelf: string, factionOpp: string): TableThemeColors {
  const self = resolvePalette(undefined, factionSelf).primary
  const opp = resolvePalette(undefined, factionOpp).primary
  return {
    nearLight: self,
    farLight: opp,
    // 背景各向双方染 6%（保暗，不打断焦距层次）
    background: mixHex(mixHex(THEME_BASE_BG, self, 0.06), opp, 0.06),
    slotNear: mixHex(THEME_BASE_SLOT, self, 0.55),
    slotFar: mixHex(THEME_BASE_SLOT, opp, 0.55),
  }
}
