/**
 * Bot 适配器 HTTP 工具：超时、JSON 解析、平台错误归一化。
 * 安全边界：错误对象只含平台/状态码/脱敏错误码，不包含完整 URL（可能含 token）。
 */
export class BotPlatformError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec: number | null

  constructor(status: number, code: string, retryAfterSec: number | null = null) {
    super(`平台请求失败（${status}${code ? `:${code}` : ''}）`)
    this.name = 'BotPlatformError'
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function fetchJson(
  input: string,
  init: RequestInit,
  deps: { fetch?: typeof fetch } = {},
): Promise<{ status: number; body: unknown }> {
  const fetcher = deps.fetch ?? fetch
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetcher(input, { ...init, redirect: 'error', signal })
  } catch {
    throw new BotPlatformError(0, 'network')
  }
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    throw new BotPlatformError(response.status, 'response_too_large')
  }
  let body: unknown = null
  const rawText = await response.text().catch(() => '')
  const text = rawText.length > 1024 * 1024 ? rawText.slice(0, 1024 * 1024) : rawText
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = null
    }
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '')
    throw new BotPlatformError(
      response.status,
      platformErrorCode(body),
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
    )
  }
  return { status: response.status, body }
}

function platformErrorCode(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  const raw = record.error ?? record.description ?? record.message
  if (typeof raw === 'string') return raw.slice(0, 80)
  if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).message === 'string') {
    return ((raw as Record<string, unknown>).message as string).slice(0, 80)
  }
  const ok = record.ok
  if (ok === false && typeof record.error === 'string') return record.error.slice(0, 80)
  return ''
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0] ?? null
  return typeof raw === 'string' ? raw : null
}

export function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
