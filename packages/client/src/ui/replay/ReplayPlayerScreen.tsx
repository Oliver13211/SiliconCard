/**
 * ReplayPlayerScreen —— 回放播放器屏（P2-UI3）。
 *
 * 挂载约定（主控接线）：replayStore.player 非 null 时由 AppRoot 渲染本屏
 * （优先级高于回放库屏 ReplayScreen——player 由库屏行内「播放」进入）；
 * 退出 = replayPlayerStore.exit()（清场并 closePlayer 回库屏）。
 *
 * 结构（自上而下主区 + 右侧战报 + 底部控制条）：
 * - 上帝视角（任务书交付 3）：双方手牌全量可见——P1/P2 各一份官方 viewFor
 *   切片（replaySlicesOf），己方手牌取切片 you.hand，对面手牌取 P2 切片的
 *   you.hand 放在对面半区展示；全部只读（回放无操作，按钮禁用并解释）；
 * - 控制条（交付 2）：播放/暂停、变速 0.5×/1×/2×/4×、逐事件步进、时间轴
 *   拖动（seek = 引擎从头快放的预计算态，幂等）、关键事件着色标记可点跳转；
 * - 事件日志侧栏与时间轴双向联动（交付 4）：点日志条目跳转对应时刻，
 *   播放进度实时高亮当前条目；
 * - 快捷键（交付 5）：replay_play_pause / replay_step / replay_speed /
 *   fast_forward（跳到下一关键事件）+ global 的静音/键位表，scope='replay'。
 */

import { useEffect, useRef, useState } from 'react'
import type { HandCard } from '@siliconcard/core'
import { useReplayPlayerStore, REPLAY_SPEEDS, REPLAY_EVENT_INTERVAL_MS, replayPlayerTick } from './playerStore'
import { MARKER_LABEL, type ReplayMarkerKind } from './replayDriver'
import { useReplayStore } from './replayStore'
import { ReplayTable3D } from './ReplayTable3D'
import { PlayerPanel } from '../components/PlayerPanel'
import { HandCardView } from '../components/HandCardView'
import { UnitCardView } from '../components/UnitCardView'
import { useAudioStore } from '../store/audioStore'
import { useKeyCommands } from '../keybinds/useKeyCommands'
import { useKeybinds } from '../keybinds/keybindsStore'
import { KeyHintsOverlay } from '../keybinds/components/KeyHintsOverlay'
import '../styles/replay-player.css'

const READ_ONLY_STATUS = { available: false as const, reason: '回放只读（上帝视角仅供复盘）' }

function noop(): void {
  /* 回放只读：占位回调 */
}

/** 时间轴上方的关键事件标记行（着色点 + 图例共用配色） */
function markerDotClass(kind: ReplayMarkerKind): string {
  return `sc-rplayer-marker is-${kind}`
}

function GodHandRow({ cards, side }: { cards: readonly HandCard[]; side: 'self' | 'enemy' }) {
  return (
    <div className={`sc-rplayer-hand is-${side}`} aria-label={side === 'self' ? 'P1 手牌（上帝视角）' : 'P2 手牌（上帝视角）'}>
      {cards.length === 0 ? (
        <span className="sc-rplayer-hand-empty">手牌空</span>
      ) : (
        cards.map((card) => <HandCardView key={card.uid} card={card} status={READ_ONLY_STATUS} selected={false} onClick={noop} />)
      )}
    </div>
  )
}

