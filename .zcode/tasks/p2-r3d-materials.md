# P2-R3D1 + P2-R3D2 拟真材质升级 · 任务书

任务执行者身份：先读 `.zcode/agents/client-3d.md`。验收标准：`docs/phase2-plan.md` §P2-R3D1 与 §P2-R3D2。工作目录：仓库根。两任务归你串行完成（共用环境贴图基建，不拆两个代理）。

## 现状事实

- 卡牌 mesh：`three/CardEntity.ts`（frontMat/backMat 贴图平面 + cardOutline 描边 + frame 辉光层）；卡面纹理经 `CardFace`/`cardArt`（512×718 CanvasTexture，TextureCache 按 cardFaceCacheKey 缓存）；卡面布局常量在 `three/cardArt/layout.ts`（插画窗/边框几何），稀有度四档底色分级在 `cardArt/ground.ts`。
- 牌桌：`three/tableSkin/`（params/textures/dust——台面/机架墙/地板/槽位柔光四张程序化 Canvas 纹理，固定种子）；`SceneManager.ts` 持灯光/雾/派系染色（tick 指数平滑）；`TableRenderer.ts` 装配。
- 质量闸门：`three/fx/quality.ts`（fxEnabled(feature) + low 档），全局开关 handle.setFxQuality。
- 渲染红线：渲染循环零分配、纹理/材质共享缓存、池化复用。

## P2-R3D1 拟真卡牌材质

1. **法线贴图（程序化派生，禁像素分析）**：新模块 `three/cardMaterial/`（命名自定）——按 `cardArt/layout.ts` 的布局几何（边框凸起、插画窗下沉、稀有度框槽、金属框高光带）纯函数绘制法线贴图 Canvas（按稀有度分档参数），随卡面纹理同键进 TextureCache 体系缓存（键扩展，不重绘不泄漏）；**不许改** cardArt/** 与 CardFace.ts（只 import 常量与既有导出）。
2. **程序化环境贴图**：一张全局共享——程序化小场景（几块光带面光源 + 暗环境）经 PMREMGenerator 生成；SceneManager 挂 scene.environment。卡牌金属框/稀有度框获得真实反射。
3. **材质升级**：卡牌正反面 → `MeshPhysicalMaterial`（map + normalMap + envMap 反射 + 粗糙度分层：纸面 0.7 / 金属框感区域由法线贴图强度体现）；传说卡 clearcoat 全息闪层（随视角微流动，幅度克制）。材质按稀有度全局共享 ≤5 档实例（禁 per-card 克隆），hover 亮态沿用现有共享切换模式。
4. **性能与降级**：法线贴图生成一次性 + 缓存；`fxEnabled` 新增 'materials' 门（quality.ts 归你改）——low 档直通现有扁平材质（保留旧材质引用路径，切换不重建几何）；envMap 只 high 档生成。
5. 测试：法线贴图参数派生纯函数、缓存键扩展、low/high 切换无泄漏——无头单测。

## P2-R3D2 牌桌真实材质（R3D1 收尾后接着做）

1. 台面绒布：织纹法线贴图 + 粗糙度贴图（光池区域更光滑），MeshStandardMaterial 全套；槽位格线/螺母徽记凹凸化（进 tableSkin 纹理生成）。
2. 灯光双灯比：暖色顶光 + 冷色补光（SceneManager），实摄影感；派系染色 tick 平滑过渡**零回归**（theme 测试保持绿）。
3. 与 R3D1 共用环境贴图，不重复生成。
4. low 档：台面材质降级直通旧贴图路径。

## 边界

独占 `three/CardEntity.ts`、`three/cardMaterial/**`（新）、`three/tableSkin/**`、`three/SceneManager.ts`、`three/TableRenderer.ts`、`three/fx/quality.ts` 及新测试文件。**禁碰**：cardArt/**、CardFace.ts、ui/**（全站）、anim/**、audio/**、tilt.ts、core、content。index.ts 导出如需变化保持向后兼容。

## 验证与汇报

定向测试（新增 + three 既有 quality/theme/tableSkin/cardOutline 测试保持绿）；禁跑全仓；禁 git commit/push。
汇报四字段：files / summary（法线派生方案、envMap 方案、材质共享结构、降级路径）/ checks / deviations（如实，含 60fps 的结构性保障说明——无法真机帧率实测要写明）。
