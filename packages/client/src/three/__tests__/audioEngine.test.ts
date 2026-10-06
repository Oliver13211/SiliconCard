/**
 * M4-SND1 无头测试：音效引擎（Synth/BGM/AudioDirector）工程性硬约束。
 *
 * A 组降级路径：node/无 WebAudio 环境（默认无 window）下全接口调用绝不抛，
 * isAvailable=false，一切播放退化为 no-op——「绝不崩」的验收；
 * B 组 mock AudioContext：节点创建/停振/断链（用完即释放）、voice 上限保护、
 * 自动播放策略解锁、extras 装饰层的质量门、设置到总线的生效路径；
 * C 组 BGM：pad 节点生命周期、节拍前瞻调度、low 档只留 pad、停播清理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameEvent } from '@siliconcard/core'
import { BgmController } from '../audio/bgm'
import { createAudioDirector, getAudioDirector, initAudio, resetAudioForTests } from '../audio/director'
import { MAX_VOICES, Synth } from '../audio/synth'
import { tone } from '../audio/spec'
import { setEffectQuality } from '../fx/quality'

// —— mock AudioContext（最小录音 stub：记录创建/调度/断链，不出声） ——

class MockParam {
  value = 0
  setValueAtTime(v: number): void {
    this.value = v
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v
  }
  exponentialRampToValueAtTime(v: number): void {
    this.value = v
  }
  setTargetAtTime(v: number): void {
    this.value = v
  }
  cancelScheduledValues(): void {}
}

class MockNode {
  disconnectCalls = 0
  connect(_node: MockNode): MockNode {
    return _node
  }
  disconnect(): void {
    this.disconnectCalls += 1
  }
}

/** stop() 是否同步触发 onended（用完即释放路径可测；false 时 voice 挂起模拟洪峰） */
let autoEndOnStop = true

class MockOsc extends MockNode {
  type: OscillatorType = 'sine'
  frequency = new MockParam()
  detune = new MockParam()
  onended: ((event: Event) => void) | null = null
  startAt: number | null = null
  stopAt: number | null = null
  start(when?: number): void {
    this.startAt = when ?? null
  }
  stop(when?: number): void {
    this.stopAt = when ?? null
    if (autoEndOnStop) this.onended?.(new Event('ended'))
  }
}

class MockBufferSource extends MockNode {
  buffer: { duration: number } | null = null
  onended: ((event: Event) => void) | null = null
  startAt: number | null = null
  start(when?: number): void {
    this.startAt = when ?? null
  }
  stop(): void {
    if (autoEndOnStop) this.onended?.(new Event('ended'))
  }
}

class MockFilter extends MockNode {
  type: BiquadFilterType = 'lowpass'
  frequency = new MockParam()
  Q = new MockParam()
}

class MockGain extends MockNode {
  gain = new MockParam()
}

class MockAudioContext {
  destination = new MockNode()
  currentTime = 0
  state: AudioContextState = 'running'
  sampleRate = 48000
  readonly oscs: MockOsc[] = []
  readonly gains: MockGain[] = []
  readonly sources: MockBufferSource[] = []
  readonly filters: MockFilter[] = []
  resume = vi.fn(() => Promise.resolve())
  suspend = vi.fn(() => Promise.resolve())
  close = vi.fn(() => Promise.resolve())

  createOscillator(): MockOsc {
    const osc = new MockOsc()
    this.oscs.push(osc)
    return osc
  }
  createGain(): MockGain {
    const gain = new MockGain()
    this.gains.push(gain)
    return gain
  }
  createBufferSource(): MockBufferSource {
    const src = new MockBufferSource()
    this.sources.push(src)
    return src
  }
  createBiquadFilter(): MockFilter {
    const filter = new MockFilter()
    this.filters.push(filter)
    return filter
  }
  createBuffer(_channels: number, length: number, rate: number): { duration: number; getChannelData(i: number): Float32Array } {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) }
  }
}

