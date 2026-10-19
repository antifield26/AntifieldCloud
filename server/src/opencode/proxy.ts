/**
 * opencode 反向代理：ai.example.com → http://127.0.0.1:4096
 * - 先校验应用会话（TOTP 登录后的 Cookie）
 * - 注入 Basic 认证，overwrite 客户端 Authorization/Cookie
 * - 支持 SSE/WebSocket 流式；不记录请求体与 Authorization
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import httpProxy from 'http-proxy'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import type { AuthService } from '../auth/service.ts'
import { isLoopbackHost, readSessionToken } from '../auth/cookies.ts'

export function normalizeHost(header: string | undefined): string {
  if (!header) return ''
  const value = header.trim().toLowerCase()
  if (value.startsWith('[')) return value.replace(/^\[|\](:\d+)?$/g, '')
  const colon = value.lastIndexOf(':')
  return colon > 0 ? value.slice(0, colon) : value
}

export function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return ''
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
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export class OpenCodeProxy {
  private readonly proxy: ReturnType<typeof httpProxy.createProxyServer>
  private readonly config: Config
  private readonly auth: AuthService
  private readonly aiHost: string
  private readonly appHost: string
  private readonly basicAuth: string

  constructor(config: Config, auth: AuthService) {
    this.config = config
    this.auth = auth
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
    this.proxy.on('error', (error, _req, res) => {
      if (!res) return
      const response = res as unknown as ServerResponse
      if (typeof response.writeHead === 'function') {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        }
        response.end(JSON.stringify({ error: { code: 'opencode_unavailable', message: 'AI 工作区暂时不可用' } }))
      } else {
        ;(res as unknown as Socket).destroy()
      }
      void error
    })
  }

  isAiHost(host: string): boolean {
    return host === this.aiHost
  }

  isAppHost(host: string): boolean {
    return host === this.appHost || host === '' || isLoopbackHost(host)
  }

  /** 在 Fastify onRequest 中调用；未认证时返回 302/401，认证后接管响应。 */
  handle(request: FastifyRequest, reply: FastifyReply): void {
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

  /** 处理 WebSocket upgrade；只允许 ai 主机且会话有效。 */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const host = normalizeHost(request.headers.host)
    if (host !== this.aiHost) {
      socket.destroy()
      return
    }
    const cookies = parseCookieHeader(request.headers.cookie)
    const token = cookies.af_session ?? null
    const context = this.auth.authenticate(token)
    if (!context) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!this.config.opencodePassword) {
      socket.destroy()
      return
    }
    delete request.headers.cookie
    delete request.headers.authorization
    this.proxy.ws(request, socket, head, { headers: { authorization: this.basicAuth } })
  }

  close(): void {
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
