#!/usr/bin/env node
/**
 * P2-UI1 对比度核验：主要前景/背景组合的 WCAG AA 对照表。
 *
 * 用法：node scripts/check-contrast.mjs（组合不达标时以非零码退出）
 *
 * 数据源：
 * - packages/client/src/ui/styles/tokens.css 的 --sc-* 色板令牌（动态解析，改令牌即重核）；
 * - battle.css / screens.css 中的固定色与玻璃底（半透明底按透明度合成到最常用的
 *   应用底色上取"最亮档"，即最坏情况核验）。
 *
 * 阈值：正文/小字 ≥4.5:1；大字（≥24px，或 ≥18.66px 且加粗，如 HUD 数值档 18px/800）
 * ≥3:1。分辨率（1080p/1440p）只影响物理尺寸，色彩对比度与分辨率无关——字号均为
 * px 定档，两档分辨率下的可读性由同一组组合覆盖。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tokensPath = path.join(root, 'packages/client/src/ui/styles/tokens.css')

/* ————— 颜色工具 ————— */
function hexToRgb(hex) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6)
  const n = Number.parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
/** 半透明前景合成到底色上（返回合成后的不透明色） */
/** 半透明前景合成到底色上（返回合成后的不透明色） */
function blend(overRgba, baseRgb) {
  const { rgb, a } = overRgba
  return rgb.map((c, i) => Math.round(c * a + baseRgb[i] * (1 - a)))
}
function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
function contrast(fg, bg) {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (l1 + 0.05) / (l2 + 0.05)
}

