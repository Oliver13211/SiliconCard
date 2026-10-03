/**
 * @siliconcard/client 界面线（src/ui）对外出口 —— 供 App.tsx 接线与 3D 线接入。
 *
 * App.tsx 接线（集成检查员执行，本任务不改 App.tsx）：
 *   import { SiliconCardApp } from './ui'
 *   export default function App() { return <SiliconCardApp /> }
 *
 * 3D 线接入（client-3d）：
 *   - canvas 挂载点：document.getElementById(TABLE3D_MOUNT_ID)
 *   - 引擎事件订阅（动画驱动）：onBattleEvents(cb)
 *   - 拾取→动作：uiBridge.playCard / attack / heroPower / confirmTarget / cancelTargeting
 *   - 状态读取：useGameStore（view / interactivity / targeting）
 */

export { SiliconCardApp } from './AppRoot'
export { useGameStore, onBattleEvents } from './store/gameStore'
export { TABLE3D_MOUNT_ID } from './components/Table3DMount'
import { useGameStore } from './store/gameStore'
import type { TargetRef } from '@siliconcard/core'

/** 3D 拾取接入的动作入口（等价于 HUD 按钮语义，targeting 决策内聚在 store） */
export const uiBridge = {
  /** 打出手牌（uid 为手牌实例 id）；需要目标时自动进入目标选择态 */
  playCard: (uid: string): void => useGameStore.getState().tryPlayCard(uid),
  /** 宣告攻击（attackerId 为场上单位实例 id）；多候选时自动进入目标选择态 */
  attack: (attackerId: string): void => useGameStore.getState().tryAttack(attackerId),
  /** 派系技能；需要目标时自动进入目标选择态 */
  heroPower: (): void => useGameStore.getState().tryHeroPower(),
  /** 确认当前目标选择（3D 拾取到单位/CPU 后调用） */
  confirmTarget: (target: TargetRef): void => useGameStore.getState().confirmTarget(target),
  /** 取消目标选择 */
  cancelTargeting: (): void => useGameStore.getState().cancelTargeting(),
}
