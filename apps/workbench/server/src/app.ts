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
import { SUPPORTED_SCHEMA_VERSION } from './db.ts'
import { AuthService } from './auth/service.ts'
import { FileService } from './files/service.ts'
import { MinecraftService } from './mc/service.ts'
import { DashboardService } from './dashboard/service.ts'
import { NoteService, BookmarkService } from './notes/service.ts'
import { ShareService } from './shares/service.ts'
import { AlertService } from './alerts/service.ts'
import { BackupService } from './backups/service.ts'
import { UploadService } from './uploads/service.ts'
import { OpenCodeProxy, normalizeHost } from './opencode/proxy.ts'
import { MetricsService } from './metrics/service.ts'
import { createMetricsSampler } from './metrics/sampler.ts'
import { purgeAudit, audit } from './auth/audit.ts'
import { readSessionToken } from './auth/cookies.ts'
import { registerErrorHandler } from './http/errors.ts'
import { registerAuthRoutes } from './http/routes/auth.ts'
import { registerFileRoutes } from './http/routes/files.ts'
import { registerMcRoutes } from './http/routes/mc.ts'
import { registerDashboardRoutes } from './http/routes/dashboard.ts'
import { registerNoteRoutes } from './http/routes/notes.ts'
import { registerShareRoutes } from './http/routes/shares.ts'
import { registerAlertRoutes } from './http/routes/alerts.ts'
import { registerBackupRoutes } from './http/routes/backups.ts'
import { registerUploadRoutes } from './http/routes/uploads.ts'
import { registerMetricsRoutes } from './http/routes/metrics.ts'
import { ChatbotService } from './chatbot/service.ts'
import { OpenCodeBotAi } from './chatbot/ai.ts'
import { SearxngSearchClient } from './chatbot/search.ts'
import { registerBotRoutes } from './http/routes/chatbots.ts'
import { registerBotWebhookRoutes } from './http/routes/chatbot-webhook.ts'
import { registerBotAiToolRoutes } from './http/routes/chatbot-ai-tool.ts'
import { McbotService } from './mcbot/service.ts'
import { registerLofiiRoutes } from './http/routes/mcbot.ts'
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
  backups: BackupService
  uploads: UploadService
  metrics: MetricsService
  chatbots: ChatbotService
  proxy: OpenCodeProxy
  /** v0.8.0 mcbot Minecraft Chatbot 对接（禁用时 snapshot 为 enabled:false）。 */
  mcbot: McbotService
  /** listen 成功后启动指标采样（metricsEnabled=false 时空操作；重复调用幂等）。 */
  startMetrics(): void
  /** listen 成功后启动 Chatbot 投递/发布队列（Chatbot 未启用时为空操作；重复调用幂等）。 */
  startBots(): void
  /** listen 成功后启动 mcbot 状态/事件轮询（未启用时为空操作；重复调用幂等）。 */
  startLofii(): void
  runMaintenance(): void
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
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
  // 分享吊销钩子：FileService 先构造，闭包延迟引用后构造的 ShareService（避免循环依赖）。
  let sharesRef: ShareService | null = null
  const files = new FileService(db, config, app.log, {
    revokeSharesForFiles: (fileIds) => {
      sharesRef?.revokeSharesForFiles(fileIds)
    },
  })
  const mc = new MinecraftService(db, config)
  const dashboard = new DashboardService(db, config, files, mc)
  const notes = new NoteService(db, {
    files,
    config,
    log: {
      warn: (obj, message) => app.log.warn(obj, message),
    },
  })
  const bookmarks = new BookmarkService(db)
  const shares = new ShareService(db, config)
  sharesRef = shares
  const metrics = new MetricsService(db)
  // 复用 DashboardService 的 HostMonitor 采集 CPU，避免两个采样器互相覆盖 CPU 基线。
  const metricsSampler = createMetricsSampler({
    config,
    metrics,
    host: { snapshot: () => dashboard.hostSnapshot() },
    files,
    log: (level, message, detail) => app.log[level](detail ?? {}, message),
  })
  const chatbots = new ChatbotService({
    db,
    config,
    log: (level, message, detail) => {
      const payload = detail ? { detail } : {}
      if (level === 'error') app.log.error(payload, message)
      else if (level === 'warn') app.log.warn(payload, message)
      else app.log.info(payload, message)
    },
    audit: (action, target, detail) => audit(db, 'chatbot', action, target, detail, null),
    ai: new OpenCodeBotAi({
      db,
      config,
      log: (level, message, detail) => {
        const payload = detail ? { detail } : {}
        if (level === 'error') app.log.error(payload, message)
        else if (level === 'warn') app.log.warn(payload, message)
        else app.log.info(payload, message)
      },
    }),
    ...(config.chatbotSearchEnabled
      ? {
          search: new SearxngSearchClient({
            baseUrl: config.chatbotSearchUrl,
            timeoutMs: config.chatbotSearchTimeoutSeconds,
            maxResults: config.chatbotSearchMaxResults,
            language: config.chatbotSearchLanguage,
            safeSearch: config.chatbotSearchSafeSearch,
            maxSnippetChars: config.chatbotSearchMaxSnippetChars,
            engines: config.chatbotSearchEngines,
          }),
        }
      : {}),
    providers: {
      status: async () => {
        const data = await dashboard.get()
        return {
          应用版本: config.appVersion,
          Minecraft: data.minecraft.online ? '在线' : '离线',
          玩家: `${data.minecraft.players.online}/${data.minecraft.players.max}`,
          服务: `${data.services.minecraft}/${data.services.cloudflared}/${data.services.opencode}`,
          备份待确认: data.backup?.pendingCount ?? null,
          生成时间: data.generatedAt,
        }
      },
      backup: async () => {
        const backup = (await dashboard.get()).backup
        if (!backup) return { 状态: '未知' }
        return {
          ok: backup.ok,
          最近拉取: backup.lastPullAt,
          待确认: backup.pendingCount,
          密钥包: backup.secretsOk,
          错误: backup.lastError,
        }
      },
      world: async () => {
        const backup = (await dashboard.get()).backup
        return { 世界备份: backup?.world ?? null, 拉取: backup?.worldPull ?? null, 演练: backup?.drill ?? null }
      },
      minecraft: async () => {
        const status = await mc.status()
        return {
          online: status.online,
          玩家: `${status.players.online}/${status.players.max}`,
          version: status.version,
          error: status.error,
        }
      },
      files: async (query: string) =>
        files.search(query, 10).items.map((item) => ({
          name: item.name,
          sizeLabel: item.size >= 1024 * 1024 ? `${Math.round(item.size / 1024 / 1024)} MB` : `${Math.max(1, Math.round(item.size / 1024))} KB`,
        })),
    },
  })
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
    notifyEvent: (event) => chatbots.notifyAlert(event),
  })
  // mcbot 轮询依赖 AlertService.recordExternal；禁用时无定时器、无网络请求。
  const mcbot = new McbotService({
    db,
    config,
    alerts,
    log: (level, message, detail) => {
      const payload = detail ? { detail } : {}
      if (level === 'error') app.log.error(payload, message)
      else if (level === 'warn') app.log.warn(payload, message)
      else app.log.info(payload, message)
    },
  })
  const proxy = new OpenCodeProxy(config, auth, app.log, {
    audit: (action, target, detail, ip) => audit(db, 'anonymous', action, target, detail, ip),
  })
  const backups = new BackupService(db, config, {
    files,
    logger: (level, message, detail) => {
      const payload = detail ? { detail } : {}
      if (level === 'error') app.log.error(payload, message)
      else if (level === 'warn') app.log.warn(payload, message)
      else app.log.info(payload, message)
    },
  })
  const uploads = new UploadService(db, config, files)

  await app.register(cookie)
  // octet-stream 全局兜底只使用实例默认 1 MiB 上限；分片上传的 8 MiB 级 raw body 上限
  // 在 uploads 路由的独立 scope 内覆盖（见 http/routes/uploads.ts），避免公开/无关端点
  // 在鉴权与 Origin/限流校验之前缓冲大 body。
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  )
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
    const pending = db
      .prepare('SELECT COUNT(*) AS c FROM backup_archives WHERE acked_at IS NULL AND deleted_at IS NULL')
      .get() as { c: number }
    return {
      ok: true,
      version: config.appVersion,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      /** 轻量就绪信息（不含敏感数据）：DB 可读 + 待确认备份数量。 */
      db: 'ok',
      pendingBackups: Number(pending.c),
    }
  })

  registerAuthRoutes(app, config, auth)
  registerFileRoutes(app, config, files, (id) => shares.revokeForFileTree(id))
  registerMcRoutes(app, config, mc)
  registerDashboardRoutes(app, config, dashboard, db)
  registerNoteRoutes(app, config, notes, bookmarks, files)
  registerShareRoutes(app, config, shares)
  registerAlertRoutes(app, config, alerts)
  registerBackupRoutes(app, config, backups, db)
  registerUploadRoutes(app, config, uploads)
  registerMetricsRoutes(app, metrics)
  registerBotRoutes(app, config, chatbots, auth)
  registerBotWebhookRoutes(app, config, chatbots)
  registerBotAiToolRoutes(app, chatbots)
  registerLofiiRoutes(app, config, mcbot, db)

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
    mcbot.stop()
    alerts.stop()
    metricsSampler.stop()
    // ARCH-04：关闭前有限等待 Chatbot 在途回复/工具缓冲/投递排空，避免部署/重启丢回复或重复投递。
    // 最多等 15s，超时仍继续关闭（不阻塞 systemd stop），并记录警告。
    const drain = chatbots.waitForIdle().catch((error: unknown) => {
      app.log.warn({ err: error }, 'Chatbot 关闭排空失败')
    })
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 15_000)
      timer.unref?.()
    })
    await Promise.race([drain, timeout])
    chatbots.stop()
    proxy.close()
  })

  function startMetrics(): void {
    if (!config.metricsEnabled) return
    metricsSampler.start()
  }

  function startBots(): void {
    chatbots.start()
  }

  function startLofii(): void {
    mcbot.start()
  }

  function runMaintenance(): void {
    // 每个维护任务独立隔离：单个任务失败不能阻断其余清理（否则一个异常会长期堆积全部数据）。
    const tasks: Array<[string, () => unknown]> = [
      ['回收站清理', () => files.autoPurge(config.trashRetentionDays)],
      ['分享清理', () => shares.cleanup()],
      ['备份清理', () => backups.cleanup()],
      ['分片上传过期清理', () => uploads.cleanupExpired()],
      ['分片上传孤儿目录清理', () => uploads.cleanupOrphanSessions()],
      ['终态上传会话清理', () => uploads.cleanupTerminalSessions()],
      ['笔记附件孤儿清理', () => notes.cleanupOrphanAttachments()],
      ['文件物理孤儿清理', () => files.cleanupOrphanFiles()],
      ['指标保留清理', () => metrics.prune(config.metricsRetentionDays)],
      ['认证数据清理', () => auth.cleanup()],
      ['审计保留清理', () => purgeAudit(db, config.auditRetentionDays)],
    ]
    for (const [name, task] of tasks) {
      try {
        task()
      } catch (error) {
        app.log.error({ err: error, task: name }, '日常维护任务失败')
      }
    }
  }

  return {
    app,
    db,
    config,
    auth,
    files,
    mc,
    dashboard,
    notes,
    bookmarks,
    shares,
    alerts,
    backups,
    uploads,
    metrics,
    chatbots,
    proxy,
    mcbot,
    startMetrics,
    startBots,
    startLofii,
    runMaintenance,
  }
}
