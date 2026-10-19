// PWA 安装提示：捕获 beforeinstallprompt，用户可安装或稍后关闭。
// 已安装/独立窗口模式不展示；关闭选择记入 localStorage，避免反复打扰。

import { useEffect, useState } from 'react'
import { Download, Smartphone, X } from 'lucide-react'
import { Button } from './Button'
import { Logo } from './Logo'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const DISMISS_KEY = 'af-pwa-install-dismissed'

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  return Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
}

export function PwaInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (isStandalone()) return
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') return
    } catch {
      // 隐私模式下 localStorage 不可写，仍显示提示
    }
    const handlePrompt = (event: Event): void => {
      event.preventDefault()
      setDeferred(event as BeforeInstallPromptEvent)
      setVisible(true)
    }
    const handleInstalled = (): void => {
      setVisible(false)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', handlePrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handlePrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const rememberDismiss = (): void => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // 忽略不可写
    }
  }

  const handleInstall = async (): Promise<void> => {
    if (!deferred || installing) return
    setInstalling(true)
    try {
      await deferred.prompt()
      const choice = await deferred.userChoice
      if (choice.outcome !== 'accepted') rememberDismiss()
      setVisible(false)
      setDeferred(null)
    } catch {
      setVisible(false)
    } finally {
      setInstalling(false)
    }
  }

  if (!visible) return null

  return (
    <aside className="pwa-prompt" aria-label="安装应用提示">
      <span className="pwa-prompt-icon" aria-hidden="true">
        <Smartphone size={18} />
      </span>
      <div className="pwa-prompt-text">
        <strong>安装到桌面</strong>
        <span>像原生应用一样打开工作台</span>
      </div>
      <div className="pwa-prompt-actions">
        <Button
          variant="primary"
          size="sm"
          icon={<Download size={14} aria-hidden="true" />}
          loading={installing}
          onClick={() => void handleInstall()}
        >
          安装
        </Button>
        <button
          type="button"
          className="icon-btn pwa-prompt-close"
          aria-label="关闭安装提示"
          onClick={() => {
            rememberDismiss()
            setVisible(false)
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <span className="pwa-prompt-logo" aria-hidden="true">
        <Logo size={24} />
      </span>
    </aside>
  )
}
