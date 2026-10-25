/**
 * P2-UI5 快捷键体系无头单测：命令注册表完整性 / 默认键位冲突不变量 /
 * combo 解析与修饰键 / 保留键拒收 / 冲突检测（含 scope 分离与交换全表复核）/
 * localStorage 容错读写 / store 状态迁移 / 输入聚焦失活判定。
 * 不触碰 DOM 与真实 localStorage（内存 fake storage），node 环境可跑。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMMAND_DEFS,
  PLAY_SLOT_COMMANDS,
  REPLAY_COMMANDS,
  commandDefOf,
  isCommandId,
  type CommandId,
} from '../commands'
import { comboFromEvent, formatCombo, isReservedCombo, parseCombo } from '../combo'
import {
  DEFAULT_BINDS,
  commandForCombo,
  defaultBinds,
  findScopeConflict,
  isValidCombo,
  sanitizeBinds,
  validateBind,
} from '../bindings'
import { KEYBINDS_SCHEMA_VERSION, KEYBINDS_STORAGE_KEY, loadKeybinds, saveKeybinds } from '../storage'
import { isTextEntryTarget } from '../useKeyCommands'
import { resetKeybindsForTests, useKeybinds } from '../keybindsStore'
import type { RawKeyEvent } from '../combo'

function key(raw: Partial<RawKeyEvent>): RawKeyEvent {
  return { key: '', ...raw }
}

/** 最小内存版 storage（对齐 uiPrefs 测试模式） */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  let failWrites = false
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('quota exceeded')
      map.set(k, v)
    },
    failWrites() {
      failWrites = true
    },
    dump: () => Object.fromEntries(map.entries()),
  }
}

describe('命令注册表', () => {
  it('固定命令集齐全：出牌 10 槽 + 对局 + 通用 + 回放三命令', () => {
    expect(PLAY_SLOT_COMMANDS).toHaveLength(10)
    expect(REPLAY_COMMANDS).toEqual(['replay_play_pause', 'replay_step', 'replay_speed'])
    const ids = COMMAND_DEFS.map((def) => def.id)
    for (const id of PLAY_SLOT_COMMANDS) expect(ids).toContain(id)
    for (const id of ['end_turn', 'hero_power', 'cycle_target', 'confirm', 'cancel', 'fast_forward', 'mute', 'toggle_key_hints', 'help'] as const) {
      expect(ids).toContain(id)
    }
    expect(ids).toHaveLength(22)
  })

  it('每条命令都有可读 label/description 和 scope', () => {
    for (const def of COMMAND_DEFS) {
      expect(def.label.length).toBeGreaterThan(0)
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.scopes.length).toBeGreaterThan(0)
    }
  })

  it('未知 id 不被当成命令（容错解析的前提）', () => {
    expect(isCommandId('play_slot_99')).toBe(false)
    expect(commandDefOf('nope')).toBeUndefined()
  })
})

describe('默认键位不变量', () => {
  it('plan 定稿默认键位', () => {
    expect(DEFAULT_BINDS.play_slot_1).toBe('1')
    expect(DEFAULT_BINDS.play_slot_9).toBe('9')
    expect(DEFAULT_BINDS.play_slot_10).toBe('0')
    expect(DEFAULT_BINDS.end_turn).toBe('Space')
    expect(DEFAULT_BINDS.hero_power).toBe('H')
    expect(DEFAULT_BINDS.cycle_target).toBe('Tab')
    expect(DEFAULT_BINDS.confirm).toBe('Enter')
    expect(DEFAULT_BINDS.cancel).toBe('Escape')
    expect(DEFAULT_BINDS.fast_forward).toBe('F')
    expect(DEFAULT_BINDS.mute).toBe('M')
    expect(DEFAULT_BINDS.help).toBe('?')
  })

  it('默认表自身无 scope 冲突（空格在对局/回放双 scope 各自合法）', () => {
    expect(findScopeConflict(DEFAULT_BINDS)).toBeNull()
  })

  it('空格同时服务对局结束回合与回放播放暂停（scope 分离互不干扰）', () => {
    expect(commandForCombo(DEFAULT_BINDS, 'Space', 'battle')).toBe('end_turn')
    expect(commandForCombo(DEFAULT_BINDS, 'Space', 'replay')).toBe('replay_play_pause')
  })
})

