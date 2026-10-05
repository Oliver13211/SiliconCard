/**
 * 结算画面（M1-UI3）：「R.I.P 烧了」。
 * 数据严格按 rules.md §9：GAME_END（winner/reason）+ 终局 viewFor（turn、双方
 * heroName/faction/health/fatigue），不扩事件载荷。
 */

import { useGameStore } from '../store/gameStore'
import { useLanStore } from '../store/lanStore'

const REASON_LABELS = {
  health_zero: 'CPU 体质归零',
  concede: '认输（拔电源）',
} as const

export function ResultScreen() {
  const result = useGameStore((s) => s.result)
  const rematch = useGameStore((s) => s.rematch)
  const remoteMode = useGameStore((s) => s.remoteMode)
  const leaveAndBackToMenu = useLanStore((s) => s.leaveAndBackToMenu)
  if (!result) return null
  return (
    <div className={`sc-result is-${result.winner}`}>
      <h1 className="sc-result-headline">{result.headline}</h1>
      <p className="sc-result-subline">{result.subline}</p>
      <p className="sc-result-meta">
        共 {result.turns} 回合 · 终局原因：{REASON_LABELS[result.reason]}
      </p>
      <div className="sc-result-grid">
        {[result.you, result.opponent].map((side, index) => (
          <div key={index} className={`sc-result-side${side.isWinner ? ' is-winner' : ''}`}>
            <span className="sc-result-side-label">{index === 0 ? '你' : '对面'}</span>
            <strong className="sc-result-side-name">{side.heroName}</strong>
            <span>{side.faction}</span>
            <span>
              ❤ {side.health}
              {side.armor > 0 ? ` 🛡 ${side.armor}` : ''}
            </span>
            <span>疲劳 {side.fatigue}</span>
            <span className="sc-result-verdict">{side.isWinner ? 'WIN' : 'R.I.P'}</span>
          </div>
        ))}
      </div>
      <div className="sc-setup-actions">
        {remoteMode ? (
          // 联机对局在服务端：房间制一局一票，重开请回房间/重建房（无本地 rematch）
          <button type="button" className="sc-btn sc-btn--primary" onClick={() => void leaveAndBackToMenu()}>
            返回主菜单（离开房间）
          </button>
        ) : (
          <>
            <button type="button" className="sc-btn sc-btn--primary" onClick={() => rematch()}>
              再来一局（换新种子）
            </button>
            <button type="button" className="sc-btn" onClick={() => useGameStore.getState().backToMenu()}>
              返回主菜单
            </button>
          </>
        )}
      </div>
    </div>
  )
}
