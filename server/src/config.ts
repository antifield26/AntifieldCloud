/**
 * 配置加载：读取 ENV_FILE / 本机 .env / process.env，做数值校验与默认值填充。
 * 生产环境由 systemd 的 EnvironmentFile 提供；CLI 通过本模块读取同一份文件。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Config {
  nodeEnv: 'development' | 'production' | 'test'
  logLevel: string
  host: string
  port: number
  dataDir: string
  webDistDir: string
  appOrigin: string
  aiOrigin: string
  cookieDomain: string
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
  backupRestorePlanTtlMinutes: number
  backupRestoreMaxEntries: number
  /** 备份生成（Web prepare/CLI）超时秒数；需覆盖 5 GiB 打包，默认 55 分钟。 */
  backupPrepareTimeoutSec: number
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
  alertCheckIntervalSeconds: number
  piHealthFile: string
  appVersion: string
  /** Bot 平台总开关；关闭后所有 Bot API/队列/入站均不可用。 */
  botEnabled: boolean
  /** 32 字节 base64 AES-256-GCM 密钥；为空时 Bot 功能降级禁用。 */
  botSecretKey: string
  /** 入站 Webhook 原始请求体上限。 */
  botWebhookMaxBodyBytes: number
  /** 出站队列扫描间隔（秒）。 */
  botDeliveryIntervalSeconds: number
  /** 单条投递最大尝试次数。 */
  botDeliveryMaxAttempts: number
  /** 入站事件去重/投递记录保留天数。 */
  botEventRetentionDays: number
  /** 每个用户/目标每分钟命令上限。 */
  botCommandRatePerMinute: number
  /** 发布媒体单文件上限。 */
  botPublishMaxMediaBytes: number
  /** 定时发布最长提前天数。 */
  botPublishMaxScheduledDays: number
  /** 最多配置的 Bot 数。 */
  botMaxBots: number
  /** AI 对话（v0.5.1，通过 OpenCode 本地 HTTP API）；默认关闭。 */
  botAiEnabled: boolean
  /** 可选模型 provider/model；为空使用 OpenCode 默认模型。 */
  botAiProvider: string
  botAiModel: string
  botAiTimeoutSeconds: number
  botAiMaxPromptChars: number
  botAiRatePerHour: number
  botAiSessionRetentionDays: number
  /** v0.5.2 Chat/记忆/多附件/Gateway。 */
  botChatRatePerMinute: number
  botAiMemoryMaxChars: number
  botAiSystemPrompt: string
  botDiscordGatewayEnabled: boolean
  botPublishMaxMediaFiles: number
  botPublishMaxMediaTotalBytes: number
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
  const nodeEnv = nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development'
  const dataDir = resolve(str(merged, 'DATA_DIR', resolve(process.cwd(), 'data')))
  const webDistDir = resolve(str(merged, 'WEB_DIST_DIR', resolve(process.cwd(), 'web', 'dist')))
  const config: Config = {
    nodeEnv,
    logLevel: str(merged, 'LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
    host: str(merged, 'HOST', '127.0.0.1'),
    port: int(merged, 'PORT', 3000, 1, 65535),
    dataDir,
    webDistDir,
    appOrigin: str(merged, 'APP_ORIGIN', 'https://app.example.com'),
    aiOrigin: str(merged, 'AI_ORIGIN', 'https://ai.example.com'),
    cookieDomain: str(merged, 'COOKIE_DOMAIN', '.example.com'),
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
    backupRestorePlanTtlMinutes: int(merged, 'BACKUP_RESTORE_PLAN_TTL_MINUTES', 30, 5, 1440),
    backupRestoreMaxEntries: int(merged, 'BACKUP_RESTORE_MAX_ENTRIES', 5000, 1, 100_000),
    backupPrepareTimeoutSec: int(merged, 'BACKUP_PREPARE_TIMEOUT_SEC', 3300, 60, 7200),
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
    alertCheckIntervalSeconds: int(merged, 'ALERT_CHECK_INTERVAL_SECONDS', 300, 60, 3600),
    piHealthFile: str(merged, 'PI_HEALTH_FILE', '/run/antifieldcloud/pi-health.json'),
    appVersion: str(merged, 'APP_VERSION', '0.5.2'),
    botEnabled: bool(merged, 'BOT_ENABLED', false),
    botSecretKey: str(merged, 'BOT_SECRET_KEY', ''),
    botWebhookMaxBodyBytes: int(merged, 'BOT_WEBHOOK_MAX_BODY_BYTES', 256 * 1024, 16 * 1024, 1024 * 1024),
    botDeliveryIntervalSeconds: int(merged, 'BOT_DELIVERY_INTERVAL_SECONDS', 30, 5, 300),
    botDeliveryMaxAttempts: int(merged, 'BOT_DELIVERY_MAX_ATTEMPTS', 5, 1, 20),
    botEventRetentionDays: int(merged, 'BOT_EVENT_RETENTION_DAYS', 7, 1, 90),
    botCommandRatePerMinute: int(merged, 'BOT_COMMAND_RATE_PER_MINUTE', 20, 1, 600),
    botPublishMaxMediaBytes: int(merged, 'BOT_PUBLISH_MAX_MEDIA_BYTES', 10 * MIB, 1 * MIB, 50 * MIB),
    botPublishMaxScheduledDays: int(merged, 'BOT_PUBLISH_MAX_SCHEDULED_DAYS', 30, 1, 365),
    botMaxBots: int(merged, 'BOT_MAX_BOTS', 10, 1, 50),
    botAiEnabled: bool(merged, 'BOT_AI_ENABLED', false),
    botAiProvider: str(merged, 'BOT_AI_PROVIDER', ''),
    botAiModel: str(merged, 'BOT_AI_MODEL', ''),
    botAiTimeoutSeconds: int(merged, 'BOT_AI_TIMEOUT_SECONDS', 60, 10, 180),
    botAiMaxPromptChars: int(merged, 'BOT_AI_MAX_PROMPT_CHARS', 2000, 100, 8000),
    botAiRatePerHour: int(merged, 'BOT_AI_RATE_PER_HOUR', 10, 1, 120),
    botAiSessionRetentionDays: int(merged, 'BOT_AI_SESSION_RETENTION_DAYS', 7, 1, 90),
    botChatRatePerMinute: int(merged, 'BOT_CHAT_RATE_PER_MINUTE', 6, 1, 60),
    botAiMemoryMaxChars: int(merged, 'BOT_AI_MEMORY_MAX_CHARS', 4096, 512, 16384),
    botAiSystemPrompt: str(merged, 'BOT_AI_SYSTEM_PROMPT', '').slice(0, 2000),
    botDiscordGatewayEnabled: bool(merged, 'BOT_DISCORD_GATEWAY_ENABLED', false),
    botPublishMaxMediaFiles: int(merged, 'BOT_PUBLISH_MAX_MEDIA_FILES', 5, 1, 10),
    botPublishMaxMediaTotalBytes: int(
      merged,
      'BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES',
      50 * MIB,
      1 * MIB,
      200 * MIB,
    ),
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
  validateOrigin(config.appOrigin, 'APP_ORIGIN')
  validateOrigin(config.aiOrigin, 'AI_ORIGIN')
  if (config.cookieDomain && !/^\.[A-Za-z0-9.-]+$/.test(config.cookieDomain)) {
    throw new Error('COOKIE_DOMAIN 必须是以 . 开头的域名')
  }
  if (config.alertWebhookUrl) validateHttpUrl(config.alertWebhookUrl, 'ALERT_WEBHOOK_URL')
  if (config.botSecretKey) {
    let key: Buffer
    try {
      key = Buffer.from(config.botSecretKey, 'base64')
    } catch {
      throw new Error('BOT_SECRET_KEY 必须是 base64 编码的 32 字节密钥')
    }
    if (key.length !== 32) throw new Error('BOT_SECRET_KEY 必须是 base64 编码的 32 字节密钥')
  }
  if (config.nodeEnv === 'production' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new Error('生产环境 HOST 必须是 loopback（应用只允许本地反代访问）')
  }
  return config
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

/** 应用启动时确保数据目录存在且可写。 */
export function ensureRuntimeDirs(config: Config): void {
  const dirs = [config.dataDir, resolve(config.dataDir, 'files'), resolve(config.dataDir, 'tmp'), resolve(config.dataDir, 'backups')]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
}
