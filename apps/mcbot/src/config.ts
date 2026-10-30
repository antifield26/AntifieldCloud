import type { LogLevel } from './logger.ts'
import type { TaskName } from './state.ts'

export interface ConfigPoint {
  x: number
  y: number
  z: number
}

/** 在线模式：auto=有玩家/任务时上线；always=常驻；off=不主动上线。 */
export type PresenceMode = 'auto' | 'always' | 'off'

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
  /** 持久化在线模式的默认值；presence.json 存在时以文件为准。 */
  presenceMode: PresenceMode
  /** 在线模式持久化文件；只保存模式/时间/操作者。 */
  presenceFile: string
  /** 长期目标/多步计划 SQLite；只保存目标元数据与步骤状态。 */
  goalsFile: string
  goalsMaxSteps: number
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
  memorySummaryEnabled: boolean
  memorySummaryTurns: number
  memorySummaryMaxChars: number
  taskEnabled: boolean
  queueMax: number
  treeFarm: {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
    groundY: number
    logMinY: number
    maxY: number
    logType: string
    saplingType: string
  }
  treeMaxLogs: number
  treeDepositEveryMs: number
  mining: {
    minY: number
    maxY: number
    maxOres: number
    maxMinutes: number
    protectRadius: number
    ores: string[]
    deepEnabled: boolean
    deepMinY: number
    deepMaxY: number
  }
  forest: {
    species: string[]
    protectRadius: number
    maxLogs: number
    depositEveryMs: number
  }
  sleep: {
    bedSearchRadius: number
    voteWaitMs: number
  }
  patrol: {
    maxMinutes: number
  }
  rcon: {
    enabled: boolean
    host: string
    port: number
    password: string
    timeoutMs: number
  }
  adminPollMs: number
  history: {
    enabled: boolean
    file: string
    sampleMs: number
    retentionDays: number
  }
  alerts: {
    enabled: boolean
    cooldownMs: number
    healthThreshold: number
  }
  defenseEnabled: boolean
  defenseRadius: number
  defenseHealthThreshold: number
  defenseFoodThreshold: number
  defenseMaxHostiles: number
  defenseTargets: string[]
  chunkWaitMs: number
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
  /** 按类别分箱存储；未配置的分类回退到主箱 chest。 */
  storageChests: {
    ores: ConfigPoint | null
    food: ConfigPoint | null
    saplings: ConfigPoint | null
    misc: ConfigPoint | null
  }
  fishStand: { x: number, y: number, z: number }
  fishWater: { x: number, y: number, z: number }
  taskMaxMinutes: number
  taskRecoveryMax: number
  teleportDistance: number
  taskAnchorTeleport: boolean
  /** v1.0.6 确定性导航开关与预算。 */
  pathPlannerEnabled: boolean
  pathPlannerMaxNodes: number
  pathPlannerTimeoutMs: number
  pathMaxReplans: number
  pathTeleportFallback: boolean
  pathOutsideSafeRadius: number
  /** AI 路点建议：默认 true；仅在 AI/OpenCode 配置可用时实际启用。 */
  pathAiEnabled: boolean
  pathAiTimeoutMs: number
  pathAiCooldownMs: number
  autoDeposit: boolean
  proactiveEnabled: boolean
  proactiveGreeting: boolean
  proactiveEvents: boolean
  aiIntentEnabled: boolean
  aiIntentTimeoutMs: number
  aiIntentMinConfidence: number
  httpControlToken: string
  httpControlEnabled: boolean
  httpOnlyHighRisk: boolean
  sseMaxClients: number
  sseHeartbeatMs: number
  sseBufferEvents: number
  taskPendingTtlMs: number
  taskStateFile: string
  auditFile: string
  auditMaxBytes: number
  auditRetentionDays: number
  controlRateLimit: number
  /** systemd sd_notify 看门狗（NOTIFY_SOCKET 存在时生效）。 */
  watchdog: { enabled: boolean, heartbeatMs: number }
  /** RSS 上限告警（MB，0=关闭）与检查周期。 */
  rssLimitMb: number
  rssCheckMs: number
  /** AI 受控工具：默认关闭；仅允许白名单内的只读/低风险工具。 */
  aiToolsEnabled: boolean
  aiToolAllowlist: string[]
  aiMaxToolCalls: number
  /** 显式启动的 AI 自主会话；默认关闭。 */
  autonomyEnabled: boolean
  autonomyMaxMinutes: number
  autonomyMaxToolCalls: number
  autonomyMaxFailures: number
  autonomyGoalMaxChars: number
  autonomyDecisionTimeoutMs: number
  autonomyMcpWarmupMs: number
  autonomyScanRadius: number
  autonomyScanMaxBlocks: number
  autonomyScanBlocks: string[]
  autonomyChestReadEnabled: boolean
  autonomyChestPathTimeoutMs: number
  autonomyEatBelow: number
  autonomyActionCooldownMs: number
  autonomyEventDebounceMs: number
  autonomyMaxReprompts: number
  autonomyTasks: TaskName[]
  /** 库存/补货告警与自动补货。 */
  inventoryAlertFreeSlots: number
  foodAlertThreshold: number
  autoRestock: boolean
  autoRestockIntervalMs: number
  /** 空闲自动进食/换装；默认开启，可由面板/环境变量关闭。 */
  autoSurvival: boolean
  autoSurvivalIntervalMs: number
  /** 自动进食阈值（饥饿值低于该值）。 */
  autoEatBelow: number
  /** 基地守卫/玩家护送/航点探索任务参数。 */
  guardRadius: number
  escortDistance: number
  exploreWaypoints: Array<ConfigPoint & { name: string }>
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

