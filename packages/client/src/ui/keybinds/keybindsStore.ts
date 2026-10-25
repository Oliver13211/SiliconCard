/**
 * keybindsStore —— 键位表 + 角标开关的唯一 zustand 状态（P2-UI5）。
 *
 * 纯界面偏好（非对局事实），模式与 uiPrefsStore 对齐：启动时从容错解析的
 * localStorage 初始化，每次变更即时落盘（失败静默）。冲突检测在 bindings.ts
 * （无头可测），这里只做状态迁移与持久化编排：
 * - setBind：校验失败原样返回结果（UI 展示冲突提示），成功才落库；
 * - swapBind：与被占命令互换键位（编辑器「交换」入口），交换双方都是合法 combo；
 * - resetBind / resetAll：恢复单条 / 全部默认。
 */

import { create } from 'zustand'
import { commandDefOf, type CommandId } from './commands'
import {
  defaultBinds,
  findScopeConflict,
  validateBind,
  type BindValidationResult,
  type BindMap,
} from './bindings'
import { loadKeybinds, saveKeybinds } from './storage'

interface KeybindsState {
  binds: BindMap
  hintsVisible: boolean
  setBind: (command: CommandId, combo: string) => BindValidationResult
  swapBind: (command: CommandId, combo: string, conflictCommand: CommandId) => BindValidationResult
  resetBind: (command: CommandId) => void
  resetAll: () => void
  toggleHints: () => void
}

const initial = loadKeybinds()

export const useKeybinds = create<KeybindsState>()(() => ({
  binds: initial.binds,
  hintsVisible: initial.hintsVisible,

  setBind: (command, combo) => {
    const { binds } = useKeybinds.getState()
    const result = validateBind(binds, command, combo)
    if (!result.ok) return result
    const next: BindMap = { ...binds, [command]: combo }
    saveKeybinds({ binds: next, hintsVisible: useKeybinds.getState().hintsVisible })
    useKeybinds.setState({ binds: next })
    return result
  },

  swapBind: (command, combo, conflictCommand) => {
    const { binds } = useKeybinds.getState()
    // 交换前再校验一次（UI 可能已过时）：保留键/非法直接拒绝；
    // 与 conflictCommand 的冲突正是交换要解决的事，放行；撞上别的命令则拒绝
    const result = validateBind(binds, command, combo)
    if (!result.ok && !(result.code === 'conflict' && result.conflictCommand === conflictCommand)) return result
    const displaced = binds[conflictCommand]
    const def = commandDefOf(conflictCommand)
    if (!def || !displaced) {
      return { ok: false, code: 'conflict', message: '被占的命令不存在了，重新打开编辑器试试', conflictCommand }
    }
    const next: BindMap = { ...binds, [command]: combo, [conflictCommand]: binds[command] }
    // 整表复核：被交换方拿到的新键可能撞上第三方（如 global 与异 scope 重复键）
    const leftover = findScopeConflict(next)
    if (leftover) {
      const other = commandDefOf(leftover.a === command ? leftover.b : leftover.a)
      return {
        ok: false,
        code: 'conflict',
        message: `换完撞上了「${other?.label ?? leftover.b}」的键——先给它换个地方`,
        conflictCommand,
      }
    }
    saveKeybinds({ binds: next, hintsVisible: useKeybinds.getState().hintsVisible })
    useKeybinds.setState({ binds: next })
    return { ok: true }
  },

  resetBind: (command) => {
    const { binds, hintsVisible } = useKeybinds.getState()
    if (binds[command] === defaultBinds()[command]) return
    const next: BindMap = { ...binds, [command]: defaultBinds()[command] }
    saveKeybinds({ binds: next, hintsVisible })
    useKeybinds.setState({ binds: next })
  },

  resetAll: () => {
    const { hintsVisible } = useKeybinds.getState()
    const next = defaultBinds()
    saveKeybinds({ binds: next, hintsVisible })
    useKeybinds.setState({ binds: next })
  },

  toggleHints: () => {
    const { binds, hintsVisible } = useKeybinds.getState()
    saveKeybinds({ binds, hintsVisible: !hintsVisible })
    useKeybinds.setState({ hintsVisible: !hintsVisible })
  },
}))

/** 测试隔离：恢复默认键位与角标开关（不动 localStorage） */
export function resetKeybindsForTests(): void {
  useKeybinds.setState({ binds: defaultBinds(), hintsVisible: true })
}
