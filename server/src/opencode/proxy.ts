/**
 * opencode 反向代理：ai.example.com → http://127.0.0.1:4096
 * - 先校验应用会话（TOTP 登录后的 Cookie）
 * - 注入 Basic 认证，overwrite 客户端 Authorization/Cookie
 * - 支持 SSE/WebSocket 流式；不记录请求体与 Authorization
 * - 所有升级/代理入口都做异常兜底：任意畸形请求不得让进程退出
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { STATUS_CODES } from 'node:http'
import type { Socket } from 'node:net'
import httpProxy from 'http-proxy'
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import { isLoopbackAddress, type AuthService } from '../auth/service.ts'
import { readSessionToken } from '../auth/cookies.ts'
import { hostFromOrigin, isLoopbackHostname, normalizeHost } from '../http/host.ts'
import { injectOpenCodeScriptOptOut, injectOpenCodeShim, OPENCODE_SHIM_PATH, OPENCODE_SHIM_SCRIPT } from './shim.ts'

export { normalizeHost, hostFromOrigin }

/** Cookie 解码失败时保留原始值（后续会话校验自然失败），绝不让异常穿透。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) out[key] = safeDecode(value)
  }
  return out
}

function writeRawJson(socket: Socket | ServerResponse, statusCode: number, body: string, headers: Record<string, string> = {}): void {
  try {
    if ('writeHead' in socket && typeof socket.writeHead === 'function') {
      const response = socket
      if (response.headersSent) {
        response.end()
        return
      }
      response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...headers,
      })
      response.end(body)
      return
    }
    const raw = socket
    if (!raw.destroyed) {
      raw.write(
        `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? 'Error'}\r\n` +
          `content-type: application/json; charset=utf-8\r\ncache-control: no-store\r\n` +
          `x-content-type-options: nosniff\r\nreferrer-policy: no-referrer\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      )
    }
    raw.destroy()
  } catch {
    try {
      socket.destroy()
    } catch {
      // 忽略：连接已经不可用。
    }
  }
}

interface ProxyLogger {
  error(obj: unknown, message?: string): void
}

export interface OpenCodeProxyOptions {
  /** 安全拒绝审计；由 app 注入，避免代理层依赖 DB。 */
  audit?: (action: string, target: string | null, detail: Record<string, unknown>, ip: string | null) => void
}

type OriginKind = 'http' | 'websocket'

export class OpenCodeProxy {
  private readonly proxy: ReturnType<typeof httpProxy.createProxyServer>
  private readonly config: Config
  private readonly auth: AuthService
  private readonly aiHost: string
  private readonly appHost: string
  private readonly basicAuth: string
  private readonly log: ProxyLogger | null
  private readonly audit: OpenCodeProxyOptions['audit'] | null
  /** 已建立的 WebSocket 隧道（关闭时强制断开，避免 shutdown 挂起）。 */
  private readonly upgradedSockets = new Set<Socket>()
  /** 代理到 opencode 的上游连接（包括 WS 隧道），关闭时一并断开。 */
  private readonly upstreamSockets = new Set<Socket>()

