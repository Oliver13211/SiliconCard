/**
 * 主菜单（M1-UI3 闭环起点）。
 */

import { useGameStore } from '../store/gameStore'

export function MainMenu() {
  const goto = useGameStore((s) => s.goto)
  const openRules = useGameStore((s) => s.openRules)
  return (
    <div className="sc-menu">
      <p className="sc-eyebrow">SILICONCARD · 显卡与硬件梗主题 1V1 卡牌对战</p>
      <h1 className="sc-menu-title">硅牌</h1>
      <p className="sc-menu-sub">5090 烧接口 · A 卡光追 · 矿卡传家宝 —— 把装机圈的全部爱恨装进一副牌。</p>
      <div className="sc-menu-actions">
        <button type="button" className="sc-btn sc-btn--primary" onClick={() => goto('setup')}>
          上电开打
        </button>
        <button type="button" className="sc-btn" onClick={() => openRules()}>
          规则书（5 分钟上手）
        </button>
      </div>
      <p className="sc-menu-foot">无头规则内核 · seed + 动作序列可复现整局 · 引擎是唯一事实源</p>
    </div>
  )
}
