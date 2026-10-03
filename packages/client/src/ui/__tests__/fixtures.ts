/**
 * 测试工具：固定的 30 张牌组与手搓 PlayerView（纯函数推导层的直接输入）。
 */

import type {
  BoardUnit,
  DeckSpec,
  HandCard,
  PlayerView,
  PublicPlayerState,
  SelfPlayerState,
} from '@siliconcard/core'

/** 用单一卡牌凑满 30 张的固定牌组（initGame 只要求总数 = DECK_SIZE） */
export function deckOf(cardId: string, count = 30): DeckSpec {
  return { cards: [{ cardId, count }] }
}

/** 混合卡牌凑满 30 张（按传入顺序循环） */
export function deckFrom(cardIds: readonly string[], total = 30): DeckSpec {
  const cards = cardIds.map((cardId, index) => ({ cardId, count: Math.max(1, Math.floor((total - index) / cardIds.length)) }))
  const sum = cards.reduce((n, c) => n + c.count, 0)
  if (sum !== total && cards.length > 0) {
    const first = cards[0]
    if (first) first.count += total - sum
  }
  return { cards }
}

export function publicPlayer(overrides?: Partial<PublicPlayerState>): PublicPlayerState {
  return {
    id: 'P1',
    faction: 'neutral',
    heroName: '你',
    health: 30,
    maxHealth: 30,
    armor: 0,
    mana: 100,
    maxMana: 100,
    handSize: 3,
    deckSize: 27,
    graveyardSize: 0,
    fatigue: 0,
    heroPowerUsed: false,
    ...overrides,
  }
}

export function handCard(overrides?: Partial<HandCard>): HandCard {
  return { uid: 'hand-1', cardId: 'demo-gt-1030', cost: 30, ...overrides }
}

export function boardUnit(overrides?: Partial<BoardUnit>): BoardUnit {
  return {
    instanceId: 'u1',
    cardId: 'demo-gt-1030',
    ownerId: 'P1',
    attack: 1,
    health: 2,
    maxHealth: 2,
    keywords: [],
    summonedOnTurn: 1,
    attacksRemaining: 1,
    attackedThisTurn: false,
    ...overrides,
  }
}

/** 手搓合法 PlayerView（deriveInteractivity / 手牌状态 / 攻击状态的纯函数输入） */
export function makeView(overrides?: {
  you?: Partial<SelfPlayerState>
  opponent?: Partial<PublicPlayerState>
  board?: BoardUnit[]
  turn?: number
  activePlayer?: 'P1' | 'P2'
  phase?: 'main' | 'ended'
}): PlayerView {
  const you: SelfPlayerState = {
    ...publicPlayer({ id: 'P1', heroName: '你' }),
    hand: [handCard()],
    ...overrides?.you,
  }
  const opponent = publicPlayer({ id: 'P2', heroName: '对面老哥', handSize: 4, deckSize: 26, ...overrides?.opponent })
  return {
    viewer: 'P1',
    turn: overrides?.turn ?? 1,
    phase: overrides?.phase ?? 'main',
    activePlayer: overrides?.activePlayer ?? 'P1',
    winner: null,
    you,
    opponent,
    board: overrides?.board ?? [],
  }
}
