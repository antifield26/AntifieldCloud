/**
 * OpenCode 自主会话客户端：只暴露自主能力所需的 session / MCP 管理接口。
 *
 * 安全边界：仅允许固定 loopback OpenCode 地址；所有错误只暴露 HTTP 状态码，
 * 不返回上游响应体、Token、模型提示词或自由文本。工具执行仍由 mcbot MCP 服务端校验。
 */
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'

export type SessionErrorKind = 'http' | 'network' | 'timeout' | 'invalid' | 'aborted'

export class OpenCodeSessionError extends Error {
  readonly kind: SessionErrorKind
  readonly status: number | null

  constructor (kind: SessionErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'OpenCodeSessionError'
    this.kind = kind
    this.status = status
  }
}

export interface SessionPermission {
  action: string
  resource: string
  effect: 'allow' | 'deny'
}

export interface AutonomySessionClient {
  registerMcp: (name: string, url: string, bearer: string) => Promise<void>
  removeMcp: (name: string) => Promise<void>
  createSession: (title: string, permissions: SessionPermission[]) => Promise<string>
  prompt: (sessionId: string, text: string) => Promise<void>
  wait: (sessionId: string, signal?: AbortSignal) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  assistantText: (sessionId: string) => Promise<string>
}

type FetchLike = typeof fetch

interface FetchResult {
  status: number
  json: unknown
  text: string
}

function abortError (): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

export class OpenCodeSessionClient implements AutonomySessionClient {
  private readonly config: Config
  private readonly logger: Logger
  private readonly fetchImpl: FetchLike

  constructor (config: Config, logger: Logger, fetchImpl: FetchLike = fetch) {
    this.config = config
    this.logger = logger
    this.fetchImpl = fetchImpl
  }

  private authHeader (): string {
    const raw = `${this.config.opencodeUsername}:${this.config.opencodePassword}`
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
  }

  private async request (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    options: { timeoutMs?: number, signal?: AbortSignal } = {}
  ): Promise<FetchResult> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(abortError())
    if (options.signal?.aborted) throw new OpenCodeSessionError('aborted', 'request aborted')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(abortError()), options.timeoutMs ?? this.config.aiTimeoutMs)
    try {
      const response = await this.fetchImpl(`${this.config.opencodeUrl}${path}`, {
        method,
        headers: {
          authorization: this.authHeader(),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      })
      const text = await response.text()
      let json: unknown = null
      try { json = JSON.parse(text) } catch { /* non-JSON response is allowed for 204 */ }
      if (response.status < 200 || response.status >= 300) {
        throw new OpenCodeSessionError('http', `OpenCode session request failed: HTTP ${response.status}`, response.status)
      }
      return { status: response.status, json, text }
    } catch (error) {
      if (options.signal?.aborted) throw new OpenCodeSessionError('aborted', 'request aborted')
      if (controller.signal.aborted) throw new OpenCodeSessionError('timeout', 'OpenCode session request timed out')
      if (error instanceof OpenCodeSessionError) throw error
      throw new OpenCodeSessionError('network', 'OpenCode session service unavailable')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async registerMcp (name: string, url: string, bearer: string): Promise<void> {
    await this.request('PUT', `/api/experimental/mcp/${encodeURIComponent(name)}`, {
      config: {
        type: 'remote',
        url,
        headers: { Authorization: `Bearer ${bearer}` }
      }
    }, { timeoutMs: 15000 })
    this.logger.debug('autonomy mcp registered', { name })
  }

  async removeMcp (name: string): Promise<void> {
    await this.request('DELETE', `/api/experimental/mcp/${encodeURIComponent(name)}`, undefined, { timeoutMs: 15000 })
    this.logger.debug('autonomy mcp removed', { name })
  }

  async createSession (title: string, permissions: SessionPermission[]): Promise<string> {
    const result = await this.request('POST', '/api/session', {
      title,
      model: { id: this.config.aiModelId, providerID: this.config.aiModelProvider },
      permissions
    })
    const data = (result.json as { data?: { id?: unknown } } | null)?.data
    const id = typeof data?.id === 'string' ? data.id.trim() : ''
    if (!id) throw new OpenCodeSessionError('invalid', 'OpenCode did not return a session id')
    return id
  }

  async prompt (sessionId: string, text: string): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text })
  }

  async wait (sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      'POST',
      `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
      undefined,
      { timeoutMs: Math.min(this.config.autonomyMaxMinutes * 60_000 + 30_000, 900_000), signal }
    )
  }

  async interrupt (sessionId: string): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`, undefined, { timeoutMs: 5000 })
  }

  async deleteSession (sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/session/${encodeURIComponent(sessionId)}`, undefined, { timeoutMs: 10000 })
  }

  async assistantText (sessionId: string): Promise<string> {
    const result = await this.request(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=20&type=assistant`,
      undefined,
      { timeoutMs: 10000 }
    )
    const rows = (result.json as { data?: unknown } | null)?.data
    if (!Array.isArray(rows)) return ''
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const content = (row as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      const text = content
        .filter(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
        .map(part => String((part as { text?: unknown }).text ?? ''))
        .join('')
        .trim()
      if (text) return text.slice(0, 1000)
    }
    return ''
  }
}
