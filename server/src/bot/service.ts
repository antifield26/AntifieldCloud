/**
 * Bot 平台服务（QQ 官方 Bot 单平台）：配置 CRUD、Webhook 验签/命令分发、通知/发布队列、投递重试与结构化长期记忆。
 * 安全边界：AppSecret 只以 AES-256-GCM 密文落库；Webhook 无 session/CSRF，Ed25519 签名是唯一鉴权；
 * 自助命令（/help、/role 私聊、/reset、/forget、/memory）对所有用户开放；其余命令必须命中 bot_targets.allow_commands + 显式 user 白名单；
 * 发布只允许登录管理员调用；通知/命令输出不得包含内部路径、URL 或密钥；记忆管理接口只返回元数据，不返回 key/value。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import { AppError, badRequest, notFound } from '../util/errors.ts'
import { getMeta, setMeta } from '../db.ts'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import { SlidingWindowLimiter } from '../auth/limiter.ts'
import {
  BotInboundHandler,
  cleanText,
  errorShortCode,
  normalizeGroupReplyMode,
  sanitizeExternalText,
  sentExternalIdsOf,
  type BurstTimingLike,
  type ParsedCommand,
} from './inbound.ts'
import { BotDiagnostics } from './diagnostics.ts'
import { BotQueue } from './queue.ts'
import { BotChatPipeline } from './chat.ts'
import {
  BOT_COMMANDS,
  isBotPlatform,
  type BotAdapter,
  type BotDelivery,
  type BotDeliveryRow,
  type BotEventItem,
  type BotEventOutcome,
  type BotGroupRoleDetail,
  type BotGroupRoleSummary,
  type BotHealthCheck,
  type BotInboundTarget,
  type BotInboundTargetRow,
  type BotMemoryItemSummary,
  type BotMemoryGroupSummary,
  type BotMemoryKind,
  type BotMemoryOperation,
  type BotMemoryUserSummary,
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
  type BotToolIsolationStatus,
  type GroupReplyMode,
  type InboundVerification,
} from './types.ts'
import { decodeBotKey, decryptBotSecret, encryptBotSecret } from './crypto.ts'
import { describeBotError } from './errors.ts'
import { BotMemoryStore, GROUP_MEMORY_PREFIX, groupMemoryScope } from './memory.ts'
import {
  BotChatRoleStore,
  normalizeRolePrompt,
  validateRole,
  type RoleValidationError,
} from './roles.ts'
import { BotGroupRoleStore } from './group-roles.ts'
import { BotConnectivityMonitor, type ConnectivitySnapshot } from './connectivity.ts'
import { QqAdapter } from './adapters/qq.ts'
import { BOT_TEXT_LIMITS } from './text.ts'
import {
  commandDenied,
  commandFailed,
  formatFileList,
  formatPairs,
  helpText,
  publicHelpText,
  roleDefaultText,
  roleGroupHint,
  roleShowText,
  roleUsage,
} from './templates.ts'

const NAME_MAX = 80
const TARGET_MAX = 128
const MAX_TARGETS_PER_BOT = 100
/** QQ 单条文本上限；发布内容在入队前先校验。 */
const PUBLISH_TEXT_MAX = BOT_TEXT_LIMITS.qq
/** 结构化记忆类型的中文标签；仅用于 /memory 状态展示（不展示 key/value）。 */
const MEMORY_KIND_LABEL: Record<BotMemoryKind, string> = {
  profile: '资料',
  preference: '偏好',
  fact: '事实',
  project: '项目',
  task: '任务',
  relationship: '关系',
  episode: '事件',
}
/** 单次记忆抽取允许的最大操作数；与 MemoryStore 内部上限一致。 */
const MEMORY_MAX_OPS = 20
/** v0.6.4 之前的旧默认会话标题（精确匹配）；孤儿清理只针对它们，避免误删新命名/归档会话。 */
const LEGACY_SESSION_TITLES = new Set(['AntifieldCloud Chat', 'AntifieldCloud Memory'])
/** 群记忆一次性归属迁移的 meta 标记；迁移成功后不再重复执行。 */
const GROUP_MEMORY_OWNER_MIGRATION_KEY = 'bot_group_memory_owner_migrated_v1'
/** Webhook 验签失败/未认证请求的每 Bot 分钟桶上限（只限制无效流量，不影响已验签事件）。 */
const WEBHOOK_UNAUTHENTICATED_PER_MINUTE = 120
/** Webhook 已验签事件每 Bot 分钟桶上限（业务限流，验签通过后才扣减）。 */
const WEBHOOK_AUTHENTICATED_PER_MINUTE = 300

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
  /** 仅群聊目标：mention=仅 @/名字提及；all=全部消息（实验性）。 */
  groupReplyMode?: GroupReplyMode
  quietStartMinute?: number | null
  quietEndMinute?: number | null
}

export interface UpdateTargetInput {
  label?: string
  kind?: 'channel' | 'user' | 'group'
  allowCommands?: boolean
  allowNotifications?: boolean
  allowChat?: boolean
  groupReplyMode?: GroupReplyMode
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

export class BotService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly deps: BotServiceDeps
  /** 诊断事件/指标存储（只做 DB 读写；权限开关由本类校验）。 */
  private readonly diagnostics: BotDiagnostics
  /** 出站投递/发布队列（入队、claim、退避、死信、TTL）。 */
  private readonly queue: BotQueue
  /** Chat 管线（连续消息合并/串行/AI/搜索/发送工具）。 */
  private readonly chat: BotChatPipeline
  private readonly key: Buffer | null
  private readonly limiter: SlidingWindowLimiter
  /** 未通过验签的 Webhook 请求（每 Bot 分钟桶）；与已验签业务桶分离，无效流量无法饿死合法事件。 */
  private readonly webhookUnauthenticatedLimiter: SlidingWindowLimiter
  /** 已验签 Webhook 事件（每 Bot 分钟桶，验签通过后才扣减）。 */
  private readonly webhookAuthenticatedLimiter: SlidingWindowLimiter

  /** Webhook 拒绝/限流审计的窗口聚合计数（避免每次 401/429 各写一条审计）。 */
  private readonly webhookAuditWindows = new Map<string, { minute: number; count: number }>()
  private readonly memory: BotMemoryStore
  private readonly roles: BotChatRoleStore
  private readonly groupRoles: BotGroupRoleStore
  private readonly connectivity: BotConnectivityMonitor
  /** 入站 Webhook 处理（验签/限流/去重/命令与 Chat 路由）；行为与重构前一致。 */
  private readonly inbound: BotInboundHandler
  /** 活跃的 AI 消息发送回合（只存内存；回合结束即清理）。 */
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private ticking = false
  private readonly pending = new Set<Promise<void>>()
  /** 待抽取的对话批次：按 Bot×用户去重，减少高频 Chat 的额外模型调用。 */
  private readonly memoryPending = new Map<
    string,
    {
      bot: BotRow
      userId: string
      targetExternalId: string
      memoryScope: string
      groupUserName?: string
      rounds: { userText: string; assistantText: string }[]
    }
  >()
  private readonly memoryTimers = new Map<string, NodeJS.Timeout>()
  /** 同一 Bot×用户的记忆抽取串行执行，避免并发读到旧条目后互相覆盖。 */
  private readonly memoryQueues = new Map<string, Promise<void>>()
  /**
   * 每用户记忆 generation：/memory off、/forget、管理端删除会递增，
   * 在途抽取写回前校验版本，避免被取消的批次把旧数据写回。
   */
  private readonly memoryGenerations = new Map<string, number>()
  /** 上次观察到的 AI 工具隔离降级次数：用于把降级写成一次性审计而不是只留日志。 */
  private lastAiFallbackCount = 0

