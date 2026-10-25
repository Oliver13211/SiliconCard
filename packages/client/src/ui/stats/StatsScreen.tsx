/**
 * StatsScreen —— 数值面板（P2-DATA1）：两层切换「全局模拟 / 个人历史」。
 *
 * 全局模拟（离线预生成随包发布）：派系胜率横向条形图（7 派系 + 50% 基准线，
 * 纯 CSS 自绘不引库）+ 卡牌出场率/打出胜率表（按派系筛选、按列排序）+
 * generatedAt / gamesTotal 口径标注；每个数字带口径 hover 提示（.sc-stats-tip）。
 * 个人历史：回放库（P2-INF1）聚合总场次/胜负/胜率、按派系分布、最近 10 局列表。
 *
 * 挂载约定（主控接线，本文件不碰 AppRoot/screens/gameStore）：
 * - 路由建议：gameStore Screen 增加 'stats'（或按 open 旗标分流，与回放库同款）；
 * - props.onClose：返回主菜单；
 * - props.onOpenReplay?(id)：最近 10 局行的「回放」按钮回调——建议接
 *   useReplayStore.getState().openPlayer(id)（播放器屏挂载后自动生效）；
 *   未接线时不渲染该按钮（不摆假按钮）。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FactionId } from '@siliconcard/core'
import { factionDisplayName } from '../game/fallbackContent'
import { replayDateLabel, replayTimeLabel, type ReplayMeta } from '../replay/types'
import {
  factionLabel,
  fetchBalanceStats,
  factionUsage,
  loadLocalHistory,
  percentLabel,
  recentMetas,
  sortCardRows,
  summarizeHistory,
  withCardFaction,
  type BalanceStats,
  type CardSortKey,
  type FactionUsageRow,
  type HistorySummary,
  type LocalHistory,
  type SortDir,
} from './statsData'
import '../styles/stats.css'

type StatsLayer = 'global' | 'local'

// —— 口径提示（hover 展示，title 作可访问性兜底） ——

function Tip({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <span className="sc-stats-tip" data-tip={tip} title={tip}>
      {children}
    </span>
  )
}

const TIP_FACTION_WIN = '口径：预组自对弈模拟——(胜 + 0.5×平) / 局数，仅跨卡组对局（镜像局不进强度统计）'
const TIP_GAMES_TOTAL = '口径：本次模拟总局数（7 套预组两两循环 + 镜像局）'
const TIP_CARD_PLAYED = '口径：该卡出场局数 ÷ 所在卡组参与局数（含镜像局）'
const TIP_CARD_WIN = '口径：该卡出场的对局中，使用方胜率（含镜像局）'
const TIP_LOCAL_TOTAL = '口径：本机回放库里的对局数（只含录上来的对局，上限最近 50 局）'
const TIP_LOCAL_WINRATE = '口径：(胜 + 0.5×平) / 总场次，按回放库录制视角统计'
const TIP_LOCAL_FACTION = '口径：你在这局使用的派系（录制视角 P1/P2 对应位）'

// —— 全局模拟层 ——

function FactionBarChart({ stats }: { stats: BalanceStats }) {
  const rows = useMemo(
    () => [...stats.factions].sort((a, b) => b.winRate - a.winRate || a.faction.localeCompare(b.faction)),
    [stats],
  )
  return (
    <section className="sc-stats-panel">
      <h2 className="sc-stats-panel-title">派系胜率（预组自对弈）</h2>
      <ul className="sc-stats-bars" aria-label="派系胜率条形图">
        {rows.map((row) => (
          <li key={row.deckId} className="sc-stats-bar-row" data-faction={row.faction}>
            <span className="sc-stats-bar-name">{factionLabel(row.faction)}</span>
            <span className="sc-stats-bar-track">
              <span
                className="sc-stats-bar-fill"
                style={{ width: `${Math.min(100, Math.max(0, row.winRate * 100)).toFixed(2)}%` }}
              />
              <span className="sc-stats-bar-baseline" aria-hidden="true" />
            </span>
            <span className="sc-stats-bar-value">
              <Tip tip={TIP_FACTION_WIN}>{percentLabel(row.winRate)}</Tip>
              <span className="sc-stats-bar-games">
                <Tip tip={TIP_GAMES_TOTAL}>{row.games.toLocaleString('zh-Hans-CN')} 局</Tip>
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="sc-stats-annotation">
        <Tip tip={TIP_GAMES_TOTAL}>共 {stats.gamesTotal.toLocaleString('zh-Hans-CN')} 局模拟</Tip>
        <span aria-hidden="true"> · </span>
        数据生成于 {new Date(stats.generatedAt).toLocaleString('zh-Hans-CN')}
        <span aria-hidden="true"> · </span>
        虚线为 50% 均衡基准
      </p>
    </section>
  )
}

const CARD_COLUMNS: { key: CardSortKey; label: string; tip: string }[] = [
  { key: 'name', label: '卡牌', tip: '按卡名排序（中文拼音序）' },
  { key: 'played', label: '出场率', tip: TIP_CARD_PLAYED },
  { key: 'playedWinRate', label: '打出胜率', tip: TIP_CARD_WIN },
]

function CardTable({ stats }: { stats: BalanceStats }) {
  const [factionFilter, setFactionFilter] = useState<string>('')
  const [sortKey, setSortKey] = useState<CardSortKey>('played')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const rowsWithFaction = useMemo(() => withCardFaction(stats), [stats])
  const factionsPresent = useMemo(() => {
    const seen = new Set<FactionId>()
    for (const row of rowsWithFaction) seen.add(row.faction)
    return [...seen]
  }, [rowsWithFaction])

  const shown = useMemo(() => {
    const filtered =
      factionFilter === '' ? rowsWithFaction : rowsWithFaction.filter((row) => row.faction === factionFilter)
    return sortCardRows(filtered, sortKey, sortDir)
  }, [rowsWithFaction, factionFilter, sortKey, sortDir])

  function toggleSort(key: CardSortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  return (
    <section className="sc-stats-panel">
      <h2 className="sc-stats-panel-title">卡牌出场率与打出胜率</h2>
      <div className="sc-stats-toolbar">
        <label className="sc-stats-filter">
          按派系
          <select
            value={factionFilter}
            onChange={(event) => setFactionFilter(event.target.value)}
            aria-label="按派系筛选卡牌表"
          >
            <option value="">全部（{shown.length} 张有出场数据）</option>
            {factionsPresent.map((faction) => (
              <option key={faction} value={faction}>
                {factionLabel(faction)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="sc-stats-table-wrap">
        <table className="sc-stats-table">
          <thead>
            <tr>
              {CARD_COLUMNS.map((column) => (
                <th key={column.key} scope="col">
                  <button
                    type="button"
                    className={`sc-stats-sort${sortKey === column.key ? ' is-active' : ''}`}
                    onClick={() => toggleSort(column.key)}
                    title={column.tip}
                  >
                    {column.label}
                    <span className="sc-stats-sort-arrow" aria-hidden="true">
                      {sortKey === column.key ? (sortDir === 'desc' ? '▼' : '▲') : '◇'}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.cardId} data-faction={row.faction}>
                <td>
                  <span className="sc-stats-card-name">{row.name}</span>
                  <span className="sc-stats-card-faction">{factionLabel(row.faction)}</span>
                </td>
                <td>
                  <Tip tip={TIP_CARD_PLAYED}>{percentLabel(row.played)}</Tip>
                </td>
                <td>
                  <Tip tip={TIP_CARD_WIN}>{percentLabel(row.playedWinRate)}</Tip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sc-stats-annotation">卡牌归属派系按卡牌 ID 前缀归类（前缀未命中归入中立硬件）。</p>
    </section>
  )
}

// —— 个人历史层 ——

function SummaryCards({ summary }: { summary: HistorySummary }) {
  return (
    <div className="sc-stats-summary">
      <div className="sc-stats-summary-card">
        <span className="sc-stats-summary-num">
          <Tip tip={TIP_LOCAL_TOTAL}>{summary.total}</Tip>
        </span>
        <span className="sc-stats-summary-label">总场次</span>
      </div>
      <div className="sc-stats-summary-card is-win">
        <span className="sc-stats-summary-num">{summary.wins}</span>
        <span className="sc-stats-summary-label">胜</span>
      </div>
      <div className="sc-stats-summary-card is-loss">
        <span className="sc-stats-summary-num">{summary.losses}</span>
        <span className="sc-stats-summary-label">负</span>
      </div>
      <div className="sc-stats-summary-card">
        <span className="sc-stats-summary-num">
          <Tip tip={TIP_LOCAL_WINRATE}>{percentLabel(summary.winRate)}</Tip>
        </span>
        <span className="sc-stats-summary-label">胜率</span>
      </div>
    </div>
  )
}

function FactionUsageChart({ usage }: { usage: FactionUsageRow[] }) {
  if (usage.length === 0) return null
  const maxGames = Math.max(...usage.map((row) => row.games), 1)
  return (
    <section className="sc-stats-panel">
      <h2 className="sc-stats-panel-title">常用派系</h2>
      <ul className="sc-stats-bars sc-stats-bars--usage">
        {usage.map((row) => (
          <li key={row.faction} className="sc-stats-bar-row" data-faction={row.faction}>
            <span className="sc-stats-bar-name">{factionDisplayName(row.faction)}</span>
            <span className="sc-stats-bar-track">
              <span
                className="sc-stats-bar-fill"
                style={{ width: `${Math.max(4, (row.games / maxGames) * 100).toFixed(1)}%` }}
              />
            </span>
            <span className="sc-stats-bar-value">
              <Tip tip={TIP_LOCAL_FACTION}>{row.games} 局</Tip>
              <span className="sc-stats-bar-games">胜率 {percentLabel(row.winRate)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RecentGamesList({
  entries,
  openReplay,
}: {
  entries: ReplayMeta[]
  openReplay?: (id: string) => void
}) {
  return (
    <section className="sc-stats-panel">
      <h2 className="sc-stats-panel-title">最近 10 局</h2>
      <ul className="sc-stats-recent">
        {entries.map((meta) => (
          <li key={meta.id} className="sc-stats-recent-row">
            <span className="sc-stats-recent-when">
              {replayDateLabel(meta.savedAt)} {replayTimeLabel(meta.savedAt)}
            </span>
            <span className="sc-stats-recent-versus">
              {factionDisplayName(meta.factions[0])} <em>vs</em> {factionDisplayName(meta.factions[1])}
            </span>
            <span className={`sc-stats-outcome is-${meta.outcome}`}>
              {meta.outcome === 'win' ? '胜' : meta.outcome === 'loss' ? '负' : '平'}
            </span>
            <span className="sc-stats-recent-detail">{meta.turns} 回合</span>
            {openReplay ? (
              <button type="button" className="sc-btn sc-btn--small" onClick={() => openReplay(meta.id)}>
                回放
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="sc-stats-annotation">
        <Tip tip={TIP_LOCAL_TOTAL}>胜负按回放库录制视角统计</Tip>；列表最多展示最近 10 局（本机上限 50 局）。
      </p>
    </section>
  )
}

function LocalHistoryView({ openReplay }: { openReplay?: (id: string) => void }) {
  const [history, setHistory] = useState<LocalHistory>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    void loadLocalHistory().then((result) => {
      if (!cancelled) setHistory(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (history.kind === 'loading') {
    return (
      <p className="sc-stats-empty" role="status">
        回放库读取中…
      </p>
    )
  }
  if (history.kind === 'error') {
    return (
      <p className="sc-stats-empty" role="alert">
        回放库读取失败：{history.message}（本地存储不可用不影响打牌，只是没有个人历史）
      </p>
    )
  }

  const summary = summarizeHistory(history.entries)
  if (summary.total === 0) {
    return (
      <p className="sc-stats-empty">
        回放库还空着——打完一局（或从对局回放库导入 JSON 存档）后，这里会出现你的胜负走势与常用派系。
      </p>
    )
  }

  return (
    <>
      <SummaryCards summary={summary} />
      <FactionUsageChart usage={factionUsage(history.entries)} />
      <RecentGamesList entries={recentMetas(history.entries, 10)} openReplay={openReplay} />
    </>
  )
}

// —— 屏壳：两层切换 + 全局数据装载/重试 ——

export function StatsScreen({
  onClose,
  onOpenReplay,
}: {
  onClose: () => void
  /** 最近 10 局的回放跳转回调（挂载约定见文件头注释）；未传则不渲染回放按钮 */
  onOpenReplay?: (id: string) => void
}) {
  const [layer, setLayer] = useState<StatsLayer>('global')
  const [stats, setStats] = useState<BalanceStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetchBalanceStats()
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  return (
    <div className="sc-stats">
      <header className="sc-stats-header">
        <h1 className="sc-screen-title">数值面板</h1>
        <div className="sc-stats-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={layer === 'global'}
            className={`sc-stats-tab${layer === 'global' ? ' is-active' : ''}`}
            onClick={() => setLayer('global')}
          >
            全局模拟
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={layer === 'local'}
            className={`sc-stats-tab${layer === 'local' ? ' is-active' : ''}`}
            onClick={() => setLayer('local')}
          >
            个人历史
          </button>
        </div>
      </header>

      {layer === 'global' ? (
        error ? (
          <div className="sc-stats-error" role="alert">
            <p>⚠ 全局数值数据加载失败：{error}</p>
            <button type="button" className="sc-btn sc-btn--primary" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </button>
          </div>
        ) : stats ? (
          <>
            <FactionBarChart stats={stats} />
            <CardTable stats={stats} />
          </>
        ) : (
          <p className="sc-stats-empty" role="status">
            数值数据加载中…
          </p>
        )
      ) : (
        <LocalHistoryView openReplay={onOpenReplay} />
      )}

      <footer className="sc-stats-footer">
        <span className="sc-stats-annotation">
          {layer === 'global'
            ? '全局数据为离线模拟（bench 管线一键再生成），与 docs/balance 报告同口径。'
            : '个人数据仅存本机（IndexedDB），清空回放库即归零，不上传任何服务器。'}
        </span>
        <button type="button" className="sc-btn" onClick={onClose}>
          返回主菜单
        </button>
      </footer>
    </div>
  )
}
