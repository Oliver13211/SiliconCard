/**
 * 3D 牌桌挂载点（M1-UI1..3 占位 + 集成检查员完成 3D 接线）：
 * - React 侧只渲染占位容器 `#sc-table3d-mount`（TABLE3D_MOUNT_ID）；
 * - useEffect 命令式创建 canvas 并挂入渲染线 TableRenderer（Three 场景不进
 *   React 渲染树，WF-VISUAL 红线；React 只持有容器 div，场景生命周期随容器挂载/卸载）；
 * - GameEvent 流：订阅 store 的 onBattleEvents 事件口 —— 每批事件先 syncView 对账
 *   再 enqueueEvents 播放（TableRenderer.ts 头注释的调用契约，幽灵体/旧实体快照演出依赖此顺序）；
 * - 3D 拾取 → 动作入口（与 HUD 按钮 / uiBridge 同语义：targeting 决策内聚在 store，
 *   此处直接调 useGameStore.getState() 的动作函数，避免 ui 组件反向 import ui/index 形成环）。
 */

import { useEffect, useRef } from 'react'
import {
  getCardDefinition,
  type GameEvent,
  type PlayerId,
  type PlayerView,
  type TargetRef,
} from '@siliconcard/core'
import { createTableRenderer, type TableRendererHandle } from '../../three'
import { onBattleEvents, useGameStore } from '../store/gameStore'

export const TABLE3D_MOUNT_ID = 'sc-table3d-mount'

/** 按初始视图合成开局演出事件（与 BattleDriver.start 的 openingEvents 同构，rules.md §2.1/§6） */
function synthesizeOpeningEvents(view: PlayerView, seed: number): readonly GameEvent[] {
  if (view.turn !== 1 || view.phase !== 'main') return []
  const activeMana = view.activePlayer === view.viewer ? view.you.maxMana : view.opponent.maxMana
  return [
    { type: 'GAME_START', seed, firstPlayer: view.activePlayer },
    {
      type: 'TURN_START',
      turn: view.turn,
      playerId: view.activePlayer,
      maxMana: activeMana,
      drawCount: 0,
    },
  ]
}

export function Table3DMount() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // —— Three 侧：命令式 canvas + 渲染线 handle ——
    const canvas = document.createElement('canvas')
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    container.appendChild(canvas)

    const handle: TableRendererHandle = createTableRenderer(canvas, {
      viewer: 'P1', // 界面线 BattleDriver 固定 P1 视角（gameStore.ts）
      getCardDef: (cardId) => getCardDefinition(cardId),
    })

    // —— 开局：BattleScreen 挂载时对局已 start（startBattle 先于本 effect），
    //    开局事件已错过事件口，这里按初始视图对账 + 重放同构的开局演出 ——
    const initial = useGameStore.getState()
    if (initial.view) {
      handle.syncView(initial.view)
      handle.enqueueEvents(synthesizeOpeningEvents(initial.view, initial.config?.seed ?? 0))
    }

    // —— 引擎事件流 → 3D：每批先对账后播放（先 syncView 后 enqueueEvents 契约） ——
    const unsubscribeEvents = onBattleEvents((events) => {
      if (events.length === 0) return
      const view = useGameStore.getState().view
      if (!view) return
      handle.syncView(view)
      handle.enqueueEvents(events)
    })

    // —— 3D 拾取 → 动作入口（HUD 同语义） ——
    handle.setPickCallbacks({
      onHandCardClick: (uid) => useGameStore.getState().tryPlayCard(uid),
      onUnitClick: (instanceId) => {
        const state = useGameStore.getState()
        const targeting = state.targeting
        if (targeting) {
          const candidate = targeting.targets.find(
            (t: TargetRef) => t.kind === 'unit' && t.instanceId === instanceId,
          )
          if (candidate) state.confirmTarget(candidate)
          return
        }
        const unit = state.view?.board.find((u) => u.instanceId === instanceId)
        if (unit && state.view && unit.ownerId === state.view.viewer) state.tryAttack(instanceId)
      },
      onHeroClick: (playerId: PlayerId) => {
        const state = useGameStore.getState()
        const targeting = state.targeting
        if (!targeting) return
        const candidate = targeting.targets.find(
          (t: TargetRef) => t.kind === 'hero' && t.playerId === playerId,
        )
        if (candidate) state.confirmTarget(candidate)
      },
    })

    return () => {
      unsubscribeEvents()
      handle.dispose() // 卸载必调（渲染线验收项：资源全释放）
      canvas.remove()
    }
  }, [])

  return (
    <div
      id={TABLE3D_MOUNT_ID}
      ref={containerRef}
      className="sc-table3d"
      data-testid={TABLE3D_MOUNT_ID}
      aria-label="3D 牌桌（Three.js 渲染，拾取经事件口接入）"
    />
  )
}
