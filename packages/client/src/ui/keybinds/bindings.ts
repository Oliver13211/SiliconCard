/**
 * 键位表逻辑（P2-UI5）——默认键位、combo→命令反查、冲突检测、载入净化。
 *
 * 冲突规则（phase2-plan P2-UI5 §3/§5）：
 * - 同一 combo 只能被 scope 相交的两个命令之一持有；scope 不相交允许共存
 *   （空格在对局=结束回合、在回放=播放暂停，两模式键位分离互不干扰）；
 * - 编辑器改键命中占用时返回 conflict + 被占命令，由 UI 提供「交换 / 改选」。
 */

import {
  COMMAND_DEFS,
  PLAY_SLOT_COMMANDS,
  commandDefOf,
  isCommandId,
  scopesIntersect,
  type CommandDef,
  type CommandId,
  type KeyScope,
} from './commands'
import { isReservedCombo, parseCombo } from './combo'

export type BindMap = Record<CommandId, string>

/** plan 定稿默认键位：1-9、0 出牌 / 空格 结束回合 / H 技能 / Tab 循环目标 /
    Enter 确认 / Esc 取消 / F 快进 / M 静音 / ? 键位表（toggle_key_hints 与
    回放三命令 plan 未指定，取不与默认冲突的直觉键，可在编辑器改） */
const DEFAULT_BIND_PAIRS: readonly (readonly [CommandId, string])[] = [
  ...PLAY_SLOT_COMMANDS.map((id, index) => [id, index === 9 ? '0' : String(index + 1)] as const),
  ['end_turn', 'Space'],
  ['hero_power', 'H'],
  ['cycle_target', 'Tab'],
  ['confirm', 'Enter'],
  ['cancel', 'Escape'],
  ['fast_forward', 'F'],
  ['mute', 'M'],
  ['toggle_key_hints', 'K'],
  ['help', '?'],
  ['replay_play_pause', 'Space'],
  ['replay_step', 'ArrowRight'],
  ['replay_speed', 'R'],
]

export const DEFAULT_BINDS: BindMap = Object.freeze(Object.fromEntries(DEFAULT_BIND_PAIRS)) as BindMap

export function defaultBinds(): BindMap {
  return { ...DEFAULT_BINDS }
}

/** combo 规范形态校验（载入容错用：格式坏 → 该命令回落默认）。
    主键含空白的一律拒收——comboFromEvent 产出的 Space 已归一化，
    不可能产出带空格的主键（挡住 'NOT A COMBO' 这类脏数据）。 */
export function isValidCombo(combo: string): boolean {
  if (typeof combo !== 'string') return false
  const parsed = parseCombo(combo)
  if (!parsed || /\s/.test(parsed.base)) return false
  return !isReservedCombo(combo)
}

export type BindValidationResult =
  | { ok: true }
  | { ok: false; code: 'invalid'; message: string }
  | { ok: false; code: 'reserved'; message: string }
  | { ok: false; code: 'conflict'; message: string; conflictCommand: CommandId }

/** 把某命令改成某 combo 的校验（不落库；交换由 store 先 validate 再成对提交） */
export function validateBind(binds: BindMap, command: CommandId, combo: string): BindValidationResult {
  if (!isValidCombo(combo)) {
    return isReservedCombo(combo)
      ? { ok: false, code: 'reserved', message: '这组是浏览器保留键（切标签/刷新那挂），换一个吧' }
      : { ok: false, code: 'invalid', message: '按键组合格式不对，重新按一次' }
  }
  if (binds[command] === combo) return { ok: true }
  for (const [other, otherCombo] of Object.entries(binds)) {
    if (other === command || otherCombo !== combo) continue
    const otherId = other as CommandId
    const selfDef = commandDefOf(command)
    const otherDef = commandDefOf(otherId)
    if (!selfDef || !otherDef) continue
    if (!scopesIntersect(selfDef.scopes, otherDef.scopes)) continue
    return {
      ok: false,
      code: 'conflict',
      message: `「${otherDef.label}」已经占了这个键——交换还是改选？`,
      conflictCommand: otherId,
    }
  }
  return { ok: true }
}

/**
 * 全表不变量检查：返回第一对 scope 相交却共用同一 combo 的命令（无冲突返回 null）。
 * swapBind 交换后整表复核用——单条校验无法覆盖"被交换方的新键撞了第三方"的情况。
 */
export function findScopeConflict(binds: BindMap): { a: CommandId; b: CommandId } | null {
  for (let i = 0; i < COMMAND_DEFS.length; i++) {
    for (let j = i + 1; j < COMMAND_DEFS.length; j++) {
      const a = COMMAND_DEFS[i]
      const b = COMMAND_DEFS[j]
      if (!a || !b) continue
      if (binds[a.id] === binds[b.id] && scopesIntersect(a.scopes, b.scopes)) return { a: a.id, b: b.id }
    }
  }
  return null
}

/** scope 过滤的 combo→命令反查：只匹配 activeScope（+global）内的命令；
    不传 scope 返回第一个命中（载入净化等全局视角用） */
export function commandForCombo(
  binds: BindMap,
  combo: string,
  activeScope?: KeyScope,
): CommandId | null {
  for (const def of COMMAND_DEFS) {
    if (binds[def.id] !== combo) continue
    if (activeScope && !def.scopes.includes(activeScope) && !def.scopes.includes('global')) continue
    return def.id
  }
  return null
}

/**
 * 载入净化：未知命令忽略 / 格式非法或保留键回落默认 / scope 相交的重复 combo
 * 保留先出现的、后者回落默认。返回新表（不修改入参）。
 */
export function sanitizeBinds(raw: Partial<Record<string, string>> | null | undefined): BindMap {
  const binds = defaultBinds()
  if (!raw) return binds
  const taken = new Map<string, CommandId>()
  for (const def of COMMAND_DEFS) taken.set(binds[def.id], def.id)

  for (const [key, combo] of Object.entries(raw)) {
    if (!isCommandId(key) || typeof combo !== 'string') continue
    if (combo === binds[key as CommandId]) continue
    if (!isValidCombo(combo)) continue
    const holder = taken.get(combo)
    if (holder !== undefined) {
      const holderDef = commandDefOf(holder) as CommandDef
      const def = commandDefOf(key) as CommandDef
      if (scopesIntersect(holderDef.scopes, def.scopes)) continue
    }
    binds[key as CommandId] = combo
    taken.set(combo, key as CommandId)
  }
  return binds
}
