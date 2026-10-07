/**
 * 手牌卡（M1-UI1/2）：功耗环、类型、攻血、关键词梗名；
 * 可打性由 getLegalActions 推导（handCardStatus），禁用时灰显并标注梗化原因。
 * M4-R3D5：CSS 3D 立体预览——悬停绕 Y 轴翻面，背面展示 flavor/派系/关键词详情
 * （perspective/rotateY/backface-visibility 见 hud.css；正面结构原样保留）。
 * 演出修正阶段二：按稀有度挂 2.5D 描边档位类（is-rare/is-epic/is-legendary），
 * 与 3D 场景描边（cardOutline）观感统一——hover/选中加亮、传说金边。
 */

import type { HandCard } from '@siliconcard/core'
import { cardDef, rarityClassName, typeLabel, keywordLabelOf } from './display'
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
      className={`sc-hand-card ${rarityClassName(def?.rarity)}${playable ? '' : ' is-disabled'}${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      disabled={!playable}
      title={playable ? (def?.flavor ?? card.cardId) : (status.reason ?? '现在打不出')}
      data-uid={card.uid}
    >
      <span className="sc-hand-face">
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
      </span>
      {/* 背面（CSS 3D 详情面）：悬停翻面时可见 */}
      <span className="sc-hand-back" aria-hidden="true">
        <span className="sc-hand-back-name">{def?.name ?? card.cardId}</span>
        {def?.flavor ? <span className="sc-hand-back-flavor">“{def.flavor}”</span> : null}
        <span className="sc-hand-back-meta">
          {def ? `${typeLabel(def.type)} · ${def.faction.toUpperCase()}` : ''}
          {def?.type === 'gpu' ? ` · ⚔${def.attack ?? 0}/❤${def.health ?? 0}` : ''}
        </span>
        {def?.keywords && def.keywords.length > 0 ? (
          <span className="sc-hand-back-keywords">{def.keywords.map((k) => keywordLabelOf(k)).join(' · ')}</span>
        ) : (
          <span className="sc-hand-back-keywords">无关键词</span>
        )}
      </span>
    </button>
  )
}
