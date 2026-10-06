/**
 * SiliconCardApp —— 界面线唯一挂载组件（M1-UI1..3 交付物入口）。
 *
 * 集成检查员只需在 App.tsx 中渲染 <SiliconCardApp />（App.tsx / main.tsx 本任务不改）。
 * 屏级路由是页面级状态（zustand），不引入路由依赖。
 *
 * M4-SND1：应用挂载即初始化音频线（程序化音效 + BGM + UI 点击音）——
 * initAudio 经注入的 ui 钩子订阅同一条 GameEvent 流（与 3D 演出同源，音画同拍）；
 * 首次用户手势解锁 AudioContext（浏览器自动播放策略，首次交互前静音是预期行为）。
 */

import { useEffect } from 'react'
import './styles/hud.css'
import { initAudio } from '../three/audio'
import { useGameStore, onBattleEvents } from './store/gameStore'
import { MainMenu } from './screens/MainMenu'
import { SetupScreen } from './screens/SetupScreen'
import { BattleScreen } from './screens/BattleScreen'
import { ResultScreen } from './screens/ResultScreen'
import { RulesScreen } from './screens/RulesScreen'
import { LanScreen } from './screens/LanScreen'

export function SiliconCardApp() {
  const screen = useGameStore((s) => s.screen)

  // 音频线全局生命周期（M4-SND1）：订阅引擎事件流 + 手势解锁 + 页面隐藏暂停
  useEffect(
    () =>
      initAudio({
        getViewer: () => useGameStore.getState().view?.viewer ?? 'P1',
        subscribeEvents: onBattleEvents,
      }),
    [],
  )

  return (
    <div className="sc-app">
      {screen === 'menu' ? <MainMenu /> : null}
      {screen === 'setup' ? <SetupScreen /> : null}
      {screen === 'lan' ? <LanScreen /> : null}
      {screen === 'battle' ? <BattleScreen /> : null}
      {screen === 'result' ? <ResultScreen /> : null}
      {screen === 'rules' ? <RulesScreen /> : null}
    </div>
  )
}
