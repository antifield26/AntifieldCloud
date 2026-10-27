/**
 * 配置加载：读取 ENV_FILE / 本机 .env / process.env，做数值校验与默认值填充。
 * 生产环境由 systemd 的 EnvironmentFile 提供；CLI 通过本模块读取同一份文件。
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute, resolve, sep } from 'node:path'

export interface Config {
  nodeEnv: 'development' | 'production' | 'test'
  logLevel: string
  host: string
  port: number
  dataDir: string
  webDistDir: string
  appOrigin: string
  aiOrigin: string
  /**
   * 过渡期清理旧父域 Cookie 的目标域（形如 `.example.com`）。
   * 只用于在登录/退出响应中删除 v0.6.0 之前按父域共享的旧 `af_session`/`af_csrf`，
   * 绝不用于设置新 Cookie；空串表示不做旧域清理。
   */
  legacyCookieDomain: string
  allowInsecureLoopback: boolean
  quotaBytes: number
  maxUploadBytes: number
  maxFilesPerRequest: number
  textPreviewBytes: number
  trashRetentionDays: number
  sessionTtlDays: number
  challengeTtlSeconds: number
  auditRetentionDays: number
  adminUsername: string
  mcHost: string
  mcPort: number
  rconHost: string
  rconPort: number
  rconPassword: string
  mcPublicAddress: string
  mcSystemdUnit: string
  opencodeUrl: string
  opencodeUsername: string
  opencodePassword: string
  /** opencode HTML 处理模式：shim=兼容垫片，attributes=只改写 cfasync，passthrough=完全透传。 */
  opencodeHtmlMode: 'shim' | 'attributes' | 'passthrough'
  backupPullFile: string
  /** 备份管理/文件级恢复功能开关；关闭时 API 仍可列出状态但拒绝导入/恢复。 */
  backupRestoreEnabled: boolean
  backupImportMaxBytes: number
  /** Web 导入归档保留天数；0=永久保留（默认 90）。 */
  backupImportRetentionDays: number
  backupRestorePlanTtlMinutes: number
  backupRestoreMaxEntries: number
  /** 备份生成（Web prepare/CLI）超时秒数；需覆盖 5 GiB 打包，默认 55 分钟。 */
  backupPrepareTimeoutSec: number
  /** 应用归档整包 age 加密开关；开启后 CLI 失败关闭，应用不持私钥。 */
  backupArchiveEncryption: boolean
  /** age 公钥文件（仅公钥；私钥离线保存，Pi 不可读）。 */
  backupAgeRecipientFile: string
  /** PC 异地副本状态文件（由 PC 脚本写入，应用只读）。 */
  backupOffsiteStatusFile: string
  chunkedUploadEnabled: boolean
  chunkSizeBytes: number
  chunkMaxFileBytes: number
  chunkSessionTtlHours: number
  chunkMaxConcurrentSessions: number
  /** 笔记附件单项/每笔记限额；附件计入总配额但不在普通文件列表展示。 */
  noteAttachmentMaxBytes: number
  noteMaxAttachments: number
  /** 每篇笔记保留的版本数（更新时自动快照）。 */
  noteVersionsKeep: number
  /** 单个分享最多包含的文件数（多文件打包分享）。 */
  shareMaxItems: number
  /** 指标历史采样与保留；关闭后不写入新样本，历史查询仍可用。 */
  metricsEnabled: boolean
  metricsSampleSeconds: number
  metricsRetentionDays: number
  /** 世界备份/拉取/演练状态文件（由 root 脚本或 PC 脚本写入，应用只读）。 */
  worldBackupStatusFile: string
  worldPullStatusFile: string
  drillStatusFile: string
  alertWorldBackupMaxAgeHours: number
  alertDrillMaxAgeDays: number
  /** 异地副本超期告警阈值（小时）；0 表示关闭该条件。 */
  alertOffsiteMaxAgeHours: number
  sharesEnabled: boolean
  shareDefaultExpiryHours: number
  shareMaxExpiryHours: number
  shareMaxDownloads: number
  alertsEnabled: boolean
  alertWebhookUrl: string
  alertWebhookType: string
  alertWebhookSecret: string
  alertDiskFreePct: number
  alertTempC: number
  alertBackupMaxAgeHours: number
  alertCooldownMinutes: number
  /** 持续 firing 的重通知间隔（小时）；0=不重通知。新键优先，旧 ALERT_COOLDOWN_MINUTES 兼容推导。 */
  alertRepeatHours: number
  alertCheckIntervalSeconds: number
  piHealthFile: string
  appVersion: string
  /** Chatbot 平台总开关；关闭后所有 Chatbot API/队列/入站均不可用。 */
  chatbotEnabled: boolean
  /** 32 字节 base64 AES-256-GCM 密钥；为空时 Chatbot 功能降级禁用。 */
  chatbotSecretKey: string
  /** 入站 Webhook 原始请求体上限。 */
  chatbotWebhookMaxBodyBytes: number
  /** 出站队列扫描间隔（秒）。 */
  chatbotDeliveryIntervalSeconds: number
  /** 单条投递最大尝试次数。 */
  chatbotDeliveryMaxAttempts: number
  /** 入站事件去重/投递记录保留天数。 */
  chatbotEventRetentionDays: number
  /** 每个用户/目标每分钟命令上限。 */
  chatbotCommandRatePerMinute: number
  /** 定时发布最长提前天数。 */
  chatbotPublishMaxScheduledDays: number
  /** 最多配置的 Chatbot 数。 */
  chatbotMaxBots: number
  /** AI 对话（v0.5.1，通过 OpenCode 本地 HTTP API）；默认关闭。 */
  chatbotAiEnabled: boolean
  /** 可选模型 provider/model；为空使用 OpenCode 默认模型。 */
  chatbotAiProvider: string
  chatbotAiModel: string
  chatbotAiTimeoutSeconds: number
  chatbotAiMaxPromptChars: number
  chatbotAiRatePerHour: number
  chatbotAiSessionRetentionDays: number
  /** v0.5.2 Chat/记忆/多附件/Gateway。 */
  chatbotChatRatePerMinute: number
  chatbotAiMemoryMaxChars: number
  /** 长期记忆自动清理周期（天）；与 7 天的会话映射保留期独立。 */
  chatbotAiMemoryRetentionDays: number
  /** 累计多少条 Chat 后合并触发一次记忆摘要。 */
  chatbotAiMemoryBatchMessages: number
  /** 用户空闲多少秒后合并触发记忆摘要；0 表示关闭空闲触发、只按条数触发。 */
  chatbotAiMemoryIdleFlushSeconds: number
  /** 结构化记忆：每用户最多条目数（超出按过期/重要度清理）。 */
  chatbotMemoryMaxItems: number
  /** 注入提示词的记忆字符预算与条数上限。 */
  chatbotMemoryPromptMaxChars: number
  chatbotMemoryPromptMaxItems: number
  /** episode/task 的默认存活天数；fact/project 复用 CHATBOT_AI_MEMORY_RETENTION_DAYS。 */
  chatbotMemoryTtlEpisodeDays: number
  chatbotMemoryTtlTaskDays: number

  /** AI 回答最大字符数；QQ 适配器会按平台上限分段发送。 */
  chatbotAiMaxReplyChars: number
  /** 图片理解总开关（OpenCode prompt files + 多模态模型）；默认开启。 */
  chatbotAiVisionEnabled: boolean
  /** 单张入站图片大小上限（字节）。 */
  chatbotAiImageMaxBytes: number
  /** v0.6.1：同一会话连续消息合并窗口（毫秒）；0 关闭合并但仍串行。 */
  chatbotChatBurstWindowMs: number
  /** 从首条消息起最长等待（毫秒），避免持续输入导致不回复。 */
  chatbotChatBurstMaxWaitMs: number
  /** 单批最大消息数；达到后立即触发。 */
  chatbotChatBurstMaxMessages: number
  /** v0.6.4：群聊目标设为全量消息时，非 @ 消息使用更长的合并窗口。 */
  chatbotChatBurstGroupAllWindowMs: number
  /** v0.6.4：全量群聊合并从首条起的最长等待。 */
  chatbotChatBurstGroupAllMaxWaitMs: number
  /** v0.6.4：是否允许模型调用 send_message 工具发送消息（需安装 botmsg MCP）。 */
  chatbotAiSendToolEnabled: boolean
  /**
   * v0.7.3：Chat 上下文文档 + read 工具开关。
   * 开启后角色卡/记忆落盘为只读文档，模型按需 read；默认关闭，OpenCode 读范围验证通过后启用。
   */
  chatbotAiContextReadEnabled: boolean
  /** v0.7.3：上下文文档根目录；生产必须显式配置为 OpenCode 组可读的独立目录。 */
  chatbotContextDir: string
  /** v0.6.1：SearXNG 联网搜索总开关；开启时必须配置 CHATBOT_SEARCH_URL。 */
  chatbotSearchEnabled: boolean
  /** SearXNG 基址（生产建议 loopback 私有实例），仅 http/https。 */
  chatbotSearchUrl: string
  /** 自动判断并搜索（显式 /search 不受此开关影响）。 */
  chatbotSearchAuto: boolean
  /** 搜索触发模式：mcp=模型通过 SearXNG MCP 工具自行决定；prefetch=服务端关键词预取。 */
  chatbotSearchMode: 'mcp' | 'prefetch'
  chatbotSearchMaxResults: number
  chatbotSearchTimeoutSeconds: number
  chatbotSearchMaxSnippetChars: number
  chatbotSearchLanguage: string
  chatbotSearchSafeSearch: boolean
  /** 逗号分隔的 SearXNG 引擎名；默认 bing（网络受限环境避免无谓 timeout）。 */
  chatbotSearchEngines: string
  /** 每 Chatbot×用户每小时搜索次数上限。 */
  chatbotSearchRatePerHour: number
  /** v0.5.3 出站连通性探测与自动恢复；默认开启。 */
  chatbotConnectivityEnabled: boolean
  chatbotConnectivityIntervalSeconds: number
  chatbotConnectivityTimeoutSeconds: number
  /**
   * v0.8.0 mcbot Minecraft Chatbot（独立附属服务，仅 loopback HTTP）对接。
   * 读/控制 Token 分离：控制 Token 为空表示只读，任务/移动接口返回 503。
   */
  mcbotEnabled: boolean
  mcbotUrl: string
  mcbotReadToken: string
  mcbotControlToken: string
  /** 单次上游请求超时（毫秒）。 */
  mcbotTimeoutMs: number
  /** 状态/事件轮询间隔（毫秒）。 */
  mcbotPollMs: number
  /** 是否把 mcbot 上游告警写入本应用告警事件（关闭后仍推进游标）。 */
  mcbotAlertsEnabled: boolean
}

