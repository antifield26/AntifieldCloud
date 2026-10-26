import type { LogLevel } from './logger.ts'

export interface Config {
  version: string
  botUsername: string
  mcHost: string
  mcPort: number
  mcVersion: string | false
  mcAuth: 'offline'
  dataDir: string
  httpHost: string
  httpPort: number
  httpToken: string
  httpAllowNonLoopback: boolean
  commandAllowlist: string[]
  presenceEnabled: boolean
  forceOnline: boolean
  presencePollMs: number
  presenceGraceMs: number
  presenceQuitCooldownMs: number
  presenceCheckMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
  loginTimeoutMs: number
  aiEnabled: boolean
  opencodeUrl: string
  opencodeUsername: string
  opencodePassword: string
  aiModelProvider: string
  aiModelId: string
  aiTimeoutMs: number
  aiMaxPromptChars: number
  aiMaxLines: number
  aiMaxLineChars: number
  aiCooldownMs: number
  aiQueueMax: number
  aiRatePerHour: number
  chatMaxInputChars: number
  memoryDir: string
  memoryMaxTurns: number
  memoryRetentionDays: number
  taskEnabled: boolean
  home: { x: number, y: number, z: number }
  safeZone: { minX: number, maxX: number, minZ: number, maxZ: number }
  farm: {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
    groundY: number
    cropY: number
  }
  chest: { x: number, y: number, z: number }
  fishStand: { x: number, y: number, z: number }
  fishWater: { x: number, y: number, z: number }
  taskMaxMinutes: number
  taskRecoveryMax: number
  teleportDistance: number
  taskAnchorTeleport: boolean
  autoDeposit: boolean
  proactiveEnabled: boolean
  proactiveGreeting: boolean
  proactiveEvents: boolean
  aiIntentEnabled: boolean
  aiIntentTimeoutMs: number
  aiIntentMinConfidence: number
  logLevel: LogLevel
  logAiPrompt: boolean
}

export class ConfigError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type Env = Record<string, string | undefined>

function readString (env: Env, key: string, fallback: string): string {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw.trim()
}

function readRequired (env: Env, key: string): string {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') throw new ConfigError(`${key} is required`)
  return raw.trim()
}

function readInt (env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new ConfigError(`${key} must be an integer`)
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}`)
  return value
}

function readNumber (env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new ConfigError(`${key} must be a finite number`)
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}`)
  return value
}

function readBool (env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new ConfigError(`${key} must be a boolean`)
}

function readLogLevel (env: Env): LogLevel {
  const raw = readString(env, 'LOG_LEVEL', 'info').toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  throw new ConfigError('LOG_LEVEL must be one of debug, info, warn, error')
}

function readAllowlist (env: Env): string[] {
  const raw = readString(env, 'COMMAND_ALLOWLIST', 'Antifield')
  const names = raw.split(',').map(item => item.trim()).filter(Boolean)
  if (names.length === 0) throw new ConfigError('COMMAND_ALLOWLIST must contain at least one name')
  return [...new Set(names)]
}

function isLoopbackHost (host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function readUrl (env: Env, key: string, fallback: string): string {
  const raw = readString(env, key, fallback)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ConfigError(`${key} must be a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${key} must be http or https`)
  }
  return raw.replace(/\/+$/, '')
}

function assertInSafeZone (
  name: string,
  point: { x: number, z: number },
  safe: { minX: number, maxX: number, minZ: number, maxZ: number }
): void {
  if (point.x < safe.minX || point.x > safe.maxX || point.z < safe.minZ || point.z > safe.maxZ) {
    throw new ConfigError(`${name} must be inside SAFE_MIN_X..SAFE_MAX_X and SAFE_MIN_Z..SAFE_MAX_Z`)
  }
}

