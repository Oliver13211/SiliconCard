/**
 * @siliconcard/client 渲染线（packages/client/src/three）公开出口。
 *
 * 职责（M1-R3D1..4）：Three.js 3D 牌桌场景、程序化卡面（CanvasTexture）、
 * 卡牌实体与手牌交互、GameEvent → 动画映射。Three 场景独立于 React 树，
 * 经 canvas ref + 本文件导出的 TableRendererHandle 通信（架构铁律）。
 *
 * —— 集成接线（App.tsx / main.tsx 统一接线时照此使用）——
 *
 * ```tsx
 * import { createTableRenderer } from './three'
 *
 * const canvasRef = useRef<HTMLCanvasElement>(null)
 * useEffect(() => {
 *   const handle = createTableRenderer(canvasRef.current!, {
 *     viewer: 'P1',                       // 视角方，默认 P1
 *     getCardDef: (id) => cardRegistry.get(id), // 内容包卡面数据接入
 *   })
 *   handle.syncView(viewFor(state, 'P1'))       // 整帧对账（摆放/数值）
 *   handle.enqueueEvents(events)                // 事件驱动动画（17 事件全覆盖）
 *   handle.fastForward()                        // 可选：跳过演出
 *   handle.setPickCallbacks({                   // raycasting 拾取回调
 *     onHandCardClick: (uid) => {},             // → M1-UI2 出牌流
 *     onUnitClick: (instanceId) => {},
 *     onHeroClick: (playerId) => {},
 *   })
 *   return () => handle.dispose()               // 卸载必调（无泄漏）
 * }, [])
 * ```
 *
 * canvas 需自行铺满容器（如 style={{ width:'100%', height:'100%', display:'block' }}），
 * 内部经 ResizeObserver 适配尺寸。
 */

export { createTableRenderer } from './TableRenderer'
export type {
  TableRendererHandle,
  TableRendererOptions,
  PickCallbacks,
} from './TableRenderer'
export { SceneManager, CameraRig } from './SceneManager'
export type { PickHandlers, Updatable } from './SceneManager'
export { CardEntity, CardEntityPool } from './CardEntity'
export type { PickInfo, Pose } from './CardEntity'
export { HeroPlate } from './HeroPlate'
export { drawCardFace, drawCardBack, resolvePalette, TextureCache, cardFaceCacheKey } from './CardFace'
export { composeCardFaceArt } from './CardFace'
export { deriveFaceArt } from './cardArt/derive'
export type { FaceArtParams, SkeletonKind, MotifKind, RarityTier, KeywordMarkKind } from './cardArt/derive'
export { buildFaceArtSvg, svgToDataUri } from './cardArt/svg'
export { handTransforms, handSlotTransform, handSlotAngle } from './handLayout'
export { eventAnimationMap, KEYWORD_DISPLAY, SKILL_DISPLAY, SKILL_FACTION } from './anim/eventAnimationMap'
export { AnimationDirector } from './anim/AnimationDirector'
export { Timeline, easeOutCubic, easeOutBack, easeOutElastic } from './anim/tween'
export type { EaseFn, TweenStep } from './anim/tween'
export type { AnimationContext, EventAnimation, EventAnimationMap } from './anim/types'
export { setEffectQuality, getEffectQuality, fxEnabled, scaleFxCount } from './fx/quality'
export type { EffectQuality, FxFeature } from './fx/quality'
export { PARTICLE_PRESETS, ParticlePool } from './fx/stageFx'
export type { ParticlePresetName, ParticleEmitSpec } from './fx/stageFx'
export { RingPool, PillarPool, BoltPool, BeamPool, ProgressFx, CameraShaker } from './fx/stageFx'
export { tableThemeFor, mixHex } from './fx/theme'
export type { TableThemeColors } from './fx/theme'
export { CAMERA_SHOTS } from './layout'
export type { CameraShot } from './layout'
export {
  initAudio,
  getAudioDirector,
  createAudioDirector,
  resolveEventSound,
  loadAudioSettings,
  saveAudioSettings,
  DEFAULT_AUDIO_SETTINGS,
  AUDIO_SETTINGS_KEY,
} from './audio'
export type { AudioDirector, AudioWiring, AudioSettings, SoundSpec } from './audio'
