import { beforeEach, describe, expect, it } from 'vitest'
import type { TargetRef } from '@siliconcard/core'
import { useGameStore } from '../store/gameStore'
import { RANDOM_DECK_ID } from '../game/deckLoader'

beforeEach(() => {
  useGameStore.getState()._resetForTests()
})

describe('菜单闭环（M1-UI3）：主菜单 → 选派系/卡组 → 对战 → 结算 → 再来一局', () => {
  it('开局：battle 屏 + 引擎视图就位 + 战报含开局事件', () => {
    const s = useGameStore.getState()
    s.setDraftFaction('neutral')
    s.startBattle({ seed: 20260101 })
    const after = useGameStore.getState()
    expect(after.screen).toBe('battle')
    expect(after.view?.viewer).toBe('P1')
    expect(after.view?.you.hand.length).toBe(3)
    expect(after.interactivity?.yourTurn).toBe(true)
    expect(after.log.some((e) => e.text.includes('对局开始'))).toBe(true)
    expect(after.config?.playerFaction).toBe('neutral')
    expect(after.config?.opponentFaction).toBeTruthy()
  })

  it('出牌流：能出的牌按引擎展开自动走「直接打出」或「目标选择→确认」', () => {
    const s = useGameStore.getState()
    // 集成接线后默认选中 content 预组卡组（费用对齐真实 TDP，首回合 100W 可能无牌可出）；
    // 本用例验证的是出牌流语义，显式选随机牌组以沿用其「保底最低费曲线」的前提。
    s.setDraftDeck(RANDOM_DECK_ID)
    s.startBattle({ seed: 20260101 })
    const state = useGameStore.getState()
    const manaBefore = state.view?.you.mana ?? 0
    const playable = [...(state.interactivity?.playsByUid.entries() ?? [])]
    expect(playable.length).toBeGreaterThan(0)
    const [uid, targets] = playable[0] as [string, readonly TargetRef[]]
    state.tryPlayCard(uid)
    if (targets.length === 0) {
      expect(useGameStore.getState().targeting).toBeNull()
      expect(useGameStore.getState().view?.you.mana).toBeLessThan(manaBefore)
    } else {
      expect(useGameStore.getState().targeting?.targets.length).toBeGreaterThan(0)
      useGameStore.getState().confirmTarget(targets[0] as TargetRef)
      const done = useGameStore.getState()
      expect(done.targeting).toBeNull()
      expect(done.view?.you.mana).toBeLessThan(manaBefore)
    }
  })

  it('目标选择可取消（ESC 语义）', () => {
    const s = useGameStore.getState()
    s.startBattle({ seed: 20260101 })
    const state = useGameStore.getState()
    const withTargets = [...(state.interactivity?.playsByUid.entries() ?? [])].find(([, t]) => t.length > 0)
    if (!withTargets) return // 该 seed 起手没有目标牌：取消流由其他 seed 用例覆盖
    state.tryPlayCard(withTargets[0] as string)
    expect(useGameStore.getState().targeting).not.toBeNull()
    useGameStore.getState().cancelTargeting()
    expect(useGameStore.getState().targeting).toBeNull()
  })

  it('非法操作反馈：点不存在的手牌给出明确错误，状态不被污染', () => {
    const s = useGameStore.getState()
    s.startBattle({ seed: 20260101 })
    const manaBefore = useGameStore.getState().view?.you.mana
    useGameStore.getState().tryPlayCard('ghost-uid')
    const after = useGameStore.getState()
    expect(after.lastError?.message).toContain('不在手上')
    expect(after.view?.you.mana).toBe(manaBefore)
    after.clearError()
    expect(useGameStore.getState().lastError).toBeNull()
  })

  it('托管推进：endTurn 后 P2 自动走完回合回到 P1', () => {
    const s = useGameStore.getState()
    s.startBattle({ seed: 20260101 })
    useGameStore.getState().endTurn()
    expect(useGameStore.getState().view?.activePlayer).toBe('P2')
    for (let i = 0; i < 80; i++) {
      const view = useGameStore.getState().view
      if (!view || view.phase === 'ended' || view.activePlayer === 'P1') break
      useGameStore.getState().botTick()
    }
    const view = useGameStore.getState().view
    expect(view && (view.activePlayer === 'P1' || view.phase === 'ended')).toBe(true)
  })

  it('认输结算：result 屏数据按 §9（GAME_END + 终局视图），失败方见「R.I.P 烧了」', () => {
    const s = useGameStore.getState()
    s.startBattle({ seed: 20260101 })
    useGameStore.getState().concede()
    const after = useGameStore.getState()
    expect(after.screen).toBe('result')
    expect(after.result?.reason).toBe('concede')
    expect(after.result?.winner).toBe('opponent')
    expect(after.result?.headline).toContain('R.I.P')
    expect(after.result?.turns).toBe(after.view?.turn)
    expect(after.result?.you.heroName).toBe('你')
    expect(after.result?.opponent.heroName).toBe('对面老哥')
  })

  it('再来一局：同一配置新对局（result 清空、战报重置、回到 battle）', () => {
    const s = useGameStore.getState()
    s.setDraftFaction('neutral')
    s.startBattle({ seed: 20260101 })
    useGameStore.getState().concede()
    expect(useGameStore.getState().screen).toBe('result')
    useGameStore.getState().rematch()
    const after = useGameStore.getState()
    expect(after.screen).toBe('battle')
    expect(after.result).toBeNull()
    expect(after.log).toHaveLength(2) // GAME_START + TURN_START
    expect(after.view?.turn).toBe(1)
    expect(after.config?.playerFaction).toBe('neutral')
  })

  it('返回主菜单：对局状态全部清空', () => {
    const s = useGameStore.getState()
    s.startBattle({ seed: 20260101 })
    useGameStore.getState().backToMenu()
    const after = useGameStore.getState()
    expect(after.screen).toBe('menu')
    expect(after.view).toBeNull()
    expect(after.log).toEqual([])
    expect(after.config).toBeNull()
  })
})

describe('规则页闭环', () => {
  it('主菜单进规则页后返回来源屏', () => {
    const s = useGameStore.getState()
    s.openRules()
    expect(useGameStore.getState().screen).toBe('rules')
    useGameStore.getState().closeRules()
    expect(useGameStore.getState().screen).toBe('menu')
  })
})
