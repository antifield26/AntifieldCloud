/**
 * 告警服务：周期评估主机/服务/备份/Minecraft/欠压指标，持久化事件并推送通用 JSON webhook。
 *
 * 安全边界与约束：
 * - 所有外部依赖（时钟、statfs、文件读取、服务状态、MC 状态、fetch、sleep、日志）均可注入，
 *   测试不依赖真实主机/网络。
 * - 日志与错误信息中绝不输出 webhook URL 与 secret；投递失败只记录脱敏后的原因。
 * - 状态机持久化在 alert_state：首次越界产生 firing 事件；持续越界按冷却时间重复通知；
 *   恢复时产生 resolved 事件。无法读取的指标视为 unknown：连续 N 次不可读后降级为
 *   unknown 事件（同一降级只发一次），数据源恢复后发 resolved；事件与状态写入在同一事务内。
 * - alert_events 保留 90 天，评估周期内按小时节流清理旧事件。
 * - start()/stop() 由进程入口接入；构造函数不自行启动定时器。
 */
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync, statfsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import { promisify } from 'node:util'
import type { Config } from '../config.ts'
import { transaction } from '../db.ts'
import { nowIso } from '../util/time.ts'

const execFileAsync = promisify(execFile)

export const DEFAULT_MEMORY_USED_PCT = 90
export const WEBHOOK_TIMEOUT_MS = 10_000
export const WEBHOOK_MAX_ATTEMPTS = 3
/** unknown 连续评估次数达到该值时降级产生事件。 */
export const UNKNOWN_DEGRADE_THRESHOLD = 3
/** alert_events 保留天数。 */
export const ALERT_EVENT_RETENTION_DAYS = 90
const EVENT_LIMIT_DEFAULT = 20
const EVENT_LIMIT_MAX = 200
/** 事件清理最小间隔，避免每次评估都执行 DELETE。 */
const EVENT_PRUNE_INTERVAL_MS = 60 * 60_000

export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertStatus = 'firing' | 'ok' | 'unknown'
export type ServiceState = 'active' | 'inactive' | 'unknown'

export interface AlertCondition {
  event: string
  severity: AlertSeverity
  status: AlertStatus
  title: string
  message: string
  details: Record<string, unknown>
}

export interface AlertDeps {
  now?: () => Date
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  readFile?: (path: string) => string
  statfs?: (path: string) => { availableBytes: number; totalBytes: number } | null
  memory?: () => { totalBytes: number; usedBytes: number } | null
  serviceStates?: () => Promise<Record<string, ServiceState>>
  minecraftStatus?: () => Promise<{ online: boolean; error?: string | null } | null>
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  /** 内存告警阈值（已用百分比），默认 90。 */
  memoryUsedPct?: number
  /** 需要监控的 systemd unit；默认 minecraft/cloudflared/opencode（nginx 已作为旧入口移除）。 */
  serviceUnits?: Record<string, string>
  /** unknown 连续评估阈值（默认 3，测试可调小）。 */
  unknownThreshold?: number
  /** 事件落库后通知 Bot 平台（不阻塞/不影响告警主流程）。 */
  notifyEvent?: (event: {
    id: number
    event: string
    severity: string
    status: string
    title: string
    message: string
    createdAt: string
  }) => void
}

export interface AlertEventItem {
  id: number
  event: string
  severity: string
  status: string
  title: string
  message: string
  details: Record<string, unknown> | null
  createdAt: string
  deliveredAt: string | null
  deliveryError: string | null
}

export interface AlertStateItem {
  event: string
  status: string
  lastFiredAt: string | null
  lastOkAt: string | null
  title: string | null
  severity: string | null
  message: string | null
  lastEventAt: string | null
}

export interface AlertConfigSummary {
  enabled: boolean
  webhookConfigured: boolean
  webhookType: string
  diskFreePct: number
  tempC: number
  memoryUsedPct: number
  backupMaxAgeHours: number
  /** 世界备份/拉取超期阈值（小时）与世界恢复演练超期阈值（天）。 */
  worldBackupMaxAgeHours: number
  drillMaxAgeDays: number
  /** 异地副本超期阈值（小时）；0 表示关闭。 */
  offsiteMaxAgeHours: number
  cooldownMinutes: number
  checkIntervalSeconds: number
  lastEvaluatedAt: string | null
}

export interface AlertListQuery {
  limit?: number
  offset?: number
  event?: string | null
  status?: string | null
  severity?: string | null
}

export interface AlertListResult {
  items: AlertEventItem[]
  total: number
  state: AlertStateItem[]
  config: AlertConfigSummary
}

export interface AlertTestResult {
  ok: boolean
  delivered: boolean
  message?: string
}

export interface EvaluateResult {
  skipped: boolean
  evaluatedAt: string
  checked: number
  firing: number
  resolved: number
  delivered: number
}

interface AlertEventRow {
  id: number
  event: string
  severity: string
  status: string
  title: string
  message: string
  details_json: string | null
  created_at: string
  delivered_at: string | null
  delivery_error: string | null
}

