/**
 * Bot 平台核心类型：当前仅支持 QQ 官方 Bot；平台标识、加密后的凭据、公开配置、队列与命令事件。
 * 安全边界：本文件中的 `BotSecret` 只允许在服务端短生命周期使用，禁止序列化到 API/日志。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'

export const BOT_PLATFORMS = ['qq'] as const
export type BotPlatform = (typeof BOT_PLATFORMS)[number]

export function isBotPlatform(value: unknown): value is BotPlatform {
  return typeof value === 'string' && (BOT_PLATFORMS as readonly string[]).includes(value)
}

export interface BotSecret {
  /** QQ 官方 Bot AppSecret（旧版本字段名为 token）。 */
  token: string
}

export interface BotRow {
  id: string
  platform: BotPlatform
  name: string
  enabled: number
  config_json: string
  secret_ciphertext: string
  secret_iv: string
  secret_tag: string
  key_version: number
  created_at: string
  updated_at: string
  last_error: string | null
  last_checked_at: string | null
}

export interface BotTargetRow {
  id: string
  bot_id: string
  external_id: string
  label: string
  kind: 'channel' | 'user' | 'group'
  allow_commands: number
  allow_notifications: number
  /** 是否允许该目标内成员进行普通消息 Chat；与 allow_commands 独立。 */
  allow_chat: number
  /** 群消息模式：mention=仅 @/名字提及；all=全部消息由模型决定是否回复（仅群聊目标）。 */
  chat_trigger: GroupReplyMode
  /** 静默时段（本地分钟 0-1439）；两者都非空时生效。 */
  quiet_start_minute: number | null
  quiet_end_minute: number | null
  created_at: string
}

export interface BotTarget {
  id: string
  botId: string
  externalId: string
  label: string
  kind: 'channel' | 'user' | 'group'
  allowCommands: boolean
  allowNotifications: boolean
  allowChat: boolean
  /** 群消息模式；仅群聊目标可设为 all，其余固定 mention。 */
  groupReplyMode: GroupReplyMode
  quietStartMinute: number | null
  quietEndMinute: number | null
  createdAt: string
}

export interface BotDeliveryRow {
  id: string
  bot_id: string
  target_id: string | null
  kind: 'notification' | 'command_reply' | 'publish' | 'test'
  dedupe_key: string | null
  payload_json: string
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'dead'
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  external_id: string | null
  created_at: string
  updated_at: string
  sent_at: string | null
}

export interface BotDelivery {
  id: string
  botId: string
  targetId: string | null
  kind: BotDeliveryRow['kind']
  status: BotDeliveryRow['status']
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  /** 服务端按 last_error 计算的中文提示；未知错误为 null。 */
  lastErrorHint?: string | null
  externalId: string | null
  createdAt: string
  sentAt: string | null
}

export interface BotPublishRow {
  id: string
  bot_id: string
  target_id: string
  content_json: string
  media_file_ids_json: string
  scheduled_at: string | null
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed' | 'canceled'
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
  sent_at: string | null
}

export interface BotPublishJob {
  id: string
  botId: string
  targetId: string
  text: string
  scheduledAt: string | null
  status: BotPublishRow['status']
  attempts: number
  lastError: string | null
  lastErrorHint?: string | null
  createdAt: string
  sentAt: string | null
}

export interface OutboundContent {
  /** QQ 仅支持文本。 */
  text: string
}

export interface SendResult {
  externalId: string | null
  externalIds?: string[]
  /** 长文本分段部分发送失败；队列不得自动重试，避免重复外发。 */
  partial?: boolean
}

/** QQ 群/频道只有 @Bot 事件进入 Bot；C2C 私聊直接进入。 */
export type ChatTrigger = 'direct' | 'mention' | 'all'

/** 群消息模式：默认仅 @/名字提及；all 为实验性全量消息。 */
export type GroupReplyMode = 'mention' | 'all'

/** 平台入站图片：只保存平台侧引用，实际下载由适配器 loadImage 完成。 */
export interface BotInboundImage {
  /** 平台附件 URL 等适配器可解析的引用。 */
  ref: string
  mime: string
  name?: string
  /** 平台声明的字节数（可选，用于提前拒绝超限文件）。 */
  size?: number
}

export type InboundVerification =
  | { kind: 'ignored'; ackBody?: unknown; detail?: string; eventId?: string }
  | { kind: 'challenge'; body: unknown }
  | { kind: 'rejected'; status: number; code: string }
  | {
      kind: 'command'
      eventId: string
      targetExternalId: string
      targetKind: BotTargetRow['kind']
      userId: string
      userName: string | null
      text: string
      isDirect: boolean
      /** 平台事件回调必须返回的确认体（QQ `{opcode:12}`）。 */
      ackBody?: unknown
      reply: (text: string) => Promise<void>
    }
  | {
      kind: 'chat'
      eventId: string
      targetExternalId: string
      targetKind: BotTargetRow['kind']
      userId: string
      userName: string | null
      text: string
      isDirect: boolean
      chatTrigger: ChatTrigger
      /** 全量群消息事件中，mentions 是否包含机器人账号。 */
      mentionedBot?: boolean
      /** 入站图片（可选）；由 Service 决定是否下载并交给 AI。 */
      image?: BotInboundImage
      ackBody?: unknown
      reply: (text: string) => Promise<void>
    }

