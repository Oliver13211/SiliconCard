/**
 * 卡面美术共享纯函数原语（M4-R3D5 第一阶段从 CardFace.ts 抽出）。
 *
 * 职责：色板解析（保留 M1 既有色表逻辑，语义零变化）+ 确定性哈希/随机流。
 * 本模块必须保持零 DOM 依赖——CardFace 的无头测试直接经 CardFace 再导出引用。
 */

import type { CardArt } from '@siliconcard/core'

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

export const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** FNV-1a 32 位字符串哈希（本地纯函数，与 core/testing 的 stableHash 用途不同勿混用） */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 种子随机流：确定性伪随机（禁 Math.random/Date 的合规替代），纯函数 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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
 * 入参契约保持 M1 原样：CardArt（含 shape/palette/glow）或 undefined。
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

/**
 * 饱和度缩放（0..∞，>1 增艳、1 原样、<1 变灰），纯函数。
 * 各通道绕通道均值拉伸：ch' = mean + (ch - mean) × k，色相不变、艳度按 k 缩放。
 * 与 shade 组合实现「又亮又艳」的底色分级（演出修正阶段二）。
 */
export function saturate(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const mean = (r + g + b) / 3
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round(mean + (v - mean) * k)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}
