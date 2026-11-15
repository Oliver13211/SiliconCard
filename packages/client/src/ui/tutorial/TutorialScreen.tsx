/**
 * 教程界面（P2-EDU1）—— 关卡选择 / 关卡简报 / 对战包装 + 教学覆盖层。
 *
 * 渲染复用约定（汇报要点，主控接线用）：
 * - 教程对战直接复用 screens/BattleScreen（只读 import）：对局事实来自
 *   gameStore（教程经 applyRemoteFrame 帧通道落地），HUD/3D/战报零重复实现；
 * - 教学层（气泡/目标条/过关结算）以覆盖层浮在本组件内，pointer-events
 *   只在自身控件上开启，不遮蔽对战 HUD；
 * - 本组件假设宿主在 open===true 时渲染（AppRoot 分支优先于 ScreenOutlet）。
 */

import { BattleScreen } from '../screens/BattleScreen'
import { RulesScreen } from '../screens/RulesScreen'
import { getFactionSkill } from '@siliconcard/core'
import { useGameStore } from '../store/gameStore'
import {
  closeTutorial,
  graduateToSetup,
  isLevel3Complete,
  retryTutorialMatch,
  startTutorialMatch,
  tutorialController,
} from './bridge'
import { TUTORIAL_LEVELS, tutorialLevelById } from './levels'
import { useTutorialStore } from './store'
import '../styles/tutorial.css'

const FACTION_CHOICES: readonly { id: string; name: string; blurb: string }[] = [
  { id: 'nvidia', name: 'NVIDIA', blurb: 'DLSS：给在场显卡白嫖 +1 攻' },
  { id: 'amd', name: 'AMD', blurb: '开光追试试：1 点直伤，30% 概率无事发生' },
  { id: 'intel', name: 'Intel', blurb: '驱动更新：抽一张牌，先重启试试' },
  { id: 'neutral', name: '中立硬件', blurb: '清灰：对任意角色 1 点直伤' },
  { id: 'apple', name: 'Apple', blurb: '能效比：自己 +2 护甲（不发热）' },
  { id: 'qualcomm', name: '高通', blurb: 'TOPS 营销：随机己方随从 +1/+1' },
  { id: 'arm', name: 'ARM', blurb: '公版方案：召唤 1/1 公版亮机卡' },
]

export function TutorialScreen() {
  const open = useTutorialStore((s) => s.open)
  const screen = useTutorialStore((s) => s.screen)
  const gameScreen = useGameStore((s) => s.screen)

  // 教程对局里点「规则」：gameStore 路由切到 rules，这里透传规则浮层（只读复用）
  if (open && gameScreen === 'rules') return <RulesScreen />
  if (!open) return null

  switch (screen) {
    case 'levels':
      return <LevelSelect />
    case 'brief':
      return <LevelBrief />
    case 'battle':
      return <TutorialBattle />
  }
}

function LevelSelect() {
  const progress = useTutorialStore((s) => s.progress)
  const showBrief = useTutorialStore((s) => s.showBrief)
  const resetAll = useTutorialStore((s) => s.resetAll)

  return (
    <div className="sc-tutorial sc-tutorial--page">
      <header className="sc-tutorial-head">
        <div>
          <h1 className="sc-screen-title">新手教程</h1>
          <p className="sc-tutorial-sub">五关毕业：通电 → 上机 → 关键词七连 → 派系对决 → 自由实战。任意关卡直达，进度自动保存。</p>
        </div>
        <div className="sc-tutorial-head-actions">
          <button
            type="button"
            className="sc-btn sc-btn--small"
            onClick={() => {
              if (window.confirm('清空教程进度？已完成记录会全部归零（不影响其他存档）。')) resetAll()
            }}
          >
            从头再来
          </button>
          <button type="button" className="sc-btn sc-btn--small sc-btn--danger" onClick={() => closeTutorial()}>
            回主菜单
          </button>
        </div>
      </header>

      <div className="sc-tutorial-levels">
        {TUTORIAL_LEVELS.map((level) => {
          const done =
            level.sections && level.sections.length > 0
              ? level.sections.every((section) => progress.sections[section.id] === true)
              : progress.levels[level.id] === true
          return (
            <button key={level.id} type="button" className={`sc-tutorial-level${done ? ' is-done' : ''}`} onClick={() => showBrief(level.id)}>
              <span className="sc-tutorial-level-no">第 {level.id} 关</span>
              <span className="sc-tutorial-level-name">{level.name}</span>
              <span className="sc-tutorial-level-sub">{level.subtitle}</span>
              <span className="sc-tutorial-level-state">{done ? '✓ 已通关' : '未通关'}</span>
            </button>
          )
        })}
      </div>
      <p className="sc-tutorial-foot">教程对局与真实对局走同一套引擎接口（initGame / applyAction / getLegalActions / viewFor）——教程里学的就是实战里用的。</p>
    </div>
  )
}

