/**
 * mcbot 服务：轮询 mcbot Bot（仅 loopback）的 /status 与 /events/recent，缓存最新状态与事件，
 * 把上游 `alert` 事件映射为本应用告警（status=event，不写 alert_state），并提供控制代理
 * （任务/移动/聊天/AI 自主模式）。
 *
 * 安全与行为约束：
 * - 轮询单飞（single-flight）：上一轮未结束时复用同一 Promise，绝不并发/堆积请求。
 * - 轮询失败只更新 reachable/stale/error，保留上一次成功的状态快照与事件缓存。
 * - /events/recent 返回 404（旧版 mcbot 无事件流）只把 eventsSupported 置 false，/status 仍可用。
 * - /status 可选 autonomy 段：旧版缺失时快照 autonomy=null，前端隐藏自主控制；不伪造状态。
 * - 告警游标持久化在 meta `mcbot.event_cursor`（{bootId,lastEventId,lastTs}）：
 *   首次/无游标/bootId 变化只建立基线，不重放 ring 内旧告警；之后只处理游标之后的 alert，
 *   并按游标去重。MCBOT_ALERTS_ENABLED=false 时仍推进游标但不写告警。
 * - 聊天事件只进内存缓存（最多 100 条，newest-first），不落库、不写日志。
 * - 控制成功后立即刷新一次；start()/stop() 的定时器 unref，不阻止进程退出。
 * - stop() 为异步收口：置停止标记 → 中止在途请求 → await 在途轮询；停止后不再写状态/事件/
 *   告警游标，避免进程关闭过程中留下半截游标。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AlertService, AlertSeverity, ExternalAlertInput } from '../alerts/service.ts'
import type { Config } from '../config.ts'
import { getMeta, setMeta } from '../db.ts'
import {
  McbotClient,
  McbotError,
  normalizeAutonomy,
  type McbotAutonomySnapshot,
  type McbotEvent,
  type McbotHistoryKind,
  type McbotHistoryQuery,
  type McbotRecentResult,
} from './client.ts'

/** 告警游标 meta key；JSON {bootId,lastEventId,lastTs}。 */
export const MCBOT_EVENT_CURSOR_KEY = 'mcbot.event_cursor'
/** 事件内存缓存上限（API 最多返回 100 条）。 */
export const MCBOT_EVENT_CACHE_LIMIT = 100
/** 事件缓存总的序列化字节上限；防止大量大 JSON 事件长期占用内存。 */
export const MCBOT_EVENT_CACHE_MAX_BYTES = 512 * 1024
/** 每轮向上游最多取 200 条（ring 500），覆盖一次突发，避免只看 100 条漏告警。 */
export const MCBOT_EVENT_POLL_LIMIT = 200
/** 连续多少次轮询间隔没有成功（3 个 poll 周期）判定 stale。 */
export const MCBOT_STALE_POLLS = 3

export interface McbotAlertCursor {
  bootId: string
  lastEventId: string | null
  lastTs: string | null
}

export interface McbotServiceDeps {
  db: DatabaseSync
  config: Config
  alerts: Pick<AlertService, 'recordExternal'>
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  /** 测试注入；默认按 config 构建。 */
  client?: McbotClient
  /** 测试注入时钟；默认 new Date()。 */
  now?: () => Date
}

export interface McbotSnapshot {
  enabled: boolean
  reachable: boolean
  stale: boolean
  controlEnabled: boolean
  alertsEnabled: boolean
  /** 上游是否支持 /events/recent（旧版返回 404 时为 false）。 */
  eventsSupported: boolean
  version: string | null
  contractVersion: number | null
  lastPollAt: string | null
  error: string | null
  status: Record<string, unknown> | null
  /** AI 自主模式快照；旧版 mcbot 或尚未启用时 null（前端隐藏/降级）。 */
  autonomy: McbotAutonomySnapshot | null
  /** newest-first，最多 100 条。 */
  events: McbotEvent[]
}

