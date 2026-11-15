/**
 * ReviewPanel —— AI 复盘报告卡（P2-QA1）。
 *
 * 职责边界（架构铁律 3 / 任务书交付 2）：
 * - 评分事实全部来自 runMatchReview（@siliconcard/ai 公开导出，Hard 基准逐步评分），
 *   本组件只做投影，不自维护任何对局/评分事实；
 * - 录制体取 replayStore.player.body（core ReplayRecording 原件 plain 对象），
 *   复盘视角取 meta.viewer——评分数据即用即弃（组件本地 state，不落库不进 store）；
 * - 事件索引对齐（时间轴同款坐标系）：复盘步 actionIndex k 的结算批次是回放
 *   时间轴的 stateIndex k+1（states[0] = 开局初始态），取该批次最后一个事件 + 1
 *   作为 seek 目标——跳转后展示「这一步打完之后」的局面；复用
 *   playerStore.seekToCursor 既有 seek 机制，不开第二套跳转逻辑；
 * - 可取消（UI 层职责）：runMatchReview 是引擎侧同步纯函数、无可中断点，取消
 *   语义 = 关闭面板即丢弃结果（setTimeout 异步包裹让「复盘计算中」先上屏，
 *   unmount 置 cancelled 丢弃产出——取舍已在任务汇报说明）。
 */

import { useEffect, useMemo, useState } from 'react'
import { runMatchReview, type MatchReview, type ReviewGrade } from '@siliconcard/ai'
import { useReplayPlayerStore } from './playerStore'
import type { ReplayTimeline } from './replayDriver'
import { useReplayStore } from './replayStore'

type ReviewStatus =
  | { kind: 'computing' }
  | { kind: 'ready'; review: MatchReview }
  | { kind: 'error'; message: string }

const GRADE_ORDER: readonly ReviewGrade[] = ['S', 'A', 'B', 'C']

const GRADE_LABEL: Record<ReviewGrade, string> = {
  S: '跟 AI 一致',
  A: '几乎无损',
  B: '小亏',
  C: '明显亏模',
}

/** 总评配色带：≥85 好 / ≥65 中 / 其余差（纯展示阈值） */
function overallTone(overall: number): string {
  if (overall >= 85) return 'is-good'
  if (overall >= 65) return 'is-mid'
  return 'is-rough'
}

/** actionIndex → 结算批次最后一个事件下标（stateIndex k+1，后写覆盖取批尾）；
 *  卡池漂移截断的批次无事件 → undefined（调用方回退到时间轴末尾）。 */
function lastEventIndexByAction(timeline: ReplayTimeline): Map<number, number> {
  const map = new Map<number, number>()
  timeline.stateIndexOfEvent.forEach((stateIndex, eventIndex) => {
    if (stateIndex > 0) map.set(stateIndex, eventIndex)
  })
  return map
}

