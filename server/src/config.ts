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
  backupPullFile: string
  appVersion: string
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
    maxUploadBytes: int(merged, 'MAX_UPLOAD_BYTES', 2 * GIB, 1 * MIB, 1024 * GIB),
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
    backupPullFile: str(merged, 'BACKUP_PULL_FILE', resolve(dataDir, 'backup-pull.json')),
    appVersion: str(merged, 'APP_VERSION', '0.1.0'),
  }
  if (config.maxUploadBytes > config.quotaBytes) {
    throw new Error('MAX_UPLOAD_BYTES 不能大于 QUOTA_BYTES')
  }
  return config
}

/** 应用启动时确保数据目录存在且可写。 */
export function ensureRuntimeDirs(config: Config): void {
  const dirs = [config.dataDir, resolve(config.dataDir, 'files'), resolve(config.dataDir, 'tmp'), resolve(config.dataDir, 'backups')]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
}
