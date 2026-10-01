import type { CSSProperties } from 'react'

const FACTIONS = [
  { name: 'NVIDIA', skill: 'DLSS', color: '#76b900' },
  { name: 'AMD', skill: '开光追试试', color: '#ed1c24' },
  { name: 'Intel', skill: '驱动更新', color: '#0068b5' },
  { name: 'Apple Silicon', skill: '能效比', color: '#a2aaad' },
  { name: '高通 Adreno', skill: 'TOPS 营销', color: '#3253dc' },
  { name: 'ARM Mali', skill: '公版方案', color: '#ffb400' },
  { name: '中立硬件', skill: '清灰', color: '#8b949e' },
] as const

const MILESTONES = [
  { id: 'M0', title: '立项基建', detail: 'monorepo · 脚手架 · CI · 设计文档', status: 'in-progress', label: '进行中' },
  { id: 'M1', title: '可玩 MVP', detail: '全量规则 · 60 张卡 · 内置人机 · 3D 牌桌', status: 'pending', label: '待开始' },
  { id: 'M3', title: 'Agent 接口', detail: 'CLI JSON 行协议 · 规则速查 skill · 演示 agent', status: 'pending', label: '待开始' },
  { id: 'M2', title: '局域网对战', detail: 'ws 权威服务端 · 房间 · mDNS 发现', status: 'pending', label: '待开始' },
  { id: 'M4', title: '内容量与平衡', detail: '新派系卡池 · 自对弈平衡管线', status: 'pending', label: '待开始' },
] as const

export default function App() {
  return (
    <div className="app">
      <header className="hero">
        <p className="hero-eyebrow">SILICONCARD · 显卡与硬件梗主题 1V1 卡牌对战</p>
        <h1 className="hero-title">硅牌</h1>
        <p className="hero-sub">5090 烧接口 · A 卡光追 · 矿卡传家宝 —— 把装机圈的全部爱恨装进一副牌。</p>
        <div className="hero-status">🚧 M0 立项基建进行中 —— 牌桌正在焊线，敬请期待</div>
      </header>

      <section className="panel">
        <h2>派系（英雄技能 2W）</h2>
        <ul className="factions">
          {FACTIONS.map((f) => (
            <li key={f.name} className="faction" style={{ '--accent': f.color } as CSSProperties}>
              <span className="faction-name">{f.name}</span>
              <span className="faction-skill">{f.skill}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>里程碑</h2>
        <ol className="milestones">
          {MILESTONES.map((m) => (
            <li key={m.id} className={`milestone is-${m.status}`}>
              <span className="milestone-id">{m.id}</span>
              <span className="milestone-body">
                <strong>{m.title}</strong>
                <small>{m.detail}</small>
              </span>
              <span className="milestone-label">{m.label}</span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="footer">
        <span>MIT License</span>
        <a href="https://github.com/Oliver13211/SiliconCard" target="_blank" rel="noreferrer">
          github.com/Oliver13211/SiliconCard
        </a>
      </footer>
    </div>
  )
}
