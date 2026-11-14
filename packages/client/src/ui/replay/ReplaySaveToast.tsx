/**
 * ReplaySaveToast —— 本局回放入柜的轻量反馈（P2-α 交付 2）。
 *
 * 挂载方式（主控接线）：AppRoot 在屏幕分流之外的「全局层」渲染
 * `<ReplaySaveToast />`（与 ErrorToast 同级，放 .sc-app 直下即可）；
 * 组件自身引入 styles/replay.css（toast 样式段），不依赖回放库屏是否挂载。
 *
 * 数据流：battleDriver sink → recordFinishedMatch 置位 replayStore.saveState
 * （saved 携带最近一条 meta / failed 携带原因）→ 本组件渲染 4s 自动消散
 * （clearSaveToast），期间新一局落库会覆盖旧状态（key=at 强制重挂重播动画）。
 *
 * 铁律：展示零阻塞——toast 不拦操作、不抢焦点，对局与结算对它零感知；
 * 进出场动画复用 motion.css 既有关键帧（.sc-toast 的 sc-toast-in/out，
 * 与 ErrorToast 同拍），本组件不发明新动画。
 */

import { useEffect } from 'react'
import { factionDisplayName } from '../game/fallbackContent'
import { useReplayStore } from './replayStore'
import { formatDuration } from './types'
import '../styles/replay.css'

/** 与 ErrorToast 的 4s 生命周期同拍（motion.css 的退场延迟 3.68s + 0.32s 淡出） */
const TOAST_LIFETIME_MS = 4000

export function ReplaySaveToast() {
  const saveState = useReplayStore((s) => s.saveState)
  const clearSaveToast = useReplayStore((s) => s.clearSaveToast)

  useEffect(() => {
    if (saveState.kind === 'idle') return
    const timer = setTimeout(() => clearSaveToast(), TOAST_LIFETIME_MS)
    return () => clearTimeout(timer)
  }, [saveState, clearSaveToast])

  if (saveState.kind === 'idle') return null

  // key=at：连续两局快速落库时重挂元素，进出场动画从头重播
  if (saveState.kind === 'saved') {
    const { meta } = saveState
    const versus = `${factionDisplayName(meta.factions[0])} vs ${factionDisplayName(meta.factions[1])}`
    return (
      <div className="sc-replay-toast-layer" aria-live="polite">
        <div key={saveState.at} className="sc-toast sc-replay-save-toast is-saved" role="status">
          ✓ 本局回放已入柜（{versus} · {meta.turns} 回合 · {formatDuration(meta.durationMs)}）
        </div>
      </div>
    )
  }
  return (
    <div className="sc-replay-toast-layer" aria-live="polite">
      <div key={saveState.at} className="sc-toast sc-replay-save-toast is-failed" role="status">
        回放入柜失败（{saveState.reason}）——本局照常结算，只是回放没存上
      </div>
    </div>
  )
}