/* ————— 解析令牌 ————— */
const tokensCss = readFileSync(tokensPath, 'utf8')
const tokenHex = {}
for (const m of tokensCss.matchAll(/^\s*(--sc-[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gm)) {
  tokenHex[m[1]] = hexToRgb(m[2])
}
const need = ['--sc-bg', '--sc-text', '--sc-dim', '--sc-accent', '--sc-danger', '--sc-mana', '--sc-gold', '--sc-panel-2']
const missing = need.filter((k) => !tokenHex[k])
if (missing.length > 0) {
  console.error(`tokens.css 缺少令牌：${missing.join(', ')}`)
  process.exit(2)
}

/* ————— 背景底色（玻璃/半透明底均合成到应用底色，取最亮档=最坏情况） ————— */
const BG = tokenHex['--sc-bg']
const backgrounds = {
  '应用底 --sc-bg': BG,
  '玻璃面板(最亮档 0.72)': blend({ rgb: [27, 34, 52], a: 0.72 }, BG),
  '按钮底 --sc-panel-2': tokenHex['--sc-panel-2'],
  '手牌卡底(亮端 #1c2333)': hexToRgb('#1c2333'),
  '场上单位卡底(0.92 亮端)': blend({ rgb: [30, 38, 56], a: 0.92 }, BG),
  '战报侧栏底(0.72)': blend({ rgb: [11, 14, 21], a: 0.72 }, BG),
  '攻/血角标底(0.85)': blend({ rgb: [8, 10, 16], a: 0.85 }, blend({ rgb: [30, 38, 56], a: 0.92 }, BG)),
  '功耗徽标底(蓝 0.14)': blend({ rgb: [108, 179, 255], a: 0.14 }, hexToRgb('#1c2333')),
  '房间条目底(0.6)': blend({ rgb: [22, 27, 38], a: 0.6 }, BG),
}

/* ————— 前景色（令牌 + 组件层固定色） ————— */
const T = tokenHex
const foregrounds = {
  '正文 --sc-text': T['--sc-text'],
  '次要 --sc-dim': T['--sc-dim'],
  '可打 --sc-accent': T['--sc-accent'],
  '危险 --sc-danger': T['--sc-danger'],
  '功耗 --sc-mana': T['--sc-mana'],
  '提醒 --sc-gold': T['--sc-gold'],
  '战报·combat #ffb0a8': hexToRgb('#ffb0a8'),
  '攻击数值 #ffb26b': hexToRgb('#ffb26b'),
  '血量数值 #7ef2b6': hexToRgb('#7ef2b6'),
}

/* ————— 核验组合（label, fg, bg, 阈值, 依据） ————— */
const checks = [
  ['正文 / 应用底', '正文 --sc-text', '应用底 --sc-bg', 4.5, '主菜单/结算正文'],
  ['次要文字 / 应用底', '次要 --sc-dim', '应用底 --sc-bg', 4.5, 'eyebrow/脚注'],
  ['正文 / 玻璃面板', '正文 --sc-text', '玻璃面板(最亮档 0.72)', 4.5, '面板段落'],
  ['次要文字 / 玻璃面板', '次要 --sc-dim', '玻璃面板(最亮档 0.72)', 4.5, '规则页脚注等'],
  ['次要文字 / 按钮底', '次要 --sc-dim', '按钮底 --sc-panel-2', 4.5, 'sc-btn 文案'],

  ['可打(accent) / 应用底', '可打 --sc-accent', '应用底 --sc-bg', 4.5, '回合胶囊/房间码'],
  ['可打(accent) / 玻璃面板', '可打 --sc-accent', '玻璃面板(最亮档 0.72)', 4.5, '技能就绪/质保高亮'],
  ['危险(danger) / 应用底', '危险 --sc-danger', '应用底 --sc-bg', 4.5, '疲劳/掉血提示'],
  ['危险(danger) / 玻璃面板', '危险 --sc-danger', '玻璃面板(最亮档 0.72)', 4.5, '供电不足数值(18px/800 大字也须达标)'],
  ['功耗蓝(mana) / 玻璃面板', '功耗 --sc-mana', '玻璃面板(最亮档 0.72)', 4.5, '功耗数值（玩家面板底）'],
  ['提醒金(gold) / 应用底', '提醒 --sc-gold', '应用底 --sc-bg', 4.5, '护甲/终局战报'],

  ['卡名 / 手牌卡底', '正文 --sc-text', '手牌卡底(亮端 #1c2333)', 4.5, '15px 牌名'],
  ['类型行 / 手牌卡底', '次要 --sc-dim', '手牌卡底(亮端 #1c2333)', 4.5, '12px 类型'],
  ['功耗徽标 / 徽标底', '功耗 --sc-mana', '功耗徽标底(蓝 0.14)', 4.5, '13px 费用'],
  ['关键词 / 手牌卡底', '提醒 --sc-gold', '手牌卡底(亮端 #1c2333)', 4.5, '12px 关键词'],
  ['禁用原因 / 手牌卡底', '危险 --sc-danger', '手牌卡底(亮端 #1c2333)', 4.5, '12px 供电不够'],

  ['单位卡名 / 单位卡底', '正文 --sc-text', '场上单位卡底(0.92 亮端)', 4.5, '15px 单位名'],
  ['单位关键词 / 单位卡底', '提醒 --sc-gold', '场上单位卡底(0.92 亮端)', 4.5, '12px 关键词'],
  ['攻击数值 / 角标底', '攻击数值 #ffb26b', '攻/血角标底(0.85)', 3, '18px/800 大字（AA large）'],
  ['血量数值 / 角标底', '血量数值 #7ef2b6', '攻/血角标底(0.85)', 3, '18px/800 大字（AA large）'],
  ['低血数值 / 角标底', '危险 --sc-danger', '攻/血角标底(0.85)', 3, '受伤变红后仍为大字（AA large）'],

  ['战报正文 / 侧栏底', '正文 --sc-text', '战报侧栏底(0.72)', 4.5, '13px 战报'],
  ['战报·system / 侧栏底', '次要 --sc-dim', '战报侧栏底(0.72)', 4.5, '回合头/系统条目'],
  ['战报·combat / 侧栏底', '战报·combat #ffb0a8', '战报侧栏底(0.72)', 4.5, '13px 伤害条目'],
  ['战报·关键事件 / 侧栏底', '提醒 --sc-gold', '战报侧栏底(0.72)', 4.5, '终局/传说/跳闸高亮'],
  ['战报·质保高亮 / 侧栏底', '可打 --sc-accent', '战报侧栏底(0.72)', 4.5, 'shield 高亮'],

  ['房间码 / 房间条目底', '可打 --sc-accent', '房间条目底(0.6)', 4.5, 'LAN 房间列表'],
  ['对局中标签 / 房间条目底', '提醒 --sc-gold', '房间条目底(0.6)', 4.5, 'LAN phase 标签'],
  ['掉线座位 / 房间条目底', '战报·combat #ffb0a8', '房间条目底(0.6)', 4.5, 'LAN 掉线座位'],
]

/* ————— 输出 ————— */
console.log('硅牌 · P2-UI1 对比度核验（WCAG AA：正文 ≥4.5:1，大字 ≥3:1）')
console.log(`令牌来源：${path.relative(root, tokensPath)}`)
console.log('')
const rows = []
let failures = 0
for (const [label, fgName, bgName, threshold, note] of checks) {
  const fg = foregrounds[fgName]
  const bg = backgrounds[bgName]
  if (!fg || !bg) {
    rows.push({ label, fgName, bgName, ratio: NaN, threshold, ok: false, note })
    failures += 1
    continue
  }
  const ratio = contrast(fg, bg)
  const ok = ratio >= threshold
  if (!ok) failures += 1
  rows.push({ label, fgName, bgName, ratio, threshold, ok, note })
}

const labelW = Math.max(...rows.map((r) => r.label.length)) + 2
const fgW = Math.max(...rows.map((r) => r.fgName.length)) + 2
const bgW = Math.max(...rows.map((r) => r.bgName.length)) + 2
for (const r of rows) {
  const ratioStr = Number.isNaN(r.ratio) ? 'N/A' : `${r.ratio.toFixed(2)}:1`
  const mark = r.ok ? 'PASS' : 'FAIL'
  console.log(
    `${mark}  ${r.label.padEnd(labelW)} ${r.fgName.padEnd(fgW)} × ${r.bgName.padEnd(bgW)} ${ratioStr.padEnd(9)} (≥${r.threshold})  ${r.note}`,
  )
}
console.log('')
console.log(`合计 ${rows.length} 组：${rows.length - failures} 通过，${failures} 不达标`)
if (failures > 0) {
  console.error('\n存在不达标组合——请回到 tokens.css / 组件层调色后重跑。')
  process.exit(1)
}
console.log('全部达标。')
