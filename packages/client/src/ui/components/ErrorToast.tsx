/**
 * 错误提示条（非法操作的梗化反馈）：lastError 由 store 写入，4s 自动消散。
 */

import { useEffect } from 'react'
import { useGameStore } from '../store/gameStore'

export function ErrorToast() {
  const lastError = useGameStore((s) => s.lastError)
  const clearError = useGameStore((s) => s.clearError)
  useEffect(() => {
    if (!lastError) return
    const timer = setTimeout(() => clearError(), 4000)
    return () => clearTimeout(timer)
  }, [lastError, clearError])
  if (!lastError) return null
  return (
    <div className="sc-toast" role="alert">
      ⚠ {lastError.message}
    </div>
  )
}
