/**
 * 全屏演出层（演出修正阶段一，需求 3）：强力时刻（高费入场 / 传说入场 /
 * 大额一次伤害 / AOE 批次）的屏幕级反馈。
 *
 * 实现取舍（汇报要点）：挂在相机下的全屏 quad 组合，而非 EffectComposer 后处理、
 * 也非 DOM overlay——
 * - 后处理管线（EffectComposer + ShaderPass）要替换现有直绘渲染流程并新增
 *   render target 开销，中端核显预算下不值得，且 low 质量档难以平滑降级；
 * - DOM overlay 无法与 WebGL 相机（含镜头微震 rig）同帧对齐，冲击波「从画面
 *   中心扩散」的纵深感也做不出来；
 * - 相机子节点 quad 零新增依赖、单 draw call 量级、快进/降级模型与既有
 *   ScreenFlash 完全一致。
 *
 * 组成（一次 fire 全部生效，短促有劲、不白屏闪瞎）：
 * - wave     屏幕中心扩散的加色冲击环（0.45s 扩到满屏，先快后慢）；
 * - chroma   红/青两片错位加色 quad 快速归位 —— 色偏一瞬（伪色差，~0.22s）；
 * - tint     极低峰值的染色 wash（峰值 0.18·强度，峰值一瞬即回落，不遮画面）；
 * - vignette 径向渐变暗角脉冲（快起缓收，压暗四角聚拢视线）。
 *
 * 与镜头微震的协调：本层只做屏幕级效果，不碰相机变换；震感仍由事件映射经
 * ctx.shakeCamera 注入 CameraShaker（trauma² 模型），两者叠加不打架。
 *
 * 性能红线：单实例池化复用（重入 fire 即重启），update 零分配；
 * 暗角纹理程序化生成（document 守卫，无 DOM 环境降级为素色 quad，可无头测试）。
 */

import * as THREE from 'three'

let vignetteTexture: THREE.CanvasTexture | null = null

/** 暗角纹理：中心全透明 → 四角近黑的径向渐变（程序化，零外部资产） */
function getVignetteTexture(): THREE.CanvasTexture | null {
  if (vignetteTexture) return vignetteTexture
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 182)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.55, 'rgba(0,0,0,0.3)')
  g.addColorStop(1, 'rgba(0,0,0,0.96)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  vignetteTexture = new THREE.CanvasTexture(canvas)
  return vignetteTexture
}

/** 冲击环扩散终点（z=-1.3 处 fov45 全屏高约 1.08，宽按 21:9 约 2.5；半径 3.4 必满屏） */
const WAVE_MAX_SCALE = 3.4
/** 色偏归位时长（秒）：一瞬即回 */
const CHROMA_DURATION = 0.22
/** 色偏最大错位（世界单位，z=-1.3 平面上） */
const CHROMA_OFFSET = 0.085

export class ScreenImpactFx {
  readonly group = new THREE.Group()
  private readonly wave: THREE.Mesh
  private readonly waveMat: THREE.MeshBasicMaterial
  private readonly tint: THREE.Mesh
  private readonly tintMat: THREE.MeshBasicMaterial
  private readonly chromaA: THREE.Mesh
  private readonly chromaB: THREE.Mesh
  private readonly chromaMatA: THREE.MeshBasicMaterial
  private readonly chromaMatB: THREE.MeshBasicMaterial
  private readonly vignette: THREE.Mesh
  private readonly vignetteMat: THREE.MeshBasicMaterial
  private age = 0
  private duration = 0.5
  private intensity = 1
  private active = false

