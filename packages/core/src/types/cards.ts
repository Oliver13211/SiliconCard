/**
 * 卡牌定义契约 —— @siliconcard/content 的 JSON 必须符合本文件类型。
 * 本文件是跨包契约：修改走 WF-ENGINE（docs/agents/workflows.md）。
 */

/** 派系 id：数据驱动，content 可无限新增；内置七系见 docs/rules.md §8 */
export type FactionId = string

export type CardId = string
/** 场上实例的唯一 id */
export type InstanceId = string
/** 手牌实例的唯一 id（PLAY_CARD 以此指牌） */
export type HandCardUid = string

export type CardType = 'gpu' | 'driver' | 'accessory'

/** 七个 M1 关键词的稳定 id（显示名与文案在 content，精确定义见 docs/rules.md §7） */
export type Keyword =
  | 'taunt' // 信仰充值（嘲讽）
  | 'divine_shield' // 三年质保（圣盾）
  | 'charge' // 超频（冲锋）
  | 'windfury' // 双芯 GPU（风怒）
  | 'deathrattle' // 蓝屏 / 传家宝（亡语）
  | 'stealth' // 无输出亮机（潜行）
  | 'overload' // 跳闸（过载）

export type Rarity = 'starter' | 'common' | 'rare' | 'epic' | 'legendary'

/** 程序化卡面渲染参数（client-3d 消费，禁止外部图片资产） */
export interface CardArt {
  shape: string
  palette: string
  glow?: string
}

// —— 效果系统 ——

export type EffectTrigger =
  | 'battlecry' // 战吼：gpu 入场 / driver·accessory 出牌结算时
  | 'deathrattle' // 亡语：死亡时触发
  | 'onPlay' // 出牌即结算（driver 的主触发）
  | 'aura' // 光环：在场持续生效（配合 aura 字段，多为 accessory）
  | 'turnStart' // 回合开始
  | 'turnEnd' // 回合结束
  | 'onAttack' // 攻击宣告时
  | 'onDamaged' // 受伤后

export type TargetPool =
  | 'ownHero'
  | 'enemyHero'
  | 'ownUnits'
  | 'enemyUnits'
  | 'allUnits'
  | 'anyCharacter' // 全部单位 + 双方 CPU
  | 'self' // 效果源实例自身
  | 'sourceOwner' // 效果源拥有者（CPU 本体）
  | 'opposingPlayer'

/**
 * 目标选择器（M1-ENG6 additive 扩展）：可选 tag 子类过滤——非空字符串时仅命中
 * 卡牌定义 tags 含该标记的场上单位（如 'miner' 供「矿难」筛选，§4 tags 字段）。
 * 只增不改：既有无 tag 定义语义不变；英雄无卡牌定义，tag 过滤下天然排除。
 */
export type TargetSelector =
  | { kind: 'chosen'; pool: TargetPool; tag?: string } // 出牌时玩家指定（合法性校验见 rules.md §3）
  | { kind: 'random'; pool: TargetPool; tag?: string } // 引擎种子 RNG 随机选一
  | { kind: 'all'; pool: TargetPool; tag?: string } // 全选

export type EffectPlayer = 'sourceOwner' | 'opposingPlayer'

/** 声明式效果步骤：按数组顺序结算（原语清单见 rules.md §5） */
export type EffectStep =
  | { op: 'damage'; target: TargetSelector; amount: number }
  | { op: 'heal'; target: TargetSelector; amount: number }
  | { op: 'buff'; target: TargetSelector; attack?: number; health?: number }
  | { op: 'grantKeyword'; target: TargetSelector; keyword: Keyword }
  | { op: 'removeKeyword'; target: TargetSelector; keyword: Keyword }
  | { op: 'draw'; player: EffectPlayer; count: number }
  | { op: 'summon'; cardId: CardId; count: number }
  | { op: 'destroy'; target: TargetSelector }
  | { op: 'revive'; pick: 'lastOwnedGpu' | 'random'; to: 'sourceOwnerBoard'; count?: number }
  | { op: 'gainArmor'; player: EffectPlayer; amount: number }
  | { op: 'lockMana'; player: EffectPlayer; amount: number }
  | { op: 'handler'; name: string }

/** 光环：在场期间对 scope 内单位的常驻修正 */
export interface AuraSpec {
  stat: 'attack' | 'health' | 'cost'
  delta: number
  scope: 'ownUnits' | 'enemyUnits' | 'allUnits'
}

export interface EffectSpec {
  trigger: EffectTrigger
  steps?: readonly EffectStep[]
  aura?: AuraSpec
  /** steps 表达不了的特殊逻辑：在 core/src/effects 按 name 注册后引用 */
  handler?: string
}

export interface CardDefinition {
  id: CardId
  name: string
  faction: FactionId
  type: CardType
  /** 功耗（W） */
  cost: number
  /** gpu 专属：攻击 */
  attack?: number
  /** gpu 专属：血量 */
  health?: number
  keywords?: readonly Keyword[]
  effect?: EffectSpec
  rarity?: Rarity
  flavor?: string
  art?: CardArt
  /** 子类标记（如 'miner' 供「矿难」类效果筛选），数据驱动可扩展 */
  tags?: readonly string[]
}
