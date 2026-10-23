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

/** 服务端 AI SSO 票据端点：requireAuth，非法 next 400，合法时 302 到 ai 的 SSO 入口。 */
export const AI_TICKET_PATH = '/api/auth/ai-ticket'

/**
 * 是否为需要经 AI 票据跳转的外部 AI 工作区 URL（当前 hostname 推导出的 app↔ai 兄弟域）。
 * 同 hostname（含 loopback 不同端口）不算：那属于同源/本机跳转，直接交给浏览器或路由。
 */
export function isAiWorkspaceUrl(
  raw: string | null | undefined,
  current: NextLocation | null | undefined = undefined,
): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username || url.password) return false
  const location = resolveCurrent(current)
  if (!location) return false
  const currentHost = location.hostname.toLowerCase()
  const targetHost = url.hostname.toLowerCase()
  if (targetHost === currentHost) return false
  // 仅 app.* → ai.* 方向视为 AI 工作区；ai 侧再跳 app 不应再经 ai-ticket。
  if (!currentHost.startsWith('app.')) return false
  const siblingHostname = deriveSiblingHostname(currentHost)
  return siblingHostname !== null && targetHost === siblingHostname
}

/** 构造 AI SSO 票据 URL：next 为完整 ai URL，由服务端二次校验并 302。 */
export function buildAiTicketUrl(next: string): string {
  return `${AI_TICKET_PATH}?next=${encodeURIComponent(next)}`
}

/**
 * 登录成功/已登录后的整页跳转目标：
 * - 外部 AI 工作区（app↔ai 兄弟域）→ 服务端 ai-ticket，由服务端签发一次性 ticket；
 * - 其它外部 URL → 原样跳转（next 已由 sanitizeNext 白名单校验）；
 * - 站内相对路径 → null，由调用方走 SPA navigate。
 */
export function externalLoginRedirect(
  raw: string | null | undefined,
  current: NextLocation | null | undefined = undefined,
): string | null {
  if (!raw) return null
  if (isAiWorkspaceUrl(raw, current)) return buildAiTicketUrl(raw)
  return isExternalUrl(raw) ? raw : null
}

/**
 * 整页跳转出口：生产环境为 window.location.assign。
 * 抽成独立函数便于组件测试替换（jsdom 的 Location.assign 不可 spy）。
 */
export function assignExternalUrl(url: string): void {
  window.location.assign(url)
}
