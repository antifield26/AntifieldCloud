/** 仪表盘聚合：主机、存储、Minecraft、opencode、服务、备份、最近活动。 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { FileService } from '../files/service.ts'
import type { MinecraftService } from '../mc/service.ts'
import { listAudit, type AuditItem } from '../auth/audit.ts'
import { readStatusFile, type StatusFileRecord } from '../util/status.ts'
import { HostMonitor, ServiceMonitor, type HostMetrics } from './system.ts'

/** 备份拉取超期阈值（小时）；与告警阈值独立，面板固定展示 48h。 */
const BACKUP_OVERDUE_HOURS = 48

export interface BackupStatus {
  /** PC 拉取脚本写入的状态；缺失记录时为 null（字段保留，前端按无记录展示）。 */
  lastPullAt: string | null
  ageHours: number | null
  sizeBytes: number | null
  ok: boolean | null
  overdue: boolean | null
  secretsOk: boolean | null
  lastSecretsAt: string | null
  secretsLastError: string | null
  /** 待 Windows 拉取确认的 Pi 归档数与字节数（不含 Web 导入归档）。 */
  pendingCount: number
  pendingBytes: number
  /** imports 目录中未登记进 DB 的孤儿归档数。 */
  orphanCount: number
  ackedBytes: number
  /** 最近一个归档错误的简述（不含绝对路径）。 */
  lastError: string | null
  /** 世界备份/拉取/演练状态文件原样对象；文件缺失为 null。 */
  world: StatusFileRecord | null
  worldPull: StatusFileRecord | null
  drill: StatusFileRecord | null
  /** v0.7.0：加密归档计数（Web 不可校验/恢复）。 */
  encryptedPendingCount: number
  encryptedAckedCount: number
  /** v0.7.0：加密开关与公钥是否就绪（只表示状态，不读取私钥）。 */
  encryption: {
    enabled: boolean
    keyConfigured: boolean
  }
  /** v0.7.0：PC 异地副本只读状态；文件缺失/未配置为 null。 */
  offsite: StatusFileRecord | null
}

export interface OpenCodeStatus {
  reachable: boolean
  url: string
  sessions: number | null
  error: string | null
}

export interface DashboardData {
  host: HostMetrics
  storage: {
    quotaBytes: number
    usedBytes: number
    trashBytes: number
    fileCount: number
    freeBytes: number
  }
  minecraft: Awaited<ReturnType<MinecraftService['status']>>
  opencode: OpenCodeStatus
  services: Record<string, 'active' | 'inactive' | 'unknown'>
  backup: BackupStatus | null
  activity: AuditItem[]
  generatedAt: string
}