function LevelBrief() {
  const levelId = useTutorialStore((s) => s.levelId)
  const progress = useTutorialStore((s) => s.progress)
  const showLevels = useTutorialStore((s) => s.showLevels)
  const draftFaction = useTutorialStore((s) => s.draftFaction)
  const setDraftFaction = useTutorialStore((s) => s.setDraftFaction)
  const level = levelId !== null ? tutorialLevelById(levelId) : undefined

  if (!level) return null // 入口恒传有效关卡 id；异常时留在当前屏等用户返回

  const level3Done = level.sections && level.sections.length > 0 ? isLevel3Complete() : progress.levels[level.id] === true
  const nextSection = level.sections?.find((section) => progress.sections[section.id] !== true)

  return (
    <div className="sc-tutorial sc-tutorial--page">
      <header className="sc-tutorial-head">
        <div>
          <p className="sc-tutorial-kicker">第 {level.id} 关 · {level.subtitle}</p>
          <h1 className="sc-screen-title">{level.name}</h1>
        </div>
        <button type="button" className="sc-btn sc-btn--small" onClick={() => showLevels()}>
          ← 关卡列表
        </button>
      </header>

      <p className="sc-tutorial-brief">{level.brief}</p>

      {level.sections ? (
        <section className="sc-tutorial-sections">
          <h2>七节进度（点击任一节直接开打）</h2>
          <div className="sc-tutorial-section-grid">
            {level.sections.map((section) => {
              const done = progress.sections[section.id] === true
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`sc-tutorial-section${done ? ' is-done' : ''}`}
                  onClick={() => startTutorialMatch(level.id, section.id)}
                >
                  <span className="sc-tutorial-section-key">{section.keywordLabel}</span>
                  <span className="sc-tutorial-section-name">{section.name}</span>
                  <span className="sc-tutorial-section-state">{done ? '✓' : '待通关'}</span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      {level.chooseFaction ? (
        <section className="sc-tutorial-sections">
          <h2>选派系（= 选本局的英雄技能）</h2>
          <div className="sc-tutorial-faction-grid">
            {FACTION_CHOICES.map((faction) => {
              const skill = getFactionSkill(faction.id)
              const active = draftFaction === faction.id
              return (
                <button
                  key={faction.id}
                  type="button"
                  className={`sc-tutorial-faction${active ? ' is-active' : ''}`}
                  onClick={() => setDraftFaction(faction.id)}
                >
                  <strong>{faction.name}</strong>
                  <span>{skill ? `${skill.skillName}（${skill.cost}W）` : ''}</span>
                  <span className="sc-tutorial-faction-blurb">{faction.blurb}</span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <footer className="sc-tutorial-launch">
        {level.graduation ? (
          <button type="button" className="sc-btn sc-btn--primary" onClick={() => graduateToSetup()}>
            毕业了，进真实对局 →
          </button>
        ) : level.sections ? (
          <button
            type="button"
            className="sc-btn sc-btn--primary"
            onClick={() => startTutorialMatch(level.id, nextSection?.id ?? level.sections?.[0]?.id ?? null)}
          >
            {level3Done
              ? '随便挑一节热身'
              : `进入第 ${(nextSection ? (level.sections ?? []).indexOf(nextSection) : 0) + 1} 节 →`}
          </button>
        ) : (
          <button type="button" className="sc-btn sc-btn--primary" onClick={() => startTutorialMatch(level.id, null)}>
            开打
          </button>
        )}
      </footer>
    </div>
  )
}

function TutorialBattle() {
  const view = useGameStore((s) => s.view)
  const targeting = useGameStore((s) => s.targeting)
  const status = useTutorialStore((s) => s.status)
  const levelId = useTutorialStore((s) => s.levelId)
  const sectionId = useTutorialStore((s) => s.sectionId)
  const progress = useTutorialStore((s) => s.progress)
  const showBrief = useTutorialStore((s) => s.showBrief)
  const level = levelId !== null ? tutorialLevelById(levelId) : undefined
  const section = level?.sections?.find((item) => item.id === sectionId) ?? null

  return (
    <div className="sc-tutorial-battle">
      {view ? <BattleScreen /> : null}

      {/* 教练簇：全部教程 UI（标签/进度/按钮/气泡/目标条）收拢在手牌上方居中，
          顶部完整让给原生对战 HUD（战报/英雄面板/回合条零遮挡） */}
      <div className={`sc-tutorial-coach${targeting ? ' is-raised' : ''}`}>
        <div className="sc-tutorial-coach-top">
          <span className="sc-tutorial-tag">
            {level ? `第 ${level.id} 关 · ${level.name}` : ''}
            {section ? ` · ${section.keywordLabel}` : ''}
          </span>
          {section && level?.sections ? (
            <span className="sc-tutorial-dots" aria-label="七节进度">
              {level.sections.map((item) => (
                <i key={item.id} className={progress.sections[item.id] === true || item.id === section.id ? 'is-on' : undefined}>
                  {progress.sections[item.id] === true ? '✓' : (level.sections?.indexOf(item) ?? 0) + 1}
                </i>
              ))}
            </span>
          ) : null}
          <span className="sc-tutorial-hud-actions">
            <button type="button" className="sc-btn sc-btn--small" onClick={() => retryTutorialMatch()}>
              重新来过
            </button>
            <button type="button" className="sc-btn sc-btn--small sc-btn--danger" onClick={() => closeTutorial()}>
              退出教程
            </button>
          </span>
        </div>

        {status?.bubble ? (
          <div className="sc-tutorial-bubble" role="status">
            <strong>{status.bubble.title}</strong>
            <p>{status.bubble.body}</p>
            {status.nudge ? <p className="sc-tutorial-nudge">{status.nudge}</p> : null}
          </div>
        ) : null}

        {status && status.objectiveLabel ? (
          <div className="sc-tutorial-objective">
            <span>目标：{status.objectiveLabel}</span>
            {status.objectiveProgress ? (
              <strong>
                {status.objectiveProgress.done}/{status.objectiveProgress.total}
              </strong>
            ) : null}
          </div>
        ) : null}
      </div>

      {status?.phase === 'passed' ? (
        <div className="sc-tutorial-overlay" role="dialog" aria-label="过关">
          <div className="sc-tutorial-overlay-card">
            <h2>{section ? `${section.keywordLabel} · 通关` : '过关！'}</h2>
            <p>{section ? section.summary : level?.summary}</p>
            <div className="sc-tutorial-overlay-actions">
              {level?.chooseFaction ? (
                <button type="button" className="sc-btn" onClick={() => tutorialController.dismissPass()}>
                  继续打完
                </button>
              ) : null}
              {section && level ? (
                <button
                  type="button"
                  className="sc-btn sc-btn--primary"
                  onClick={() => {
                    const sections = level.sections ?? []
                    const index = sections.findIndex((item) => item.id === section.id)
                    const next = sections[index + 1]
                    if (next) startTutorialMatch(level.id, next.id)
                    else showBrief(level.id)
                  }}
                >
                  下一节 →
                </button>
              ) : level && level.id < 5 ? (
                <button type="button" className="sc-btn sc-btn--primary" onClick={() => showBrief(level.id + 1)}>
                  下一关 →
                </button>
              ) : null}
              <button type="button" className="sc-btn" onClick={() => showBrief(level?.id ?? 1)}>
                回关卡简报
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {status?.phase === 'failed' ? (
        <div className="sc-tutorial-overlay" role="dialog" aria-label="失败">
          <div className="sc-tutorial-overlay-card is-fail">
            <h2>翻车了</h2>
            <p>{section ? '这节是演示局，不该输的——重来一次，跟着气泡走。' : '对面把你 CPU 干退役了。没事，教程局输了不疼，点重来再来一遍。'}</p>
            <div className="sc-tutorial-overlay-actions">
              <button type="button" className="sc-btn sc-btn--primary" onClick={() => retryTutorialMatch()}>
                重新来过
              </button>
              <button type="button" className="sc-btn" onClick={() => showBrief(level?.id ?? 1)}>
                回关卡简报
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