interface AlertStateRow {
  event: string
  status: string
  last_fired_at: string | null
  last_ok_at: string | null
}

export interface PiHealthSnapshot {
  tempC: number | null
  underVoltage: boolean
  throttledRaw: string | null
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** 解析 vcgencmd get_throttled 的返回值（支持 0x50000 / "throttled=0x0" / 十进制）。 */
export function parseThrottled(raw: unknown): { underVoltageNow: boolean; underVoltageOccurred: boolean; text: string | null } {
  if (raw === undefined || raw === null) return { underVoltageNow: false, underVoltageOccurred: false, text: null }
  const text = String(raw).trim()
  const match = /(?:0x([0-9a-fA-F]+)|(\d+))/.exec(text)
  let bits = 0
  if (match) {
    bits = match[1] ? Number.parseInt(match[1], 16) : Number.parseInt(match[2] ?? '0', 10)
  }
  if (!Number.isFinite(bits)) return { underVoltageNow: false, underVoltageOccurred: false, text }
  return {
    underVoltageNow: (bits & 0x1) !== 0,
    underVoltageOccurred: (bits & 0x10000) !== 0,
    text,
  }
}

/** 解析 /run/antifieldcloud/pi-health.json；字段名允许几种常见写法，缺失返回 null。 */
export function parsePiHealth(raw: string): PiHealthSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const tempC = toNumber(record.tempC ?? record.temp_c ?? record.temperature)
  const throttled = parseThrottled(record.throttled ?? record.throttledRaw ?? record.throttled_raw)
  // deploy/health-probe.sh 输出 undervoltageNow/undervoltageOccurred；同时兼容布尔简写。
  let explicitUnderVoltage: boolean | undefined
  for (const key of ['underVoltage', 'under_voltage', 'undervoltageNow', 'undervoltage_now']) {
    if (record[key] === true) {
      explicitUnderVoltage = true
      break
    }
    if (record[key] === false && explicitUnderVoltage === undefined) explicitUnderVoltage = false
  }
  return {
    tempC,
    underVoltage: explicitUnderVoltage ?? throttled.underVoltageNow,
    throttledRaw: throttled.text,
  }
}

function defaultStatfs(path: string): { availableBytes: number; totalBytes: number } | null {
  try {
    const stats = statfsSync(path)
    const blockSize = Number(stats.bsize)
    return {
      availableBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize,
    }
  } catch {
    return null
  }
}

