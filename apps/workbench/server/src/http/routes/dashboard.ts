/** 仪表盘、审计、版本信息路由。 */
import { existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { DashboardService } from '../../dashboard/service.ts'
import type { DatabaseSync } from 'node:sqlite'
import { getAuditDiagnostics, listAudit } from '../../auth/audit.ts'
import { SUPPORTED_SCHEMA_VERSION } from '../../db.ts'
import { badRequest } from '../../util/errors.ts'
import { asRecord, parsePositiveInt } from '../util.ts'
import { requireAuth } from '../guards.ts'
import { CHATBOT_PLATFORMS } from '../../chatbot/types.ts'

/** 时间过滤参数：空值忽略；非法 ISO 时间返回 400，避免静默变全量查询。 */
function timeParam(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw badRequest(`参数 ${field} 必须是 ISO 时间`, 'invalid_request')
  return new Date(Date.parse(text)).toISOString()
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  config: Config,
  dashboard: DashboardService,
  db: DatabaseSync,
): void {
  app.get('/api/dashboard', { preHandler: [requireAuth] }, async () => dashboard.get())

  // 轻量存储用量：Files/Trash 页面轮询使用，语义与 dashboard.storage 完全一致。
  app.get('/api/storage', { preHandler: [requireAuth] }, async () => dashboard.storage())

  app.get('/api/audit', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    return listAudit(db, {
      limit: parsePositiveInt(query.limit, 50, 1, 200),
      offset: parsePositiveInt(query.offset, 0, 0, 100_000),
      action: typeof query.action === 'string' && query.action ? query.action : null,
      q: typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 200) : null,
      from: timeParam(query.from, 'from'),
      to: timeParam(query.to, 'to'),
    })
  })

  app.get('/api/version', { preHandler: [requireAuth] }, async () => ({
    version: config.appVersion,
    /** 当前程序支持的 schema 版本；前端用于演练/升级一致性提示（v0.7.0）。 */
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    appOrigin: config.appOrigin,
    aiOrigin: config.aiOrigin,
    trashRetentionDays: config.trashRetentionDays,
    maxUploadBytes: config.maxUploadBytes,
    sharesEnabled: config.sharesEnabled,
    alertsEnabled: config.alertsEnabled,
    backupRestoreEnabled: config.backupRestoreEnabled,
    backupImportMaxBytes: config.backupImportMaxBytes,
    backupRestoreMaxEntries: config.backupRestoreMaxEntries,
    /** 加密/异地副本只读状态（不含密钥/路径）。 */
    backupArchiveEncryption: config.backupArchiveEncryption,
    backupAgeRecipientConfigured: existsSync(config.backupAgeRecipientFile),
    backupOffsiteStatusConfigured: existsSync(config.backupOffsiteStatusFile),
    chunkedUploadEnabled: config.chunkedUploadEnabled,
    chunkSizeBytes: config.chunkSizeBytes,
    chunkMaxFileBytes: config.chunkMaxFileBytes,
    noteAttachmentMaxBytes: config.noteAttachmentMaxBytes,
    noteMaxAttachments: config.noteMaxAttachments,
    noteVersionsKeep: config.noteVersionsKeep,
    shareMaxItems: config.shareMaxItems,
    metricsEnabled: config.metricsEnabled,
    metricsSampleSeconds: config.metricsSampleSeconds,
    metricsRetentionDays: config.metricsRetentionDays,
    chatbotsEnabled: config.chatbotEnabled && config.chatbotSecretKey.length > 0,
    chatbotPlatforms: [...CHATBOT_PLATFORMS],
    /** v0.8.0 mcbot 对接开关与控制能力（控制 Token 为空 = 只读）。 */
    mcbotEnabled: config.mcbotEnabled,
    mcbotControlEnabled: config.mcbotEnabled && config.mcbotControlToken.length > 0,
    /** 审计写入诊断：失败计数/最近错误（不含明细），用于发现 DB 忙/磁盘满导致的审计丢失。 */
    audit: getAuditDiagnostics(db),
  }))
}
