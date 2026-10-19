// 站点域名与来源推导工具。
// 域名不写死：app/ai 兄弟域由当前 hostname 推导，生产与本地回环分别处理。
// 安全边界：只接受 http/https 且不带 userinfo 的 origin；拒绝把任意输入当作可跳转来源。

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface SiteLocation {
  origin: string
  hostname: string
  protocol: string
}

export function currentSiteLocation(): SiteLocation | null {
  if (typeof window === 'undefined') return null
  const { origin, hostname, protocol } = window.location
  return { origin, hostname, protocol }
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

/** app.example.com ↔ ai.example.com；没有可推导前缀时返回 null。 */
export function deriveSiblingHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase()
  if (lower.startsWith('app.')) return `ai.${lower.slice(4)}`
  if (lower.startsWith('ai.')) return `app.${lower.slice(3)}`
  return null
}

export function deriveSiblingOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    const siblingHostname = deriveSiblingHostname(url.hostname)
    if (!siblingHostname) return null
    url.hostname = siblingHostname
    return url.origin
  } catch {
    return null
  }
}

/** 校验服务端下发的 origin 字段，非法值安全回退为 null。 */
export function safeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}
