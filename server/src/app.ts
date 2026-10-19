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
import { OpenCodeProxy, normalizeHost } from './opencode/proxy.ts'
import { purgeAudit } from './auth/audit.ts'
import { readSessionToken } from './auth/cookies.ts'
import { registerErrorHandler } from './http/errors.ts'
import { registerAuthRoutes } from './http/routes/auth.ts'
import { registerFileRoutes } from './http/routes/files.ts'
import { registerMcRoutes } from './http/routes/mc.ts'
import { registerDashboardRoutes } from './http/routes/dashboard.ts'
import { wantsHtml } from './http/util.ts'

export interface AppContext {
  app: FastifyInstance
  db: DatabaseSync
  config: Config
  auth: AuthService
  files: FileService
  mc: MinecraftService
  dashboard: DashboardService
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
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

export async function buildApp(config: Config, db: DatabaseSync): Promise<AppContext> {
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    exposeHeadRoutes: true,
  })

  const auth = new AuthService(db, config)
  const files = new FileService(db, config)
  const mc = new MinecraftService(db, config)
  const dashboard = new DashboardService(db, config, files, mc)
  const proxy = new OpenCodeProxy(config, auth)

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
        }
      },
    })
  } else {
    app.log.warn({ webRoot }, 'web/dist 不存在：仅提供 API（开发时请用 Vite）')
  }

  // 安全响应头（AI 反代由 opencode 自己控制 CSP，不覆盖）。
  app.addHook('onSend', async (request, reply, payload) => {
    const host = normalizeHost(request.headers.host)
    if (proxy.isAiHost(host)) return payload
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    const path = request.raw.url ?? ''
    if (path.startsWith('/api/') || path === '/healthz') {
      reply.header('cache-control', 'no-store')
    }
    const contentType = String(reply.getHeader('content-type') ?? '')
    if (contentType.includes('text/html')) {
      reply.header('content-security-policy', CSP)
      reply.header('x-frame-options', 'SAMEORIGIN')
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  // Host 分流：ai → 代理；app/loopback → 应用；未知 → 404。
  app.addHook('onRequest', async (request, reply) => {
    const host = normalizeHost(request.headers.host)
    if (proxy.isAiHost(host)) {
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
  registerFileRoutes(app, config, files)
  registerMcRoutes(app, config, mc)
  registerDashboardRoutes(app, config, dashboard, db)

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
    proxy.handleUpgrade(request, socket as unknown as import('node:net').Socket, head)
  })

  app.addHook('onClose', async () => {
    proxy.close()
  })

  function runMaintenance(): void {
    try {
      files.autoPurge(config.trashRetentionDays)
      auth.cleanup()
      purgeAudit(db, config.auditRetentionDays)
    } catch (error) {
      app.log.error({ err: error }, '日常维护失败')
    }
  }

  return { app, db, config, auth, files, mc, dashboard, proxy, runMaintenance }
}
