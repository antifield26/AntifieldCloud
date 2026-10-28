/**
 * mcbot Bot HTTP 客户端（v0.8.0 只读/控制；v1.0.2 增加 AI 自主模式）。
 *
 * 安全边界：
 * - 上游地址由 config 校验为 loopback + http(s)；客户端始终 `redirect: 'error'`，
 *   避免被 302 引到外部主机后把 Token 发出去；每次请求带超时 AbortSignal，
 *   可由调用方传入额外 AbortSignal（进程关闭时中断在途请求）。
 * - 读 Token 只用于 /status、/autonomy、/events/recent、/history、/say；控制 Token
 *   只用于 /task/*、/move 与 /autonomy/start|stop；控制 Token 为空时控制方法直接返回
 *   mcbot_control_disabled。
 * - 错误统一为稳定 `McbotError`（code/statusCode/upstreamCode），message 会移除上游
 *   地址与两个 Token，绝不把 URL/Token 写进错误文本或日志。
 * - 响应体上限 2 MiB；非 JSON、5xx 统一映射为 mcbot_upstream_error。
 * - 自主快照只读取契约字段并截断文本；不含 run id/提示词/Token。
 * - fetch 可注入，测试不访问真实网络。
 */

/** 单次响应体上限：mcbot 是本地进程，正常响应远小于该值。 */
export const MCBOT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type McbotHistoryKind = 'samples' | 'alerts'

/** mcbot 事件 envelope（/events/recent 与 SSE 相同）。 */
export interface McbotEvent {
  id: string
  type: string
  ts: string
  data: unknown
}

export interface McbotRecentResult {
  contractVersion: number | null
  bootId: string
  lastEventId: string | null
  /** 与上游一致：旧 → 新排序。 */
  events: McbotEvent[]
}

export interface McbotHistoryQuery {
  from?: string
  to?: string
  limit?: number
}

/** 自主模式状态（与上游 mcbot 当前实现一致）；未知值原样保留，前端按字符串兜底展示。 */
export type McbotAutonomyState = 'idle' | 'starting' | 'running' | 'stopping' | 'finished' | 'failed'

/** mcbot AI 自主会话只读快照；不含 run id/提示词正文/Token。 */
export interface McbotAutonomySnapshot {
  enabled: boolean
  active: boolean
  state: McbotAutonomyState
  goal: string | null
  startedAt: string | null
  elapsedSec: number
  remainingSec: number
  toolCalls: number
  maxToolCalls: number
  lastAction: string | null
  lastReason: string | null
  lastError: string | null
  lastDecisionAt: string | null
}

/** 自主状态枚举；上游未来新增状态时保留原值（只用于 UI 兜底，不影响控制逻辑）。 */
const KNOWN_AUTONOMY_STATES = new Set<string>([
  'idle',
  'starting',
  'running',
  'stopping',
  'finished',
  'failed',
])

/** 快照文本字段上限：上游异常长文本不进入前端/日志。 */
const MAX_AUTONOMY_TEXT = 300
const MAX_AUTONOMY_GOAL = 200

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * 规范化上游 autonomy 快照：显式字段缺失/类型漂移时给安全默认值，
 * 未知 state 保留原字符串（前端 label 兜底），非对象返回 null（旧版 mcbot 无自主模式）。
 */
export function normalizeAutonomy(value: unknown): McbotAutonomySnapshot | null {
  if (!isRecord(value)) return null
  const rawState = typeof value.state === 'string' ? value.state.trim() : ''
  const state = KNOWN_AUTONOMY_STATES.has(rawState) ? rawState : rawState || 'idle'
  return {
    enabled: value.enabled === true,
    active: value.active === true,
    state: state as McbotAutonomyState,
    goal: boundedText(value.goal, MAX_AUTONOMY_GOAL),
    startedAt: boundedText(value.startedAt, MAX_AUTONOMY_TEXT),
    elapsedSec: nonNegativeNumber(value.elapsedSec),
    remainingSec: nonNegativeNumber(value.remainingSec),
    toolCalls: nonNegativeNumber(value.toolCalls),
    maxToolCalls: nonNegativeNumber(value.maxToolCalls),
    lastAction: boundedText(value.lastAction, MAX_AUTONOMY_TEXT),
    lastReason: boundedText(value.lastReason, MAX_AUTONOMY_TEXT),
    lastError: boundedText(value.lastError, MAX_AUTONOMY_TEXT),
    lastDecisionAt: boundedText(value.lastDecisionAt, MAX_AUTONOMY_TEXT),
  }
}

