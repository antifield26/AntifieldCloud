// 登录 next 参数白名单解析，避免开放重定向。
// 允许：站内相对路径、当前页面同源 URL、由当前 hostname 推导的 app/ai 兄弟域；
// loopback 地址仅在当前页面本身处于 loopback 时允许，且要求同 hostname。

import { deriveSiblingHostname, isLoopbackHostname } from './origin'
import type { SiteLocation } from './origin'

export interface NextLocation {
  origin: string
  hostname: string
  protocol: string
}

function resolveCurrent(current: NextLocation | null | undefined): SiteLocation | null {
  if (current) return { origin: current.origin, hostname: current.hostname, protocol: current.protocol }
  if (typeof window === 'undefined') return null
  const { origin, hostname, protocol } = window.location
  return { origin, hostname, protocol }
}

export function sanitizeNext(
  raw: string | null | undefined,
  current: NextLocation | null | undefined = undefined,
): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value) return null

  // 相对路径只允许以单个 / 开头，防止 //evil.com 与 /\evil.com 绕过
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  if (value.startsWith('/')) {
    if (value.startsWith('/login')) return null
    return value
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  if (url.pathname === '/login') return null

  const location = resolveCurrent(current)
  if (!location) return null

  const currentHost = location.hostname.toLowerCase()
  const targetHost = url.hostname.toLowerCase()

  // 当前页面是 loopback 时，仅允许同 hostname 的 loopback 地址（开发环境）
  if (isLoopbackHostname(currentHost)) {
    if (!isLoopbackHostname(targetHost)) return null
    if (targetHost !== currentHost) return null
    return url.href
  }

  if (url.origin === location.origin) return url.href

  // 生产：仅允许 https 下由当前 hostname 推导的 app↔ai 兄弟域
  const siblingHostname = deriveSiblingHostname(currentHost)
  if (url.protocol === 'https:' && siblingHostname !== null && targetHost === siblingHostname) {
    return url.href
  }
  return null
}

export function isExternalUrl(target: string): boolean {
  return /^https?:\/\//i.test(target)
}
