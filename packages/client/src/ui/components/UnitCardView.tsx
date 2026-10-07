/**
 * 场上单位卡（M1-UI1）：攻/血角标、关键词梗名徽标、可选中/可作为目标的高亮。
 * 点击语义由 BattleScreen 决定（攻击宣告 / 确认目标）。
 * 演出修正阶段二：按稀有度挂 2.5D 描边档位类（is-rare/is-epic/is-legendary），
 * 交互态（is-selectable/is-targetable）优先级高于描边档位（见 hud.css 规则顺序）。
 */

import type { BoardUnit } from '@siliconcard/core'
import { cardDef, keywordLabelOf, rarityClassName } from './display'
import { targetKey } from '../game/legal'

export function UnitCardView({
  unit,
  targetable,
  selectable,
  onClick,
}: {
  unit: BoardUnit
  targetable: boolean
  selectable: boolean
  onClick: () => void
}) {
  const def = cardDef(unit.cardId)
  const keywordTexts = unit.keywords.map((k) => keywordLabelOf(k))
  return (
    <button
      type="button"
      className={[
        'sc-unit',
        rarityClassName(def?.rarity),
        targetable ? 'is-targetable' : '',
        selectable ? 'is-selectable' : '',
        unit.attacksRemaining > 0 ? 'can-attack' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-target-key={targetKey({ kind: 'unit', instanceId: unit.instanceId })}
      onClick={onClick}
      title={`${def?.name ?? unit.cardId}${def?.flavor ? ` · ${def.flavor}` : ''}`}
    >
      <span className="sc-unit-name">{def?.name ?? unit.cardId}</span>
      {keywordTexts.length > 0 ? (
        <span className="sc-unit-keywords">
          {keywordTexts.map((label) => (
            <em key={label}>{label}</em>
          ))}
        </span>
      ) : null}
      <span className="sc-unit-attack">{unit.attack}</span>
      <span className={`sc-unit-health${unit.health < unit.maxHealth ? ' is-hurt' : ''}`}>{unit.health}</span>
    </button>
  )
}
