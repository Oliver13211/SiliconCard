/**
 * 动作契约 —— 玩家 / 内置 AI / 外部 Agent / 网络对端，统一以 Action 驱动引擎。
 */

import type { HandCardUid, InstanceId } from './cards'

export type PlayerId = 'P1' | 'P2'

/** 对局中一切"指向目标"的运行时引用 */
export type TargetRef =
  | { kind: 'unit'; instanceId: InstanceId }
  | { kind: 'hero'; playerId: PlayerId }

/**
 * 五种玩家动作。合法性条件见 docs/rules.md §3；
 * 非法动作由引擎抛 RuleError（错误码见 engine.ts）。
 */
export type Action =
  | { type: 'PLAY_CARD'; playerId: PlayerId; uid: HandCardUid; target?: TargetRef }
  | { type: 'ATTACK'; playerId: PlayerId; attackerId: InstanceId; target: TargetRef }
  | { type: 'USE_HERO_POWER'; playerId: PlayerId; target?: TargetRef }
  | { type: 'END_TURN'; playerId: PlayerId }
  | { type: 'CONCEDE'; playerId: PlayerId }
