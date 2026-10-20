/**
 * 备份管理 HTTP 路由：清单、生成、导入、校验、恢复计划/执行、归档内容浏览。
 *
 * 安全边界：全部端点需要登录；写操作额外校验 CSRF；危险操作（prepare/import/restore-plan/execute）
 * 还要求 TOTP 再认证 + 限流 + 明确确认词；不暴露归档下载、TOTP 或服务器路径。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { BackupService } from '../../backups/service.ts'
import type { Config } from '../../config.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { badRequest, rateLimited, unauthorized } from '../../util/errors.ts'
import { asRecord, actorFrom, clientIp } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

function totpOf(request: FastifyRequest, body?: Record<string, unknown>): unknown {
  const header = request.headers['x-totp-code']
  if (typeof header === 'string' && header.trim()) return header.trim()
  return body?.totpCode
}

function requireConfirm(value: unknown, expected: string): void {
  if (typeof value !== 'string' || value.trim().toUpperCase() !== expected) {
    throw badRequest(`危险操作需要输入 ${expected} 确认`, 'confirmation_failed')
  }
}

export function registerBackupRoutes(app: FastifyInstance, config: Config, backups: BackupService): void {
  const csrf = csrfGuard(config)
  const prepareLimiter = new SlidingWindowLimiter(60 * 60_000, 3)
  const importLimiter = new SlidingWindowLimiter(60 * 60_000, 10)
  const verifyLimiter = new SlidingWindowLimiter(60 * 60_000, 20)
  const planLimiter = new SlidingWindowLimiter(60 * 60_000, 10)
  const executeLimiter = new SlidingWindowLimiter(60 * 60_000, 5)
  // 归档内容浏览会解包 DB 快照，按 IP 限流避免被反复触发消耗 CPU/磁盘。
  const entriesLimiter = new SlidingWindowLimiter(60_000, 30)

  function limit(limiter: SlidingWindowLimiter, key: string): void {
    const retry = limiter.hit(key)
    if (retry > 0) throw rateLimited(retry)
  }

  function contextOf(request: FastifyRequest): { userId: string } {
    const context = request.auth
    if (!context) throw unauthorized()
    return { userId: context.user.id }
  }

  // ---------- 清单 ----------

  app.get('/api/backups', { preHandler: [requireAuth] }, async () => {
    return backups.list()
  })

  // ---------- 生成归档（仅 pending，不 ack） ----------

  app.post('/api/backups/prepare', { preHandler: [requireAuth, csrf] }, async (request) => {
    const { userId } = contextOf(request)
    limit(prepareLimiter, userId)
    const body = asRecord(request.body)
    backups.verifyReauth(userId, totpOf(request, body))
    requireConfirm(body.confirmText, 'PREPARE')
    return backups.prepare(actorFrom(request), { full: body.full === true })
  })

  // ---------- 导入归档（multipart，TOTP 走请求头） ----------

  app.post('/api/backups/import', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const { userId } = contextOf(request)
    limit(importLimiter, userId)
    backups.verifyReauth(userId, totpOf(request))
    if (!request.isMultipart()) throw badRequest('需要 multipart/form-data 请求', 'invalid_multipart')
    let result: Awaited<ReturnType<BackupService['importArchive']>> | null = null
    for await (const part of request.parts()) {
      if (part.type === 'field') continue
      if (part.fieldname !== 'file' || result || !part.filename) {
        part.file.resume()
        continue
      }
      result = await backups.importArchive(actorFrom(request), {
        filename: part.filename,
        stream: part.file,
      })
    }
    if (!result) throw badRequest('未收到归档文件（字段名 file）', 'invalid_file')
    reply.code(201)
    return result
  })

  // ---------- 校验归档 ----------

  app.post('/api/backups/verify', { preHandler: [requireAuth, csrf] }, async (request) => {
    const { userId } = contextOf(request)
    limit(verifyLimiter, userId)
    const body = asRecord(request.body)
    const verified = await backups.verify(actorFrom(request), String(body.name ?? ''))
    return { ok: true, archive: verified.archive }
  })

  // ---------- 浏览归档内快照 ----------

  app.get('/api/backups/archives/:name/entries', { preHandler: [requireAuth] }, async (request) => {
    limit(entriesLimiter, clientIp(request))
    const params = request.params as { name: string }
    const query = asRecord(request.query)
    return backups.listArchiveEntries(params.name, query.path)
  })

  // ---------- 恢复计划与执行 ----------

  app.post('/api/backups/restore-plan', { preHandler: [requireAuth, csrf] }, async (request) => {
    const { userId } = contextOf(request)
    limit(planLimiter, userId)
    const body = asRecord(request.body)
    backups.verifyReauth(userId, totpOf(request, body))
    requireConfirm(body.confirmText, 'RESTORE')
    const plan = await backups.createRestorePlan(actorFrom(request), {
      archive: body.archive,
      paths: body.paths,
      targetName: body.targetName,
    })
    return { plan }
  })

  app.get('/api/restores/:planId', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { planId: string }
    return { plan: backups.getRestorePlan(params.planId) }
  })

  app.post('/api/restores/:planId/execute', { preHandler: [requireAuth, csrf] }, async (request) => {
    const { userId } = contextOf(request)
    limit(executeLimiter, userId)
    const body = asRecord(request.body)
    backups.verifyReauth(userId, totpOf(request, body))
    requireConfirm(body.confirmText, 'RESTORE')
    const params = request.params as { planId: string }
    return backups.executeRestore(actorFrom(request), params.planId)
  })
}
