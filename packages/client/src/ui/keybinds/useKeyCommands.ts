/**
 * useKeyCommands —— 对局/回放共用的键盘命令钩子（P2-UI5）。
 *
 * 职责单一：把「按键 → 当前键位表 → 命令」翻译出来，然后调用调用方挂的
 * handler（就是各屏既有点击逻辑的同一入口，键盘与鼠标走同一条代码路径，
 * 可交互性仍由 getLegalActions 统一驱动——非法操作由 gameStore 给梗化反馈）。
 *
 * 失活规则：
 * - 输入框聚焦（input/textarea/select/contentEditable）全部失活（plan §5）；
 * - 事件已被别处 preventDefault 的不再接管；
 * - 只有调用方挂了 handler 的命令才会被消费并 preventDefault（Tab 循环目标
 *   依赖这条：挂了 handler 才拦浏览器焦点切换，没挂则系统行为原样放行）。
 *
 * 本钩子只读键位表（useKeybinds.getState），不持有任何对局事实。
 */

import { useEffect, useRef } from 'react'
import type { CommandId, KeyScope } from './commands'
import { comboFromEvent } from './combo'
import { commandForCombo } from './bindings'
import { useKeybinds } from './keybindsStore'

export type KeyCommandHandlers = Partial<Record<CommandId, () => void>>

/** 输入类元素判定：可打字/可下拉的焦点目标上快捷键全部失活。
    入参用 unknown 鸭子判定（测试环境无 DOM，也能喂普通对象） */
export function isTextEntryTarget(target: unknown): boolean {
  const el = target as Partial<HTMLElement> | null | undefined
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/**
 * 挂全局 keydown 监听，按当前键位表把按键翻译成命令并调用 handler。
 * @param handlers 本界面消费的命令集（对局屏挂 battle+global，回放屏挂 replay+global）
 * @param scope 本界面的主 scope（冲突的同键异 scope 命令在此被过滤掉）
 */
export function useKeyCommands(handlers: KeyCommandHandlers, scope?: KeyScope): void {
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (isTextEntryTarget(event.target)) return
      const combo = comboFromEvent(event)
      if (!combo) return
      const command = commandForCombo(useKeybinds.getState().binds, combo, scope)
      if (!command) return
      const handler = handlersRef.current[command]
      if (!handler) return
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [scope])
}
