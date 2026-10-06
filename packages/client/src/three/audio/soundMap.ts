/**
 * 事件→音效映射表（M4-SND1）——音频契约 = docs/rules.md §6 的 17 种 GameEvent。
 *
 * 铁律（与 eventAnimationMap 同款）：音效一律由 GameEvent 驱动；新事件先补本映射
 * 再写音效。键集用映射类型 `{ [K in GameEvent['type']] }` 声明，引擎加事件而本表
 * 未补时 typecheck 即失败；**17/17 全部是真音效条目、无默认分支吞事件**——
 * 变体级（viewer 视角 / 伤害类型 / 七派系技能）在对应函数内分流，未知技能仍给
 * 通用激活音（mod 不哑）。
 *
 * 音画同拍：delay 参数对齐 eventAnimationMap 的演出节奏——
 * - ATTACK_DECLARED：0.15s 冲刺破空（蓄力 0.16s 结束）→ 0.32s 命中（弹冲段 p>0.45 的冲击帧）
 * - CARD_PLAYED：0s 出手破空 → 0.40s 落场闷响（飞行补间 0.42s 收尾）
 * - MINION_SUMMONED：0s 空投气流 → 0.34s 触地闷响（下落补间第一段 0.34s 结束）
 * - BURN_OUT：0/0.14s 两道电击（对齐两连闪屏）→ 0.1s 起跳闸功率下滑
 * - GAME_END / FATIGUE 等即时结算类命中音落 0 帧
 *
 * 七派系技能音色（rules.md §8，经 SKILL_FACTION 分流，未知技能回落通用音）：
 * - nvidia  dlss             亮三角波上滑（帧数提升的「亮」）
 * - amd     ray_tracing_try  锯齿冲刺 + 低频嗡鸣（红龙咆哮感）
 * - intel   driver_update    三连升调 blip（对齐 22%→67%→99% 进度条）
 * - neutral dust_off         高通白噪气吹（清灰的「噗——」）
 * - apple   efficiency       柔正弦双音（安静凉快，无风扇声）
 * - qualcomm tops_marketing  快速琶音迸发（数字一个个蹦出来）
 * - arm     reference_design 下降钟音（公版从天而降的传送感）
 */

import type { GameEvent, PlayerId } from '@siliconcard/core'
import { SKILL_FACTION } from '../anim/eventAnimationMap'
import { noise, tone, type SoundLayer, type SoundSpec } from './spec'

/** 单事件音效条目：拿窄化后的 payload + 视角方，返回纯数据 SoundSpec */
export type EventSound<K extends GameEvent['type']> = (
  event: Extract<GameEvent, { type: K }>,
  viewer: PlayerId,
) => SoundSpec

/** 17 事件完整映射（键全量由编译期保证；条目恒为函数，变体分流在函数内） */
export type EventSoundMap = { [K in GameEvent['type']]: EventSound<K> }

/** amd 光追失败的借位契约 detail（rules.md §5 定稿字面量，与 core / eventAnimationMap 对齐） */
const RAY_TRACING_FAIL_DETAIL = '光追失败'

