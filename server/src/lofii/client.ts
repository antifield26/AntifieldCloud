/**
 * Lofii Bot HTTP 客户端（v0.8.0 只读/控制）。
 *
 * 安全边界：
 * - 上游地址由 config 校验为 loopback + http(s)；客户端始终 `redirect: 'error'`，
 *   避免被 302 引到外部主机后把 Token 发出去；每次请求带超时 AbortSignal。
 * - 读 Token 只用于 /status、/events/recent、/history、/say；控制 Token 只用于
 *   /task/* 与 /move；控制 Token 为空时控制方法直接返回 lofii_control_disabled。
 * - 错误统一为稳定 `LofiiError`（code/statusCode/upstreamCode），message 会移除上游
 *   地址与两个 Token，绝不把 URL/Token 写进错误文本或日志。
 * - 响应体上限 2 MiB；非 JSON、5xx 统一映射为 lofii_upstream_error。
 * - fetch 可注入，测试不访问真实网络。
 */

/** 单次响应体上限：Lofii 是本地进程，正常响应远小于该值。 */
export const LOFII_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type LofiiHistoryKind = 'samples' | 'alerts'

/** Lofii 事件 envelope（/events/recent 与 SSE 相同）。 */
export interface LofiiEvent {
  id: string
  type: string
  ts: string
  data: unknown
}

export interface LofiiRecentResult {
  contractVersion: number | null
  bootId: string
  lastEventId: string | null
  /** 与上游一致：旧 → 新排序。 */
  events: LofiiEvent[]
}

export interface LofiiHistoryQuery {
  from?: string
  to?: string
  limit?: number
}

export interface LofiiClientOptions {
  baseUrl: string
  readToken: string
  controlToken: string
  timeoutMs: number
  fetch?: typeof fetch
}

/** 稳定错误码；`lofii_<upstream>` 表示上游 4xx 明确错误。 */
export class LofiiError extends Error {
  readonly code: string
  readonly statusCode: number | null
  readonly upstreamCode: string | null

  constructor(code: string, message: string, statusCode: number | null = null, upstreamCode: string | null = null) {
    super(message)
    this.name = 'LofiiError'
    this.code = code
    this.statusCode = statusCode
    this.upstreamCode = upstreamCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toEvent(value: unknown): LofiiEvent | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.type !== 'string' || !value.type) return null
  if (typeof value.ts !== 'string' || !value.ts) return null
  return { id: value.id, type: value.type, ts: value.ts, data: value.data }
}

/** 上游错误码只保留安全字符，避免把任意文本拼进错误码。 */
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

