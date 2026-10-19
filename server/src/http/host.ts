/**
 * Host 头与来源解析：只有这里负责把请求头转为可比较的 hostname。
 * 安全约束：不得让客户端可控的 X-Forwarded-Host 参与任何安全判断。
 */

/** 取 Host 头的主机名（去掉端口、小写、IPv6 去括号）。 */
export function normalizeHost(header: string | undefined): string {
  if (!header) return ''
  const value = header.trim().toLowerCase()
  if (value.startsWith('[')) return value.replace(/^\[|\](:\d+)?$/g, '')
  const colon = value.lastIndexOf(':')
  return colon > 0 ? value.slice(0, colon) : value
}

/** 从配置的 origin（如 https://app.example.com）提取主机名。 */
export function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 判断 hostname 是否是本机 loopback 名称（仅用于开发/本机访问例外）。 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}