export interface McbotClientOptions {
  baseUrl: string
  readToken: string
  controlToken: string
  timeoutMs: number
  fetch?: typeof fetch
}

/** 上游 5xx 中可安全透传的稳定业务错误码（mcbot 用 503 表示任务/控制/历史/自主关闭）。 */
const STABLE_UPSTREAM_5XX_CODES = new Set([
  'task_disabled',
  'control_disabled',
  'history_disabled',
  'autonomy_disabled',
  'autonomy_unavailable',
  'autonomy_failed',
])

/** 稳定错误码；`mcbot_<upstream>` 表示上游明确业务错误。 */
export class McbotError extends Error {
  readonly code: string
  readonly statusCode: number | null
  readonly upstreamCode: string | null

  constructor(code: string, message: string, statusCode: number | null = null, upstreamCode: string | null = null) {
    super(message)
    this.name = 'McbotError'
    this.code = code
    this.statusCode = statusCode
    this.upstreamCode = upstreamCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toEvent(value: unknown): McbotEvent | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.type !== 'string' || !value.type) return null
  if (typeof value.ts !== 'string' || !value.ts) return null
  return { id: value.id, type: value.type, ts: value.ts, data: value.data }
}

/** 上游错误码只保留安全字符，避免把任意文本拼进错误码。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeCode(raw: string): string {
  const code = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 64)
  return code || 'upstream_error'
}

/** 只从错误体提取 error 字段；不信任其余字段。 */
function extractErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null
  const error = body.error
  if (typeof error === 'string' && error.trim()) return normalizeCode(error)
  if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) return normalizeCode(error.code)
  return null
}

function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) return null
  return typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null
}

