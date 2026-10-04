/**
 * 文件模式全流程（M3-AGT1 验收）：注册 content 卡组 → 外部 agent（脚本化，
 * 只看 turn.json）打满一局 → gameover.json；--seed 确定性（两局逐字段一致）。
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent, resolveDeckChoice } from './content'
import { AgentMatch, type AgentMatchOptions } from './driver'
import { runFileMode } from './modes/file'
import { runFileActor, chooseScriptedAction, type ActorReport } from './testHelpers'
import { FILE_PROTOCOL, type StateMessage } from './protocol'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'siliconcard-cli-'))
}

function seededMatch(seed: number, difficulty: AgentMatchOptions['difficulty'] = 'normal'): AgentMatch {
  const content = loadContent() // 生产路径在 play.ts：先注册 content 卡池与预组卡组
  return new AgentMatch({
    seed,
    difficulty,
    agentDeck: resolveDeckChoice(undefined, 'nvidia-flagship-faith', content, 'deck'),
    opponentDeck: resolveDeckChoice(undefined, 'amd-war-future', content, 'opponent-deck'),
  })
}

/** 起一局文件模式对局（CLI 侧 + 脚本 agent 侧并发），返回 agent 视角的全程记录 */
async function playFullFileGame(dir: string, seed: number, choose = chooseScriptedAction): Promise<{ over: Awaited<ReturnType<typeof runFileMode>>; actor: ActorReport }> {
  const [over, actor] = await Promise.all([
    runFileMode(seededMatch(seed), { dir, pollMs: 2, log: () => {} }),
    runFileActor(dir, { choose }),
  ])
  return { over, actor }
}

describe('file 模式全流程（注册 content 卡组 → 打满一局 → gameover）', () => {
  it('turn.json / action.json 轮转 → gameover.json，正常终局', async () => {
    const dir = tempDir()
    try {
      const { over, actor } = await playFullFileGame(dir, 42)
      expect(over.protocol).toBe(FILE_PROTOCOL)
      expect(over.message).toBe('gameover')
      expect(['P1', 'P2', null]).toContain(over.winner)
      expect(over.endReason).toMatch(/health_zero|concede/)
      expect(over.turns).toBeGreaterThan(0)
      expect(over.totalEvents).toBeGreaterThan(0)
      expect(over.aiAnomalies).toEqual([]) // 正常对局 AI 零异常
      // 终审第 2 轮缺陷 2 修复：gameover 必须带全程 log 与全程原始事件
      expect(over.events.length).toBe(over.totalEvents)
      expect(over.log.length).toBe(over.totalEvents)
      expect(over.log.some((l) => l.includes('对局结束'))).toBe(true)
      expect(existsSync(join(dir, 'protocol-readme.txt'))).toBe(true)
      expect(existsSync(join(dir, 'action.json'))).toBe(false) // 动作文件消费即删
      // 全程状态消息满足外部 agent 自解释契约
      expect(actor.stateMessages.length).toBeGreaterThan(0)
      for (const msg of actor.stateMessages as StateMessage[]) {
        expect(msg.protocol).toBe(FILE_PROTOCOL)
        expect(msg.waitingFor).toBe('P1')
        expect(msg.state.opponent).not.toHaveProperty('hand') // 对手手牌永不泄露
        expect(msg.legalActions.some((l) => l.kind === 'END_TURN')).toBe(true)
        expect(Object.keys(msg.cardGlossary).length).toBeGreaterThan(0)
        // lastError 与 lastSettled 同源：报错必有 accepted=false 回执，无错必无拒绝回执
        if (msg.lastError) {
          expect(msg.lastSettled?.accepted).toBe(false)
          expect(msg.lastSettled?.error?.code).toBe(msg.lastError.code)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('非法动作：lastSettled 回执指向该动作且 accepted=false（终审第 2 轮缺陷 1 回归：绝无 lastError 迟到/丢失）', async () => {
    const dir = tempDir()
    try {
      let mischiefDone = false
      const mischief = (msg: Parameters<typeof chooseScriptedAction>[0]) => {
        // 第 1 回合故意发一个不存在的 uid，验证回执闭环后照常打满
        if (!mischiefDone) {
          mischiefDone = true
          return {
            action: { type: 'PLAY_CARD', playerId: 'P1', uid: 'i-do-not-exist' } as const,
            kind: 'PLAY_CARD' as const,
            summary: '',
          }
        }
        return chooseScriptedAction(msg)
      }
      const { actor } = await playFullFileGame(dir, 42, mischief)
      expect(actor.lastErrorCodes).toContain('CARD_NOT_IN_HAND')
      // 回执关联性：必须存在一条 turn.json，其 lastSettled 恰好指向被提交的非法动作且 accepted=false
      const receipt = actor.stateMessages.find(
        (m) => m.lastSettled && m.lastSettled.accepted === false && (m.lastSettled.action as { uid?: string } | undefined)?.uid === 'i-do-not-exist',
      )
      expect(receipt, '非法动作必须拿到指向自身的拒绝回执（seq+lastError 同次写入）').toBeDefined()
      expect(receipt!.lastError?.code).toBe('CARD_NOT_IN_HAND')
      const gameOver = actor.gameover
      expect(['P1', 'P2', null]).toContain(gameOver.winner)
      expect(gameOver.turns).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('--seed 确定性', () => {
  it('同 seed 两局：gameover 摘要与全程状态消息逐字段一致', async () => {
    const dirs = [tempDir(), tempDir()]
    try {
      const [a, b] = await Promise.all(dirs.map((dir) => playFullFileGame(dir, 1234)))
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      expect(JSON.stringify(a!.over)).toBe(JSON.stringify(b!.over))
      expect(JSON.stringify(a!.actor.stateMessages)).toBe(JSON.stringify(b!.actor.stateMessages))
      expect(a!.over.winner).not.toBeNull()
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