export function loadConfig (env: Env = process.env, version = '0.0.0'): Config {
  const dataDir = readString(env, 'DATA_DIR', '/var/lib/lofii-bot')
  const httpHost = readString(env, 'HTTP_HOST', '127.0.0.1')
  const httpAllowNonLoopback = readBool(env, 'HTTP_ALLOW_NON_LOOPBACK', false)
  if (!httpAllowNonLoopback && !isLoopbackHost(httpHost)) {
    throw new ConfigError('HTTP_HOST must be a loopback address unless HTTP_ALLOW_NON_LOOPBACK=true')
  }

  const aiEnabled = readBool(env, 'AI_ENABLED', true)
  const opencodePassword = readString(env, 'OPENCODE_PASSWORD', '')
  if (aiEnabled && opencodePassword === '') {
    throw new ConfigError('OPENCODE_PASSWORD is required when AI_ENABLED=true')
  }

  const rawVersion = readString(env, 'MC_VERSION', '26.1')
  const mcVersion: string | false = rawVersion.toLowerCase() === 'auto' ? false : rawVersion

  const httpToken = readRequired(env, 'HTTP_TOKEN')
  if (httpToken.length < 16) throw new ConfigError('HTTP_TOKEN must be at least 16 characters')

  const safeZone = {
    minX: readNumber(env, 'SAFE_MIN_X', 175, -30000000, 30000000),
    maxX: readNumber(env, 'SAFE_MAX_X', 239, -30000000, 30000000),
    minZ: readNumber(env, 'SAFE_MIN_Z', 410, -30000000, 30000000),
    maxZ: readNumber(env, 'SAFE_MAX_Z', 474, -30000000, 30000000)
  }
  if (safeZone.minX > safeZone.maxX || safeZone.minZ > safeZone.maxZ) {
    throw new ConfigError('SAFE_MIN_* must be <= SAFE_MAX_*')
  }
  const home = {
    x: readNumber(env, 'BOT_HOME_X', 175.5, -30000000, 30000000),
    y: readNumber(env, 'BOT_HOME_Y', 64, -256, 512),
    z: readNumber(env, 'BOT_HOME_Z', 410.5, -30000000, 30000000)
  }
  const farm = {
    minX: readNumber(env, 'FARM_MIN_X', 177, -30000000, 30000000),
    maxX: readNumber(env, 'FARM_MAX_X', 183, -30000000, 30000000),
    minZ: readNumber(env, 'FARM_MIN_Z', 432, -30000000, 30000000),
    maxZ: readNumber(env, 'FARM_MAX_Z', 439, -30000000, 30000000),
    groundY: readNumber(env, 'FARM_GROUND_Y', 63, -256, 512),
    cropY: readNumber(env, 'FARM_CROP_Y', 64, -256, 512)
  }
  if (farm.minX > farm.maxX || farm.minZ > farm.maxZ) {
    throw new ConfigError('FARM_MIN_* must be <= FARM_MAX_*')
  }
  const chest = {
    x: readNumber(env, 'CHEST_X', 184, -30000000, 30000000),
    y: readNumber(env, 'CHEST_Y', 64, -256, 512),
    z: readNumber(env, 'CHEST_Z', 435, -30000000, 30000000)
  }
  const fishStand = {
    x: readNumber(env, 'FISH_STAND_X', 204.5, -30000000, 30000000),
    y: readNumber(env, 'FISH_STAND_Y', 63, -256, 512),
    z: readNumber(env, 'FISH_STAND_Z', 469.5, -30000000, 30000000)
  }
  const fishWater = {
    x: readNumber(env, 'FISH_WATER_X', 204.5, -30000000, 30000000),
    y: readNumber(env, 'FISH_WATER_Y', 62.5, -256, 512),
    z: readNumber(env, 'FISH_WATER_Z', 470.5, -30000000, 30000000)
  }
  assertInSafeZone('BOT_HOME', home, safeZone)
  assertInSafeZone('FARM', { x: farm.minX, z: farm.minZ }, safeZone)
  assertInSafeZone('FARM', { x: farm.maxX, z: farm.maxZ }, safeZone)
  assertInSafeZone('CHEST', chest, safeZone)
  assertInSafeZone('FISH_STAND', fishStand, safeZone)
  assertInSafeZone('FISH_WATER', fishWater, safeZone)

  return Object.freeze({
    version,
    botUsername: readString(env, 'BOT_USERNAME', 'lofii'),
    mcHost: readString(env, 'MC_HOST', '127.0.0.1'),
    mcPort: readInt(env, 'MC_PORT', 25565, 1, 65535),
    mcVersion,
    mcAuth: 'offline',
    dataDir,
    httpHost,
    httpPort: readInt(env, 'HTTP_PORT', 3010, 1, 65535),
    httpToken,
    httpAllowNonLoopback,
    commandAllowlist: readAllowlist(env),
    presenceEnabled: readBool(env, 'PRESENCE_ENABLED', true),
    forceOnline: readBool(env, 'FORCE_ONLINE', false),
    presencePollMs: readInt(env, 'PRESENCE_POLL_MS', 15000, 1000, 300000),
    presenceGraceMs: readInt(env, 'PRESENCE_GRACE_MS', 60000, 1000, 3600000),
    presenceQuitCooldownMs: readInt(env, 'PRESENCE_QUIT_COOLDOWN_MS', 10000, 1000, 300000),
    presenceCheckMs: readInt(env, 'PRESENCE_CHECK_MS', 5000, 200, 60000),
    reconnectMinMs: readInt(env, 'RECONNECT_MIN_MS', 5000, 1000, 300000),
    reconnectMaxMs: readInt(env, 'RECONNECT_MAX_MS', 60000, 1000, 600000),
    loginTimeoutMs: readInt(env, 'LOGIN_TIMEOUT_MS', 45000, 5000, 180000),
    aiEnabled,
    opencodeUrl: readUrl(env, 'OPENCODE_URL', 'http://127.0.0.1:4096'),
    opencodeUsername: readString(env, 'OPENCODE_USERNAME', 'opencode'),
    opencodePassword,
    aiModelProvider: readString(env, 'AI_MODEL_PROVIDER', 'opencode-go'),
    aiModelId: readString(env, 'AI_MODEL_ID', 'deepseek-v4.1-flash'),
    aiTimeoutMs: readInt(env, 'AI_TIMEOUT_MS', 45000, 5000, 180000),
    aiMaxPromptChars: readInt(env, 'AI_MAX_PROMPT_CHARS', 6000, 1000, 30000),
    aiMaxLines: readInt(env, 'AI_MAX_LINES', 3, 1, 5),
    aiMaxLineChars: readInt(env, 'AI_MAX_LINE_CHARS', 240, 80, 256),
    aiCooldownMs: readInt(env, 'AI_COOLDOWN_MS', 10000, 1000, 300000),
    aiQueueMax: readInt(env, 'AI_QUEUE_MAX', 4, 1, 50),
    aiRatePerHour: readInt(env, 'AI_RATE_PER_HOUR', 60, 1, 10000),
    chatMaxInputChars: readInt(env, 'CHAT_MAX_INPUT_CHARS', 500, 50, 1000),
    memoryDir: readString(env, 'MEMORY_DIR', `${dataDir}/memory`),
    memoryMaxTurns: readInt(env, 'MEMORY_MAX_TURNS', 20, 1, 200),
    memoryRetentionDays: readInt(env, 'MEMORY_RETENTION_DAYS', 30, 1, 3650),
    taskEnabled: readBool(env, 'TASK_ENABLED', true),
    home,
    safeZone,
    farm,
    chest,
    fishStand,
    fishWater,
    taskMaxMinutes: readInt(env, 'TASK_MAX_MINUTES', 30, 1, 120),
    taskRecoveryMax: readInt(env, 'TASK_RECOVERY_MAX', 3, 1, 5),
    teleportDistance: readNumber(env, 'TELEPORT_DISTANCE', 64, 8, 512),
    taskAnchorTeleport: readBool(env, 'TASK_ANCHOR_TELEPORT', true),
    autoDeposit: readBool(env, 'AUTO_DEPOSIT', true),
    proactiveEnabled: readBool(env, 'PROACTIVE_ENABLED', true),
    proactiveGreeting: readBool(env, 'PROACTIVE_GREETING', true),
    proactiveEvents: readBool(env, 'PROACTIVE_EVENTS', true),
    aiIntentEnabled: readBool(env, 'AI_INTENT_ENABLED', true),
    aiIntentTimeoutMs: readInt(env, 'AI_INTENT_TIMEOUT_MS', 5000, 1000, 30000),
    aiIntentMinConfidence: readNumber(env, 'AI_INTENT_MIN_CONFIDENCE', 0.7, 0, 1),
    logLevel: readLogLevel(env),
    logAiPrompt: readBool(env, 'LOG_AI_PROMPT', false)
  })
}
