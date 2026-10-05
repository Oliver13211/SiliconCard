/**
 * SiliconCardApp —— 界面线唯一挂载组件（M1-UI1..3 交付物入口）。
 *
 * 集成检查员只需在 App.tsx 中渲染 <SiliconCardApp />（App.tsx / main.tsx 本任务不改）。
 * 屏级路由是页面级状态（zustand），不引入路由依赖。
 */

import './styles/hud.css'
import { useGameStore } from './store/gameStore'
import { MainMenu } from './screens/MainMenu'
import { SetupScreen } from './screens/SetupScreen'
import { BattleScreen } from './screens/BattleScreen'
import { ResultScreen } from './screens/ResultScreen'
import { RulesScreen } from './screens/RulesScreen'
import { LanScreen } from './screens/LanScreen'

export function SiliconCardApp() {
  const screen = useGameStore((s) => s.screen)
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