describe('combo 解析与修饰键', () => {
  it('数字/字母/空格/命名键归一化', () => {
    expect(comboFromEvent(key({ key: '1' }))).toBe('1')
    expect(comboFromEvent(key({ key: '0' }))).toBe('0')
    expect(comboFromEvent(key({ key: 'h' }))).toBe('H')
    expect(comboFromEvent(key({ key: ' ' }))).toBe('Space')
    expect(comboFromEvent(key({ key: 'Tab' }))).toBe('Tab')
    expect(comboFromEvent(key({ key: 'Enter' }))).toBe('Enter')
    expect(comboFromEvent(key({ key: 'Escape' }))).toBe('Escape')
    expect(comboFromEvent(key({ key: 'ArrowRight' }))).toBe('ArrowRight')
  })

  it('? 按下产出 "?"（Shift 已体现在符号本身，不再记 Shift）', () => {
    expect(comboFromEvent(key({ key: '?', shiftKey: true }))).toBe('?')
    expect(isValidCombo('?')).toBe(true)
  })

  it('字母键显式区分 Shift（H 与 Shift+H 是两个 combo）', () => {
    expect(comboFromEvent(key({ key: 'h', shiftKey: true }))).toBe('Shift+H')
    expect(comboFromEvent(key({ key: 'h' }))).toBe('H')
  })

  it('Ctrl/Alt/Meta 组合按规范顺序拼接', () => {
    expect(comboFromEvent(key({ key: 'k', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+K')
    expect(comboFromEvent(key({ key: 'x', metaKey: true, shiftKey: true }))).toBe('Shift+Meta+X')
  })

  it('纯修饰键不算一次绑定', () => {
    expect(comboFromEvent(key({ key: 'Shift' }))).toBeNull()
    expect(comboFromEvent(key({ key: 'Control', ctrlKey: true }))).toBeNull()
  })

  it('保留键拒收：切标签/刷新/全屏那挂', () => {
    expect(isReservedCombo('Ctrl+Tab')).toBe(true)
    expect(isReservedCombo('Shift+Ctrl+Tab')).toBe(true)
    expect(isReservedCombo('Meta+Tab')).toBe(true)
    expect(isReservedCombo('Ctrl+W')).toBe(true)
    expect(isReservedCombo('Meta+T')).toBe(true)
    expect(isReservedCombo('Ctrl+N')).toBe(true)
    expect(isReservedCombo('Meta+Q')).toBe(true)
    expect(isReservedCombo('Ctrl+R')).toBe(true)
    expect(isReservedCombo('Alt+F4')).toBe(true)
    expect(isReservedCombo('F5')).toBe(true)
    expect(isReservedCombo('F11')).toBe(true)
    expect(isReservedCombo('F12')).toBe(true)
    // 普通键不受牵连
    expect(isReservedCombo('Tab')).toBe(false)
    expect(isReservedCombo('Ctrl+K')).toBe(false)
  })

  it('formatCombo 人类可读（键位表/角标/编辑器共用）', () => {
    expect(formatCombo('Space')).toBe('空格')
    expect(formatCombo('Escape')).toBe('Esc')
    expect(formatCombo('?')).toBe('?')
    expect(formatCombo('Ctrl+Alt+K')).toBe('Ctrl + Alt + K')
  })

  it('parseCombo 对坏格式返回 null', () => {
    expect(parseCombo('')).toBeNull()
    expect(parseCombo('Ctrl++')).toBeNull()
    expect(parseCombo('K+Ctrl')).toBeNull() // 修饰键必须在主键前
    expect(parseCombo('Ctrl+Ctrl+K')).toBeNull() // 重复修饰键
    expect(parseCombo('WRONG+Ctrl+K')).toBeNull() // 非法修饰键名
    expect(parseCombo('K')).toEqual({ mods: [], base: 'K' })
  })
})

describe('冲突检测', () => {
  it('同 scope 重复键检出并指认被占命令', () => {
    const result = validateBind(DEFAULT_BINDS, 'hero_power', 'Space')
    expect(result.ok).toBe(false)
    if (!result.ok && result.code === 'conflict') {
      expect(result.conflictCommand).toBe('end_turn')
    } else {
      throw new Error('应检出冲突')
    }
  })

  it('global 命令与所有 scope 冲突', () => {
    const result = validateBind(DEFAULT_BINDS, 'mute', 'H')
    expect(result.ok).toBe(false)
  })

  it('battle 与 replay 异 scope 重复键合法（键位分离互不干扰）', () => {
    const binds = { ...DEFAULT_BINDS, replay_play_pause: 'H' }
    expect(validateBind(binds, 'hero_power', 'H')).toEqual({ ok: true })
  })

  it('保留键拒收有专属提示', () => {
    const result = validateBind(DEFAULT_BINDS, 'mute', 'Ctrl+Tab')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('reserved')
  })

  it('改成自己当前键位是幂等合法', () => {
    expect(validateBind(DEFAULT_BINDS, 'end_turn', 'Space')).toEqual({ ok: true })
  })

  it('findScopeConflict 能抓到交换后的第三方撞键', () => {
    const binds = defaultBinds()
    binds.replay_speed = 'Tab' // replay 与 battle 的 Tab 合法共存
    expect(findScopeConflict(binds)).toBeNull()
    binds.toggle_key_hints = 'Tab' // global 撞上双方 → 冲突
    expect(findScopeConflict(binds)).not.toBeNull()
  })
})

describe('combo→命令反查（键盘钩子的翻译核心）', () => {
  it('默认键位逐条反查正确', () => {
    expect(commandForCombo(DEFAULT_BINDS, '1', 'battle')).toBe('play_slot_1')
    expect(commandForCombo(DEFAULT_BINDS, 'Space', 'battle')).toBe('end_turn')
    expect(commandForCombo(DEFAULT_BINDS, 'H', 'battle')).toBe('hero_power')
    expect(commandForCombo(DEFAULT_BINDS, 'Tab', 'battle')).toBe('cycle_target')
    expect(commandForCombo(DEFAULT_BINDS, 'Enter', 'battle')).toBe('confirm')
    expect(commandForCombo(DEFAULT_BINDS, 'Escape', 'battle')).toBe('cancel')
    expect(commandForCombo(DEFAULT_BINDS, 'M', 'battle')).toBe('mute')
    expect(commandForCombo(DEFAULT_BINDS, '?', 'battle')).toBe('help')
  })

  it('scope 过滤：battle 视角看不到 replay 命令（fast_forward 默认 F）', () => {
    expect(commandForCombo(DEFAULT_BINDS, 'F', 'battle')).toBeNull()
    expect(commandForCombo(DEFAULT_BINDS, 'F', 'replay')).toBe('fast_forward')
    expect(commandForCombo(DEFAULT_BINDS, 'R', 'replay')).toBe('replay_speed')
    expect(commandForCombo(DEFAULT_BINDS, 'ArrowRight', 'replay')).toBe('replay_step')
  })

  it('自定义键位即时反映', () => {
    const binds = { ...DEFAULT_BINDS, end_turn: 'Ctrl+Enter' }
    expect(commandForCombo(binds, 'Ctrl+Enter', 'battle')).toBe('end_turn')
    expect(commandForCombo(binds, 'Space', 'battle')).toBeNull()
  })

  it('未知 combo 返回 null', () => {
    expect(commandForCombo(DEFAULT_BINDS, 'Ctrl+Alt+F13', 'battle')).toBeNull()
  })
})

describe('localStorage 容错读写', () => {
  it('roundtrip：save 后 load 原样读回', () => {
    const storage = fakeStorage()
    const binds = { ...defaultBinds(), mute: 'Ctrl+M' }
    saveKeybinds({ binds, hintsVisible: false }, storage)
    const loaded = loadKeybinds(storage)
    expect(loaded.binds.mute).toBe('Ctrl+M')
    expect(loaded.hintsVisible).toBe(false)
  })

  it('无存储 / 无记录回落默认', () => {
    expect(loadKeybinds(undefined)).toEqual({ binds: defaultBinds(), hintsVisible: true })
    expect(loadKeybinds(fakeStorage()).binds).toEqual(defaultBinds())
  })

  it('JSON 损坏 / 非对象 / 版本不符整体回落默认且不报错', () => {
    const broken = fakeStorage({ [KEYBINDS_STORAGE_KEY]: '{not-json' })
    expect(loadKeybinds(broken)).toEqual({ binds: defaultBinds(), hintsVisible: true })

    const notObject = fakeStorage({ [KEYBINDS_STORAGE_KEY]: JSON.stringify('haha') })
    expect(loadKeybinds(notObject).binds).toEqual(defaultBinds())

    const wrongVersion = fakeStorage({
      [KEYBINDS_STORAGE_KEY]: JSON.stringify({ version: 999, binds: { mute: 'X' }, hintsVisible: false }),
    })
    expect(loadKeybinds(wrongVersion)).toEqual({ binds: defaultBinds(), hintsVisible: true })
  })

  it('单条损坏只影响该条：非法格式 / 保留键 / 未知命令 / 重复 combo', () => {
    const payload = {
      version: KEYBINDS_SCHEMA_VERSION,
      binds: {
        mute: 'Ctrl+M', // 合法自定义
        end_turn: 'NOT A COMBO', // 格式坏 → 回落 Space
        hero_power: 'Ctrl+Tab', // 保留键 → 回落 H
        no_such_command: 'Z', // 未知命令 → 忽略
        cycle_target: 'Ctrl+M', // 与 mute（global）scope 相交的重复 → 回落 Tab
      },
      hintsVisible: true,
    }
    const storage = fakeStorage({ [KEYBINDS_STORAGE_KEY]: JSON.stringify(payload) })
    const loaded = loadKeybinds(storage)
    expect(loaded.binds.mute).toBe('Ctrl+M')
    expect(loaded.binds.end_turn).toBe('Space')
    expect(loaded.binds.hero_power).toBe('H')
    expect(loaded.binds.cycle_target).toBe('Tab')
    expect(findScopeConflict(loaded.binds)).toBeNull()
  })

  it('异 scope 重复 combo 载入时保留', () => {
    const payload = {
      version: KEYBINDS_SCHEMA_VERSION,
      binds: { replay_play_pause: 'H' }, // 与 hero_power 异 scope，合法
      hintsVisible: true,
    }
    const storage = fakeStorage({ [KEYBINDS_STORAGE_KEY]: JSON.stringify(payload) })
    expect(loadKeybinds(storage).binds.replay_play_pause).toBe('H')
  })

  it('hintsVisible 非布尔回落 true；写入失败静默', () => {
    const weird = fakeStorage({
      [KEYBINDS_STORAGE_KEY]: JSON.stringify({ version: KEYBINDS_SCHEMA_VERSION, binds: {}, hintsVisible: 'yes' }),
    })
    expect(loadKeybinds(weird).hintsVisible).toBe(true)

    const storage = fakeStorage()
    storage.failWrites()
    expect(() => saveKeybinds({ binds: defaultBinds(), hintsVisible: true }, storage)).not.toThrow()
  })

  it('sanitizeBinds 直接调用：null 输入给全默认表', () => {
    expect(sanitizeBinds(null)).toEqual(defaultBinds())
    const ids = Object.keys(sanitizeBinds(null))
    expect(ids).toHaveLength(COMMAND_DEFS.length)
  })
})

describe('keybindsStore 状态迁移', () => {
  beforeEach(() => {
    resetKeybindsForTests()
  })

  it('setBind 合法变更生效', () => {
    expect(useKeybinds.getState().setBind('end_turn', 'Ctrl+Enter')).toEqual({ ok: true })
    expect(useKeybinds.getState().binds.end_turn).toBe('Ctrl+Enter')
  })

  it('setBind 冲突/保留键被拒且状态不变', () => {
    expect(useKeybinds.getState().setBind('hero_power', 'Space').ok).toBe(false)
    expect(useKeybinds.getState().setBind('mute', 'Ctrl+Tab').ok).toBe(false)
    expect(useKeybinds.getState().binds.hero_power).toBe('H')
    expect(useKeybinds.getState().binds.mute).toBe('M')
  })

  it('swapBind 与被占命令互换', () => {
    const result = useKeybinds.getState().swapBind('hero_power', 'Space', 'end_turn')
    expect(result).toEqual({ ok: true })
    expect(useKeybinds.getState().binds.hero_power).toBe('Space')
    expect(useKeybinds.getState().binds.end_turn).toBe('H')
    expect(findScopeConflict(useKeybinds.getState().binds)).toBeNull()
  })

  it('swapBind 撞第三方时拒绝且状态不变', () => {
    useKeybinds.getState().setBind('replay_speed', 'Tab') // replay 独占 Tab（与 cycle_target 异 scope）
    const before = useKeybinds.getState().binds
    const result = useKeybinds.getState().swapBind('mute', 'Tab', 'cycle_target')
    expect(result.ok).toBe(false)
    expect(useKeybinds.getState().binds).toEqual(before)
  })

  it('resetBind 单条恢复 / resetAll 全部恢复 / toggleHints 开关', () => {
    useKeybinds.getState().setBind('mute', 'Ctrl+M')
    useKeybinds.getState().toggleHints()
    expect(useKeybinds.getState().hintsVisible).toBe(false)
    useKeybinds.getState().resetBind('mute')
    expect(useKeybinds.getState().binds.mute).toBe('M')
    expect(useKeybinds.getState().hintsVisible).toBe(false)
    useKeybinds.getState().resetAll()
    expect(useKeybinds.getState().binds).toEqual(defaultBinds())
    expect(useKeybinds.getState().hintsVisible).toBe(false)
    useKeybinds.getState().toggleHints()
    expect(useKeybinds.getState().hintsVisible).toBe(true)
  })
})

describe('输入聚焦失活判定（键盘钩子前置条件）', () => {
  it('输入类元素失活，其余放行', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'input' })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntryTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
    expect(isTextEntryTarget(undefined)).toBe(false)
    expect(isTextEntryTarget({})).toBe(false)
  })
})
