/** 仪表盘聚合：主机、存储、Minecraft、opencode、服务、备份、最近活动。 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { FileService } from '../files/service.ts'
import type { MinecraftService } from '../mc/service.ts'
import { listAudit, type AuditItem } from '../auth/audit.ts'
import { HostMonitor, ServiceMonitor, type HostMetrics } from './system.ts'

export interface BackupStatus {
  lastPullAt: string
  ageHours: number
  sizeBytes: number
  ok: boolean
  overdue: boolean
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
      nginx: 'nginx',
      opencode: 'opencode',
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

  private backupStatus(): BackupStatus | null {
    try {
      const raw = JSON.parse(readFileSync(this.config.backupPullFile, 'utf8')) as {
        lastPullAt?: string
        sizeBytes?: number
        ok?: boolean
      }
      if (!raw.lastPullAt) return null
      const ageHours = (Date.now() - Date.parse(raw.lastPullAt)) / 3_600_000
      return {
        lastPullAt: raw.lastPullAt,
        ageHours: Math.round(ageHours * 10) / 10,
        sizeBytes: Number(raw.sizeBytes ?? 0),
        ok: raw.ok !== false,
        overdue: ageHours > 48,
      }
    } catch {
      return null
    }
  }

  async get(): Promise<DashboardData> {
    const usage = this.files.usage()
    const [minecraft, opencode, services, activity] = await Promise.all([
      this.minecraft.status(),
      this.opencodeStatus(),
      this.services.snapshot(),
      Promise.resolve(listAudit(this.db, { limit: 8, offset: 0 }).items),
    ])
    return {
      host: this.host.snapshot(),
      storage: {
        quotaBytes: usage.quotaBytes,
        usedBytes: usage.usedBytes,
        trashBytes: usage.trashBytes,
        fileCount: usage.fileCount,
        freeBytes: usage.freeBytes,
      },
      minecraft,
      opencode,
      services,
      backup: this.backupStatus(),
      activity,
      generatedAt: new Date().toISOString(),
    }
  }
}
