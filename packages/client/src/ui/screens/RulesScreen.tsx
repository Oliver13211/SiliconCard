/**
 * 规则页（M1-UI3）：5 分钟上手摘要。完整契约以 docs/rules.md 为准（v1.0.1），
 * 本页只做玩家侧速览；关键词显示名与 core Keyword 枚举一一对应。
 */

import { useGameStore } from '../store/gameStore'
import { KEYWORD_LABELS } from '../game/fallbackContent'

const KEYWORD_HELP: Record<string, string> = {
  taunt: '敌方攻击必须先打它（公版涡轮的信仰灯）',
  divine_shield: '挡下第一次受到的伤害，然后消失（质保用掉了）',
  charge: '入场当回合就能攻击（一键冲 5.8GHz）',
  windfury: '每回合可以攻击两次（Titan Z 双芯）',
  deathrattle: '死亡时结算遗留效果（矿卡传家宝）',
  stealth: '攻击前不可被敌方指定（亮机卡的卑微）',
  overload: '打出后锁定下回合部分功耗（白牌电源跳闸）',
}

export function RulesScreen() {
  const closeRules = useGameStore((s) => s.closeRules)
  return (
    <div className="sc-rules">
      <h1 className="sc-screen-title">规则书 · 5 分钟上手</h1>
      <section className="sc-rules-section">
        <h2>基础盘</h2>
        <ul>
          <li>你扮演一颗 CPU，30 点体质；体质归零即「R.I.P 烧了」。</li>
          <li>功耗 = 法力：每个自己的回合 +100W，上限 1000W；卡牌功耗按真实 TDP 设计（5090 = 575W）。</li>
          <li>显卡（随从）站扩展槽，双方各最多 7 个；驱动（法术）出牌即结算；配件进场上常驻。</li>
          <li>手牌上限 10 张，回合结束超出即烧牌；牌库抽空再抽 → 疲劳递增伤害。</li>
        </ul>
      </section>
      <section className="sc-rules-section">
        <h2>回合流程</h2>
        <ul>
          <li>回合开始：供电 +100W → 结算跳闸 → 抽 1 张牌。</li>
          <li>你的回合内：任意次出牌 / 派系技能（200W，每回合一次）+ 显卡攻击。</li>
          <li>显卡入场当回合不能攻击（「超频」关键词例外）；攻击次数默认 1。</li>
          <li>结束回合：超出上限烧牌 → 轮到对面。</li>
        </ul>
      </section>
      <section className="sc-rules-section">
        <h2>七个关键词（梗化命名对照）</h2>
        <ul>
          {KEYWORD_LABELS.map((k) => (
            <li key={k.id}>
              <strong>{k.label}</strong>（{k.id}）：{KEYWORD_HELP[k.id] ?? ''}
            </li>
          ))}
        </ul>
      </section>
      <section className="sc-rules-section">
        <h2>胜负</h2>
        <ul>
          <li>对方 CPU 体质（+护甲）被打穿 → 你赢；双方同时归零 → 平局。</li>
          <li>认输随时可用（对局未结束时）；「对局结束」后一切操作失效。</li>
        </ul>
      </section>
      <p className="sc-rules-foot">精确规则见 docs/rules.md（v1.0.1）—— 本页若有出入，以规则书为准。</p>
      <div className="sc-setup-actions">
        <button type="button" className="sc-btn sc-btn--primary" onClick={() => closeRules()}>
          看完了，回去
        </button>
      </div>
    </div>
  )
}