  constructor(config: Config, auth: AuthService, log?: FastifyBaseLogger, options: OpenCodeProxyOptions = {}) {
    this.config = config
    this.auth = auth
    this.log = log ?? null
    this.audit = options.audit ?? null
    this.aiHost = hostFromOrigin(config.aiOrigin)
    this.appHost = hostFromOrigin(config.appOrigin)
    this.basicAuth = `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`, 'utf8').toString('base64')}`
    this.proxy = httpProxy.createProxyServer({
      target: config.opencodeUrl,
      ws: true,
      changeOrigin: true,
      xfwd: true,
      timeout: 0,
      proxyTimeout: 0,
    })
    this.proxy.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('authorization', this.basicAuth)
      proxyReq.removeHeader('cookie')
    })
    this.proxy.on('open', (proxySocket) => {
      const socket = proxySocket as unknown as Socket
      this.upstreamSockets.add(socket)
      const forget = (): void => {
        this.upstreamSockets.delete(socket)
      }
      socket.once('close', forget)
      socket.once('error', forget)
    })
    this.proxy.on('error', (error, _req, res) => {
      this.log?.error({ err: error }, 'opencode 反代失败')
      if (!res) return
      writeRawJson(res as unknown as Socket | ServerResponse, 502, JSON.stringify({
        error: { code: 'opencode_unavailable', message: 'AI 工作区暂时不可用' },
      }))
    })
  }

  isAiHost(host: string): boolean {
    return host === this.aiHost
  }

  isAppHost(host: string): boolean {
    return host === this.appHost || host === '' || isLoopbackHostname(host)
  }

  /**
   * Origin 白名单：只允许 app/ai 两个正式 origin；WS 握手额外接受 ws(s) 形式。
   * loopback 开发例外要求对端也是 loopback，避免生产环境被本机以外的 Origin 绕过。
   * 返回 false 表示应拒绝（403 + 审计）。
   */
  private originAllowed(originHeader: string | string[] | undefined, kind: OriginKind, remoteIp: string | null): boolean {
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
    // 同源导航可能不带 Origin；WebSocket 必须带（浏览器都会发送）。
    if (origin === undefined || origin === '') return kind === 'http'
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    const hostname = parsed.hostname.toLowerCase()
    const isLoopbackPeer = remoteIp !== null && isLoopbackAddress(remoteIp)
    const loopbackOrigin = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
    if (this.config.allowInsecureLoopback && isLoopbackPeer && loopbackOrigin) return true
    const protocol = parsed.protocol
    if (kind === 'websocket') {
      // 非 loopback（生产）只接受 TLS origin；浏览器 WS 握手的 Origin 通常为 https。
      if (protocol !== 'https:' && protocol !== 'wss:') return false
    } else if (protocol !== 'https:') {
      return false
    }
    const host = parsed.host.toLowerCase()
    return host === this.aiHost || host === this.appHost
  }

  /** 记录安全拒绝（不记录 token/Cookie）。 */
  private auditOriginRejected(kind: OriginKind, origin: string | string[] | undefined, ip: string | null): void {
    const value = Array.isArray(origin) ? origin[0] : origin
    this.audit?.('opencode_origin_rejected', value ? value.slice(0, 256) : null, { kind }, ip)
  }

  /**
   * opencode Web HTML 处理：
   * - shim：注入同源脚本并 opt-out Rocket Loader（默认，兼容当前上游）；
   * - attributes：只加 data-cfasync，不注入 JS；
   * - passthrough：完全交给原生代理（用于 Cloudflare 已关闭注入后的无垫片验证）。
   * 返回 true 表示已接管响应；false 交回原来的 http-proxy 路径。
   */
  async serveShim(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const mode = this.config.opencodeHtmlMode
    if (mode === 'passthrough') return false
    const method = request.method
    if (method !== 'GET' && method !== 'HEAD') return false
    const rawUrl = request.raw.url ?? '/'
    const path = rawUrl.split('?')[0] ?? '/'
    const context = this.auth.authenticate(readSessionToken(request))
    if (!context) return false
    request.auth = context
    if (!this.originAllowed(request.headers.origin, 'http', request.socket.remoteAddress ?? null)) {
      this.auditOriginRejected('http', request.headers.origin, request.socket.remoteAddress ?? null)
      reply.code(403).header('cache-control', 'no-store').send({
        error: { code: 'origin_rejected', message: '请求来源不受信任' },
      })
      return true
    }

    if (mode === 'shim' && path === OPENCODE_SHIM_PATH) {
      reply
        .code(200)
        .header('content-type', 'application/javascript; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(OPENCODE_SHIM_SCRIPT)
      return true
    }

    const accept = request.headers.accept ?? ''
    const htmlNavigation =
      path === '/' ||
      path === '/index.html' ||
      (typeof accept === 'string' && accept.includes('text/html'))
    if (!htmlNavigation) return false
    if (path.startsWith('/api/') || path.startsWith('/_assets/') || path.startsWith('/__af/')) return false
    if (!this.config.opencodePassword) return false

    try {
      const upstream = await fetch(`${this.config.opencodeUrl}${rawUrl}`, {
        headers: {
          accept: 'text/html',
          authorization: this.basicAuth,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      if (!upstream.ok) return false
      const contentType = upstream.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html')) return false
      const html =
        mode === 'shim' ? injectOpenCodeShim(await upstream.text()) : injectOpenCodeScriptOptOut(await upstream.text())
      const headers: Record<string, string> = {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-af-oc-mode': mode,
      }
      if (mode === 'shim') headers['x-af-oc-shim'] = '1'
      for (const name of ['content-security-policy', 'content-language', 'vary']) {
        const value = upstream.headers.get(name)
        if (value) headers[name] = value
      }
      reply.code(upstream.status).headers(headers)
      if (method === 'HEAD') reply.send()
      else reply.send(html)
      return true
    } catch (error) {
      this.log?.error({ err: error }, 'opencode HTML 处理失败，回退原生代理')
      return false
    }
  }

  /** 在 Fastify onRequest 中调用；未认证时返回 302/401，认证后接管响应。 */
  handle(request: FastifyRequest, reply: FastifyReply): void {    try {
      this.handleUnsafe(request, reply)
    } catch (error) {
      this.log?.error({ err: error }, 'opencode 代理请求处理异常')
      if (!reply.raw.headersSent) {
        writeRawJson(reply.raw, 502, JSON.stringify({ error: { code: 'opencode_unavailable', message: 'AI 工作区暂时不可用' } }))
      } else {
        reply.raw.destroy()
      }
    }
  }

  private handleUnsafe(request: FastifyRequest, reply: FastifyReply): void {
    const context = this.auth.authenticate(readSessionToken(request))
    if (!context) {
      if (request.method === 'GET' && this.wantsHtml(request)) {
        const next = encodeURIComponent(`${this.config.aiOrigin}${request.raw.url ?? '/'}`)
        reply
          .code(302)
          .header('location', `${this.config.appOrigin}/login?next=${next}`)
          .header('cache-control', 'no-store')
          .send()
        return
      }
      reply.code(401).header('cache-control', 'no-store').send({
        error: { code: 'unauthenticated', message: '请先登录' },
      })
      return
    }
    // 已登录后校验 Origin：防止被第三方站点借用浏览器 Cookie 发起跨站请求。
    const remoteIp = request.socket.remoteAddress ?? null
    if (!this.originAllowed(request.headers.origin, 'http', remoteIp)) {
      this.auditOriginRejected('http', request.headers.origin, remoteIp)
      reply.code(403).header('cache-control', 'no-store').send({
        error: { code: 'origin_rejected', message: '请求来源不受信任' },
      })
      return
    }
    if (!this.config.opencodePassword) {
      reply.code(503).send({ error: { code: 'opencode_not_configured', message: 'opencode 未配置' } })
      return
    }
    request.auth = context
    reply.hijack()
    this.proxy.web(request.raw, reply.raw)
  }

  private wantsHtml(request: FastifyRequest): boolean {
    const accept = request.headers.accept ?? ''
    return typeof accept === 'string' && accept.includes('text/html')
  }

  /** 处理 WebSocket upgrade；只允许 ai 主机且会话有效。任何异常都只断开连接。 */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    try {
      this.handleUpgradeUnsafe(request, socket, head)
    } catch (error) {
      this.log?.error({ err: error }, 'opencode WebSocket 升级处理异常')
      writeRawJson(socket, 400, JSON.stringify({ error: { code: 'invalid_request', message: '请求不合法' } }))
    }
  }

  private handleUpgradeUnsafe(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const host = normalizeHost(request.headers.host)
    if (host !== this.aiHost) {
      socket.destroy()
      return
    }
    const cookies = parseCookieHeader(request.headers.cookie)
    const token = cookies.af_session ?? null
    const context = this.auth.authenticate(token)
    if (!context) {
      writeRawJson(socket, 401, JSON.stringify({ error: { code: 'unauthenticated', message: '请先登录' } }))
      return
    }
    // WS 握手必须携带合法 Origin（浏览器总是发送）；不匹配/缺失一律 403 + 审计。
    const remoteIp = request.socket.remoteAddress ?? null
    if (!this.originAllowed(request.headers.origin, 'websocket', remoteIp)) {
      this.auditOriginRejected('websocket', request.headers.origin, remoteIp)
      writeRawJson(socket, 403, JSON.stringify({ error: { code: 'origin_rejected', message: '请求来源不受信任' } }))
      return
    }
    if (!this.config.opencodePassword) {
      socket.destroy()
      return
    }
    delete request.headers.cookie
    delete request.headers.authorization
    this.upgradedSockets.add(socket)
    const forget = (): void => {
      this.upgradedSockets.delete(socket)
    }
    socket.once('close', forget)
    socket.once('error', () => {
      forget()
      socket.destroy()
    })
    this.proxy.ws(request, socket, head, { headers: { authorization: this.basicAuth } })
  }

  close(): void {
    for (const socket of this.upgradedSockets) {
      try {
        socket.destroy()
      } catch {
        // 忽略：连接可能已经断开。
      }
    }
    this.upgradedSockets.clear()
    for (const socket of this.upstreamSockets) {
      try {
        socket.destroy()
      } catch {
        // 忽略：连接可能已经断开。
      }
    }
    this.upstreamSockets.clear()
    this.proxy.close()
  }

  /** 供测试/诊断使用，不暴露密码。 */
  get upstreamHost(): string {
    return this.config.opencodeUrl
  }

  get hosts(): { app: string; ai: string } {
    return { app: this.appHost, ai: this.aiHost }
  }
}
