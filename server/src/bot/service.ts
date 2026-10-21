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
import { DiscordAdapter } from './adapters/discord.ts'
import { SlackAdapter } from './adapters/slack.ts'
import { TelegramAdapter } from './adapters/telegram.ts'
import { commandDenied, commandFailed, formatFileList, formatPairs, helpText } from './templates.ts'

const NAME_MAX = 80
const TARGET_MAX = 128
const TEXT_MAX = 4096
const MAX_TARGETS_PER_BOT = 100

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
}

export interface UpdateTargetInput {
  label?: string
  kind?: 'channel' | 'user' | 'group'
  allowCommands?: boolean
  allowNotifications?: boolean
}

export interface CreatePublishInput {
  targetId: string
  text: string
  mediaFileIds?: string[]
  scheduledAt?: string | null
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
    return this.getBot(id)
  }

  deleteBot(id: string): void {
    this.requireEnabled()
    this.botRow(id)
    this.db.prepare('DELETE FROM bots WHERE id = ?').run(id)
    this.deps.audit('bot.delete', id)
  }

  listTargets(botId: string): BotTarget[] {
    this.requireEnabled()
    this.botRow(botId)
    const rows = this.db
      .prepare('SELECT * FROM bot_targets WHERE bot_id = ? ORDER BY created_at ASC')
      .all(botId) as unknown as BotTargetRow[]
    return rows.map(toTarget)
  }

  createTarget(botId: string, input: CreateTargetInput): BotTarget {
    this.requireEnabled()
    this.botRow(botId)
    const externalId = cleanText(input.externalId, TARGET_MAX)
    const label = cleanText(input.label, NAME_MAX)
    if (!externalId || !label) throw badRequest('目标 ID 与名称不能为空')
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM bot_targets WHERE bot_id = ?').get(botId) as { c: number }
    if (count.c >= MAX_TARGETS_PER_BOT) throw badRequest('目标数量过多')
    const id = newId()
    try {
      this.db
        .prepare(
          `INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, botId, externalId, label, input.kind, input.allowCommands ? 1 : 0, input.allowNotifications ? 1 : 0, nowIso())
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
    this.db
      .prepare('UPDATE bot_targets SET label = ?, kind = ?, allow_commands = ?, allow_notifications = ? WHERE id = ?')
      .run(
        label,
        input.kind ?? row.kind,
        input.allowCommands === undefined ? row.allow_commands : input.allowCommands ? 1 : 0,
        input.allowNotifications === undefined ? row.allow_notifications : input.allowNotifications ? 1 : 0,
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
    const bot = this.botRow(botId)
    const target = this.targetRowForBot(botId, input.targetId)
    if (target.kind === 'user') throw badRequest('发布目标必须是频道/群组')
    const text = cleanText(input.text, TEXT_MAX)
    if (!text) throw badRequest('发布内容不能为空')
    const platformLimit = bot.platform === 'discord' ? 2000 : bot.platform === 'slack' ? 4000 : 4096
    if (text.length > platformLimit) throw badRequest(`内容超过 ${platformLimit} 字符`)
    const mediaIds = Array.isArray(input.mediaFileIds) ? input.mediaFileIds.map((id) => cleanText(id, 64)).filter(Boolean) : []
    if (mediaIds.length > 1) throw badRequest('v0.5.0 单次发布最多选择 1 个媒体文件')
    if (mediaIds.length === 1) {
      const stat = this.deps.media.stat(mediaIds[0]!)
      if (!stat) throw badRequest('媒体文件不存在或不可发布')
      if (stat.size > this.config.botPublishMaxMediaBytes) throw badRequest('媒体文件超过大小限制')
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
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
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
        this.enqueueDelivery(bot.id, target.id, 'notification', { text }, `alert:${event.id}:${bot.id}:${target.id}`)
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
      const mediaId = Array.isArray(mediaIds) && typeof mediaIds[0] === 'string' ? mediaIds[0] : null
      let media: OutboundMedia | undefined
      if (mediaId) {
        const stat = this.deps.media.stat(mediaId)
        if (!stat) throw new AppError(400, 'media_missing', '媒体文件不存在')
        media = await this.deps.media.load(mediaId)
      }
      const adapter = this.adapterFor(bot)
      const result = await adapter.send(target, { text, media })
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
    const message = error instanceof Error ? error.message.slice(0, 500) : '发布失败'
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
    if (result.kind === 'ignored') return { status: 200, body: { ok: true } }
    const inserted = this.db
      .prepare('INSERT OR IGNORE INTO bot_events (bot_id, platform_event_id, received_at) VALUES (?, ?, ?)')
      .run(bot.id, result.eventId, nowIso())
    if (Number(inserted.changes) === 0) return { status: 200, body: { ok: true, duplicate: true } }
    const target = this.db
      .prepare('SELECT * FROM bot_targets WHERE bot_id = ? AND external_id = ?')
      .get(bot.id, result.targetExternalId) as unknown as BotTargetRow | undefined
    if (!target || target.allow_commands !== 1 || !this.isCommandUserAllowed(bot.id, result.userId)) {
      this.deps.audit('bot.command.denied', bot.id, { target: result.targetExternalId, user: result.userId.slice(0, 64) })
      return { status: 200, body: result.immediateResponse ?? { ok: true } }
    }
    const retry = this.limiter.hit(`${bot.id}:${result.userId}`)
    if (retry > 0) {
      void result.reply('命令过于频繁，请稍后再试。').catch(() => undefined)
      return { status: 200, body: result.immediateResponse ?? { ok: true } }
    }
    const task = this.executeCommand(bot, result).catch((error: unknown) => {
      this.deps.log('warn', 'Bot 命令执行失败', { bot: bot.id, error: error instanceof Error ? error.message : 'unknown' })
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return { status: 200, body: result.immediateResponse ?? { ok: true } }
  }

  private async executeCommand(bot: BotRow, result: Extract<InboundVerification, { kind: 'command' }>): Promise<void> {
    const parsed = /^\/([a-z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(result.text.trim())
    const command = parsed?.[1] ?? ''
    const args = (parsed?.[2] ?? '').trim()
    this.deps.audit('bot.command', `${bot.platform}:${result.targetExternalId}`, {
      command: command.slice(0, 32),
      bot: bot.id,
      user: result.userId.slice(0, 64),
    })
    if (!(BOT_COMMANDS as readonly string[]).includes(command)) {
      await result.reply(helpText(bot.platform))
      return
    }
    try {
      let text: string
      switch (command) {
        case 'help':
          text = helpText(bot.platform)
          break
        case 'status':
          text = formatPairs('应用状态', await this.deps.providers.status())
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
        default:
          text = commandDenied()
      }
      await result.reply(sanitizeExternalText(text))
    } catch {
      await result.reply(commandFailed(command || '命令'))
    }
  }

  private enqueueDelivery(
    botId: string,
    targetId: string | null,
    kind: BotDeliveryRow['kind'],
    payload: Record<string, unknown>,
    dedupeKey: string | null,
  ): void {
    const now = nowIso()
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO bot_deliveries
           (id, bot_id, target_id, kind, dedupe_key, payload_json, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
        )
        .run(newId(), botId, targetId, kind, dedupeKey, JSON.stringify(payload), now, now)
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
      this.db.prepare("DELETE FROM bot_deliveries WHERE sent_at IS NOT NULL AND sent_at < ?").run(deliveryCutoff)
      this.db.prepare("DELETE FROM bot_publish_jobs WHERE sent_at IS NOT NULL AND sent_at < ?").run(deliveryCutoff)
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
        return new TelegramAdapter(secret, { fetch: this.deps.fetch })
      case 'discord':
        return new DiscordAdapter(config, secret, { fetch: this.deps.fetch })
      case 'slack':
        return new SlackAdapter(secret, { fetch: this.deps.fetch })
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
    }
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
        ? new TelegramAdapter(secret, { fetch: this.deps.fetch })
        : platform === 'discord'
          ? new DiscordAdapter(config, secret, { fetch: this.deps.fetch })
          : new SlackAdapter(secret, { fetch: this.deps.fetch })
    const errors = adapter.validate(config, secret)
    if (errors.length > 0) throw badRequest(`Bot 配置无效：${errors.join(', ')}`, 'invalid_bot_config')
  }

  private parseSchedule(scheduledAt: string | null | undefined): string | null {
    if (!scheduledAt) return null
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
