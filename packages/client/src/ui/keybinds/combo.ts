/**
 * 按键组合（combo）的归一化 / 展示格式化 / 浏览器保留键判定（P2-UI5）。
 *
 * combo 是规范字符串，也是展示串的来源：修饰键固定顺序 `Shift+Ctrl+Alt+Meta`，
 * 主键取 KeyboardEvent.key 的语义形态（' '→Space、字母大写、可打印符号保持原样如 '?'）。
 * 设计取向：
 * - 用 key 而非 code：跨键盘布局直觉（? 就是 ?，而不是"物理 Slash 键"）；
 * - 字母键显式记录 Shift（H 与 Shift+H 是两个 combo）；
 *   非字母可打印符号不记 Shift（Shift+/. 产出的 '?' 本身就是完整语义）；
 * - 纯修饰键按下不算一次绑定（编辑器捕获时忽略，等主键）。
 */

/** 编辑器捕获/运行时共用的最小按键输入形态（避免测试环境依赖 DOM KeyboardEvent） */
export interface RawKeyEvent {
  key: string
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

export const MODIFIER_ORDER = ['Shift', 'Ctrl', 'Alt', 'Meta'] as const

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'])

/** event.key 的多字符命名键 → 规范主键名 */
const NAMED_KEY_MAP: Record<string, string> = {
  ' ': 'Space',
}

/** 解析规范 combo → { mods, base }；格式非法返回 null（容错解析侧用） */
export function parseCombo(combo: string): { mods: string[]; base: string } | null {
  if (combo.length === 0) return null
  const parts = combo.split('+')
  const base = parts[parts.length - 1]
  if (!base) return null
  const mods = parts.slice(0, -1)
  // 修饰键必须是合法子集，且严格按规范顺序、无重复
  let cursor = 0
  for (const mod of mods) {
    let found = -1
    for (let i = cursor; i < MODIFIER_ORDER.length; i++) {
      if (MODIFIER_ORDER[i] === mod) {
        found = i
        break
      }
    }
    if (found < 0) return null
    cursor = found + 1
  }
  return { mods, base }
}

/**
 * KeyboardEvent → 规范 combo；纯修饰键按下返回 null（不是一次可绑定的按键）。
 */
export function comboFromEvent(event: RawKeyEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  let base: string
  if (event.key in NAMED_KEY_MAP) {
    base = NAMED_KEY_MAP[event.key] ?? event.key
  } else if (event.key.length === 1) {
    base = /[a-z]/i.test(event.key) ? event.key.toUpperCase() : event.key
  } else {
    base = event.key
  }

  const mods: string[] = []
  // 字母主键才显式记 Shift：可打印符号（'?'、'!' 等）按下时 shift 已体现在符号本身
  if (event.shiftKey && event.key.length === 1 && /[a-z]/i.test(event.key)) mods.push('Shift')
  if (event.ctrlKey) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.metaKey) mods.push('Meta')
  return [...mods, base].join('+')
}

/** 规范 combo → 人类可读展示（键位表 / 角标 / 编辑器共用，中文可读优先） */
export function formatCombo(combo: string): string {
  const parsed = parseCombo(combo)
  if (!parsed) return combo
  const base = DISPLAY_KEY_MAP[parsed.base] ?? parsed.base
  const mods = parsed.mods.map((mod) => DISPLAY_MOD_MAP[mod] ?? mod)
  return [...mods, base].join(' + ')
}

const DISPLAY_KEY_MAP: Record<string, string> = {
  Space: '空格',
  Escape: 'Esc',
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

const DISPLAY_MOD_MAP: Record<string, string> = {
  Meta: 'Cmd/Win',
}

/**
 * 浏览器/系统保留键判定：这些 combo 浏览器优先消费（页面往往根本收不到，
 * 或触发关闭标签/刷新等破坏行为），编辑器拒收并提示改选。
 */
export function isReservedCombo(combo: string): boolean {
  const parsed = parseCombo(combo)
  if (!parsed) return false
  const { mods, base } = parsed
  const hasCtrlOrMeta = mods.includes('Ctrl') || mods.includes('Meta')

  // Ctrl/Cmd(+Shift) + Tab/W/T/N/Q/R：切标签、关标签、新标签、新窗口、退出、刷新
  if (hasCtrlOrMeta && ['Tab', 'W', 'T', 'N', 'Q', 'R'].includes(base)) return true
  // Alt+Tab / Cmd+Tab（无 Ctrl 也拦）
  if (base === 'Tab' && (mods.includes('Alt') || mods.includes('Meta'))) return true
  // Alt+F4：系统级关窗（页面通常收不到，防御性拒收）
  if (base === 'F4' && mods.includes('Alt')) return true
  // F5 / F11 / F12：刷新 / 全屏 / 开发者工具（浏览器同时响应，键位必然失灵）
  if (['F5', 'F11', 'F12'].includes(base)) return true
  return false
}
