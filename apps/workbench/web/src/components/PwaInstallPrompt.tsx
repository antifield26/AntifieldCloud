// PWA 安装提示：展示浏览器 beforeinstallprompt 捕获到的安装机会，用户可安装或稍后关闭。
// 已安装/独立窗口模式不展示；关闭选择记入 localStorage，避免反复打扰。
// v0.7.0：事件由 lib/pwa-install 统一捕获，Settings“关于”卡片与底部提示复用同一 deferred prompt。

import { useEffect, useState } from 'react'
import { Download, Smartphone, X } from 'lucide-react'
import { Button } from './Button'
import { Logo } from './Logo'
import {
  ensurePwaInstallListener,
  getInstallPromptEvent,
  isInstallDismissed,
  isPwaInstalled,
  promptPwaInstall,
  rememberInstallDismissed,
  subscribePwaInstall,
} from '../lib/pwa-install'

export function PwaInstallPrompt() {
  const [hasPrompt, setHasPrompt] = useState<boolean>(() => Boolean(getInstallPromptEvent()))
  const [visible, setVisible] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    ensurePwaInstallListener()
    const sync = (): void => {
      const available = Boolean(getInstallPromptEvent())
      setHasPrompt(available)
      setVisible(available && !isPwaInstalled() && !isInstallDismissed())
    }
    sync()
    return subscribePwaInstall(sync)
  }, [])

  const handleInstall = async (): Promise<void> => {
    if (!hasPrompt || installing) return
    setInstalling(true)
    try {
      const outcome = await promptPwaInstall()
      if (outcome !== 'accepted') rememberInstallDismissed()
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
            rememberInstallDismissed()
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
