/**
 * 手牌卡（M1-UI1/2）：功耗环、类型、攻血、关键词梗名；
 * 可打性由 getLegalActions 推导（handCardStatus），禁用时灰显并标注梗化原因。
 */

import type { HandCard } from '@siliconcard/core'
import { cardDef, typeLabel, keywordLabelOf } from './display'
import type { Availability } from '../game/legal'

export function HandCardView({
  card,
  status,
  selected,
  onClick,
}: {
  card: HandCard
  status: Availability
  selected: boolean
  onClick: () => void
}) {
  const def = cardDef(card.cardId)
  const playable = status.available
  return (
    <button
      type="button"
      className={`sc-hand-card${playable ? '' : ' is-disabled'}${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      disabled={!playable}
      title={playable ? (def?.flavor ?? card.cardId) : (status.reason ?? '现在打不出')}
      data-uid={card.uid}
    >
      <span className="sc-hand-cost">{card.cost}W</span>
      <span className="sc-hand-name">{def?.name ?? card.cardId}</span>
      <span className="sc-hand-type">{def ? typeLabel(def.type) : '??'}</span>
      {def?.type === 'gpu' ? (
        <span className="sc-hand-stats">
          ⚔ {def.attack ?? 0} / ❤ {def.health ?? 0}
        </span>
      ) : null}
      {def?.keywords && def.keywords.length > 0 ? (
        <span className="sc-hand-keywords">{def.keywords.map((k) => keywordLabelOf(k)).join(' · ')}</span>
      ) : null}
      {!playable && status.reason ? <span className="sc-hand-reason">{status.reason}</span> : null}
    </button>
  )
}