export interface BotHealthItem {
  name: string
  ok: boolean
  /** 脱敏细节（如平台身份/错误码），不包含 Token 或内部 URL。 */
  detail: string
}

export interface BotHealthCheck {
  ok: boolean
  items: BotHealthItem[]
  /** 自检时间（ISO 8601）；由 Service 注入，adapter 可不返回。 */
  checkedAt?: string
}

export interface BotAdapter {
  platform: BotPlatform
  /** 校验公开配置与密钥，返回错误码数组；空数组表示通过。 */
  validate(config: Record<string, unknown>, secret: BotSecret): string[]
  /** 构造 Webhook URL 与平台后台配置步骤（不含密钥）。 */
  setup(botId: string, appOrigin: string): { webhookUrl: string; steps: string[] }
  verifyInbound(input: {
    botId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }): Promise<InboundVerification>
  send(target: BotTargetRow, content: OutboundContent): Promise<SendResult>
  /** 只读连接自检。 */
  check?(input: { botId: string; appOrigin: string }): Promise<BotHealthCheck>
  /** 下载入站图片（固定平台域名）；调用方负责 mime 白名单与大小上限。 */
  loadImage?(
    image: BotInboundImage,
    options: { maxBytes: number; timeoutMs?: number },
  ): Promise<{ mime: string; data: Buffer }>
}

export interface BotCommandProviders {
  status(): Promise<Record<string, unknown>>
  backup(): Promise<Record<string, unknown>>
  world(): Promise<Record<string, unknown>>
  minecraft(): Promise<Record<string, unknown>>
  files(query: string): Promise<Record<string, unknown>[]>
}

/** AI 对话提供方（通过 OpenCode 本地 HTTP API）。 */

/** 入站图片转成 OpenCode prompt files 的 data URL；只允许图片 mime。 */
export interface BotAiImage {
  mime: string
  base64: string
  name?: string
}

/** AI 工具隔离状态：supported=false 表示 OpenCode 拒绝 permissions 后已降级为默认工具权限（未隔离）。 */
export interface BotToolIsolationStatus {
  supported: boolean
  /** 进程生命周期内发生降级的累计次数；0 表示从未降级。 */
  fallbackCount: number
  /** 首次降级时间（ISO 8601）；未降级为 null。 */
  fallbackAt: string | null
  /**
   * 下一次允许重试 permissions 的时间（ISO 8601）；未降级/无需重试为 null。
   * service 侧据此决定是否前置 fail-closed：窗口内阻断新 Chat，到点后放行给 AI 层重试。
   */
  retryAt: string | null
}

export interface BotAi {
  chat(input: {
    botId: string
    targetExternalId: string
    userId: string
    prompt: string
    /** 新会话标题；为空时使用内置默认标题。 */
    sessionTitle?: string
    /** 可选图片；未启用/不支持时由调用方降级为纯文本。 */
    image?: BotAiImage
  }): Promise<string>
  /** 工具隔离状态（可选；未实现时服务端视为未知）。 */
  toolIsolation?(): BotToolIsolationStatus
  /**
   * 从一批对话中抽取结构化记忆操作；每次使用一次性远端会话并在结束后删除。
   * 模型只负责给出操作意图，业务校验与合并由 MemoryStore 完成。
   */
  extractMemories?(input: {
    botId: string
    userId: string
    /** 新会话标题；为空时使用内置默认标题。 */
    sessionTitle?: string
    /** 当前未过期条目（用于让模型做 upsert/delete，而不是重复新增）。 */
    existing: BotMemoryItemPrompt[]
    /** 尚未迁移的旧滚动摘要；空字符串表示无。 */
    legacySummary: string
    userText: string
    assistantText: string
    /** 群聊共享记忆：当前发言用户显示名；设置后按“用户名：记忆”归属到该用户。 */
    groupUserName?: string
    maxOps: number
  }): Promise<BotMemoryOperation[]>
  /** 删除远端 AI 会话（/reset、/forget、角色变更等本地映射清理时尽力删除）。 */
  deleteSession?(sessionId: string): Promise<void>
  /** 列出远端 Bot 会话（仅 id/title）；用于清理工具模式切换后的孤儿会话。 */
  listSessions?(): Promise<{ id: string; title: string }[]>
  /** 清理过期会话映射；未实现时服务端跳过。 */
  cleanup?(): number
}

/** 结构化记忆类型。 */
export type BotMemoryKind = 'profile' | 'preference' | 'fact' | 'project' | 'task' | 'relationship' | 'episode'

export const BOT_MEMORY_KINDS: readonly BotMemoryKind[] = [
  'profile',
  'preference',
  'fact',
  'project',
  'task',
  'relationship',
  'episode',
]

