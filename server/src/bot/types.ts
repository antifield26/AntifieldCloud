/**
 * Bot 平台核心类型：平台标识、加密后的凭据、公开配置、队列与命令事件。
 * 安全边界：本文件中的 `BotSecret` 只允许在服务端短生命周期使用，禁止序列化到 API/日志。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'

export const BOT_PLATFORMS = ['telegram', 'discord', 'slack', 'qq'] as const
export type BotPlatform = (typeof BOT_PLATFORMS)[number]

export function isBotPlatform(value: unknown): value is BotPlatform {
  return typeof value === 'string' && (BOT_PLATFORMS as readonly string[]).includes(value)
}

export interface BotSecret {
  /** 平台 API token（Discord Bot Token / Telegram Bot Token / Slack Bot Token）。 */
  token: string
  /** Telegram webhook secret token。 */
  webhookSecret?: string
  /** Discord application public key（hex）。 */
  publicKey?: string
  /** Slack signing secret。 */
  signingSecret?: string
  /** QQ 官方 Bot AppSecret（与 AppSecret 对应；token 字段承载）。 */
  appSecret?: string
}

export interface BotRuntimeConfig {
  /** 非敏感配置，允许在 API 返回。 */
  config: Record<string, unknown>
  secret: BotSecret
  botId: string
  platform: BotPlatform
  fetch?: typeof fetch
  now?: () => Date
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
  mediaFileIds: string[]
  scheduledAt: string | null
  status: BotPublishRow['status']
  attempts: number
  lastError: string | null
  createdAt: string
  sentAt: string | null
}

export interface OutboundMedia {
  filename: string
  mime: string
  data: Buffer
}

export interface OutboundContent {
  text: string
  /** 单次最多 5 个；QQ 适配器只接受文本。 */
  media?: OutboundMedia[]
}

/** 只读交互按钮；平台适配器负责编码，Service 只认动作 ID。 */
export type BotAction = 'refresh_status' | 'help'

export interface BotButton {
  id: BotAction
  label: string
}

export interface BotReplyOptions {
  buttons?: BotButton[]
}

export interface SendResult {
  externalId: string | null
  externalIds?: string[]
  /** 多附件部分发送失败；队列不得自动重试，避免重复外发。 */
  partial?: boolean
}

export type ChatTrigger = 'direct' | 'mention' | 'reply'

export type InboundVerification =
  | { kind: 'ignored'; ackBody?: unknown; detail?: string }
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
      /** 平台要求立即返回的响应体（如 Discord deferred / QQ opcode 12）。 */
      immediateResponse?: unknown
      /** 平台事件回调必须返回的确认体（QQ `{opcode:12}`）。 */
      ackBody?: unknown
      reply: (text: string, options?: BotReplyOptions) => Promise<void>
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
      ackBody?: unknown
      reply: (text: string, options?: BotReplyOptions) => Promise<void>
    }
  | {
      kind: 'action'
      eventId: string
      targetExternalId: string
      targetKind: BotTargetRow['kind']
      userId: string
      userName: string | null
      action: BotAction
      isDirect: boolean
      immediateResponse?: unknown
      ackBody?: unknown
      reply: (text: string, options?: BotReplyOptions) => Promise<void>
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
}

export interface BotCommandProviders {
  status(): Promise<Record<string, unknown>>
  backup(): Promise<Record<string, unknown>>
  world(): Promise<Record<string, unknown>>
  minecraft(): Promise<Record<string, unknown>>
  files(query: string): Promise<Record<string, unknown>[]>
}

export interface BotMediaStore {
  /** 返回用户文件的公开元数据；不存在/非普通文件返回 null。 */
  stat(fileId: string): { filename: string; mime: string; size: number } | null
  /** 读取发布内容；调用方必须先 stat 校验。 */
  load(fileId: string): Promise<OutboundMedia>
}

/** AI 对话提供方（v0.5.1 通过 OpenCode 本地 HTTP API）。 */
export type BotAiMode = 'task' | 'chat'

export interface BotAi {
  chat(input: {
    botId: string
    targetExternalId: string
    userId: string
    /** task=/ask 任务导向；chat=普通消息对话导向。 */
    mode: BotAiMode
    prompt: string
  }): Promise<string>
  /** 每轮对话后滚动摘要长期记忆；未实现时服务端保留旧摘要。 */
  summarizeMemory?(input: {
    botId: string
    userId: string
    memoryId: string
    sessionId: string | null
    existing: string
    userText: string
    assistantText: string
    maxChars: number
  }): Promise<{ summary: string; sessionId: string | null }>
  /** 清理过期会话映射；未实现时服务端跳过。 */
  cleanup?(): number
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

export type GatewayState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface BotGatewayStatus {
  state: GatewayState
  lastError: string | null
}

export interface BotMetrics {
  hours: number
  deliveries: { total: number; sent: number; failed: number; dead: number; successRate: number }
  publishes: { total: number; sent: number; failed: number }
  events: number
  lastError: string | null
  lastSentAt: string | null
}

export interface BotServiceDeps {
  db: DatabaseSync
  config: Config
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  audit: (action: string, target: string | null, detail?: Record<string, unknown> | null) => void
  providers: BotCommandProviders
  media: BotMediaStore
  /** 可选 AI 对话；未配置时 /ask 返回不可用提示。 */
  ai?: BotAi
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
  /** Discord Gateway 状态；非 Discord 或无 Gateway 时为 disabled。 */
  gateway: BotGatewayStatus
}

export const BOT_COMMANDS = ['help', 'status', 'backup', 'world', 'mc', 'files', 'ask', 'role'] as const
export type BotCommandName = (typeof BOT_COMMANDS)[number]
