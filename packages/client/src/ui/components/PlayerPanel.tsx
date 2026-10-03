/**
 * 玩家面板（M1-UI1）：血量/护甲、功耗条、扩展槽指示、牌库/手牌/墓地计数、疲劳。
 * 数据一律来自 viewFor 视图（架构铁律 3）；血量与功耗永远一眼可见（预设硬约束）。
 */

import { MANA_PER_TURN } from '@siliconcard/core'
import type { PublicPlayerState } from '@siliconcard/core'
import { factionDisplayName } from '../game/fallbackContent'

export function ManaBar({ player, locked }: { player: PublicPlayerState; locked?: number }) {
  const segments = Math.max(1, Math.round(player.maxMana / MANA_PER_TURN))
  const filled = player.maxMana > 0 ? player.mana / player.maxMana : 0
  return (
    <div className="sc-mana" title={`供电：${player.mana}/${player.maxMana}W${locked ? ` · 下回合跳闸锁定 ${locked}W` : ''}`}>
      <div className="sc-mana-track">
        <div className="sc-mana-fill" style={{ width: `${Math.round(filled * 100)}%` }} />
        <div className="sc-mana-ticks">
          {Array.from({ length: segments }, (_, i) => (
            <span key={i} className="sc-mana-tick" />
          ))}
        </div>
      </div>
      <span className="sc-mana-text">
        {player.mana}/{player.maxMana}W
      </span>
      {locked && locked > 0 ? <span className="sc-mana-locked">跳闸锁定 {locked}W</span> : null}
    </div>
  )
}

export function PlayerPanel({
  player,
  side,
  locked,
  slotUsage,
}: {
  player: PublicPlayerState
  side: 'self' | 'opponent'
  locked?: number
  slotUsage?: string
}) {
  const hpRatio = Math.max(0, Math.min(1, player.health / player.maxHealth))
  return (
    <div className={`sc-player sc-player--${side}`}>
      <div className="sc-player-portrait" data-faction={player.faction}>
        {factionDisplayName(player.faction).slice(0, 2)}
      </div>
      <div className="sc-player-main">
        <div className="sc-player-name">
          <strong>{player.heroName}</strong>
          <span className="sc-player-faction">{factionDisplayName(player.faction)}</span>
        </div>
        <div className="sc-health">
          <div className="sc-health-track">
            <div className="sc-health-fill" style={{ width: `${Math.round(hpRatio * 100)}%` }} />
          </div>
          <span className="sc-health-text">
            ❤ {player.health}/{player.maxHealth}
            {player.armor > 0 ? <em className="sc-armor"> 🛡 {player.armor}</em> : null}
          </span>
        </div>
        <ManaBar player={player} locked={locked} />
        <div className="sc-counters">
          <span title="牌库剩余">🂠 牌库 {player.deckSize}</span>
          <span title="手牌张数">✋ 手牌 {player.handSize}</span>
          <span title="墓地（下岗显卡）">♻ {player.graveyardSize}</span>
          {player.fatigue > 0 ? <span className="sc-fatigue" title="牌库空转次数">疲劳 {player.fatigue}</span> : null}
          {slotUsage ? <span title="扩展槽占用">插槽 {slotUsage}</span> : null}
        </div>
      </div>
    </div>
  )
}