export class LofiiClient {
  private readonly baseUrl: string
  private readonly readToken: string
  private readonly controlToken: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: LofiiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.readToken = options.readToken
    this.controlToken = options.controlToken
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs))
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** /status 完整快照；只做对象校验，字段由上游契约保证。 */
  async status(): Promise<Record<string, unknown>> {
    const body = await this.request('/status', { method: 'GET', token: this.readToken })
    if (!isRecord(body)) throw new LofiiError('lofii_upstream_error', 'Lofii 状态响应格式不合法')
    return body
  }

  /** /events/recent（v0.6.0+）；返回旧 → 新的最近事件与契约版本。 */
  async recentEvents(limit = 100): Promise<LofiiRecentResult> {
    const normalized = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100
    const body = await this.request(`/events/recent?limit=${normalized}`, { method: 'GET', token: this.readToken })
    if (!isRecord(body)) throw new LofiiError('lofii_upstream_error', 'Lofii 事件响应格式不合法')
    const bootId = typeof body.bootId === 'string' ? body.bootId : ''
    if (!bootId) throw new LofiiError('lofii_upstream_error', 'Lofii 事件响应缺少 bootId')
    const contractVersion =
      typeof body.contractVersion === 'number' && Number.isFinite(body.contractVersion) ? body.contractVersion : null
    const events = Array.isArray(body.events) ? body.events.map(toEvent).filter((event): event is LofiiEvent => event !== null) : []
    return {
      contractVersion,
      bootId,
      lastEventId: typeof body.lastEventId === 'string' && body.lastEventId ? body.lastEventId : null,
      events,
    }
  }

  /** /history?kind=samples|alerts：原样返回上游响应体（kind/from/to/count/samples|alerts）。 */
  async history(kind: LofiiHistoryKind, query: LofiiHistoryQuery = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ kind })
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const body = await this.request(`/history?${params.toString()}`, { method: 'GET', token: this.readToken })
    if (!isRecord(body)) throw new LofiiError('lofii_upstream_error', 'Lofii 历史响应格式不合法')
    return body
  }

  async startTask(name: string): Promise<Record<string, unknown>> {
    return this.control('/task/start', { name })
  }

  async stopTask(): Promise<Record<string, unknown>> {
    return this.control('/task/stop', {})
  }

  async resumeTask(taskId?: string): Promise<Record<string, unknown>> {
    return this.control('/task/resume', taskId ? { taskId } : {})
  }

  async move(action: string, target?: string): Promise<Record<string, unknown>> {
    return this.control('/move', target ? { action, target } : { action })
  }

  /** /say 使用读 Token（与上游契约一致）；不执行任何斜杠命令。 */
  async say(message: string): Promise<Record<string, unknown>> {
    const body = await this.request('/say', { method: 'POST', token: this.readToken, payload: { message } })
    if (!isRecord(body)) throw new LofiiError('lofii_upstream_error', 'Lofii 聊天响应格式不合法')
    return body
  }

  private async control(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.controlToken) {
      throw new LofiiError('lofii_control_disabled', 'Lofii 控制接口未启用（未配置控制 Token）')
    }
    const body = await this.request(path, { method: 'POST', token: this.controlToken, payload })
    if (!isRecord(body)) throw new LofiiError('lofii_upstream_error', 'Lofii 响应格式不合法')
    return body
  }

  private async request(
    path: string,
    options: { method: 'GET' | 'POST'; token: string; payload?: Record<string, unknown> },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${options.token}`,
    }
    if (options.payload !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
        // 允许 http(s) loopback；重定向直接失败，防止 Token 被带到其它主机。
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      // 网络错误/超时/重定向拒绝：不暴露底层 message（可能包含 URL）。
      throw new LofiiError('lofii_unavailable', 'Lofii 服务不可用')
    }

    let raw: ArrayBuffer
    try {
      raw = await response.arrayBuffer()
    } catch {
      throw new LofiiError('lofii_unavailable', 'Lofii 响应读取失败')
    }
    if (raw.byteLength > LOFII_MAX_RESPONSE_BYTES) {
      throw new LofiiError('lofii_upstream_error', 'Lofii 响应超过大小上限')
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
      throw new LofiiError('lofii_upstream_error', 'Lofii 响应不是合法 JSON', response.status)
    }
    return parsed
  }

  private mapHttpError(status: number, parsed: unknown): LofiiError {
    const rawCode = extractErrorCode(parsed)
    // 防御上游把 Token 回显进 error 字段：错误码也不得携带凭据。
    const upstreamCode = rawCode && !this.containsSecret(rawCode) ? rawCode : rawCode ? 'invalid_request' : null
    const upstreamMessage = extractErrorMessage(parsed)
    if (status === 401 || status === 403) {
      return new LofiiError('lofii_auth_failed', 'Lofii 鉴权失败（Token 无效）', status)
    }
    if (status === 404) {
      return new LofiiError(upstreamCode ? `lofii_${upstreamCode}` : 'lofii_not_found', 'Lofii 接口不存在', status, upstreamCode)
    }
    if (status >= 400 && status < 500) {
      const code = upstreamCode ?? 'invalid_request'
      return new LofiiError(`lofii_${code}`, this.sanitizeMessage(upstreamMessage ?? 'Lofii 请求被拒绝'), status, code)
    }
    return new LofiiError('lofii_upstream_error', `Lofii 上游错误（HTTP ${status}）`, status)
  }

  /** 上游 message 可能包含地址（如错误栈）；移除本机地址与两个 Token。 */
  private sanitizeMessage(message: string): string {
    let text = message
    for (const secret of [this.baseUrl, this.readToken, this.controlToken]) {
      if (secret) text = text.split(secret).join('[REDACTED]')
    }
    return text.slice(0, 200)
  }

  private containsSecret(value: string): boolean {
    for (const secret of [this.readToken, this.controlToken]) {
      if (secret && value.includes(secret)) return true
    }
    return false
  }
}