export class DashboardService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly files: FileService
  private readonly minecraft: MinecraftService
  private readonly host: HostMonitor
  private readonly services: ServiceMonitor
  private opencodeCache: { at: number; value: OpenCodeStatus } | null = null

  constructor(db: DatabaseSync, config: Config, files: FileService, minecraft: MinecraftService) {
    this.db = db
    this.config = config
    this.files = files
    this.minecraft = minecraft
    this.host = new HostMonitor(config)
    this.services = new ServiceMonitor({
      minecraft: config.mcSystemdUnit,
      cloudflared: 'cloudflared',
      opencode: 'opencode',
      // mcbot 仅在集成启用时才纳入监控：未启用不探测、不产生 false alarm。
      ...(config.mcbotEnabled ? { mcbot: 'mcbot' } : {}),
    })
  }

  private async opencodeStatus(): Promise<OpenCodeStatus> {
    if (this.opencodeCache && Date.now() - this.opencodeCache.at < 15_000) return this.opencodeCache.value
    const base: OpenCodeStatus = {
      reachable: false,
      url: this.config.aiOrigin,
      sessions: null,
      error: null,
    }
    if (!this.config.opencodePassword) {
      const value = { ...base, error: '未配置 opencode 密码' }
      this.opencodeCache = { at: Date.now(), value }
      return value
    }
    try {
      const auth = Buffer.from(`${this.config.opencodeUsername}:${this.config.opencodePassword}`, 'utf8').toString('base64')
      const response = await fetch(`${this.config.opencodeUrl}/api/session`, {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(2500),
      })
      if (!response.ok) {
        const value = { ...base, error: `HTTP ${response.status}` }
        this.opencodeCache = { at: Date.now(), value }
        return value
      }
      const body = (await response.json()) as { data?: unknown[] }
      const value = { ...base, reachable: true, sessions: Array.isArray(body.data) ? body.data.length : null }
      this.opencodeCache = { at: Date.now(), value }
      return value
    } catch (error) {
      const value = { ...base, error: error instanceof Error ? error.message : '不可达' }
      this.opencodeCache = { at: Date.now(), value }
      return value
    }
  }

  /** 存储用量摘要：/api/dashboard 与 /api/storage 共用同一份语义。 */
  storage(): DashboardData['storage'] {
    const usage = this.files.usage()
    return {
      quotaBytes: usage.quotaBytes,
      usedBytes: usage.usedBytes,
      trashBytes: usage.trashBytes,
      fileCount: usage.fileCount,
      freeBytes: usage.freeBytes,
    }
  }

  hostSnapshot(): HostMetrics {
    return this.host.snapshot()
  }

  private archiveCounts(): {
    pendingCount: number
    pendingBytes: number
    ackedBytes: number
    encryptedPendingCount: number
    encryptedAckedCount: number
    lastError: string | null
  } {
    try {
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM backup_archives
           WHERE deleted_at IS NULL AND acked_at IS NULL AND origin != 'import'`,
        )
        .get() as { c: number; bytes: number }
      const acked = this.db
        .prepare(
          `SELECT COALESCE(SUM(size), 0) AS bytes FROM backup_archives
           WHERE deleted_at IS NULL AND acked_at IS NOT NULL AND origin != 'import'`,
        )
        .get() as { bytes: number }
      const encryptedPending = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM backup_archives
           WHERE deleted_at IS NULL AND acked_at IS NULL AND origin != 'import' AND name LIKE '%.tar.gz.age'`,
        )
        .get() as { c: number }
      const encryptedAcked = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM backup_archives
           WHERE deleted_at IS NULL AND acked_at IS NOT NULL AND origin != 'import' AND name LIKE '%.tar.gz.age'`,
        )
        .get() as { c: number }
      const lastError = (
        this.db
          .prepare(
            `SELECT last_error FROM backup_archives
             WHERE deleted_at IS NULL AND acked_at IS NULL AND last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          )
          .get() as { last_error: string | null } | undefined
      )?.last_error ?? null
      return {
        pendingCount: Number(pending.c),
        pendingBytes: Number(pending.bytes),
        ackedBytes: Number(acked.bytes),
        encryptedPendingCount: Number(encryptedPending.c),
        encryptedAckedCount: Number(encryptedAcked.c),
        lastError,
      }
    } catch {
      return {
        pendingCount: 0,
        pendingBytes: 0,
        ackedBytes: 0,
        encryptedPendingCount: 0,
        encryptedAckedCount: 0,
        lastError: null,
      }
    }
  }

  /** imports 目录里未登记进 DB 的文件视为孤儿归档；目录不存在时按 0 处理。 */
  private orphanCount(): number {
    try {
      const known = new Set(
        (
          this.db.prepare("SELECT name FROM backup_archives WHERE origin = 'import'").all() as unknown as {
            name: string
          }[]
        ).map((row) => row.name),
      )
      let count = 0
      for (const entry of readdirSync(join(this.config.dataDir, 'backups', 'imports'), { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.part-')) continue
        if (!known.has(entry.name)) count += 1
      }
      return count
    } catch {
      return 0
    }
  }

  /**
   * 备份面板状态：PC 拉取状态文件 + DB 归档统计 + 世界备份/拉取/演练只读状态。
   * 任一来源缺失都不抛错（对应字段为 null），由前端展示降级态。
   */
  private backupStatus(): BackupStatus {
    let raw: {
      lastPullAt?: string
      sizeBytes?: number
      ok?: boolean
      secretsOk?: boolean
      lastSecretsAt?: string | null
      secretsLastError?: string | null
      lastError?: string | null
    } = {}
    try {
      raw = JSON.parse(readFileSync(this.config.backupPullFile, 'utf8')) as typeof raw
    } catch {
      raw = {}
    }
    const hasPull = typeof raw.lastPullAt === 'string' && raw.lastPullAt.length > 0
    const ageHours = hasPull ? (Date.now() - Date.parse(raw.lastPullAt!)) / 3_600_000 : null
    const counts = this.archiveCounts()
    return {
      lastPullAt: hasPull ? raw.lastPullAt! : null,
      ageHours: ageHours !== null && Number.isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null,
      sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : null,
      ok: typeof raw.ok === 'boolean' ? raw.ok : null,
      overdue:
        ageHours !== null && Number.isFinite(ageHours) ? ageHours > BACKUP_OVERDUE_HOURS : null,
      secretsOk: typeof raw.secretsOk === 'boolean' ? raw.secretsOk : null,
      lastSecretsAt: raw.lastSecretsAt ?? null,
      secretsLastError: raw.secretsLastError ?? null,
      pendingCount: counts.pendingCount,
      pendingBytes: counts.pendingBytes,
      orphanCount: this.orphanCount(),
      ackedBytes: counts.ackedBytes,
      lastError: counts.lastError ?? raw.lastError ?? null,
      world: readStatusFile(this.config.worldBackupStatusFile),
      worldPull: readStatusFile(this.config.worldPullStatusFile),
      drill: readStatusFile(this.config.drillStatusFile),
      encryptedPendingCount: counts.encryptedPendingCount,
      encryptedAckedCount: counts.encryptedAckedCount,
      encryption: {
        enabled: this.config.backupArchiveEncryption,
        keyConfigured: existsSync(this.config.backupAgeRecipientFile),
      },
      offsite: readStatusFile(this.config.backupOffsiteStatusFile),
    }
  }

  async get(): Promise<DashboardData> {
    const [minecraft, opencode, services, activity] = await Promise.all([
      this.minecraft.status(),
      this.opencodeStatus(),
      this.services.snapshot(),
      Promise.resolve(listAudit(this.db, { limit: 8, offset: 0 }).items),
    ])
    return {
      host: this.host.snapshot(),
      storage: this.storage(),
      minecraft,
      opencode,
      services,
      backup: this.backupStatus(),
      activity,
      generatedAt: new Date().toISOString(),
    }
  }
}