function defaultMemory(): { totalBytes: number; usedBytes: number } | null {
  try {
    const total = os.totalmem()
    return { totalBytes: total, usedBytes: total - os.freemem() }
  } catch {
    return null
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export class AlertService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly deps: Required<Pick<AlertDeps, 'now' | 'fetch' | 'sleep' | 'readFile' | 'statfs' | 'memory' | 'log'>> &
    AlertDeps
  private readonly memoryUsedPct: number
  private readonly serviceUnits: Record<string, string>
  private readonly unknownThreshold: number
  /** event → 连续 unknown 次数（进程内即可：重启后重新累计）。 */
  private readonly unknownStreak = new Map<string, number>()
  private lastEventPruneAt = 0
  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastEvaluatedAt: string | null = null

  constructor(db: DatabaseSync, config: Config, deps: AlertDeps = {}) {
    this.db = db
    this.config = config
    this.deps = {
      now: deps.now ?? (() => new Date()),
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      readFile: deps.readFile ?? ((path) => readFileSync(path, 'utf8')),
      statfs: deps.statfs ?? defaultStatfs,
      memory: deps.memory ?? defaultMemory,
      log:
        deps.log ??
        ((level, message, detail) => {
          const line = detail ? `${message} ${JSON.stringify(detail)}` : message
          if (level === 'error') console.error(`[alerts] ${line}`)
          else if (level === 'warn') console.warn(`[alerts] ${line}`)
          else console.info(`[alerts] ${line}`)
        }),
      ...deps,
    }
    this.memoryUsedPct = deps.memoryUsedPct ?? DEFAULT_MEMORY_USED_PCT
    this.unknownThreshold = Math.max(1, deps.unknownThreshold ?? UNKNOWN_DEGRADE_THRESHOLD)
    this.serviceUnits = deps.serviceUnits ?? {
      minecraft: config.mcSystemdUnit,
      cloudflared: 'cloudflared',
      opencode: 'opencode',
    }
  }

  // ---------- 生命周期 ----------

  /** 由进程入口调用；alertsEnabled=false 时不启动。定时器 unref，不阻止进程退出。 */
  start(): void {
    if (!this.config.alertsEnabled || this.timer) return
    const intervalMs = Math.max(60, this.config.alertCheckIntervalSeconds) * 1000
    this.timer = setInterval(() => {
      void this.evaluateOnce().catch((error: unknown) => {
        this.deps.log('error', '告警评估失败', { error: this.sanitizeError(error) })
      })
    }, intervalMs)
    this.timer.unref?.()
    void this.evaluateOnce().catch((error: unknown) => {
      this.deps.log('error', '告警评估失败', { error: this.sanitizeError(error) })
    })
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  get evaluatedAt(): string | null {
    return this.lastEvaluatedAt
  }

  // ---------- 评估 ----------

  private async collectConditions(): Promise<AlertCondition[]> {
    const health = this.readPiHealth()
    const offsite = this.offsiteCondition()
    const conditions: AlertCondition[] = [
      this.diskCondition(),
      this.tempCondition(health),
      this.memoryCondition(),
      await this.servicesCondition(),
      this.backupOverdueCondition(),
      this.backupPendingCondition(),
      this.backupSecretsCondition(),
      this.worldBackupCondition(),
      this.worldPullCondition(),
      this.drillCondition(),
      ...(offsite ? [offsite] : []),
      await this.minecraftCondition(),
      this.underVoltageCondition(health),
    ]
    return conditions
  }

  private readPiHealth(): PiHealthSnapshot | null {
    try {
      const raw = this.deps.readFile(this.config.piHealthFile)
      return parsePiHealth(raw)
    } catch {
      return null
    }
  }

  private diskCondition(): AlertCondition {
    const threshold = this.config.alertDiskFreePct
    const stat = this.deps.statfs(this.config.dataDir)
    if (!stat || stat.totalBytes <= 0) {
      return this.unknown('disk_low', '磁盘空间', '无法读取磁盘用量')
    }
    const freePct = round1((stat.availableBytes / stat.totalBytes) * 100)
    const firing = freePct < threshold
    return {
      event: 'disk_low',
      severity: freePct < threshold / 2 ? 'critical' : 'warning',
      status: firing ? 'firing' : 'ok',
      title: '磁盘剩余空间不足',
      message: `数据盘剩余 ${freePct}%（阈值 ${threshold}%）`,
      details: {
        freePct,
        thresholdPct: threshold,
        freeBytes: stat.availableBytes,
        totalBytes: stat.totalBytes,
      },
    }
  }

  private tempCondition(health: PiHealthSnapshot | null): AlertCondition {
    const threshold = this.config.alertTempC
    let tempC = health?.tempC ?? null
    let source = 'pi-health'
    if (tempC === null) {
      try {
        const raw = this.deps.readFile('/sys/class/thermal/thermal_zone0/temp').trim()
        const milli = Number(raw)
        if (Number.isFinite(milli) && milli > 0) {
          tempC = round1(milli / 1000)
          source = 'sysfs'
        }
      } catch {
        tempC = null
      }
    }
    if (tempC === null) return this.unknown('temp_high', 'CPU 温度', '无法读取温度')
    const firing = tempC > threshold
    return {
      event: 'temp_high',
      severity: tempC > threshold + 10 ? 'critical' : 'warning',
      status: firing ? 'firing' : 'ok',
      title: 'CPU 温度偏高',
      message: `CPU 温度 ${tempC}℃（阈值 ${threshold}℃）`,
      details: { tempC, thresholdC: threshold, source },
    }
  }

  private memoryCondition(): AlertCondition {
    const mem = this.deps.memory()
    if (!mem || mem.totalBytes <= 0) return this.unknown('mem_high', '内存使用', '无法读取内存用量')
    const usedPct = round1((mem.usedBytes / mem.totalBytes) * 100)
    const firing = usedPct > this.memoryUsedPct
    return {
      event: 'mem_high',
      severity: 'warning',
      status: firing ? 'firing' : 'ok',
      title: '内存使用率偏高',
      message: `内存已用 ${usedPct}%（阈值 ${this.memoryUsedPct}%）`,
      details: { usedPct, thresholdPct: this.memoryUsedPct, totalBytes: mem.totalBytes, usedBytes: mem.usedBytes },
    }
  }

  private async servicesCondition(): Promise<AlertCondition> {
    let states: Record<string, ServiceState>
    try {
      states = this.deps.serviceStates ? await this.deps.serviceStates() : await this.defaultServiceStates()
    } catch {
      return this.unknown('service_down', '服务状态', '无法读取服务状态')
    }
    const entries = Object.entries(states)
    const known = entries.filter(([, state]) => state !== 'unknown')
    const down = known.filter(([, state]) => state === 'inactive').map(([name]) => name)
    if (known.length === 0) return this.unknown('service_down', '服务状态', '没有可用的服务状态数据')
    const firing = down.length > 0
    return {
      event: 'service_down',
      severity: 'warning',
      status: firing ? 'firing' : 'ok',
      title: '后台服务未运行',
      message: firing ? `未运行：${down.join('、')}` : '所有受监控服务运行正常',
      details: { services: states, down },
    }
  }

  private async defaultServiceStates(): Promise<Record<string, ServiceState>> {
    if (process.platform === 'win32') return {}
    const names = Object.entries(this.serviceUnits)
    const entries = await Promise.all(
      names.map(async ([name, unit]) => {
        let state: ServiceState = 'unknown'
        try {
          const { stdout } = await execFileAsync('/bin/systemctl', ['is-active', unit], { timeout: 2500 })
          const value = stdout.trim()
          if (value === 'active' || value === 'inactive') state = value
          else if (value === 'failed') state = 'inactive'
        } catch (error) {
          const stdout = (error as { stdout?: string }).stdout?.trim()
          if (stdout === 'inactive' || stdout === 'failed') state = 'inactive'
        }
        return [name, state] as const
      }),
    )
    return Object.fromEntries(entries)
  }

  private backupOverdueCondition(): AlertCondition {
    const threshold = this.config.alertBackupMaxAgeHours
    let row: { last_backup_at: string | null } | undefined
    try {
      row = this.db.prepare('SELECT last_backup_at FROM backup_state WHERE id = 1').get() as
        | { last_backup_at: string | null }
        | undefined
    } catch {
      return this.unknown('backup_overdue', '备份超期', '无法读取备份状态')
    }
    const last = row?.last_backup_at ?? null
    if (!last) return this.unknown('backup_overdue', '备份超期', '尚无成功备份记录')
    const ageHours = (this.deps.now().getTime() - Date.parse(last)) / 3_600_000
    if (!Number.isFinite(ageHours)) return this.unknown('backup_overdue', '备份超期', '备份时间不可解析')
    const firing = ageHours > threshold
    return {
      event: 'backup_overdue',
      severity: 'critical',
      status: firing ? 'firing' : 'ok',
      title: '备份超期',
      message: `最近一次成功备份在 ${round1(ageHours)} 小时前（阈值 ${threshold} 小时）`,
      details: { lastBackupAt: last, ageHours: round1(ageHours), thresholdHours: threshold },
    }
  }

  private backupPendingCondition(): AlertCondition {
    const threshold = this.config.alertBackupMaxAgeHours
    let rows: { name: string; created_at: string }[]
    try {
      // 只统计 Pi 生成的 pending 归档：Web 导入的 origin='import' 行永远不会 ack，不能计入待拉取。
      rows = this.db
        .prepare(
          "SELECT name, created_at FROM backup_archives WHERE acked_at IS NULL AND deleted_at IS NULL AND origin = 'pi' ORDER BY created_at ASC",
        )
        .all() as unknown as { name: string; created_at: string }[]
    } catch {
      return this.unknown('backup_pending', '备份待拉取', '无法读取备份归档')
    }
    const now = this.deps.now().getTime()
    const overdue = rows.filter((row) => {
      const created = Date.parse(row.created_at)
      return !Number.isFinite(created) || now - created > threshold * 3_600_000
    })
    const firing = overdue.length > 0
    return {
      event: 'backup_pending',
      severity: 'warning',
      status: firing ? 'firing' : 'ok',
      title: '备份归档待拉取',
      message: firing
        ? `有 ${overdue.length} 个归档超过 ${threshold} 小时未确认拉取`
        : `待拉取归档 ${rows.length} 个，均未超期`,
      details: {
        pending: rows.length,
        overdue: overdue.length,
        thresholdHours: threshold,
        oldest: rows[0]?.created_at ?? null,
      },
    }
  }

  /** PC 拉取脚本写入的密钥包状态；旧状态没有字段时明确标为 unknown，不冒充成功。 */
  private backupSecretsCondition(): AlertCondition {
    let raw: {
      secretsAttempted?: boolean
      secretsOk?: boolean
      lastSecretsAt?: string | null
      secretsLastError?: string | null
    }
    try {
      raw = JSON.parse(this.deps.readFile(this.config.backupPullFile)) as typeof raw
    } catch {
      return this.unknown('backup_secrets', '密钥包备份', '无法读取备份状态')
    }
    if (!raw || raw.secretsAttempted !== true) {
      return this.unknown('backup_secrets', '密钥包备份', '尚未记录密钥包拉取状态')
    }
    if (raw.secretsOk === false) {
      return {
        event: 'backup_secrets',
        severity: 'warning',
        status: 'firing',
        title: '密钥包备份失败',
        message: `最近一次密钥包拉取失败${raw.secretsLastError ? `：${raw.secretsLastError}` : ''}`,
        details: { lastSecretsAt: raw.lastSecretsAt ?? null, error: raw.secretsLastError ?? null },
      }
    }
    if (!raw.lastSecretsAt) {
      return this.unknown('backup_secrets', '密钥包备份', '密钥包成功状态缺少时间')
    }
    const ageHours = (this.deps.now().getTime() - Date.parse(raw.lastSecretsAt)) / 3_600_000
    if (!Number.isFinite(ageHours)) {
      return this.unknown('backup_secrets', '密钥包备份', '密钥包时间不可解析')
    }
    const threshold = Math.max(72, this.config.alertBackupMaxAgeHours)
    const firing = ageHours > threshold
    return {
      event: 'backup_secrets',
      severity: 'warning',
      status: firing ? 'firing' : 'ok',
      title: '密钥包备份超期',
      message: firing
        ? `最近一次密钥包备份在 ${round1(ageHours)} 小时前（阈值 ${threshold} 小时）`
        : '密钥包备份正常',
      details: { lastSecretsAt: raw.lastSecretsAt, ageHours: round1(ageHours), thresholdHours: threshold },
    }
  }

  /** 读取 root 脚本写入的只读状态 JSON；不可读/不是对象返回 null。 */
  private readStatusRecord(path: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(this.deps.readFile(path))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  private statusTime(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return null
  }

  private worldBackupCondition(): AlertCondition {
    return this.statusFileCondition({
      event: 'world_backup_stale',
      title: '世界备份超期',
      path: this.config.worldBackupStatusFile,
      thresholdMs: this.config.alertWorldBackupMaxAgeHours * 3_600_000,
      timeKeys: ['lastRunAt'],
    })
  }

  private worldPullCondition(): AlertCondition {
    return this.statusFileCondition({
      event: 'world_pull_stale',
      title: '世界备份未拉取',
      path: this.config.worldPullStatusFile,
      thresholdMs: this.config.alertWorldBackupMaxAgeHours * 3_600_000,
      timeKeys: ['lastRunAt', 'lastPullAt'],
    })
  }

  private drillCondition(): AlertCondition {
    return this.statusFileCondition({
      event: 'drill_stale',
      title: '恢复演练超期',
      path: this.config.drillStatusFile,
      thresholdMs: this.config.alertDrillMaxAgeDays * 86_400_000,
      timeKeys: ['lastRunAt'],
    })
  }

  /**
   * 异地副本超期：未配置 offsite（状态文件不存在）时返回 null，不进入条件列表，
   * 避免“从未配置”被降级为 unknown 并反复告警；文件存在但字段异常仍按 unknown 处理。
   */
  private offsiteCondition(): AlertCondition | null {
    if (this.config.alertOffsiteMaxAgeHours <= 0) return null
    const record = this.readStatusRecord(this.config.backupOffsiteStatusFile)
    if (!record) return null
    return this.statusFileCondition({
      event: 'offsite_overdue',
      title: '异地副本超期',
      path: this.config.backupOffsiteStatusFile,
      thresholdMs: this.config.alertOffsiteMaxAgeHours * 3_600_000,
      timeKeys: ['lastRunAt'],
    })
  }

  /**
   * 世界备份/拉取/演练状态文件告警：
   * 文件缺失或缺少时间字段视为 unknown（新功能尚未跑过/脚本未写状态）；
   * ok=false 或最后成功时间超过阈值视为 firing；否则 ok。
   */
  private statusFileCondition(options: {
    event: string
    title: string
    path: string
    thresholdMs: number
    timeKeys: string[]
  }): AlertCondition {
    const record = this.readStatusRecord(options.path)
    if (!record) return this.unknown(options.event, options.title, '无法读取状态文件')
    const lastAt = this.statusTime(record, options.timeKeys)
    if (!lastAt) return this.unknown(options.event, options.title, '状态文件缺少时间字段')
    const lastMs = Date.parse(lastAt)
    if (!Number.isFinite(lastMs)) return this.unknown(options.event, options.title, '状态时间不可解析')
    const ok = typeof record.ok === 'boolean' ? record.ok : null
    const error = typeof record.error === 'string' && record.error.trim() ? record.error.trim().slice(0, 200) : null
    const ageMs = Math.max(0, this.deps.now().getTime() - lastMs)
    const ageHours = round1(ageMs / 3_600_000)
    const thresholdHours = round1(options.thresholdMs / 3_600_000)
    const firing = ok === false || ageMs > options.thresholdMs
    const reason = ok === false ? `最近一次执行失败${error ? `：${error}` : ''}` : `最近一次成功在 ${ageHours} 小时前（阈值 ${thresholdHours} 小时）`
    return {
      event: options.event,
      severity: ok === false ? 'critical' : 'warning',
      status: firing ? 'firing' : 'ok',
      title: options.title,
      message: firing ? reason : `${options.title}正常`,
      details: {
        lastRunAt: lastAt,
        ageHours,
        thresholdHours,
        ok,
        ...(error ? { error } : {}),
      },
    }
  }

  private async minecraftCondition(): Promise<AlertCondition> {
    if (!this.deps.minecraftStatus) return this.unknown('mc_offline', 'Minecraft 状态', '未接入 Minecraft 状态')
    let status: { online: boolean; error?: string | null } | null
    try {
      status = await this.deps.minecraftStatus()
    } catch {
      return this.unknown('mc_offline', 'Minecraft 状态', 'Minecraft 状态检查失败')
    }
    if (!status) return this.unknown('mc_offline', 'Minecraft 状态', 'Minecraft 状态不可用')
    return {
      event: 'mc_offline',
      severity: 'warning',
      status: status.online ? 'ok' : 'firing',
      title: 'Minecraft 服务器离线',
      message: status.online ? 'Minecraft 服务器在线' : `Minecraft 服务器未响应${status.error ? `：${status.error}` : ''}`,
      details: { online: status.online, error: status.error ?? null },
    }
  }

  private underVoltageCondition(health: PiHealthSnapshot | null): AlertCondition {
    if (!health) return this.unknown('undervoltage', '树莓派欠压', '无法读取 pi-health')
    return {
      event: 'undervoltage',
      severity: health.underVoltage ? 'critical' : 'info',
      status: health.underVoltage ? 'firing' : 'ok',
      title: '树莓派供电欠压',
      message: health.underVoltage
        ? `检测到欠压${health.throttledRaw ? `（throttled=${health.throttledRaw}）` : ''}`
        : '供电正常',
      details: { underVoltage: health.underVoltage, throttled: health.throttledRaw },
    }
  }

  private unknown(event: string, title: string, message: string): AlertCondition {
    return { event, severity: 'info', status: 'unknown', title, message, details: {} }
  }

  /** 执行一次评估：更新 alert_state、写入事件并投递 webhook。由定时器或测试调用。 */
  async evaluateOnce(): Promise<EvaluateResult> {
    const evaluatedAt = this.deps.now()
    const evaluatedIso = evaluatedAt.toISOString()
    if (!this.config.alertsEnabled) {
      return { skipped: true, evaluatedAt: evaluatedIso, checked: 0, firing: 0, resolved: 0, delivered: 0 }
    }
    if (this.running) {
      return { skipped: true, evaluatedAt: evaluatedIso, checked: 0, firing: 0, resolved: 0, delivered: 0 }
    }
    this.running = true
    try {
      const conditions = await this.collectConditions()
      const events: AlertEventRow[] = []
      for (const condition of conditions) {
        const event = this.applyCondition(condition, evaluatedAt)
        if (event) events.push(event)
      }
      let delivered = 0
      for (const event of events) {
        if (await this.deliver(event)) delivered += 1
        try {
          this.deps.notifyEvent?.({
            id: event.id,
            event: event.event,
            severity: event.severity,
            status: event.status,
            title: event.title,
            message: event.message,
            createdAt: event.created_at,
          })
        } catch (error) {
          this.deps.log('warn', 'Bot 告警通知入队失败', { error: this.sanitizeError(error) })
        }
      }
      try {
        this.pruneEventsIfDue()
      } catch (error) {
        this.deps.log('warn', '告警事件清理失败', { error: this.sanitizeError(error) })
      }
      this.lastEvaluatedAt = evaluatedIso
      return {
        skipped: false,
        evaluatedAt: evaluatedIso,
        checked: conditions.length,
        firing: events.filter((event) => event.status === 'firing').length,
        resolved: events.filter((event) => event.status === 'resolved').length,
        delivered,
      }
    } finally {
      this.running = false
    }
  }

  // ---------- 状态机 ----------

  private applyCondition(condition: AlertCondition, now: Date): AlertEventRow | null {
    if (condition.status === 'unknown') return this.applyUnknownCondition(condition, now)
    // 数据源恢复可用：重置连续 unknown 计数。
    this.unknownStreak.delete(condition.event)
    const nowMs = now.getTime()
    const state = this.db.prepare('SELECT * FROM alert_state WHERE event = ?').get(condition.event) as unknown as
      | AlertStateRow
      | undefined
    const cooldownMs = this.config.alertCooldownMinutes * 60_000
    if (condition.status === 'firing') {
      const lastFired = state?.last_fired_at ? Date.parse(state.last_fired_at) : Number.NaN
      const inCooldown = state?.status === 'firing' && Number.isFinite(lastFired) && nowMs - lastFired < cooldownMs
      if (inCooldown) return null
      return transaction(this.db, () => {
        const event = this.insertEvent(condition, 'firing', now)
        this.db
          .prepare(
            `INSERT INTO alert_state (event, status, last_fired_at, last_ok_at) VALUES (?, 'firing', ?, ?)
             ON CONFLICT(event) DO UPDATE SET status = 'firing', last_fired_at = excluded.last_fired_at`,
          )
          .run(condition.event, event.created_at, state?.last_ok_at ?? null)
        return event
      })
    }
    // status === 'ok'：从 firing 或 unknown 恢复都产生一条 resolved 事件。
    if (state?.status === 'firing' || state?.status === 'unknown') {
      const degraded = state.status === 'unknown'
      const previous = degraded
        ? undefined
        : (this.db
            .prepare("SELECT severity, title FROM alert_events WHERE event = ? AND status = 'firing' ORDER BY id DESC LIMIT 1")
            .get(condition.event) as { severity: string; title: string } | undefined)
      return transaction(this.db, () => {
        const event = this.insertEvent(
          {
            ...condition,
            severity: degraded ? 'info' : ((previous?.severity as AlertSeverity | undefined) ?? 'info'),
            title: degraded ? `${condition.title}（数据已恢复）` : `${previous?.title ?? condition.title}（已恢复）`,
            message: degraded ? '指标数据源恢复可用' : '指标已恢复正常',
          },
          'resolved',
          now,
        )
        this.db
          .prepare("UPDATE alert_state SET status = 'ok', last_ok_at = ? WHERE event = ?")
          .run(event.created_at, condition.event)
        return event
      })
    }
    this.db
      .prepare(
        `INSERT INTO alert_state (event, status, last_fired_at, last_ok_at) VALUES (?, 'ok', ?, ?)
         ON CONFLICT(event) DO UPDATE SET status = 'ok', last_ok_at = excluded.last_ok_at`,
      )
      .run(condition.event, state?.last_fired_at ?? null, now.toISOString())
    return null
  }

  /**
   * unknown 连续出现：未到阈值保持既有状态；达到阈值后降级为 unknown 事件并写状态。
   * 同一降级只发一次（state.status 已是 unknown 时不再重复），数据恢复时由 ok 分支发 resolved。
   */
  private applyUnknownCondition(condition: AlertCondition, now: Date): AlertEventRow | null {
    const streak = (this.unknownStreak.get(condition.event) ?? 0) + 1
    this.unknownStreak.set(condition.event, streak)
    if (streak < this.unknownThreshold) return null
    const state = this.db.prepare('SELECT * FROM alert_state WHERE event = ?').get(condition.event) as unknown as
      | AlertStateRow
      | undefined
    if (state?.status === 'unknown') return null
    return transaction(this.db, () => {
      const event = this.insertEvent(
        {
          ...condition,
          severity: 'warning',
          title: `${condition.title}（数据不可用）`,
          message: `连续 ${streak} 次无法评估：${condition.message}`,
          details: { ...condition.details, unknownStreak: streak, degraded: true },
        },
        'unknown',
        now,
      )
      this.db
        .prepare(
          `INSERT INTO alert_state (event, status, last_fired_at, last_ok_at) VALUES (?, 'unknown', ?, ?)
           ON CONFLICT(event) DO UPDATE SET status = 'unknown', last_fired_at = excluded.last_fired_at`,
        )
        .run(condition.event, event.created_at, state?.last_ok_at ?? null)
      return event
    })
  }

  /** 清理超过保留期的告警事件（按小时节流）。 */
  private pruneEventsIfDue(): void {
    const nowMs = this.deps.now().getTime()
    if (this.lastEventPruneAt > 0 && nowMs - this.lastEventPruneAt < EVENT_PRUNE_INTERVAL_MS) return
    this.lastEventPruneAt = nowMs
    const cutoff = new Date(nowMs - ALERT_EVENT_RETENTION_DAYS * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM alert_events WHERE created_at < ?').run(cutoff)
  }

  private insertEvent(condition: AlertCondition, status: 'firing' | 'resolved' | 'unknown', now: Date): AlertEventRow {
    const createdAt = now.toISOString()
    const result = this.db
      .prepare(
        `INSERT INTO alert_events (event, severity, status, title, message, details_json, created_at, delivered_at, delivery_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        condition.event,
        condition.severity,
        status,
        condition.title,
        condition.message,
        JSON.stringify(condition.details),
        createdAt,
      )
    return {
      id: Number(result.lastInsertRowid),
      event: condition.event,
      severity: condition.severity,
      status,
      title: condition.title,
      message: condition.message,
      details_json: JSON.stringify(condition.details),
      created_at: createdAt,
      delivered_at: null,
      delivery_error: null,
    }
  }

  // ---------- webhook ----------

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    const url = this.config.alertWebhookUrl.trim()
    let text = raw
    if (url) {
      text = text.split(url).join('[REDACTED]')
      try {
        const parsed = new URL(url)
        text = text.split(parsed.origin).join('[REDACTED]')
        text = text.split(parsed.host).join('[REDACTED]')
      } catch {
        // URL 非法时只做原文替换。
      }
    }
    return text.slice(0, 300)
  }

  private buildPayload(event: AlertEventRow, payloadEvent = event.event): string {
    let details: unknown = null
    if (event.details_json) {
      try {
        details = JSON.parse(event.details_json)
      } catch {
        details = null
      }
    }
    return JSON.stringify({
      source: 'antifieldcloud',
      version: this.config.appVersion,
      event: payloadEvent,
      severity: event.severity,
      status: event.status,
      title: event.title,
      message: event.message,
      details,
      at: event.created_at,
    })
  }

  /** 投递单个事件；返回是否成功。失败原因脱敏后写入 delivery_error。 */
  private async deliver(event: AlertEventRow): Promise<boolean> {
    const url = this.config.alertWebhookUrl.trim()
    if (!url) {
      this.markDelivery(event.id, null, '未配置 webhook URL')
      return false
    }
    const body = this.buildPayload(event)
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': `AntifieldCloud/${this.config.appVersion}`,
    }
    if (this.config.alertWebhookSecret) {
      const signature = createHmac('sha256', this.config.alertWebhookSecret).update(body).digest('hex')
      headers['x-antifieldcloud-signature'] = `sha256=${signature}`
    }
    let lastError = ''
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.deps.fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        })
        if (!response.ok) {
          lastError = `HTTP ${response.status}`
        } else {
          this.markDelivery(event.id, nowIso(), null)
          this.deps.log('info', '告警 webhook 已投递', { event: event.event, status: event.status })
          return true
        }
      } catch (error) {
        lastError = this.sanitizeError(error)
      }
      if (attempt < WEBHOOK_MAX_ATTEMPTS) await this.deps.sleep(attempt * 1000)
    }
    const reason = lastError || '未知错误'
    this.markDelivery(event.id, null, reason)
    this.deps.log('warn', '告警 webhook 投递失败', {
      event: event.event,
      status: event.status,
      attempts: WEBHOOK_MAX_ATTEMPTS,
      error: reason,
    })
    return false
  }

  private markDelivery(id: number, deliveredAt: string | null, error: string | null): void {
    this.db
      .prepare('UPDATE alert_events SET delivered_at = ?, delivery_error = ? WHERE id = ?')
      .run(deliveredAt, error, id)
  }

  // ---------- 查询与测试 ----------

  private toEventItem(row: AlertEventRow): AlertEventItem {
    let details: Record<string, unknown> | null = null
    if (row.details_json) {
      try {
        const parsed = JSON.parse(row.details_json)
        details = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      } catch {
        details = null
      }
    }
    return {
      id: row.id,
      event: row.event,
      severity: row.severity,
      status: row.status,
      title: row.title,
      message: row.message,
      details,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      deliveryError: row.delivery_error,
    }
  }

  configSummary(): AlertConfigSummary {
    return {
      enabled: this.config.alertsEnabled,
      webhookConfigured: this.config.alertWebhookUrl.trim().length > 0,
      webhookType: this.config.alertWebhookType,
      diskFreePct: this.config.alertDiskFreePct,
      tempC: this.config.alertTempC,
      memoryUsedPct: this.memoryUsedPct,
      backupMaxAgeHours: this.config.alertBackupMaxAgeHours,
      worldBackupMaxAgeHours: this.config.alertWorldBackupMaxAgeHours,
      drillMaxAgeDays: this.config.alertDrillMaxAgeDays,
      offsiteMaxAgeHours: this.config.alertOffsiteMaxAgeHours,
      cooldownMinutes: this.config.alertCooldownMinutes,
      checkIntervalSeconds: this.config.alertCheckIntervalSeconds,
      lastEvaluatedAt: this.lastEvaluatedAt,
    }
  }

  /**
   * 事件列表：可按 event/status/severity 过滤并分页，默认行为与旧版一致（最近 20 条）。
   * 同时返回当前告警状态与只读阈值配置。
   */
  list(options: AlertListQuery = {}): AlertListResult {
    const limit = Math.min(EVENT_LIMIT_MAX, Math.max(1, Math.floor(options.limit ?? EVENT_LIMIT_DEFAULT)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const conditions: string[] = []
    const params: (string | number)[] = []
    if (options.event) {
      conditions.push('event = ?')
      params.push(options.event)
    }
    if (options.status) {
      conditions.push('status = ?')
      params.push(options.status)
    }
    if (options.severity) {
      conditions.push('severity = ?')
      params.push(options.severity)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM alert_events ${where}`).get(...params) as { c: number }
    ).c
    const rows = this.db
      .prepare(`SELECT * FROM alert_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as AlertEventRow[]
    const states = this.db.prepare('SELECT * FROM alert_state ORDER BY event ASC').all() as unknown as AlertStateRow[]
    const stateItems: AlertStateItem[] = states.map((state) => {
      const last = this.db
        .prepare('SELECT title, severity, message, created_at, status FROM alert_events WHERE event = ? ORDER BY id DESC LIMIT 1')
        .get(state.event) as
        | { title: string; severity: string; message: string; created_at: string; status: string }
        | undefined
      return {
        event: state.event,
        status: state.status,
        lastFiredAt: state.last_fired_at,
        lastOkAt: state.last_ok_at,
        title: last?.title ?? null,
        severity: last?.severity ?? null,
        message: last?.message ?? null,
        lastEventAt: last?.created_at ?? null,
      }
    })
    return {
      items: rows.map((row) => this.toEventItem(row)),
      total: Number(total),
      state: stateItems,
      config: this.configSummary(),
    }
  }

  /** 发送一条测试告警（不参与状态机）；返回是否成功投递。 */
  async sendTest(): Promise<AlertTestResult> {
    const now = this.deps.now()
    const event: AlertEventRow = {
      id: 0,
      event: 'test',
      severity: 'info',
      status: 'firing',
      title: '测试告警',
      message: '这是一条来自 AntifieldCloud 的测试告警，无需处理。',
      details_json: JSON.stringify({ source: 'manual' }),
      created_at: now.toISOString(),
      delivered_at: null,
      delivery_error: null,
    }
    const result = this.db
      .prepare(
        `INSERT INTO alert_events (event, severity, status, title, message, details_json, created_at, delivered_at, delivery_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(event.event, event.severity, event.status, event.title, event.message, event.details_json, event.created_at)
    event.id = Number(result.lastInsertRowid)
    if (!this.config.alertWebhookUrl.trim()) {
      const message = '未配置 webhook URL'
      this.markDelivery(event.id, null, message)
      return { ok: false, delivered: false, message }
    }
    const delivered = await this.deliver(event)
    if (delivered) return { ok: true, delivered: true }
    const updated = this.db.prepare('SELECT delivery_error FROM alert_events WHERE id = ?').get(event.id) as
      | { delivery_error: string | null }
      | undefined
    return { ok: false, delivered: false, message: updated?.delivery_error ?? '投递失败' }
  }
}