export const eventSoundMap: EventSoundMap = {
  GAME_START: () => ({
    // 上电自检：低频上电爬升 + 空气涌入；装饰层为高频自检哨
    layers: [
      tone('sawtooth', 55, 0.9, 0.3, { glideTo: 110, attack: 0.03 }),
      tone('sine', 220, 1.1, 0.18, { glideTo: 440, attack: 0.05 }),
      noise(0.7, 0.12, { filter: { type: 'lowpass', freq: 600 } }),
    ],
    extras: [tone('sine', 880, 0.6, 0.06, { delay: 0.5 })],
  }),

  TURN_START: (ev, viewer) =>
    ev.playerId === viewer
      ? {
          // 你的回合：明亮的升调双音（上电就绪）
          layers: [
            tone('sine', 523.25, 0.12, 0.22),
            tone('sine', 783.99, 0.28, 0.25, { delay: 0.12 }),
          ],
          extras: [tone('triangle', 1046.5, 0.2, 0.08, { delay: 0.12 })],
        }
      : {
          // 对面回合：低八度弱化降调（存在感但不抢戏）
          layers: [
            tone('sine', 392, 0.12, 0.16),
            tone('sine', 329.63, 0.24, 0.18, { delay: 0.12 }),
          ],
        },

  TURN_END: (ev, viewer) =>
    ev.playerId === viewer
      ? { layers: [tone('sine', 392, 0.22, 0.15, { glideTo: 261.63 })] }
      : { layers: [tone('sine', 261.63, 0.14, 0.08)] },

  CARD_DRAWN: (ev) =>
    ev.source === 'fatigue'
      ? {
          // 牌库空转的「抽了个寂寞」：干瘪闷响（视觉侧无卡可飞，rules.md §6）
          layers: [tone('sine', 180, 0.2, 0.12, { glideTo: 120 }), noise(0.15, 0.08, { filter: { type: 'lowpass', freq: 300 } })],
        }
      : {
          // 抽牌：指尖翻卡的瞬态噪声 + 上滑轻音（对齐 0.5s 飞牌弧线的起手）
          layers: [
            noise(0.1, 0.16, { filter: { type: 'highpass', freq: 2400 } }),
            tone('triangle', 520, 0.14, 0.16, { glideTo: 760, delay: 0.02 }),
          ],
        },

  CARD_PLAYED: () => ({
    // 出手破空（带通扫频）→ 0.40s 落场闷响（飞行补间 0.42s 内的冲击帧）
    layers: [
      noise(0.3, 0.22, { filter: { type: 'bandpass', freq: 500, sweepTo: 1800, q: 1.2 } }),
      tone('sine', 150, 0.18, 0.5, { glideTo: 68, delay: 0.4 }),
      noise(0.1, 0.3, { delay: 0.4, filter: { type: 'lowpass', freq: 400 } }),
    ],
    extras: [tone('triangle', 660, 0.12, 0.1, { delay: 0.42 })],
  }),

  CARD_BURNED: () => ({
    // 烧卡：闷燃噼啪 + 火焰下坠音；装饰层为高频嘶嘶
    layers: [
      noise(0.4, 0.3, { filter: { type: 'lowpass', freq: 900 } }),
      tone('sawtooth', 240, 0.35, 0.18, { glideTo: 80 }),
    ],
    extras: [noise(0.25, 0.1, { delay: 0.05, filter: { type: 'highpass', freq: 3000 } })],
  }),

  MINION_SUMMONED: () => ({
    // 空投气流 → 0.34s 触地闷响（下落补间第一段 0.34s 结束）→ 落场轻环
    layers: [
      noise(0.2, 0.15, { filter: { type: 'bandpass', freq: 800 } }),
      tone('sine', 130, 0.2, 0.45, { glideTo: 60, delay: 0.34 }),
      tone('sine', 660, 0.25, 0.12, { delay: 0.38 }),
    ],
    extras: [tone('sine', 990, 0.2, 0.07, { delay: 0.4 })],
  }),

  MINION_DIED: () => ({
    // 冒烟下岗：高频碎裂 + 锯齿下坠 + 低频烟雾闷响
    layers: [
      noise(0.22, 0.3, { filter: { type: 'highpass', freq: 1800 } }),
      tone('sawtooth', 320, 0.4, 0.3, { glideTo: 55 }),
      noise(0.35, 0.2, { delay: 0.05, filter: { type: 'lowpass', freq: 350 } }),
    ],
    extras: [tone('square', 110, 0.15, 0.1, { delay: 0.18 })],
  }),

  ATTACK_DECLARED: () => ({
    // 蓄力结束（0.16s）起冲刺破空 → 0.32s 命中（弹冲段 p>0.45 的冲击帧附近）
    layers: [
      noise(0.18, 0.2, { delay: 0.15, filter: { type: 'bandpass', freq: 700, sweepTo: 2000, q: 1 } }),
      noise(0.14, 0.55, { delay: 0.32, filter: { type: 'lowpass', freq: 900 } }),
      tone('sine', 95, 0.2, 0.6, { glideTo: 38, delay: 0.32 }),
    ],
    extras: [tone('square', 1400, 0.06, 0.12, { delay: 0.33 })],
  }),

  DAMAGE_DEALT: (ev) => {
    if (ev.shieldConsumed) {
      // 三年质保生效：金属铭牌叮响 + 高频碎裂（对齐金色涟漪 + 质保碎裂横幅）
      return {
        layers: [
          tone('sine', 880, 0.5, 0.3, { attack: 0.002 }),
          tone('sine', 1318.51, 0.4, 0.2, { delay: 0.01, attack: 0.002 }),
          noise(0.2, 0.2, { delay: 0.02, filter: { type: 'highpass', freq: 2500 } }),
        ],
        extras: [tone('sine', 1760, 0.3, 0.08, { delay: 0.05 })],
      }
    }
    if (ev.armorAbsorbed !== undefined && ev.armorAbsorbed > 0) {
      // 护甲格挡：钝金属闷磕（对齐灰白小涟漪，明显弱于直伤）
      return {
        layers: [
          tone('sine', 220, 0.12, 0.3, { glideTo: 180 }),
          noise(0.08, 0.2, { filter: { type: 'bandpass', freq: 500 } }),
        ],
      }
    }
    // 直伤：皮肉闷击（红飘字同帧）
    return {
      layers: [
        tone('sine', 140, 0.16, 0.5, { glideTo: 60 }),
        noise(0.1, 0.3, { filter: { type: 'lowpass', freq: 800 } }),
      ],
      extras: [tone('triangle', 280, 0.1, 0.12, { glideTo: 140 })],
    }
  },

  HEALING: () => ({
    // 回血：温柔的升调双音 + 气泡感高频噪声
    layers: [
      tone('sine', 523.25, 0.18, 0.2, { attack: 0.01 }),
      tone('sine', 659.26, 0.22, 0.2, { delay: 0.09, attack: 0.01 }),
    ],
    extras: [
      tone('sine', 783.99, 0.25, 0.12, { delay: 0.18, attack: 0.01 }),
      noise(0.15, 0.05, { filter: { type: 'highpass', freq: 5000 } }),
    ],
  }),

  KEYWORD_TRIGGERED: (ev) => {
    if (ev.detail === RAY_TRACING_FAIL_DETAIL) {
      // 开光追失败：功率骤降 + 电流嗡鸣（对齐红色电弧抽搐，「无事发生」）
      return {
        layers: [
          tone('sawtooth', 320, 0.55, 0.35, { glideTo: 50 }),
          noise(0.3, 0.2, { filter: { type: 'lowpass', freq: 500 } }),
          tone('square', 55, 0.3, 0.15, { delay: 0.05 }),
        ],
        extras: [tone('square', 1200, 0.04, 0.1, { delay: 0.1 })],
      }
    }
    // 关键词生效：金色钟鸣（脉冲 + 金色迸发同帧）
    return {
      layers: [
        tone('triangle', 987.77, 0.3, 0.28),
        tone('sine', 1484.98, 0.25, 0.12, { delay: 0.03 }),
      ],
      extras: [tone('sine', 1975.53, 0.2, 0.06, { delay: 0.06 })],
    }
  },

  HERO_POWER_USED: (ev) => {
    // 通用激活底噪（按技能名分流前先给「按下去了」的气声）
    const base: SoundSpec = { layers: [noise(0.12, 0.15, { filter: { type: 'bandpass', freq: 1200 } })] }
    const factionLayers: SoundLayer[] = []
    const extras: SoundLayer[] = []
    switch (SKILL_FACTION[ev.skillId]) {
      case 'nvidia':
        factionLayers.push(tone('triangle', 660, 0.24, 0.25, { glideTo: 990, delay: 0.02 }))
        extras.push(tone('sine', 1320, 0.15, 0.08, { delay: 0.1 }))
        break
      case 'amd':
        factionLayers.push(tone('sawtooth', 220, 0.26, 0.3, { glideTo: 330, delay: 0.02 }))
        factionLayers.push(tone('square', 55, 0.2, 0.14, { delay: 0.04 }))
        extras.push(noise(0.15, 0.1, { delay: 0.06, filter: { type: 'highpass', freq: 1500 } }))
        break
      case 'intel':
        // 驱动更新：22% → 67% → 99% 三连升调（对齐分段进度条）
        factionLayers.push(
          tone('sine', 493.88, 0.09, 0.2, { delay: 0.02 }),
          tone('sine', 739.99, 0.09, 0.2, { delay: 0.14 }),
          tone('sine', 987.77, 0.2, 0.22, { delay: 0.26 }),
        )
        break
      case 'neutral':
        factionLayers.push(noise(0.3, 0.22, { delay: 0.02, filter: { type: 'highpass', freq: 2800 } }))
        factionLayers.push(tone('sine', 329.63, 0.2, 0.1, { delay: 0.05 }))
        break
      case 'apple':
        factionLayers.push(
          tone('sine', 523.25, 0.3, 0.2, { attack: 0.02 }),
          tone('sine', 659.26, 0.3, 0.14, { delay: 0.03, attack: 0.02 }),
        )
        extras.push(tone('sine', 1046.5, 0.2, 0.06, { delay: 0.1 }))
        break
      case 'qualcomm':
        // TOPS 营销：数字蹦跳琶音
        factionLayers.push(
          tone('sine', 587.33, 0.08, 0.2),
          tone('sine', 880, 0.08, 0.2, { delay: 0.06 }),
          tone('sine', 1174.66, 0.14, 0.22, { delay: 0.12 }),
        )
        extras.push(tone('sine', 1760, 0.1, 0.08, { delay: 0.18 }))
        break
      case 'arm':
        factionLayers.push(tone('sine', 660, 0.4, 0.24, { glideTo: 330, delay: 0.02, attack: 0.01 }))
        factionLayers.push(noise(0.25, 0.1, { delay: 0.05, filter: { type: 'bandpass', freq: 900 } }))
        break
      default:
        // 未知技能（mod）：通用激活音，绝不让技能哑火
        factionLayers.push(tone('triangle', 587.33, 0.2, 0.22, { delay: 0.02 }))
        break
    }
    return { layers: [...base.layers, ...factionLayers], extras }
  },

  FATIGUE: () => ({
    // 疲劳掉血：低频警号下滑 + 沉闷抽气（红闪同帧）
    layers: [
      tone('sine', 130, 0.45, 0.4, { glideTo: 96 }),
      noise(0.3, 0.15, { delay: 0.05, filter: { type: 'lowpass', freq: 300 } }),
    ],
    extras: [tone('sawtooth', 65, 0.4, 0.12, { delay: 0.1 })],
  }),

  BURN_OUT: () => ({
    // 跳闸：两道电击 zap（对齐黄色两连闪屏）+ 功率骤降 + 保险丝闷响
    layers: [
      tone('square', 1800, 0.1, 0.5, { glideTo: 90 }),
      tone('square', 1500, 0.1, 0.45, { glideTo: 80, delay: 0.14 }),
      tone('sawtooth', 420, 0.6, 0.4, { glideTo: 45, delay: 0.1 }),
      tone('sine', 70, 0.3, 0.5, { glideTo: 35, delay: 0.2 }),
    ],
    extras: [noise(0.12, 0.15, { filter: { type: 'highpass', freq: 4000 } })],
  }),

  ARMOR_GAINED: () => ({
    // 护甲上装：金属滑套 + 卡扣叮响（对齐灰白涟漪 + 上浮粒子）
    layers: [
      noise(0.28, 0.2, { filter: { type: 'bandpass', freq: 700 } }),
      tone('sine', 440, 0.22, 0.22, { glideTo: 392, delay: 0.06 }),
    ],
    extras: [tone('sine', 880, 0.15, 0.08, { delay: 0.08 })],
  }),

  GAME_END: (ev, viewer) => {
    if (ev.winner !== null && ev.winner === viewer) {
      // 胜利：四音上行号角（结算机位推进时起奏）
      return {
        layers: [
          tone('sine', 523.25, 0.16, 0.3),
          tone('sine', 659.26, 0.16, 0.3, { delay: 0.14 }),
          tone('sine', 783.99, 0.16, 0.3, { delay: 0.28 }),
          tone('sine', 1046.5, 0.5, 0.32, { delay: 0.42 }),
        ],
        extras: [tone('triangle', 1567.98, 0.4, 0.1, { delay: 0.42 })],
      }
    }
    if (ev.winner !== null) {
      // 败北：下滑的挽歌双音
      return {
        layers: [
          tone('sawtooth', 220, 0.5, 0.3, { glideTo: 110 }),
          tone('sine', 164.81, 0.7, 0.3, { glideTo: 82.41, delay: 0.15 }),
        ],
        extras: [tone('square', 110, 0.3, 0.08, { delay: 0.3 })],
      }
    }
    // 平局：两记中性闷响（双双烧毁的「握手言和」）
    return {
      layers: [tone('sine', 261.63, 0.25, 0.25), tone('sine', 261.63, 0.25, 0.25, { delay: 0.3 })],
    }
  },
}

/** 事件 → 音效（映射表唯一入口；类型层保证 17/17，此处一次受控断言收口） */
export function resolveEventSound(event: GameEvent, viewer: PlayerId = 'P1'): SoundSpec {
  const entry = eventSoundMap[event.type] as (ev: GameEvent, viewer: PlayerId) => SoundSpec
  return entry(event, viewer)
}
