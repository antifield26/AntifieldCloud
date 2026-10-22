/**
 * Bot 平台服务（QQ 官方 Bot 单平台）：配置 CRUD、Webhook 验签/命令分发、通知/发布队列与投递重试。
 * 安全边界：AppSecret 只以 AES-256-GCM 密文落库；Webhook 无 session/CSRF，Ed25519 签名是唯一鉴权；
 * 除自助命令（/role 私聊、/reset、/forget）外，命令必须命中 bot_targets.allow_commands + 显式 user 白名单；
 * 发布只允许登录管理员调用；通知/命令输出不得包含内部路径、URL 或密钥。
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
  type BotAdapter,
  type BotAiImage,
  type BotAiMode,
  type BotDelivery,
  type BotDeliveryRow,
  type BotEventItem,
  type BotEventOutcome,
  type BotHealthCheck,
  type BotInboundTarget,
  type BotInboundTargetRow,
  type BotMemorySummary,
  type BotMetrics,
  type BotPlatform,
  type BotPublishJob,
  type BotPublishRow,
  type BotRoleSummary,
  type BotRow,
  type BotSecret,
  type BotServiceDeps,
  type BotStatus,
  type BotSummary,
  type BotTarget,
  type BotTargetRow,
  type InboundVerification,
} from './types.ts'
import { decodeBotKey, decryptBotSecret, encryptBotSecret } from './crypto.ts'
import { describeBotError } from './errors.ts'
import { formatAiReply } from './format.ts'
import { BotMemoryStore } from './memory.ts'
import { buildBotPrompt } from './prompts.ts'
import {
  BotChatRoleStore,
  normalizeRolePrompt,
  validateRole,
  type BotChatRole,
  type RoleValidationError,
} from './roles.ts'
import { BotConnectivityMonitor, type ConnectivitySnapshot } from './connectivity.ts'
import { QqAdapter } from './adapters/qq.ts'
import { BOT_TEXT_LIMITS } from './text.ts'
import {
  commandDenied,
  commandFailed,
  formatFileList,
  formatPairs,
  helpText,
  roleDefaultText,
  roleGroupHint,
  roleUsage,
} from './templates.ts'

const NAME_MAX = 80
const TARGET_MAX = 128
const MAX_TARGETS_PER_BOT = 100
const MAX_INBOUND_TARGETS_PER_BOT = 500
/** QQ 单条文本上限；发布内容在入队前先校验。 */
const PUBLISH_TEXT_MAX = BOT_TEXT_LIMITS.qq
/** 诊断事件结果枚举；service 与 route 共用校验。 */
const BOT_EVENT_OUTCOMES = ['received', 'ok', 'denied', 'rate_limited', 'ignored', 'error'] as const
/** AI 图片理解允许的 mime；超出范围降级为纯文本。 */
const IMAGE_MIME_ALLOWLIST = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
/** 入站图片下载超时；由适配器 loadImage 执行。 */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
/** 图片无法处理时附在纯文字回答末尾的说明。 */
const IMAGE_DEGRADED_NOTE = '（图片未能处理，已按文字回答）'
const IMAGE_UNSUPPORTED_TEXT = '当前暂不支持处理这张图片，可以用文字描述。'
/** 仅图片无正文时交给模型的用户消息占位，避免空用户消息。 */
const IMAGE_ONLY_USER_TEXT = '（用户发送了一张图片）'

interface ParsedCommand {
  command: string
  args: string
}