/** 抽取模型输出的单条操作；value 仅 upsert 使用。 */
export interface BotMemoryOperation {
  op: 'upsert' | 'delete'
  kind: BotMemoryKind
  key: string
  value?: string
  confidence?: number
  importance?: number
}

/** 提供给模型做合并判断的现有条目（不含 id/时间等内部字段）。 */
export interface BotMemoryItemPrompt {
  kind: BotMemoryKind
  key: string
  value: string
  importance: number
  updatedAt: string
}

/** 管理端条目元数据：绝不包含 key/value。 */
export interface BotMemoryItemSummary {
  id: string
  kind: BotMemoryKind
  importance: number
  confidence: number
  updatedAt: string
  expiresAt: string | null
}

/** 管理端用户级记忆元数据：不含任何正文。 */
export interface BotMemoryUserSummary {
  userId: string
  userName: string | null
  itemCount: number
  kinds: Partial<Record<BotMemoryKind, number>>
  memoryEnabled: boolean
  updatedAt: string | null
}

/** 群聊共享记忆元数据：按群目标聚合，不含 key/value。 */
export interface BotMemoryGroupSummary {
  /** 内部 scope；删除/查看条目时作为标识提交。 */
  scope: string
  targetExternalId: string
  targetName: string
  itemCount: number
  kinds: Partial<Record<BotMemoryKind, number>>
  updatedAt: string | null
}

export interface BotMemoryState {
  memoryEnabled: boolean
  legacyMigratedAt: string | null
}

export interface BotMemoryRow {
  bot_id: string
  user_id: string
  memory_id: string
  summary: string
  summary_session_id: string | null
  created_at: string
  updated_at: string
}

export interface BotInboundTargetRow {
  bot_id: string
  target_external_id: string
  target_kind: BotTargetRow['kind']
  user_id: string
  user_name: string | null
  is_direct: number
  last_seen_at: string
}

export interface BotInboundTarget {
  botId: string
  targetExternalId: string
  targetKind: BotTargetRow['kind']
  userId: string
  userName: string | null
  isDirect: boolean
  lastSeenAt: string
}

/** 诊断事件结果：received=已接收待处理，其余为最终处理结果。 */
export type BotEventOutcome = 'received' | 'ok' | 'denied' | 'rate_limited' | 'ignored' | 'error'

export interface BotEventItem {
  eventId: string
  kind: string | null
  outcome: string | null
  detail: string | null
  targetExternalId: string | null
  userId: string | null
  receivedAt: string
  updatedAt: string | null
}

/** 角色卡管理元数据（不含正文）。 */
export interface BotRoleSummary {
  userId: string
  userName: string | null
  name: string
  enabled: boolean
  promptLength: number
  createdAt: string
  updatedAt: string
}

/** 群聊角色卡列表项：始终列出群聊目标，role=null 表示尚未配置。 */
export interface BotGroupRoleSummary {
  targetId: string
  targetLabel: string
  targetExternalId: string
  name: string | null
  enabled: boolean
  promptLength: number
  updatedAt: string | null
}

/** 群聊角色卡编辑详情（管理员可编辑正文）；target 不存在或非群聊时返回 404/400。 */
export interface BotGroupRoleDetail {
  targetId: string
  targetLabel: string
  targetExternalId: string
  name: string
  prompt: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface BotMetrics {
  hours: number
  deliveries: { total: number; sent: number; failed: number; dead: number; successRate: number }
  publishes: { total: number; sent: number; failed: number }
  events: number
  lastError: string | null
  lastErrorHint?: string | null
  lastSentAt: string | null
}

export interface BotServiceDeps {
  db: DatabaseSync
  config: Config
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  audit: (action: string, target: string | null, detail?: Record<string, unknown> | null) => void
  providers: BotCommandProviders
  /** 可选 AI 对话；未配置时普通消息 Chat 不调用 AI。 */
  ai?: BotAi
  /** 可选联网搜索；未配置或关闭时 /search 返回未启用，自动搜索跳过。 */
  search?: import('./search.ts').WebSearchClient
  fetch?: typeof fetch
  now?: () => Date
}

export interface BotStatus {
  enabled: boolean
  keyConfigured: boolean
  bots: number
  enabledBots: number
  targets: number
  queuedDeliveries: number
  queuedPublishes: number
  lastError: string | null
  /** AI 工具隔离状态；未配置 AI 时为 null。supported=false 表示 400 降级后未隔离。 */
  aiToolIsolation: BotToolIsolationStatus | null
}

export interface BotSummary {
  id: string
  platform: BotPlatform
  name: string
  enabled: boolean
  config: Record<string, unknown>
  webhookUrl: string
  setupSteps: string[]
  targetsCount: number
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
  keyVersion: number
}

export const BOT_COMMANDS = [
  'help',
  'status',
  'backup',
  'world',
  'mc',
  'files',
  'role',
  'reset',
  'forget',
  'memory',
  'search',
] as const
export type BotCommandName = (typeof BOT_COMMANDS)[number]
