/**
 * ReplayTable3D —— 回放播放器的 3D 牌桌挂载点（P2-UI3）。
 *
 * 与对局 Table3DMount 同构（three 渲染线不进 React 树，WF-VISUAL 红线）：
 * - 命令式创建 canvas + createTableRenderer（视角固定 P1——回放是复盘视角）；
 * - 事件流改走 onReplayFrames 帧通道（playerStore 的光标推进/seek 产出），
 *   契约不变：每帧先 syncView 对账再 enqueueEvents 播放；
 * - 音效同源：批次帧直接喂 getAudioDirector().playEvents（AppRoot 已 initAudio，
 *   全局音频线仍在，只是回放期间 gameStore 无事件、不冲突）；BGM 随播放器挂载起停；
 * - 只读：不挂拾取回调（回放无操作）。
 */

import { useEffect, useRef } from 'react'
import { getCardDefinition } from '@siliconcard/core'
import { createTableRenderer, getAudioDirector, type TableRendererHandle } from '../../three'
import { onReplayFrames, useReplayPlayerStore } from './playerStore'

export function ReplayTable3D() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const canvas = document.createElement('canvas')
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    container.appendChild(canvas)

    const handle: TableRendererHandle = createTableRenderer(canvas, {
      viewer: 'P1',
      getCardDef: (cardId) => getCardDefinition(cardId),
    })

    // BGM 生命周期随播放器挂载（与对局屏同语义）
    getAudioDirector()?.setBattleActive(true)

    // 加载即有初始切片：先对账摆开局（load 在屏幕 effect 中先于本 effect 完成）
    const initial = useReplayPlayerStore.getState().viewP1
    if (initial) handle.syncView(initial)

    // 光标帧 → 3D：对账帧只 syncView；批次帧 syncView + enqueueEvents + 音效
    const unsubscribe = onReplayFrames((frame) => {
      handle.syncView(frame.view)
      if (frame.events && frame.events.length > 0) {
        handle.enqueueEvents(frame.events)
        getAudioDirector()?.playEvents(frame.events, 'P1')
      }
    })

    return () => {
      unsubscribe()
      getAudioDirector()?.setBattleActive(false)
      handle.dispose() // 卸载必调（渲染线验收项：资源全释放）
      canvas.remove()
    }
  }, [])

  return <div ref={containerRef} className="sc-rplayer-stage3d" aria-label="回放 3D 牌桌（只读演出）" />
}
