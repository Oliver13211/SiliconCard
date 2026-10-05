/**
 * 协议契约测试（WF-AGENT 第 2 步：协议样例消息往返全部通过）。
 * 覆盖：StateMessage 自解释性 / legalActions 语义 / JSON 往返重放 /
 *      非法动作错误含纠正指导 / 参数解析 / content 装载。
 */

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { parsePlayArgs, DEMO_USAGE, PLAY_USAGE } from './args'
import { defaultGameDir, loadContent, repoRoot, resolveDeckChoice, UsageError } from './content'
import {
  buildGameOverMessage,
  buildStateMessage,
  parseAgentAction,
  toProtocolError,
  type StateMessage,
} from './protocol'
import { chooseScriptedAction, makeMatch } from './testHelpers'

describe('StateMessage 自解释性', () => {
  const match = makeMatch(42)
  const msg: StateMessage = buildStateMessage(match, { protocol: 'siliconcard.file/1' })

  it('裁剪视图：你=完整手牌，对手=仅计数（无手牌/牌库内容）', () => {
    expect(msg.state.you.hand.length).toBeGreaterThan(0)
    expect(msg.state.you.hand[0]).toHaveProperty('uid')
    expect(msg.state.you.hand[0]).toHaveProperty('cost')
    expect(msg.state.opponent).not.toHaveProperty('hand')
    expect(msg.state.opponent.handSize).toBeGreaterThan(0)
    expect(msg.state.opponent.deckSize).toBe(27) // 30 - 开局起手 3（P1 第 1 回合不抽牌）
    expect(JSON.stringify(msg)).not.toMatch(/"rng"/) // 永不泄露 rng 状态
  })

  it('legalActions 每条都带 kind 与非空人话 summary，含 END_TURN 收尾', () => {
    expect(msg.legalActions.length).toBeGreaterThan(0)
    for (const entry of msg.legalActions) {
      expect(entry.summary.length).toBeGreaterThan(0)
      expect(typeof entry.action.type).toBe('string')
    }
    expect(msg.legalActions.some((l) => l.kind === 'END_TURN')).toBe(true)
  })

  it('出牌类 summary 展示卡名/功耗/效果而非裸 uid', () => {
    const play = msg.legalActions.find((l) => l.kind === 'PLAY_CARD')
    if (play) {
      expect(play.summary).toMatch(/打出「/)
      expect(play.summary).toMatch(/功耗 \d+W/)
    }
  })

  it('cardGlossary 覆盖手牌与场上全部 cardId，含名称/类型/功耗/效果文本', () => {
    for (const card of msg.state.you.hand) {
      const entry = msg.cardGlossary[card.cardId]
      expect(entry, `图鉴缺 ${card.cardId}`).toBeDefined()
      expect(entry?.name).toBeTruthy()
      expect(['gpu', 'driver', 'accessory']).toContain(entry?.type)
    }
  })

  it('help 块与 heroPowers 在场，错误码表齐备（自解释兜底）', () => {
    expect(msg.help.actionTypes).toHaveProperty('PLAY_CARD')
    expect(msg.help.howToAct.file).toMatch(/action\.json/)
    expect(msg.heroPowers).toHaveProperty(msg.state.you.faction)
    // 终审反馈回归：stateDigest 必须点明 board 单位的 ownerId 归属字段与手牌轻量引用
    expect(msg.help.stateDigest).toMatch(/ownerId/)
    expect(msg.help.stateDigest).toMatch(/cardGlossary\[/)
  })
})

describe('协议样例往返（state 输出 → action 输入）', () => {
  it('StateMessage JSON 序列化 → 取 legalActions[].action → 结算成功且事件流非空', () => {
    const match = makeMatch(42)
    const wire = JSON.stringify(buildStateMessage(match, {})) // 模拟跨进程传输
    const parsed = JSON.parse(wire) as StateMessage
    const play = parsed.legalActions.find((l) => l.kind === 'PLAY_CARD') ?? parsed.legalActions.find((l) => l.kind === 'END_TURN')
    expect(play).toBeDefined()
    const outcome = match.applyAgentAction(play!.action) // 回传的动作应被引擎接受
    expect(outcome.ok).toBe(true)
    expect(outcome.events!.length).toBeGreaterThan(0)
  })

  it('同 seed 下：JSON 往返动作与原始动作结算结果逐字节一致', () => {
    const a = makeMatch(42)
    const b = makeMatch(42)
    const action = chooseScriptedAction(buildStateMessage(a, {}))!.action
    const roundTripped = JSON.parse(JSON.stringify(action)) as typeof action
    a.applyAgentAction(action)
    b.applyAgentAction(roundTripped)
    expect(JSON.stringify(a.engine.viewFor(a.state, 'P1'))).toBe(JSON.stringify(b.engine.viewFor(b.state, 'P1')))
  })

  it('动作输入解析：{"type":"action"} 包装 / {"action"} 包装 / 裸动作三种形态等价', () => {
    const action = { type: 'END_TURN', playerId: 'P1' }
    expect(parseAgentAction({ type: 'action', action })).toEqual({ action })
    expect(parseAgentAction({ action })).toEqual({ action })
    expect(parseAgentAction(action)).toEqual({ action })
    expect(parseAgentAction('not json')).toHaveProperty('error')
    expect(parseAgentAction({ nope: 1 })).toHaveProperty('error')
  })
})

describe('非法动作错误必须含纠正指导', () => {
  it('CARD_NOT_IN_HAND：code + message + hint 指向 legalActions', () => {
    const match = makeMatch(42)
    const outcome = match.applyAgentAction({ type: 'PLAY_CARD', playerId: 'P1', uid: 'ghost-uid' } as never)
    expect(outcome.ok).toBe(false)
    const err = toProtocolError(outcome.error!)
    expect(err.code).toBe('CARD_NOT_IN_HAND')
    expect(err.hint).toMatch(/legalActions/)
  })

  it('INSUFFICIENT_MANA：提示剩余功耗与 END_TURN 出路', () => {
    const match = makeMatch(42)
    const msg = buildStateMessage(match, {})
    const pricey = msg.state.you.hand.filter((c) => c.cost > msg.state.you.mana).sort((x, y) => y.cost - x.cost)[0]
    expect(pricey, '起手应有功耗不足的牌（seed=42 固定）').toBeDefined()
    const outcome = match.applyAgentAction({ type: 'PLAY_CARD', playerId: 'P1', uid: pricey!.uid } as never)
    expect(outcome.ok).toBe(false)
    const err = toProtocolError(outcome.error!)
    expect(err.code).toBe('INSUFFICIENT_MANA')
    expect(err.hint).toMatch(/mana/)
    expect(err.hint).toMatch(/END_TURN/)
  })

  it('UNIT_NOT_ON_BOARD / UNKNOWN_ACTION：错误码与指导齐备，且状态未被破坏', () => {
    const match = makeMatch(42)
    const before = JSON.stringify(match.engine.viewFor(match.state, 'P1'))
    const bad1 = match.applyAgentAction({ type: 'ATTACK', playerId: 'P1', attackerId: 'u-ghost', target: { kind: 'hero', playerId: 'P2' } } as never)
    expect(bad1.ok).toBe(false)
    expect(toProtocolError(bad1.error!).code).toBe('UNIT_NOT_ON_BOARD')
    const bad2 = match.applyAgentAction({ whatever: true } as never)
    expect(bad2.ok).toBe(false)
    expect(toProtocolError(bad2.error!).code).toBe('UNKNOWN_ACTION')
    expect(JSON.stringify(match.engine.viewFor(match.state, 'P1'))).toBe(before) // 非法动作不改动状态
  })

  it('终局后的动作返回 GAME_ENDED 并指路 gameover', () => {
    const match = makeMatch(42)
    match.applyAgentAction({ type: 'CONCEDE', playerId: 'P1' })
    const outcome = match.applyAgentAction({ type: 'END_TURN', playerId: 'P1' } as never)
    expect(outcome.ok).toBe(false)
    expect(toProtocolError(outcome.error!).code).toBe('GAME_ENDED')
    expect(toProtocolError(outcome.error!).hint).toMatch(/gameover/)
    expect(buildGameOverMessage(match).winner).toBe('P2')
  })
})

describe('参数解析与 content 装载', () => {
  it('parsePlayArgs：默认值 / 覆盖 / 未知参数报错', () => {
    const args = parsePlayArgs(['--mode', 'stdio', '--seed', '7', '--difficulty', 'hard', '--deck', 'amd-war-future', '--dir', '/tmp/x'])
    expect(args).toMatchObject({ mode: 'stdio', seed: 7, difficulty: 'hard', deck: 'amd-war-future', dir: '/tmp/x' })
    expect(parsePlayArgs([])).toMatchObject({ mode: 'file', seed: 42, difficulty: 'normal' })
    expect(parsePlayArgs([]).dir).toBeUndefined() // 默认目录由 play.ts 经 defaultGameDir() 解析
    expect(() => parsePlayArgs(['--wat'])).toThrow(UsageError)
    expect(() => parsePlayArgs(['--seed', 'abc'])).toThrow(/0 ~ 4294967295/)
    expect(() => parsePlayArgs(['--difficulty', 'extreme'])).toThrow(/easy \/ normal \/ hard/)
  })

  it('默认交换目录稳定落在仓库根下（不随 cwd/调用方式漂移）', () => {
    expect(defaultGameDir()).toBe(resolve(defaultGameDir())) // 绝对路径
    expect(defaultGameDir()).toMatch(/silicon-card-game$/)
    expect(defaultGameDir()).toBe(resolve(repoRoot(), 'silicon-card-game'))
  })

  it('--help 文案写死一行可复制的入口命令', () => {
    expect(PLAY_USAGE).toContain('yarn workspace @siliconcard/cli play --mode file --seed 42')
    expect(PLAY_USAGE).toContain('yarn workspace @siliconcard/cli demo --seed 42')
    expect(DEMO_USAGE).toContain('yarn workspace @siliconcard/cli demo --seed 42')
  })

  it('loadContent：注册正式卡池并解析预组卡组；未知卡组 id 报错列出可选项', () => {
    const content = loadContent()
    expect(content.cards.length).toBeGreaterThanOrEqual(50)
    expect(content.invalidCards).toEqual([])
    expect(content.decks.map((d) => d.id).sort()).toEqual(['amd-war-future', 'apple-efficiency-faith', 'arm-reference-swarm', 'intel-driver-magic', 'neutral-system-builder', 'nvidia-flagship-faith', 'qualcomm-ai-everything'])
    const choice = resolveDeckChoice('amd-war-future', 'x', content, 'deck')
    expect(choice.faction).toBe('amd')
    expect(choice.spec.cards.reduce((n, c) => n + c.count, 0)).toBe(30)
    expect(() => resolveDeckChoice('no-such-deck', 'x', content, 'deck')).toThrow(/amd-war-future/)
  })

  it('AgentMatch 构造：双方各抽 3 张起手（牌库余 27）、先手 P1、对手 AI 执 P2', () => {
    const match = makeMatch(42)
    expect(match.state.players.P1.deck.length).toBe(27)
    expect(match.state.players.P1.hand.length).toBe(3)
    expect(match.state.players.P2.hand.length).toBe(3)
    expect(match.state.activePlayer).toBe('P1')
    expect(match.ai.playerId).toBe('P2')
    expect(match.agentTurn).toBe(true)
  })
})
