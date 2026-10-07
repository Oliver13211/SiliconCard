/**
 * SiliconCardApp —— 界面线唯一挂载组件（M1-UI1..3 交付物入口）。
 *
 * 集成检查员只需在 App.tsx 中渲染 <SiliconCardApp />（App.tsx / main.tsx 本任务不改）。
 * 屏级路由是页面级状态（zustand），不引入路由依赖。
 *
 * M4-SND1：应用挂载即初始化音频线（程序化音效 + BGM + UI 点击音）——
 * initAudio 经注入的 ui 钩子订阅同一条 GameEvent 流（与 3D 演出同源，音画同拍）；
 * 首次用户手势解锁 AudioContext（浏览器自动播放策略，首次交互前静音是预期行为）。
 *
 * UI 现代化：
 * - 屏幕切换过渡：进场 fade+上浮（motion.css 的 sc-screen-in 挂载即播）；
 *   退场保留上一屏 240ms 淡出（.sc-screen--leaving 包裹层，pointer-events 已隔离）——
 *   battle 屏退出时不保留（重挂 3D 渲染线只为淡出不划算，见 scScreenExitSkip）；
 * - 动效偏好：uiPrefsStore.motion 落到 .sc-app[data-motion]（auto/on/off 三档，
 *   motion.css 统一接管 prefers-reduced-motion 与强制开关）。
 */

import { useEffect, useRef, useState } from 'react'
import './styles/hud.css'
import { initAudio } from '../three/audio'
import { useGameStore, onBattleEvents, type Screen } from './store/gameStore'
import { useUiPrefs } from './store/uiPrefsStore'
import { MainMenu } from './screens/MainMenu'
import { SetupScreen } from './screens/SetupScreen'
import { BattleScreen } from './screens/BattleScreen'
import { ResultScreen } from './screens/ResultScreen'
import { RulesScreen } from './screens/RulesScreen'
import { LanScreen } from './screens/LanScreen'

/** 退场淡出时长（需 ≥ motion.css 的 sc-screen-out 0.22s） */
const SCREEN_EXIT_MS = 240

/** 按屏 id 渲染对应屏（保持结构稳定，方便进退场包裹层复用） */
function ScreenOutlet({ screen }: { screen: Screen }) {
  switch (screen) {
    case 'menu':
      return <MainMenu />
    case 'setup':
      return <SetupScreen />
    case 'lan':
      return <LanScreen />
    case 'battle':
      return <BattleScreen />
    case 'result':
      return <ResultScreen />
    case 'rules':
      return <RulesScreen />
  }
}

export function SiliconCardApp() {
  const screen = useGameStore((s) => s.screen)
  const motion = useUiPrefs((s) => s.motion)

  // 屏幕退场：记录上一屏，短保留渲染淡出层；timer 清理防快速连切残留
  const prevScreenRef = useRef<Screen>(screen)
  const [leaving, setLeaving] = useState<Screen | null>(null)
  useEffect(() => {
    if (prevScreenRef.current === screen) return
    const from = prevScreenRef.current
    prevScreenRef.current = screen
    setLeaving(from)
    const timer = setTimeout(() => setLeaving(null), SCREEN_EXIT_MS)
    return () => clearTimeout(timer)
  }, [screen])

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
    <div className="sc-app" data-motion={motion}>
      {leaving && leaving !== 'battle' ? (
        <div className="sc-screen--leaving" key={`leaving-${leaving}`} aria-hidden="true">
          <ScreenOutlet screen={leaving} />
        </div>
      ) : null}
      <ScreenOutlet screen={screen} />
    </div>
  )
}
