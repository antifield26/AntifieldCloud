/**
 * 请求元信息（客户端 IP、协议、Host）解析。
 *
 * 信任模型：应用只监听 127.0.0.1，唯一外部入口是 Cloudflare Tunnel（cloudflared
 * 从本机 loopback 连入）。因此只有「socket 对端是 loopback」时才采信 Cloudflare
 * 注入的 CF-Connecting-IP / X-Forwarded-Proto；X-Forwarded-Host 一律不采信。
 *
 * - IP：loopback 对端时优先 CF-Connecting-IP，其次 X-Forwarded-For 的最后一项
 *   （Cloudflare 追加在尾部，最左项可被客户端伪造）；非法值回退 socket 地址。
 * - 协议：loopback 对端时采信 X-Forwarded-Proto（Cloudflare 会覆盖该头）；
 *   否则按 socket 是否 TLS 判断。
 * - Host：只取原始 Host 头，绝不使用 X-Forwarded-Host。
 */
import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'
import { isLoopbackHostname, normalizeHost } from './host.ts'

export type RequestProtocol = 'http' | 'https'

export interface RequestMeta {
  /** 用于限流/审计/会话记录的客户端 IP。 */
  ip: string
  /** 用于 Cookie Secure/Domain 判断的协议。 */
  protocol: RequestProtocol
  /** 来自原始 Host 头的主机名（不含端口）。 */
  hostname: string
  /** socket 对端是否为 loopback（即是否可能来自本机反代）。 */
  trustedPeer: boolean
  /** 是否为本机 loopback 访问（Host 为 loopback 名称）。 */
  loopback: boolean
}

export interface RequestMetaInput {
  peerAddress: string | undefined
  encrypted: boolean
  headers: Record<string, string | string[] | undefined>
}

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? ''
  return typeof value === 'string' ? value.trim() : ''
}

/** 规范化 IPv4-mapped IPv6 与 zone id，便于比较与记录。 */
export function normalizeIpAddress(value: string): string {
  let address = value.trim()
  const zoneIndex = address.indexOf('%')
  if (zoneIndex > 0) address = address.slice(0, zoneIndex)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped?.[1]) return mapped[1]
  return address
}

/** 判断是否是 loopback 地址（127.0.0.0/8、::1）。 */
export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false
  const address = normalizeIpAddress(value)
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4)
}

/**
 * 纯函数：从 socket 对端/协议/请求头解析出可信的请求元信息。
 * 独立导出以便单元测试伪造非 loopback 对端。
 */
export function resolveRequestMeta(input: RequestMetaInput): RequestMeta {
  const peer = normalizeIpAddress(input.peerAddress ?? '')
  const trustedPeer = isLoopbackAddress(peer)
  const hostname = normalizeHost(firstHeader(input.headers.host))

  let ip = peer || 'unknown'
  if (trustedPeer) {
    const cfConnecting = firstHeader(input.headers['cf-connecting-ip'])
    if (cfConnecting && isIP(normalizeIpAddress(cfConnecting)) !== 0) {
      ip = normalizeIpAddress(cfConnecting)
    } else {
      const forwarded = firstHeader(input.headers['x-forwarded-for'])
      if (forwarded) {
        const entries = forwarded.split(',').map((entry) => normalizeIpAddress(entry)).filter(Boolean)
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const candidate = entries[index]!
          if (isIP(candidate) !== 0) {
            ip = candidate
            break
          }
        }
      }
    }
  }

  let protocol: RequestProtocol = input.encrypted ? 'https' : 'http'
  if (trustedPeer) {
    const forwardedProto = firstHeader(input.headers['x-forwarded-proto']).toLowerCase()
    if (forwardedProto === 'https' || forwardedProto === 'http') protocol = forwardedProto
  }

  return { ip, protocol, hostname, trustedPeer, loopback: isLoopbackHostname(hostname) }
}

/** 从 Fastify 请求解析请求元信息。 */
export function requestMeta(request: FastifyRequest): RequestMeta {
  const raw = request.raw
  return resolveRequestMeta({
    peerAddress: raw.socket?.remoteAddress,
    encrypted: Boolean((raw.socket as { encrypted?: boolean } | undefined)?.encrypted),
    headers: raw.headers,
  })
}
