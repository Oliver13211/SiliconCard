/**
 * 声音控制组（M4-SND1）——HUD 上的最小混音面：主音量（滑条 + 静音）与 BGM 开关。
 * 状态经 useAudioStore 同步引擎与 localStorage；首次出声仍需用户手势解锁
 * （浏览器自动播放策略，任意点击即解锁）。
 */

import { useAudioStore } from '../store/audioStore'

export function AudioControls() {
  const muted = useAudioStore((s) => s.muted)
  const volume = useAudioStore((s) => s.volume)
  const bgmEnabled = useAudioStore((s) => s.bgmEnabled)
  const toggleMuted = useAudioStore((s) => s.toggleMuted)
  const setVolume = useAudioStore((s) => s.setVolume)
  const toggleBgm = useAudioStore((s) => s.toggleBgm)

  return (
    <div className="sc-audio" role="group" aria-label="声音设置">
      <button
        type="button"
        className={`sc-btn sc-btn--small sc-audio-btn${muted ? ' is-off' : ''}`}
        onClick={toggleMuted}
        aria-pressed={!muted}
        title={muted ? '取消静音（主音量）' : '静音全部声音'}
      >
        {muted ? '音效关' : '音效开'}
      </button>
      <input
        type="range"
        className="sc-audio-slider"
        min={0}
        max={100}
        step={5}
        value={Math.round(volume * 100)}
        aria-label="主音量"
        title={`主音量 ${Math.round(volume * 100)}%`}
        onChange={(e) => setVolume(Number(e.target.value) / 100)}
      />
      <button
        type="button"
        className={`sc-btn sc-btn--small sc-audio-btn${bgmEnabled ? '' : ' is-off'}`}
        onClick={toggleBgm}
        aria-pressed={bgmEnabled}
        title={bgmEnabled ? '关闭背景音乐' : '开启背景音乐'}
      >
        BGM{bgmEnabled ? '开' : '关'}
      </button>
    </div>
  )
}