function asCtx(mock: MockAudioContext): AudioContext {
  return mock as unknown as AudioContext
}

const TONE = tone('sine', 440, 0.1, 0.5)

beforeEach(() => {
  autoEndOnStop = true
  setEffectQuality('high')
})

afterEach(() => {
  vi.useRealTimers()
  setEffectQuality('high')
})

describe('A 组：不可用环境静默降级（node / 无 WebAudio）', () => {
  it('Synth 默认构造（node 无 window.AudioContext）：available=false，播放 no-op 不抛', () => {
    const synth = new Synth()
    expect(synth.available).toBe(false)
    expect(synth.context).toBeNull()
    expect(() => synth.play({ layers: [TONE] })).not.toThrow()
    expect(() => synth.scheduleLayer(TONE, 0, new MockNode() as unknown as AudioNode)).not.toThrow()
    expect(() => synth.unlock()).not.toThrow()
    expect(() => synth.suspend()).not.toThrow()
    expect(() => synth.resume()).not.toThrow()
    expect(() => synth.close()).not.toThrow()
  })

  it('工厂显式返回 null / 构造抛异常 → 同样降级且结论缓存', () => {
    const nullSynth = new Synth({ ctxFactory: () => null })
    expect(nullSynth.available).toBe(false)

    let calls = 0
    const boomSynth = new Synth({
      ctxFactory: () => {
        calls += 1
        throw new Error('no audio hardware')
      },
    })
    expect(boomSynth.available).toBe(false)
    expect(boomSynth.available).toBe(false) // 再探测
    expect(boomSynth.available).toBe(false)
    expect(calls).toBe(1) // 失败结论缓存，不反复轰炸
    expect(() => boomSynth.play({ layers: [TONE] })).not.toThrow()
  })

  it('Director 全接口在降级环境下调用不抛（含完整 17 事件批与 UI 音）', () => {
    const director = createAudioDirector()
    expect(director.isAvailable()).toBe(false)
    expect(() => {
      director.start({ getViewer: () => 'P1', subscribeEvents: () => () => {} })
      director.setBattleActive(true)
      director.setSettings({ muted: true, volume: 0.5, bgmEnabled: false })
      director.playEvents(
        [
          { type: 'GAME_START', seed: 1, firstPlayer: 'P1' },
          { type: 'ATTACK_DECLARED', attackerId: 'i1', target: { kind: 'unit', instanceId: 'i2' } },
          { type: 'GAME_END', winner: null, reason: 'health_zero' },
        ] satisfies GameEvent[],
        'P1',
      )
      director.uiClick()
      director.unlock()
      director.setBattleActive(false)
      director.stop()
    }).not.toThrow()
  })
})