function parseCommandText(text: string): ParsedCommand | null {
  const parsed = /^\/([a-z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!parsed) return null
  return { command: parsed[1] ?? '', args: (parsed[2] ?? '').trim() }
}

function roleValidationMessage(error: RoleValidationError): string {
  switch (error) {
    case 'role_name_empty':
      return '请提供名字。用法：/role set <名字> <设定>'
    case 'role_name_too_long':
      return '名字过长，请控制在 32 字以内。'
    case 'role_name_has_whitespace':
      return '名字不能包含空格。'
    case 'role_name_invalid_chars':
      return '名字不能包含方括号等符号。'
    case 'role_prompt_empty':
      return '请提供设定内容。'
    case 'role_prompt_too_long':
      return '设定过长，请控制在 1000 字以内。'
    case 'role_prompt_reserved_marker':
      return '设定包含不支持的格式，请换一种写法。'
    default:
      return '设定格式无法识别。'
  }
}

/** 适配器部分发送失败时挂在错误对象上的已发送 ID；用于禁止自动重试。 */
function sentExternalIdsOf(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const value = (error as { sentExternalIds?: unknown }).sentExternalIds
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** 诊断 detail 只记录短代码：优先 AppError.code，其次通用 error。 */
function errorShortCode(error: unknown): string {
  if (error instanceof AppError) return error.code.slice(0, 60)
  return 'error'
}

export interface CreateBotInput {
  platform: BotPlatform
  name: string
  /** QQ AppSecret（历史字段名为 token）。 */
  token: string
  /** 公开配置（QQ 仅 appId）。 */
  config?: Record<string, unknown>
}

export interface UpdateBotInput {
  name?: string
  enabled?: boolean
  config?: Record<string, unknown>
  token?: string
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
  private readonly roles: BotChatRoleStore
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
    this.roles = new BotChatRoleStore(deps.db)
    this.connectivity = new BotConnectivityMonitor({
      enabled: deps.config.botEnabled && deps.config.botConnectivityEnabled,
      intervalSeconds: deps.config.botConnectivityIntervalSeconds,
      timeoutSeconds: deps.config.botConnectivityTimeoutSeconds,
      proxyUrl: deps.config.botProxyUrl,
      getPlatforms: () => this.enabledPlatforms(),
      log: deps.log,
      onRecover: () => {
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
      lastErrorHint: describeBotError(lastError?.last_error ?? null),
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
    const config = this.normalizeConfig(input.config)
    this.validateOrThrow(config, secret)
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
    const secret: BotSecret = { token: cleanText(input.token, 500) || this.secretOf(row).token }
    const nextConfig = input.config !== undefined ? this.normalizeConfig(input.config) : parseConfig(row.config_json)
    this.validateOrThrow(nextConfig, secret)
    const encrypted = encryptBotSecret(this.key!, secret)
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
         SET label = ?, kind = ?, allow_commands = ?, allow_notifications = ?, allow_chat = ?,
             quiet_start_minute = ?, quiet_end_minute = ?
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

  /**
   * 角色卡管理列表：只返回元数据（名字/长度/启停/时间），不返回角色设定正文。
   * userName 取自最近入站目标记录（没有则为 null）。
   */
  listRoles(botId: string, options: { limit?: number; offset?: number } = {}): { items: BotRoleSummary[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    const names = this.inboundUserNames(botId)
    const items = this.roles.list(botId, limit, offset).map((item) => ({
      ...item,
      userName: names.get(item.userId) ?? null,
    }))
    return { items, total: this.roles.count(botId) }
  }

  /** 启用/停用指定用户的角色卡；不存在时 404。 */
  setRoleEnabled(botId: string, userId: string, enabled: boolean): void {
    this.requireEnabled()
    this.botRow(botId)
    const card = this.roles.get(botId, userId)
    if (!card || !this.roles.setEnabled(botId, userId, enabled)) throw notFound('角色卡不存在')
    this.deps.audit('bot.role.admin', `${botId}:${userId.slice(0, 64)}`, {
      action: enabled ? 'enable' : 'disable',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 删除角色卡，并清理该 Bot×用户的全部 chat 模式会话（task 会话保留）。 */
  deleteRole(botId: string, userId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const card = this.roles.get(botId, userId)
    if (!card || !this.roles.remove(botId, userId)) throw notFound('角色卡不存在')
    this.db.prepare("DELETE FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ? AND mode = 'chat'").run(botId, userId)
    this.deps.audit('bot.role.admin', `${botId}:${userId.slice(0, 64)}`, {
      action: 'delete',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 长期记忆管理列表：只返回长度/时间等元数据，不返回摘要正文。 */
  listMemories(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemorySummary[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    const names = this.inboundUserNames(botId)
    const items = this.memory.list(botId, limit, offset).map((item) => ({
      ...item,
      userName: names.get(item.userId) ?? null,
    }))
    return { items, total: this.memory.count(botId) }
  }

  /** 删除指定用户的长期记忆（DB 行 + 镜像文件）；不存在时 404。 */
  deleteMemory(botId: string, userId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const row = this.db
      .prepare('SELECT length(summary) AS len FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?')
      .get(botId, userId) as { len: number } | undefined
    if (!row || !this.memory.remove(botId, userId)) throw notFound('长期记忆不存在')
    this.deps.audit('bot.memory.admin', `${botId}:${userId.slice(0, 64)}`, {
      action: 'delete',
      user: userId.slice(0, 64),
      summaryLength: row.len,
      at: nowIso(),
    })
  }

  /**
   * 平台连接自检：需要启用中的 Bot + 可解密凭据 + 适配器实现 check。
   * 无论成功失败都刷新 last_checked_at；不触碰 last_error（投递错误由队列负责）。
   */
  async checkBot(botId: string): Promise<BotHealthCheck> {
    this.requireEnabled()
    const bot = this.botRow(botId)
    let adapter: BotAdapter
    try {
      adapter = this.adapterFor(bot)
    } catch (error) {
      this.deps.log('warn', 'Bot 自检无法构造适配器', { bot: bot.id, code: errorShortCode(error) })
      return this.finishCheck(bot, {
        ok: false,
        items: [{ name: '凭据', ok: false, detail: '凭据读取失败，请重新保存平台凭据' }],
      })
    }
    if (!adapter.check) throw new AppError(400, 'bot_health_unsupported', '该平台暂不支持连接自检')
    let health: BotHealthCheck
    try {
      health = await adapter.check({ botId: bot.id, appOrigin: this.config.appOrigin })
    } catch (error) {
      // 兜底结果只保留脱敏短描述，避免异常消息里的 URL/凭据进入 API。
      const detail = sanitizeExternalText(error instanceof Error ? error.message : '').slice(0, 120)
      health = {
        ok: false,
        items: [{ name: '连接自检', ok: false, detail: detail || '自检请求失败' }],
      }
    }
    return this.finishCheck(bot, health)
  }

  /** 自检收尾：刷新 last_checked_at 并审计（ok/detail 短码）。 */
  private finishCheck(bot: BotRow, health: BotHealthCheck): BotHealthCheck {
    const checkedAt = nowIso()
    try {
      this.db.prepare('UPDATE bots SET last_checked_at = ? WHERE id = ?').run(checkedAt, bot.id)
    } catch {
      // 时间戳写入失败不影响自检结果返回。
    }
    const failed = health.items.filter((item) => !item.ok).map((item) => item.name).join(',')
    this.deps.audit('bot.check', bot.id, {
      ok: health.ok,
      items: health.items.length,
      ...(failed ? { detail: failed.slice(0, 120) } : {}),
    })
    return {
      ok: health.ok,
      items: health.items.map((item) => ({ name: item.name, ok: item.ok, detail: item.detail })),
      checkedAt,
    }
  }

  /** 最近入站身份表：userId → 平台显示名（同一用户多目标时取最近一次）。 */
  private inboundUserNames(botId: string): Map<string, string | null> {
    const rows = this.db
      .prepare('SELECT user_id, user_name FROM bot_inbound_targets WHERE bot_id = ? ORDER BY last_seen_at DESC')
      .all(botId) as unknown as { user_id: string; user_name: string | null }[]
    const names = new Map<string, string | null>()
    for (const row of rows) {
      if (!names.has(row.user_id)) names.set(row.user_id, row.user_name)
    }
    return names
  }

  /**
   * 诊断事件列表：按 received_at DESC 分页；只含元数据（事件 ID/类型/结果/短码/目标/用户/时间）。
   * outcome 缺省返回全部，非法值直接 400。
   */
  listEvents(
    botId: string,
    options: { hours?: number; limit?: number; offset?: number; outcome?: string } = {},
  ): { items: BotEventItem[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    const rawHours = Number(options.hours)
    const hours = Math.max(1, Math.min(720, Math.floor(Number.isFinite(rawHours) ? rawHours : 24)))
    const rawLimit = Number(options.limit)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 50)))
    const rawOffset = Number(options.offset)
    const offset = Math.max(0, Math.floor(Number.isFinite(rawOffset) ? rawOffset : 0))
    const outcome = typeof options.outcome === 'string' && options.outcome.trim() ? options.outcome.trim() : null
    if (outcome !== null && !(BOT_EVENT_OUTCOMES as readonly string[]).includes(outcome)) {
      throw badRequest('事件结果筛选值无效')
    }
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
    const where = outcome === null ? 'bot_id = ? AND received_at >= ?' : 'bot_id = ? AND received_at >= ? AND outcome = ?'
    const params: (string | number)[] = outcome === null ? [botId, cutoff] : [botId, cutoff, outcome]
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM bot_events WHERE ${where}`).get(...params) as { c: number }
    const rows = this.db
      .prepare(
        `SELECT platform_event_id, event_kind, outcome, detail, target_external_id, user_id, received_at, updated_at
         FROM bot_events WHERE ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as Array<{
      platform_event_id: string
      event_kind: string | null
      outcome: string | null
      detail: string | null
      target_external_id: string | null
      user_id: string | null
      received_at: string
      updated_at: string | null
    }>
    return {
      total: totalRow.c,
      items: rows.map((row) => ({
        eventId: row.platform_event_id,
        kind: row.event_kind,
        outcome: row.outcome,
        detail: row.detail,
        targetExternalId: row.target_external_id,
        userId: row.user_id,
        receivedAt: row.received_at,
        updatedAt: row.updated_at,
      })),
    }
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
      .prepare(
        "UPDATE bot_deliveries SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND bot_id = ? AND status IN ('failed','dead')",
      )
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
    this.botRow(botId)
    const target = this.targetRowForBot(botId, input.targetId)
    if (target.kind === 'user') throw badRequest('发布目标必须是频道/群组')
    // 保留到上限 +1 以便区分「空内容」与「超长内容」，超长直接 400 而不是静默截断。
    const text = cleanText(input.text, PUBLISH_TEXT_MAX + 1)
    if (!text) throw badRequest('发布内容不能为空')
    if (text.length > PUBLISH_TEXT_MAX) throw badRequest(`内容超过 ${PUBLISH_TEXT_MAX} 字符`)
    const scheduledAt = this.parseSchedule(input.scheduledAt)
    const id = newId()
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO bot_publish_jobs (id, bot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, 'queued', 0, ?, ?)`,
      )
      .run(id, botId, target.id, JSON.stringify({ text }), scheduledAt, now, now)
    this.deps.audit('bot.publish.create', `${botId}:${id}`, { scheduled: Boolean(scheduledAt) })
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
    this.connectivity.start()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.connectivity.stop()
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
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND attempts < ? ORDER BY created_at ASC LIMIT 20`,
      )
      .all(now, this.config.botDeliveryMaxAttempts) as unknown as BotDeliveryRow[]
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
    const sentIds = sentExternalIdsOf(error)
    if (sentIds.length > 0) {
      // 长消息已部分外发：自动重试会重复发送，标记 failed 且 attempts 用尽，交人工确认。
      this.db
        .prepare("UPDATE bot_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?")
        .run(
          this.config.botDeliveryMaxAttempts,
          `partial_text_sent（已发送 ${sentIds.length} 段）：${message}`.slice(0, 500),
          nowIso(),
          delivery.id,
        )
      this.deps.log('warn', 'Bot 投递部分外发，停止自动重试', {
        bot: delivery.bot_id,
        delivery: delivery.id,
        sent: sentIds.length,
      })
      this.deps.audit('bot.delivery.partial', `${delivery.bot_id}:${delivery.id}`, { sent: sentIds.length })
      return
    }
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
      if (!text) throw new AppError(400, 'empty_payload', '发布内容为空')
      const adapter = this.adapterFor(bot)
      const result = await adapter.send(target, { text })
      if (result.partial) {
        const message = 'partial_text_sent：部分段落已发送，需人工确认后重建发布任务'
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
    const partialIds = sentExternalIdsOf(error)
    const message = error instanceof Error ? error.message.slice(0, 500) : '发布失败'
    if (partialIds.length > 0) {
      // 长文本已部分外发，自动重试会重复发送；保留证据交管理员人工重建。
      this.db
        .prepare("UPDATE bot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(
          this.config.botDeliveryMaxAttempts,
          `partial_text_sent（已发送 ${partialIds.length} 段）：${message}`.slice(0, 500),
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
      // 适配器可给出去重事件 ID；带 ID 时记录 ignored 结果供诊断查询。
      if (result.eventId) {
        this.insertEvent(bot.id, result.eventId, 'ignored', 'ignored', result.detail ?? null, null, null)
      }
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    const inserted = this.insertEvent(
      bot.id,
      result.eventId,
      result.kind,
      'received',
      null,
      result.targetExternalId,
      result.userId,
    )
    if (!inserted) return { status: 200, body: result.ackBody ?? { ok: true, duplicate: true } }
    this.recordInbound(bot, result)
    if (result.kind === 'command') return this.dispatchCommand(bot, result)
    return this.dispatchChat(bot, result)
  }

  /** 写入入站事件（按 bot×平台事件 ID 去重）；返回是否首次插入。 */
  private insertEvent(
    botId: string,
    eventId: string,
    kind: string,
    outcome: BotEventOutcome,
    detail: string | null,
    targetExternalId: string | null,
    userId: string | null,
  ): boolean {
    try {
      const now = nowIso()
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO bot_events
           (bot_id, platform_event_id, received_at, event_kind, outcome, detail, target_external_id, user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          botId,
          eventId,
          now,
          kind.slice(0, 32),
          outcome,
          detail === null ? null : detail.slice(0, 120),
          targetExternalId === null ? null : targetExternalId.slice(0, 128),
          userId === null ? null : userId.slice(0, 64),
          now,
        )
      return Number(inserted.changes) > 0
    } catch {
      // 诊断记录失败不影响消息主路径（按新事件继续处理）。
      return true
    }
  }

  /**
   * 更新事件最终结果。detail 只允许短码（如 command_denied/chat_ok/error code），
   * 禁止写入消息正文、文件路径或外部 ID 以外的内容。
   */
  private markEvent(
    botId: string,
    eventId: string,
    update: { outcome: BotEventOutcome; detail?: string; target?: string; user?: string },
  ): void {
    try {
      this.db
        .prepare(
          `UPDATE bot_events SET outcome = ?, detail = ?,
             target_external_id = COALESCE(?, target_external_id),
             user_id = COALESCE(?, user_id), updated_at = ?
           WHERE bot_id = ? AND platform_event_id = ?`,
        )
        .run(
          update.outcome,
          update.detail === undefined ? null : update.detail.slice(0, 120),
          update.target === undefined ? null : update.target.slice(0, 128),
          update.user === undefined ? null : update.user.slice(0, 64),
          nowIso(),
          botId,
          eventId,
        )
    } catch {
      // 诊断更新失败不影响处理。
    }
  }

  private recordInbound(bot: BotRow, result: Extract<InboundVerification, { kind: 'command' | 'chat' }>): void {
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
    const parsed = parseCommandText(result.text)
    const command = parsed?.command ?? ''
    const ack = () => result.ackBody ?? { ok: true }
    // 群聊里角色统一使用默认 lofii；/role 只做友好提示，不读取或修改任何人的私聊角色。
    if (command === 'role' && !result.isDirect) {
      const retry = this.limiter.hit(`${bot.id}:${result.userId}`)
      if (retry === 0) void result.reply(roleGroupHint()).catch(() => undefined)
      this.deps.audit('bot.role.hint', bot.id, {
        target: result.targetExternalId,
        user: result.userId.slice(0, 64),
      })
      this.markEvent(bot.id, result.eventId, {
        outcome: 'ok',
        detail: 'role_hint',
        target: result.targetExternalId,
        user: result.userId,
      })
      return { status: 200, body: ack() }
    }
    // /role（私聊）、/reset、/forget 面向所有用户，不要求目标 allow_commands 或 user 白名单。
    const openCommand = command === 'role' || command === 'reset' || command === 'forget'
    const target = this.inboundTarget(bot.id, result)
    if (!openCommand && (!target || target.allow_commands !== 1 || !this.isCommandUserAllowed(bot.id, result.userId))) {
      this.deps.audit('bot.command.denied', bot.id, { target: result.targetExternalId, user: result.userId.slice(0, 64) })
      this.markEvent(bot.id, result.eventId, {
        outcome: 'denied',
        detail: 'command_denied',
        target: result.targetExternalId,
        user: result.userId,
      })
      return { status: 200, body: ack() }
    }
    const retry = this.limiter.hit(`${bot.id}:${result.userId}`)
    if (retry > 0) {
      void result.reply('命令过于频繁，请稍后再试。').catch(() => undefined)
      this.markEvent(bot.id, result.eventId, {
        outcome: 'rate_limited',
        detail: 'command_rate_limited',
        target: result.targetExternalId,
        user: result.userId,
      })
      return { status: 200, body: ack() }
    }
    const task = this.executeCommand(bot, result, parsed).catch((error: unknown) => {
      this.deps.log('warn', 'Bot 命令执行失败', { bot: bot.id, error: error instanceof Error ? error.message : 'unknown' })
      this.markEvent(bot.id, result.eventId, {
        outcome: 'error',
        detail: sentExternalIdsOf(error).length > 0 ? 'partial_reply' : errorShortCode(error),
        target: result.targetExternalId,
        user: result.userId,
      })
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return { status: 200, body: ack() }
  }

  private async dispatchChat(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
  ): Promise<{ status: number; body: unknown }> {
    const target = this.inboundTarget(bot.id, result)
    const ack = () => result.ackBody ?? { ok: true }
    const mark = (outcome: BotEventOutcome, detail: string) =>
      this.markEvent(bot.id, result.eventId, {
        outcome,
        detail,
        target: result.targetExternalId,
        user: result.userId,
      })
    // QQ C2C 的接触面由 QQ 平台“谁可添加 Bot”控制；Chat 对任意 C2C 开放，命令仍走目标白名单。
    const openQqC2c = result.isDirect && result.targetKind === 'user'
    if ((!target || target.allow_chat !== 1) && !openQqC2c) {
      this.deps.audit('bot.chat.denied', bot.id, { target: result.targetExternalId })
      mark('denied', 'chat_denied')
      return { status: 200, body: ack() }
    }
    if (!this.config.botAiEnabled || !this.deps.ai) {
      mark('ignored', 'ai_disabled')
      return { status: 200, body: ack() }
    }
    const text = cleanText(result.text, this.config.botAiMaxPromptChars)
    // 允许只有图片没有正文的消息进入 AI 管线。
    if (!text && !result.image) {
      mark('ignored', 'empty_content')
      return { status: 200, body: ack() }
    }
    const chatRetry = this.chatLimiter.hit(`${bot.id}:${result.userId}`)
    if (chatRetry > 0) {
      void result.reply(`对话过于频繁（每分钟 ${this.config.botChatRatePerMinute} 次），请稍后再试。`).catch(() => undefined)
      mark('rate_limited', 'chat_rate_limited')
      return { status: 200, body: ack() }
    }
    const aiRetry = this.aiLimiter.hit(`${bot.id}:${result.userId}`)
    if (aiRetry > 0) {
      void result.reply(`AI 调用过于频繁（每小时 ${this.config.botAiRatePerHour} 次），请稍后再试。`).catch(() => undefined)
      mark('rate_limited', 'ai_rate_limited')
      return { status: 200, body: ack() }
    }
    this.deps.audit('bot.chat', `${bot.platform}:${result.targetExternalId}`, {
      bot: bot.id,
      user: result.userId.slice(0, 64),
      chars: text.length,
      ...(result.image ? { image: result.image.mime.slice(0, 50) } : {}),
      ...(target ? {} : { open: 'qq_c2c' }),
    })
    const task = this.executeChat(bot, result, text).catch((error: unknown) => {
      this.deps.log('warn', 'Bot Chat 执行失败', { bot: bot.id, error: error instanceof Error ? error.message : 'unknown' })
      mark('error', sentExternalIdsOf(error).length > 0 ? 'partial_reply' : errorShortCode(error))
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return { status: 200, body: ack() }
  }

  private async executeCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    parsed: ParsedCommand | null,
  ): Promise<void> {
    const command = parsed?.command ?? ''
    const args = parsed?.args ?? ''
    this.deps.audit('bot.command', `${bot.platform}:${result.targetExternalId}`, {
      command: command.slice(0, 32),
      bot: bot.id,
      user: result.userId.slice(0, 64),
    })
    const finish = (outcome: BotEventOutcome, detail: string) =>
      this.markEvent(bot.id, result.eventId, {
        outcome,
        detail,
        target: result.targetExternalId,
        user: result.userId,
      })
    try {
      if (!(BOT_COMMANDS as readonly string[]).includes(command)) {
        await result.reply(helpText())
        finish('ok', 'help')
        return
      }
      let text: string
      switch (command) {
        case 'help':
          text = helpText()
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
          const answer = await this.chatWithAi(bot, result.userId, result.targetExternalId, args, 'task')
          const plain = this.sanitizeAiText(answer)
          await result.reply(formatAiReply(plain) || 'AI 没有返回内容，请稍后再试。')
          this.scheduleMemoryUpdate(bot, result.userId, result.targetExternalId, args, plain)
          finish('ok', 'command_ask')
          return
        }
        case 'role':
          text = await this.executeRoleCommand(bot, result, args)
          break
        case 'reset':
          text = this.resetConversation(bot, result)
          break
        case 'forget':
          text = this.forgetMemory(bot, result, args)
          break
        default:
          text = commandDenied()
      }
      await result.reply(sanitizeExternalText(text))
      finish('ok', command ? `command_${command}` : 'help')
    } catch (error) {
      const sentIds = sentExternalIdsOf(error)
      if (sentIds.length > 0) {
        // 命令回复已部分外发：不再补发失败提示，避免重复外发。
        this.deps.log('warn', 'Bot 命令回复部分外发', {
          bot: bot.id,
          command: command.slice(0, 32),
          sent: sentIds.length,
        })
        finish('error', 'partial_reply')
        return
      }
      await result.reply(commandFailed(command || '命令')).catch(() => undefined)
      finish('error', errorShortCode(error))
    }
  }

  /** `/reset`：删除当前 Bot×目标×用户的 chat/task 会话映射，长期记忆保留。 */
  private resetConversation(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
  ): string {
    this.deleteSessions(bot.id, result.targetExternalId, result.userId, ['chat', 'task'])
    this.deps.audit('bot.reset', bot.id, { bot: bot.id, user: result.userId.slice(0, 64) })
    return '已重置当前对话（长期记忆保留）。'
  }

  /** `/forget confirm`：清除长期记忆（DB+镜像）与该 Bot×用户的全部会话上下文；幂等。 */
  private forgetMemory(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): string {
    if (args.trim().toLowerCase() !== 'confirm') {
      return '用法：/forget confirm（将清除长期记忆与全部对话上下文，此操作不可恢复）。'
    }
    const removed = this.memory.remove(bot.id, result.userId)
    this.db.prepare('DELETE FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?').run(bot.id, result.userId)
    this.deps.audit('bot.memory.forget', bot.id, { bot: bot.id, user: result.userId.slice(0, 64), removed: removed ? 1 : 0 })
    return '已清除长期记忆与全部对话上下文。'
  }

  private async executeRoleCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): Promise<string> {
    // dispatchCommand 已把群聊引导到 roleGroupHint；这里再做一次防御，避免未来路由变化导致群内写角色卡。
    if (!result.isDirect) return roleGroupHint()
    const card = this.roles.get(bot.id, result.userId)
    const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
    const sub = (parsed?.[1] ?? '').toLowerCase()
    const rest = (parsed?.[2] ?? '').trim()
    if (!sub || sub === 'help') {
      const status = card
        ? `当前角色：${card.name}（专属，${card.enabled ? '使用中' : '已暂停'}）`
        : roleDefaultText()
      return `${status}\n\n${roleUsage()}`
    }

    if (sub === 'show') {
      if (!card) return roleDefaultText()
      return [
        `当前角色：${card.name}（专属，${card.enabled ? '使用中' : '已暂停'}）`,
        '设定：',
        card.prompt,
      ].join('\n')
    }

    if (sub === 'set') {
      const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
      const name = (parts?.[1] ?? '').trim()
      const prompt = normalizeRolePrompt(parts?.[2] ?? '')
      const error = validateRole(name, prompt)
      if (error) return roleValidationMessage(error)
      this.roles.save(bot.id, result.userId, name, prompt)
      this.resetChatSession(bot.id, result.targetExternalId, result.userId)
      this.deps.audit('bot.role', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        user: result.userId.slice(0, 64),
        action: 'set',
        nameLength: name.length,
        promptLength: prompt.length,
      })
      return `专属角色「${name}」已设置，私聊将使用该角色；群聊仍使用默认 lofii。`
    }

    if (sub === 'off' || sub === 'on') {
      if (!card) {
        return sub === 'off'
          ? '当前没有专属角色，正在使用默认 lofii。'
          : '当前没有专属角色，可先用 /role set 设置。'
      }
      const enabled = sub === 'on'
      if (!this.roles.setEnabled(bot.id, result.userId, enabled)) return '角色状态更新失败，请稍后重试。'
      this.resetChatSession(bot.id, result.targetExternalId, result.userId)
      this.deps.audit('bot.role', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        user: result.userId.slice(0, 64),
        action: sub,
      })
      return enabled
        ? `专属角色「${card.name}」已启用。`
        : '专属角色已暂停，当前使用默认 lofii。'
    }

    if (sub === 'delete') {
      if (!this.roles.remove(bot.id, result.userId)) {
        return '当前没有专属角色。'
      }
      this.resetChatSession(bot.id, result.targetExternalId, result.userId)
      this.deps.audit('bot.role', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        user: result.userId.slice(0, 64),
        action: 'delete',
      })
      return '专属角色已删除，当前使用默认 lofii。'
    }

    return roleUsage()
  }

  /**
   * 删除会话映射：`/reset` 删 chat+task，角色卡变更只删 chat（task/群会话与远端历史不删除）。
   * 两条路径复用同一 DELETE 语句，避免会话清理逻辑分叉。
   */
  private deleteSessions(
    botId: string,
    targetExternalId: string,
    userId: string,
    modes: readonly BotAiMode[],
  ): void {
    const statement = this.db.prepare(
      'DELETE FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ? AND user_id = ? AND mode = ?',
    )
    for (const mode of modes) statement.run(botId, targetExternalId, userId, mode)
  }

  /** 角色变更后丢弃当前私聊 Chat 映射；task 会话保留。 */
  private resetChatSession(botId: string, targetExternalId: string, userId: string): void {
    this.deleteSessions(botId, targetExternalId, userId, ['chat'])
  }

  private async executeChat(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
    text: string,
  ): Promise<void> {
    const finish = (outcome: BotEventOutcome, detail: string) =>
      this.markEvent(bot.id, result.eventId, {
        outcome,
        detail,
        target: result.targetExternalId,
        user: result.userId,
      })
    try {
      const role = result.isDirect ? this.roles.get(bot.id, result.userId) : null
      const roleCard = role?.enabled ? role : null
      const prepared = await this.prepareAiImage(bot, result)
      if (prepared.kind === 'unsupported') {
        // 图片无法处理且用户没有可用文字：直接提示，不调用模型。
        await result.reply(IMAGE_UNSUPPORTED_TEXT)
        finish('ignored', 'image_unsupported')
        return
      }
      // 仅图片无正文时用中性占位，避免向模型发送空用户消息。
      const userText = text || (result.image ? IMAGE_ONLY_USER_TEXT : '')
      const answer = await this.chatWithAi(
        bot,
        result.userId,
        result.targetExternalId,
        userText,
        'chat',
        roleCard,
        prepared.image,
      )
      const plain = this.sanitizeAiText(answer)
      const formatted = formatAiReply(plain)
      const replyText = prepared.degraded && text ? `${formatted}\n${IMAGE_DEGRADED_NOTE}` : formatted
      await result.reply(replyText || '暂时没回应上来，稍后再试。')
      if (userText) this.scheduleMemoryUpdate(bot, result.userId, result.targetExternalId, userText, plain)
      finish('ok', 'chat')
    } catch (error) {
      if (sentExternalIdsOf(error).length > 0) {
        // 长回复已部分外发：只记日志，不补发失败提示。
        this.deps.log('warn', 'Bot Chat 回复部分外发', {
          bot: bot.id,
          sent: sentExternalIdsOf(error).length,
        })
        finish('error', 'partial_reply')
        return
      }
      finish('error', errorShortCode(error))
      await result.reply('暂时没回应上来，稍后再试。').catch(() => undefined)
    }
  }

  /**
   * 图片预处理：识别关闭/适配器不支持/下载失败/mime 非法时降级为纯文本。
   * - 有文字：继续回答，末尾追加“图片未能处理”说明；
   * - 无文字：返回 unsupported，由调用方提示用户改用文字描述。
   */
  private async prepareAiImage(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
  ): Promise<{ kind: 'ok'; image?: BotAiImage; degraded: boolean } | { kind: 'unsupported' }> {
    const inbound = result.image
    if (!inbound) return { kind: 'ok', degraded: false }
    const degrade = () =>
      result.text.trim()
        ? ({ kind: 'ok', degraded: true } as const)
        : ({ kind: 'unsupported' } as const)
    if (!this.config.botAiVisionEnabled) {
      this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        mime: inbound.mime.slice(0, 50),
        size: inbound.size ?? null,
        skipped: 'vision_disabled',
      })
      return degrade()
    }
    const adapter = this.adapterFor(bot)
    if (!adapter.loadImage) {
      this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        mime: inbound.mime.slice(0, 50),
        size: inbound.size ?? null,
        skipped: 'unsupported',
      })
      return degrade()
    }
    try {
      const loaded = await adapter.loadImage(inbound, {
        maxBytes: this.config.botAiImageMaxBytes,
        timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
      })
      const mime = loaded.mime.toLowerCase()
      if (!IMAGE_MIME_ALLOWLIST.has(mime) || loaded.data.length === 0 || loaded.data.length > this.config.botAiImageMaxBytes) {
        this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
          bot: bot.id,
          mime: mime.slice(0, 50),
          size: loaded.data.length,
          skipped: 'invalid',
        })
        return degrade()
      }
      // 审计只记录 mime/大小，不记录图片内容或 base64。
      this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        mime: mime.slice(0, 50),
        size: loaded.data.length,
      })
      return {
        kind: 'ok',
        degraded: false,
        image: {
          mime,
          base64: loaded.data.toString('base64'),
          ...(inbound.name ? { name: inbound.name.slice(0, 80) } : {}),
        },
      }
    } catch (error) {
      this.deps.log('warn', 'Bot 入站图片处理失败，降级为纯文本', {
        bot: bot.id,
        code: errorShortCode(error),
      })
      return degrade()
    }
  }

  /** Chat/`/ask` 的统一模型调用：按模式选择提示词 + 共享长期记忆 + 用户消息（可选图片）。 */
  private async chatWithAi(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    text: string,
    mode: BotAiMode,
    roleCard?: BotChatRole | null,
    image?: BotAiImage,
  ): Promise<string> {
    if (!this.deps.ai) throw new AppError(503, 'ai_disabled', 'AI 未启用')
    const memory = this.memory.get(bot.id, userId)
    const customPrompt = mode === 'task' ? this.config.botAiTaskPrompt : this.config.botAiChatPrompt
    const prompt = buildBotPrompt({
      mode,
      customPrompt,
      roleCard: mode === 'chat' ? roleCard : null,
      memory: memory.summary,
      userText: text.slice(0, this.config.botAiMaxPromptChars),
    })
    this.deps.audit('bot.ai.chat', `${bot.platform}:${targetExternalId}`, {
      bot: bot.id,
      user: userId.slice(0, 64),
      mode,
      chars: text.length,
      ...(roleCard ? { role: true } : {}),
      ...(image ? { image: image.mime.slice(0, 50) } : {}),
    })
    const answer = await this.deps.ai.chat({
      botId: bot.id,
      targetExternalId,
      userId,
      mode,
      prompt,
      ...(image ? { image } : {}),
    })
    return answer
  }

  /**
   * AI 回答清洗：去除内部路径/URL 与控制字符，保留换行/分段，按配置上限截断。
   * 与 sanitizeExternalText 的固定 1500 截断区分：AI 回答由 QQ 适配器按 2000 上限分段发送。
   */
  private sanitizeAiText(value: string): string {
    if (typeof value !== 'string') return ''
    const replaced = value
      .replace(/\r\n?/g, '\n')
      .replace(/(?:[A-Za-z]:\\|\/(?:home|var|etc|opt|run|proc|sys|tmp)\/)[^\s"'`]+/g, '[path]')
      .replace(/(?:ssh|https?):\/\/[^\s"'`]+/g, '[url]')
    let cleaned = ''
    for (const char of replaced) {
      const code = char.codePointAt(0) ?? 0
      if (code === 10 || code === 9 || (code >= 32 && code !== 127)) cleaned += char
    }
    // 保留换行/分段，仅收敛行内多余空白；不要压缩空行。
    cleaned = cleaned
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .trim()
    return cleaned.slice(0, this.config.botAiMaxReplyChars)
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
   * 入站目标解析：优先按平台目标 ID；私聊没有独立频道目标时回退到 user 目标（QQ C2C）。
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

  private adapterFor(row: BotRow): BotAdapter {
    const config = parseConfig(row.config_json)
    const secret = this.secretOf(row)
    return new QqAdapter(config, secret, { fetch: this.deps.fetch, now: this.deps.now })
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
    return { token: cleanText(input.token, 500) }
  }

  private normalizeConfig(raw: Record<string, unknown> | undefined): Record<string, unknown> {
    const source = raw ?? {}
    return { appId: cleanText(source.appId ?? source.applicationId, 64) }
  }

  private validateOrThrow(config: Record<string, unknown>, secret: BotSecret): void {
    const adapter = new QqAdapter(config, secret, { fetch: this.deps.fetch, now: this.deps.now })
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
    lastErrorHint: describeBotError(row.last_error),
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
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    lastErrorHint: describeBotError(row.last_error),
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }
}