export interface McbotPollResult {
  skipped: boolean
  ok: boolean
  error: string | null
  alerts: number
}

interface McbotAlertMapping {
  event: string
  severity: AlertSeverity
  title: string
}

/** 上游告警类型 → 本应用稳定事件名/级别（未知类型统一 mcbot_alert）。 */
export const MCBOT_ALERT_MAP: Record<string, McbotAlertMapping> = {
  low_health: { event: 'mcbot_low_health', severity: 'warning', title: 'mcbot 血量偏低' },
  task_failed: { event: 'mcbot_task_failed', severity: 'critical', title: 'mcbot 任务失败' },
  disconnected: { event: 'mcbot_disconnected', severity: 'critical', title: 'mcbot 连接断开' },
  chest_full: { event: 'mcbot_chest_full', severity: 'warning', title: 'mcbot 储物箱已满' },
  defense_retreat: { event: 'mcbot_defense_retreat', severity: 'warning', title: 'mcbot 防御撤退' },
}

const MAX_DETAILS_DEPTH = 2
const MAX_DETAILS_KEYS = 20
const MAX_DETAILS_ARRAY = 20
const MAX_DETAIL_STRING = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 递归清洗上游 details：只保留 JSON 基础类型，限制深度/键数/数组长度/字符串长度。 */
function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, MAX_DETAIL_STRING)
  if (depth >= MAX_DETAILS_DEPTH) return null
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAILS_ARRAY).map((item) => sanitizeDetailValue(item, depth + 1))
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, item] of Object.entries(value)) {
      if (count >= MAX_DETAILS_KEYS) break
      const safeKey = key.slice(0, 40)
      // 跳过原型相关键，避免清洗结果被改写原型；普通对象保持可预测的深比较行为。
      if (safeKey === '__proto__' || safeKey === 'constructor' || safeKey === 'prototype') continue
      out[safeKey] = sanitizeDetailValue(item, depth + 1)
      count += 1
    }
    return out
  }
  return null
}

function sanitizeDetails(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDetailValue(value, 0) as Record<string, unknown>
}

/**
 * 把上游 alert envelope 映射为 ExternalAlertInput。
 * 非 alert 事件返回 null；未知 type 仍映射为 mcbot_alert（severity 按上游 error→critical）。
 */
export function mapLofiiAlert(event: McbotEvent): ExternalAlertInput | null {
  if (event.type !== 'alert') return null
  const data = isRecord(event.data) ? event.data : {}
  const mcbotType = typeof data.type === 'string' && data.type.trim() ? data.type.trim().slice(0, 64) : 'unknown'
  const known = Object.prototype.hasOwnProperty.call(MCBOT_ALERT_MAP, mcbotType)
    ? MCBOT_ALERT_MAP[mcbotType]
    : undefined
  const severity: AlertSeverity = known
    ? known.severity
    : data.severity === 'error'
      ? 'critical'
      : 'warning'
  const title = known?.title ?? 'mcbot 告警'
  const upstreamMessage = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : ''
  const message = (upstreamMessage || title).slice(0, 500)
  const upstreamDetails = isRecord(data.details) ? data.details : {}
  const details: Record<string, unknown> = {
    ...sanitizeDetails(upstreamDetails),
    source: 'mcbot',
    mcbotEventId: event.id,
    mcbotType,
  }
  return {
    event: known?.event ?? 'mcbot_alert',
    severity,
    title,
    message,
    details,
  }
}

/** 事件 id 形如 `<bootId>-<seq>`；解析出进程内序号用于游标跨窗口比较。 */
function eventSeq(id: string, bootId: string): number | null {
  const prefix = `${bootId}-`
  if (!id.startsWith(prefix)) return null
  const rest = id.slice(prefix.length)
  if (!/^\d+$/.test(rest)) return null
  const seq = Number(rest)
  return Number.isSafeInteger(seq) ? seq : null
}