export function ReviewPanel({ onClose }: { onClose: () => void }) {
  const body = useReplayStore((s) => s.player?.body ?? null)
  const viewer = useReplayStore((s) => s.player?.meta.viewer ?? null)
  const timeline = useReplayPlayerStore((s) => s.timeline)
  const seekToCursor = useReplayPlayerStore((s) => s.seekToCursor)
  const [status, setStatus] = useState<ReviewStatus>({ kind: 'computing' })

  // 异步计算包裹（可取消 = 关闭即丢弃）
  useEffect(() => {
    if (!body || !viewer) {
      setStatus({ kind: 'error', message: '回放未装载，无法复盘' })
      return
    }
    let cancelled = false
    setStatus({ kind: 'computing' })
    const handle = window.setTimeout(() => {
      if (cancelled) return
      try {
        setStatus({ kind: 'ready', review: runMatchReview(body, viewer) })
      } catch (error) {
        setStatus({ kind: 'error', message: `复盘计算失败：${error instanceof Error ? error.message : String(error)}` })
      }
    }, 30)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [body, viewer])

  const eventIndexByAction = useMemo(
    () => (timeline ? lastEventIndexByAction(timeline) : null),
    [timeline],
  )

  /** 跳到某决策步的结算后局面（复用既有 seek：cursor = 批尾事件数） */
  const seekToStep = (actionIndex: number): void => {
    if (!timeline) return
    const eventIndex = eventIndexByAction?.get(actionIndex + 1)
    seekToCursor(eventIndex !== undefined ? eventIndex + 1 : timeline.events.length)
  }

  return (
    <section className="sc-rplayer-review" aria-label="AI 复盘报告">
      <header className="sc-rplayer-review-head">
        <h2 className="sc-rplayer-review-title">AI 复盘 · 视角 {viewer ?? '—'}</h2>
        <button type="button" className="sc-rplayer-review-close" aria-label="关闭复盘报告" onClick={onClose}>
          ✕
        </button>
      </header>

      {status.kind === 'computing' ? (
        <p className="sc-rplayer-review-hint" role="status">
          复盘计算中…（Hard AI 重放你的每个决策点）
        </p>
      ) : null}

      {status.kind === 'error' ? <p className="sc-rplayer-review-empty">{status.message}</p> : null}

      {status.kind === 'ready' ? <ReviewReport review={status.review} eventIndexByAction={eventIndexByAction} onSeek={seekToStep} /> : null}
    </section>
  )
}

function ReviewReport({
  review,
  eventIndexByAction,
  onSeek,
}: {
  review: MatchReview
  eventIndexByAction: Map<number, number> | null
  onSeek: (actionIndex: number) => void
}) {
  const totalEvents = useReplayPlayerStore((s) => s.timeline?.events.length ?? 0)

  // 曲线点坐标：与时间轴标记同一坐标系（eventIndex / totalEvents），
  // 位置取该步结算批次的最后一个事件（跳转语义与曲线点一致）
  const positions = review.steps.map((step) => {
    const eventIndex = eventIndexByAction?.get(step.actionIndex + 1) ?? totalEvents
    return {
      step,
      percent: totalEvents > 0 ? Math.min(100, (eventIndex / totalEvents) * 100) : 0,
    }
  })

  return (
    <>
      <div className={`sc-rplayer-review-score ${overallTone(review.overall)}`}>
        <strong>{review.overall}</strong>
        <span>/100</span>
      </div>

      {review.notice ? (
        <p className="sc-rplayer-review-banner" role="note">
          ⚠ {review.notice}
        </p>
      ) : null}

      {review.lethalMissedSteps.length > 0 ? (
        <div className="sc-rplayer-review-banner is-lethal" role="alert">
          <span>漏斩 ×{review.lethalMissedSteps.length}：存在一击致胜线路未执行</span>
          <div className="sc-rplayer-review-banner-actions">
            {review.lethalMissedSteps.map((actionIndex) => (
              <button
                key={actionIndex}
                type="button"
                className="sc-rplayer-review-miss is-lethal"
                onClick={() => onSeek(actionIndex)}
              >
                第 {actionIndex + 1} 步
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {review.steps.length === 0 ? (
        <p className="sc-rplayer-review-empty">这条回放里没有该视角的决策点（还没轮到它行动就结束了）</p>
      ) : (
        <>
          {/* S/A/B/C 分布条 */}
          <div className="sc-rplayer-review-dist" role="img" aria-label="评分分布">
            {GRADE_ORDER.map((grade) => {
              const count = review.scores[grade]
              if (count === 0) return null
              return (
                <span
                  key={grade}
                  className={`sc-rplayer-review-dist-seg is-${grade.toLowerCase()}`}
                  style={{ width: `${(count / review.steps.length) * 100}%` }}
                  title={`${GRADE_LABEL[grade]}（${grade}）× ${count}`}
                />
              )
            })}
          </div>
          <div className="sc-rplayer-review-legend">
            {GRADE_ORDER.map((grade) => (
              <span key={grade} className={`sc-rplayer-review-legend-item is-${grade.toLowerCase()}`}>
                {grade}·{GRADE_LABEL[grade]} ×{review.scores[grade]}
              </span>
            ))}
          </div>

          {/* 逐步评分曲线（点 = 决策步，位置与时间轴事件索引对齐，可跳转） */}
          <p className="sc-rplayer-review-section-title">逐步评分曲线（点跳转）</p>
          <div className="sc-rplayer-review-curve">
            {positions.map(({ step, percent }) => (
              <button
                key={step.actionIndex}
                type="button"
                className={`sc-rplayer-review-dot is-${step.score.toLowerCase()}`}
                style={{ left: `${percent}%` }}
                title={`第 ${step.actionIndex + 1} 步 · ${step.score} · 分差 ${
                  step.evalDelta >= 0 ? '+' : ''
                }${step.evalDelta.toFixed(2)}`}
                onClick={() => onSeek(step.actionIndex)}
              />
            ))}
          </div>

          {/* Top 失误（≤3，点击跳转） */}
          {review.topMisses.length > 0 ? (
            <>
              <p className="sc-rplayer-review-section-title">Top 失误</p>
              <ul className="sc-rplayer-review-misses">
                {review.topMisses.map((miss) => (
                  <li key={miss.actionIndex}>
                    <button type="button" className="sc-rplayer-review-miss" onClick={() => onSeek(miss.actionIndex)}>
                      <span className="sc-rplayer-review-miss-index">第 {miss.actionIndex + 1} 步</span>
                      <span>{miss.reason}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="sc-rplayer-review-hint">全程跟 AI 同档，没有值得复盘的失误</p>
          )}
        </>
      )}
      <p className="sc-rplayer-review-hint">评分仅本地计算（Hard 基准），即用即弃不落库</p>
    </>
  )
}
