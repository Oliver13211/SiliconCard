/**
 * 音效描述符（M4-SND1）——事件音与 BGM 共用的纯数据格式。
 *
 * 设计对齐演出线：eventAnimationMap 用「映射表 + play(ctx)」描述动画，
 * 音效线用「映射表 + SoundSpec 描述符」描述声音。描述符是纯数据（零 Web Audio
 * 依赖），因此 soundMap 与校验逻辑可无头测试；真正的节点创建只在 synth.ts
 * 解释层发生（振荡器 + 噪声缓冲 + 包络，零音频资产、零外部依赖、零网络请求）。
 *
 * 音色词汇表：
 * - tone  振荡器层：波形 + 频率（可滑音）+ 包络（attack → 峰值 → 指数衰减）
 * - noise 噪声层：共享白噪声缓冲切片 + 可选滤波器（可扫频）
 * - delay 起始偏移——用于把命中音压到视觉冲击帧附近（音画同拍）
 * - extras 装饰层：low 质量档跳过（fx/quality 的 audioExtras 门），关键音层永远保留
 */

/** 波形（DOM OscillatorType 的同形别名，保持 spec 层可读性） */
export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle'

export interface ToneLayerSpec {
  kind: 'tone'
  wave: Waveform
  /** 起始频率 Hz（20..8000） */
  freq: number
  /** 终点频率 Hz（滑音；缺省不振荡） */
  glideTo?: number
  /** 总时长秒（含衰减尾） */
  dur: number
  /** 峰值增益 0..1（总线再乘主音量；>0.6 视为重音，慎用） */
  gain: number
  /** 起始偏移秒（音画同拍的关键参数） */
  delay?: number
  /** attack 秒（默认 0.004：近乎瞬态） */
  attack?: number
  /** detune 音分（默认 0） */
  detune?: number
}

export interface NoiseLayerSpec {
  kind: 'noise'
  dur: number
  gain: number
  delay?: number
  attack?: number
  /** 可选滤波；sweepTo 为截止频率扫频终点 */
  filter?: { type: 'lowpass' | 'highpass' | 'bandpass'; freq: number; q?: number; sweepTo?: number }
}

export type SoundLayer = ToneLayerSpec | NoiseLayerSpec

export interface SoundSpec {
  /** 主音层（任何质量档都播——关键事件音保留的「关键」部分） */
  layers: readonly SoundLayer[]
  /** 装饰层（low 档经 fxEnabled('audioExtras') 门跳过） */
  extras?: readonly SoundLayer[]
}

/** tone 层快捷构建器（soundMap 里保持配方一眼可读） */
export function tone(
  wave: Waveform,
  freq: number,
  dur: number,
  gain: number,
  opts: Partial<Pick<ToneLayerSpec, 'glideTo' | 'delay' | 'attack' | 'detune'>> = {},
): ToneLayerSpec {
  return { kind: 'tone', wave, freq, dur, gain, ...opts }
}

/** noise 层快捷构建器 */
export function noise(
  dur: number,
  gain: number,
  opts: Partial<Pick<NoiseLayerSpec, 'delay' | 'attack' | 'filter'>> = {},
): NoiseLayerSpec {
  return { kind: 'noise', dur, gain, ...opts }
}

const FREQ_MIN = 20
const FREQ_MAX = 8000
const DUR_MAX = 4
const DELAY_MAX = 3

/** 层级合法性检查（测试与调试用；非法层由解释层兜底钳制，不抛） */
export function layerProblems(layer: SoundLayer): string[] {
  const problems: string[] = []
  const label = `${layer.kind}@${layer.delay ?? 0}s`
  if (!(layer.dur > 0) || layer.dur > DUR_MAX) problems.push(`${label} dur=${layer.dur} 越界`)
  if (!(layer.gain > 0) || layer.gain > 1) problems.push(`${label} gain=${layer.gain} 越界`)
  if ((layer.delay ?? 0) < 0 || (layer.delay ?? 0) > DELAY_MAX) problems.push(`${label} delay 越界`)
  if (layer.kind === 'tone') {
    for (const f of [layer.freq, layer.glideTo]) {
      if (f === undefined) continue
      if (f < FREQ_MIN || f > FREQ_MAX) problems.push(`${label} freq=${f} 越界`)
    }
  }
  if (layer.kind === 'noise' && layer.filter) {
    if (layer.filter.freq <= 0 || (layer.filter.sweepTo ?? 1) <= 0) problems.push(`${label} 滤波频率非法`)
  }
  return problems
}

/** 整条 spec 的合法性检查（空 spec 视为非法——17 事件不允许哑音条目） */
export function specProblems(spec: SoundSpec): string[] {
  if (spec.layers.length === 0) return ['spec 无任何主音层（事件音不允许哑音）']
  return [...spec.layers, ...(spec.extras ?? [])].flatMap(layerProblems)
}
