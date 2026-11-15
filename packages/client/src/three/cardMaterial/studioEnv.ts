/**
 * 程序化摄影棚环境贴图（P2-R3D1）—— 一张全局共享，卡牌与牌桌共用（P2-R3D2）。
 *
 * 方案：几块「光带面光源」漂浮在暗环境里的小场景，经 PMREMGenerator 一次性
 * 烘焙成辐射环保SR环境贴图（scene.environment），金属框 / 稀有度框 / 台面 PCB
 * 边框获得真实的方向性反射。禁外部图片资产：光带 = 程序化平面 + 超亮颜色
 * （线性 HDR 值 >1，PMREM 烘焙后即面光源），布局由 studioEnvLayout 纯函数
 * 确定（确定性铁律：无 Math.random / Date）。
 *
 * 生成时机：仅 'materials' 门开启（high 档）时构建一次（SceneManager
 * setMaterialsEnabled），low 档 scene.environment = null（零生成零采样）。
 * 环境小场景的几何/材质在烘焙完成即销毁——只保留烘焙产物 RT。
 */

import * as THREE from 'three'

/** 面光源光带规格（纯数据；坐标系 = 以牌桌中心为原点的摄影棚小场景） */
export interface EnvStripSpec {
  x: number
  y: number
  z: number
  /** 欧拉角（rad）：面片朝向 */
  rotX: number
  rotY: number
  /** 面片尺寸 */
  w: number
  h: number
  /** 光色（hex） */
  color: string
  /** 线性亮度增益（>1 = HDR 面光源） */
  boost: number
}

/**
 * 摄影棚光带布局（纯函数，确定性）：暗机房里的「双灯比」摄影布光——
 * 暖色顶主光带 + 冷色前补光带 + 两翼冷色轮廓光 + 背景弱面板，
 * 反射在卡牌金属框上呈方向性高光而非均匀白斑。
 */
export function studioEnvLayout(): EnvStripSpec[] {
  return [
    // 顶暖主光带（key，面朝下）
    { x: 0, y: 3, z: 0.4, rotX: Math.PI / 2, rotY: 0, w: 7, h: 3, color: '#ffd9a6', boost: 5 },
    // 前冷补光带（fill，面朝卡牌）
    { x: 0, y: 1.4, z: 4, rotX: 0, rotY: Math.PI, w: 6, h: 1.6, color: '#6fb4ff', boost: 2.6 },
    // 左翼轮廓光（青，呼应 rim 灯）
    { x: -3.6, y: 1.6, z: -0.5, rotX: 0, rotY: Math.PI / 2, w: 4.5, h: 1.4, color: '#35d0ff', boost: 1.8 },
    // 右翼轮廓光（中性冷白，稍弱）
    { x: 3.6, y: 1.6, z: -0.5, rotX: 0, rotY: -Math.PI / 2, w: 4.5, h: 1.4, color: '#9fb6ff', boost: 1.3 },
    // 背景弱面板（机房暗环境层次，避免反射死黑）
    { x: 0, y: 2, z: -3.6, rotX: 0, rotY: 0, w: 8, h: 2.4, color: '#243b52', boost: 0.8 },
  ]
}

/**
 * 烘焙程序化环境贴图（浏览器/ WebGL 专用；失败或无 DOM 返回 null，上层回落无环境）。
 * 返回 PMREM 渲染目标——texture 挂 scene.environment，RT 本体随场景 dispose()。
 */
export function buildStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget | null {
  try {
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envScene = new THREE.Scene()
    envScene.background = new THREE.Color('#02040a') // 暗环境基底
    for (const s of studioEnvLayout()) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w, s.h),
        // 颜色乘增益突破 1.0 → 线性 HDR 面光源（PMREM 烘焙保留亮度层次）
        new THREE.MeshBasicMaterial({ color: new THREE.Color(s.color).multiplyScalar(s.boost) }),
      )
      mesh.position.set(s.x, s.y, s.z)
      mesh.rotation.set(s.rotX, s.rotY, 0)
      envScene.add(mesh)
    }
    const rt = pmrem.fromScene(envScene, 0.035)
    pmrem.dispose()
    // 小场景即刻销毁（只留烘焙产物）
    envScene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const mat = obj.material as THREE.MeshBasicMaterial
        mat.dispose()
      }
    })
    return rt
  } catch {
    return null
  }
}
