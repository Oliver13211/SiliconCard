/**
 * ReplayScreen —— 回放库屏（P2-INF1）：列表 / 按日期筛选 / 看对阵胜负 / 删除 / 导出 / 导入 / 播放。
 *
 * 只从主菜单进入（openLibrary / closeLibrary，AppRoot 按 open 分流渲染），
 * 不占用 gameStore 的 screen 路由（避免与对局屏互相踩状态）。
 * 播放（P2-UI3）：行内「播放」→ openPlayer 写入 replayStore.player，
 * AppRoot 按 player 分流渲染 ReplayPlayerScreen（挂载约定见 replayStore）。
 *
 * 交互细节：
 * - 导入：文件选择 + 整屏拖拽 .json 双路径；校验失败不库存、原因直显（role=alert）；
 * - 删除：两段式确认（「删除」→「确认删除？」），防手滑也不弹原生对话框；
 * - 对阵：派系名 + 胜负徽标（录制视角 win/loss/draw；无终局信息的裸存档显示 —）。
 */

import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { factionDisplayName } from '../game/fallbackContent'
import { useReplayStore, availableDates, filteredEntries } from './replayStore'
import { formatDuration, hasEndInfo, replayDateLabel, replayTimeLabel, type ReplayMeta } from './types'

const OUTCOME_LABEL: Record<ReplayMeta['outcome'], string> = {
  win: '胜',
  loss: '负',
  draw: '平',
}

function StatusBanner() {
  const status = useReplayStore((s) => s.status)
  const clearStatus = useReplayStore((s) => s.clearStatus)
  if (status.kind === 'idle') return null
  if (status.kind === 'error') {
    return (
      <p className="sc-replay-banner is-error" role="alert">
        <span>⚠ {status.message}</span>
        <button type="button" className="sc-btn sc-btn--small" onClick={clearStatus}>
          知道了
        </button>
      </p>
    )
  }
  return (
    <p className={status.kind === 'busy' ? 'sc-replay-banner is-busy' : 'sc-replay-banner is-notice'} role="status">
      {status.message}
    </p>
  )
}

function ReplayRow({ meta }: { meta: ReplayMeta }) {
  const removeReplay = useReplayStore((s) => s.removeReplay)
  const exportReplay = useReplayStore((s) => s.exportReplay)
  const openPlayer = useReplayStore((s) => s.openPlayer)
  const status = useReplayStore((s) => s.status)
  const [confirming, setConfirming] = useState(false)
  const busy = status.kind === 'busy'

  useEffect(() => {
    if (busy) setConfirming(false)
  }, [busy])

  return (
    <li className="sc-replay-row">
      <div className="sc-replay-row-when">
        <span className="sc-replay-row-date">{replayDateLabel(meta.savedAt)}</span>
        <span className="sc-replay-row-time">{replayTimeLabel(meta.savedAt)}</span>
      </div>
      <div className="sc-replay-row-match">
        <span className="sc-replay-row-versus">
          {factionDisplayName(meta.factions[0])} <em>vs</em> {factionDisplayName(meta.factions[1])}
        </span>
        <span className="sc-replay-row-detail">
          {hasEndInfo(meta) ? <span className={`sc-replay-outcome is-${meta.outcome}`}>{OUTCOME_LABEL[meta.outcome]}</span> : <span className="sc-replay-outcome">—</span>}
          <span>{meta.turns} 回合</span>
          <span>{meta.actionCount} 动作</span>
          <span>{formatDuration(meta.durationMs)}</span>
          <span className="sc-replay-row-seed">种子 {meta.seed}</span>
        </span>
      </div>
      <div className="sc-replay-row-actions">
        <button
          type="button"
          className="sc-btn sc-btn--small sc-btn--primary"
          disabled={busy}
          onClick={() => void openPlayer(meta.id)}
        >
          播放
        </button>
        <button type="button" className="sc-btn sc-btn--small" disabled={busy} onClick={() => void exportReplay(meta.id)}>
          导出 JSON
        </button>
        {confirming ? (
          <>
            <button type="button" className="sc-btn sc-btn--small sc-btn--danger" disabled={busy} onClick={() => void removeReplay(meta.id)}>
              确认删除
            </button>
            <button type="button" className="sc-btn sc-btn--small" disabled={busy} onClick={() => setConfirming(false)}>
              手滑了
            </button>
          </>
        ) : (
          <button type="button" className="sc-btn sc-btn--small sc-btn--danger" disabled={busy} onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
    </li>
  )
}

export function ReplayScreen() {
  const entries = useReplayStore((s) => s.entries)
  const loaded = useReplayStore((s) => s.loaded)
  const dateFilter = useReplayStore((s) => s.dateFilter)
  const setDateFilter = useReplayStore((s) => s.setDateFilter)
  const importReplayFile = useReplayStore((s) => s.importReplayFile)
  const closeLibrary = useReplayStore((s) => s.closeLibrary)
  const refresh = useReplayStore((s) => s.refresh)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const shown = filteredEntries(entries, dateFilter)
  const dates = availableDates(entries)

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragOver(false)
    for (const file of Array.from(event.dataTransfer.files)) {
      if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
        void importReplayFile(file)
      }
    }
  }

  return (
    <div
      className={`sc-replay${dragOver ? ' is-dragover' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <h1 className="sc-screen-title">对局回放库</h1>
      <p className="sc-replay-sub">
        本地保留最近 50 局（旧的自动腾位置）——每局都是 seed + 动作序列的确定性录制，可导出 JSON 直接喂给外部 AI 复盘。
      </p>

      <StatusBanner />

      <div className="sc-replay-toolbar">
        <label className="sc-replay-filter">
          按日期
          <select
            value={dateFilter ?? ''}
            onChange={(event) => setDateFilter(event.target.value === '' ? null : event.target.value)}
            aria-label="按日期筛选回放"
          >
            <option value="">全部（{entries.length} 局）</option>
            {dates.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="sc-btn" onClick={() => fileInputRef.current?.click()}>
          导入回放（.json）
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="sc-replay-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importReplayFile(file)
            event.target.value = ''
          }}
        />
        <button type="button" className="sc-btn" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {dragOver ? <p className="sc-replay-drop-hint">松手即导入（校验通过的存档才会入库）</p> : null}

      {!loaded ? (
        <p className="sc-replay-empty" role="status">
          回放库读取中…
        </p>
      ) : shown.length === 0 ? (
        <p className="sc-replay-empty">{entries.length === 0 ? '回放库还空着——打完一局会自动入柜；也可以从上面把 JSON 存档拖进来。' : '这个日期没有对局，换个日期看看。'}</p>
      ) : (
        <ul className="sc-replay-list">
          {shown.map((meta) => (
            <ReplayRow key={meta.id} meta={meta} />
          ))}
        </ul>
      )}

      <div className="sc-replay-footer">
        <button type="button" className="sc-btn" onClick={closeLibrary}>
          返回主菜单
        </button>
      </div>
    </div>
  )
}