/** 取游标之后的事件：优先按 ring 内位置定位，窗口外回退到序号/时间比较，无法判断则宁可不重复。 */
export function eventsAfterCursor(events: McbotEvent[], cursor: McbotAlertCursor): McbotEvent[] {
  if (!cursor.lastEventId) return []
  const index = events.findIndex((event) => event.id === cursor.lastEventId)
  if (index >= 0) return events.slice(index + 1)
  const cursorSeq = eventSeq(cursor.lastEventId, cursor.bootId)
  const cursorTs = cursor.lastTs ? Date.parse(cursor.lastTs) : Number.NaN
  return events.filter((event) => {
    const seq = eventSeq(event.id, cursor.bootId)
    if (cursorSeq !== null && seq !== null) return seq > cursorSeq
    const ts = Date.parse(event.ts)
    if (Number.isFinite(cursorTs) && Number.isFinite(ts)) return ts > cursorTs
    return false
  })
}

function compareEventsNewestFirst(a: McbotEvent, b: McbotEvent): number {
  const ta = Date.parse(a.ts)
  const tb = Date.parse(b.ts)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

function errorCodeOf(error: unknown): string {
  return error instanceof McbotError ? error.code : 'mcbot_upstream_error'
}

export class McbotService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly alerts: Pick<AlertService, 'recordExternal'>
  private readonly log: NonNullable<McbotServiceDeps['log']>
  private readonly client: McbotClient
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<McbotPollResult> | null = null
  /** 当前在途轮询的 AbortController：stop() 用它中止 status/recent 请求。 */
  private abortController: AbortController | null = null
  /** 停止标记：置位后不再发起轮询、不写状态/告警游标（异步 stop 收口）。 */
  private stopped = false
  private events: McbotEvent[] = []
  private statusSnapshot: Record<string, unknown> | null = null
  private autonomySnapshot: McbotAutonomySnapshot | null = null
  private version: string | null = null
  private contractVersion: number | null = null
  private lastPollAt: string | null = null
  private lastSuccessAt: number | null = null
  private reachable = false
  private eventsSupported = true
  private error: string | null = null
  /** 连续未成功轮询次数：从未成功过时用于判定 stale（3 个周期）。 */
  private failedPolls = 0
  /** 上一次记录到日志的错误，避免轮询失败期间每 5s 重复告警日志。 */
  private lastLoggedError: string | null = null

  constructor(deps: McbotServiceDeps) {
    this.db = deps.db
    this.config = deps.config
    this.alerts = deps.alerts
    this.now = deps.now ?? (() => new Date())
    this.log =
      deps.log ??
      ((level, message, detail) => {
        const line = detail ? `${message} ${JSON.stringify(detail)}` : message
        if (level === 'error') console.error(`[mcbot] ${line}`)
        else if (level === 'warn') console.warn(`[mcbot] ${line}`)
        else console.info(`[mcbot] ${line}`)
      })
    this.client =
      deps.client ??
      new McbotClient({
        baseUrl: this.config.mcbotUrl,
        readToken: this.config.mcbotReadToken,
        controlToken: this.config.mcbotControlToken,
        timeoutMs: this.config.mcbotTimeoutMs,
      })
  }

  // ---------- 生命周期 ----------

  /** 由进程入口在 listen 后调用；关闭状态下为空操作，重复调用幂等。 */
  start(): void {
    if (!this.config.mcbotEnabled || this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        this.log('error', 'mcbot 轮询异常', { error: errorCodeOf(error) })
      })
    }, this.config.mcbotPollMs)
    this.timer.unref?.()
    void this.pollOnce().catch((error: unknown) => {
      this.log('error', 'mcbot 轮询异常', { error: errorCodeOf(error) })
    })
  }

  /**
   * 异步停止轮询：置停止标记 → 清除定时器 → 中止在途请求 → await 在途轮询结束。
   * 幂等；未启动时调用也会中止可能存在的单次 pollOnce（测试/控制刷新场景）。
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.abortController?.abort()
    const pending = this.inFlight
    if (pending) {
      try {
        await pending
      } catch {
        // runPoll 自身不抛错；这里只防御注入实现的异常，停止流程不因轮询错误失败。
      }
    }
  }

  /** 是否已停止（诊断/测试用）。 */
  get isStopped(): boolean {
    return this.stopped
  }

  // ---------- 轮询 ----------

  /** 单次轮询；单飞：上一轮未完成时直接复用同一 Promise（测试与 refresh 也会用到）。 */
  pollOnce(): Promise<McbotPollResult> {
    if (!this.config.mcbotEnabled) {
      return Promise.resolve({ skipped: true, ok: false, error: 'mcbot_disabled', alerts: 0 })
    }
    // 已停止（进程关闭中）：不再发起任何上游请求/写库。
    if (this.stopped) return Promise.resolve({ skipped: true, ok: false, error: 'mcbot_stopped', alerts: 0 })
    if (this.inFlight) return this.inFlight
    const run = this.runPoll()
    this.inFlight = run
    const clear = (): void => {
      if (this.inFlight === run) this.inFlight = null
    }
    // runPoll 内部已捕获所有失败，这里只负责结束后清空单飞标记。
    void run.then(clear, clear)
    return run
  }

  /** 控制成功后立即刷新：若已有在途轮询先等它结束，再执行一轮保证拿到最新状态。 */
  async refresh(): Promise<McbotPollResult> {
    if (!this.config.mcbotEnabled) {
      return { skipped: true, ok: false, error: 'mcbot_disabled', alerts: 0 }
    }
    if (this.stopped) return { skipped: true, ok: false, error: 'mcbot_stopped', alerts: 0 }
    if (this.inFlight) {
      try {
        await this.inFlight
      } catch {
        // runPoll 自身不抛错；这里只防御注入实现的异常。
      }
    }
    return this.pollOnce()
  }

  private async runPoll(): Promise<McbotPollResult> {
    const startedAt = this.now()
    const controller = new AbortController()
    this.abortController = controller
    try {
      const [statusResult, recentResult] = await Promise.allSettled([
        this.client.status(controller.signal),
        this.client.recentEvents(MCBOT_EVENT_POLL_LIMIT, controller.signal),
      ])
      // stop() 已置停止标记：丢弃本轮结果，不更新缓存/不写告警游标（进程关闭收口）。
      if (this.stopped) return { skipped: true, ok: false, error: 'mcbot_stopped', alerts: 0 }
      this.lastPollAt = startedAt.toISOString()
      let error: string | null = null
      let alertCount = 0

      if (statusResult.status === 'fulfilled') {
        this.reachable = true
        this.statusSnapshot = statusResult.value
        this.autonomySnapshot = normalizeAutonomy(statusResult.value.autonomy)
        const version = statusResult.value.version
        if (typeof version === 'string' && version.trim()) this.version = version.trim()
        this.lastSuccessAt = startedAt.getTime()
        this.failedPolls = 0
      } else {
        this.reachable = false
        this.failedPolls += 1
        error = errorCodeOf(statusResult.reason)
      }

      if (recentResult.status === 'fulfilled') {
        this.eventsSupported = true
        this.contractVersion = recentResult.value.contractVersion
        this.mergeEvents(recentResult.value.events)
        try {
          alertCount = this.advanceCursor(recentResult.value)
        } catch (cause) {
          // 游标/告警写库失败不影响状态轮询；本轮 error 暴露给前端但不回滚已有缓存。
          this.log('warn', 'mcbot 告警游标处理失败', { error: errorCodeOf(cause) })
          if (!error) error = 'mcbot_cursor_failed'
        }
      } else if (recentResult.reason instanceof McbotError && recentResult.reason.statusCode === 404) {
        // 旧版 mcbot 没有 /events/recent：明确降级，状态仍可用。
        this.eventsSupported = false
        this.contractVersion = null
      } else if (!error) {
        error = errorCodeOf(recentResult.reason)
      }

      this.error = error
      // 只在错误状态变化时写一条日志：轮询失败期间不重复刷屏，恢复时记录一次。
      if (this.error !== this.lastLoggedError) {
        if (this.error) {
          this.log('warn', 'mcbot 上游不可用', { error: this.error, reachable: this.reachable })
        } else if (this.lastLoggedError) {
          this.log('info', 'mcbot 上游已恢复', { reachable: this.reachable, eventsSupported: this.eventsSupported })
        }
        this.lastLoggedError = this.error
      }
      return { skipped: false, ok: this.reachable && error === null, error, alerts: alertCount }
    } finally {
      if (this.abortController === controller) this.abortController = null
    }
  }

  /** 合并事件到内存缓存：按 id 去重、newest-first、最多 100 条且总字节有界。 */
  private mergeEvents(incoming: McbotEvent[]): void {
    if (incoming.length === 0) return
    const seen = new Set<string>()
    const merged: McbotEvent[] = []
    for (const event of [...incoming, ...this.events]) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      merged.push(event)
    }
    merged.sort(compareEventsNewestFirst)
    const bounded: McbotEvent[] = []
    let bytes = 0
    for (const event of merged) {
      if (bounded.length >= MCBOT_EVENT_CACHE_LIMIT) break
      let size: number
      try {
        size = Buffer.byteLength(JSON.stringify(event), 'utf8')
      } catch {
        // 不可序列化的事件不进入 UI 缓存；游标/告警处理仍使用原始事件。
        continue
      }
      if (bytes + size > MCBOT_EVENT_CACHE_MAX_BYTES) break
      bounded.push(event)
      bytes += size
    }
    this.events = bounded
  }

  // ---------- 告警游标 ----------

  private readCursor(): McbotAlertCursor | null {
    const raw = getMeta(this.db, MCBOT_EVENT_CURSOR_KEY)
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!isRecord(parsed)) return null
    const bootId = typeof parsed.bootId === 'string' ? parsed.bootId : ''
    if (!bootId) return null
    return {
      bootId,
      lastEventId: typeof parsed.lastEventId === 'string' && parsed.lastEventId ? parsed.lastEventId : null,
      lastTs: typeof parsed.lastTs === 'string' && parsed.lastTs ? parsed.lastTs : null,
    }
  }

  private writeCursor(cursor: McbotAlertCursor): void {
    // 停止后不得再写告警游标：进程关闭过程中的半截游标会让下次启动漏告警/重放。
    if (this.stopped) return
    const current = this.readCursor()
    if (
      current &&
      current.bootId === cursor.bootId &&
      current.lastEventId === cursor.lastEventId &&
      current.lastTs === cursor.lastTs
    ) {
      return
    }
    setMeta(this.db, MCBOT_EVENT_CURSOR_KEY, JSON.stringify(cursor))
  }

  /**
   * 推进告警游标并处理游标之后的 alert：
   * - 无游标/首次/bootId 变化：只记录基线，不重放旧 ring 告警。
   * - 告警开关关闭：仍推进游标，不写事件。
   * - 返回本轮写入的告警事件数。
   */
  private advanceCursor(recent: McbotRecentResult): number {
    if (this.stopped || !this.eventsSupported) return 0
    const lastEvent = recent.events.at(-1)
    const lastId = recent.lastEventId ?? lastEvent?.id ?? null
    const lastTs = lastEvent?.ts ?? null
    const cursor = this.readCursor()
    // 首次/无游标/bootId 变化：只建立基线，不重放 ring 内旧告警。
    if (!cursor || cursor.bootId !== recent.bootId) {
      this.writeCursor({ bootId: recent.bootId, lastEventId: lastId, lastTs })
      return 0
    }
    // 基线建立时 ring 为空（lastEventId=null）：之后出现的事件都是新的；ring 非空时按游标过滤。
    const after = cursor.lastEventId ? eventsAfterCursor(recent.events, cursor) : [...recent.events]
    let count = 0
    // 记录最后一条已完整处理的事件；告警写入失败时游标停在该事件，下一轮重试失败事件，
    // 避免“错误被吞掉但游标照常推进”导致告警永久丢失。
    let processed: McbotEvent | null = null
    for (const event of after) {
      if (event.type === 'alert' && this.config.mcbotAlertsEnabled) {
        const input = mapLofiiAlert(event)
        if (input) {
          try {
            if (this.alerts.recordExternal(input) !== null) count += 1
          } catch (cause) {
            this.log('warn', 'mcbot 告警写入失败', {
              error: errorCodeOf(cause),
              mcbotEventId: event.id,
              mcbotType: input.details.mcbotType,
            })
            if (processed) {
              this.writeCursor({
                bootId: recent.bootId,
                lastEventId: processed.id,
                lastTs: processed.ts,
              })
            }
            return count
          }
        }
      }
      processed = event
    }
    this.writeCursor({
      bootId: recent.bootId,
      lastEventId: lastId ?? processed?.id ?? cursor.lastEventId,
      lastTs: lastTs ?? processed?.ts ?? cursor.lastTs,
    })
    return count
  }

  // ---------- 查询 ----------

  get enabled(): boolean {
    return this.config.mcbotEnabled
  }

  get controlEnabled(): boolean {
    return this.config.mcbotEnabled && this.config.mcbotControlToken.length > 0
  }

  get alertsEnabled(): boolean {
    return this.config.mcbotAlertsEnabled
  }

  get supportsEvents(): boolean {
    return this.eventsSupported
  }

  /** 当前状态快照（禁用时返回 enabled:false 的空壳）。 */
  snapshot(): McbotSnapshot {
    if (!this.config.mcbotEnabled) {
      return {
        enabled: false,
        reachable: false,
        stale: false,
        controlEnabled: false,
        alertsEnabled: this.config.mcbotAlertsEnabled,
        eventsSupported: false,
        version: null,
        contractVersion: null,
        lastPollAt: null,
        error: null,
        status: null,
        autonomy: null,
        events: [],
      }
    }
    return {
      enabled: true,
      reachable: this.reachable,
      stale: this.isStale(),
      controlEnabled: this.controlEnabled,
      alertsEnabled: this.config.mcbotAlertsEnabled,
      eventsSupported: this.eventsSupported,
      version: this.version,
      contractVersion: this.contractVersion,
      lastPollAt: this.lastPollAt,
      error: this.error,
      status: this.statusSnapshot,
      autonomy: this.autonomySnapshot,
      events: [...this.events],
    }
  }

  /** stale：未连通且（从未成功过时已连续失败 3 轮，或距上次成功超过 3 个轮询周期）。 */
  private isStale(): boolean {
    if (this.reachable) return false
    if (this.lastSuccessAt === null) return this.failedPolls >= MCBOT_STALE_POLLS
    return this.now().getTime() - this.lastSuccessAt > MCBOT_STALE_POLLS * this.config.mcbotPollMs
  }

  // ---------- 控制代理（成功即刷新） ----------

  async startTask(name: string): Promise<Record<string, unknown>> {
    return this.control(() => this.client.startTask(name))
  }

  async stopTask(): Promise<Record<string, unknown>> {
    return this.control(() => this.client.stopTask())
  }

  async resumeTask(taskId?: string): Promise<Record<string, unknown>> {
    return this.control(() => this.client.resumeTask(taskId))
  }

  async move(action: string, target?: string): Promise<Record<string, unknown>> {
    return this.control(() => this.client.move(action, target))
  }

  /** /say 使用读 Token，只读模式（无控制 Token）下仍可用。 */
  async say(message: string): Promise<Record<string, unknown>> {
    if (!this.config.mcbotEnabled) throw new McbotError('mcbot_disabled', 'mcbot 对接未启用')
    const result = await this.client.say(message)
    await this.refresh()
    return result
  }

  async history(kind: McbotHistoryKind, query: McbotHistoryQuery = {}): Promise<Record<string, unknown>> {
    if (!this.config.mcbotEnabled) throw new McbotError('mcbot_disabled', 'mcbot 对接未启用')
    return this.client.history(kind, query)
  }

  /** 读取 /autonomy 实时快照；成功即更新缓存（旧版 mcbot 无该接口时由路由映射错误）。 */
  async autonomy(): Promise<McbotAutonomySnapshot> {
    if (!this.config.mcbotEnabled) throw new McbotError('mcbot_disabled', 'mcbot 对接未启用')
    if (this.stopped) throw new McbotError('mcbot_unavailable', 'mcbot 服务不可用')
    const snapshot = await this.client.autonomy()
    this.autonomySnapshot = snapshot
    return snapshot
  }

  /** 启动自主模式；返回上游快照（响应缺少 autonomy 时回落为最近一次状态轮询结果）。 */
  async startAutonomy(goal?: string): Promise<{ ok: true; autonomy: McbotAutonomySnapshot | null }> {
    return this.controlAutonomy(() => this.client.startAutonomy(goal))
  }

  /** 停止自主模式；上游幂等，无活动会话也返回成功快照。 */
  async stopAutonomy(reason?: string): Promise<{ ok: true; autonomy: McbotAutonomySnapshot | null }> {
    return this.controlAutonomy(() => this.client.stopAutonomy(reason))
  }

  async presence(): Promise<Record<string, unknown>> {
    if (!this.config.mcbotEnabled) throw new McbotError('mcbot_disabled', 'mcbot 对接未启用')
    return this.client.presence()
  }

  async setPresence(mode: string): Promise<Record<string, unknown>> {
    return this.control(() => this.client.setPresence(mode))
  }

  async goals(limit = 20): Promise<Record<string, unknown>> {
    if (!this.config.mcbotEnabled) throw new McbotError('mcbot_disabled', 'mcbot 对接未启用')
    return this.client.goals(limit)
  }

  async createGoal(objective: string, steps: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.control(() => this.client.createGoal(objective, steps))
  }

  async goalAction(goalId: string, action: 'start' | 'pause' | 'resume' | 'cancel'): Promise<Record<string, unknown>> {
    return this.control(() => this.client.goalAction(goalId, action))
  }

  private async controlAutonomy(
    run: () => Promise<Record<string, unknown>>,
  ): Promise<{ ok: true; autonomy: McbotAutonomySnapshot | null }> {
    // 控制响应中的快照是本次动作的权威结果；control() 随后刷新 /status 可能短暂滞后，
    // 因此返回动作响应里的快照（缺失时回落为最近一次轮询缓存）。
    let responded: McbotAutonomySnapshot | null = null
    await this.control(async () => {
      const body = await run()
      const autonomy = normalizeAutonomy(body.autonomy)
      if (autonomy) {
        responded = autonomy
        this.autonomySnapshot = autonomy
      }
      return body
    })
    return { ok: true, autonomy: responded ?? this.autonomySnapshot }
  }

  private async control<T>(run: () => Promise<T>): Promise<T> {
    if (!this.config.mcbotEnabled) throw new McbotError('mcbot_disabled', 'mcbot 对接未启用')
    if (!this.controlEnabled) {
      throw new McbotError('mcbot_control_disabled', 'mcbot 控制接口未启用（未配置控制 Token）')
    }
    const result = await run()
    await this.refresh()
    return result
  }
}