const DEFAULT_ENV_FILE = '/etc/antifieldcloud/env'

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** 解析 KEY=VALUE 形式的 env 文件；忽略空行与 # 注释。 */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  const text = readFileSync(path, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = stripQuotes(value)
  }
  return out
}

function loadEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const base: Record<string, string> = {}
  const explicit = env.ENV_FILE
  const file = explicit && existsSync(explicit) ? explicit : existsSync(DEFAULT_ENV_FILE) ? DEFAULT_ENV_FILE : null
  if (file) Object.assign(base, parseEnvFile(file))
  const local = resolve(process.cwd(), '.env')
  if (!file && existsSync(local)) Object.assign(base, parseEnvFile(local))
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) base[key] = value
  }
  return base
}

function str(env: Record<string, string>, key: string, fallback: string): string {
  const value = env[key]
  return value === undefined || value === '' ? fallback : value
}

function int(env: Record<string, string>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`配置项 ${key} 非法：${raw}（要求 ${min}..${max} 的整数）`)
  }
  return value
}

function bool(env: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false
  throw new Error(`配置项 ${key} 非法布尔值：${raw}`)
}

function parseOpenCodeHtmlMode(env: Record<string, string>): 'shim' | 'attributes' | 'passthrough' {
  const raw = (env.OPENCODE_HTML_MODE ?? 'shim').trim().toLowerCase()
  if (raw === 'shim' || raw === 'attributes' || raw === 'passthrough') return raw
  throw new Error(`配置项 OPENCODE_HTML_MODE 非法：${raw}（允许 shim/attributes/passthrough）`)
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged = loadEnv(env)
  const nodeEnvRaw = str(merged, 'NODE_ENV', 'development')
  if (nodeEnvRaw !== 'production' && nodeEnvRaw !== 'test' && nodeEnvRaw !== 'development') {
    throw new Error(`NODE_ENV 非法：${nodeEnvRaw}（允许 production/test/development）`)
  }
  const nodeEnv = nodeEnvRaw as 'production' | 'test' | 'development'
  const dataDir = resolve(str(merged, 'DATA_DIR', resolve(process.cwd(), 'data')))
  const webDistDir = resolve(str(merged, 'WEB_DIST_DIR', resolve(process.cwd(), 'web', 'dist')))
  // 默认放在 DATA_DIR 下仅用于本地开发；生产由部署创建独立目录并显式配置（OpenCode 需可读）。
  const rawBotContextDir = (merged.CHATBOT_CONTEXT_DIR ?? '').trim()
  const chatbotContextDir = resolve(rawBotContextDir || resolve(dataDir, 'chatbot-context'))
  const appOrigin = str(merged, 'APP_ORIGIN', 'https://app.example.com')
  const aiOrigin = str(merged, 'AI_ORIGIN', 'https://ai.example.com')
  const config: Config = {
    nodeEnv,
    logLevel: str(merged, 'LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
    host: str(merged, 'HOST', '127.0.0.1'),
    port: int(merged, 'PORT', 3000, 1, 65535),
    dataDir,
    webDistDir,
    appOrigin,
    aiOrigin,
    legacyCookieDomain: resolveLegacyCookieDomain(merged, appOrigin),
    allowInsecureLoopback: bool(merged, 'ALLOW_INSECURE_LOOPBACK', true),
    quotaBytes: int(merged, 'QUOTA_BYTES', 10 * GIB, 64 * MIB, 1024 * GIB),
    maxUploadBytes: int(merged, 'MAX_UPLOAD_BYTES', 100 * MIB, 1 * MIB, 1024 * GIB),
    maxFilesPerRequest: int(merged, 'MAX_FILES_PER_REQUEST', 20, 1, 100),
    textPreviewBytes: int(merged, 'TEXT_PREVIEW_BYTES', 1 * MIB, 4 * 1024, 16 * MIB),
    trashRetentionDays: int(merged, 'TRASH_RETENTION_DAYS', 30, 1, 365),
    sessionTtlDays: int(merged, 'SESSION_TTL_DAYS', 7, 1, 90),
    challengeTtlSeconds: int(merged, 'CHALLENGE_TTL_SECONDS', 300, 60, 3600),
    auditRetentionDays: int(merged, 'AUDIT_RETENTION_DAYS', 90, 1, 3650),
    adminUsername: str(merged, 'ADMIN_USERNAME', 'antifield'),
    mcHost: str(merged, 'MC_HOST', '127.0.0.1'),
    mcPort: int(merged, 'MC_PORT', 25565, 1, 65535),
    rconHost: str(merged, 'RCON_HOST', '127.0.0.1'),
    rconPort: int(merged, 'RCON_PORT', 25575, 1, 65535),
    rconPassword: str(merged, 'RCON_PASSWORD', ''),
    mcPublicAddress: str(merged, 'MC_PUBLIC_ADDRESS', 'mc.example.com:11798'),
    mcSystemdUnit: str(merged, 'MC_SYSTEMD_UNIT', 'minecraft'),
    opencodeUrl: str(merged, 'OPENCODE_URL', 'http://127.0.0.1:4096').replace(/\/+$/, ''),
    opencodeUsername: str(merged, 'OPENCODE_USERNAME', 'opencode'),
    opencodePassword: str(merged, 'OPENCODE_PASSWORD', ''),
    opencodeHtmlMode: parseOpenCodeHtmlMode(merged),
    backupPullFile: str(merged, 'BACKUP_PULL_FILE', resolve(dataDir, 'backup-pull.json')),
    backupRestoreEnabled: bool(merged, 'BACKUP_RESTORE_ENABLED', false),
    backupImportMaxBytes: int(merged, 'BACKUP_IMPORT_MAX_BYTES', 100 * MIB, 1 * MIB, 1024 * GIB),
    backupImportRetentionDays: int(merged, 'BACKUP_IMPORT_RETENTION_DAYS', 90, 0, 3650),
    backupRestorePlanTtlMinutes: int(merged, 'BACKUP_RESTORE_PLAN_TTL_MINUTES', 30, 5, 1440),
    backupRestoreMaxEntries: int(merged, 'BACKUP_RESTORE_MAX_ENTRIES', 5000, 1, 100_000),
    backupPrepareTimeoutSec: int(merged, 'BACKUP_PREPARE_TIMEOUT_SEC', 3300, 60, 7200),
    backupArchiveEncryption: bool(merged, 'BACKUP_ARCHIVE_ENCRYPTION', false),
    backupAgeRecipientFile: str(merged, 'BACKUP_AGE_RECIPIENT_FILE', '/etc/antifieldcloud/backup-age.pub'),
    backupOffsiteStatusFile: str(
      merged,
      'BACKUP_OFFSITE_STATUS_FILE',
      resolve(dataDir, 'backup-offsite-status.json'),
    ),
    chunkedUploadEnabled: bool(merged, 'CHUNKED_UPLOAD_ENABLED', true),
    chunkSizeBytes: int(merged, 'CHUNK_SIZE_BYTES', 8 * MIB, 1 * MIB, 100 * MIB),
    chunkMaxFileBytes: int(merged, 'CHUNK_MAX_FILE_BYTES', 5 * GIB, 1 * MIB, 10 * GIB),
    chunkSessionTtlHours: int(merged, 'CHUNK_SESSION_TTL_HOURS', 24, 1, 168),
    chunkMaxConcurrentSessions: int(merged, 'CHUNK_MAX_CONCURRENT_SESSIONS', 3, 1, 20),
    noteAttachmentMaxBytes: int(merged, 'NOTE_ATTACHMENT_MAX_BYTES', 25 * MIB, 1 * MIB, 100 * MIB),
    noteMaxAttachments: int(merged, 'NOTE_MAX_ATTACHMENTS', 100, 1, 1000),
    noteVersionsKeep: int(merged, 'NOTE_VERSIONS_KEEP', 20, 1, 100),
    shareMaxItems: int(merged, 'SHARE_MAX_ITEMS', 50, 1, 200),
    metricsEnabled: bool(merged, 'METRICS_ENABLED', true),
    metricsSampleSeconds: int(merged, 'METRICS_SAMPLE_SECONDS', 60, 10, 3600),
    metricsRetentionDays: int(merged, 'METRICS_RETENTION_DAYS', 30, 1, 365),
    worldBackupStatusFile: str(merged, 'WORLD_BACKUP_STATUS_FILE', resolve(dataDir, 'world-backup-status.json')),
    worldPullStatusFile: str(merged, 'WORLD_PULL_STATUS_FILE', resolve(dataDir, 'world-pull-status.json')),
    drillStatusFile: str(merged, 'DRILL_STATUS_FILE', resolve(dataDir, 'drill-status.json')),
    alertWorldBackupMaxAgeHours: int(merged, 'ALERT_WORLD_BACKUP_MAX_AGE_HOURS', 192, 6, 8760),
    alertDrillMaxAgeDays: int(merged, 'ALERT_DRILL_MAX_AGE_DAYS', 35, 1, 365),
    alertOffsiteMaxAgeHours: int(merged, 'ALERT_OFFSITE_MAX_AGE_HOURS', 48, 0, 8760),
    sharesEnabled: bool(merged, 'SHARES_ENABLED', true),
    shareDefaultExpiryHours: int(merged, 'SHARE_DEFAULT_EXPIRY_HOURS', 168, 1, 720),
    shareMaxExpiryHours: int(merged, 'SHARE_MAX_EXPIRY_HOURS', 720, 1, 8760),
    shareMaxDownloads: int(merged, 'SHARE_MAX_DOWNLOADS', 10_000, 1, 1_000_000),
    alertsEnabled: bool(merged, 'ALERTS_ENABLED', true),
    alertWebhookUrl: str(merged, 'ALERT_WEBHOOK_URL', ''),
    alertWebhookType: str(merged, 'ALERT_WEBHOOK_TYPE', 'generic'),
    alertWebhookSecret: str(merged, 'ALERT_WEBHOOK_SECRET', ''),
    alertDiskFreePct: int(merged, 'ALERT_DISK_FREE_PCT', 15, 1, 90),
    alertTempC: int(merged, 'ALERT_TEMP_C', 80, 40, 110),
    alertBackupMaxAgeHours: int(merged, 'ALERT_BACKUP_MAX_AGE_HOURS', 48, 6, 720),
    alertCooldownMinutes: int(merged, 'ALERT_COOLDOWN_MINUTES', 360, 5, 1440),
    alertRepeatHours:
      'ALERT_REPEAT_HOURS' in merged
        ? int(merged, 'ALERT_REPEAT_HOURS', 24, 0, 168)
        : Math.max(0, int(merged, 'ALERT_COOLDOWN_MINUTES', 360, 5, 1440) / 60),
    alertCheckIntervalSeconds: int(merged, 'ALERT_CHECK_INTERVAL_SECONDS', 300, 60, 3600),
    piHealthFile: str(merged, 'PI_HEALTH_FILE', '/run/antifieldcloud/pi-health.json'),
    appVersion: str(merged, 'APP_VERSION', '0.0.0-dev'),
    chatbotEnabled: bool(merged, 'CHATBOT_ENABLED', false),
    chatbotSecretKey: str(merged, 'CHATBOT_SECRET_KEY', ''),
    chatbotWebhookMaxBodyBytes: int(merged, 'CHATBOT_WEBHOOK_MAX_BODY_BYTES', 256 * 1024, 16 * 1024, 1024 * 1024),
    chatbotDeliveryIntervalSeconds: int(merged, 'CHATBOT_DELIVERY_INTERVAL_SECONDS', 30, 5, 300),
    chatbotDeliveryMaxAttempts: int(merged, 'CHATBOT_DELIVERY_MAX_ATTEMPTS', 5, 1, 20),
    chatbotEventRetentionDays: int(merged, 'CHATBOT_EVENT_RETENTION_DAYS', 7, 1, 90),
    chatbotCommandRatePerMinute: int(merged, 'CHATBOT_COMMAND_RATE_PER_MINUTE', 120, 1, 600),
    chatbotPublishMaxScheduledDays: int(merged, 'CHATBOT_PUBLISH_MAX_SCHEDULED_DAYS', 30, 1, 365),
    chatbotMaxBots: int(merged, 'CHATBOT_MAX_BOTS', 10, 1, 50),
    chatbotAiEnabled: bool(merged, 'CHATBOT_AI_ENABLED', false),
    chatbotAiProvider: str(merged, 'CHATBOT_AI_PROVIDER', ''),
    chatbotAiModel: str(merged, 'CHATBOT_AI_MODEL', ''),
    chatbotAiTimeoutSeconds: int(merged, 'CHATBOT_AI_TIMEOUT_SECONDS', 60, 10, 180),
    chatbotAiMaxPromptChars: int(merged, 'CHATBOT_AI_MAX_PROMPT_CHARS', 2000, 100, 8000),
    chatbotAiRatePerHour: int(merged, 'CHATBOT_AI_RATE_PER_HOUR', 120, 1, 600),
    chatbotAiSessionRetentionDays: int(merged, 'CHATBOT_AI_SESSION_RETENTION_DAYS', 7, 1, 90),
    chatbotChatRatePerMinute: int(merged, 'CHATBOT_CHAT_RATE_PER_MINUTE', 30, 1, 120),
    chatbotAiMemoryMaxChars: int(merged, 'CHATBOT_AI_MEMORY_MAX_CHARS', 4096, 512, 16384),
    chatbotAiMemoryRetentionDays: int(merged, 'CHATBOT_AI_MEMORY_RETENTION_DAYS', 365, 30, 3650),
    chatbotAiMemoryBatchMessages: int(merged, 'CHATBOT_AI_MEMORY_BATCH_MESSAGES', 3, 1, 20),
    chatbotAiMemoryIdleFlushSeconds: int(merged, 'CHATBOT_AI_MEMORY_IDLE_FLUSH_SECONDS', 120, 0, 3600),
    chatbotMemoryMaxItems: int(merged, 'CHATBOT_MEMORY_MAX_ITEMS', 200, 20, 1000),
    chatbotMemoryPromptMaxChars: int(merged, 'CHATBOT_MEMORY_PROMPT_MAX_CHARS', 3000, 500, 8000),
    chatbotMemoryPromptMaxItems: int(merged, 'CHATBOT_MEMORY_PROMPT_MAX_ITEMS', 12, 1, 50),
    chatbotMemoryTtlEpisodeDays: int(merged, 'CHATBOT_MEMORY_TTL_EPISODE_DAYS', 90, 1, 365),
    chatbotMemoryTtlTaskDays: int(merged, 'CHATBOT_MEMORY_TTL_TASK_DAYS', 30, 1, 180),
    chatbotAiMaxReplyChars: int(merged, 'CHATBOT_AI_MAX_REPLY_CHARS', 4000, 1000, 12000),
    chatbotAiVisionEnabled: bool(merged, 'CHATBOT_AI_VISION_ENABLED', true),
    chatbotAiImageMaxBytes: int(merged, 'CHATBOT_AI_IMAGE_MAX_BYTES', 10 * MIB, 1 * MIB, 20 * MIB),
    chatbotChatBurstWindowMs: int(merged, 'CHATBOT_CHAT_BURST_WINDOW_MS', 3000, 0, 8000),
    chatbotChatBurstMaxWaitMs: int(merged, 'CHATBOT_CHAT_BURST_MAX_WAIT_MS', 10000, 1000, 20000),
    chatbotChatBurstMaxMessages: int(merged, 'CHATBOT_CHAT_BURST_MAX_MESSAGES', 10, 1, 20),
    chatbotChatBurstGroupAllWindowMs: int(merged, 'CHATBOT_CHAT_BURST_GROUP_ALL_WINDOW_MS', 8000, 0, 30000),
    chatbotChatBurstGroupAllMaxWaitMs: int(merged, 'CHATBOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS', 20000, 1000, 60000),
    chatbotAiSendToolEnabled: bool(merged, 'CHATBOT_AI_SEND_TOOL_ENABLED', false),
    chatbotAiContextReadEnabled: bool(merged, 'CHATBOT_AI_CONTEXT_READ_ENABLED', false),
    chatbotContextDir,
    chatbotSearchEnabled: bool(merged, 'CHATBOT_SEARCH_ENABLED', false),
    chatbotSearchUrl: str(merged, 'CHATBOT_SEARCH_URL', ''),
    chatbotSearchAuto: bool(merged, 'CHATBOT_SEARCH_AUTO', true),
    chatbotSearchMode: parseBotSearchMode(merged),
    chatbotSearchMaxResults: int(merged, 'CHATBOT_SEARCH_MAX_RESULTS', 5, 1, 10),
    chatbotSearchTimeoutSeconds: int(merged, 'CHATBOT_SEARCH_TIMEOUT_SECONDS', 8, 1, 30),
    chatbotSearchMaxSnippetChars: int(merged, 'CHATBOT_SEARCH_MAX_SNIPPET_CHARS', 500, 100, 1500),
    chatbotSearchLanguage: str(merged, 'CHATBOT_SEARCH_LANGUAGE', 'zh-CN'),
    chatbotSearchSafeSearch: bool(merged, 'CHATBOT_SEARCH_SAFESEARCH', true),
    chatbotSearchEngines: str(merged, 'CHATBOT_SEARCH_ENGINES', 'bing'),
    chatbotSearchRatePerHour: int(merged, 'CHATBOT_SEARCH_RATE_PER_HOUR', 60, 1, 600),
    chatbotConnectivityEnabled: bool(merged, 'CHATBOT_CONNECTIVITY_ENABLED', true),
    chatbotConnectivityIntervalSeconds: int(merged, 'CHATBOT_CONNECTIVITY_INTERVAL_SECONDS', 60, 15, 600),
    chatbotConnectivityTimeoutSeconds: int(merged, 'CHATBOT_CONNECTIVITY_TIMEOUT_SECONDS', 8, 2, 30),
    mcbotEnabled: bool(merged, 'MCBOT_ENABLED', false),
    mcbotUrl: str(merged, 'MCBOT_URL', 'http://127.0.0.1:3010').replace(/\/+$/, ''),
    mcbotReadToken: str(merged, 'MCBOT_READ_TOKEN', ''),
    mcbotControlToken: str(merged, 'MCBOT_CONTROL_TOKEN', ''),
    mcbotTimeoutMs: int(merged, 'MCBOT_TIMEOUT_MS', 2500, 500, 10_000),
    mcbotPollMs: int(merged, 'MCBOT_POLL_MS', 5000, 2000, 60_000),
    mcbotAlertsEnabled: bool(merged, 'MCBOT_ALERTS_ENABLED', true),
  }
  if (config.maxUploadBytes > config.quotaBytes) {
    throw new Error('MAX_UPLOAD_BYTES 不能大于 QUOTA_BYTES')
  }
  if (config.shareDefaultExpiryHours > config.shareMaxExpiryHours) {
    throw new Error('SHARE_DEFAULT_EXPIRY_HOURS 不能大于 SHARE_MAX_EXPIRY_HOURS')
  }
  if (config.alertWebhookType !== 'generic') {
    throw new Error('ALERT_WEBHOOK_TYPE 目前只支持 generic')
  }
  if (config.chatbotSearchEnabled) {
    if (!config.chatbotSearchUrl) throw new Error('CHATBOT_SEARCH_ENABLED=true 时必须配置 CHATBOT_SEARCH_URL')
    validateHttpUrl(config.chatbotSearchUrl, 'CHATBOT_SEARCH_URL')
  }
  if (config.chatbotAiContextReadEnabled) {
    const rawContextDir = (merged.CHATBOT_CONTEXT_DIR ?? '').trim()
    if (rawContextDir && !isAbsolute(rawContextDir)) {
      throw new Error('CHATBOT_CONTEXT_DIR 必须是绝对路径')
    }
    if (/[*?]/.test(rawContextDir || config.chatbotContextDir)) {
      throw new Error('CHATBOT_CONTEXT_DIR 不能包含 * 或 ?（会被 OpenCode 当作权限通配符）')
    }
    if (config.chatbotContextDir === resolve('/')) {
      throw new Error('CHATBOT_CONTEXT_DIR 不能是文件系统根目录')
    }
    if (config.nodeEnv === 'production') {
      if (!rawContextDir) {
        throw new Error('CHATBOT_AI_CONTEXT_READ_ENABLED=true 时生产必须显式设置 CHATBOT_CONTEXT_DIR')
      }
      // OpenCode 以独立用户运行；DATA_DIR 为 0750，放在其内部会导致 OpenCode 无法穿越。
      if (config.chatbotContextDir === config.dataDir || config.chatbotContextDir.startsWith(config.dataDir + sep)) {
        throw new Error('CHATBOT_CONTEXT_DIR 不能位于 DATA_DIR 内（OpenCode 无法穿越 0750 父目录）')
      }
    }
  }
  if (config.chatbotChatBurstWindowMs > config.chatbotChatBurstMaxWaitMs) {
    throw new Error('CHATBOT_CHAT_BURST_WINDOW_MS 不能大于 CHATBOT_CHAT_BURST_MAX_WAIT_MS')
  }
  if (config.chatbotChatBurstGroupAllWindowMs > config.chatbotChatBurstGroupAllMaxWaitMs) {
    throw new Error('CHATBOT_CHAT_BURST_GROUP_ALL_WINDOW_MS 不能大于 CHATBOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS')
  }
  validateOrigin(config.appOrigin, 'APP_ORIGIN')
  validateOrigin(config.aiOrigin, 'AI_ORIGIN')
  if (config.appOrigin === config.aiOrigin) {
    throw new Error('APP_ORIGIN 与 AI_ORIGIN 不能相同（Host 分流会冲突）')
  }
  // 代理只允许固定 loopback 上游；非 loopback 会把应用会话/密码暴露给外部主机（配置错误即拒绝启动）。
  validateLoopbackUrl(config.opencodeUrl, 'OPENCODE_URL')
  // mcbot 上游同样只允许 loopback：读/控制 Token 不得发往外部主机；仅在启用时校验，
  // 关闭状态下允许保留空 Token/默认地址，便于随时开关。
  if (config.mcbotEnabled) {
    validateLoopbackUrl(config.mcbotUrl, 'MCBOT_URL')
    // 基地址只允许根路径：userinfo/query/hash/子路径都可能让 Token 发往意外端点。
    const mcbotUrl = new URL(config.mcbotUrl)
    if (mcbotUrl.username || mcbotUrl.password) {
      throw new Error('MCBOT_URL 不允许包含用户名/密码')
    }
    if ((mcbotUrl.pathname !== '' && mcbotUrl.pathname !== '/') || mcbotUrl.search || mcbotUrl.hash) {
      throw new Error('MCBOT_URL 只允许 scheme://host[:port]，不允许路径/查询/片段')
    }
    if (!config.mcbotReadToken) {
      throw new Error('MCBOT_ENABLED=true 时必须配置 MCBOT_READ_TOKEN')
    }
  }
  if (config.alertWebhookUrl) validateHttpUrl(config.alertWebhookUrl, 'ALERT_WEBHOOK_URL')
  if (config.chatbotSecretKey) {
    let key: Buffer
    try {
      key = Buffer.from(config.chatbotSecretKey, 'base64')
    } catch {
      throw new Error('CHATBOT_SECRET_KEY 必须是 base64 编码的 32 字节密钥')
    }
    if (key.length !== 32) throw new Error('CHATBOT_SECRET_KEY 必须是 base64 编码的 32 字节密钥')
  }
  if (config.nodeEnv === 'production' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new Error('生产环境 HOST 必须是 loopback（应用只允许本地反代访问）')
  }
  return config
}

/** 搜索触发模式：非法值直接拒绝，避免拼写错误被静默当成 mcp。 */
function parseBotSearchMode(env: Record<string, string>): 'mcp' | 'prefetch' {
  const raw = (env.CHATBOT_SEARCH_MODE ?? 'mcp').trim().toLowerCase()
  if (raw !== 'mcp' && raw !== 'prefetch') {
    throw new Error(`配置项 CHATBOT_SEARCH_MODE 非法：${raw}（允许 mcp/prefetch）`)
  }
  return raw
}

/** OpenCode 上游必须是 loopback：代理会注入 Basic 凭据，不能指向外部主机。 */
export function validateLoopbackUrl(value: string, key: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} 不是合法 URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${key} 必须是 http(s) URL`)
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]']
  if (!loopback.includes(url.hostname.toLowerCase())) {
    throw new Error(`${key} 必须指向 loopback（当前 ${url.hostname}）`)
  }
}

function validateOrigin(value: string, key: string): void {
  if (!value.startsWith('https://') || value.endsWith('/')) {
    throw new Error(`${key} 必须是无尾斜杠的 https:// origin`)
  }
  try {
    const url = new URL(value)
    if (!url.hostname) throw new Error('missing host')
  } catch {
    throw new Error(`${key} 不是合法 URL`)
  }
}

