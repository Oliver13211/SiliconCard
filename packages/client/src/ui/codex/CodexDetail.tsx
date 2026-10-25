/**
 * 图鉴详情面板（P2-UI4 交付 3）：大图 + 白话解释（glossary 渲染器，与 matchStep
 * 同语义）+ 关键词解释 + flavor + 数值 + 平衡数据 + 预留「演示」入口
 * （P2-UI2-2 演示基建落地后由主控点亮，此处先占位禁用）。
 */

import type { CardDefinition } from '@siliconcard/core'
import { factionDisplayName } from '../game/fallbackContent'
import { RARITY_LABELS } from './filters'
import { explainEffectSpec, explainKeyword, type CardNameResolver } from './glossaryRender'
import { playedRateLabel, winRateLabel, type CardBalanceStat } from './balanceStats'
import { CodexCardFace } from './CodexCardFace'

const TYPE_LABELS: Record<CardDefinition['type'], string> = {
  gpu: '显卡',
  driver: '驱动',
  accessory: '外设',
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sc-codex-stat">
      <span className="sc-codex-stat-label">{label}</span>
      <span className="sc-codex-stat-value">{value}</span>
    </div>
  )
}

export function CodexDetail({
  def,
  resolveCardName,
  stat,
  onClose,
}: {
  def: CardDefinition
  resolveCardName: CardNameResolver
  stat: CardBalanceStat | undefined
  onClose: () => void
}) {
  const explain = def.effect ? explainEffectSpec(def.effect, resolveCardName) : null
  const played = playedRateLabel(stat)
  const winRate = winRateLabel(stat)

  return (
    <aside className="sc-codex-detail" aria-label={`卡牌详情：${def.name}`}>
      <div className="sc-codex-detail-head">
        <h2 className="sc-codex-detail-name">{def.name}</h2>
        <button type="button" className="sc-btn sc-btn--small" onClick={onClose} aria-label="关闭详情">
          关闭
        </button>
      </div>

      <CodexCardFace def={def} className="sc-codex-face sc-codex-face--large" />

      <div className="sc-codex-stats">
        <Stat label="功耗" value={`${def.cost}W`} />
        {def.type === 'gpu' && (
          <>
            <Stat label="攻击" value={String(def.attack ?? 0)} />
            <Stat label="血量" value={String(def.health ?? 0)} />
          </>
        )}
        <Stat label="类型" value={TYPE_LABELS[def.type]} />
        <Stat label="派系" value={factionDisplayName(def.faction)} />
        <Stat label="稀有度" value={def.rarity ? RARITY_LABELS[def.rarity] : '—'} />
      </div>

      {def.tags !== undefined && def.tags.length > 0 && (
        <p className="sc-codex-tags">
          标签：
          {def.tags.map((tag) => (
            <span key={tag} className="sc-codex-tag">
              {tag}
            </span>
          ))}
        </p>
      )}

      {explain && (
        <section className="sc-codex-explain">
          <h3>白话解释</h3>
          <p className="sc-codex-explain-trigger">{explain.triggerLabel}</p>
          <ul>
            {explain.sentences.map((sentence, i) => (
              <li key={i}>{sentence}</li>
            ))}
          </ul>
          {!explain.ok && (
            <p className="sc-codex-explain-missing" role="alert">
              白话解释缺词条（glossary 待补）：{explain.problems.join('；')}
            </p>
          )}
        </section>
      )}

      {def.keywords !== undefined && def.keywords.length > 0 && (
        <section className="sc-codex-keywords">
          <h3>关键词</h3>
          <ul>
            {def.keywords.map((id) => (
              <li key={id}>{explainKeyword(id) ?? id}</li>
            ))}
          </ul>
        </section>
      )}

      {def.flavor && (
        <p className="sc-codex-flavor">「{def.flavor}」</p>
      )}

      <section className="sc-codex-balance">
        <h3>平衡数据</h3>
        {played !== null && winRate !== null ? (
          <p>
            出场率 {played} · 出场胜率 {winRate}
          </p>
        ) : (
          <p className="sc-codex-balance-empty">暂无出场记录</p>
        )}
      </section>

      <button type="button" className="sc-btn sc-codex-demo" disabled title="演示模式将随 P2-UI2-2 上线后点亮">
        演示（即将上线）
      </button>
    </aside>
  )
}
