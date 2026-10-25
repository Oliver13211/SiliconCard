/**
 * CodexScreen —— 全卡牌图鉴（P2-UI4）：90 卡瀑布网格 + 筛选/排序 + 详情面板。
 *
 * - 卡池 = content/cards 全部 JSON（cardPool.loadCodexCards，与对局同一数据源，
 *   新卡入池零登记自动进图鉴）；
 * - 卡面与对局同源渲染（three/CardFace 同函数同参数，TextureCache 复用）；
 * - 全卡开放（图鉴是学习工具不是收集墙）；
 * - 挂载约定（p2-ui4-codex.md 交付 4）：AppRoot 按 useCodexStore(s => s.open)
 *   分流渲染本屏（与 ReplayScreen 同模式），主菜单「图鉴」入口调 openCodex()，
 *   接线由主控执行。
 */

import { useEffect, useMemo, useState } from 'react'
import { loadCodexCards, makeCardNameResolver } from './cardPool'
import {
  applyFilters,
  COST_BANDS,
  DEFAULT_FILTERS,
  factionsInPool,
  raritiesInPool,
  RARITY_LABELS,
  sortCards,
  TYPE_OPTIONS,
  type CodexFilters,
  type CodexSort,
} from './filters'
import { factionDisplayName } from '../game/fallbackContent'
import { useCodexStore } from './codexStore'
import { CodexCardFace } from './CodexCardFace'
import { CodexDetail } from './CodexDetail'
import { fetchBalanceStats, type BalanceStatTable } from './balanceStats'
import '../styles/codex.css'

const SORT_OPTIONS: readonly { id: CodexSort; label: string }[] = [
  { id: 'cost', label: '按功耗' },
  { id: 'name', label: '按名称' },
  { id: 'rarity', label: '按稀有度' },
]

export function CodexScreen() {
  const closeCodex = useCodexStore((s) => s.closeCodex)

  // 卡池只在首次挂载解析一次（Vite glob 构建期注入，运行时零开销）
  const [cards] = useState(() => loadCodexCards())
  const [filters, setFilters] = useState<CodexFilters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<CodexSort>('cost')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stats, setStats] = useState<BalanceStatTable>({})

  useEffect(() => {
    let alive = true
    void fetchBalanceStats().then((table) => {
      if (alive) setStats(table)
    })
    return () => {
      alive = false
    }
  }, [])

  const factions = useMemo(() => factionsInPool(cards), [cards])
  const rarities = useMemo(() => raritiesInPool(cards), [cards])
  const visible = useMemo(() => sortCards(applyFilters(cards, filters), sort), [cards, filters, sort])
  const resolveCardName = useMemo(() => makeCardNameResolver(cards), [cards])
  const selected = selectedId !== null ? (cards.find((c) => c.id === selectedId) ?? null) : null

  const patch = (partial: Partial<CodexFilters>) => setFilters((prev) => ({ ...prev, ...partial }))

  return (
    <div className="sc-codex">
      <header className="sc-codex-head">
        <h1 className="sc-screen-title">全卡图鉴</h1>
        <p className="sc-codex-sub">
          共 {cards.length} 张 · 当前显示 {visible.length} 张 —— 学习工具全卡开放，新卡入池自动上架。
        </p>
        <button type="button" className="sc-btn sc-btn--primary sc-codex-close" onClick={closeCodex}>
          返回主菜单
        </button>
      </header>

      <div className="sc-codex-controls" role="group" aria-label="图鉴筛选与排序">
        <label className="sc-codex-control">
          派系
          <select value={filters.faction} onChange={(e) => patch({ faction: e.target.value })}>
            <option value="all">全部派系</option>
            {factions.map((id) => (
              <option key={id} value={id}>
                {factionDisplayName(id)}
              </option>
            ))}
          </select>
        </label>

        <label className="sc-codex-control">
          稀有度
          <select value={filters.rarity} onChange={(e) => patch({ rarity: e.target.value as CodexFilters['rarity'] })}>
            <option value="all">全部稀有度</option>
            {rarities.map((id) => (
              <option key={id} value={id}>
                {RARITY_LABELS[id]}
              </option>
            ))}
          </select>
        </label>

        <div className="sc-codex-control" role="group" aria-label="类型筛选">
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="sc-btn sc-btn--small"
              aria-pressed={filters.type === option.id}
              onClick={() => patch({ type: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="sc-codex-control">
          费用区间
          <select value={filters.costBand} onChange={(e) => patch({ costBand: e.target.value as CodexFilters['costBand'] })}>
            {COST_BANDS.map((band) => (
              <option key={band.id} value={band.id}>
                {band.label}
              </option>
            ))}
          </select>
        </label>

        <label className="sc-codex-control">
          排序
          <select value={sort} onChange={(e) => setSort(e.target.value as CodexSort)}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="sc-codex-body">
        <ul className="sc-codex-grid">
          {visible.map((def) => (
            <li key={def.id}>
              <button
                type="button"
                className="sc-codex-cell"
                aria-pressed={selectedId === def.id}
                onClick={() => setSelectedId(def.id)}
              >
                <CodexCardFace def={def} />
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <CodexDetail
            def={selected}
            resolveCardName={resolveCardName}
            stat={stats[selected.id]}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  )
}