function validateHttpUrl(value: string, key: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
  } catch {
    throw new Error(`${key} 必须是 http(s) URL`)
  }
}

/** 旧父域 Cookie 清理域允许的形状：以点开头、至少两个 label、不含空 label。 */
const LEGACY_COOKIE_DOMAIN_PATTERN = /^\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

/**
 * 解析过渡期旧父域 Cookie 的清理域（仅删除旧 Cookie，不用于设置新 Cookie）。
 *
 * - 优先使用 env `COOKIE_DOMAIN`（v0.6.0 起语义变为 deprecated-only-cleanup）；显式配置非法时
 *   拒绝启动，避免静默不清理。
 * - 未配置时从 APP_ORIGIN 主机名推导最后两级（如 app.example.com → .example.com）；仅当
 *   主机名 ≥3 个 label 且不是 IP 时推导，否则返回空串（不做清理）。
 * - 多级子域/公共后缀（如 app.foo.co.uk → .co.uk）的推导可能无效，但浏览器会拒绝公共后缀
 *   Domain，不会误删；生产建议保留显式 `COOKIE_DOMAIN` 以精确清理。
 */
export function resolveLegacyCookieDomain(env: Record<string, string>, appOrigin: string): string {
  const configured = (env.COOKIE_DOMAIN ?? '').trim().toLowerCase()
  if (configured) {
    if (!LEGACY_COOKIE_DOMAIN_PATTERN.test(configured)) {
      throw new Error('COOKIE_DOMAIN 非法（须形如 .example.com；v0.6.0 起仅用于清理旧父域 Cookie）')
    }
    return configured
  }
  try {
    const hostname = new URL(appOrigin).hostname.toLowerCase()
    if (isIP(hostname) !== 0) return ''
    const labels = hostname.split('.')
    if (labels.length < 3) return ''
    return `.${labels.slice(-2).join('.')}`
  } catch {
    return ''
  }
}

/** 应用启动时确保数据目录存在且可写；上下文目录只在启用文档模式时校验。 */
export function ensureRuntimeDirs(config: Config): void {
  const dirs = [config.dataDir, resolve(config.dataDir, 'files'), resolve(config.dataDir, 'tmp'), resolve(config.dataDir, 'backups')]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  if (!config.chatbotAiContextReadEnabled) return
  if (existsSync(config.chatbotContextDir)) {
    try {
      accessSync(config.chatbotContextDir, constants.W_OK | constants.X_OK)
    } catch {
      throw new Error(`CHATBOT_CONTEXT_DIR 不可写/不可进入：${config.chatbotContextDir}（检查属主与权限）`)
    }
    return
  }
  if (config.nodeEnv === 'production') {
    throw new Error(
      `CHATBOT_CONTEXT_DIR 不存在：${config.chatbotContextDir}（部署时创建：install -d -o antifieldcloud -g opencode -m 2750 <dir>）`,
    )
  }
  mkdirSync(config.chatbotContextDir, { recursive: true, mode: 0o750 })
}
