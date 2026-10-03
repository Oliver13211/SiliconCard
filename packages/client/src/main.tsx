import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { ensureContentRegistered } from './ui/game/deckLoader'

// —— 内容注册（集成接线，M1 内容四批次 nvidia/amd/intel/neutral 共 60 张）——
// 启动即把 packages/content/cards/** 的 JSON 经引擎注册表 registerCardDefinitions 注入，
// 保证 3D 卡面（getCardDefinition）与战报卡名在任意时刻可查。
// 幂等：startBattle 前会再次调用 ensureContentRegistered（同 id 后写覆盖）；
// 正式卡池缺失时自动降级注册 demo 占位池（deckLoader 内部处理，不在此抛错）。
try {
  const report = ensureContentRegistered()
  if (report.invalidCards.length > 0) {
    console.warn('[siliconcard] 以下卡牌定义未通过结构校验被跳过：', report.invalidCards)
  }
} catch (error) {
  // 注册失败不让页面白屏：startBattle 仍会重试，失败时以错误提示条呈现
  console.error('[siliconcard] 启动时内容注册失败：', error)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
