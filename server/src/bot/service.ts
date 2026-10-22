/**
 * Bot 平台服务：配置 CRUD、Webhook 验签/命令分发、通知/发布队列与投递重试。
 * 安全边界：凭据只以密文落库；Webhook 无 session/CSRF，签名是唯一鉴权；
 * 命令只读且必须命中 bot_targets.allow_commands；发布只允许登录管理员调用。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import { AppError, badRequest, notFound } from '../util/errors.ts'
import { newId } from '../util/ids.ts'
import { isoAfterSeconds, nowIso } from '../util/time.ts'
import { SlidingWindowLimiter } from '../auth/limiter.ts'
import {
  BOT_COMMANDS,
  isBotPlatform,
  type BotDelivery,
  type BotDeliveryRow,
  type BotAiMode,
  type BotInboundTarget,
  type BotInboundTargetRow,
  type BotMetrics,
  type BotPlatform,
  type BotPublishJob,
  type BotPublishRow,
  type BotRow,
  type BotSecret,
  type BotServiceDeps,
  type BotStatus,
  type BotSummary,
  type BotTarget,
  type BotTargetRow,
  type InboundVerification,
  type OutboundMedia,
} from './types.ts'
import { decodeBotKey, decryptBotSecret, encryptBotSecret } from './crypto.ts'
import { BotMemoryStore } from './memory.ts'
import { buildBotPrompt } from './prompts.ts'
import { DiscordGatewayManager } from './discord-gateway.ts'
import { BotConnectivityMonitor, type ConnectivitySnapshot } from './connectivity.ts'
import { DiscordAdapter } from './adapters/discord.ts'
import { QqAdapter } from './adapters/qq.ts'
import { SlackAdapter } from './adapters/slack.ts'
import { TelegramAdapter } from './adapters/telegram.ts'
import { commandDenied, commandFailed, formatFileList, formatPairs, helpText } from './templates.ts'

const NAME_MAX = 80
const TARGET_MAX = 128
const TEXT_MAX = 4096
const MAX_TARGETS_PER_BOT = 100
const MAX_INBOUND_TARGETS_PER_BOT = 500
const STATUS_BUTTONS = [
  { id: 'refresh_status' as const, label: '刷新状态' },
  { id: 'help' as const, label: '帮助' },
]

export interface CreateBotInput {
  platform: BotPlatform
  name: string
  token: string
  config?: Record<string, unknown>
  webhookSecret?: string
  publicKey?: string
  signingSecret?: string
}

export interface UpdateBotInput {
  name?: string
  enabled?: boolean
  config?: Record<string, unknown>
  token?: string
  webhookSecret?: string
  publicKey?: string
  signingSecret?: string
}

export interface CreateTargetInput {
  externalId: string
  label: string
  kind: 'channel' | 'user' | 'group'
  allowCommands: boolean
  allowNotifications: boolean
  allowChat?: boolean
  quietStartMinute?: number | null
  quietEndMinute?: number | null
}

export interface UpdateTargetInput {
  label?: string
  kind?: 'channel' | 'user' | 'group'
  allowCommands?: boolean
  allowNotifications?: boolean
  allowChat?: boolean
  quietStartMinute?: number | null
  quietEndMinute?: number | null
}

export interface CreatePublishInput {
  targetId: string
  text: string
  mediaFileIds?: string[]
  scheduledAt?: string | null
  /** 二次确认文本，必须为 PUBLISH（服务端校验）。 */
  confirmText?: string
}

export interface BotAlertEvent {
  id: number | string
  event: string
  severity: string
  status: string
  title: string
  message: string
  createdAt: string
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 32 && code !== 127) text += char
  }
  return text.trim().slice(0, max)
}