export class McbotClient {
  private readonly baseUrl: string
  private readonly readToken: string
  private readonly controlToken: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: McbotClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.readToken = options.readToken
    this.controlToken = options.controlToken
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs))
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** /status 完整快照；只做对象校验，字段由上游契约保证。 */
  async status(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = await this.request('/status', { method: 'GET', token: this.readToken, signal })
    if (!isRecord(body)) throw new McbotError('mcbot_upstream_error', 'mcbot 状态响应格式不合法')
    return body
  }

  /** /autonomy 自主模式快照（读 Token）；旧版 mcbot 没有该接口时抛 mcbot_not_found。 */
  async autonomy(signal?: AbortSignal): Promise<McbotAutonomySnapshot> {
    const body = await this.request('/autonomy', { method: 'GET', token: this.readToken, signal })
    if (!isRecord(body)) throw new McbotError('mcbot_upstream_error', 'mcbot 自主模式响应格式不合法')
    const autonomy = normalizeAutonomy(body.autonomy)
    if (!autonomy) throw new McbotError('mcbot_upstream_error', 'mcbot 自主模式响应缺少 autonomy')
    return autonomy
  }

  /** /events/recent（v0.6.0+）；返回旧 → 新的最近事件与契约版本。 */
  async recentEvents(limit = 100, signal?: AbortSignal): Promise<McbotRecentResult> {
    const normalized = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100
    const body = await this.request(`/events/recent?limit=${normalized}`, {
      method: 'GET',
      token: this.readToken,
      signal,
    })
    if (!isRecord(body)) throw new McbotError('mcbot_upstream_error', 'mcbot 事件响应格式不合法')
    const bootId = typeof body.bootId === 'string' ? body.bootId : ''
    if (!bootId) throw new McbotError('mcbot_upstream_error', 'mcbot 事件响应缺少 bootId')
    const contractVersion =
      typeof body.contractVersion === 'number' && Number.isFinite(body.contractVersion) ? body.contractVersion : null
    const events = Array.isArray(body.events) ? body.events.map(toEvent).filter((event): event is McbotEvent => event !== null) : []
    return {
      contractVersion,
      bootId,
      lastEventId: typeof body.lastEventId === 'string' && body.lastEventId ? body.lastEventId : null,
      events,
    }
  }

  /** /history?kind=samples|alerts：原样返回上游响应体（kind/from/to/count/samples|alerts）。 */
  async history(
    kind: McbotHistoryKind,
    query: McbotHistoryQuery = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ kind })
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const body = await this.request(`/history?${params.toString()}`, { method: 'GET', token: this.readToken, signal })
    if (!isRecord(body)) throw new McbotError('mcbot_upstream_error', 'mcbot 历史响应格式不合法')
    if (body.kind !== kind) throw new McbotError('mcbot_upstream_error', 'mcbot 历史响应类型不匹配')
    const rows = body[kind]
    if (!Array.isArray(rows)) throw new McbotError('mcbot_upstream_error', 'mcbot 历史响应缺少数组')
    // 只透传对象行，避免畸形数组让前端 Table 渲染时解引用 null/原始值崩溃。
    return {
      ...body,
      [kind]: rows.filter((row): row is Record<string, unknown> => isRecord(row)),
    }
  }

  async startTask(name: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.control('/task/start', { name }, signal)
  }

  async stopTask(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.control('/task/stop', {}, signal)
  }

  async resumeTask(taskId?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.control('/task/resume', taskId ? { taskId } : {}, signal)
  }

  async move(action: string, target?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.control('/move', target ? { action, target } : { action }, signal)
  }

  /** /say 使用读 Token（与上游契约一致）；不执行任何斜杠命令。 */
  async say(message: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = await this.request('/say', { method: 'POST', token: this.readToken, payload: { message }, signal })
    if (!isRecord(body)) throw new McbotError('mcbot_upstream_error', 'mcbot 聊天响应格式不合法')
    return body
  }

  /** 启动自主模式（控制 Token）；目标由应用侧校验 1..200 字符。 */
  async startAutonomy(goal?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.control('/autonomy/start', goal ? { goal } : {}, signal)
  }

  /** 停止自主模式（控制 Token）；上游幂等，无活动会话时仍返回成功快照。 */
  async stopAutonomy(reason?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.control('/autonomy/stop', reason ? { reason } : {}, signal)
  }

  private async control(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.controlToken) {
      throw new McbotError('mcbot_control_disabled', 'mcbot 控制接口未启用（未配置控制 Token）')
    }
    const body = await this.request(path, { method: 'POST', token: this.controlToken, payload, signal })
    if (!isRecord(body)) throw new McbotError('mcbot_upstream_error', 'mcbot 响应格式不合法')
    return body
  }

  private async request(
    path: string,
    options: { method: 'GET' | 'POST'; token: string; payload?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${options.token}`,
    }
    if (options.payload !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    // 外部 signal 用于进程关闭时中断在途请求；与超时信号合并，任一触发即中止。
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
        // 允许 http(s) loopback；重定向直接失败，防止 Token 被带到其它主机。
        redirect: 'error',
        signal,
      })
    } catch {
      // 网络错误/超时/重定向拒绝/调用方中止：不暴露底层 message（可能包含 URL）。
      throw new McbotError('mcbot_unavailable', 'mcbot 服务不可用')
    }

    let raw: Uint8Array
    try {
      raw = await this.readCappedBody(response)
    } catch (error) {
      if (error instanceof McbotError) throw error
      throw new McbotError('mcbot_unavailable', 'mcbot 响应读取失败')
    }
    const text = new TextDecoder().decode(raw)
    let parsed: unknown = null
    let parsedOk = false
    if (text.trim()) {
      try {
        parsed = JSON.parse(text)
        parsedOk = true
      } catch {
        parsedOk = false
      }
    }

    if (!response.ok) {
      throw this.mapHttpError(response.status, parsed)
    }
    if (!parsedOk) {
      throw new McbotError('mcbot_upstream_error', 'mcbot 响应不是合法 JSON', response.status)
    }
    return parsed
  }

  /**
   * 流式读取并限制响应体大小：不能先 arrayBuffer() 再检查，否则 chunked/无长度响应
   * 会先把整个超大正文读入内存。Content-Length 超限时直接拒绝；未知长度边读边计数。
   */
  private async readCappedBody(response: Response): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MCBOT_MAX_RESPONSE_BYTES) {
      throw new McbotError('mcbot_upstream_error', 'mcbot 响应超过大小上限')
    }
    const body = response.body
    if (!body) {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MCBOT_MAX_RESPONSE_BYTES) {
        throw new McbotError('mcbot_upstream_error', 'mcbot 响应超过大小上限')
      }
      return new Uint8Array(buffer)
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        total += value.byteLength
        if (total > MCBOT_MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel()
          } catch {
            // 取消失败不影响拒绝结果。
          }
          throw new McbotError('mcbot_upstream_error', 'mcbot 响应超过大小上限')
        }
        chunks.push(value)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // reader 已关闭/取消时 release 可能抛错，忽略。
      }
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  private mapHttpError(status: number, parsed: unknown): McbotError {
    const rawCode = extractErrorCode(parsed)
    // 防御上游把 Token 回显进 error 字段：错误码也不得携带凭据。
    const upstreamCode = rawCode && !this.containsSecret(rawCode) ? rawCode : rawCode ? 'invalid_request' : null
    const upstreamMessage = extractErrorMessage(parsed)
    if (status === 401 || status === 403) {
      return new McbotError('mcbot_auth_failed', 'mcbot 鉴权失败（Token 无效）', status)
    }
    if (status === 404) {
      return new McbotError(upstreamCode ? `mcbot_${upstreamCode}` : 'mcbot_not_found', 'mcbot 接口不存在', status, upstreamCode)
    }
    if (status >= 400 && status < 500) {
      const code = upstreamCode ?? 'invalid_request'
      return new McbotError(`mcbot_${code}`, this.sanitizeMessage(upstreamMessage ?? 'mcbot 请求被拒绝'), status, code)
    }
    if (status >= 500 && upstreamCode && STABLE_UPSTREAM_5XX_CODES.has(upstreamCode)) {
      return new McbotError(
        `mcbot_${upstreamCode}`,
        this.sanitizeMessage(upstreamMessage ?? 'mcbot 功能未启用'),
        status,
        upstreamCode,
      )
    }
    return new McbotError('mcbot_upstream_error', `mcbot 上游错误（HTTP ${status}）`, status)
  }

  /** 上游 message 可能包含地址（如错误栈）；移除本机地址与两个 Token（大小写不敏感）。 */
  private sanitizeMessage(message: string): string {
    let text = message
    for (const secret of [this.baseUrl, this.readToken, this.controlToken]) {
      if (secret) text = text.replace(new RegExp(escapeRegExp(secret), 'gi'), '[REDACTED]')
    }
    return text.slice(0, 200)
  }

  private containsSecret(value: string): boolean {
    const lowered = value.toLowerCase()
    const normalized = normalizeCode(value)
    for (const secret of [this.readToken, this.controlToken]) {
      if (!secret) continue
      if (lowered.includes(secret.toLowerCase())) return true
      // normalizeCode 会把 '-'/'+' 等变成 '_'：同时比较变换后的 Token，避免编码变体回显。
      const normalizedSecret = normalizeCode(secret)
      if (normalizedSecret.length >= 8 && normalized.includes(normalizedSecret)) return true
    }
    return false
  }
}
