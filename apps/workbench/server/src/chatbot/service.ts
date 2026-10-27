/**
 * Chatbot 平台服务（QQ 官方 Chatbot 单平台）：配置 CRUD、Webhook 验签/命令分发、通知/发布队列、投递重试与结构化长期记忆。
 * 安全边界：AppSecret 只以 AES-256-GCM 密文落库；Webhook 无 session/CSRF，Ed25519 签名是唯一鉴权；
 * 自助命令（/help、/role 私聊、/reset、/forget、/memory）对所有用户开放；其余命令必须命中 chatbot_targets.allow_commands + 显式 user 白名单；
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
  ChatbotInboundHandler,
  cleanText,
  errorShortCode,
  sanitizeExternalText,
  sentExternalIdsOf,
  type BurstTimingLike,
  type ParsedCommand,
} from './inbound.ts'
import { ChatbotDiagnostics } from './diagnostics.ts'
import { ChatbotQueue } from './queue.ts'
import { ChatbotChatPipeline } from './chat.ts'
import {
  CHATBOT_COMMANDS,
  isBotPlatform,
  type ChatbotAdapter,
  type ChatbotDelivery,
  type ChatbotDeliveryRow,
  type ChatbotEventItem,
  type ChatbotEventOutcome,
  type ChatbotGroupRoleDetail,
  type ChatbotGroupRoleSummary,
  type ChatbotHealthCheck,
  type ChatbotInboundTarget,
  type ChatbotMemoryItemSummary,
  type ChatbotMemoryGroupSummary,
  type ChatbotMemoryKind,
  type ChatbotMemoryOperation,
  type ChatbotMemoryUserSummary,
  type ChatbotMetrics,
  type ChatbotPlatform,
  type ChatbotPublishJob,
  type ChatbotPublishRow,
  type ChatbotRoleSummary,
  type ChatbotRow,
  type ChatbotSecret,
  type ChatbotServiceDeps,
  type ChatbotStatus,
  type ChatbotSummary,
  type ChatbotTarget,
  type ChatbotTargetRow,
  type ChatbotToolIsolationStatus,
  type InboundVerification,
} from './types.ts'
import { decodeBotKey, decryptBotSecret, encryptBotSecret } from './crypto.ts'
import { describeBotError } from './errors.ts'
import { ChatbotMemoryStore, groupMemoryScope } from './memory.ts'
import {
  ChatbotChatRoleStore,
  normalizeRolePrompt,
  roleValidationMessage,
  validateRole,
} from './roles.ts'
import { ChatbotGroupRoleStore } from './group-roles.ts'
import { ChatbotTargetAdmin, type CreateTargetInput, type UpdateTargetInput } from './targets.ts'
import { ChatbotMemoryAdmin } from './memory-admin.ts'
import { ChatbotRoleAdmin } from './roles-admin.ts'
import { GROUP_CHAT_SESSION_USER_ID } from './session.ts'
import { ChatbotContextStore, contextModeTag, contextScopeKey } from './context.ts'
import { ChatbotConnectivityMonitor, type ConnectivitySnapshot } from './connectivity.ts'
import { QqAdapter, DEFAULT_SEND_INTERVAL_MS } from './adapters/qq.ts'
import { CHATBOT_TEXT_LIMITS } from './text.ts'
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
/** QQ 单条文本上限；发布内容在入队前先校验。 */
const PUBLISH_TEXT_MAX = CHATBOT_TEXT_LIMITS.qq
/** 结构化记忆类型的中文标签；仅用于 /memory 状态展示（不展示 key/value）。 */
const MEMORY_KIND_LABEL: Record<ChatbotMemoryKind, string> = {
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
const GROUP_MEMORY_OWNER_MIGRATION_KEY = 'chatbot_group_memory_owner_migrated_v1'
/** Webhook 验签失败/未认证请求的每 Chatbot 分钟桶上限（只限制无效流量，不影响已验签事件）。 */
const WEBHOOK_UNAUTHENTICATED_PER_MINUTE = 120
/** Webhook 已验签事件每 Chatbot 分钟桶上限（业务限流，验签通过后才扣减）。 */
const WEBHOOK_AUTHENTICATED_PER_MINUTE = 300

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
  platform: ChatbotPlatform
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

export interface CreatePublishInput {
  targetId: string
  text: string
  scheduledAt?: string | null
  /** 二次确认文本，必须为 PUBLISH（服务端校验）。 */
  confirmText?: string
}

export interface ChatbotAlertEvent {
  id: number | string
  event: string
  severity: string
  status: string
  title: string
  message: string
  createdAt: string
}

export class ChatbotService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly deps: ChatbotServiceDeps
  /** 诊断事件/指标存储（只做 DB 读写；权限开关由本类校验）。 */
  private readonly diagnostics: ChatbotDiagnostics
  /** 出站投递/发布队列（入队、claim、退避、死信、TTL）。 */
  private readonly queue: ChatbotQueue
  /** Chat 管线（连续消息合并/串行/AI/搜索/发送工具）。 */
  private readonly chat: ChatbotChatPipeline
  private readonly key: Buffer | null
  private readonly limiter: SlidingWindowLimiter
  /** 未通过验签的 Webhook 请求（每 Chatbot 分钟桶）；与已验签业务桶分离，无效流量无法饿死合法事件。 */
  private readonly webhookUnauthenticatedLimiter: SlidingWindowLimiter
  /** 已验签 Webhook 事件（每 Chatbot 分钟桶，验签通过后才扣减）。 */
  private readonly webhookAuthenticatedLimiter: SlidingWindowLimiter

  /** Webhook 拒绝/限流审计的窗口聚合计数（避免每次 401/429 各写一条审计）。 */
  private readonly webhookAuditWindows = new Map<string, { minute: number; count: number }>()
  private readonly memory: ChatbotMemoryStore
  /** v0.7.3：角色卡/记忆文档存储（read 工具按需读取；默认关闭）。 */
  private readonly context: ChatbotContextStore
  private readonly memoryAdmin: ChatbotMemoryAdmin
  private readonly roles: ChatbotChatRoleStore
  private readonly groupRoles: ChatbotGroupRoleStore
  private readonly roleAdmin: ChatbotRoleAdmin
  private readonly targetsAdmin: ChatbotTargetAdmin
  private readonly connectivity: ChatbotConnectivityMonitor
  /** 入站 Webhook 处理（验签/限流/去重/命令与 Chat 路由）；行为与重构前一致。 */
  private readonly inbound: ChatbotInboundHandler
  /** 活跃的 AI 消息发送回合（只存内存；回合结束即清理）。 */
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private ticking = false
  private readonly pending = new Set<Promise<void>>()
  /** 待抽取的对话批次：按 Chatbot×用户去重，减少高频 Chat 的额外模型调用。 */
  private readonly memoryPending = new Map<
    string,
    {
      chatbot: ChatbotRow
      userId: string
      targetExternalId: string
      memoryScope: string
      groupUserName?: string
      rounds: { userText: string; assistantText: string }[]
    }
  >()
  private readonly memoryTimers = new Map<string, NodeJS.Timeout>()
  /** 同一 Chatbot×用户的记忆抽取串行执行，避免并发读到旧条目后互相覆盖。 */
  private readonly memoryQueues = new Map<string, Promise<void>>()
  /**
   * 每用户记忆 generation：/memory off、/forget、管理端删除会递增，
   * 在途抽取写回前校验版本，避免被取消的批次把旧数据写回。
   */
  private readonly memoryGenerations = new Map<string, number>()
  /** 上次观察到的 AI 工具隔离降级次数：用于把降级写成一次性审计而不是只留日志。 */
  private lastAiFallbackCount = 0

  constructor(deps: ChatbotServiceDeps) {
    this.db = deps.db
    this.config = deps.config
    this.deps = deps
    this.diagnostics = new ChatbotDiagnostics({ db: deps.db })
    this.queue = new ChatbotQueue({
      db: deps.db,
      config: deps.config,
      log: deps.log,
      audit: deps.audit,
      chatbotRow: (id) => this.chatbotRow(id),
      targetRow: (id) => this.targetRow(id),
      publishRow: (id) => this.publishRow(id),
      adapterFor: (chatbot) => this.adapterFor(chatbot),
      now: deps.now,
    })
    this.limiter = new SlidingWindowLimiter(60_000, Math.max(1, deps.config.chatbotCommandRatePerMinute))
    this.webhookUnauthenticatedLimiter = new SlidingWindowLimiter(60_000, WEBHOOK_UNAUTHENTICATED_PER_MINUTE)
    this.webhookAuthenticatedLimiter = new SlidingWindowLimiter(60_000, WEBHOOK_AUTHENTICATED_PER_MINUTE)
    this.memory = new ChatbotMemoryStore(deps.db, deps.config.dataDir, {
      maxItems: deps.config.chatbotMemoryMaxItems,
      promptMaxChars: deps.config.chatbotMemoryPromptMaxChars,
      promptMaxItems: deps.config.chatbotMemoryPromptMaxItems,
      // fact/project 复用旧记忆保留期；episode/task 使用独立 TTL。
      factProjectTtlDays: deps.config.chatbotAiMemoryRetentionDays,
      episodeTtlDays: deps.config.chatbotMemoryTtlEpisodeDays,
      taskTtlDays: deps.config.chatbotMemoryTtlTaskDays,
      legacyMaxChars: deps.config.chatbotAiMemoryMaxChars,
    })
    this.roles = new ChatbotChatRoleStore(deps.db)
    this.groupRoles = new ChatbotGroupRoleStore(deps.db)
    this.context = new ChatbotContextStore({ dir: deps.config.chatbotContextDir, log: deps.log })
    this.roleAdmin = new ChatbotRoleAdmin({
      db: this.db,
      requireEnabled: () => this.requireEnabled(),
      chatbotRow: (id) => this.chatbotRow(id),
      targetRowForBot: (chatbotId, targetId) => this.targetRowForBot(chatbotId, targetId),
      roles: this.roles,
      groupRoles: this.groupRoles,
      inboundUserNames: (chatbotId) => this.inboundUserNames(chatbotId),
      resetUserSessions: (chatbotId, userId) => this.resetUserSessions(chatbotId, userId),
      resetGroupSessions: (chatbotId, targetExternalId) => this.resetGroupSessions(chatbotId, targetExternalId),
      audit: this.deps.audit,
    })
    this.memoryAdmin = new ChatbotMemoryAdmin({
      requireEnabled: () => this.requireEnabled(),
      chatbotRow: (id) => this.chatbotRow(id),
      memory: this.memory,
      audit: this.deps.audit,
      cancelUserMemory: (chatbotId, userId) => this.cancelUserMemory(chatbotId, userId),
      cancelGroupMemoryScope: (chatbotId, scope) => this.cancelGroupMemoryScope(chatbotId, scope),
    })
    this.targetsAdmin = new ChatbotTargetAdmin({
      db: this.db,
      requireEnabled: () => this.requireEnabled(),
      chatbotRow: (id) => this.chatbotRow(id),
      targetRow: (id) => this.targetRow(id),
      targetRowForBot: (chatbotId, targetId) => this.targetRowForBot(chatbotId, targetId),
      audit: this.deps.audit,
      groupRoles: this.groupRoles,
      dropGroupTargetMemory: (chatbotId, externalId) => this.dropGroupTargetMemory(chatbotId, externalId),
      resetTargetSessions: (chatbotId, externalId) => this.resetTargetSessions(chatbotId, externalId),
    })
    this.resetSessionsForToolMode()
    this.connectivity = new ChatbotConnectivityMonitor({
      enabled: deps.config.chatbotEnabled && deps.config.chatbotConnectivityEnabled,
      intervalSeconds: deps.config.chatbotConnectivityIntervalSeconds,
      timeoutSeconds: deps.config.chatbotConnectivityTimeoutSeconds,
      getPlatforms: () => this.enabledPlatforms(),
      log: deps.log,
      onRecover: () => {
        this.scheduleTick()
      },
    })
    try {
      this.key = decodeBotKey(deps.config.chatbotSecretKey)
    } catch {
      throw new AppError(500, 'chatbot_key_invalid', 'CHATBOT_SECRET_KEY 配置无效')
    }
    this.inbound = new ChatbotInboundHandler({
      db: this.db,
      config: this.config,
      log: this.deps.log,
      audit: this.deps.audit,
      chatbotRow: (id) => this.chatbotRow(id),
      adapterFor: (chatbot) => this.adapterFor(chatbot),
      inboundTarget: (chatbotId, result) => this.inboundTarget(chatbotId, result),
      isCommandUserAllowed: (chatbotId, userId) => this.isCommandUserAllowed(chatbotId, userId),
      commandLimiter: this.limiter,
      webhookUnauthenticatedLimiter: this.webhookUnauthenticatedLimiter,
      webhookAuthenticatedLimiter: this.webhookAuthenticatedLimiter,
      auditWebhookThrottled: (action, chatbotId, detail) => this.auditWebhookThrottled(action, chatbotId, detail),
      insertEvent: (chatbotId, eventId, kind, outcome, detail, targetExternalId, userId) =>
        this.insertEvent(chatbotId, eventId, kind, outcome, detail, targetExternalId, userId),
      markEvent: (chatbotId, eventId, update) => this.markEvent(chatbotId, eventId, update),
      recordInbound: (chatbot, result) => this.recordInbound(chatbot, result),
      executeCommand: (chatbot, result, parsed, adminAllowed) => this.executeCommand(chatbot, result, parsed, adminAllowed),
      enqueueChat: (chatbot, result, text, timing) => this.enqueueChatMessage(chatbot, result, text, timing),
      track: (task) => {
        this.pending.add(task)
        void task.finally(() => this.pending.delete(task))
      },
      aiIsolationBlocked: () => this.aiIsolationBlocked(),
    })
    this.chat = new ChatbotChatPipeline({
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
        context: this.context,
      },
      roles: this.roles,
      groupRoles: this.groupRoles,
      host: {
        markEvent: (chatbotId, eventId, update) => this.markEvent(chatbotId, eventId, update),
        inboundTarget: (chatbotId, result) => this.inboundTarget(chatbotId, result),
        inboundDisplayName: (result) => this.inboundDisplayName(result),
        targetNameForSession: (chatbotId, targetExternalId, userId, userName) =>
          this.targetNameForSession(chatbotId, targetExternalId, userId, userName),
        scheduleMemoryUpdate: (chatbot, userId, targetExternalId, userText, assistantText, options) =>
          this.scheduleMemoryUpdate(chatbot, userId, targetExternalId, userText, assistantText, options),
        observeAiToolIsolation: (chatbotId) => this.observeAiToolIsolation(chatbotId),
        aiIsolationBlocked: () => this.aiIsolationBlocked(),
        adapterFor: (chatbot) => this.adapterFor(chatbot),
        trackTask: (task) => {
          this.pending.add(task)
          void task.finally(() => this.pending.delete(task))
        },
      },
    })
  }

  get enabled(): boolean {
    return this.config.chatbotEnabled && this.key !== null
  }

  private requireEnabled(): void {
    if (!this.config.chatbotEnabled) throw new AppError(503, 'chatbot_disabled', 'Chatbot 功能未启用')
    if (!this.key) throw new AppError(503, 'chatbot_key_missing', '未配置 CHATBOT_SECRET_KEY')
  }

  status(): ChatbotStatus {
    const chatbots = this.db.prepare('SELECT COUNT(*) AS c FROM chatbots').get() as { c: number }
    const enabledBots = this.db.prepare('SELECT COUNT(*) AS c FROM chatbots WHERE enabled = 1').get() as { c: number }
    const targets = this.db.prepare('SELECT COUNT(*) AS c FROM chatbot_targets').get() as { c: number }
    const deliveries = this.db
      .prepare("SELECT COUNT(*) AS c FROM chatbot_deliveries WHERE status IN ('queued','sending','failed')")
      .get() as { c: number }
    const publishes = this.db
      .prepare("SELECT COUNT(*) AS c FROM chatbot_publish_jobs WHERE status IN ('queued','sending')")
      .get() as { c: number }
    return {
      enabled: this.enabled,
      keyConfigured: this.key !== null,
      chatbots: chatbots.c,
      enabledBots: enabledBots.c,
      targets: targets.c,
      queuedDeliveries: deliveries.c,
      queuedPublishes: publishes.c,
      lastError: this.latestBotError(null),
      aiToolIsolation: this.aiToolIsolationStatus(),
    }
  }

  /** AI 工具隔离状态：未配置 AI 时返回 null；用于 /api/chatbots/status 与降级审计。 */
  private aiToolIsolationStatus(): ChatbotToolIsolationStatus | null {
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
    if (!this.config.chatbotAiSendToolEnabled && !this.config.chatbotAiContextReadEnabled) return false
    const status = this.aiToolIsolationStatus()
    if (!status || status.supported !== false) return false
    if (!status.retryAt) return false
    const retryAt = Date.parse(status.retryAt)
    return Number.isFinite(retryAt) && Date.now() < retryAt
  }

  /**
   * Webhook 拒绝/限流审计按「每 Chatbot×动作×分钟」聚合：第 1 次与每满 50 次写一条，
   * 避免未认证请求刷 401/429 时把 audit_log 写满（A5-CHATBOT-16 遗留的写放大问题）。
   */
  private auditWebhookThrottled(action: string, chatbotId: string, detail?: Record<string, unknown>): void {
    const minute = Math.floor(Date.now() / 60_000)
    const key = `${action}\u0000${chatbotId}`
    const entry = this.webhookAuditWindows.get(key)
    const count = entry && entry.minute === minute ? entry.count + 1 : 1
    this.webhookAuditWindows.set(key, { minute, count })
    if (count === 1 || count % 50 === 0) {
      this.deps.audit(action, chatbotId, detail ? { ...detail, count } : { count })
    }
    // 窗口滚动时清理其它过期键，避免 Map 随 chatbot/动作增长（Chatbot 数量有限，但仍显式收敛）。
    if (this.webhookAuditWindows.size > 200) {
      for (const [windowKey, window] of this.webhookAuditWindows) {
        if (window.minute < minute) this.webhookAuditWindows.delete(windowKey)
      }
    }
  }

  /** 最近一次投递/发布失败（CHATBOT-07）：派生自队列，避免 chatbots.last_error 死字段。 */
  private latestBotError(chatbotId: string | null, fallback: string | null = null): string | null {
    return this.diagnostics.findLatestError(chatbotId, fallback)
  }

  /**
   * 观察 AI 工具隔离是否发生新的降级：OpenCode 拒绝 permissions 后仅日志不足以告警，
   * 这里在每次 AI 调用后比较累计次数，新增降级写审计 `chatbot.ai.permissions_fallback`（不含提示词）。
   */
  private observeAiToolIsolation(chatbotId: string): void {
    const status = this.aiToolIsolationStatus()
    if (!status || status.fallbackCount <= this.lastAiFallbackCount) return
    this.lastAiFallbackCount = status.fallbackCount
    this.deps.log('warn', 'AI 工具隔离降级：OpenCode 拒绝 permissions，会话以默认工具权限运行（未隔离）', {
      chatbot: chatbotId,
      fallbackCount: status.fallbackCount,
      supported: status.supported,
    })
    this.deps.audit('chatbot.ai.permissions_fallback', chatbotId, {
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

  private enabledPlatforms(): ChatbotPlatform[] {
    const rows = this.db
      .prepare('SELECT DISTINCT platform FROM chatbots WHERE enabled = 1')
      .all() as unknown as { platform: string }[]
    return rows.map((row) => row.platform).filter((platform): platform is ChatbotPlatform => isBotPlatform(platform))
  }

  metrics(chatbotId: string, hours = 24): ChatbotMetrics {
    this.requireEnabled()
    this.chatbotRow(chatbotId)
    return this.diagnostics.metrics(chatbotId, hours)
  }

  listBots(): ChatbotSummary[] {
    this.requireEnabled()
    const rows = this.db.prepare('SELECT * FROM chatbots ORDER BY created_at ASC').all() as unknown as ChatbotRow[]
    return rows.map((row) => this.toSummary(row))
  }

  getBot(id: string): ChatbotSummary {
    this.requireEnabled()
    return this.toSummary(this.chatbotRow(id))
  }

  createBot(input: CreateBotInput): ChatbotSummary {
    this.requireEnabled()
    if (!isBotPlatform(input.platform)) throw badRequest('不支持的平台')
    const name = cleanText(input.name, NAME_MAX)
    if (!name) throw badRequest('名称不能为空')
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM chatbots').get() as { c: number }
    if (count.c >= this.config.chatbotMaxBots) throw badRequest(`最多配置 ${this.config.chatbotMaxBots} 个 Chatbot`)
    const secret = this.normalizeSecret(input)
    const config = this.normalizeConfig(input.config)
    this.validateOrThrow(config, secret)
    const encrypted = encryptBotSecret(this.key!, secret)
    const id = newId()
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO chatbots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
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
    this.deps.audit('chatbot.create', id, { platform: input.platform, name })
    return this.getBot(id)
  }

  updateBot(id: string, input: UpdateBotInput): ChatbotSummary {
    this.requireEnabled()
    const row = this.chatbotRow(id)
    const secret: ChatbotSecret = { token: cleanText(input.token, 500) || this.secretOf(row).token }
    const nextConfig = input.config !== undefined ? this.normalizeConfig(input.config) : parseConfig(row.config_json)
    this.validateOrThrow(nextConfig, secret)
    const encrypted = encryptBotSecret(this.key!, secret)
    const name = input.name !== undefined ? cleanText(input.name, NAME_MAX) : row.name
    if (!name) throw badRequest('名称不能为空')
    this.db
      .prepare(
        `UPDATE chatbots SET name = ?, enabled = ?, config_json = ?, secret_ciphertext = ?, secret_iv = ?, secret_tag = ?,
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
    this.deps.audit('chatbot.update', id, { enabled: input.enabled, name })
    return this.getBot(id)
  }

  deleteBot(id: string): void {
    this.requireEnabled()
    this.chatbotRow(id)
    const mirrorIds = this.memory.listBotMemoryIds(id)
    this.db.prepare('DELETE FROM chatbots WHERE id = ?').run(id)
    // DB 行已删；镜像/上下文文档清理 best-effort，失败不改变删除结果。
    this.memory.removeMirrorFiles(mirrorIds)
    this.context.removeBot(id)
    this.deps.audit('chatbot.delete', id)
  }

  listTargets(chatbotId: string): ChatbotTarget[] {
    return this.targetsAdmin.listTargets(chatbotId)
  }

  /** 最近入站目标发现：只含平台 ID/类型/用户名/时间，不含消息正文。 */
  listInboundTargets(chatbotId: string, limit = 50): ChatbotInboundTarget[] {
    return this.targetsAdmin.listInboundTargets(chatbotId, limit)
  }

  createTarget(chatbotId: string, input: CreateTargetInput): ChatbotTarget {
    return this.targetsAdmin.createTarget(chatbotId, input)
  }

  updateTarget(chatbotId: string, targetId: string, input: UpdateTargetInput): ChatbotTarget {
    return this.targetsAdmin.updateTarget(chatbotId, targetId, input)
  }

  deleteTarget(chatbotId: string, targetId: string): void {
    this.targetsAdmin.deleteTarget(chatbotId, targetId)
  }

  /** 目标删除/改类型后清理其群共享记忆 scope（含状态/旧摘要），避免孤儿记忆无法再被管理。 */
  private dropGroupTargetMemory(chatbotId: string, targetExternalId: string): void {
    const scope = groupMemoryScope(targetExternalId)
    this.cancelGroupMemoryScope(chatbotId, scope)
    this.memory.deleteGroupScope(chatbotId, scope)
  }

  /**
   * 角色卡管理列表：只返回元数据（名字/长度/启停/时间），不返回角色设定正文。
   * userName 取自最近入站目标记录（没有则为 null）。
   */
  listRoles(chatbotId: string, options: { limit?: number; offset?: number } = {}): { items: ChatbotRoleSummary[]; total: number } {
    return this.roleAdmin.listRoles(chatbotId, options)
  }

  /** 启用/停用指定用户的角色卡；不存在时 404。 */
  setRoleEnabled(chatbotId: string, userId: string, enabled: boolean): void {
    this.roleAdmin.setRoleEnabled(chatbotId, userId, enabled)
  }

  /** 删除角色卡，并清理该 Chatbot×用户的全部会话映射与远端会话（下次 Chat 重新创建会话）。 */
  deleteRole(chatbotId: string, userId: string): void {
    this.roleAdmin.deleteRole(chatbotId, userId)
  }

  /** 群聊角色卡列表：始终列出群聊目标，未配置时 role 元数据为空。 */
  listGroupRoles(chatbotId: string): { items: ChatbotGroupRoleSummary[] } {
    return this.roleAdmin.listGroupRoles(chatbotId)
  }

  /** 群聊角色卡正文仅供管理员编辑；目标必须是群聊。 */
  getGroupRole(chatbotId: string, targetId: string): ChatbotGroupRoleDetail | null {
    return this.roleAdmin.getGroupRole(chatbotId, targetId)
  }

  /** 新建/覆盖群聊角色卡；正文只保存在 DB，不写入日志/审计。 */
  saveGroupRole(chatbotId: string, targetId: string, name: string, prompt: string): ChatbotGroupRoleDetail {
    return this.roleAdmin.saveGroupRole(chatbotId, targetId, name, prompt)
  }

  setGroupRoleEnabled(chatbotId: string, targetId: string, enabled: boolean): void {
    this.roleAdmin.setGroupRoleEnabled(chatbotId, targetId, enabled)
  }

  deleteGroupRole(chatbotId: string, targetId: string): void {
    this.roleAdmin.deleteGroupRole(chatbotId, targetId)
  }

  /**
   * 结构化记忆管理：用户级元数据分页（条目数/类型分布/启停/更新时间），不含 key/value。
   * userName 由 MemoryStore 结合最近入站目标补齐。
   */
  listMemories(
    chatbotId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: ChatbotMemoryUserSummary[]; total: number } {
    return this.memoryAdmin.listMemories(chatbotId, options)
  }

  /** 群聊共享记忆管理：按群目标聚合的元数据分页，不含 key/value。 */
  listGroupMemories(
    chatbotId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: ChatbotMemoryGroupSummary[]; total: number } {
    return this.memoryAdmin.listGroupMemories(chatbotId, options)
  }

  /** 清空某个群目标的共享记忆；scope 必须是内部群 scope，避免误删用户记忆。 */
  deleteGroupMemory(chatbotId: string, scope: string): void {
    this.memoryAdmin.deleteGroupMemory(chatbotId, scope)
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
    this.deps.audit('chatbot.memory.group_owner_migrate', 'chatbot', result)
    this.deps.log('info', '群聊共享记忆归属迁移完成', result)
    return { ...result, skipped: false }
  }

  /**
   * 一次性数据迁移：把群聊参与者的用户级记忆复制/迁移到群共享记忆。
   * 通过 meta 标记保证进程重启后不重复执行；失败时保留标记缺失，下次启动重试。
   */
  migrateGroupChatMemories(): { copied: number; moved: number; groups: number; skipped: boolean } {
    const key = 'chatbot_group_memory_migrated_v1'
    if (getMeta(this.db, key)) return { copied: 0, moved: 0, groups: 0, skipped: true }
    const result = this.memory.migrateGroupParticipantMemories()
    setMeta(this.db, key, nowIso())
    this.deps.audit('chatbot.memory.group_migrate', 'chatbot', {
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
    chatbotId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: ChatbotMemoryItemSummary[]; total: number } {
    return this.memoryAdmin.listMemoryItems(chatbotId, userId, options)
  }

  /** 删除单条结构化记忆（管理端）；不存在时 404。审计不含 key/value。 */
  deleteMemoryItem(chatbotId: string, userId: string, itemId: string): void {
    this.memoryAdmin.deleteMemoryItem(chatbotId, userId, itemId)
  }

  /** 整用户删除结构化记忆（条目+状态+旧摘要+镜像）；不存在时 404。审计不含正文。 */
  deleteMemory(chatbotId: string, userId: string): void {
    this.memoryAdmin.deleteMemory(chatbotId, userId)
  }

  /**
   * 平台连接自检：需要启用中的 Chatbot + 可解密凭据 + 适配器实现 check。
   * 无论成功失败都刷新 last_checked_at；不触碰 last_error（投递错误由队列负责）。
   */
  async checkBot(chatbotId: string): Promise<ChatbotHealthCheck> {
    this.requireEnabled()
    const chatbot = this.chatbotRow(chatbotId)
    let adapter: ChatbotAdapter
    try {
      adapter = this.adapterFor(chatbot)
    } catch (error) {
      this.deps.log('warn', 'Chatbot 自检无法构造适配器', { chatbot: chatbot.id, code: errorShortCode(error) })
      return this.finishCheck(chatbot, {
        ok: false,
        items: [{ name: '凭据', ok: false, detail: '凭据读取失败，请重新保存平台凭据' }],
      })
    }
    if (!adapter.check) throw new AppError(400, 'chatbot_health_unsupported', '该平台暂不支持连接自检')
    let health: ChatbotHealthCheck
    try {
      health = await adapter.check({ chatbotId: chatbot.id, appOrigin: this.config.appOrigin })
    } catch (error) {
      // 兜底结果只保留脱敏短描述，避免异常消息里的 URL/凭据进入 API。
      const detail = sanitizeExternalText(error instanceof Error ? error.message : '').slice(0, 120)
      health = {
        ok: false,
        items: [{ name: '连接自检', ok: false, detail: detail || '自检请求失败' }],
      }
    }
    return this.finishCheck(chatbot, health)
  }

  /** 自检收尾：刷新 last_checked_at 并审计（ok/detail 短码）。 */
  private finishCheck(chatbot: ChatbotRow, health: ChatbotHealthCheck): ChatbotHealthCheck {
    const checkedAt = nowIso()
    try {
      this.db.prepare('UPDATE chatbots SET last_checked_at = ? WHERE id = ?').run(checkedAt, chatbot.id)
    } catch {
      // 时间戳写入失败不影响自检结果返回。
    }
    const failed = health.items.filter((item) => !item.ok).map((item) => item.name).join(',')
    this.deps.audit('chatbot.check', chatbot.id, {
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
  private inboundUserNames(chatbotId: string): Map<string, string | null> {
    const rows = this.db
      .prepare('SELECT user_id, user_name FROM chatbot_inbound_targets WHERE chatbot_id = ? ORDER BY last_seen_at DESC')
      .all(chatbotId) as unknown as { user_id: string; user_name: string | null }[]
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
    chatbotId: string,
    options: { hours?: number; limit?: number; offset?: number; outcome?: string } = {},
  ): { items: ChatbotEventItem[]; total: number } {
    this.requireEnabled()
    this.chatbotRow(chatbotId)
    return this.diagnostics.listEvents(chatbotId, options)
  }

  listDeliveries(chatbotId: string, limit = 50): ChatbotDelivery[] {
    this.requireEnabled()
    this.chatbotRow(chatbotId)
    const rows = this.db
      .prepare('SELECT * FROM chatbot_deliveries WHERE chatbot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(chatbotId, Math.max(1, Math.min(200, limit))) as unknown as ChatbotDeliveryRow[]
    return rows.map(toDelivery)
  }

  retryDelivery(chatbotId: string, deliveryId: string): void {
    this.requireEnabled()
    this.chatbotRow(chatbotId)
    if (!this.queue.retryDelivery(chatbotId, deliveryId)) throw notFound('投递记录不存在或不可重试')
    this.deps.audit('chatbot.delivery.retry', `${chatbotId}:${deliveryId}`)
  }

  listPublishJobs(chatbotId: string, limit = 50): ChatbotPublishJob[] {
    this.requireEnabled()
    this.chatbotRow(chatbotId)
    const rows = this.db
      .prepare('SELECT * FROM chatbot_publish_jobs WHERE chatbot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(chatbotId, Math.max(1, Math.min(200, limit))) as unknown as ChatbotPublishRow[]
    return rows.map(toPublishJob)
  }

  createPublish(chatbotId: string, input: CreatePublishInput): ChatbotPublishJob {
    this.requireEnabled()
    if (input.confirmText !== 'PUBLISH') throw badRequest('发布需要输入 PUBLISH 二次确认', 'publish_confirm_required')
    this.chatbotRow(chatbotId)
    const target = this.targetRowForBot(chatbotId, input.targetId)
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
        `INSERT INTO chatbot_publish_jobs (id, chatbot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, '[]', ?, 'queued', 0, ?, ?)`,
      )
      .run(id, chatbotId, target.id, JSON.stringify({ text }), scheduledAt, now, now)
    this.deps.audit('chatbot.publish.create', `${chatbotId}:${id}`, { scheduled: Boolean(scheduledAt) })
    this.scheduleTick()
    return toPublishJob(this.publishRow(id))
  }

  cancelPublishJob(chatbotId: string, jobId: string): void {
    this.requireEnabled()
    this.chatbotRow(chatbotId)
    const result = this.db
      .prepare("UPDATE chatbot_publish_jobs SET status = 'canceled', updated_at = ? WHERE id = ? AND chatbot_id = ? AND status IN ('queued','draft')")
      .run(nowIso(), jobId, chatbotId)
    if (Number(result.changes) === 0) throw notFound('发布任务不存在或不可取消')
    this.deps.audit('chatbot.publish.cancel', `${chatbotId}:${jobId}`)
  }

  testBot(chatbotId: string, targetId?: string): Promise<void> {
    this.requireEnabled()
    const chatbot = this.chatbotRow(chatbotId)
    const target = targetId ? this.targetRowForBot(chatbotId, targetId) : this.firstTarget(chatbotId)
    if (!target) throw badRequest('请先配置目标')
    return this.queue.sendTest(chatbot, target)
  }

  /**
   * OpenCode 的工具权限在会话创建时固定；搜索模式或消息发送工具开关变化后，
   * 旧会话即使映射仍在也没有新工具（或可能沿用不再需要的权限）。
   * 用 meta 记录上次工具模式，模式变化时一次性清空会话映射（新 Chat 会重新建会话），避免
   * “提示词说有工具、实际不可用”或沿用旧权限。消息发送工具启用时也必须重建会话。
   */
  private resetSessionsForToolMode(): void {
    if (!this.config.chatbotEnabled || !this.config.chatbotAiEnabled) return
    const searchMode = this.config.chatbotSearchEnabled ? this.config.chatbotSearchMode : 'off'
    // read 关闭时保持旧 mode 字符串（兼容既有测试/升级路径）；开启后目录变化也触发重建。
    const baseMode = `${searchMode}:${this.config.chatbotAiSendToolEnabled ? 'send' : 'nosend'}`
    const mode = this.config.chatbotAiContextReadEnabled
      ? `${baseMode}:read:${contextModeTag(this.config.chatbotContextDir)}`
      : baseMode
    const previous = getMeta(this.db, 'chatbot_ai_tool_mode')
    if (previous === mode) {
      void this.cleanupRemoteSessions([])
      return
    }
    try {
      const sessionRows = this.db
        .prepare('SELECT session_id FROM chatbot_ai_sessions')
        .all() as { session_id: string }[]
      const changes = Number(this.db.prepare('DELETE FROM chatbot_ai_sessions').run().changes)
      setMeta(this.db, 'chatbot_ai_tool_mode', mode)
      if (changes > 0) {
        this.deps.audit('chatbot.ai.tool_mode_reset', null, { mode, sessions: changes })
      }
      void this.cleanupRemoteSessions(sessionRows.map((row) => row.session_id))
    } catch (error) {
      this.deps.log('warn', 'Chatbot AI 工具模式切换清理会话失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  /**
   * 工具模式切换后删除旧远端会话，并保守清理没有 DB 映射的孤儿 Chatbot 会话。
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
        (this.db.prepare('SELECT session_id FROM chatbot_ai_sessions').all() as { session_id: string }[]).map(
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
      if (removed > 0) this.deps.audit('chatbot.ai.orphan_sessions_removed', null, { sessions: removed })
    } catch (error) {
      this.deps.log('warn', '清理远端 Chatbot 孤儿会话失败', {
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

  /**
   * v0.7.1：旧版群聊会话按成员拆分；启动时清理所有群目标的非共享 Chat 映射。
   * 仅保留 `__group__` 映射（若已存在），并异步尽力删除远端旧会话；下次群 Chat 会创建共享会话。
   */
  private migrateLegacyGroupSessions(): void {
    const groups = this.db
      .prepare("SELECT chatbot_id, external_id FROM chatbot_targets WHERE kind = 'group'")
      .all() as unknown as { chatbot_id: string; external_id: string }[]
    let removed = 0
    for (const group of groups) {
      const stale = this.db
        .prepare(
          "SELECT session_id FROM chatbot_ai_sessions WHERE chatbot_id = ? AND target_external_id = ? AND mode = 'chat' AND user_id <> ?",
        )
        .all(group.chatbot_id, group.external_id, GROUP_CHAT_SESSION_USER_ID) as unknown as { session_id: string }[]
      if (stale.length === 0) continue
      this.db
        .prepare(
          "DELETE FROM chatbot_ai_sessions WHERE chatbot_id = ? AND target_external_id = ? AND mode = 'chat' AND user_id <> ?",
        )
        .run(group.chatbot_id, group.external_id, GROUP_CHAT_SESSION_USER_ID)
      removed += stale.length
      for (const row of stale) {
        void this.deps.ai?.deleteSession?.(row.session_id)?.catch(() => undefined)
      }
    }
    if (removed > 0) this.deps.log('info', '旧群聊分用户会话已清理', { removed })
  }

  start(): void {
    // 上下文文档是派生数据；即使 Chatbot 当前关闭也在启动时回收一次超期孤儿，避免个人记忆长期残留。
    this.cleanupContext()
    if (!this.enabled || this.timer) return
    try {
      this.migrateGroupChatMemories()
    } catch (error) {
      // 迁移失败不阻塞 Chatbot 启动；保留 meta 标记缺失，下次启动重试。
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
    try {
      this.migrateLegacyGroupSessions()
    } catch (error) {
      this.deps.log('warn', '群聊旧分用户会话清理失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
    try {
      const removed = this.memory.cleanupOrphanMirrors()
      if (removed > 0) this.deps.log('info', '已清理 Chatbot 记忆镜像孤儿', { removed })
    } catch (error) {
      this.deps.log('warn', 'Chatbot 记忆镜像孤儿清理失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
    this.stopped = false
    this.timer = setInterval(() => this.scheduleTick(), this.config.chatbotDeliveryIntervalSeconds * 1000)
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

  async tick(): Promise<void> {    if (!this.enabled || this.stopped || this.ticking) return
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
  notifyAlert(event: ChatbotAlertEvent): void {
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
    chatbotId: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): Promise<{ status: number; body: unknown }> {
    return this.inbound.handleWebhook(chatbotId, headers, body)
  }

  /** 消息发送工具入口：认证/缓冲在 Chat 管线内完成。 */
  handleAiSendTool(input: unknown): { status: number; body: unknown } {
    return this.chat.handleAiSendTool(input)
  }

  private insertEvent(
    chatbotId: string,
    eventId: string,
    kind: string,
    outcome: ChatbotEventOutcome,
    detail: string | null,
    targetExternalId: string | null,
    userId: string | null,
  ): boolean {
    return this.diagnostics.insertEvent(chatbotId, eventId, kind, outcome, detail, targetExternalId, userId)
  }

  private markEvent(
    chatbotId: string,
    eventId: string,
    update: { outcome: ChatbotEventOutcome; detail?: string; target?: string; user?: string },
  ): void {
    this.diagnostics.markEvent(chatbotId, eventId, update)
  }

  private recordInbound(chatbot: ChatbotRow, result: Extract<InboundVerification, { kind: 'command' | 'chat' }>): void {
    this.diagnostics.recordInbound(chatbot, result)
  }

  /** 入站模块把 Chat 消息放入连续消息合并器（保留原有 burst 时序语义）。 */
  private enqueueChatMessage(
    chatbot: ChatbotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
    text: string,
    timing: BurstTimingLike | undefined,
  ): void {
    this.chat.enqueue(chatbot, result, text, timing)
  }

  private chatBurstKey(chatbotId: string, targetExternalId: string, userId: string): string {
    return `${chatbotId}:${targetExternalId}:${userId}`
  }

  private async executeCommand(
    chatbot: ChatbotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    parsed: ParsedCommand | null,
    adminAllowed: boolean,
  ): Promise<void> {
    const command = parsed?.command ?? ''
    const args = parsed?.args ?? ''
    this.deps.audit('chatbot.command', `${chatbot.platform}:${result.targetExternalId}`, {
      command: command.slice(0, 32),
      chatbot: chatbot.id,
      user: result.userId.slice(0, 64),
    })
    const finish = (outcome: ChatbotEventOutcome, detail: string) =>
      this.markEvent(chatbot.id, result.eventId, {
        outcome,
        detail,
        target: result.targetExternalId,
        user: result.userId,
      })
    try {
      if (!(CHATBOT_COMMANDS as readonly string[]).includes(command)) {
        await result.reply(adminAllowed ? helpText() : publicHelpText())
        finish('ok', 'help')
        return
      }
      let text: string
      switch (command) {
        case 'search':
          await this.chat.executeSearchChat(chatbot, result, args)
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
          text = await this.executeRoleCommand(chatbot, result, args)
          break
        case 'reset':
          text = this.resetConversation(chatbot, result)
          break
        case 'forget':
          text = this.forgetMemory(chatbot, result, args)
          break
        case 'memory':
          text = this.executeMemoryCommand(chatbot, result, args)
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
        this.deps.log('warn', 'Chatbot 命令回复部分外发', {
          chatbot: chatbot.id,
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

  /** `/reset`：删除当前 Chatbot×目标×用户的会话映射与远端会话，长期记忆保留。 */
  private resetConversation(
    chatbot: ChatbotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
  ): string {
    this.chat.clearSession(chatbot.id, result.targetExternalId, result.userId)
    this.chat.clearSearchQuery(chatbot.id, result.userId)
    this.resetChatSession(chatbot.id, result.targetExternalId, result.userId)
    void this.cleanupRemoteSessions([])
    this.deps.audit('chatbot.reset', chatbot.id, { chatbot: chatbot.id, user: result.userId.slice(0, 64) })
    return '已重置当前对话（长期记忆保留）。'
  }

  /**
   * `/forget confirm`：删除结构化记忆（条目+状态+旧摘要+镜像）、全部会话映射与远端会话；幂等。
   * 同时取消待处理批次并递增 generation，避免在途抽取把旧记忆写回。
   */
  private forgetMemory(
    chatbot: ChatbotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): string {
    if (args.trim().toLowerCase() !== 'confirm') {
      return '用法：/forget confirm（将清除长期记忆与全部对话上下文，此操作不可恢复）。'
    }
    this.cancelUserMemory(chatbot.id, result.userId)
    // D-13：群共享记忆条目按稳定 member_openid 归属，/forget 同时清除本人贡献的群记忆并取消在途抽取。
    this.cancelMemberGroupMemory(chatbot.id, result.userId)
    this.chat.clearSession(chatbot.id, result.targetExternalId, result.userId)
    this.chat.clearSearchQuery(chatbot.id, result.userId)
    this.deleteRemoteSessions(chatbot.id, { userId: result.userId })
    void this.cleanupRemoteSessions([])
    const removed = this.memory.deleteUser(chatbot.id, result.userId)
    const groupRemoved = this.memory.deleteMemberGroupItems(chatbot.id, result.userId)
    this.db.prepare('DELETE FROM chatbot_ai_sessions WHERE chatbot_id = ? AND user_id = ?').run(chatbot.id, result.userId)
    // 删除磁盘上的记忆文档：用户作用域精确删除；群作用域整目录删除（下一轮按当前 DB 重建）。
    const removedUserScopes = this.context.removeUserScopes(chatbot.id, result.userId)
    const removedGroupScopes = this.context.removeGroupScopes(chatbot.id)
    this.deps.audit('chatbot.memory.forget', chatbot.id, {
      chatbot: chatbot.id,
      user: result.userId.slice(0, 64),
      items: removed.deletedItems,
      legacy: removed.deletedLegacy ? 1 : 0,
      groupItems: groupRemoved.items,
      groupScopes: groupRemoved.groups,
      userScopes: removedUserScopes,
      contextGroupScopes: removedGroupScopes,
    })
    return removed.deletedItems > 0 || removed.deletedLegacy || groupRemoved.items > 0
      ? `已清除长期记忆与全部对话上下文（记忆条目 ${removed.deletedItems} 条${groupRemoved.items > 0 ? `，群聊共享记忆 ${groupRemoved.items} 条` : ''}${removed.deletedLegacy ? '，旧摘要已删除' : ''}）。`
      : '已清除长期记忆与全部对话上下文。'
  }

  /** `/memory`：查看状态或 off/on 暂停/恢复；只展示条目计数与类型分布，不展示 key/value。 */
  private executeMemoryCommand(
    chatbot: ChatbotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): string {
    const sub = args.trim().toLowerCase()
    if (sub === 'off' || sub === 'on') {
      const enabled = sub === 'on'
      this.memory.setMemoryEnabled(chatbot.id, result.userId, enabled)
      if (!enabled) this.cancelUserMemory(chatbot.id, result.userId)
      this.deps.audit('chatbot.memory.toggle', chatbot.id, {
        chatbot: chatbot.id,
        user: result.userId.slice(0, 64),
        enabled,
      })
      return enabled
        ? '已开启长期记忆：之后的对话会重新抽取记忆。'
        : '已关闭长期记忆：不再抽取与注入，已取消待处理的记忆批次。'
    }
    return this.memoryStatusText(chatbot.id, result.userId)
  }

  /** /memory 状态文本：总条数、各类型计数、启用状态与最近更新时间（不含 key/value）。 */
  private memoryStatusText(chatbotId: string, userId: string): string {
    const state = this.memory.getState(chatbotId, userId)
    // 通过 MemoryStore 元数据 API 聚合：总数取 total，各类型分页累计，避免读取条目正文。
    const kinds = new Map<ChatbotMemoryKind, number>()
    let updatedAt: string | null = null
    const first = this.memory.listItems(chatbotId, userId, 200, 0)
    let page = first
    let offset = 0
    while (true) {
      for (const item of page.items) {
        kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
        if (!updatedAt || item.updatedAt > updatedAt) updatedAt = item.updatedAt
      }
      offset += page.items.length
      if (page.items.length === 0 || offset >= page.total) break
      page = this.memory.listItems(chatbotId, userId, 200, offset)
    }
    const kindText = [...kinds.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${MEMORY_KIND_LABEL[kind] ?? kind} ${count}`)
      .join('、')
    const legacy = state.legacyMigratedAt ? null : this.memory.legacySummary(chatbotId, userId)
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
    chatbot: ChatbotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): Promise<string> {
    // Webhook 已在群聊/频道拦截命令；这里保留防御，避免未来路由变化导致群内写角色卡。
    if (!result.isDirect) return roleGroupHint()
    const card = this.roles.get(chatbot.id, result.userId)
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
      this.roles.save(chatbot.id, result.userId, name, prompt)
      this.resetChatSession(chatbot.id, result.targetExternalId, result.userId)
      this.deps.audit('chatbot.role', `${chatbot.platform}:${result.targetExternalId}`, {
        chatbot: chatbot.id,
        user: result.userId.slice(0, 64),
        action: 'set',
        nameLength: name.length,
        promptLength: prompt.length,
      })
      return `专属角色「${name}」已设置，私聊将使用该角色；群聊仍使用默认 mcbot。`
    }

    if (sub === 'off' || sub === 'on') {
      if (!card) {
        return sub === 'off'
          ? '当前没有专属角色，正在使用默认 mcbot。'
          : '当前没有专属角色，可先用 /role set 设置。'
      }
      const enabled = sub === 'on'
      if (!this.roles.setEnabled(chatbot.id, result.userId, enabled)) return '角色状态更新失败，请稍后重试。'
      this.resetChatSession(chatbot.id, result.targetExternalId, result.userId)
      this.deps.audit('chatbot.role', `${chatbot.platform}:${result.targetExternalId}`, {
        chatbot: chatbot.id,
        user: result.userId.slice(0, 64),
        action: sub,
      })
      return enabled
        ? `专属角色「${card.name}」已启用。`
        : '专属角色已暂停，当前使用默认 mcbot。'
    }

    if (sub === 'delete') {
      if (!this.roles.remove(chatbot.id, result.userId)) {
        return '当前没有专属角色。'
      }
      this.resetChatSession(chatbot.id, result.targetExternalId, result.userId)
      this.deps.audit('chatbot.role', `${chatbot.platform}:${result.targetExternalId}`, {
        chatbot: chatbot.id,
        user: result.userId.slice(0, 64),
        action: 'delete',
      })
      return '专属角色已删除，当前使用默认 mcbot。'
    }

    return roleUsage()
  }

  /** 删除当前 Chatbot×目标×用户的会话映射，并尽力删除对应远端会话（保留远端历史以外的副本）。 */
  private resetChatSession(chatbotId: string, targetExternalId: string, userId: string): void {
    this.deleteRemoteSessions(chatbotId, { targetExternalId, userId })
    this.db
      .prepare('DELETE FROM chatbot_ai_sessions WHERE chatbot_id = ? AND target_external_id = ? AND user_id = ?')
      .run(chatbotId, targetExternalId, userId)
    this.context.removeScope(chatbotId, targetExternalId, userId)
  }

  /** 管理端角色变更：清理该用户全部会话映射与上下文文档（私聊可能涉及多个目标）。 */
  private resetUserSessions(chatbotId: string, userId: string): void {
    this.deleteRemoteSessions(chatbotId, { userId })
    this.db.prepare('DELETE FROM chatbot_ai_sessions WHERE chatbot_id = ? AND user_id = ?').run(chatbotId, userId)
    this.context.removeUserScopes(chatbotId, userId)
  }

  /** 群聊角色/目标变更：清理该群共享会话与群作用域文档。 */
  private resetGroupSessions(chatbotId: string, targetExternalId: string): void {
    const userId = GROUP_CHAT_SESSION_USER_ID
    this.deleteRemoteSessions(chatbotId, { targetExternalId, userId })
    this.db
      .prepare('DELETE FROM chatbot_ai_sessions WHERE chatbot_id = ? AND target_external_id = ? AND user_id = ?')
      .run(chatbotId, targetExternalId, userId)
    this.context.removeScope(chatbotId, targetExternalId, userId)
  }

  /** 目标删除/类型变更：清理该目标下全部会话映射与上下文文档。 */
  private resetTargetSessions(chatbotId: string, targetExternalId: string): void {
    this.deleteRemoteSessions(chatbotId, { targetExternalId })
    this.db
      .prepare('DELETE FROM chatbot_ai_sessions WHERE chatbot_id = ? AND target_external_id = ?')
      .run(chatbotId, targetExternalId)
    this.context.removeTarget(chatbotId, targetExternalId)
  }

  /** 当前仍存在的会话作用域集合；用于上下文目录维护清理。 */
  private activeContextScopes(): Set<string> {
    const rows = this.db
      .prepare('SELECT chatbot_id, target_external_id, user_id FROM chatbot_ai_sessions')
      .all() as unknown as { chatbot_id: string; target_external_id: string; user_id: string }[]
    return new Set(rows.map((row) => contextScopeKey(row.chatbot_id, row.target_external_id, row.user_id)))
  }

  /** 维护清理：只回收无活动会话映射且超期的上下文目录，避免个人数据长期残留。 */
  private cleanupContext(): number {
    try {
      const removed = this.context.sweep(this.activeContextScopes())
      if (removed > 0) this.deps.log('info', '已清理 Chatbot 上下文文档孤儿', { removed })
      return removed
    } catch (error) {
      this.deps.log('warn', 'Chatbot 上下文文档清理失败', {
        error: error instanceof Error ? error.message : 'unknown',
      })
      return 0
    }
  }

  /**
   * 尽力删除本地映射对应的远端 OpenCode 会话（含旧摘要会话）。
   * 远端删除异步执行并纳入 pending；失败只记日志，不阻塞命令响应。
   */
  private deleteRemoteSessions(
    chatbotId: string,
    filter: { targetExternalId?: string; userId?: string },
  ): void {
    if (!this.deps.ai?.deleteSession) return
    const clauses = ['chatbot_id = ?']
    const params: string[] = [chatbotId]
    if (filter.targetExternalId) {
      clauses.push('target_external_id = ?')
      params.push(filter.targetExternalId)
    }
    if (filter.userId) {
      clauses.push('user_id = ?')
      params.push(filter.userId)
    }
    const rows = this.db
      .prepare(`SELECT session_id FROM chatbot_ai_sessions WHERE ${clauses.join(' AND ')}`)
      .all(...params) as unknown as { session_id: string }[]
    const ids = new Set<string>()
    for (const row of rows) if (row.session_id) ids.add(row.session_id)
    // legacy 摘要没有 target 维度：只在按用户过滤时删除，避免按目标清理时误删其他用户的旧摘要会话。
    if (filter.userId) {
      const memories = this.db
        .prepare('SELECT summary_session_id FROM chatbot_ai_memories WHERE chatbot_id = ? AND user_id = ? AND summary_session_id IS NOT NULL')
        .all(chatbotId, filter.userId) as unknown as { summary_session_id: string }[]
      for (const row of memories) if (row.summary_session_id) ids.add(row.summary_session_id)
    }
    for (const sessionId of ids) {
      const task = this.deps.ai.deleteSession(sessionId).catch(() => undefined)
      this.pending.add(task)
      void task.finally(() => this.pending.delete(task))
    }
  }

  /** 开启一轮消息发送工具上下文；工具未启用/无 Chatbot 密钥时返回 null。 */
  private memoryKey(chatbotId: string, userId: string): string {
    return `${chatbotId}:${userId}`
  }

  /**
   * 取消某用户待处理的记忆批次并递增 generation：
   * 已入队的在途抽取会在写回前发现版本变化而放弃，避免 `/memory off` 或 `/forget` 后被旧数据回写。
   */
  private cancelUserMemory(chatbotId: string, userId: string): void {
    const key = this.memoryKey(chatbotId, userId)
    this.memoryGenerations.set(key, (this.memoryGenerations.get(key) ?? 0) + 1)
    const timer = this.memoryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.memoryTimers.delete(key)
    }
    this.memoryPending.delete(key)
  }

  /**
   * 取消某群 scope 下所有成员的在途/待处理记忆抽取（管理端清空群记忆用，CHATBOT-06）。
   * 群聊队列 key 形如 `${chatbot}:${scope}:${userId}`，gen 与队列必须同源，否则清空后会被在途批次写回。
   */
  private cancelGroupMemoryScope(chatbotId: string, scope: string): void {
    const prefix = `${chatbotId}:${scope}:`
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
  private cancelMemberGroupMemory(chatbotId: string, memberUserId: string): void {
    const groups = this.db
      .prepare("SELECT external_id FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'group'")
      .all(chatbotId) as unknown as { external_id: string }[]
    for (const group of groups) {
      const key = `${chatbotId}:${groupMemoryScope(group.external_id)}:${memberUserId}`
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
   * 回复已发送后再更新长期记忆：按 Chatbot×用户合并待抽取对话，
   * 达到条数阈值或用户空闲后触发一次结构化抽取，减少高频 Chat 的额外模型调用。
   */
  private scheduleMemoryUpdate(
    chatbot: ChatbotRow,
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
    if (!this.memory.getState(chatbot.id, memoryScope).memoryEnabled) return
    const key = this.memoryQueueKey(chatbot.id, userId, memoryScope, Boolean(groupUserName))
    const entry = this.memoryPending.get(key) ?? {
      chatbot,
      userId,
      targetExternalId,
      memoryScope,
      ...(groupUserName ? { groupUserName } : {}),
      rounds: [],
    }
    entry.chatbot = chatbot
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
    if (entry.rounds.length >= Math.max(1, this.config.chatbotAiMemoryBatchMessages)) {
      this.flushMemory(key)
      return
    }
    const idleSeconds = this.config.chatbotAiMemoryIdleFlushSeconds
    if (idleSeconds > 0) {
      const timer = setTimeout(() => {
        this.memoryTimers.delete(key)
        this.flushMemory(key)
      }, idleSeconds * 1000)
      timer.unref()
      this.memoryTimers.set(key, timer)
    }
  }

  /** 私聊按 Chatbot×用户、群聊按 Chatbot×群 scope×发言用户隔离待抽取批次。 */
  private memoryQueueKey(chatbotId: string, userId: string, memoryScope: string, group: boolean): string {
    return group ? `${chatbotId}:${memoryScope}:${userId}` : this.memoryKey(chatbotId, userId)
  }

  /**
   * 群聊共享记忆操作（D-13）：key 前缀使用稳定 member_openid，显示名只写入 value（“用户名：记忆”）。
   * 模型可能按旧提示词输出 `<显示名>:` 前缀，服务端统一剥掉后改写，保证同名/改名成员不会互相覆盖或删除。
   * 已登记用户/其他成员的用户级记忆不会进入这里。
   */
  private groupMemoryOperations(
    memberUserId: string,
    memberName: string,
    ops: readonly ChatbotMemoryOperation[],
  ): ChatbotMemoryOperation[] {
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
          entry.chatbot,
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
    chatbot: ChatbotRow,
    userId: string,
    targetExternalId: string,
    userText: string,
    assistantText: string,
    rounds: number,
    generation: number,
    memoryScope: string,
    groupUserName?: string,
  ): Promise<void> {
    const key = this.memoryQueueKey(chatbot.id, userId, memoryScope, Boolean(groupUserName))
    // 排队期间被取消（/memory off、/forget、管理端删除）：不再读取/写入任何记忆数据。
    if ((this.memoryGenerations.get(key) ?? 0) !== generation) return
    try {
      const state = this.memory.getState(chatbot.id, memoryScope)
      if (!state.memoryEnabled) return
      const existing = this.memory.itemsForExtraction(chatbot.id, memoryScope)
      // 群聊共享记忆没有 legacy 摘要；只有私聊用户才迁移旧摘要。
      const legacy = !groupUserName && !state.legacyMigratedAt ? this.memory.legacySummary(chatbot.id, memoryScope) : null
      const legacySummary = legacy?.summary ?? ''
      let ops: ChatbotMemoryOperation[]
      try {
        ops = await this.deps.ai!.extractMemories!({
          chatbotId: chatbot.id,
          userId: groupUserName ? memoryScope : userId,
          sessionTitle: `${this.targetNameForSession(chatbot.id, targetExternalId, userId)} Memory`,
          existing,
          legacySummary,
          userText,
          assistantText,
          ...(groupUserName ? { groupUserName } : {}),
          maxOps: MEMORY_MAX_OPS,
        })
      } finally {
        this.observeAiToolIsolation(chatbot.id)
      }
      // 抽取期间记忆被关闭/清除：丢弃本次结果，避免旧数据回写。
      if ((this.memoryGenerations.get(key) ?? 0) !== generation) return
      const current = this.memory.getState(chatbot.id, memoryScope)
      if (!current.memoryEnabled) return
      const finalOps = groupUserName ? this.groupMemoryOperations(userId, groupUserName, ops) : ops
      const result = this.memory.applyOperations(chatbot.id, memoryScope, finalOps, 'chat')
      // 只有本次确实产出可迁移条目时才把旧摘要标记为已迁移；ops=0（模型未转换出条目）
      // 必须保留 fallback 注入并继续作为后续批次的迁移输入，避免旧记忆被"静默丢弃"。
      let migrated = false
      if (legacySummary && !current.legacyMigratedAt && result.upserts > 0) {
        this.memory.markLegacyMigrated(chatbot.id, memoryScope)
        migrated = true
      }
      this.deps.audit('chatbot.memory.extract', `${chatbot.platform}:${targetExternalId}`, {
        chatbot: chatbot.id,
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
      this.deps.log('warn', 'Chatbot 记忆抽取失败', {
        chatbot: chatbot.id,
        error: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  private cleanup(): void {
    const cutoff = new Date(Date.now() - this.config.chatbotEventRetentionDays * 86400_000).toISOString()
    try {
      this.db.prepare('DELETE FROM chatbot_events WHERE received_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM chatbot_inbound_targets WHERE last_seen_at < ?').run(cutoff)
      this.memory.cleanup()
      this.memory.cleanupOrphanMirrors()
      this.cleanupContext()
      this.queue.cleanupExpired()
      this.deps.ai?.cleanup?.()
    } catch {
      // 清理失败不影响投递。
    }
  }

  private chatbotRow(id: string): ChatbotRow {
    const row = this.db.prepare('SELECT * FROM chatbots WHERE id = ?').get(id) as unknown as ChatbotRow | undefined
    if (!row) throw notFound('Chatbot 不存在')
    return row
  }

  private targetRow(id: string): ChatbotTargetRow {
    const row = this.db.prepare('SELECT * FROM chatbot_targets WHERE id = ?').get(id) as unknown as ChatbotTargetRow | undefined
    if (!row) throw notFound('目标不存在')
    return row
  }

  private targetRowForBot(chatbotId: string, targetId: string): ChatbotTargetRow {
    const row = this.db
      .prepare('SELECT * FROM chatbot_targets WHERE id = ? AND chatbot_id = ?')
      .get(targetId, chatbotId) as unknown as ChatbotTargetRow | undefined
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
    chatbotId: string,
    targetExternalId: string,
    userId: string,
    userName?: string | null,
  ): string {
    const target = this.db
      .prepare('SELECT label FROM chatbot_targets WHERE chatbot_id = ? AND external_id = ?')
      .get(chatbotId, targetExternalId) as { label: string } | undefined
    const label = cleanText(target?.label, 60)
    if (label) return label
    const inbound = this.db
      .prepare('SELECT user_name FROM chatbot_inbound_targets WHERE chatbot_id = ? AND target_external_id = ? AND user_id = ?')
      .get(chatbotId, targetExternalId, userId) as { user_name: string | null } | undefined
    const name = cleanText(userName ?? inbound?.user_name ?? '', 60)
    if (name) return name
    const short = (targetExternalId || userId).slice(-6)
    return short ? `目标${short}` : 'Chatbot'
  }

  private inboundTarget(
    chatbotId: string,
    input: { targetExternalId: string; userId: string; isDirect: boolean },
  ): ChatbotTargetRow | undefined {
    const direct = this.db
      .prepare('SELECT * FROM chatbot_targets WHERE chatbot_id = ? AND external_id = ?')
      .get(chatbotId, input.targetExternalId) as unknown as ChatbotTargetRow | undefined
    if (direct) return direct
    if (!input.isDirect) return undefined
    return this.db
      .prepare("SELECT * FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'user' AND external_id = ?")
      .get(chatbotId, input.userId) as unknown as ChatbotTargetRow | undefined
  }

  private firstTarget(chatbotId: string): ChatbotTargetRow | null {
    const row = this.db
      .prepare('SELECT * FROM chatbot_targets WHERE chatbot_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(chatbotId) as unknown as ChatbotTargetRow | undefined
    return row ?? null
  }

  /** 命令必须同时满足目标授权 + 用户白名单（kind=user 且 allow_commands=1）。 */
  private isCommandUserAllowed(chatbotId: string, userId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'user' AND external_id = ? AND allow_commands = 1")
      .get(chatbotId, userId) as { ok: number } | undefined
    return row !== undefined
  }

  private publishRow(id: string): ChatbotPublishRow {
    const row = this.db.prepare('SELECT * FROM chatbot_publish_jobs WHERE id = ?').get(id) as unknown as ChatbotPublishRow | undefined
    if (!row) throw notFound('发布任务不存在')
    return row
  }

  private secretOf(row: ChatbotRow): ChatbotSecret {
    return decryptBotSecret(this.key!, {
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      tag: row.secret_tag,
      keyVersion: row.key_version,
    })
  }

  private adapterFor(row: ChatbotRow): ChatbotAdapter {
    const config = parseConfig(row.config_json)
    const secret = this.secretOf(row)
    return new QqAdapter(config, secret, {
      fetch: this.deps.fetch,
      now: this.deps.now,
      sendIntervalMs: this.deps.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS,
    })
  }

  private toSummary(row: ChatbotRow): ChatbotSummary {
    const config = parseConfig(row.config_json)
    const adapter = this.adapterFor(row)
    const setup = adapter.setup(row.id, this.config.appOrigin)
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM chatbot_targets WHERE chatbot_id = ?').get(row.id) as { c: number }
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

  private normalizeSecret(input: CreateBotInput): ChatbotSecret {
    return { token: cleanText(input.token, 500) }
  }

  private normalizeConfig(raw: Record<string, unknown> | undefined): Record<string, unknown> {
    const source = raw ?? {}
    return { appId: cleanText(source.appId ?? source.applicationId, 64) }
  }

  private validateOrThrow(config: Record<string, unknown>, secret: ChatbotSecret): void {
    const adapter = new QqAdapter(config, secret, {
      fetch: this.deps.fetch,
      now: this.deps.now,
      sendIntervalMs: this.deps.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS,
    })
    const errors = adapter.validate(config, secret)
    if (errors.length > 0) throw badRequest(`Chatbot 配置无效：${errors.join(', ')}`, 'invalid_chatbot_config')
  }

  private parseSchedule(scheduledAt: string | null | undefined): string | null {
    if (!scheduledAt) return null
    const time = Date.parse(scheduledAt)
    if (!Number.isFinite(time)) throw badRequest('定时时间格式无效')
    if (time < Date.now() - 30_000) throw badRequest('定时时间必须晚于当前时间')
    if (time > Date.now() + this.config.chatbotPublishMaxScheduledDays * 86400_000) {
      throw badRequest(`定时时间不能超过 ${this.config.chatbotPublishMaxScheduledDays} 天`)
    }
    return new Date(time).toISOString()
  }
}

function toDelivery(row: ChatbotDeliveryRow): ChatbotDelivery {
  return {
    id: row.id,
    chatbotId: row.chatbot_id,
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

function toPublishJob(row: ChatbotPublishRow): ChatbotPublishJob {
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
    chatbotId: row.chatbot_id,
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
