/** 测试辅助：临时目录、测试配置、管理员种子、Cookie 解析。 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../src/config.ts'
import { openDatabase } from '../src/db.ts'
import { hashPassword } from '../src/auth/password.ts'
import { generateTotpSecret, hotp, currentStep } from '../src/auth/totp.ts'
import { createUser } from '../src/auth/users.ts'
import { recoveryCodeHash } from '../src/util/ids.ts'

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-test-'))
  mkdirSync(join(dir, 'web'), { recursive: true })
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><html lang="zh-CN"><body>test</body></html>')
  return dir
}

export function testConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    logLevel: 'silent',
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webDistDir: join(dataDir, 'web'),
    appOrigin: 'https://app.test',
    aiOrigin: 'https://ai.test',
    cookieDomain: '.test',
    allowInsecureLoopback: true,
    quotaBytes: 8 * 1024 * 1024,
    maxUploadBytes: 2 * 1024 * 1024,
    maxFilesPerRequest: 10,
    textPreviewBytes: 1024 * 1024,
    trashRetentionDays: 30,
    sessionTtlDays: 7,
    challengeTtlSeconds: 300,
    auditRetentionDays: 90,
    adminUsername: 'admin',
    mcHost: '127.0.0.1',
    mcPort: 25565,
    rconHost: '127.0.0.1',
    rconPort: 25575,
    rconPassword: '',
    mcPublicAddress: 'mc.test:25565',
    mcSystemdUnit: 'minecraft',
    opencodeUrl: 'http://127.0.0.1:4096',
    opencodeUsername: 'opencode',
    opencodePassword: '',
    opencodeHtmlMode: 'shim',
    backupPullFile: join(dataDir, 'backup-pull.json'),
    backupRestoreEnabled: true,
    backupImportMaxBytes: 100 * 1024 * 1024,
    backupRestorePlanTtlMinutes: 30,
    backupRestoreMaxEntries: 5000,
    backupPrepareTimeoutSec: 3300,
    chunkedUploadEnabled: true,
    chunkSizeBytes: 8 * 1024 * 1024,
    chunkMaxFileBytes: 5 * 1024 * 1024 * 1024,
    chunkSessionTtlHours: 24,
    chunkMaxConcurrentSessions: 3,
    noteAttachmentMaxBytes: 25 * 1024 * 1024,
    noteMaxAttachments: 100,
    noteVersionsKeep: 20,
    shareMaxItems: 50,
    metricsEnabled: true,
    metricsSampleSeconds: 60,
    metricsRetentionDays: 30,
    worldBackupStatusFile: join(dataDir, 'world-backup-status.json'),
    worldPullStatusFile: join(dataDir, 'world-pull-status.json'),
    drillStatusFile: join(dataDir, 'drill-status.json'),
    alertWorldBackupMaxAgeHours: 192,
    alertDrillMaxAgeDays: 35,
    sharesEnabled: true,
    shareDefaultExpiryHours: 168,
    shareMaxExpiryHours: 720,
    shareMaxDownloads: 10_000,
    alertsEnabled: true,
    alertWebhookUrl: '',
    alertWebhookType: 'generic',
    alertWebhookSecret: '',
    alertDiskFreePct: 15,
    alertTempC: 80,
    alertBackupMaxAgeHours: 48,
    alertCooldownMinutes: 360,
    alertCheckIntervalSeconds: 300,
    piHealthFile: join(dataDir, 'pi-health.json'),
    appVersion: '0.2.0-test',
    botEnabled: true,
    botSecretKey: '',
    botWebhookMaxBodyBytes: 256 * 1024,
    botDeliveryIntervalSeconds: 30,
    botDeliveryMaxAttempts: 5,
    botEventRetentionDays: 7,
    botCommandRatePerMinute: 120,
    botPublishMaxScheduledDays: 30,
    botMaxBots: 10,
    botAiEnabled: false,
    botAiProvider: '',
    botAiModel: '',
    botAiTimeoutSeconds: 60,
    botAiMaxPromptChars: 2000,
    botAiRatePerHour: 120,
    botAiSessionRetentionDays: 7,
    botChatRatePerMinute: 30,
    botAiMemoryMaxChars: 4096,
    botAiMaxReplyChars: 4000,
    botAiVisionEnabled: true,
    botAiImageMaxBytes: 10 * 1024 * 1024,
    botConnectivityEnabled: false,
    botConnectivityIntervalSeconds: 60,
    botConnectivityTimeoutSeconds: 8,
    botProxyUrl: '',
    ...overrides,
  }
}

export function testDb(dataDir: string): DatabaseSync {
  return openDatabase({ path: join(dataDir, 'db.sqlite') })
}

export interface SeedResult {
  username: string
  password: string
  secret: string
  userId: string
}

export async function seedAdmin(db: DatabaseSync, options: { recoveryCode?: string } = {}): Promise<SeedResult> {
  const username = 'admin'
  const password = 'test-password-1234'
  const hashed = await hashPassword(password)
  const secret = generateTotpSecret()
  const recovery = options.recoveryCode ?? 'ABCDE-12345'
  const user = createUser(db, {
    username,
    passwordHash: hashed.hash,
    passwordSalt: hashed.salt,
    totpSecret: secret,
    recoveryCodeHashes: [recoveryCodeHash(recovery)],
  })
  return { username, password, secret, userId: user.id }
}

export function currentCode(secret: string): string {
  return hotp(secret, currentStep())
}

export function parseSetCookies(header: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of header ?? []) {
    const first = raw.split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq > 0) out[first.slice(0, eq)] = first.slice(eq + 1)
  }
  return out
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上数据库文件可能短时间内仍被占用；测试目录由系统清理。
  }
}
