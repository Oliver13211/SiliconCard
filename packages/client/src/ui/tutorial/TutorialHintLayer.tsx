/**
 * TutorialHintLayer（P2-EDU1 关5 配套，可选挂载件）—— 真实对局前 3 个己方回合的提示气泡。
 *
 * 与教程对局零耦合：只读 useGameStore 视图（turn / yourTurn），任何宿主
 * （AppRoot battle 分支）都可以挂，不挂也不影响任何功能——形态自定方案里
 * "Setup 时的说明"由教程关5简报页承载，本组件是"前 3 回合气泡"的可选实现。
 */

import { useGameStore } from '../store/gameStore'
import { heroPowerCost } from '../game/legal'

const HINTS: readonly string[] = [
  '第 1 回合供电 100W：先上低功耗小卡站场（显卡上场当回合不能攻击，超频卡除外）。',
  '供电每回合 +100W。卡牌功耗取材真实 TDP——5090 要 575W，攒够电再上大件。',
  '结束回合前看一眼技能按钮（白嫖收益别浪费）；攻击目标会被嘲讽（信仰充值）单位拦截。',
]

export function TutorialHintLayer() {
  const view = useGameStore((s) => s.view)
  if (!view || view.viewer !== 'P1' || view.phase === 'ended') return null
  if (view.activePlayer !== view.viewer) return null
  const ownTurn = Math.ceil(view.turn / 2)
  if (ownTurn < 1 || ownTurn > HINTS.length) return null
  const hint = HINTS[ownTurn - 1] as string
  const power = heroPowerCost(view.you.faction)
  return (
    <aside className="sc-tutorial-hint" role="status">
      <strong>上手提示 · 第 {ownTurn} 回合</strong>
      <p>{hint}</p>
      {ownTurn === 1 ? <p className="sc-tutorial-hint-foot">技能按钮要 {power}W，第 2 回合才点得动。</p> : null}
    </aside>
  )
}