describe('B 组：Synth 节点纪律与解锁（mock AudioContext）', () => {
  it('播放 tone：创建振荡器与增益，stop 调度在 dur 之后，onended 断链（用完即释放）', () => {
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    synth.play({ layers: [TONE] })
    expect(mock.oscs).toHaveLength(1)
    expect(mock.gains.length).toBeGreaterThanOrEqual(4) // 总线 3 + 本层 1
    const osc = mock.oscs[0]!
    expect(osc.startAt).not.toBeNull()
    expect(osc.stopAt).not.toBeNull()
    expect(osc.disconnectCalls).toBe(1) // 自动 onended → 已断链
    expect(osc.frequency.value).toBe(440)
  })

  it('播放 noise：复用共享缓冲（池化），源与滤波断链', () => {
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    synth.play({ layers: [{ kind: 'noise', dur: 0.2, gain: 0.3, filter: { type: 'highpass', freq: 2000 } }] })
    expect(mock.sources).toHaveLength(1)
    expect(mock.filters).toHaveLength(1)
    expect(mock.sources[0]!.disconnectCalls).toBe(1)
    expect(mock.filters[0]!.disconnectCalls).toBe(1)
    expect(mock.sources[0]!.buffer).not.toBeNull()
  })

  it('voice 上限：洪峰下拒绝新 voice（保护主线程与耳朵）', () => {
    autoEndOnStop = false // onended 永不触发 → voice 挂起累积
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    for (let i = 0; i < MAX_VOICES + 10; i += 1) synth.play({ layers: [TONE] })
    expect(mock.oscs).toHaveLength(MAX_VOICES)
  })

  it('unlock：suspended 时 resume（自动播放策略），running 时幂等不重复', () => {
    const mock = new MockAudioContext()
    mock.state = 'suspended'
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    synth.unlock()
    expect(mock.resume).toHaveBeenCalledTimes(1)
    mock.state = 'running'
    synth.unlock()
    expect(mock.resume).toHaveBeenCalledTimes(1)
  })

  it('extras 装饰层受质量门控制：low 档跳过、high 档播放（关键音层永远保留）', () => {
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    const spec = { layers: [TONE], extras: [tone('sine', 880, 0.1, 0.1)] }
    setEffectQuality('low')
    synth.play(spec)
    expect(mock.oscs).toHaveLength(1)
    setEffectQuality('high')
    synth.play(spec)
    expect(mock.oscs).toHaveLength(3)
  })

  it('设置生效：muted → 主总线 0；volume 映射主总线；bgmEnabled → BGM 总线开关', () => {
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    expect(synth.available).toBe(true) // 触发惰性创建与总线搭建
    // buildBuses 先建 3 条总线：master(0) / sfx(1) / music(2)
    expect(mock.gains.length).toBe(3)
    synth.applySettings({ muted: false, volume: 0.5, musicOn: true })
    expect(mock.gains[0]!.gain.value).toBe(0.5)
    expect(mock.gains[2]!.gain.value).toBe(1)
    synth.applySettings({ muted: true, volume: 0.5, musicOn: false })
    expect(mock.gains[0]!.gain.value).toBe(0)
    expect(mock.gains[2]!.gain.value).toBe(0)
  })
})

