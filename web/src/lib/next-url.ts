// 登录 next 参数白名单解析，避免开放重定向。
// 允许：站内相对路径（非 // 协议相对地址）、本站同源 URL、同域的 ai 兄弟子域、本地回环地址。
// 域名不写死：由当前页面 hostname 推导，适配任意部署域名（app.example.com ↔ ai.example.com）。

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function sanitizeNext(raw: string | null | undefined): string | null {
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
  if (url.pathname === '/login') return null

  const current = typeof window !== 'undefined' ? window.location : null
  const sameOrigin = current !== null && url.origin === current.origin
  const parentDomain =
    current && current.hostname.includes('.') ? current.hostname.toLowerCase().split('.').slice(1).join('.') : ''
  const aiSibling = current !== null && url.protocol === 'https:' && parentDomain.length > 0 && url.hostname === `ai.${parentDomain}`
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (!sameOrigin && !aiSibling && !loopback) return null
  return url.href
}

export function isExternalUrl(target: string): boolean {
  return /^https?:\/\//i.test(target)
}
