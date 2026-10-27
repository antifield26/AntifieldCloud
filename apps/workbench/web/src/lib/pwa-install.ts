// PWA 安装提示的共享状态（v0.7.0）：beforeinstallprompt 只捕获一次，
// 底部提示与 Settings/关于卡片共用同一个 deferred prompt。

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

type Listener = () => void

let deferredEvent: BeforeInstallPromptEvent | null = null
let installed = false
let listening = false
const listeners = new Set<Listener>()

const DISMISS_KEY = 'af-pwa-install-dismissed'

function notify(): void {
  for (const listener of listeners) listener()
}

export function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  return Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
}

export function isInstallDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberInstallDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // 隐私模式忽略
  }
}

/** 注册全局 beforeinstallprompt/appinstalled 监听（幂等）。应在应用启动早期调用一次。 */
export function ensurePwaInstallListener(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredEvent = event as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferredEvent = null
    notify()
  })
}

export function getInstallPromptEvent(): BeforeInstallPromptEvent | null {
  return deferredEvent
}

export function isPwaInstalled(): boolean {
  return installed || isStandaloneMode()
}

/** 订阅 deferred prompt/安装状态变化；返回取消订阅函数。 */
export function subscribePwaInstall(listener: Listener): () => void {
  ensurePwaInstallListener()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

/** 触发浏览器安装提示；没有可用事件时返回 unavailable（由调用方提示用浏览器菜单安装）。 */
export async function promptPwaInstall(): Promise<InstallOutcome> {
  const event = deferredEvent
  if (!event) return 'unavailable'
  try {
    await event.prompt()
    const choice = await event.userChoice
    deferredEvent = null
    if (choice.outcome !== 'accepted') rememberInstallDismissed()
    return choice.outcome
  } catch {
    return 'unavailable'
  } finally {
    notify()
  }
}
