/**
 * 战报日志（M1-UI1 / P2-UI1）：按回合分组折叠展示，最新在上；对局事实全部来自事件。
 * - 回合头可点收起/展开；默认展开最近 2 回合（LOG_DEFAULT_OPEN_TURNS），其余折叠；
 *   用户手动开合后覆盖默认态（新回合仍按默认规则：最近 2 回合展开）；
 * - 关键事件（斩杀/终局/跳闸/质保破/传说入场）按 tokens 状态语义色高亮（is-key 系），
 *   类别判定在 eventLog（按事件 type/关键字段），本组件只做呈现。
 */

import { useState } from 'react'
import { useGameStore } from '../store/gameStore'
import { groupLogByTurn, LOG_DEFAULT_OPEN_TURNS } from '../game/eventLog'

export function BattleLog() {
  const log = useGameStore((s) => s.log)
  const groups = groupLogByTurn(log)
  // 手动开合覆盖（turn → 用户意愿）；未覆盖的回合走默认：最近 2 回合展开
  const [forceCollapsed, setForceCollapsed] = useState<ReadonlySet<number>>(new Set())
  const [forceExpanded, setForceExpanded] = useState<ReadonlySet<number>>(new Set())

  const defaultOpen = new Set(groups.slice(0, LOG_DEFAULT_OPEN_TURNS).map((g) => g.turn))
  const isOpen = (turn: number) => {
    if (forceCollapsed.has(turn)) return false
    if (forceExpanded.has(turn)) return true
    return defaultOpen.has(turn)
  }
  const toggle = (turn: number) => {
    const open = isOpen(turn)
    setForceCollapsed((prev) => {
      const next = new Set(prev)
      if (open) next.add(turn)
      else next.delete(turn)
      return next
    })
    setForceExpanded((prev) => {
      const next = new Set(prev)
      if (open) next.delete(turn)
      else next.add(turn)
      return next
    })
  }

  return (
    <aside className="sc-log" aria-label="战报日志">
      <h2 className="sc-log-title">战报</h2>
      <ol className="sc-log-list">
        {groups.map((group) => {
          const open = isOpen(group.turn)
          // 回合头已承载 TURN_START 信息，条目行里不再重复渲染
          const items = group.entries.filter((item) => item.kind !== 'turn')
          return (
            <li key={group.turn} className="sc-log-group">
              <button
                type="button"
                className={`sc-log-head${open ? ' is-open' : ''}`}
                onClick={() => toggle(group.turn)}
                aria-expanded={open}
                title={open ? '收起这一回合' : '展开这一回合'}
              >
                <span className="sc-log-head-arrow" aria-hidden="true">
                  ▶
                </span>
                <span className="sc-log-head-title">{group.title}</span>
                <span className="sc-log-head-count">{items.length} 条</span>
              </button>
              {open ? (
                <ol className="sc-log-items">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className={[
                        'sc-log-item',
                        `is-${item.tone}`,
                        item.kind ? `is-key is-${item.kind}` : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {item.text}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
