/**
 * 图鉴卡面 canvas（P2-UI4）：经 ui/codex/face.ts 走与对局完全同源的渲染管线
 * （CardFace.drawCardFace + composeCardFaceArt + TextureCache，禁第二套视觉）。
 * 网格缩略图与详情大图共用同一缓存键 → 同一张缓存纹理，绘制只发生一次。
 */

import { useEffect, useRef } from 'react'
import type { CardDefinition } from '@siliconcard/core'
import { blitCodexFace, codexFaceCache } from './face'

export function CodexCardFace({ def, className }: { def: CardDefinition; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // SSR / 无 DOM 环境下 getContext 为空，face.ts 内部已静默降级
    blitCodexFace(el, codexFaceCache, def)
  }, [def])

  return <canvas ref={ref} className={className ?? 'sc-codex-face'} role="img" aria-label={`卡面：${def.name}`} />
}