describe('B 组：Director 接线（事件源 / 设置 / 清理）', () => {
  it('wiring 事件批 → 逐事件路由出声；stop 解订', () => {
    const mock = new MockAudioContext()
    const director = createAudioDirector({ ctxFactory: () => asCtx(mock) })
    let captured: ((events: readonly GameEvent[]) => void) | null = null
    let unsubCalls = 0
    director.start({
      getViewer: () => 'P1',
      subscribeEvents: (cb) => {
        captured = cb
        return () => {
          unsubCalls += 1
        }
      },
    })
    const before = mock.oscs.length
    expect(captured).not.toBeNull() // start 已挂上订阅
    captured!([{ type: 'GAME_START', seed: 1, firstPlayer: 'P1' }])
    expect(mock.oscs.length).toBeGreaterThan(before)
    director.stop()
    expect(unsubCalls).toBe(1)
  })

  it('单条事件音失败不炸同批后续（逐条吞错并 console.error）', () => {
    const mock = new MockAudioContext()
    const director = createAudioDirector({ ctxFactory: () => asCtx(mock) })
    // 注入故障：第 6 个振荡器创建时抛（GAME_START 每条 4 只 osc → 第 1 条成功、第 2 条中途炸）
    let oscCreations = 0
    const originalCreateOsc = mock.createOscillator.bind(mock)
    mock.createOscillator = () => {
      oscCreations += 1
      if (oscCreations === 6) throw new Error('node budget exhausted')
      return originalCreateOsc()
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const batch = [
      { type: 'GAME_START', seed: 1, firstPlayer: 'P1' },
      { type: 'GAME_START', seed: 2, firstPlayer: 'P1' },
    ] satisfies GameEvent[]
    expect(() => director.playEvents(batch, 'P1')).not.toThrow()
    expect(errSpy).toHaveBeenCalledTimes(1) // 只吞第 2 条的错
    expect(errSpy.mock.calls[0]?.[1]).toBe('GAME_START')
    errSpy.mockRestore()
  })

  it('设置与查询：setSettings 生效快照，创建时读持久化（node 下为默认）', () => {
    const mock = new MockAudioContext()
    const director = createAudioDirector({ ctxFactory: () => asCtx(mock) })
    director.setSettings({ muted: true, volume: 0.25, bgmEnabled: false })
    expect(director.getSettings()).toEqual({ muted: true, volume: 0.25, bgmEnabled: false })
  })

  it('initAudio 单例：复挂复用实例，reset 后为 null', () => {
    resetAudioForTests()
    expect(getAudioDirector()).toBeNull()
    const cleanup = initAudio({ getViewer: () => 'P1', subscribeEvents: () => () => {} })
    const first = getAudioDirector()
    expect(first).not.toBeNull()
    const cleanup2 = initAudio({ getViewer: () => 'P1', subscribeEvents: () => () => {} })
    expect(getAudioDirector()).toBe(first) // 复用单例，不叠加 AudioContext
    cleanup()
    cleanup2()
    resetAudioForTests()
    expect(getAudioDirector()).toBeNull()
  })
})

describe('C 组：BGM（pad 生命周期 / 前瞻节拍 / 质量门）', () => {
  it('start：pad 三只振荡器 + LFO + 低通，接入 musicBus；stop：停振且清调度器', () => {
    vi.useFakeTimers()
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    const bgm = new BgmController(synth)
    expect(bgm.isRunning).toBe(false)

    bgm.start()
    expect(bgm.isRunning).toBe(true)
    expect(mock.oscs).toHaveLength(4) // pad ×3 + LFO
    expect(mock.filters).toHaveLength(1)
    const started = mock.oscs.length
    // 时钟推进 + 调度 tick → 节拍落入前瞻窗口（沙锤每拍、底鼓每 4 拍）
    mock.currentTime = 1.2
    vi.advanceTimersByTime(250)
    expect(mock.oscs.length).toBeGreaterThan(started)

    bgm.stop()
    expect(bgm.isRunning).toBe(false)
    const afterStop = mock.oscs.length
    mock.currentTime = 3.0
    vi.advanceTimersByTime(500)
    expect(mock.oscs.length).toBe(afterStop) // 调度器已清，无悬挂排程
  })

  it('start 幂等：重复 start 不叠加节点', () => {
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    const bgm = new BgmController(synth)
    bgm.start()
    bgm.start()
    expect(mock.oscs).toHaveLength(4)
  })

  it('不可用时 start no-op（node 降级）', () => {
    const synth = new Synth({ ctxFactory: () => null })
    const bgm = new BgmController(synth)
    expect(() => bgm.start()).not.toThrow()
    expect(bgm.isRunning).toBe(false)
    expect(() => bgm.stop()).not.toThrow()
  })

  it('low 质量档：只留 pad，节拍调度器整层关闭（减 BGM 层）', () => {
    vi.useFakeTimers()
    setEffectQuality('low')
    const mock = new MockAudioContext()
    const synth = new Synth({ ctxFactory: () => asCtx(mock) })
    const bgm = new BgmController(synth)
    bgm.start()
    expect(mock.oscs).toHaveLength(4) // pad + LFO，无节拍
    const count = mock.oscs.length
    mock.currentTime = 2.0
    vi.advanceTimersByTime(500)
    expect(mock.oscs.length).toBe(count) // 无节拍振荡器产生
    bgm.stop()
  })

  it('Director 对局门：setBattleActive(true) 起播 / (false) 停播（对局内循环、菜单静）', () => {
    const mock = new MockAudioContext()
    const director = createAudioDirector({ ctxFactory: () => asCtx(mock) })
    director.setBattleActive(true)
    expect(mock.oscs.length).toBe(4) // pad + LFO 已起
    director.setBattleActive(false)
    expect(mock.oscs[0]?.stopAt).not.toBeNull() // pad 已排停振
  })
})
