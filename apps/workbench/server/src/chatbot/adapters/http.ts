/**
 * Chatbot 适配器 HTTP 工具：超时、JSON 解析、平台错误归一化、入站图片下载与文本分段 partial 标记。
 * 安全边界：错误对象只含平台/状态码/脱敏错误码，不包含完整 URL（可能含 AppSecret）；
 * 图片下载只允许调用方给定的平台域名（精确匹配或后缀匹配），且错误码固定，不把 URL/响应正文带出。
 */
import type { ChatbotInboundImage } from '../types.ts'

/** 入站图片允许的 mime；仅这些类型会进入 AI 视觉链路（与 ai.ts 的 Data URL 白名单一致）。 */
const INBOUND_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** 归一化图片 mime；不在白名单内返回 null。 */
function normalizeImageMime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const mime = value.trim().toLowerCase()
  return INBOUND_IMAGE_MIMES.has(mime) ? mime : null
}

/** QQ 仅文本：分段发送失败时标记 chatbotPartialKind='text'，服务端据此禁止自动重试。 */
export function markPartialError<T>(error: T, sentExternalIds: string[]): T {
  if (error !== null && typeof error === 'object') {
    const target = error as { sentExternalIds?: string[]; chatbotPartialKind?: 'text' }
    if (sentExternalIds.length > 0) target.sentExternalIds = sentExternalIds
    target.chatbotPartialKind = 'text'
  }
  return error
}

export class ChatbotPlatformError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec: number | null

  constructor(status: number, code: string, retryAfterSec: number | null = null) {
    super(`平台请求失败（${status}${code ? `:${code}` : ''}）`)
    this.name = 'ChatbotPlatformError'
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
    throw new ChatbotPlatformError(0, 'network')
  }
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    throw new ChatbotPlatformError(response.status, 'response_too_large')
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
    throw new ChatbotPlatformError(
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

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000

export interface DownloadImageOptions {
  /** 调用方声明的图片 mime；不在白名单内直接 image_unsupported。 */
  image: ChatbotInboundImage
  /** 允许下载的最大字节数；平台声明或实际响应超限都返回 image_too_large。 */
  maxBytes: number
  timeoutMs?: number
  fetch?: typeof fetch
  headers?: Record<string, string>
  /** 固定平台域名白名单：主机名精确匹配；未提供时只看后缀白名单。 */
  allowedHosts?: readonly string[]
  /** 平台 CDN 后缀白名单（如 '.qpic.cn'）：必须以 '.' 开头，避免 evilqq.com 之类的伪装域名。 */
  allowedHostSuffixes?: readonly string[]
}

/** 主机名是否命中精确白名单或后缀白名单；后缀按完整 DNS 标签边界匹配。 */
function hostAllowed(hostname: string, options: DownloadImageOptions): boolean {
  const host = hostname.toLowerCase()
  if ((options.allowedHosts ?? []).some((item) => item.trim().toLowerCase() === host)) return true
  return (options.allowedHostSuffixes ?? []).some((item) => {
    const suffix = item.trim().toLowerCase()
    return suffix.startsWith('.') && host.endsWith(suffix)
  })
}

/**
 * 下载入站图片：固定域名 + https + mime 白名单 + 大小上限；只在内存返回 Buffer，不落盘。
 * 失败统一抛 ChatbotPlatformError 固定错误码（image_unsupported/image_too_large/image_download_failed），
 * 不透出 URL、host 或平台响应正文。
 */
export async function downloadImage(options: DownloadImageOptions): Promise<{ mime: string; data: Buffer }> {
  const declaredMime = normalizeImageMime(options.image.mime)
  if (!declaredMime) throw new ChatbotPlatformError(400, 'image_unsupported')
  const maxBytes = Number(options.maxBytes)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new ChatbotPlatformError(400, 'image_too_large')
  const declaredSize = Number(options.image.size)
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new ChatbotPlatformError(413, 'image_too_large')
  }
  let target: URL
  try {
    target = new URL(options.image.ref)
  } catch {
    throw new ChatbotPlatformError(400, 'image_unsupported')
  }
  if (target.protocol !== 'https:' || !hostAllowed(target.hostname, options)) {
    throw new ChatbotPlatformError(400, 'image_unsupported')
  }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : IMAGE_DOWNLOAD_TIMEOUT_MS
  const fetcher = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetcher(target.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: options.headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new ChatbotPlatformError(0, 'image_download_failed')
  }
  if (!response.ok) throw new ChatbotPlatformError(response.status, 'image_download_failed')
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ChatbotPlatformError(413, 'image_too_large')
  }
  let data: Buffer
  try {
    data = Buffer.from(await response.arrayBuffer())
  } catch {
    throw new ChatbotPlatformError(0, 'image_download_failed')
  }
  if (data.length > maxBytes) throw new ChatbotPlatformError(413, 'image_too_large')
  if (data.length === 0) throw new ChatbotPlatformError(400, 'image_download_failed')
  return { mime: declaredMime, data }
}