  constructor(deps: BotServiceDeps) {
    this.db = deps.db
    this.config = deps.config
    this.deps = deps
    this.diagnostics = new BotDiagnostics({ db: deps.db })
    this.queue = new BotQueue({
      db: deps.db,
      config: deps.config,
      log: deps.log,
      audit: deps.audit,
      botRow: (id) => this.botRow(id),
      targetRow: (id) => this.targetRow(id),
      publishRow: (id) => this.publishRow(id),
      adapterFor: (bot) => this.adapterFor(bot),
      now: deps.now,
    })
    this.limiter = new SlidingWindowLimiter(60_000, Math.max(1, deps.config.botCommandRatePerMinute))
    this.webhookUnauthenticatedLimiter = new SlidingWindowLimiter(60_000, WEBHOOK_UNAUTHENTICATED_PER_MINUTE)
    this.webhookAuthenticatedLimiter = new SlidingWindowLimiter(60_000, WEBHOOK_AUTHENTICATED_PER_MINUTE)
    this.memory = new BotMemoryStore(deps.db, deps.config.dataDir, {
      maxItems: deps.config.botMemoryMaxItems,
      promptMaxChars: deps.config.botMemoryPromptMaxChars,
      promptMaxItems: deps.config.botMemoryPromptMaxItems,
      // fact/project 复用旧记忆保留期；episode/task 使用独立 TTL。
      factProjectTtlDays: deps.config.botAiMemoryRetentionDays,
      episodeTtlDays: deps.config.botMemoryTtlEpisodeDays,
      taskTtlDays: deps.config.botMemoryTtlTaskDays,
      legacyMaxChars: deps.config.botAiMemoryMaxChars,
    })
    this.roles = new BotChatRoleStore(deps.db)
    this.groupRoles = new BotGroupRoleStore(deps.db)
    this.resetSessionsForToolMode()
    this.connectivity = new BotConnectivityMonitor({
      enabled: deps.config.botEnabled && deps.config.botConnectivityEnabled,
      intervalSeconds: deps.config.botConnectivityIntervalSeconds,
      timeoutSeconds: deps.config.botConnectivityTimeoutSeconds,
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
    this.inbound = new BotInboundHandler({
      db: this.db,
      config: this.config,
      log: this.deps.log,
      audit: this.deps.audit,
      botRow: (id) => this.botRow(id),
      adapterFor: (bot) => this.adapterFor(bot),
      inboundTarget: (botId, result) => this.inboundTarget(botId, result),
      isCommandUserAllowed: (botId, userId) => this.isCommandUserAllowed(botId, userId),
      commandLimiter: this.limiter,
      webhookUnauthenticatedLimiter: this.webhookUnauthenticatedLimiter,
      webhookAuthenticatedLimiter: this.webhookAuthenticatedLimiter,
      auditWebhookThrottled: (action, botId, detail) => this.auditWebhookThrottled(action, botId, detail),
      insertEvent: (botId, eventId, kind, outcome, detail, targetExternalId, userId) =>
        this.insertEvent(botId, eventId, kind, outcome, detail, targetExternalId, userId),
      markEvent: (botId, eventId, update) => this.markEvent(botId, eventId, update),
      recordInbound: (bot, result) => this.recordInbound(bot, result),
      executeCommand: (bot, result, parsed, adminAllowed) => this.executeCommand(bot, result, parsed, adminAllowed),
      enqueueChat: (bot, result, text, timing) => this.enqueueChatMessage(bot, result, text, timing),
      track: (task) => {
        this.pending.add(task)
        void task.finally(() => this.pending.delete(task))
      },
      aiIsolationBlocked: () => this.aiIsolationBlocked(),
    })
    this.chat = new BotChatPipeline({
      config: this.config,
      key: this.key,
      deps: {
        db: this.db,
        log: this.deps.log,
        audit: this.deps.audit,
        ai: this.deps.ai,
        search: this.deps.search,
        now: this.deps.now,
        memory: this.memory,
      },
      roles: this.roles,
      groupRoles: this.groupRoles,
      host: {
        markEvent: (botId, eventId, update) => this.markEvent(botId, eventId, update),
        inboundTarget: (botId, result) => this.inboundTarget(botId, result),
        inboundDisplayName: (result) => this.inboundDisplayName(result),
        targetNameForSession: (botId, targetExternalId, userId, userName) =>
          this.targetNameForSession(botId, targetExternalId, userId, userName),
        scheduleMemoryUpdate: (bot, userId, targetExternalId, userText, assistantText, options) =>
          this.scheduleMemoryUpdate(bot, userId, targetExternalId, userText, assistantText, options),
        observeAiToolIsolation: (botId) => this.observeAiToolIsolation(botId),
        aiIsolationBlocked: () => this.aiIsolationBlocked(),
        adapterFor: (bot) => this.adapterFor(bot),
        trackTask: (task) => {
          this.pending.add(task)
          void task.finally(() => this.pending.delete(task))
        },
      },
    })
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
    return {
      enabled: this.enabled,
      keyConfigured: this.key !== null,
      bots: bots.c,
      enabledBots: enabledBots.c,
      targets: targets.c,
      queuedDeliveries: deliveries.c,
      queuedPublishes: publishes.c,
      lastError: this.latestBotError(null),
      aiToolIsolation: this.aiToolIsolationStatus(),
    }
  }

  /** AI 工具隔离状态：未配置 AI 时返回 null；用于 /api/bots/status 与降级审计。 */
  private aiToolIsolationStatus(): BotToolIsolationStatus | null {
    try {
      return this.deps.ai?.toolIsolation?.() ?? null
    } catch {
      return null
    }
  }

  /**
   * SEC-11 fail-closed：启用消息发送工具时，工具隔离不可用且仍在重试窗口内就拒绝新的 AI 对话，
   * 不以默认权限继续运行；由 Chat 入口与批次执行前双重检查。
   *
   * 到 `retryAt` 后必须放行给 AI 层重试（ai.chat 内部仍 fail-closed），否则 10 分钟重试永远无法发生。
   * `retryAt` 缺失（旧 AI 实现/无窗口信息）时不前置阻断，交给 ai.chat 的 503 兜底。
   */
  private aiIsolationBlocked(): boolean {
    if (!this.config.botAiSendToolEnabled) return false
    const status = this.aiToolIsolationStatus()
    if (!status || status.supported !== false) return false
    if (!status.retryAt) return false
    const retryAt = Date.parse(status.retryAt)
    return Number.isFinite(retryAt) && Date.now() < retryAt
  }

  /**
   * Webhook 拒绝/限流审计按「每 Bot×动作×分钟」聚合：第 1 次与每满 50 次写一条，
   * 避免未认证请求刷 401/429 时把 audit_log 写满（A5-BOT-16 遗留的写放大问题）。
   */
  private auditWebhookThrottled(action: string, botId: string, detail?: Record<string, unknown>): void {
    const minute = Math.floor(Date.now() / 60_000)
    const key = `${action}\u0000${botId}`
    const entry = this.webhookAuditWindows.get(key)
    const count = entry && entry.minute === minute ? entry.count + 1 : 1
    this.webhookAuditWindows.set(key, { minute, count })
    if (count === 1 || count % 50 === 0) {
      this.deps.audit(action, botId, detail ? { ...detail, count } : { count })
    }
    // 窗口滚动时清理其它过期键，避免 Map 随 bot/动作增长（Bot 数量有限，但仍显式收敛）。
    if (this.webhookAuditWindows.size > 200) {
      for (const [windowKey, window] of this.webhookAuditWindows) {
        if (window.minute < minute) this.webhookAuditWindows.delete(windowKey)
      }
    }
  }

  /** 最近一次投递/发布失败（BOT-07）：派生自队列，避免 bots.last_error 死字段。 */
  private latestBotError(botId: string | null, fallback: string | null = null): string | null {
    return this.diagnostics.findLatestError(botId, fallback)
  }

  /**
   * 观察 AI 工具隔离是否发生新的降级：OpenCode 拒绝 permissions 后仅日志不足以告警，
   * 这里在每次 AI 调用后比较累计次数，新增降级写审计 `bot.ai.permissions_fallback`（不含提示词）。
   */
  private observeAiToolIsolation(botId: string): void {
    const status = this.aiToolIsolationStatus()
    if (!status || status.fallbackCount <= this.lastAiFallbackCount) return
    this.lastAiFallbackCount = status.fallbackCount
    this.deps.log('warn', 'AI 工具隔离降级：OpenCode 拒绝 permissions，会话以默认工具权限运行（未隔离）', {
      bot: botId,
      fallbackCount: status.fallbackCount,
      supported: status.supported,
    })
    this.deps.audit('bot.ai.permissions_fallback', botId, {
      fallbackCount: status.fallbackCount,
      supported: status.supported,
      fallbackAt: status.fallbackAt,
    })
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
    return this.diagnostics.metrics(botId, hours)
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
    const groupReplyMode = normalizeGroupReplyMode(input.groupReplyMode, input.kind)
    const id = newId()
    try {
      this.db
        .prepare(
          `INSERT INTO bot_targets
           (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, allow_chat, chat_trigger, quiet_start_minute, quiet_end_minute, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          groupReplyMode,
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
    const kind = input.kind ?? row.kind
    const groupReplyMode = normalizeGroupReplyMode(
      input.groupReplyMode === undefined
        ? kind === row.kind
          ? row.chat_trigger
          : undefined
        : input.groupReplyMode,
      kind,
    )
    const quiet = this.normalizeQuiet(
      input.quietStartMinute === undefined ? row.quiet_start_minute : input.quietStartMinute,
      input.quietEndMinute === undefined ? row.quiet_end_minute : input.quietEndMinute,
    )
    this.db
      .prepare(
        `UPDATE bot_targets
         SET label = ?, kind = ?, allow_commands = ?, allow_notifications = ?, allow_chat = ?, chat_trigger = ?,
             quiet_start_minute = ?, quiet_end_minute = ?
         WHERE id = ?`,
      )
      .run(
        label,
        kind,
        input.allowCommands === undefined ? row.allow_commands : input.allowCommands ? 1 : 0,
        input.allowNotifications === undefined ? row.allow_notifications : input.allowNotifications ? 1 : 0,
        input.allowChat === undefined ? row.allow_chat : input.allowChat ? 1 : 0,
        groupReplyMode,
        quiet.start,
        quiet.end,
        targetId,
      )
    if (kind !== 'group') this.groupRoles.remove(botId, targetId)
    // 目标从群聊改为其它类型后，原群共享记忆 scope 会变成不可管理的孤儿，直接清理。
    if (row.kind === 'group' && kind !== 'group') this.dropGroupTargetMemory(botId, row.external_id)
    this.deps.audit('bot.target.update', `${botId}:${targetId}`)
    return toTarget(this.targetRowForBot(botId, targetId))
  }

  deleteTarget(botId: string, targetId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const row = this.targetRowForBot(botId, targetId)
    this.db.prepare('DELETE FROM bot_targets WHERE id = ?').run(targetId)
    if (row.kind === 'group') this.dropGroupTargetMemory(botId, row.external_id)
    this.deps.audit('bot.target.delete', `${botId}:${targetId}`)
  }

  /** 目标删除/改类型后清理其群共享记忆 scope（含状态/旧摘要），避免孤儿记忆无法再被管理。 */
  private dropGroupTargetMemory(botId: string, targetExternalId: string): void {
    const scope = groupMemoryScope(targetExternalId)
    this.cancelGroupMemoryScope(botId, scope)
    this.memory.deleteGroupScope(botId, scope)
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

  /** 删除角色卡，并清理该 Bot×用户的全部会话映射与远端会话（下次 Chat 重新创建会话）。 */
  deleteRole(botId: string, userId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const card = this.roles.get(botId, userId)
    if (!card || !this.roles.remove(botId, userId)) throw notFound('角色卡不存在')
    this.deleteRemoteSessions(botId, { userId })
    this.db.prepare('DELETE FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?').run(botId, userId)
    this.deps.audit('bot.role.admin', `${botId}:${userId.slice(0, 64)}`, {
      action: 'delete',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 群聊角色卡列表：始终列出群聊目标，未配置时 role 元数据为空。 */
  listGroupRoles(botId: string): { items: BotGroupRoleSummary[] } {
    this.requireEnabled()
    this.botRow(botId)
    return { items: this.groupRoles.list(botId) }
  }

  /** 群聊角色卡正文仅供管理员编辑；目标必须是群聊。 */
  getGroupRole(botId: string, targetId: string): BotGroupRoleDetail | null {
    this.requireEnabled()
    this.botRow(botId)
    const target = this.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.groupRoles.getByTargetId(botId, targetId)
    if (!card) return null
    return {
      targetId: target.id,
      targetLabel: target.label,
      targetExternalId: target.external_id,
      name: card.name,
      prompt: card.prompt,
      enabled: card.enabled,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    }
  }

  /** 新建/覆盖群聊角色卡；正文只保存在 DB，不写入日志/审计。 */
  saveGroupRole(botId: string, targetId: string, name: string, prompt: string): BotGroupRoleDetail {
    this.requireEnabled()
    this.botRow(botId)
    const target = this.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const normalizedPrompt = normalizeRolePrompt(prompt)
    const trimmedName = name.trim()
    const error = validateRole(trimmedName, normalizedPrompt)
    if (error) throw badRequest(roleValidationMessage(error))
    const card = this.groupRoles.save(target, trimmedName, normalizedPrompt)
    this.deps.audit('bot.group_role.admin', `${botId}:${targetId}`, {
      action: 'save',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
    return {
      targetId: target.id,
      targetLabel: target.label,
      targetExternalId: target.external_id,
      name: card.name,
      prompt: card.prompt,
      enabled: card.enabled,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    }
  }

  setGroupRoleEnabled(botId: string, targetId: string, enabled: boolean): void {
    this.requireEnabled()
    this.botRow(botId)
    const target = this.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.groupRoles.getByTargetId(botId, targetId)
    if (!card || !this.groupRoles.setEnabled(botId, targetId, enabled)) throw notFound('群聊角色卡不存在')
    this.deps.audit('bot.group_role.admin', `${botId}:${targetId}`, {
      action: enabled ? 'enable' : 'disable',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  deleteGroupRole(botId: string, targetId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const target = this.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.groupRoles.getByTargetId(botId, targetId)
    if (!card || !this.groupRoles.remove(botId, targetId)) throw notFound('群聊角色卡不存在')
    this.deps.audit('bot.group_role.admin', `${botId}:${targetId}`, {
      action: 'delete',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /**
   * 结构化记忆管理：用户级元数据分页（条目数/类型分布/启停/更新时间），不含 key/value。
   * userName 由 MemoryStore 结合最近入站目标补齐。
   */
  listMemories(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemoryUserSummary[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    return this.memory.listUsers(botId, limit, offset)
  }

  /** 群聊共享记忆管理：按群目标聚合的元数据分页，不含 key/value。 */
  listGroupMemories(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemoryGroupSummary[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    return this.memory.listGroups(botId, options.limit ?? 20, options.offset ?? 0)
  }

  /** 清空某个群目标的共享记忆；scope 必须是内部群 scope，避免误删用户记忆。 */
  deleteGroupMemory(botId: string, scope: string): void {
    this.requireEnabled()
    this.botRow(botId)
    if (!scope.startsWith(GROUP_MEMORY_PREFIX)) throw badRequest('群聊记忆标识无效')
    // 先取消该 scope 下所有成员的在途抽取/待处理批次，避免清空后旧批次写回（BOT-06）。
    this.cancelGroupMemoryScope(botId, scope)
    this.deleteMemory(botId, scope)
  }

  /**
   * D-13 一次性归属迁移：把旧版按显示名前缀存储的群共享条目改为稳定 `member_openid:` 前缀。
   * 通过 meta 标记保证只执行一次；失败时保留标记缺失，下次启动重试。
   */
  migrateGroupMemoryOwners(): {
    migrated: number
    legacy: number
    groups: number
    skippedConflicts: number
    skipped: boolean
  } {
    if (getMeta(this.db, GROUP_MEMORY_OWNER_MIGRATION_KEY)) {
      return { migrated: 0, legacy: 0, groups: 0, skippedConflicts: 0, skipped: true }
    }
    const result = this.memory.renameGroupItemOwners()
    setMeta(this.db, GROUP_MEMORY_OWNER_MIGRATION_KEY, nowIso())
    this.deps.audit('bot.memory.group_owner_migrate', 'bot', result)
    this.deps.log('info', '群聊共享记忆归属迁移完成', result)
    return { ...result, skipped: false }
  }

  /**
   * 一次性数据迁移：把群聊参与者的用户级记忆复制/迁移到群共享记忆。
   * 通过 meta 标记保证进程重启后不重复执行；失败时保留标记缺失，下次启动重试。
   */
  migrateGroupChatMemories(): { copied: number; moved: number; groups: number; skipped: boolean } {
    const key = 'bot_group_memory_migrated_v1'
    if (getMeta(this.db, key)) return { copied: 0, moved: 0, groups: 0, skipped: true }
    const result = this.memory.migrateGroupParticipantMemories()
    setMeta(this.db, key, nowIso())
    this.deps.audit('bot.memory.group_migrate', 'bot', {
      copied: result.copied,
      moved: result.moved,
      groups: result.groups,
    })
    this.deps.log('info', '群聊共享记忆迁移完成', {
      copied: result.copied,
      moved: result.moved,
      groups: result.groups,
    })
    return { ...result, skipped: false }
  }

  /** 管理端条目元数据分页：只有 id/类型/重要度/置信度/时间，不含 key/value。 */
  listMemoryItems(
    botId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemoryItemSummary[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    return this.memory.listItems(botId, userId, limit, offset)
  }

  /** 删除单条结构化记忆（管理端）；不存在时 404。审计不含 key/value。 */
  deleteMemoryItem(botId: string, userId: string, itemId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    const id = itemId.trim().slice(0, 64)
    if (!id) throw badRequest('记忆条目 ID 不能为空')
    if (!this.memory.deleteItem(botId, userId, id)) throw notFound('记忆条目不存在')
    this.deps.audit('bot.memory.delete_item', `${botId}:${userId.slice(0, 64)}`, {
      bot: botId,
      user: userId.slice(0, 64),
      item: id,
    })
  }

  /** 整用户删除结构化记忆（条目+状态+旧摘要+镜像）；不存在时 404。审计不含正文。 */
  deleteMemory(botId: string, userId: string): void {
    this.requireEnabled()
    this.botRow(botId)
    // 先取消待处理批次并递增 generation，防止删除后在途抽取回写。
    this.cancelUserMemory(botId, userId)
    const result = this.memory.deleteUser(botId, userId)
    if (result.deletedItems === 0 && !result.deletedState && !result.deletedLegacy) throw notFound('长期记忆不存在')
    this.deps.audit('bot.memory.delete_user', `${botId}:${userId.slice(0, 64)}`, {
      bot: botId,
      user: userId.slice(0, 64),
      items: result.deletedItems,
      legacy: result.deletedLegacy ? 1 : 0,
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
  /** 诊断事件列表（只含元数据）；权限/开关校验保留在 facade。 */
  listEvents(
    botId: string,
    options: { hours?: number; limit?: number; offset?: number; outcome?: string } = {},
  ): { items: BotEventItem[]; total: number } {
    this.requireEnabled()
    this.botRow(botId)
    return this.diagnostics.listEvents(botId, options)
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
    if (!this.queue.retryDelivery(botId, deliveryId)) throw notFound('投递记录不存在或不可重试')
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
    if (text.length > PUBLISH_TEXT_MAX) {
      throw badRequest(`内容超过 ${PUBLISH_TEXT_MAX} 字符`, 'publish_text_too_long')
    }
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
    return this.queue.sendTest(bot, target)
  }

  /**
   * OpenCode 的工具权限在会话创建时固定；搜索模式或消息发送工具开关变化后，
   * 旧会话即使映射仍在也没有新工具（或可能沿用不再需要的权限）。
   * 用 meta 记录上次工具模式，模式变化时一次性清空会话映射（新 Chat 会重新建会话），避免
   * “提示词说有工具、实际不可用”或沿用旧权限。消息发送工具启用时也必须重建会话。
   */
  private resetSessionsForToolMode(): void {
    if (!this.config.botEnabled || !this.config.botAiEnabled) return
    const searchMode = this.config.botSearchEnabled ? this.config.botSearchMode : 'off'
    const mode = `${searchMode}:${this.config.botAiSendToolEnabled ? 'send' : 'nosend'}`
    const previous = getMeta(this.db, 'bot_ai_tool_mode')
    if (previous === mode) {
      void this.cleanupRemoteSessions([])
      return
    }
    try {
      const sessionRows = this.db
        .prepare('SELECT session_id FROM bot_ai_sessions')
        .all() as { session_id: string }[]
      const changes = Number(this.db.prepare('DELETE FROM bot_ai_sessions').run().changes)
      setMeta(this.db, 'bot_ai_tool_mode', mode)
      if (changes > 0) {
        this.deps.audit('bot.ai.tool_mode_reset', null, { mode, sessions: changes })
      }
      void this.cleanupRemoteSessions(sessionRows.map((row) => row.session_id))
    } catch (error) {
      this.deps.log('warn', 'Bot AI 工具模式切换清理会话失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  /**
   * 工具模式切换后删除旧远端会话，并保守清理没有 DB 映射的孤儿 Bot 会话。
   *
   * 只清理 v0.6.4 之前的旧默认标题（精确匹配 `AntifieldCloud Chat`/`AntifieldCloud Memory`）。
   * v0.6.4 起会话标题是「目标名称 Chat/Memory」，与其用前缀猜测，不如不主动删：
   * - 2.1.x `session.list` 是否包含 archived 尚未验证，按前缀删除可能误删归档/自定义会话；
   * - 新命名孤儿本版先保留，待 OpenCode 2.1.4 归档语义验证后再单独设计清理策略。
   */
  private async cleanupRemoteSessions(ids: string[]): Promise<void> {
    const ai = this.deps.ai
    if (!ai?.deleteSession && !ai?.listSessions) return
    for (const id of ids) {
      if (id) await ai.deleteSession?.(id).catch(() => undefined)
    }
    if (!ai.listSessions) return
    try {
      const sessions = await ai.listSessions()
      const mapped = new Set(
        (this.db.prepare('SELECT session_id FROM bot_ai_sessions').all() as { session_id: string }[]).map(
          (row) => row.session_id,
        ),
      )
      let removed = 0
      for (const session of sessions) {
        if (!LEGACY_SESSION_TITLES.has(session.title.trim())) continue
        if (mapped.has(session.id)) continue
        await ai.deleteSession?.(session.id).catch(() => undefined)
        removed += 1
      }
      if (removed > 0) this.deps.audit('bot.ai.orphan_sessions_removed', null, { sessions: removed })
    } catch (error) {
      this.deps.log('warn', '清理远端 Bot 孤儿会话失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending])
    // 连续消息缓冲可能仍在防抖计时；一并排空，保证测试/关闭能看到最终回复。
    await this.chat.drain()
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
    try {
      this.migrateGroupChatMemories()
    } catch (error) {
      // 迁移失败不阻塞 Bot 启动；保留 meta 标记缺失，下次启动重试。
      this.deps.log('warn', '群聊共享记忆迁移失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
    try {
      // 必须在 v0.6.6 群记忆迁移之后执行（把显示名 key 改写成 member_openid）。
      this.migrateGroupMemoryOwners()
    } catch (error) {
      this.deps.log('warn', '群聊共享记忆归属迁移失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
    this.stopped = false
    this.timer = setInterval(() => this.scheduleTick(), this.config.botDeliveryIntervalSeconds * 1000)
    this.timer.unref()
    this.scheduleTick()
    this.connectivity.start()
  }

  stop(): void {
    this.stopped = true
    this.flushPendingMemory()
    this.chat.stop()
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
      this.queue.recoverStaleQueue()
      await this.queue.processDeliveries()
      await this.queue.processPublishJobs()
      this.cleanup()
    } finally {
      this.ticking = false
    }
  }

  /** 告警通知入队（静默时段只延迟 next_attempt_at）。 */
  notifyAlert(event: BotAlertEvent): void {
    if (!this.enabled) return
    this.queue.notifyAlert(event)
  }

  /** 投递队列扫描（tick/测试可直接调用）。 */
  async processDeliveries(): Promise<void> {
    await this.queue.processDeliveries()
  }

  /** 发布队列扫描（tick/测试可直接调用）。 */
  async processPublishJobs(): Promise<void> {
    await this.queue.processPublishJobs()
  }

  /** Webhook 入口（无 session/CSRF）：验签、去重、命令/Chat 分发全部在 inbound 模块。 */
  async handleWebhook(
    botId: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): Promise<{ status: number; body: unknown }> {
    return this.inbound.handleWebhook(botId, headers, body)
  }

  /** 消息发送工具入口：认证/缓冲在 Chat 管线内完成。 */
  handleAiSendTool(input: unknown): { status: number; body: unknown } {
    return this.chat.handleAiSendTool(input)
  }

  private insertEvent(
    botId: string,
    eventId: string,
    kind: string,
    outcome: BotEventOutcome,
    detail: string | null,
    targetExternalId: string | null,
    userId: string | null,
  ): boolean {
    return this.diagnostics.insertEvent(botId, eventId, kind, outcome, detail, targetExternalId, userId)
  }

  private markEvent(
    botId: string,
    eventId: string,
    update: { outcome: BotEventOutcome; detail?: string; target?: string; user?: string },
  ): void {
    this.diagnostics.markEvent(botId, eventId, update)
  }

  private recordInbound(bot: BotRow, result: Extract<InboundVerification, { kind: 'command' | 'chat' }>): void {
    this.diagnostics.recordInbound(bot, result)
  }

  /** 入站模块把 Chat 消息放入连续消息合并器（保留原有 burst 时序语义）。 */
  private enqueueChatMessage(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
    text: string,
    timing: BurstTimingLike | undefined,
  ): void {
    this.chat.enqueue(bot, result, text, timing)
  }

  private chatBurstKey(botId: string, targetExternalId: string, userId: string): string {
    return `${botId}:${targetExternalId}:${userId}`
  }

  private async executeCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    parsed: ParsedCommand | null,
    adminAllowed: boolean,
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
        await result.reply(adminAllowed ? helpText() : publicHelpText())
        finish('ok', 'help')
        return
      }
      let text: string
      switch (command) {
        case 'search':
          await this.chat.executeSearchChat(bot, result, args)
          return
        case 'help':
          text = adminAllowed ? helpText() : publicHelpText()
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
        case 'role':
          text = await this.executeRoleCommand(bot, result, args)
          break
        case 'reset':
          text = this.resetConversation(bot, result)
          break
        case 'forget':
          text = this.forgetMemory(bot, result, args)
          break
        case 'memory':
          text = this.executeMemoryCommand(bot, result, args)
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

  /** `/reset`：删除当前 Bot×目标×用户的会话映射与远端会话，长期记忆保留。 */
  private resetConversation(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
  ): string {
    this.chat.clearSession(bot.id, result.targetExternalId, result.userId)
    this.chat.clearSearchQuery(bot.id, result.userId)
    this.resetChatSession(bot.id, result.targetExternalId, result.userId)
    void this.cleanupRemoteSessions([])
    this.deps.audit('bot.reset', bot.id, { bot: bot.id, user: result.userId.slice(0, 64) })
    return '已重置当前对话（长期记忆保留）。'
  }

  /**
   * `/forget confirm`：删除结构化记忆（条目+状态+旧摘要+镜像）、全部会话映射与远端会话；幂等。
   * 同时取消待处理批次并递增 generation，避免在途抽取把旧记忆写回。
   */
  private forgetMemory(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): string {
    if (args.trim().toLowerCase() !== 'confirm') {
      return '用法：/forget confirm（将清除长期记忆与全部对话上下文，此操作不可恢复）。'
    }
    this.cancelUserMemory(bot.id, result.userId)
    // D-13：群共享记忆条目按稳定 member_openid 归属，/forget 同时清除本人贡献的群记忆并取消在途抽取。
    this.cancelMemberGroupMemory(bot.id, result.userId)
    this.chat.clearSession(bot.id, result.targetExternalId, result.userId)
    this.chat.clearSearchQuery(bot.id, result.userId)
    this.deleteRemoteSessions(bot.id, { userId: result.userId })
    void this.cleanupRemoteSessions([])
    const removed = this.memory.deleteUser(bot.id, result.userId)
    const groupRemoved = this.memory.deleteMemberGroupItems(bot.id, result.userId)
    this.db.prepare('DELETE FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?').run(bot.id, result.userId)
    this.deps.audit('bot.memory.forget', bot.id, {
      bot: bot.id,
      user: result.userId.slice(0, 64),
      items: removed.deletedItems,
      legacy: removed.deletedLegacy ? 1 : 0,
      groupItems: groupRemoved.items,
      groupScopes: groupRemoved.groups,
    })
    return removed.deletedItems > 0 || removed.deletedLegacy || groupRemoved.items > 0
      ? `已清除长期记忆与全部对话上下文（记忆条目 ${removed.deletedItems} 条${groupRemoved.items > 0 ? `，群聊共享记忆 ${groupRemoved.items} 条` : ''}${removed.deletedLegacy ? '，旧摘要已删除' : ''}）。`
      : '已清除长期记忆与全部对话上下文。'
  }

  /** `/memory`：查看状态或 off/on 暂停/恢复；只展示条目计数与类型分布，不展示 key/value。 */
  private executeMemoryCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): string {
    const sub = args.trim().toLowerCase()
    if (sub === 'off' || sub === 'on') {
      const enabled = sub === 'on'
      this.memory.setMemoryEnabled(bot.id, result.userId, enabled)
      if (!enabled) this.cancelUserMemory(bot.id, result.userId)
      this.deps.audit('bot.memory.toggle', bot.id, {
        bot: bot.id,
        user: result.userId.slice(0, 64),
        enabled,
      })
      return enabled
        ? '已开启长期记忆：之后的对话会重新抽取记忆。'
        : '已关闭长期记忆：不再抽取与注入，已取消待处理的记忆批次。'
    }
    return this.memoryStatusText(bot.id, result.userId)
  }

  /** /memory 状态文本：总条数、各类型计数、启用状态与最近更新时间（不含 key/value）。 */
  private memoryStatusText(botId: string, userId: string): string {
    const state = this.memory.getState(botId, userId)
    // 通过 MemoryStore 元数据 API 聚合：总数取 total，各类型分页累计，避免读取条目正文。
    const kinds = new Map<BotMemoryKind, number>()
    let updatedAt: string | null = null
    const first = this.memory.listItems(botId, userId, 200, 0)
    let page = first
    let offset = 0
    while (true) {
      for (const item of page.items) {
        kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
        if (!updatedAt || item.updatedAt > updatedAt) updatedAt = item.updatedAt
      }
      offset += page.items.length
      if (page.items.length === 0 || offset >= page.total) break
      page = this.memory.listItems(botId, userId, 200, offset)
    }
    const kindText = [...kinds.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${MEMORY_KIND_LABEL[kind] ?? kind} ${count}`)
      .join('、')
    const legacy = state.legacyMigratedAt ? null : this.memory.legacySummary(botId, userId)
    return [
      '【长期记忆】',
      `状态：${state.memoryEnabled ? '已开启' : '已暂停'}`,
      `条目：${first.total} 条${legacy ? '（含待迁移旧摘要）' : ''}`,
      `类型：${kindText || '（暂无）'}`,
      `最近更新：${updatedAt ?? '暂无'}`,
      '说明：/memory off 暂停记忆（不再抽取与注入）；/memory on 恢复；/forget confirm 清除全部记忆。',
    ].join('\n')
  }

  private async executeRoleCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): Promise<string> {
    // Webhook 已在群聊/频道拦截命令；这里保留防御，避免未来路由变化导致群内写角色卡。
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
      return roleShowText(card)
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

  /** 删除当前 Bot×目标×用户的会话映射，并尽力删除对应远端会话（保留远端历史以外的副本）。 */
  private resetChatSession(botId: string, targetExternalId: string, userId: string): void {
    this.deleteRemoteSessions(botId, { targetExternalId, userId })
    this.db
      .prepare('DELETE FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ? AND user_id = ?')
      .run(botId, targetExternalId, userId)
  }

  /**
   * 尽力删除本地映射对应的远端 OpenCode 会话（含旧摘要会话）。
   * 远端删除异步执行并纳入 pending；失败只记日志，不阻塞命令响应。
   */
  private deleteRemoteSessions(
    botId: string,
    filter: { targetExternalId?: string; userId?: string },
  ): void {
    if (!this.deps.ai?.deleteSession) return
    const clauses = ['bot_id = ?']
    const params: string[] = [botId]
    if (filter.targetExternalId) {
      clauses.push('target_external_id = ?')
      params.push(filter.targetExternalId)
    }
    if (filter.userId) {
      clauses.push('user_id = ?')
      params.push(filter.userId)
    }
    const rows = this.db
      .prepare(`SELECT session_id FROM bot_ai_sessions WHERE ${clauses.join(' AND ')}`)
      .all(...params) as unknown as { session_id: string }[]
    const summaryClauses = ['bot_id = ?', 'summary_session_id IS NOT NULL']
    const summaryParams: string[] = [botId]
    if (filter.userId) {
      summaryClauses.push('user_id = ?')
      summaryParams.push(filter.userId)
    }
    const memories = this.db
      .prepare(`SELECT summary_session_id FROM bot_ai_memories WHERE ${summaryClauses.join(' AND ')}`)
      .all(...summaryParams) as unknown as { summary_session_id: string }[]
    const ids = new Set<string>()
    for (const row of rows) if (row.session_id) ids.add(row.session_id)
    for (const row of memories) if (row.summary_session_id) ids.add(row.summary_session_id)
    for (const sessionId of ids) {
      const task = this.deps.ai.deleteSession(sessionId).catch(() => undefined)
      this.pending.add(task)
      void task.finally(() => this.pending.delete(task))
    }
  }

  /** 开启一轮消息发送工具上下文；工具未启用/无 Bot 密钥时返回 null。 */
  private memoryKey(botId: string, userId: string): string {
    return `${botId}:${userId}`
  }

  /**
   * 取消某用户待处理的记忆批次并递增 generation：
   * 已入队的在途抽取会在写回前发现版本变化而放弃，避免 `/memory off` 或 `/forget` 后被旧数据回写。
   */
  private cancelUserMemory(botId: string, userId: string): void {
    const key = this.memoryKey(botId, userId)
    this.memoryGenerations.set(key, (this.memoryGenerations.get(key) ?? 0) + 1)
    const timer = this.memoryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.memoryTimers.delete(key)
    }
    this.memoryPending.delete(key)
  }

  /**
   * 取消某群 scope 下所有成员的在途/待处理记忆抽取（管理端清空群记忆用，BOT-06）。
   * 群聊队列 key 形如 `${bot}:${scope}:${userId}`，gen 与队列必须同源，否则清空后会被在途批次写回。
   */
  private cancelGroupMemoryScope(botId: string, scope: string): void {
    const prefix = `${botId}:${scope}:`
    for (const [key, timer] of [...this.memoryTimers]) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(timer)
      this.memoryTimers.delete(key)
    }
    for (const key of [...this.memoryPending.keys()]) {
      if (key.startsWith(prefix)) this.memoryPending.delete(key)
    }
    // 在途队列里的 key 不一定已写进 memoryGenerations（首次批次 generation 缺省为 0），
    // 这里对队列/已记录的所有 key 统一 +1，确保 updateMemory 写回前能发现版本变化。
    for (const key of [...this.memoryQueues.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.memoryGenerations.set(key, (this.memoryGenerations.get(key) ?? 0) + 1)
    }
    for (const key of [...this.memoryGenerations.keys()]) {
      if (key.startsWith(prefix)) this.memoryGenerations.set(key, (this.memoryGenerations.get(key) ?? 0) + 1)
    }
  }

  /** 取消某成员在各群 scope 下的在途/待处理记忆抽取（`/forget confirm` 用，D-13）。 */
  private cancelMemberGroupMemory(botId: string, memberUserId: string): void {
    const groups = this.db
      .prepare("SELECT external_id FROM bot_targets WHERE bot_id = ? AND kind = 'group'")
      .all(botId) as unknown as { external_id: string }[]
    for (const group of groups) {
      const key = `${botId}:${groupMemoryScope(group.external_id)}:${memberUserId}`
      this.memoryGenerations.set(key, (this.memoryGenerations.get(key) ?? 0) + 1)
      const timer = this.memoryTimers.get(key)
      if (timer) {
        clearTimeout(timer)
        this.memoryTimers.delete(key)
      }
      this.memoryPending.delete(key)
    }
  }

  /**
   * 回复已发送后再更新长期记忆：按 Bot×用户合并待抽取对话，
   * 达到条数阈值或用户空闲后触发一次结构化抽取，减少高频 Chat 的额外模型调用。
   */
  private scheduleMemoryUpdate(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    userText: string,
    assistantText: string,
    options: { memoryScope?: string; groupUserName?: string } = {},
  ): void {
    if (!this.deps.ai?.extractMemories) return
    const memoryScope = options.memoryScope ?? userId
    const groupUserName = options.groupUserName
    // 记忆已关闭的 scope 不进入批处理；开启后下一条 Chat 重新开始累计。
    if (!this.memory.getState(bot.id, memoryScope).memoryEnabled) return
    const key = this.memoryQueueKey(bot.id, userId, memoryScope, Boolean(groupUserName))
    const entry = this.memoryPending.get(key) ?? {
      bot,
      userId,
      targetExternalId,
      memoryScope,
      ...(groupUserName ? { groupUserName } : {}),
      rounds: [],
    }
    entry.bot = bot
    entry.targetExternalId = targetExternalId
    entry.memoryScope = memoryScope
    if (groupUserName) entry.groupUserName = groupUserName
    entry.rounds.push({ userText, assistantText })
    this.memoryPending.set(key, entry)
    const existing = this.memoryTimers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.memoryTimers.delete(key)
    }
    if (entry.rounds.length >= Math.max(1, this.config.botAiMemoryBatchMessages)) {
      this.flushMemory(key)
      return
    }
    const idleSeconds = this.config.botAiMemoryIdleFlushSeconds
    if (idleSeconds > 0) {
      const timer = setTimeout(() => {
        this.memoryTimers.delete(key)
        this.flushMemory(key)
      }, idleSeconds * 1000)
      timer.unref()
      this.memoryTimers.set(key, timer)
    }
  }

  /** 私聊按 Bot×用户、群聊按 Bot×群 scope×发言用户隔离待抽取批次。 */
  private memoryQueueKey(botId: string, userId: string, memoryScope: string, group: boolean): string {
    return group ? `${botId}:${memoryScope}:${userId}` : this.memoryKey(botId, userId)
  }

  /**
   * 群聊共享记忆操作（D-13）：key 前缀使用稳定 member_openid，显示名只写入 value（“用户名：记忆”）。
   * 模型可能按旧提示词输出 `<显示名>:` 前缀，服务端统一剥掉后改写，保证同名/改名成员不会互相覆盖或删除。
   * 已登记用户/其他成员的用户级记忆不会进入这里。
   */
  private groupMemoryOperations(
    memberUserId: string,
    memberName: string,
    ops: readonly BotMemoryOperation[],
  ): BotMemoryOperation[] {
    const name = cleanText(memberName, 20) || '群成员'
    const idPrefix = `${memberUserId}:`
    return ops.map((op) => {
      let rawKey = String(op.key ?? '').trim()
      if (rawKey.startsWith(`${name}:`)) rawKey = rawKey.slice(name.length + 1)
      else if (rawKey.startsWith(`${name}：`)) rawKey = rawKey.slice(name.length + 1)
      const key = `${idPrefix}${rawKey}`
      if (op.op === 'delete') return { ...op, key }
      let value = String(op.value ?? '').trim()
      if (value.startsWith(`${name}：`)) value = value.slice(name.length + 1)
      else if (value.startsWith(`${name}:`)) value = value.slice(name.length + 1).trimStart()
      return { ...op, key, value: `${name}：${value}` }
    })
  }

  /** 把某用户待抽取批次送入串行队列；同用户抽取严格顺序执行，避免并发覆盖。 */
  private flushMemory(key: string): void {
    const timer = this.memoryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.memoryTimers.delete(key)
    }
    const entry = this.memoryPending.get(key)
    if (!entry) return
    this.memoryPending.delete(key)
    const rounds = entry.rounds.length
    const userText = entry.rounds.map((round) => round.userText).join('\n---\n')
    const assistantText = entry.rounds.map((round) => round.assistantText).join('\n---\n')
    // 入队时记录 generation：排队期间被 /memory off、/forget 或管理端删除取消的批次不再执行。
    const generation = this.memoryGenerations.get(key) ?? 0
    const previous = this.memoryQueues.get(key) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() =>
        this.updateMemory(
          entry.bot,
          entry.userId,
          entry.targetExternalId,
          userText,
          assistantText,
          rounds,
          generation,
          entry.memoryScope,
          entry.groupUserName,
        ),
      )
    this.memoryQueues.set(key, task)
    this.pending.add(task)
    void task.finally(() => {
      this.pending.delete(task)
      if (this.memoryQueues.get(key) === task) this.memoryQueues.delete(key)
    })
  }

  /** 进程停止前把待抽取批次全部入队；不阻塞关闭流程。 */
  private flushPendingMemory(): void {
    for (const key of [...this.memoryPending.keys()]) this.flushMemory(key)
    for (const timer of this.memoryTimers.values()) clearTimeout(timer)
    this.memoryTimers.clear()
  }

  /**
   * 结构化记忆抽取：读取现有条目与未迁移旧摘要 → 模型输出操作 → MemoryStore 校验合并。
   * 产出可迁移条目时迁移旧摘要标记（ops=0 保留 fallback）；失败保留旧数据（fallback 继续生效）并在下一批重试。
   * generation 变化（/memory off、/forget、管理端删除）时放弃写回。
   */
  private async updateMemory(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    userText: string,
    assistantText: string,
    rounds: number,
    generation: number,
    memoryScope: string,
    groupUserName?: string,
  ): Promise<void> {
    const key = this.memoryQueueKey(bot.id, userId, memoryScope, Boolean(groupUserName))
    // 排队期间被取消（/memory off、/forget、管理端删除）：不再读取/写入任何记忆数据。
    if ((this.memoryGenerations.get(key) ?? 0) !== generation) return
    try {
      const state = this.memory.getState(bot.id, memoryScope)
      if (!state.memoryEnabled) return
      const existing = this.memory.itemsForExtraction(bot.id, memoryScope)
      // 群聊共享记忆没有 legacy 摘要；只有私聊用户才迁移旧摘要。
      const legacy = !groupUserName && !state.legacyMigratedAt ? this.memory.legacySummary(bot.id, memoryScope) : null
      const legacySummary = legacy?.summary ?? ''
      let ops: BotMemoryOperation[]
      try {
        ops = await this.deps.ai!.extractMemories!({
          botId: bot.id,
          userId: groupUserName ? memoryScope : userId,
          sessionTitle: `${this.targetNameForSession(bot.id, targetExternalId, userId)} Memory`,
          existing,
          legacySummary,
          userText,
          assistantText,
          ...(groupUserName ? { groupUserName } : {}),
          maxOps: MEMORY_MAX_OPS,
        })
      } finally {
        this.observeAiToolIsolation(bot.id)
      }
      // 抽取期间记忆被关闭/清除：丢弃本次结果，避免旧数据回写。
      if ((this.memoryGenerations.get(key) ?? 0) !== generation) return
      const current = this.memory.getState(bot.id, memoryScope)
      if (!current.memoryEnabled) return
      const finalOps = groupUserName ? this.groupMemoryOperations(userId, groupUserName, ops) : ops
      const result = this.memory.applyOperations(bot.id, memoryScope, finalOps, 'chat')
      // 只有本次确实产出可迁移条目时才把旧摘要标记为已迁移；ops=0（模型未转换出条目）
      // 必须保留 fallback 注入并继续作为后续批次的迁移输入，避免旧记忆被"静默丢弃"。
      let migrated = false
      if (legacySummary && !current.legacyMigratedAt && result.upserts > 0) {
        this.memory.markLegacyMigrated(bot.id, memoryScope)
        migrated = true
      }
      this.deps.audit('bot.memory.extract', `${bot.platform}:${targetExternalId}`, {
        bot: bot.id,
        user: (groupUserName ? `${groupUserName.slice(0, 20)}:${userId}` : userId).slice(0, 64),
        ...(groupUserName ? { group: true } : {}),
        rounds,
        ops: ops.length,
        upserts: result.upserts,
        deletes: result.deletes,
        skipped: result.skipped,
        pruned: result.pruned,
        migrated: migrated ? 1 : 0,
      })
    } catch (error) {
      // 失败不落任何部分数据；旧摘要 fallback 继续生效，下一批重试。
      this.deps.log('warn', 'Bot 记忆抽取失败', {
        bot: bot.id,
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - this.config.botEventRetentionDays * 86400_000).toISOString()
    try {
      this.db.prepare('DELETE FROM bot_events WHERE received_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM bot_inbound_targets WHERE last_seen_at < ?').run(cutoff)
      this.memory.cleanup()
      this.queue.cleanupExpired()
      this.deps.ai?.cleanup?.()
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
  /**
   * 新会话标题使用目标名称 + Chat/Memory，便于在 OpenCode 会话列表中管理。
   * 未登记 C2C 用户优先使用入站用户名；都没有时使用短 ID 兜底。
   */
  private inboundDisplayName(result: { userId: string; userName: string | null }): string {
    const name = cleanText(result.userName ?? '', 40)
    if (name) return name
    const short = result.userId.slice(-6)
    return short ? `用户${short}` : '用户'
  }

  private targetNameForSession(
    botId: string,
    targetExternalId: string,
    userId: string,
    userName?: string | null,
  ): string {
    const target = this.db
      .prepare('SELECT label FROM bot_targets WHERE bot_id = ? AND external_id = ?')
      .get(botId, targetExternalId) as { label: string } | undefined
    const label = cleanText(target?.label, 60)
    if (label) return label
    const inbound = this.db
      .prepare('SELECT user_name FROM bot_inbound_targets WHERE bot_id = ? AND target_external_id = ? AND user_id = ?')
      .get(botId, targetExternalId, userId) as { user_name: string | null } | undefined
    const name = cleanText(userName ?? inbound?.user_name ?? '', 60)
    if (name) return name
    const short = (targetExternalId || userId).slice(-6)
    return short ? `目标${short}` : 'Bot'
  }

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
      lastError: this.latestBotError(row.id, row.last_error),
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

/** 目标显示名称用于管理识别；不改 openid、权限或投递目标。 */
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
    groupReplyMode: row.chat_trigger === 'all' ? 'all' : 'mention',
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