function ControlBar() {
  const cursor = useReplayPlayerStore((s) => s.cursor)
  const playing = useReplayPlayerStore((s) => s.playing)
  const speed = useReplayPlayerStore((s) => s.speed)
  const timeline = useReplayPlayerStore((s) => s.timeline)
  const togglePlay = useReplayPlayerStore((s) => s.togglePlay)
  const stepForward = useReplayPlayerStore((s) => s.stepForward)
  const seekToCursor = useReplayPlayerStore((s) => s.seekToCursor)
  const setSpeed = useReplayPlayerStore((s) => s.setSpeed)
  const exit = useReplayPlayerStore((s) => s.exit)
  if (!timeline) return null

  const total = timeline.events.length
  const markers = timeline.markers

  function jumpToNextMarker(): void {
    const next = markers.find((marker) => marker.eventIndex >= cursor)
    seekToCursor(next ? next.eventIndex + 1 : total)
  }

  return (
    <footer className="sc-rplayer-controls">
      <div className="sc-rplayer-buttons">
        <button type="button" className="sc-btn" onClick={exit}>
          退出回放（回库）
        </button>
        <button type="button" className={`sc-btn sc-btn--primary${playing ? ' is-playing' : ''}`} onClick={togglePlay}>
          {playing ? '暂停' : '播放'}
        </button>
        <button type="button" className="sc-btn" onClick={stepForward} disabled={cursor >= total}>
          步进 +1 事件
        </button>
        <button type="button" className="sc-btn" onClick={jumpToNextMarker} disabled={cursor >= total}>
          下一关键事件
        </button>
        <div className="sc-rplayer-speeds" role="group" aria-label="回放速度">
          {REPLAY_SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              className={`sc-btn sc-btn--small${speed === option ? ' is-active' : ''}`}
              onClick={() => setSpeed(option)}
            >
              {option}×
            </button>
          ))}
        </div>
        <span className="sc-rplayer-progress">
          {cursor}/{total} 事件
        </span>
      </div>
      <div className="sc-rplayer-timeline">
        <div className="sc-rplayer-markers" aria-hidden="false">
          {markers.map((marker) => (
            <button
              key={`${marker.kind}-${marker.eventIndex}`}
              type="button"
              className={markerDotClass(marker.kind)}
              style={{ left: `${total > 0 ? (marker.eventIndex / total) * 100 : 0}%` }}
              title={`${MARKER_LABEL[marker.kind]} · 事件 ${marker.eventIndex + 1}`}
              onClick={() => seekToCursor(marker.eventIndex + 1)}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={cursor}
          aria-label="回放时间轴（按事件）"
          onChange={(event) => seekToCursor(Number(event.target.value))}
        />
        <div className="sc-rplayer-legend">
          {(Object.keys(MARKER_LABEL) as ReplayMarkerKind[]).map((kind) => (
            <span key={kind} className={`sc-rplayer-legend-item is-${kind}`}>
              {MARKER_LABEL[kind]}
            </span>
          ))}
        </div>
      </div>
    </footer>
  )
}

function EventLogSidebar() {
  const timeline = useReplayPlayerStore((s) => s.timeline)
  const cursor = useReplayPlayerStore((s) => s.cursor)
  const seekToCursor = useReplayPlayerStore((s) => s.seekToCursor)
  const listRef = useRef<HTMLOListElement>(null)

  // 双向联动（时间轴 → 日志）：当前条目滚动跟随
  useEffect(() => {
    listRef.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!timeline) return null
  return (
    <aside className="sc-rplayer-log">
      <h2 className="sc-rplayer-log-title">事件战报（点条目跳转）</h2>
      <ol className="sc-rplayer-log-list" ref={listRef}>
        {timeline.log.map((entry, index) =>
          entry ? (
            <li
              key={index}
              className={[
                'sc-rplayer-log-item',
                `is-${entry.tone}`,
                index < cursor ? 'is-played' : '',
                index === cursor - 1 ? 'is-current' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => seekToCursor(index + 1)}
            >
              <span className="sc-rplayer-log-index">{index + 1}</span>
              <span>{entry.text}</span>
            </li>
          ) : null,
        )}
        {timeline.log.every((entry) => entry === null) ? <li className="sc-rplayer-log-item is-info">这局没有可播报的事件</li> : null}
      </ol>
    </aside>
  )
}

export function ReplayPlayerScreen() {
  const status = useReplayPlayerStore((s) => s.status)
  const meta = useReplayPlayerStore((s) => s.meta)
  const timeline = useReplayPlayerStore((s) => s.timeline)
  const versionNotice = useReplayPlayerStore((s) => s.versionNotice)
  const viewP1 = useReplayPlayerStore((s) => s.viewP1)
  const viewP2 = useReplayPlayerStore((s) => s.viewP2)
  const playing = useReplayPlayerStore((s) => s.playing)
  const speed = useReplayPlayerStore((s) => s.speed)
  const load = useReplayPlayerStore((s) => s.load)
  const [showHelp, setShowHelp] = useState(false)

  // 挂载即装载：录制体来自 replayStore.player（库屏「播放」写入的挂载约定）
  useEffect(() => {
    const player = useReplayStore.getState().player
    if (player) load(player.meta, player.body)
  }, [load])

  // 播放节拍：每事件一个 tick（1× 基准间隔 / 倍速）
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => replayPlayerTick(), REPLAY_EVENT_INTERVAL_MS / speed)
    return () => window.clearInterval(id)
  }, [playing, speed])

  // 快捷键（P2-UI5 键位体系，scope='replay'）：播放/步进/变速 + 跳下一关键事件 + global
  const toggleHints = useKeybinds((s) => s.toggleHints)
  useKeyCommands(
    {
      replay_play_pause: () => useReplayPlayerStore.getState().togglePlay(),
      replay_step: () => useReplayPlayerStore.getState().stepForward(),
      replay_speed: () => useReplayPlayerStore.getState().cycleSpeed(),
      fast_forward: () => {
        const { timeline: tl, cursor, seekToCursor: seek } = useReplayPlayerStore.getState()
        if (!tl) return
        const next = tl.markers.find((marker) => marker.eventIndex >= cursor)
        seek(next ? next.eventIndex + 1 : tl.events.length)
      },
      mute: () => useAudioStore.getState().toggleMuted(),
      toggle_key_hints: () => toggleHints(),
      help: () => setShowHelp((value) => !value),
    },
    'replay',
  )

  if (status !== 'ready' || !timeline || !meta) {
    return (
      <div className="sc-rplayer" role="status">
        <p className="sc-rplayer-loading">回放重驱中…（引擎从头快放录制体）</p>
      </div>
    )
  }

  const ownUnits = (viewP1?.board ?? []).filter((unit) => unit.ownerId === 'P1')
  const enemyUnits = (viewP1?.board ?? []).filter((unit) => unit.ownerId === 'P2')
  const phaseText =
    viewP1 === null
      ? ''
      : viewP1.phase === 'ended'
        ? '对局结束'
        : `${viewP1.activePlayer} 回合中`

  return (
    <div className="sc-rplayer">
      {versionNotice ? (
        <p className="sc-rplayer-banner" role="alert">
          ⚠ {versionNotice}
        </p>
      ) : null}

      <div className="sc-rplayer-body">
        <main className="sc-rplayer-main">
          <header className="sc-rplayer-zone is-opponent">
            <div className="sc-rplayer-hero">
              {viewP1 ? <PlayerPanel player={viewP1.opponent} side="opponent" /> : null}
            </div>
            <div className="sc-rplayer-turn">{phaseText} · 第 {viewP1?.turn ?? 0} 回合</div>
          </header>
          <GodHandRow cards={viewP2?.you.hand ?? []} side="enemy" />

          <section className="sc-rplayer-stage">
            <ReplayTable3D />
            <div className="sc-rplayer-board" aria-label="扩展槽棋盘（回放只读）">
              <div className="sc-rplayer-board-row is-enemy">
                {enemyUnits.length === 0 ? <span className="sc-rplayer-board-empty">对面扩展槽空着</span> : null}
                {enemyUnits.map((unit) => (
                  <UnitCardView key={unit.instanceId} unit={unit} targetable={false} selectable={false} onClick={noop} />
                ))}
              </div>
              <div className="sc-rplayer-board-divider" />
              <div className="sc-rplayer-board-row is-own">
                {ownUnits.length === 0 ? <span className="sc-rplayer-board-empty">你的扩展槽空着</span> : null}
                {ownUnits.map((unit) => (
                  <UnitCardView key={unit.instanceId} unit={unit} targetable={false} selectable={false} onClick={noop} />
                ))}
              </div>
            </div>
          </section>

          <GodHandRow cards={viewP1?.you.hand ?? []} side="self" />
          <header className="sc-rplayer-zone is-self">
            <div className="sc-rplayer-hero">{viewP1 ? <PlayerPanel player={viewP1.you} side="self" /> : null}</div>
            <p className="sc-rplayer-god-hint">上帝视角：双方手牌全开 · 种子 {meta.seed} · {meta.factions[0]} vs {meta.factions[1]}</p>
          </header>

          <ControlBar />
        </main>
        <EventLogSidebar />
      </div>

      {showHelp ? <KeyHintsOverlay scope="replay" onClose={() => setShowHelp(false)} /> : null}
    </div>
  )
}
