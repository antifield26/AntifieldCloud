// PWA 更新提示（v0.7.0）：Service Worker 提升 controller 后提示刷新，
// 避免长开页面继续使用旧 bundle 与旧接口假设。

import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from './Button'

export function PwaUpdatePrompt() {
  const [updated, setUpdated] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const container = navigator.serviceWorker
    const wasControlled = Boolean(container.controller)
    const onChange = (): void => {
      // 首次安装时 controller 从 null 变为 SW，不算“更新”；已有控制后再变化才是新版本接管。
      if (wasControlled) setUpdated(true)
    }
    container.addEventListener('controllerchange', onChange)
    return () => container.removeEventListener('controllerchange', onChange)
  }, [])

  if (!updated || dismissed) return null

  return (
    <div className="pwa-update-prompt" role="status">
      <RefreshCw size={15} aria-hidden="true" />
      <span>应用已更新到新版本，刷新后生效。</span>
      <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
        刷新
      </Button>
      <button
        type="button"
        className="icon-btn pwa-update-close"
        aria-label="关闭更新提示"
        onClick={() => setDismissed(true)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
