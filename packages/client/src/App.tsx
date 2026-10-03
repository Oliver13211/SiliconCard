/**
 * 集成接线（M1 四线整合）：App.tsx 只做一件事 —— 渲染界面线的 SiliconCardApp。
 *
 * - HUD / 菜单闭环：packages/client/src/ui（M1-UI1..3 交付物）；
 * - 3D 牌桌：不在这里挂 —— BattleScreen 内的 Table3DMount（#sc-table3d-mount）
 *   经 useEffect 命令式创建渲染线 TableRenderer（Three 场景不进 React 树，WF-VISUAL 红线），
 *   引擎 GameEvent 流经 store 的 onBattleEvents 事件口同时喂给 3D 动画映射与 UI；
 * - 内容注册：main.tsx 启动时把 content 卡池 registerCardDefinitions（deckLoader.ensureContentRegistered）。
 */

import { SiliconCardApp } from './ui'

export default function App() {
  return <SiliconCardApp />
}
