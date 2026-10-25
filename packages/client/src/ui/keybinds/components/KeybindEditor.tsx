/**
 * 键位编辑器（P2-UI5 §3，挂在开局配置屏）。
 *
 * 交互流：点命令行 → 进入捕获（"按新键…"）→ 按新键（支持 Shift/Ctrl/Alt 修饰组合）：
 * - 保留键（Ctrl+Tab 那挂）拒收并提示改选；
 * - 冲突（scope 相交命令已占用）给「交换 / 改选」二选一；
 * - Esc 取消捕获（因此 Esc 本身不可被绑定为新键，默认绑定不受影响）；
 * - 纯修饰键按下不结束捕获（提示"再按主键"）。
 * 单条恢复默认 / 一键全部重置 / `?` 键位表浮层（编辑器内也能看全表）。
 */

import { Fragment, useEffect, useState } from 'react'
import '../../styles/keybinds.css'
import {
  COMMAND_DEFS,
  PLAY_SLOT_COMMANDS,
  REPLAY_COMMANDS,
  type CommandDef,
  type CommandId,
} from '../commands'
import { comboFromEvent, formatCombo } from '../combo'
import { defaultBinds, validateBind } from '../bindings'
import { useKeybinds } from '../keybindsStore'
import { KeyHintsOverlay } from './KeyHintsOverlay'

interface PendingConflict {
  command: CommandId
  combo: string
  conflictCommand: CommandId
}

function groupOf(def: CommandDef): string {
  if (def.scopes.includes('global')) return '通用'
  if (PLAY_SLOT_COMMANDS.includes(def.id)) return '出牌'
  if (REPLAY_COMMANDS.includes(def.id) || def.id === 'fast_forward') return '回放'
  return '对局'
}

const GROUP_ORDER = ['出牌', '对局', '回放', '通用'] as const

export function KeybindEditor() {
  const binds = useKeybinds((s) => s.binds)
  const hintsVisible = useKeybinds((s) => s.hintsVisible)
  const setBind = useKeybinds((s) => s.setBind)
  const swapBind = useKeybinds((s) => s.swapBind)
  const resetBind = useKeybinds((s) => s.resetBind)
  const resetAll = useKeybinds((s) => s.resetAll)
  const toggleHints = useKeybinds((s) => s.toggleHints)

  const [capturing, setCapturing] = useState<CommandId | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [conflict, setConflict] = useState<PendingConflict | null>(null)
  const [showHints, setShowHints] = useState(false)

  // 捕获态监听：窗口级 keydown 全拦（stopPropagation 防别的钩子抢跑）
  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        setConflict(null)
        setNotice(null)
        return
      }
      const combo = comboFromEvent(event)
      if (!combo) {
        setNotice('修饰键已按住——再按一个主键完成绑定')
        return
      }
      const result = validateBind(useKeybinds.getState().binds, capturing, combo)
      if (result.ok) {
        setBind(capturing, combo)
        setCapturing(null)
        setConflict(null)
        setNotice(null)
        return
      }
      if (result.code === 'conflict') {
        setNotice(null)
        setConflict({ command: capturing, combo, conflictCommand: result.conflictCommand })
        return
      }
      setConflict(null)
      setNotice(result.message)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, setBind])

  function startCapture(command: CommandId) {
    setConflict(null)
    setNotice(null)
    setCapturing(command)
  }

  function handleSwap() {
    if (!conflict) return
    const result = swapBind(conflict.command, conflict.combo, conflict.conflictCommand)
    if (result.ok) {
      setConflict(null)
      setCapturing(null)
    } else {
      setConflict(null)
      setNotice(result.message)
    }
  }

  function handleResetAll() {
    if (window.confirm('把全部键位恢复默认？（自定义会丢，马上生效）')) resetAll()
  }

  const conflictDef = conflict ? COMMAND_DEFS.find((def) => def.id === conflict.conflictCommand) : null

  return (
    <div className="sc-key-editor">
      <div className="sc-key-editor-bar">
        <button type="button" className="sc-btn sc-btn--small" onClick={toggleHints}>
          手牌键位角标：{hintsVisible ? '开' : '关'}
        </button>
        <button type="button" className="sc-btn sc-btn--small" onClick={() => setShowHints(true)} title="查看当前全部键位">
          键位表（?）
        </button>
        <button type="button" className="sc-btn sc-btn--small sc-btn--danger" onClick={handleResetAll}>
          全部恢复默认
        </button>
      </div>
      <p className="sc-key-editor-note">
        点一条命令再按新键，支持 Shift / Ctrl / Alt 组合；Esc 退出捕获；改完立即生效并记进本机。
      </p>

      {GROUP_ORDER.map((group) => (
        <section key={group} className="sc-key-editor-group">
          <h4>{group}</h4>
          {COMMAND_DEFS.filter((def) => groupOf(def) === group).map((def) => {
            const isCapturing = capturing === def.id
            const pending = conflict?.command === def.id
            return (
              <Fragment key={def.id}>
                <div className={`sc-key-row${isCapturing ? ' is-capturing' : ''}`}>
                  <span className="sc-key-label" title={def.description}>
                    {def.label}
                  </span>
                  <button
                    type="button"
                    className={`sc-key-keybtn${binds[def.id] !== defaultBinds()[def.id] ? ' is-custom' : ''}`}
                    onClick={() => startCapture(def.id)}
                    aria-label={`为「${def.label}」设置新键位，当前 ${formatCombo(binds[def.id])}`}
                  >
                    {isCapturing ? '按新键…（Esc 取消）' : formatCombo(binds[def.id])}
                  </button>
                  <button
                    type="button"
                    className="sc-key-reset"
                    onClick={() => resetBind(def.id)}
                    disabled={binds[def.id] === defaultBinds()[def.id]}
                    title="恢复这条的默认键位"
                  >
                    默认
                  </button>
                </div>
                {pending && conflict ? (
                  <div className="sc-key-conflict" role="alert">
                    <span>{`「${conflictDef?.label ?? conflict.conflictCommand}」已经占了这个键——交换还是改选？`}</span>
                    <button type="button" className="sc-btn sc-btn--small" onClick={handleSwap}>
                      交换
                    </button>
                    <button
                      type="button"
                      className="sc-btn sc-btn--small"
                      onClick={() => {
                        setConflict(null)
                        setNotice(null)
                      }}
                    >
                      改选
                    </button>
                  </div>
                ) : null}
              </Fragment>
            )
          })}
        </section>
      ))}

      {notice && capturing ? <p className="sc-key-notice" role="status">{notice}</p> : null}

      {showHints ? <KeyHintsOverlay scope="all" onClose={() => setShowHints(false)} /> : null}
    </div>
  )
}