/** 通知/命令回复只保留用户可见文本，去除内部路径与 URL（审计 BOT-04）。 */
function sanitizeExternalText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:\\|\/(?:home|var|etc|opt|run|proc|sys|tmp)\/)[^\s"'`]+/g, '[path]')
    .replace(/(?:ssh|https?):\/\/[^\s"'`]+/g, '[url]')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 1500)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 目标静默时段：Asia/Shanghai 本地分钟；起止相等视为未配置。 */
function localMinute(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

function inQuietWindow(now: Date, target: BotTargetRow): boolean {
  const start = target.quiet_start_minute
  const end = target.quiet_end_minute
  if (start === null || end === null || start === end) return false
  const minute = localMinute(now)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** 静默窗口结束时刻（最多向后找 24 小时，按上海本地分钟匹配）。 */
function quietUntil(now: Date, target: BotTargetRow): Date {
  const end = target.quiet_end_minute ?? 0
  for (let offset = 1; offset <= 24 * 60; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 60_000)
    if (localMinute(candidate) === end) return candidate
  }
  return new Date(now.getTime() + 24 * 3_600_000)
}

function parseConfig(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown
    return asRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

export class BotService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly deps: BotServiceDeps
  private readonly key: Buffer | null
  private readonly limiter: SlidingWindowLimiter
  private readonly webhookLimiter: SlidingWindowLimiter
  private readonly aiLimiter: SlidingWindowLimiter
  private readonly chatLimiter: SlidingWindowLimiter
  private readonly memory: BotMemoryStore
  private readonly gateway: DiscordGatewayManager
  private readonly connectivity: BotConnectivityMonitor
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private ticking = false
  private readonly pending = new Set<Promise<void>>()

  constructor(deps: BotServiceDeps) {
    this.db = deps.db
    this.config = deps.config
    this.deps = deps
    this.limiter = new SlidingWindowLimiter(60_000, Math.max(1, deps.config.botCommandRatePerMinute))
    this.webhookLimiter = new SlidingWindowLimiter(60_000, 300)
    this.aiLimiter = new SlidingWindowLimiter(3_600_000, Math.max(1, deps.config.botAiRatePerHour))
    this.chatLimiter = new SlidingWindowLimiter(60_000, Math.max(1, deps.config.botChatRatePerMinute))
    this.memory = new BotMemoryStore(deps.db, deps.config.dataDir, deps.config.botAiMemoryMaxChars)
    this.gateway = new DiscordGatewayManager({
      enabled: deps.config.botDiscordGatewayEnabled,
      log: deps.log,
      getBots: () => this.gatewayBots(),
      onMessage: (event) => {
        void this.handleGatewayMessage(event.botId, event).catch((error: unknown) => {
          this.deps.log('warn', 'Discord Gateway 消息处理失败', {
            bot: event.botId,
            error: error instanceof Error ? error.message : 'unknown',
          })
        })
      },
    })
    this.connectivity = new BotConnectivityMonitor({
      enabled: deps.config.botEnabled && deps.config.botConnectivityEnabled,
      intervalSeconds: deps.config.botConnectivityIntervalSeconds,
      timeoutSeconds: deps.config.botConnectivityTimeoutSeconds,
      proxyUrl: deps.config.botProxyUrl,
      getPlatforms: () => this.enabledPlatforms(),
      log: deps.log,
      onRecover: () => {
        this.gateway.wake()
        this.scheduleTick()
      },
    })
    try {
      this.key = decodeBotKey(deps.config.botSecretKey)
    } catch {
      throw new AppError(500, 'bot_key_invalid', 'BOT_SECRET_KEY 配置无效')
    }
  }

  get enabled(): boolean {
    return this.config.botEnabled && this.key !== null
  }

  private requireEnabled(): void {
    if (!this.config.botEnabled) throw new AppError(503, 'bot_disabled', 'Bot 功能未启用')
    if (!this.key) throw new AppError(503, 'bot_key_missing', '未配置 BOT_SECRET_KEY')
  }

  status(): BotStatus {
    const bots = this.db.prepare('SELECT COUNT(*) AS c FROM bots').get() as { c: number }
    const enabledBots = this.db.prepare('SELECT COUNT(*) AS c FROM bots WHERE enabled = 1').get() as { c: number }
    const targets = this.db.prepare('SELECT COUNT(*) AS c FROM bot_targets').get() as { c: number }
    const deliveries = this.db
      .prepare("SELECT COUNT(*) AS c FROM bot_deliveries WHERE status IN ('queued','sending','failed')")
      .get() as { c: number }
    const publishes = this.db
      .prepare("SELECT COUNT(*) AS c FROM bot_publish_jobs WHERE status IN ('queued','sending')")
      .get() as { c: number }
    const lastError = this.db
      .prepare("SELECT last_error FROM bots WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
      .get() as { last_error: string } | undefined
    return {
      enabled: this.enabled,
      keyConfigured: this.key !== null,
      bots: bots.c,
      enabledBots: enabledBots.c,
      targets: targets.c,
      queuedDeliveries: deliveries.c,
      queuedPublishes: publishes.c,
      lastError: lastError?.last_error ?? null,
    }
  }

  connectivityStatus(): ConnectivitySnapshot {
    return this.connectivity.snapshot()
  }

  async checkConnectivity(): Promise<ConnectivitySnapshot> {
    return this.connectivity.checkNow()
  }

  private enabledPlatforms(): BotPlatform[] {
    const rows = this.db
      .prepare('SELECT DISTINCT platform FROM bots WHERE enabled = 1')
      .all() as unknown as { platform: string }[]
    return rows.map((row) => row.platform).filter((platform): platform is BotPlatform => isBotPlatform(platform))
  }

  metrics(botId: string, hours = 24): BotMetrics {
    this.requireEnabled()
    this.botRow(botId)
    const windowHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)))
    const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString()
    const deliveries = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
         FROM bot_deliveries WHERE bot_id = ? AND created_at >= ?`,
      )
      .get(botId, cutoff) as { total: number; sent: number | null; failed: number | null; dead: number | null }
    const publishes = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM bot_publish_jobs WHERE bot_id = ? AND created_at >= ?`,
      )
      .get(botId, cutoff) as { total: number; sent: number | null; failed: number | null }
    const events = this.db
      .prepare('SELECT COUNT(*) AS c FROM bot_events WHERE bot_id = ? AND received_at >= ?')
      .get(botId, cutoff) as { c: number }
    const lastError = this.db
      .prepare(
        `SELECT last_error FROM (
           SELECT last_error, updated_at FROM bot_deliveries WHERE bot_id = ? AND last_error IS NOT NULL
           UNION ALL
           SELECT last_error, updated_at FROM bot_publish_jobs WHERE bot_id = ? AND last_error IS NOT NULL
         ) ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(botId, botId) as { last_error: string } | undefined
    const lastSent = this.db
      .prepare(
        `SELECT sent_at FROM (
           SELECT sent_at FROM bot_deliveries WHERE bot_id = ? AND sent_at IS NOT NULL
           UNION ALL
           SELECT sent_at FROM bot_publish_jobs WHERE bot_id = ? AND sent_at IS NOT NULL
         ) ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(botId, botId) as { sent_at: string } | undefined
    const attempted = Number(deliveries.sent ?? 0) + Number(deliveries.failed ?? 0)
    return {
      hours: windowHours,
      deliveries: {
        total: deliveries.total,
        sent: Number(deliveries.sent ?? 0),
        failed: Number(deliveries.failed ?? 0),
        dead: Number(deliveries.dead ?? 0),
        successRate: attempted === 0 ? 0 : Math.round((Number(deliveries.sent ?? 0) / attempted) * 1000) / 10,
      },
      publishes: {
        total: publishes.total,
        sent: Number(publishes.sent ?? 0),
        failed: Number(publishes.failed ?? 0),
      },
      events: events.c,
      lastError: lastError?.last_error ?? null,
      lastSentAt: lastSent?.sent_at ?? null,
    }
  }

  listBots(): BotSummary[] {
    this.requireEnabled()
    const rows = this.db.prepare('SELECT * FROM bots ORDER BY created_at ASC').all() as unknown as BotRow[]
    return rows.map((row) => this.toSummary(row))
  }

  getBot(id: string): BotSummary {
    this.requireEnabled()
    return this.toSummary(this.botRow(id))
  }

  createBot(input: CreateBotInput): BotSummary {
    this.requireEnabled()
    if (!isBotPlatform(input.platform)) throw badRequest('不支持的平台')
    const name = cleanText(input.name, NAME_MAX)
    if (!name) throw badRequest('名称不能为空')
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM bots').get() as { c: number }
    if (count.c >= this.config.botMaxBots) throw badRequest(`最多配置 ${this.config.botMaxBots} 个 Bot`)
    const secret = this.normalizeSecret(input)
    const config = this.normalizeConfig(input.platform, input.config, input.publicKey)
    this.validateOrThrow(input.platform, config, secret)
    const encrypted = encryptBotSecret(this.key!, secret)
    const id = newId()
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.platform,
        name,
        JSON.stringify(config),
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.keyVersion,
        now,
        now,
      )
    this.deps.audit('bot.create', id, { platform: input.platform, name })
    this.syncGateway()
    return this.getBot(id)
  }

  updateBot(id: string, input: UpdateBotInput): BotSummary {
    this.requireEnabled()
    const row = this.botRow(id)
    const secret = this.secretOf(row)
    const nextSecret: BotSecret = {
      ...secret,
      token: cleanText(input.token, 500) || secret.token,
      webhookSecret: input.webhookSecret !== undefined ? cleanText(input.webhookSecret, 500) : secret.webhookSecret,
      signingSecret: input.signingSecret !== undefined ? cleanText(input.signingSecret, 500) : secret.signingSecret,
      publicKey: input.publicKey !== undefined ? cleanText(input.publicKey, 200) : secret.publicKey,
    }
    const nextConfig = input.config !== undefined ? this.normalizeConfig(row.platform, input.config, input.publicKey) : parseConfig(row.config_json)
    if (row.platform === 'discord' && input.publicKey) nextConfig.publicKey = cleanText(input.publicKey, 200)
    this.validateOrThrow(row.platform, nextConfig, nextSecret)
    const encrypted = encryptBotSecret(this.key!, nextSecret)
    const name = input.name !== undefined ? cleanText(input.name, NAME_MAX) : row.name
    if (!name) throw badRequest('名称不能为空')
    this.db
      .prepare(
        `UPDATE bots SET name = ?, enabled = ?, config_json = ?, secret_ciphertext = ?, secret_iv = ?, secret_tag = ?,
         key_version = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
      )
      .run(
        name,
        input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
        JSON.stringify(nextConfig),
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.keyVersion,
        nowIso(),
        id,
      )
    this.deps.audit('bot.update', id, { enabled: input.enabled, name })
    this.syncGateway()
    return this.getBot(id)
  }

  deleteBot(id: string): void {
    this.requireEnabled()
    this.botRow(id)
    this.db.prepare('DELETE FROM bots WHERE id = ?').run(id)
    this.deps.audit('bot.delete', id)
    this.syncGateway()
  }

  listTargets(botId: string): BotTarget[] {
    this.requireEnabled()
    this.botRow(botId)
    const rows = this.db
      .prepare('SELECT * FROM bot_targets WHERE bot_id = ? ORDER BY created_at ASC')
      .all(botId) as unknown as BotTargetRow[]
    return rows.map(toTarget)
  }

  /** 最近入站目标发现：只含平台 ID/类型/用户名/时间，不含消息正文。 */
  listInboundTargets(botId: string, limit = 50): BotInboundTarget[] {
    this.requireEnabled()
    this.botRow(botId)
    const rows = this.db
      .prepare('SELECT * FROM bot_inbound_targets WHERE bot_id = ? ORDER BY last_seen_at DESC LIMIT ?')
      .all(botId, Math.max(1, Math.min(200, limit))) as unknown as BotInboundTargetRow[]
    return rows.map((row) => ({
      botId: row.bot_id,
      targetExternalId: row.target_external_id,
      targetKind: row.target_kind,
      userId: row.user_id,
      userName: row.user_name,
      isDirect: row.is_direct === 1,
      lastSeenAt: row.last_seen_at,
    }))
  }

  createTarget(botId: string, input: CreateTargetInput): BotTarget {
    this.requireEnabled()
    this.botRow(botId)
    const externalId = cleanText(input.externalId, TARGET_MAX)
    const label = cleanText(input.label, NAME_MAX)
    if (!externalId || !label) throw badRequest('目标 ID 与名称不能为空')
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM bot_targets WHERE bot_id = ?').get(botId) as { c: number }
    if (count.c >= MAX_TARGETS_PER_BOT) throw badRequest('目标数量过多')
    const quiet = this.normalizeQuiet(input.quietStartMinute, input.quietEndMinute)
    const id = newId()
    try {
      this.db
        .prepare(
          `INSERT INTO bot_targets
           (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, allow_chat, quiet_start_minute, quiet_end_minute, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          botId,
          externalId,
          label,
          input.kind,
          input.allowCommands ? 1 : 0,
          input.allowNotifications ? 1 : 0,
          input.allowChat ? 1 : 0,
          quiet.start,
          quiet.end,
          nowIso(),
        )
    } catch {
      throw new AppError(409, 'conflict', '该目标已存在')
    }
    this.deps.audit('bot.target.create', `${botId}:${id}`, { kind: input.kind })
    return toTarget(this.targetRow(id))
  }

  updateTarget(botId: string, targetId: string, input: UpdateTargetInput): BotTarget {
    this.requireEnabled()
    this.botRow(botId)
    const row = this.targetRowForBot(botId, targetId)
    const label = input.label !== undefined ? cleanText(input.label, NAME_MAX) : row.label
    if (!label) throw badRequest('目标名称不能为空')
    const quiet = this.normalizeQuiet(
      input.quietStartMinute === undefined ? row.quiet_start_minute : input.quietStartMinute,
      input.quietEndMinute === undefined ? row.quiet_end_minute : input.quietEndMinute,
    )
    this.db
      .prepare(
        `UPDATE bot_targets
         SET label = ?, kind = ?, allow_commands = ?, allow_notifications = ?, allow_chat = ?, quiet_start_minute = ?, quiet_end_minute = ?
         WHERE id = ?`,
      )
      .run(
        label,
        input.kind ?? row.kind,
        input.allowCommands === undefined ? row.allow_commands : input.allowCommands ? 1 : 0,
        input.allowNotifications === undefined ? row.allow_notifications : input.allowNotifications ? 1 : 0,
        input.allowChat === undefined ? row.allow_chat : input.allowChat ? 1 : 0,
        quiet.start,
        quiet.end,
        targetId,
      )
    this.deps.audit('bot.target.update', `${botId}:${targetId}`)
    return toTarget(this.targetRowForBot(botId, targetId))
  }

  deleteTarget(botId: string, targetId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    this.targetRowForBot(botId, targetId)
    this.db.prepare('DELETE FROM bot_targets WHERE id = ?').run(targetId)
    this.deps.audit('bot.target.delete', `${botId}:${targetId}`)
  }

  listDeliveries(botId: string, limit = 50): BotDelivery[] {
    this.requireEnabled()
    this.botRow(botId)
    const rows = this.db
      .prepare('SELECT * FROM bot_deliveries WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(botId, Math.max(1, Math.min(200, limit))) as unknown as BotDeliveryRow[]
    return rows.map(toDelivery)
  }

  retryDelivery(botId: string, deliveryId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const result = this.db
      .prepare("UPDATE bot_deliveries SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND bot_id = ? AND status IN ('failed','dead')")
      .run(deliveryId, botId)
    if (Number(result.changes) === 0) throw notFound('投递记录不存在或不可重试')
    this.deps.audit('bot.delivery.retry', `${botId}:${deliveryId}`)
  }

  listPublishJobs(botId: string, limit = 50): BotPublishJob[] {
    this.requireEnabled()
    this.botRow(botId)
    const rows = this.db
      .prepare('SELECT * FROM bot_publish_jobs WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(botId, Math.max(1, Math.min(200, limit))) as unknown as BotPublishRow[]
    return rows.map(toPublishJob)
  }

  createPublish(botId: string, input: CreatePublishInput): BotPublishJob {
    this.requireEnabled()
    if (input.confirmText !== 'PUBLISH') throw badRequest('发布需要输入 PUBLISH 二次确认', 'publish_confirm_required')
    const bot = this.botRow(botId)
    const target = this.targetRowForBot(botId, input.targetId)
    if (target.kind === 'user') throw badRequest('发布目标必须是频道/群组')
    const text = cleanText(input.text, TEXT_MAX)
    if (!text) throw badRequest('发布内容不能为空')
    const platformLimit =
      bot.platform === 'discord' ? 2000 : bot.platform === 'slack' ? 4000 : bot.platform === 'qq' ? 2000 : 4096
    if (text.length > platformLimit) throw badRequest(`内容超过 ${platformLimit} 字符`)
    const mediaIds = Array.isArray(input.mediaFileIds) ? input.mediaFileIds.map((id) => cleanText(id, 64)).filter(Boolean) : []
    if (mediaIds.length > this.config.botPublishMaxMediaFiles) {
      throw badRequest(`单次发布最多选择 ${this.config.botPublishMaxMediaFiles} 个媒体文件`, 'too_many_media')
    }
    if (mediaIds.length > 0 && bot.platform === 'qq') throw badRequest('QQ 官方 Bot 暂不支持媒体发布', 'qq_media_unsupported')
    let mediaTotal = 0
    for (const mediaId of mediaIds) {
      const stat = this.deps.media.stat(mediaId)
      if (!stat) throw badRequest('媒体文件不存在或不可发布')
      if (stat.size > this.config.botPublishMaxMediaBytes) throw badRequest('媒体文件超过大小限制', 'media_too_large')
      mediaTotal += stat.size
    }
    if (mediaTotal > this.config.botPublishMaxMediaTotalBytes) {
      throw badRequest('媒体文件总大小超过限制', 'media_total_too_large')
    }
    const scheduledAt = this.parseSchedule(input.scheduledAt)
    const id = newId()
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO bot_publish_jobs (id, bot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(id, botId, target.id, JSON.stringify({ text }), JSON.stringify(mediaIds), scheduledAt, now, now)
    this.deps.audit('bot.publish.create', `${botId}:${id}`, { media: mediaIds.length, scheduled: Boolean(scheduledAt) })
    this.scheduleTick()
    return toPublishJob(this.publishRow(id))
  }

  cancelPublishJob(botId: string, jobId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const result = this.db
      .prepare("UPDATE bot_publish_jobs SET status = 'canceled', updated_at = ? WHERE id = ? AND bot_id = ? AND status IN ('queued','draft')")
      .run(nowIso(), jobId, botId)
    if (Number(result.changes) === 0) throw notFound('发布任务不存在或不可取消')
    this.deps.audit('bot.publish.cancel', `${botId}:${jobId}`)
  }

  testBot(botId: string, targetId?: string): Promise<void> {
    this.requireEnabled()
    const bot = this.botRow(botId)
    const target = targetId ? this.targetRowForBot(botId, targetId) : this.firstTarget(botId)
    if (!target) throw badRequest('请先配置目标')
    return this.sendTest(bot, target)
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  /** 调度一轮 tick 并纳入 pending，便于测试/关闭等待异步队列完全结束。 */
  private scheduleTick(): void {
    if (this.stopped) return
    const task = this.tick()
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  start(): void {
    if (!this.enabled || this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.scheduleTick(), this.config.botDeliveryIntervalSeconds * 1000)
    this.timer.unref()
    this.scheduleTick()
    this.gateway.start()
    this.connectivity.start()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.connectivity.stop()
    this.gateway.stop()
  }

  /** Bot 创建/更新/删除后同步 Gateway 连接集合。 */
  private syncGateway(): void {
    try {
      this.gateway.sync()
    } catch (error) {
      this.deps.log('warn', 'Discord Gateway 同步失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  private gatewayBots(): { botId: string; token: string; enabled: boolean; applicationId?: string }[] {
    const rows = this.db.prepare("SELECT * FROM bots WHERE platform = 'discord'").all() as unknown as BotRow[]
    const result: { botId: string; token: string; enabled: boolean; applicationId?: string }[] = []
    for (const row of rows) {
      try {
        const config = parseConfig(row.config_json)
        result.push({
          botId: row.id,
          token: this.secretOf(row).token,
          enabled: row.enabled === 1,
          applicationId: typeof config.applicationId === 'string' ? config.applicationId : undefined,
        })
      } catch {
        // 单个 Bot 凭据损坏不影响其它 Gateway 连接。
      }
    }
    return result
  }

  async tick(): Promise<void> {
    if (!this.enabled || this.stopped || this.ticking) return
    this.ticking = true
    try {
      this.recoverStaleQueue()
      await this.processDeliveries()
      await this.processPublishJobs()
      this.cleanup()
    } finally {
      this.ticking = false
    }
  }

  /** 进程重启/异常后，把长时间停留在 sending 的记录重新排队，避免永久卡死。 */
  private recoverStaleQueue(): void {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
    try {
      this.db
        .prepare("UPDATE bot_deliveries SET status = 'queued', next_attempt_at = NULL, updated_at = ? WHERE status = 'sending' AND updated_at < ?")
        .run(nowIso(), cutoff)
      this.db
        .prepare("UPDATE bot_publish_jobs SET status = 'queued', updated_at = ? WHERE status = 'sending' AND updated_at < ?")
        .run(nowIso(), cutoff)
    } catch {
      // 恢复失败不阻断本轮投递。
    }
  }

  notifyAlert(event: BotAlertEvent): void {
    if (!this.enabled) return
    const bots = this.db.prepare('SELECT * FROM bots WHERE enabled = 1').all() as unknown as BotRow[]
    for (const bot of bots) {
      const targets = this.db
        .prepare('SELECT * FROM bot_targets WHERE bot_id = ? AND allow_notifications = 1')
        .all(bot.id) as unknown as BotTargetRow[]
      for (const target of targets) {
        const text = [
          `【${event.severity}】${sanitizeExternalText(event.title)}`,
          sanitizeExternalText(event.message),
          `事件：${event.event}（${event.status}）`,
          `时间：${event.createdAt}`,
        ].join('\n')
        const now = this.deps.now?.() ?? new Date()
        const notBefore = inQuietWindow(now, target) ? quietUntil(now, target) : undefined
        this.enqueueDelivery(bot.id, target.id, 'notification', { text }, `alert:${event.id}:${bot.id}:${target.id}`, notBefore)
      }
    }
  }

  async processDeliveries(): Promise<void> {
    const now = nowIso()
    const rows = this.db
      .prepare(
        `SELECT * FROM bot_deliveries WHERE status IN ('queued','failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT 20`,
      )
      .all(now) as unknown as BotDeliveryRow[]
    for (const row of rows) {
      await this.deliverOne(row)
    }
  }

  private async deliverOne(row: BotDeliveryRow): Promise<void> {
    const claimed = this.db
      .prepare("UPDATE bot_deliveries SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('queued','failed')")
      .run(nowIso(), row.id)
    if (Number(claimed.changes) !== 1) return
    const delivery = this.db.prepare('SELECT * FROM bot_deliveries WHERE id = ?').get(row.id) as unknown as BotDeliveryRow
    if (delivery.status !== 'sending') return
    try {
      const bot = this.botRow(delivery.bot_id)
      if (!bot.enabled) throw new AppError(400, 'bot_disabled', 'Bot 已停用')
      const target = delivery.target_id ? this.targetRow(delivery.target_id) : null
      if (!target) throw new AppError(400, 'target_missing', '目标不存在')
      const payload = JSON.parse(delivery.payload_json) as { text?: unknown }
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) throw new AppError(400, 'empty_payload', '投递内容为空')
      const adapter = this.adapterFor(bot)
      const result = await adapter.send(target, { text })
      this.db
        .prepare("UPDATE bot_deliveries SET status = 'sent', external_id = ?, sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?")
        .run(result.externalId, nowIso(), nowIso(), delivery.id)
    } catch (error) {
      this.failDelivery(delivery, error)
    }
  }

  private failDelivery(delivery: BotDeliveryRow, error: unknown): void {
    const attempts = delivery.attempts + 1
    const message = error instanceof Error ? error.message.slice(0, 500) : '投递失败'
    if (attempts >= this.config.botDeliveryMaxAttempts) {
      this.db
        .prepare("UPDATE bot_deliveries SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, nowIso(), delivery.id)
      this.deps.log('warn', 'Bot 投递进入死信', { bot: delivery.bot_id, delivery: delivery.id })
      return
    }
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(6, attempts))
    this.db
      .prepare(
        "UPDATE bot_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(attempts, message, isoAfterSeconds(delaySeconds, new Date()), nowIso(), delivery.id)
  }

  async processPublishJobs(): Promise<void> {
    const now = nowIso()
    const rows = this.db
      .prepare(
        `SELECT * FROM bot_publish_jobs WHERE status = 'queued'
         AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY scheduled_at ASC LIMIT 10`,
      )
      .all(now) as unknown as BotPublishRow[]
    for (const row of rows) {
      await this.publishOne(row)
    }
  }

  private async publishOne(row: BotPublishRow): Promise<void> {
    const claimed = this.db
      .prepare("UPDATE bot_publish_jobs SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso(), row.id)
    if (Number(claimed.changes) !== 1) return
    const job = this.publishRow(row.id)
    if (job.status !== 'sending') return
    try {
      const bot = this.botRow(job.bot_id)
      if (!bot.enabled) throw new AppError(400, 'bot_disabled', 'Bot 已停用')
      const target = this.targetRow(job.target_id)
      const content = JSON.parse(job.content_json) as { text?: unknown }
      const text = typeof content.text === 'string' ? content.text : ''
      const mediaIds = JSON.parse(job.media_file_ids_json) as unknown
      const media: OutboundMedia[] = []
      if (Array.isArray(mediaIds)) {
        for (const mediaId of mediaIds) {
          if (typeof mediaId !== 'string') continue
          const stat = this.deps.media.stat(mediaId)
          if (!stat) throw new AppError(400, 'media_missing', '媒体文件不存在')
          if (stat.size > this.config.botPublishMaxMediaBytes) throw new AppError(400, 'media_too_large', '媒体文件超过大小限制')
          media.push(await this.deps.media.load(mediaId))
        }
      }
      const adapter = this.adapterFor(bot)
      const result = await adapter.send(target, { text, media })
      if (result.partial) {
        const message = '部分媒体已发送，需人工确认后重建发布任务'
        this.db
          .prepare("UPDATE bot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .run(this.config.botDeliveryMaxAttempts, message, nowIso(), job.id)
        this.deps.audit('bot.publish.partial', `${bot.id}:${job.id}`)
        return
      }
      this.db
        .prepare("UPDATE bot_publish_jobs SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?")
        .run(nowIso(), nowIso(), job.id)
      this.deps.audit('bot.publish.sent', `${bot.id}:${job.id}`, { externalId: result.externalId })
    } catch (error) {
      this.failPublish(job, error)
    }
  }

  private failPublish(job: BotPublishRow, error: unknown): void {
    const attempts = job.attempts + 1
    const partialIds =
      error && typeof error === 'object' && Array.isArray((error as { sentExternalIds?: unknown }).sentExternalIds)
        ? (error as { sentExternalIds: unknown[] }).sentExternalIds.filter((id): id is string => typeof id === 'string')
        : []
    const message = error instanceof Error ? error.message.slice(0, 500) : '发布失败'
    if (partialIds.length > 0) {
      // 多附件已部分外发，自动重试会重复发送；保留证据交管理员人工重建。
      this.db
        .prepare("UPDATE bot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(
          this.config.botDeliveryMaxAttempts,
          `partial_media_sent（已发送 ${partialIds.length} 个）：${message}`.slice(0, 500),
          nowIso(),
          job.id,
        )
      this.deps.audit('bot.publish.partial', `${job.bot_id}:${job.id}`, { sent: partialIds.length })
      return
    }
    if (attempts >= this.config.botDeliveryMaxAttempts) {
      this.db
        .prepare("UPDATE bot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, nowIso(), job.id)
      return
    }
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(6, attempts))
    this.db
      .prepare(
        "UPDATE bot_publish_jobs SET status = 'queued', attempts = ?, last_error = ?, scheduled_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(attempts, message, isoAfterSeconds(delaySeconds), nowIso(), job.id)
  }

  async handleWebhook(
    botId: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.config.botEnabled) return { status: 404, body: { error: { code: 'not_found' } } }
    if (!this.key) return { status: 404, body: { error: { code: 'not_found' } } }
    let bot: BotRow
    try {
      bot = this.botRow(botId)
    } catch {
      return { status: 404, body: { error: { code: 'not_found' } } }
    }
    if (!bot.enabled) return { status: 404, body: { error: { code: 'not_found' } } }
    if (this.webhookLimiter.hit(bot.id) > 0) {
      this.deps.audit('bot.webhook.rate_limited', bot.id)
      return { status: 429, body: { error: { code: 'rate_limited' } } }
    }
    let result: InboundVerification
    try {
      result = await this.adapterFor(bot).verifyInbound({ botId, headers, body })
    } catch {
      this.deps.log('warn', 'Bot Webhook 验签异常', { bot: bot.id })
      return { status: 400, body: { error: { code: 'invalid_request' } } }
    }
    if (result.kind === 'rejected') {
      this.deps.audit('bot.webhook.rejected', bot.id, { code: result.code })
      return { status: result.status, body: { error: { code: result.code } } }
    }
    if (result.kind === 'challenge') return { status: 200, body: result.body }
    if (result.kind === 'ignored') {
      if (result.detail) this.deps.audit('bot.event.ignored', bot.id, { event: result.detail.slice(0, 80) })
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO bot_events (bot_id, platform_event_id, received_at) VALUES (?, ?, ?)')
      .run(bot.id, result.eventId, nowIso())
    if (Number(inserted.changes) === 0) return { status: 200, body: result.ackBody ?? { ok: true, duplicate: true } }
    this.recordInbound(bot, result)
    if (result.kind === 'command') return this.dispatchCommand(bot, result)
    if (result.kind === 'chat') return this.dispatchChat(bot, result)
    return this.dispatchAction(bot, result)
  }

  /** Gateway 消息不经 HTTP 验签，由 Gateway 连接层完成 TLS/Token 鉴权；此处复用 Chat 授权与限流。 */
  async handleGatewayMessage(
    botId: string,
    event: {
      eventId: string
      targetExternalId: string
      targetKind: BotTargetRow['kind']
      userId: string
      userName: string | null
      text: string
      isDirect: boolean
      chatTrigger: 'direct' | 'mention' | 'reply'
    },
  ): Promise<void> {
    if (!this.enabled) return
    const bot = this.botRow(botId)
    if (!bot.enabled) return
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO bot_events (bot_id, platform_event_id, received_at) VALUES (?, ?, ?)')
      .run(bot.id, event.eventId, nowIso())
    if (Number(inserted.changes) === 0) return
    const target = this.inboundTarget(bot.id, event)
    this.recordInbound(bot, {
      kind: 'chat',
      eventId: event.eventId,
      targetExternalId: event.targetExternalId,
      targetKind: event.targetKind,
      userId: event.userId,
      userName: event.userName,
      text: event.text,
      isDirect: event.isDirect,
      chatTrigger: event.chatTrigger,
      reply: async (text: string) => {
        if (!target) return
        await this.adapterFor(bot).send(target, { text })
      },
    })
    await this.dispatchChat(bot, {
      kind: 'chat',
      eventId: event.eventId,
      targetExternalId: event.targetExternalId,
      targetKind: event.targetKind,
      userId: event.userId,
      userName: event.userName,
      text: event.text,
      isDirect: event.isDirect,
      chatTrigger: event.chatTrigger,
      reply: async (text: string) => {
        if (!target) return
        await this.adapterFor(bot).send(target, { text })
      },
    })
  }

  private recordInbound(bot: BotRow, result: Extract<InboundVerification, { kind: 'command' | 'chat' | 'action' }>): void {
    try {
      this.db
        .prepare(
          `INSERT INTO bot_inbound_targets
           (bot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, target_external_id, user_id) DO UPDATE SET
             target_kind = excluded.target_kind,
             user_name = excluded.user_name,
             is_direct = excluded.is_direct,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          bot.id,
          result.targetExternalId,
          result.targetKind,
          result.userId,
          result.userName,
          result.isDirect ? 1 : 0,
          nowIso(),
        )
      const count = this.db.prepare('SELECT COUNT(*) AS c FROM bot_inbound_targets WHERE bot_id = ?').get(bot.id) as { c: number }
      if (count.c > MAX_INBOUND_TARGETS_PER_BOT) {
        this.db
          .prepare(
            `DELETE FROM bot_inbound_targets WHERE rowid IN (
               SELECT rowid FROM bot_inbound_targets WHERE bot_id = ? ORDER BY last_seen_at ASC LIMIT ?
             )`,
          )
          .run(bot.id, count.c - MAX_INBOUND_TARGETS_PER_BOT)
      }
    } catch {
      // 发现记录失败不影响命令/会话主路径。
    }
  }

  private async dispatchCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
  ): Promise<{ status: number; body: unknown }> {
    const target = this.inboundTarget(bot.id, result)
    if (!target || target.allow_commands !== 1 || !this.isCommandUserAllowed(bot.id, result.userId)) {
      this.deps.audit('bot.command.denied', bot.id, { target: result.targetExternalId, user: result.userId.slice(0, 64) })
      return { status: 200, body: result.ackBody ?? result.immediateResponse ?? { ok: true } }
    }
    const retry = this.limiter.hit(`${bot.id}:${result.userId}`)
    if (retry > 0) {
      void result.reply('命令过于频繁，请稍后再试。').catch(() => undefined)
      return { status: 200, body: result.ackBody ?? result.immediateResponse ?? { ok: true } }
    }
    const task = this.executeCommand(bot, result, target).catch((error: unknown) => {
      this.deps.log('warn', 'Bot 命令执行失败', { bot: bot.id, error: error instanceof Error ? error.message : 'unknown' })
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return { status: 200, body: result.ackBody ?? result.immediateResponse ?? { ok: true } }
  }

  private async dispatchChat(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
  ): Promise<{ status: number; body: unknown }> {
    const target = this.inboundTarget(bot.id, result)
    // QQ C2C 的接触面由 QQ 平台“谁可添加 Bot”控制；Chat 对任意 C2C 开放，命令仍走目标白名单。
    const openQqC2c = bot.platform === 'qq' && result.isDirect && result.targetKind === 'user'
    if ((!target || target.allow_chat !== 1) && !openQqC2c) {
      this.deps.audit('bot.chat.denied', bot.id, { target: result.targetExternalId })
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    // 群/频道必须 @ Bot 或回复 Bot；私聊不受触发限制。
    if (!result.isDirect && result.chatTrigger === 'direct') {
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    if (!this.config.botAiEnabled || !this.deps.ai) {
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    const text = cleanText(result.text, this.config.botAiMaxPromptChars)
    if (!text) return { status: 200, body: result.ackBody ?? { ok: true } }
    const chatRetry = this.chatLimiter.hit(`${bot.id}:${result.userId}`)
    if (chatRetry > 0) {
      void result.reply(`对话过于频繁（每分钟 ${this.config.botChatRatePerMinute} 次），请稍后再试。`).catch(() => undefined)
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    const aiRetry = this.aiLimiter.hit(`${bot.id}:${result.userId}`)
    if (aiRetry > 0) {
      void result.reply(`AI 调用过于频繁（每小时 ${this.config.botAiRatePerHour} 次），请稍后再试。`).catch(() => undefined)
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    this.deps.audit('bot.chat', `${bot.platform}:${result.targetExternalId}`, {
      bot: bot.id,
      user: result.userId.slice(0, 64),
      chars: text.length,
      ...(target ? {} : { open: 'qq_c2c' }),
    })
    const task = this.executeChat(bot, result, text).catch((error: unknown) => {
      this.deps.log('warn', 'Bot Chat 执行失败', { bot: bot.id, error: error instanceof Error ? error.message : 'unknown' })
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return { status: 200, body: result.ackBody ?? { ok: true } }
  }

  private async dispatchAction(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'action' }>,
  ): Promise<{ status: number; body: unknown }> {
    const target = this.inboundTarget(bot.id, result)
    if (!target || target.allow_commands !== 1 || !this.isCommandUserAllowed(bot.id, result.userId)) {
      this.deps.audit('bot.action.denied', bot.id, { target: result.targetExternalId, action: result.action })
      return { status: 200, body: result.immediateResponse ?? result.ackBody ?? { ok: true } }
    }
    const retry = this.limiter.hit(`${bot.id}:${result.userId}`)
    if (retry > 0) {
      return { status: 200, body: result.immediateResponse ?? result.ackBody ?? { ok: true } }
    }
    const task = this.executeAction(bot, result, target).catch((error: unknown) => {
      this.deps.log('warn', 'Bot 按钮动作失败', { bot: bot.id, error: error instanceof Error ? error.message : 'unknown' })
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return { status: 200, body: result.immediateResponse ?? result.ackBody ?? { ok: true } }
  }

  private async executeCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    _target: BotTargetRow,
  ): Promise<void> {
    const parsed = /^\/([a-z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(result.text.trim())
    const command = parsed?.[1] ?? ''
    const args = (parsed?.[2] ?? '').trim()
    this.deps.audit('bot.command', `${bot.platform}:${result.targetExternalId}`, {
      command: command.slice(0, 32),
      bot: bot.id,
      user: result.userId.slice(0, 64),
    })
    if (!(BOT_COMMANDS as readonly string[]).includes(command)) {
      await result.reply(helpText(bot.platform), { buttons: STATUS_BUTTONS })
      return
    }
    try {
      let text: string
      let buttons: typeof STATUS_BUTTONS | undefined
      let memoryPrompt: string | null = null
      let memoryAnswer: string | null = null
      switch (command) {
        case 'help':
          text = helpText(bot.platform)
          buttons = STATUS_BUTTONS
          break
        case 'status':
          text = formatPairs('应用状态', await this.deps.providers.status())
          buttons = STATUS_BUTTONS
          break
        case 'backup':
          text = formatPairs('备份状态', await this.deps.providers.backup())
          break
        case 'world':
          text = formatPairs('世界备份/演练', await this.deps.providers.world())
          break
        case 'mc':
          text = formatPairs('Minecraft', await this.deps.providers.minecraft())
          break
        case 'files': {
          if (!args) {
            text = '用法：/files <关键词>'
            break
          }
          text = formatFileList(args, await this.deps.providers.files(args))
          break
        }
        case 'ask': {
          if (!this.config.botAiEnabled || !this.deps.ai) {
            text = 'AI 对话未启用，请联系管理员开启 BOT_AI_ENABLED。'
            break
          }
          if (!args) {
            text = '用法：/ask <问题>'
            break
          }
          const retry = this.aiLimiter.hit(`${bot.id}:${result.userId}`)
          if (retry > 0) {
            text = `AI 调用过于频繁（每小时 ${this.config.botAiRatePerHour} 次），请稍后再试。`
            break
          }
          text = await this.chatWithAi(bot, result.userId, result.targetExternalId, args, 'task')
          memoryPrompt = args
          memoryAnswer = text
          break
        }
        default:
          text = commandDenied()
      }
      await result.reply(sanitizeExternalText(text), buttons ? { buttons } : undefined)
      if (memoryPrompt !== null && memoryAnswer !== null) {
        this.scheduleMemoryUpdate(bot, result.userId, result.targetExternalId, memoryPrompt, memoryAnswer)
      }
    } catch {
      await result.reply(commandFailed(command || '命令'))
    }
  }

  private async executeChat(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
    text: string,
  ): Promise<void> {
    try {
      const answer = await this.chatWithAi(bot, result.userId, result.targetExternalId, text, 'chat')
      await result.reply(sanitizeExternalText(answer))
      this.scheduleMemoryUpdate(bot, result.userId, result.targetExternalId, text, answer)
    } catch {
      await result.reply('AI 暂时不可用，请稍后再试。').catch(() => undefined)
    }
  }

  private async executeAction(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'action' }>,
    _target: BotTargetRow,
  ): Promise<void> {
    this.deps.audit('bot.action', `${bot.platform}:${result.targetExternalId}`, {
      action: result.action,
      bot: bot.id,
      user: result.userId.slice(0, 64),
    })
    try {
      if (result.action === 'refresh_status') {
        const text = formatPairs('应用状态', await this.deps.providers.status())
        await result.reply(sanitizeExternalText(text), { buttons: STATUS_BUTTONS })
        return
      }
      await result.reply(helpText(bot.platform), { buttons: STATUS_BUTTONS })
    } catch {
      await result.reply(commandFailed('刷新状态'))
    }
  }

  /** Chat/`/ask` 的统一模型调用：按模式选择提示词 + 共享长期记忆 + 用户消息。 */
  private async chatWithAi(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    text: string,
    mode: BotAiMode,
  ): Promise<string> {
    if (!this.deps.ai) throw new AppError(503, 'ai_disabled', 'AI 未启用')
    const memory = this.memory.get(bot.id, userId)
    const customPrompt = mode === 'task' ? this.config.botAiTaskPrompt : this.config.botAiChatPrompt
    const prompt = buildBotPrompt({
      mode,
      customPrompt,
      memory: memory.summary,
      userText: text.slice(0, this.config.botAiMaxPromptChars),
    })
    this.deps.audit('bot.ai.chat', `${bot.platform}:${targetExternalId}`, {
      bot: bot.id,
      user: userId.slice(0, 64),
      mode,
      chars: text.length,
    })
    const answer = await this.deps.ai.chat({
      botId: bot.id,
      targetExternalId,
      userId,
      mode,
      prompt,
    })
    return answer
  }

  /** 回复已发送后再更新长期记忆，避免摘要模型调用拖慢用户可见回复。 */
  private scheduleMemoryUpdate(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    userText: string,
    assistantText: string,
  ): void {
    if (!this.deps.ai?.summarizeMemory) return
    const task = this.updateMemory(bot, userId, targetExternalId, userText, assistantText)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  private async updateMemory(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    try {
      const memory = this.memory.get(bot.id, userId)
      const updated = await this.deps.ai!.summarizeMemory!({
        botId: bot.id,
        userId,
        memoryId: memory.memoryId,
        sessionId: memory.sessionId,
        existing: memory.summary,
        userText,
        assistantText,
        maxChars: this.config.botAiMemoryMaxChars,
      })
      this.memory.save(bot.id, userId, memory.memoryId, updated.summary, updated.sessionId)
      this.deps.audit('bot.ai.memory', `${bot.platform}:${targetExternalId}`, { bot: bot.id, user: userId.slice(0, 64) })
    } catch (error) {
      this.deps.log('warn', 'Bot 记忆摘要失败', {
        bot: bot.id,
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  private enqueueDelivery(
    botId: string,
    targetId: string | null,
    kind: BotDeliveryRow['kind'],
    payload: Record<string, unknown>,
    dedupeKey: string | null,
    notBefore?: Date,
  ): void {
    const now = nowIso()
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO bot_deliveries
           (id, bot_id, target_id, kind, dedupe_key, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        )
        .run(
          newId(),
          botId,
          targetId,
          kind,
          dedupeKey,
          JSON.stringify(payload),
          notBefore ? notBefore.toISOString() : null,
          now,
          now,
        )
    } catch {
      // 队列写入失败不应影响告警/请求主路径。
    }
  }

  private async sendTest(bot: BotRow, target: BotTargetRow): Promise<void> {
    const adapter = this.adapterFor(bot)
    const result = await adapter.send(target, { text: 'AntifieldCloud Bot 测试消息：配置可用。' })
    this.db
      .prepare(
        `INSERT INTO bot_deliveries (id, bot_id, target_id, kind, payload_json, status, attempts, external_id, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, 'test', ?, 'sent', 1, ?, ?, ?, ?)`,
      )
      .run(newId(), bot.id, target.id, JSON.stringify({ text: 'test' }), result.externalId, nowIso(), nowIso(), nowIso())
    this.deps.audit('bot.test', `${bot.id}:${target.id}`)
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - this.config.botEventRetentionDays * 86400_000).toISOString()
    const deliveryCutoff = new Date(Date.now() - 30 * 86400_000).toISOString()
    try {
      this.db.prepare('DELETE FROM bot_events WHERE received_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM bot_inbound_targets WHERE last_seen_at < ?').run(cutoff)
      this.memory.cleanup(this.config.botAiSessionRetentionDays)
      this.db.prepare("DELETE FROM bot_deliveries WHERE sent_at IS NOT NULL AND sent_at < ?").run(deliveryCutoff)
      this.db.prepare("DELETE FROM bot_publish_jobs WHERE sent_at IS NOT NULL AND sent_at < ?").run(deliveryCutoff)
      this.deps.ai?.cleanup?.()
      // 永久失败/死信也需要 TTL，避免 Bot 长期运行后队列无限增长。
      this.db.prepare("DELETE FROM bot_deliveries WHERE status IN ('dead','failed') AND updated_at < ?").run(deliveryCutoff)
      this.db.prepare("DELETE FROM bot_publish_jobs WHERE status = 'failed' AND updated_at < ?").run(deliveryCutoff)
    } catch {
      // 清理失败不影响投递。
    }
  }

  private botRow(id: string): BotRow {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as unknown as BotRow | undefined
    if (!row) throw notFound('Bot 不存在')
    return row
  }

  private targetRow(id: string): BotTargetRow {
    const row = this.db.prepare('SELECT * FROM bot_targets WHERE id = ?').get(id) as unknown as BotTargetRow | undefined
    if (!row) throw notFound('目标不存在')
    return row
  }

  private targetRowForBot(botId: string, targetId: string): BotTargetRow {
    const row = this.db
      .prepare('SELECT * FROM bot_targets WHERE id = ? AND bot_id = ?')
      .get(targetId, botId) as unknown as BotTargetRow | undefined
    if (!row) throw notFound('目标不存在')
    return row
  }

  /**
   * 入站目标解析：优先按平台目标 ID；私聊没有独立频道目标时回退到 user 目标（Discord DM）。
   * 只改变授权/回复目标，不自动创建目标，也不放开未登记用户。
   */
  private inboundTarget(
    botId: string,
    input: { targetExternalId: string; userId: string; isDirect: boolean },
  ): BotTargetRow | undefined {
    const direct = this.db
      .prepare('SELECT * FROM bot_targets WHERE bot_id = ? AND external_id = ?')
      .get(botId, input.targetExternalId) as unknown as BotTargetRow | undefined
    if (direct) return direct
    if (!input.isDirect) return undefined
    return this.db
      .prepare("SELECT * FROM bot_targets WHERE bot_id = ? AND kind = 'user' AND external_id = ?")
      .get(botId, input.userId) as unknown as BotTargetRow | undefined
  }

  private firstTarget(botId: string): BotTargetRow | null {
    const row = this.db
      .prepare('SELECT * FROM bot_targets WHERE bot_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(botId) as unknown as BotTargetRow | undefined
    return row ?? null
  }

  /** 命令必须同时满足目标授权 + 用户白名单（kind=user 且 allow_commands=1）。 */
  private isCommandUserAllowed(botId: string, userId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM bot_targets WHERE bot_id = ? AND kind = 'user' AND external_id = ? AND allow_commands = 1")
      .get(botId, userId) as { ok: number } | undefined
    return row !== undefined
  }

  private publishRow(id: string): BotPublishRow {
    const row = this.db.prepare('SELECT * FROM bot_publish_jobs WHERE id = ?').get(id) as unknown as BotPublishRow | undefined
    if (!row) throw notFound('发布任务不存在')
    return row
  }

  private secretOf(row: BotRow): BotSecret {
    return decryptBotSecret(this.key!, {
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      tag: row.secret_tag,
      keyVersion: row.key_version,
    })
  }

  private adapterFor(row: BotRow) {
    const config = parseConfig(row.config_json)
    const secret = this.secretOf(row)
    switch (row.platform) {
      case 'telegram':
        return new TelegramAdapter(config, secret, { fetch: this.deps.fetch })
      case 'discord':
        return new DiscordAdapter(config, secret, { fetch: this.deps.fetch })
      case 'slack':
        return new SlackAdapter(config, secret, { fetch: this.deps.fetch })
      case 'qq':
        return new QqAdapter(config, secret, { fetch: this.deps.fetch, now: this.deps.now })
      default:
        throw new AppError(500, 'bot_platform_invalid', 'Bot 平台无效')
    }
  }

  private toSummary(row: BotRow): BotSummary {
    const config = parseConfig(row.config_json)
    const adapter = this.adapterFor(row)
    const setup = adapter.setup(row.id, this.config.appOrigin)
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM bot_targets WHERE bot_id = ?').get(row.id) as { c: number }
    return {
      id: row.id,
      platform: row.platform,
      name: row.name,
      enabled: row.enabled === 1,
      config,
      webhookUrl: setup.webhookUrl,
      setupSteps: setup.steps,
      targetsCount: count.c,
      lastError: row.last_error,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      keyVersion: row.key_version,
      gateway: this.gatewayStatus(row.id),
    }
  }

  /** Discord Gateway 状态；由 BotService 生命周期注入，未启用时为 disabled。 */
  private gatewayStatus(botId: string): BotSummary['gateway'] {
    return this.gateway.status(botId)
  }

  private normalizeSecret(input: CreateBotInput): BotSecret {
    return {
      token: cleanText(input.token, 500),
      webhookSecret: cleanText(input.webhookSecret, 500) || undefined,
      signingSecret: cleanText(input.signingSecret, 500) || undefined,
      publicKey: cleanText(input.publicKey, 200) || undefined,
    }
  }

  private normalizeConfig(
    platform: BotPlatform,
    raw: Record<string, unknown> | undefined,
    publicKey?: string,
  ): Record<string, unknown> {
    if (platform === 'qq') {
      const source = raw ?? {}
      return { appId: cleanText(source.appId ?? source.applicationId, 64) }
    }
    if (platform !== 'discord') return {}
    const source = raw ?? {}
    return {
      applicationId: cleanText(source.applicationId, 64),
      publicKey: cleanText(source.publicKey, 200) || cleanText(publicKey, 200),
    }
  }

  private validateOrThrow(platform: BotPlatform, config: Record<string, unknown>, secret: BotSecret): void {
    const adapter =
      platform === 'telegram'
        ? new TelegramAdapter(config, secret, { fetch: this.deps.fetch })
        : platform === 'discord'
          ? new DiscordAdapter(config, secret, { fetch: this.deps.fetch })
          : platform === 'qq'
            ? new QqAdapter(config, secret, { fetch: this.deps.fetch, now: this.deps.now })
            : new SlackAdapter(config, secret, { fetch: this.deps.fetch })
    const errors = adapter.validate(config, secret)
    if (errors.length > 0) throw badRequest(`Bot 配置无效：${errors.join(', ')}`, 'invalid_bot_config')
  }

  private normalizeQuiet(start: number | null | undefined, end: number | null | undefined): {
    start: number | null
    end: number | null
  } {
    const clean = (value: number | null | undefined): number | null => {
      if (value === null || value === undefined) return null
      if (!Number.isInteger(value) || value < 0 || value > 1439) throw badRequest('静默时段必须是 0-1439 分钟')
      return value
    }
    const cleanStart = clean(start)
    const cleanEnd = clean(end)
    if ((cleanStart === null) !== (cleanEnd === null)) throw badRequest('静默时段起止必须同时设置或同时留空')
    if (cleanStart !== null && cleanStart === cleanEnd) throw badRequest('静默时段起止不能相同')
    return { start: cleanStart, end: cleanEnd }
  }

  private parseSchedule(scheduledAt: string | null | undefined): string | null {    if (!scheduledAt) return null
    const time = Date.parse(scheduledAt)
    if (!Number.isFinite(time)) throw badRequest('定时时间格式无效')
    if (time < Date.now() - 30_000) throw badRequest('定时时间必须晚于当前时间')
    if (time > Date.now() + this.config.botPublishMaxScheduledDays * 86400_000) {
      throw badRequest(`定时时间不能超过 ${this.config.botPublishMaxScheduledDays} 天`)
    }
    return new Date(time).toISOString()
  }
}

function toTarget(row: BotTargetRow): BotTarget {
  return {
    id: row.id,
    botId: row.bot_id,
    externalId: row.external_id,
    label: row.label,
    kind: row.kind,
    allowCommands: row.allow_commands === 1,
    allowNotifications: row.allow_notifications === 1,
    allowChat: row.allow_chat === 1,
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    createdAt: row.created_at,
  }
}

function toDelivery(row: BotDeliveryRow): BotDelivery {
  return {
    id: row.id,
    botId: row.bot_id,
    targetId: row.target_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    externalId: row.external_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }
}

function toPublishJob(row: BotPublishRow): BotPublishJob {
  const text = (() => {
    try {
      const parsed = JSON.parse(row.content_json) as { text?: unknown }
      return typeof parsed.text === 'string' ? parsed.text : ''
    } catch {
      return ''
    }
  })()
  return {
    id: row.id,
    botId: row.bot_id,
    targetId: row.target_id,
    text,
    mediaFileIds: (() => {
      try {
        const parsed = JSON.parse(row.media_file_ids_json) as unknown
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
      } catch {
        return []
      }
    })(),
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }
}