function readNameList (env: Env, key: string, fallback: string): string[] {
  const raw = readString(env, key, fallback)
  const names = raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0) throw new ConfigError(`${key} must contain at least one name`)
  return [...new Set(names)]
}

/** 方块 allowlist：精确名或以 * 结尾的前缀模式；限制数量与长度。 */
function readBlockPatterns (env: Env, key: string, fallback: string): string[] {
  const raw = readString(env, key, fallback)
  const patterns = raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  if (patterns.length === 0) throw new ConfigError(`${key} must contain at least one block name`)
  if (patterns.length > 32) throw new ConfigError(`${key} must contain at most 32 patterns`)
  for (const pattern of patterns) {
    if (!/^[*]?[a-z0-9_]+[*]?$/.test(pattern) || pattern === '*' || pattern.length > 32) {
      throw new ConfigError(`${key} has an invalid block pattern: ${pattern}`)
    }
  }
  return [...new Set(patterns)]
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

/** 可选坐标点：三个 env 都缺失返回 null；只配置一部分视为错误。 */
function readOptionalPoint (
  env: Env,
  prefix: string,
  safe: { minX: number, maxX: number, minZ: number, maxZ: number }
): ConfigPoint | null {
  const rawX = env[`${prefix}_X`]
  const rawY = env[`${prefix}_Y`]
  const rawZ = env[`${prefix}_Z`]
  const present = [rawX, rawY, rawZ].filter(value => value !== undefined && value.trim() !== '')
  if (present.length === 0) return null
  if (present.length !== 3) throw new ConfigError(`${prefix}_X/Y/Z must be set together`)
  const point = {
    x: readNumber(env, `${prefix}_X`, 0, -30000000, 30000000),
    y: readNumber(env, `${prefix}_Y`, 0, -256, 512),
    z: readNumber(env, `${prefix}_Z`, 0, -30000000, 30000000)
  }
  assertInSafeZone(prefix, point, safe)
  return point
}

const MAX_EXPLORE_WAYPOINTS = 32

/** EXPlORE_WAYPOINTS 形如 `home:175:64:410;farm:180:64:435`；名称唯一且都在安全区内。 */
function readExploreWaypoints (
  env: Env,
  safe: { minX: number, maxX: number, minZ: number, maxZ: number }
): Array<ConfigPoint & { name: string }> {
  const raw = readString(env, 'EXPLORE_WAYPOINTS', '').trim()
  if (raw === '') return []
  const names = new Set<string>()
  const waypoints: Array<ConfigPoint & { name: string }> = []
  for (const entry of raw.split(';').map(item => item.trim()).filter(Boolean)) {
    const parts = entry.split(':').map(item => item.trim())
    if (parts.length !== 4) throw new ConfigError('EXPLORE_WAYPOINTS entries must be name:x:y:z')
    const [name, rawX, rawY, rawZ] = parts
    if (!name || !/^[A-Za-z0-9_]{1,24}$/.test(name)) {
      throw new ConfigError('EXPLORE_WAYPOINTS name must be 1-24 letters, digits or underscores')
    }
    if (names.has(name)) throw new ConfigError(`EXPLORE_WAYPOINTS has duplicate name: ${name}`)
    names.add(name)
    const x = Number(rawX)
    const y = Number(rawY)
    const z = Number(rawZ)
    if (![x, y, z].every(value => Number.isFinite(value))) {
      throw new ConfigError(`EXPLORE_WAYPOINTS coordinates must be numbers: ${entry}`)
    }
    if (x < -30000000 || x > 30000000 || z < -30000000 || z > 30000000 || y < -256 || y > 512) {
      throw new ConfigError(`EXPLORE_WAYPOINTS coordinates out of range: ${entry}`)
    }
    assertInSafeZone(`EXPLORE_WAYPOINTS ${name}`, { x, z }, safe)
    waypoints.push({ name, x, y, z })
    if (waypoints.length > MAX_EXPLORE_WAYPOINTS) {
      throw new ConfigError(`EXPLORE_WAYPOINTS supports at most ${MAX_EXPLORE_WAYPOINTS} points`)
    }
  }
  return waypoints
}

const AI_TOOL_NAMES = new Set(['status', 'inventory', 'task_status'])
const AUTONOMY_TASK_NAMES = new Set<TaskName>([
  'fishing', 'farming', 'woodcutting', 'mining', 'forest', 'sleep', 'patrol', 'guard', 'escort', 'explore', 'clearing'
])

function readAutonomyTasks (env: Env): TaskName[] {
  const raw = readString(
    env,
    'AUTONOMY_TASKS',
    'fishing,farming,woodcutting,mining,forest,sleep,patrol,guard,escort,explore,clearing'
  )
  const names = raw.split(',').map(item => item.trim()).filter(Boolean) as TaskName[]
  if (names.length === 0) throw new ConfigError('AUTONOMY_TASKS must contain at least one task')
  for (const name of names) {
    if (!AUTONOMY_TASK_NAMES.has(name)) throw new ConfigError(`AUTONOMY_TASKS has unknown task: ${name}`)
  }
  return [...new Set(names)]
}

function readAiToolAllowlist (env: Env): string[] {
  const names = readNameList(env, 'AI_TOOL_ALLOWLIST', 'status,inventory,task_status')
  for (const name of names) {
    if (!AI_TOOL_NAMES.has(name)) throw new ConfigError(`AI_TOOL_ALLOWLIST has unknown tool: ${name}`)
  }
  return names
}

export function loadConfig (env: Env = process.env, version = '0.0.0'): Config {
  const dataDir = readString(env, 'DATA_DIR', '/var/lib/mcbot')
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
    minX: readNumber(env, 'SAFE_MIN_X', 111, -30000000, 30000000),
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
  const storageChests = {
    ores: readOptionalPoint(env, 'CHEST_ORES', safeZone),
    food: readOptionalPoint(env, 'CHEST_FOOD', safeZone),
    saplings: readOptionalPoint(env, 'CHEST_SAPLINGS', safeZone),
    misc: readOptionalPoint(env, 'CHEST_MISC', safeZone)
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
  const treeFarm = {
    minX: readNumber(env, 'TREE_FARM_MIN_X', 180, -30000000, 30000000),
    maxX: readNumber(env, 'TREE_FARM_MAX_X', 193, -30000000, 30000000),
    minZ: readNumber(env, 'TREE_FARM_MIN_Z', 455, -30000000, 30000000),
    maxZ: readNumber(env, 'TREE_FARM_MAX_Z', 464, -30000000, 30000000),
    groundY: readNumber(env, 'TREE_FARM_GROUND_Y', 63, -256, 512),
    logMinY: readNumber(env, 'TREE_FARM_LOG_MIN_Y', 64, -256, 512),
    maxY: readNumber(env, 'TREE_FARM_MAX_Y', 96, -256, 512),
    logType: readString(env, 'TREE_LOG_TYPE', 'oak_log'),
    saplingType: readString(env, 'TREE_SAPLING_TYPE', 'oak_sapling')
  }
  if (treeFarm.minX > treeFarm.maxX || treeFarm.minZ > treeFarm.maxZ) {
    throw new ConfigError('TREE_FARM_MIN_* must be <= TREE_FARM_MAX_*')
  }
  if (treeFarm.logMinY <= treeFarm.groundY || treeFarm.maxY < treeFarm.logMinY) {
    throw new ConfigError('TREE_FARM_LOG_MIN_Y must be > TREE_FARM_GROUND_Y and <= TREE_FARM_MAX_Y')
  }
  assertInSafeZone('BOT_HOME', home, safeZone)
  assertInSafeZone('FARM', { x: farm.minX, z: farm.minZ }, safeZone)
  assertInSafeZone('FARM', { x: farm.maxX, z: farm.maxZ }, safeZone)
  assertInSafeZone('CHEST', chest, safeZone)
  assertInSafeZone('FISH_STAND', fishStand, safeZone)
  assertInSafeZone('FISH_WATER', fishWater, safeZone)
  assertInSafeZone('TREE_FARM', { x: treeFarm.minX, z: treeFarm.minZ }, safeZone)
  assertInSafeZone('TREE_FARM', { x: treeFarm.maxX, z: treeFarm.maxZ }, safeZone)

  const mining = {
    minY: readNumber(env, 'MINE_MIN_Y', 60, -256, 512),
    maxY: readNumber(env, 'MINE_MAX_Y', 120, -256, 512),
    maxOres: readInt(env, 'MINE_MAX_ORES', 64, 1, 2048),
    maxMinutes: readInt(env, 'MINE_MAX_MINUTES', 30, 1, 120),
    protectRadius: readNumber(env, 'MINE_PROTECT_RADIUS', 16, 0, 64),
    ores: readNameList(env, 'MINE_ORES',
      'coal_ore,deepslate_coal_ore,iron_ore,deepslate_iron_ore,copper_ore,deepslate_copper_ore'),
    deepEnabled: readBool(env, 'MINE_DEEP_ENABLED', false),
    deepMinY: readNumber(env, 'MINE_DEEP_MIN_Y', 0, -256, 512),
    deepMaxY: readNumber(env, 'MINE_DEEP_MAX_Y', 59, -256, 512)
  }
  if (mining.minY > mining.maxY) throw new ConfigError('MINE_MIN_Y must be <= MINE_MAX_Y')
  if (mining.deepEnabled) {
    if (mining.deepMinY > mining.deepMaxY) {
      throw new ConfigError('MINE_DEEP_MIN_Y must be <= MINE_DEEP_MAX_Y')
    }
    if (mining.deepMaxY >= mining.minY) {
      throw new ConfigError('MINE_DEEP_MAX_Y must be < MINE_MIN_Y')
    }
  }
  const forest = {
    species: readNameList(env, 'FOREST_SPECIES', 'oak,spruce,birch'),
    protectRadius: readNumber(env, 'FOREST_PROTECT_RADIUS', 16, 0, 64),
    maxLogs: readInt(env, 'FOREST_MAX_LOGS', 128, 1, 2048),
    depositEveryMs: readInt(env, 'FOREST_DEPOSIT_EVERY_MS', 300000, 60000, 3600000)
  }
  const allowedForest = new Set(['oak', 'spruce', 'birch'])
  if (forest.species.some(species => !allowedForest.has(species))) {
    throw new ConfigError('FOREST_SPECIES only supports oak, spruce, birch')
  }
  const sleepConfig = {
    bedSearchRadius: readNumber(env, 'BED_SEARCH_RADIUS', 16, 2, 64),
    voteWaitMs: readInt(env, 'SLEEP_VOTE_WAIT_MS', 45000, 5000, 180000)
  }
  const patrol = {
    maxMinutes: readInt(env, 'PATROL_MAX_MINUTES', 15, 1, 60)
  }
  const rconEnabled = readBool(env, 'RCON_ENABLED', false)
  const rconPassword = readString(env, 'RCON_PASSWORD', '')
  if (rconEnabled && rconPassword === '') {
    throw new ConfigError('RCON_PASSWORD is required when RCON_ENABLED=true')
  }
  const rcon = {
    enabled: rconEnabled,
    host: readString(env, 'RCON_HOST', '127.0.0.1'),
    port: readInt(env, 'RCON_PORT', 25575, 1, 65535),
    password: rconPassword,
    timeoutMs: readInt(env, 'RCON_TIMEOUT_MS', 4000, 500, 30000)
  }
  const history = {
    enabled: readBool(env, 'HISTORY_ENABLED', true),
    file: readString(env, 'HISTORY_DB', `${dataDir}/history.db`),
    sampleMs: readInt(env, 'HISTORY_SAMPLE_MS', 60000, 5000, 3600000),
    retentionDays: readInt(env, 'HISTORY_RETENTION_DAYS', 30, 1, 3650)
  }
  const alerts = {
    enabled: readBool(env, 'ALERTS_ENABLED', true),
    cooldownMs: readInt(env, 'ALERT_COOLDOWN_MS', 300000, 10000, 3600000),
    healthThreshold: readNumber(env, 'ALERT_HEALTH_THRESHOLD', 12, 1, 20)
  }
  const autonomyEnabled = readBool(env, 'AUTONOMY_ENABLED', false)
  const autonomyTasks = readAutonomyTasks(env)
  const httpControlEnabled = readBool(env, 'HTTP_CONTROL_ENABLED', true)
  if (autonomyEnabled && !aiEnabled) throw new ConfigError('AUTONOMY_ENABLED=true requires AI_ENABLED=true')
  if (autonomyEnabled && !readBool(env, 'TASK_ENABLED', true)) {
    throw new ConfigError('AUTONOMY_ENABLED=true requires TASK_ENABLED=true')
  }
  if (autonomyEnabled && !httpControlEnabled) {
    throw new ConfigError('AUTONOMY_ENABLED=true requires HTTP_CONTROL_ENABLED=true')
  }

  const presenceEnabled = readBool(env, 'PRESENCE_ENABLED', true)
  const forceOnline = readBool(env, 'FORCE_ONLINE', false)
  const rawPresenceMode = readString(env, 'PRESENCE_MODE', '')
  if (rawPresenceMode && rawPresenceMode !== 'auto' && rawPresenceMode !== 'always' && rawPresenceMode !== 'off') {
    throw new ConfigError('PRESENCE_MODE must be auto, always or off')
  }
  const presenceMode: PresenceMode = rawPresenceMode === ''
    ? (!presenceEnabled || forceOnline ? 'always' : 'auto')
    : (rawPresenceMode as PresenceMode)
  const presenceFile = readString(env, 'PRESENCE_FILE', `${dataDir}/presence.json`)
  const goalsFile = readString(env, 'GOALS_FILE', `${dataDir}/goals.db`)
  const goalsMaxSteps = readInt(env, 'GOALS_MAX_STEPS', 5, 1, 10)

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
    presenceEnabled,
    forceOnline,
    presenceMode,
    presenceFile,
    goalsFile,
    goalsMaxSteps,
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
    memorySummaryEnabled: readBool(env, 'MEMORY_SUMMARY_ENABLED', true),
    memorySummaryTurns: (() => {
      const turns = readInt(env, 'MEMORY_SUMMARY_TURNS', 40, 2, 1000)
      if (turns % 2 !== 0) throw new ConfigError('MEMORY_SUMMARY_TURNS must be an even number')
      return turns
    })(),
    memorySummaryMaxChars: readInt(env, 'MEMORY_SUMMARY_MAX_CHARS', 1000, 100, 5000),
    taskEnabled: readBool(env, 'TASK_ENABLED', true),
    queueMax: readInt(env, 'QUEUE_MAX', 3, 1, 10),
    treeFarm,
    treeMaxLogs: readInt(env, 'TREE_MAX_LOGS', 128, 1, 2048),
    treeDepositEveryMs: readInt(env, 'TREE_DEPOSIT_EVERY_MS', 300000, 60000, 3600000),
    mining,
    forest,
    sleep: sleepConfig,
    patrol,
    rcon,
    adminPollMs: readInt(env, 'ADMIN_POLL_MS', 60000, 5000, 3600000),
    history,
    alerts,
    defenseEnabled: readBool(env, 'DEFENSE_ENABLED', true),
    defenseRadius: readNumber(env, 'DEFENSE_RADIUS', 12, 4, 32),
    defenseHealthThreshold: readNumber(env, 'DEFENSE_HEALTH_THRESHOLD', 12, 1, 20),
    defenseFoodThreshold: readNumber(env, 'DEFENSE_FOOD_THRESHOLD', 6, 1, 20),
    defenseMaxHostiles: readInt(env, 'DEFENSE_MAX_HOSTILES', 2, 1, 10),
    defenseTargets: readNameList(
      env,
      'DEFENSE_TARGETS',
      'zombie,husk,drowned,skeleton,stray,spider,cave_spider'
    ),
    chunkWaitMs: readInt(env, 'CHUNK_WAIT_MS', 5000, 500, 60000),
    home,
    safeZone,
    farm,
    chest,
    storageChests,
    fishStand,
    fishWater,
    taskMaxMinutes: readInt(env, 'TASK_MAX_MINUTES', 60, 1, 180),
    taskRecoveryMax: readInt(env, 'TASK_RECOVERY_MAX', 3, 1, 5),
    teleportDistance: readNumber(env, 'TELEPORT_DISTANCE', 64, 8, 512),
    taskAnchorTeleport: readBool(env, 'TASK_ANCHOR_TELEPORT', true),
    pathPlannerEnabled: readBool(env, 'PATH_PLANNER_ENABLED', true),
    pathPlannerMaxNodes: readInt(env, 'PATH_PLANNER_MAX_NODES', 6000, 64, 50000),
    pathPlannerTimeoutMs: readInt(env, 'PATH_PLANNER_TIMEOUT_MS', 1500, 100, 15000),
    pathMaxReplans: readInt(env, 'PATH_MAX_REPLANS', 2, 0, 5),
    pathTeleportFallback: readBool(env, 'PATH_TELEPORT_FALLBACK', true),
    pathOutsideSafeRadius: readInt(env, 'PATH_OUTSIDE_SAFE_RADIUS', 32, 4, 128),
    pathAiEnabled: readBool(env, 'PATH_AI_ENABLED', true),
    pathAiTimeoutMs: readInt(env, 'PATH_AI_TIMEOUT_MS', 8000, 1000, 30000),
    pathAiCooldownMs: readInt(env, 'PATH_AI_COOLDOWN_MS', 30000, 0, 300000),
    autoDeposit: readBool(env, 'AUTO_DEPOSIT', true),
    proactiveEnabled: readBool(env, 'PROACTIVE_ENABLED', true),
    proactiveGreeting: readBool(env, 'PROACTIVE_GREETING', true),
    proactiveEvents: readBool(env, 'PROACTIVE_EVENTS', true),
    aiIntentEnabled: readBool(env, 'AI_INTENT_ENABLED', true),
    aiIntentTimeoutMs: readInt(env, 'AI_INTENT_TIMEOUT_MS', 5000, 1000, 30000),
    aiIntentMinConfidence: readNumber(env, 'AI_INTENT_MIN_CONFIDENCE', 0.7, 0, 1),
    httpControlToken: (() => {
      const token = readString(env, 'HTTP_CONTROL_TOKEN', '')
      if (token !== '' && token.length < 16) throw new ConfigError('HTTP_CONTROL_TOKEN must be at least 16 characters')
      return token
    })(),
    httpControlEnabled,
    httpOnlyHighRisk: readBool(env, 'HTTP_ONLY_HIGH_RISK', false),
    sseMaxClients: readInt(env, 'SSE_MAX_CLIENTS', 8, 1, 64),
    sseHeartbeatMs: readInt(env, 'SSE_HEARTBEAT_MS', 15000, 1000, 600000),
    sseBufferEvents: readInt(env, 'SSE_BUFFER_EVENTS', 500, 10, 10000),
    taskPendingTtlMs: readInt(env, 'TASK_PENDING_TTL_MS', 600000, 60000, 3600000),
    taskStateFile: readString(env, 'TASK_STATE_FILE', `${dataDir}/task-state.json`),
    auditFile: readString(env, 'AUDIT_FILE', `${dataDir}/audit.jsonl`),
    auditMaxBytes: readInt(env, 'AUDIT_MAX_BYTES', 5242880, 65536, 1073741824),
    auditRetentionDays: readInt(env, 'AUDIT_RETENTION_DAYS', 30, 1, 3650),
    controlRateLimit: readInt(env, 'CONTROL_RATE_LIMIT', 30, 1, 1000),
    watchdog: {
      enabled: readBool(env, 'WATCHDOG_ENABLED', true),
      heartbeatMs: readInt(env, 'WATCHDOG_HEARTBEAT_MS', 20000, 5000, 120000)
    },
    rssLimitMb: readInt(env, 'RSS_LIMIT_MB', 0, 0, 8192),
    rssCheckMs: readInt(env, 'RSS_CHECK_MS', 30000, 5000, 600000),
    aiToolsEnabled: readBool(env, 'AI_TOOLS_ENABLED', false),
    aiToolAllowlist: readAiToolAllowlist(env),
    aiMaxToolCalls: readInt(env, 'AI_MAX_TOOL_CALLS', 2, 1, 4),
    autonomyEnabled,
    autonomyMaxMinutes: readInt(env, 'AUTONOMY_MAX_MINUTES', 20, 1, 60),
    autonomyMaxToolCalls: readInt(env, 'AUTONOMY_MAX_TOOL_CALLS', 12, 1, 30),
    autonomyMaxFailures: readInt(env, 'AUTONOMY_MAX_FAILURES', 2, 1, 5),
    autonomyGoalMaxChars: readInt(env, 'AUTONOMY_GOAL_MAX_CHARS', 200, 20, 500),
    autonomyDecisionTimeoutMs: readInt(env, 'AUTONOMY_DECISION_TIMEOUT_MS', 180000, 30000, 900000),
    autonomyMcpWarmupMs: readInt(env, 'AUTONOMY_MCP_WARMUP_MS', 3000, 0, 15000),
    autonomyScanRadius: readInt(env, 'AUTONOMY_SCAN_RADIUS', 16, 4, 32),
    autonomyScanMaxBlocks: readInt(env, 'AUTONOMY_SCAN_MAX_BLOCKS', 48, 8, 128),
    autonomyScanBlocks: readBlockPatterns(env, 'AUTONOMY_SCAN_BLOCKS', 'chest,trapped_chest,barrel,ender_chest,*_bed,water,crafting_table,furnace,blast_furnace,smoker,wheat,carrots,potatoes,beetroots,*_log,*_ore'),
    autonomyChestReadEnabled: readBool(env, 'AUTONOMY_CHEST_READ_ENABLED', true),
    autonomyChestPathTimeoutMs: readInt(env, 'AUTONOMY_CHEST_PATH_TIMEOUT_MS', 12000, 2000, 30000),
    autonomyEatBelow: readInt(env, 'AUTONOMY_EAT_BELOW', 18, 1, 20),
    autonomyActionCooldownMs: readInt(env, 'AUTONOMY_ACTION_COOLDOWN_MS', 5000, 0, 60000),
    autonomyEventDebounceMs: readInt(env, 'AUTONOMY_EVENT_DEBOUNCE_MS', 30000, 0, 300000),
    autonomyMaxReprompts: readInt(env, 'AUTONOMY_MAX_REPROMPTS', 6, 1, 20),
    autonomyTasks,
    inventoryAlertFreeSlots: readInt(env, 'INVENTORY_ALERT_FREE_SLOTS', 2, 0, 9),
    foodAlertThreshold: readInt(env, 'FOOD_ALERT_THRESHOLD', 4, 0, 20),
    autoRestock: readBool(env, 'AUTO_RESTOCK', true),
    autoRestockIntervalMs: readInt(env, 'AUTO_RESTOCK_INTERVAL_MS', 300000, 60000, 3600000),
    autoSurvival: readBool(env, 'AUTO_SURVIVAL', true),
    autoSurvivalIntervalMs: readInt(env, 'AUTO_SURVIVAL_INTERVAL_MS', 5000, 1000, 60000),
    autoEatBelow: readInt(env, 'AUTO_EAT_BELOW', 16, 1, 20),
    guardRadius: readNumber(env, 'GUARD_RADIUS', 16, 4, 32),
    escortDistance: readNumber(env, 'ESCORT_DISTANCE', 12, 4, 32),
    exploreWaypoints: readExploreWaypoints(env, safeZone),
    logLevel: readLogLevel(env),
    logAiPrompt: readBool(env, 'LOG_AI_PROMPT', false)
  })
}
