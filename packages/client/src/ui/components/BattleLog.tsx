/**
 * 战报日志（M1-UI1）：按事件流倒序展示，最新在上；对局事实全部来自事件。
 */

import { useGameStore } from '../store/gameStore'

export function BattleLog() {
  const log = useGameStore((s) => s.log)
  return (
    <aside className="sc-log" aria-label="战报日志">
      <h2 className="sc-log-title">战报</h2>
      <ol className="sc-log-list">
        {log.map((entry) => (
          <li key={entry.id} className={`sc-log-item is-${entry.tone}`}>
            {entry.text}
          </li>
        ))}
      </ol>
    </aside>
  )
}
