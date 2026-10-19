/**
 * Fastify 应用装配：插件、Host 分流、认证上下文、安全头、路由、静态资源与 SPA 回退。
 * 所有安全边界在 app 层显式建立，路由只处理业务。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import type { Config } from './config.ts'
import { loggerOptions } from './logger.ts'
import { AuthService } from './auth/service.ts'
import { FileService } from './files/service.ts'
import { MinecraftService } from './mc/service.ts'
import { DashboardService } from './dashboard/service.ts'
import { NoteService, BookmarkService } from './notes/service.ts'
import { ShareService } from './shares/service.ts'
import { AlertService } from './alerts/service.ts'
import { OpenCodeProxy, normalizeHost } from './opencode/proxy.ts'
import { purgeAudit } from './auth/audit.ts'
import { readSessionToken } from './auth/cookies.ts'
import { registerErrorHandler } from './http/errors.ts'
import { registerAuthRoutes } from './http/routes/auth.ts'
import { registerFileRoutes } from './http/routes/files.ts'
import { registerMcRoutes } from './http/routes/mc.ts'
import { registerDashboardRoutes } from './http/routes/dashboard.ts'
import { registerNoteRoutes } from './http/routes/notes.ts'
import { registerShareRoutes } from './http/routes/shares.ts'
import { registerAlertRoutes } from './http/routes/alerts.ts'
import { wantsHtml } from './http/util.ts'

export interface AppContext {
  app: FastifyInstance
  db: DatabaseSync
  config: Config
  auth: AuthService
  files: FileService
  mc: MinecraftService
  dashboard: DashboardService
  notes: NoteService
  bookmarks: BookmarkService
  shares: ShareService
  alerts: AlertService
  proxy: OpenCodeProxy
  runMaintenance(): void
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

export async function buildApp(config: Config, db: DatabaseSync): Promise<AppContext> {
  const app = Fastify({
    logger: loggerOptions(config),
    // 只监听 127.0.0.1，唯一入口是 cloudflared；转发头在 request-meta 中按信任模型解析，
    // 不让 Fastify 用 X-Forwarded-* 覆盖 Host/协议/IP（避免 X-Forwarded-Host 影响安全判断）。
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    exposeHeadRoutes: true,
    // 关闭时强制断开长连接（SSE/WebSocket），否则 systemd stop 可能挂到超时被 SIGKILL。
    forceCloseConnections: true,
  })

  const auth = new AuthService(db, config)
  const files = new FileService(db, config, app.log)
  const mc = new MinecraftService(db, config)
  const dashboard = new DashboardService(db, config, files, mc)
  const notes = new NoteService(db)
  const bookmarks = new BookmarkService(db)
  const shares = new ShareService(db, config)
  const alerts = new AlertService(db, config, {
    log: (level, message, detail) => {
      const payload = detail ? { detail } : {}
      if (level === 'error') app.log.error(payload, message)
      else if (level === 'warn') app.log.warn(payload, message)
      else app.log.info(payload, message)
    },
    minecraftStatus: async () => {
      const status = await mc.status()
      return { online: status.online, error: status.error }
    },
  })
  const proxy = new OpenCodeProxy(config, auth, app.log)

  await app.register(cookie)
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: config.maxFilesPerRequest,
      fields: 16,
      parts: config.maxFilesPerRequest + 16,
    },
  })

  const webRoot = config.webDistDir
  const hasWeb = existsSync(join(webRoot, 'index.html'))
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      index: ['index.html'],
      setHeaders(response, filePath) {
        const normalized = filePath.replace(/\\/g, '/')
        if (normalized.includes('/assets/')) {
          response.header('cache-control', 'public, max-age=31536000, immutable')
        } else if (normalized.endsWith('index.html')) {
          response.header('cache-control', 'no-store')
        } else if (normalized.endsWith('/sw.js')) {
          response.header('cache-control', 'no-cache')
          response.header('service-worker-allowed', '/')
        } else if (normalized.endsWith('/manifest.webmanifest') || normalized.endsWith('/offline.html')) {
          response.header('cache-control', 'no-cache')
        }
      },
    })
  } else {
    app.log.warn({ webRoot }, 'web/dist 不存在：仅提供 API（开发时请用 Vite）')
  }

  // 安全响应头（AI 主机的应用层响应同样加固；opencode 自身响应由反代直通）。
  app.addHook('onSend', async (request, reply, payload) => {
    const host = normalizeHost(request.headers.host)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    // HSTS 不带 includeSubDomains（mc 子域走 SakuraFRP，避免影响其它子域）。
    reply.header('strict-transport-security', 'max-age=31536000')
    if (proxy.isAiHost(host)) {
      reply.header('cache-control', 'no-store')
      return payload
    }
    const path = request.raw.url ?? ''
    if (path.startsWith('/s/')) {
      reply.header('x-robots-tag', 'noindex, nofollow')
      reply.header('cache-control', 'no-store')
    } else if (path.startsWith('/api/') || path === '/healthz') {
      reply.header('cache-control', 'no-store')
    }
    const contentType = String(reply.getHeader('content-type') ?? '')
    if (contentType.includes('text/html')) {
      reply.header('content-security-policy', CSP)
      reply.header('x-frame-options', 'SAMEORIGIN')
      // offline.html 由 Service Worker 预缓存，不能被 no-store 覆盖；应用壳仍 no-store。
      reply.header('cache-control', path === '/offline.html' ? 'no-cache' : 'no-store')
    }
    return payload
  })

  // Host 分流：ai → 代理；app/loopback → 应用；未知 → 404。
  app.addHook('onRequest', async (request, reply) => {
    const host = normalizeHost(request.headers.host)
    if (proxy.isAiHost(host)) {
      if (await proxy.serveShim(request, reply)) return reply
      proxy.handle(request, reply)
      return reply
    }
    if (!proxy.isAppHost(host)) {
      reply.code(404).header('cache-control', 'no-store').send({
        error: { code: 'not_found', message: '未知主机' },
      })
      return reply
    }
    request.auth = auth.authenticate(readSessionToken(request)) ?? undefined
  })

  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get()
    return { ok: true, version: config.appVersion, uptimeSec: Math.floor(process.uptime()) }
  })

  registerAuthRoutes(app, config, auth)
  registerFileRoutes(app, config, files, (id) => shares.revokeForFileTree(id))
  registerMcRoutes(app, config, mc)
  registerDashboardRoutes(app, config, dashboard, db)
  registerNoteRoutes(app, config, notes, bookmarks)
  registerShareRoutes(app, config, shares)
  registerAlertRoutes(app, config, alerts)

  registerErrorHandler(app)

  // SPA 回退：非 /api 的 HTML 请求返回 index.html。
  app.setNotFoundHandler((request, reply) => {
    const path = request.raw.url ?? ''
    if (path.startsWith('/api/') || path === '/healthz') {
      reply.code(404).send({ error: { code: 'not_found', message: '接口不存在' } })
      return
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && wantsHtml(request) && hasWeb) {
      reply.type('text/html; charset=utf-8').sendFile('index.html', webRoot)
      return
    }
    reply.code(404).send({ error: { code: 'not_found', message: '未找到' } })
  })

  app.server.on('upgrade', (request, socket, head) => {
    try {
      proxy.handleUpgrade(request, socket as unknown as import('node:net').Socket, head)
    } catch (error) {
      // 兜底：升级路径异常不得让进程退出（进程重启会中断所有会话/上传）。
      app.log.error({ err: error }, 'WebSocket 升级处理异常')
      socket.destroy()
    }
  })

  app.addHook('onClose', async () => {
    alerts.stop()
    proxy.close()
  })

  function runMaintenance(): void {
    try {
      files.autoPurge(config.trashRetentionDays)
      shares.cleanup()
      auth.cleanup()
      purgeAudit(db, config.auditRetentionDays)
    } catch (error) {
      app.log.error({ err: error }, '日常维护失败')
    }
  }

  return { app, db, config, auth, files, mc, dashboard, notes, bookmarks, shares, alerts, proxy, runMaintenance }
}
