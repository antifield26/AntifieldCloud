// PWA Service Worker 版本与注册 URL（纯函数，构建 hash 作为缓存版本）。
// 构建产物入口为 /assets/index-<hash>.js；开发环境不注册 SW。

export function buildPwaVersion(moduleUrl: string): string {
  try {
    const pathname = new URL(moduleUrl, 'http://localhost').pathname
    const file = pathname.split('/').pop() ?? ''
    const stem = file.replace(/\.[^.]+$/, '').replace(/^index-/, '')
    // Rolldown/Vite 的 hash 段可能以下划线开头（如 _E7svcQK）
    return /^[a-z0-9_-]+$/i.test(stem) && stem.length >= 6 && stem !== 'dev' ? stem : 'dev'
  } catch {
    return 'dev'
  }
}

export function serviceWorkerUrl(version: string): string {
  return `/sw.js?v=${encodeURIComponent(version)}`
}