  constructor(camera: THREE.Camera) {
    this.group.position.set(0, 0, -1.3)

    // 冲击环：加色扩散（渲染序最高，压过闪屏）
    this.waveMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.wave = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), this.waveMat)
    this.wave.renderOrder = 41
    this.wave.visible = false

    // 染色 wash：极低峰值的一瞬（非白屏闪光）
    this.tintMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.tint = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.5), this.tintMat)
    this.tint.renderOrder = 42
    this.tint.visible = false

    // 伪色差：红 / 青两片错位加色 quad，fire 后快速归位
    this.chromaMatA = new THREE.MeshBasicMaterial({
      color: '#ff2d3c',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.chromaMatB = new THREE.MeshBasicMaterial({
      color: '#23e0ff',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.chromaA = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.5), this.chromaMatA)
    this.chromaB = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.5), this.chromaMatB)
    this.chromaA.renderOrder = 43
    this.chromaB.renderOrder = 43
    this.chromaA.visible = false
    this.chromaB.visible = false

    // 暗角：法向混合压暗四角（低于 ScreenFlash 的 40，不遮挡既有闪屏语义）
    this.vignetteMat = new THREE.MeshBasicMaterial({
      color: '#000000',
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      map: getVignetteTexture(),
    })
    this.vignette = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.6), this.vignetteMat)
    this.vignette.renderOrder = 39
    this.vignette.visible = false

    this.group.add(this.vignette, this.wave, this.tint, this.chromaA, this.chromaB)
    this.group.visible = false
    camera.add(this.group)
  }

  /** 触发一次全屏演出（重入即重启；intensity 0.6~1.3，钳制防过曝） */
  fire(color: string, intensity = 1): void {
    const i = Math.min(1.3, Math.max(0.6, intensity))
    this.intensity = i
    this.age = 0
    this.duration = 0.5
    this.active = true
    this.group.visible = true
    this.waveMat.color.set(color)
    this.tintMat.color.set(color)
    this.wave.scale.setScalar(0.12)
    this.chromaA.position.x = -CHROMA_OFFSET * i
    this.chromaB.position.x = CHROMA_OFFSET * i
    // 触发帧即建立完整视觉态（首个 update 前渲染也不黑屏）；暗角走 0.08s 快起
    this.waveMat.opacity = 0.85
    this.tintMat.opacity = 0.18 * i
    this.chromaMatA.opacity = 0.42 * i
    this.chromaMatB.opacity = 0.42 * i
    this.vignetteMat.opacity = 0
    this.wave.visible = true
    this.tint.visible = true
    this.chromaA.visible = true
    this.chromaB.visible = true
    this.vignette.visible = true
  }

  update(dt: number): void {
    if (!this.active) return
    this.age += dt
    const p = this.age / this.duration
    if (p >= 1) {
      this.finishAll()
      return
    }
    // 冲击环：先快后慢扩到满屏，线性熄灭
    const ease = 1 - (1 - p) ** 2
    this.wave.scale.setScalar(0.12 + (WAVE_MAX_SCALE - 0.12) * ease)
    this.waveMat.opacity = 0.85 * (1 - p)
    // 染色 wash：一瞬即落（不遮画面）
    this.tintMat.opacity = 0.18 * this.intensity * (1 - p) ** 2
    // 色偏：错位与亮度同步归位（0.22s 内结束）
    const cp = Math.min(1, this.age / CHROMA_DURATION)
    const off = CHROMA_OFFSET * this.intensity * (1 - cp) ** 2
    this.chromaA.position.x = -off
    this.chromaB.position.x = off
    this.chromaMatA.opacity = 0.42 * this.intensity * (1 - cp)
    this.chromaMatB.opacity = 0.42 * this.intensity * (1 - cp)
    // 暗角：快起（0.08s）缓收（随整体时长衰减）
    const attack = Math.min(1, this.age / 0.08)
    this.vignetteMat.opacity = 0.72 * this.intensity * attack * (1 - p)
  }

  get activeCount(): number {
    return this.active ? 1 : 0
  }

  /** 快进：立即清场 */
  finishAll(): void {
    this.active = false
    this.age = 0
    this.group.visible = false
    this.wave.visible = false
    this.tint.visible = false
    this.chromaA.visible = false
    this.chromaB.visible = false
    this.vignette.visible = false
    this.waveMat.opacity = 0
    this.tintMat.opacity = 0
    this.chromaMatA.opacity = 0
    this.chromaMatB.opacity = 0
    this.vignetteMat.opacity = 0
  }

  dispose(): void {
    this.finishAll()
    this.wave.geometry.dispose()
    this.tint.geometry.dispose()
    this.chromaA.geometry.dispose()
    this.chromaB.geometry.dispose()
    this.vignette.geometry.dispose()
    this.waveMat.dispose()
    this.tintMat.dispose()
    this.chromaMatA.dispose()
    this.chromaMatB.dispose()
    this.vignetteMat.dispose()
    this.group.removeFromParent()
  }
}
