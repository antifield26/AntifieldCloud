// 统一 HTTP 客户端。
// 职责：同源 fetch、credentials include、自动附带 CSRF 头、统一错误解析、401 会话失效回调。
// 安全边界：不把密码、TOTP、恢复码写日志；不解析文件 ID 含义；错误信息只保留服务端可展示文案。

import type {
  AuditPage,
  ClearTrashResult,
  DashboardData,
  FileDetailResult,
  FileItem,
  FileListQuery,
  FileListResult,
  FileSearchResult,
  LoginResult,
  MeResult,
  MinecraftStatus,
  OkResult,
  PasswordChallenge,
  TextPreviewResult,
  TrashListResult,
  UploadResult,
  VersionResult,
  WhitelistMutationResult,
  WhitelistResult,
} from './types'

const CSRF_COOKIE = 'af_csrf'
const CSRF_HEADER = 'X-CSRF-Token'
const JSON_HEADERS = { Accept: 'application/json' }

/** 常见错误码的中文兜底文案；服务端返回的 message 优先。 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_request: '请求参数有误',
  unauthenticated: '登录状态已失效，请重新登录',
  csrf_failed: '安全校验失败，请刷新页面后重试',
  not_found: '请求的资源不存在',
  conflict: '操作冲突，请刷新后重试',
  already_exists: '同名内容已存在',
  quota_exceeded: '空间不足，请清理文件后重试',
  file_too_large: '文件超过大小限制',
  unsupported_media_type: '不支持的文件类型',
  rate_limited: '尝试次数过多，请稍后再试',
  internal_error: '服务器内部错误，请稍后重试',
  insufficient_storage: '存储空间不足',
  invalid_credentials: '用户名或密码错误',
  invalid_code: '验证码或恢复码无效',
  challenge_expired: '验证已过期，请重新登录',
  rcon_unavailable: 'RCON 不可用，暂时无法读取或修改白名单',
  already_whitelisted: '该玩家已在白名单中',
  not_whitelisted: '该玩家不在白名单中',
  invalid_name: '名称不合法',
  cycle_detected: '不能把文件夹移动到自身或子目录中',
  network_error: '网络连接失败，请检查网络后重试',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec: number | null

  constructor(status: number, code: string, message: string, retryAfterSec: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

/** 把任意异常转成可展示的中文文案。 */
export function toErrorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiError && error.message) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  if (!(error instanceof ApiError)) return false
  return code === undefined || error.code === code
}

let csrfToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function getCsrfToken(): string | null {
  if (csrfToken) return csrfToken
  return readCookie(CSRF_COOKIE)
}

/** 由 AuthContext 注册：任意 API 会话失效时清空登录态。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  for (const chunk of document.cookie.split('; ')) {
    if (!chunk.startsWith(prefix)) continue
    try {
      return decodeURIComponent(chunk.slice(prefix.length))
    } catch {
      return null
    }
  }
  return null
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null
  const seconds = Number(headerValue)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = new Date(headerValue)
  if (Number.isNaN(date.getTime())) return null
  return Math.max(0, Math.round((date.getTime() - Date.now()) / 1000))
}

function parseErrorBody(body: unknown, status: number, retryAfterHeader: number | null): ApiError {
  let code = status === 401 ? 'unauthenticated' : 'internal_error'
  let message = ''
  let retryAfterSec = retryAfterHeader

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const nested = record.error
    if (typeof record.retryAfterSec === 'number') retryAfterSec = record.retryAfterSec
    if (nested && typeof nested === 'object') {
      const detail = nested as Record<string, unknown>
      if (typeof detail.code === 'string' && detail.code) code = detail.code
      if (typeof detail.message === 'string') message = detail.message
      if (typeof detail.retryAfterSec === 'number') retryAfterSec = detail.retryAfterSec
    } else if (typeof record.message === 'string') {
      message = record.message
    }
  }

  if (!message) message = ERROR_MESSAGES[code] ?? `请求失败（HTTP ${status}）`
  return new ApiError(status, code, message, retryAfterSec)
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  /** 认证类请求（如登录）不触发全局 401 跳转。 */
  skipAuthRedirect?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { ...JSON_HEADERS }
  let body: BodyInit | undefined

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    body = JSON.stringify(options.body)
  }
  if (method !== 'GET') {
    const token = getCsrfToken()
    if (token) headers[CSRF_HEADER] = token
  }

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'include',
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'network_error', ERROR_MESSAGES.network_error ?? '网络连接失败')
  }

  if (!response.ok) {
    const error = parseErrorBody(await readJsonBody(response), response.status, parseRetryAfter(response.headers.get('Retry-After')))
    if (error.status === 401 && error.code === 'unauthenticated' && !options.skipAuthRedirect) {
      unauthorizedHandler?.()
    }
    throw error
  }

  if (response.status === 204) return undefined as T
  const payload = await readJsonBody(response)
  return payload as T
}

function get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' })
}

function post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body })
}

function patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'PATCH', body })
}

function del<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' })
}

function encodeId(value: string): string {
  return encodeURIComponent(value)
}

/**
 * 文件内容地址：用于 img/iframe/a 标签直接访问（Cookie 自动携带）。
 * 预览必须显式 `inline=1`，否则服务端可能以 attachment 返回导致 iframe 变成下载；
 * 下载则使用 `download=1`。
 */
export function fileContentUrl(id: string, options: { inline?: boolean; download?: boolean } = {}): string {
  const base = `/api/files/${encodeId(id)}/content`
  const params = new URLSearchParams()
  if (options.inline) params.set('inline', '1')
  if (options.download) params.set('download', '1')
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

export interface UploadCallbacks {
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

/**
 * 使用 XMLHttpRequest 上传以获得进度事件。
 * 每批文件单独一次请求，便于页面按文件展示进度与重试。
 */
export function uploadFiles(
  files: File[],
  parentId: string | null,
  callbacks: UploadCallbacks = {},
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (files.length === 0) {
      resolve({ items: [], errors: [] })
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files/upload')
    xhr.withCredentials = true
    xhr.responseType = 'text'

    const token = getCsrfToken()
    if (token) xhr.setRequestHeader(CSRF_HEADER, token)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      callbacks.onProgress?.(event.loaded, event.total)
    }

    xhr.onload = () => {
      let body: unknown = null
      if (xhr.responseText) {
        try {
          body = JSON.parse(xhr.responseText) as unknown
        } catch {
          body = null
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((body as UploadResult | null) ?? { items: [], errors: [] })
        return
      }
      const error = parseErrorBody(body, xhr.status, parseRetryAfter(xhr.getResponseHeader('Retry-After')))
      if (error.status === 401 && error.code === 'unauthenticated') unauthorizedHandler?.()
      reject(error)
    }

    xhr.onerror = () => reject(new ApiError(0, 'network_error', '上传失败：网络连接异常'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '上传已取消'))

    if (callbacks.signal) {
      if (callbacks.signal.aborted) {
        reject(new ApiError(0, 'aborted', '上传已取消'))
        return
      }
      callbacks.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    const form = new FormData()
    if (parentId) form.append('parentId', parentId)
    for (const file of files) form.append('files', file, file.name)
    xhr.send(form)
  })
}

export const api = {
  auth: {
    password(username: string, password: string): Promise<PasswordChallenge> {
      return post<PasswordChallenge>('/api/auth/password', { username, password }, { skipAuthRedirect: true })
    },
    totp(challenge: string, code: string): Promise<LoginResult> {
      return post<LoginResult>('/api/auth/totp', { challenge, code }, { skipAuthRedirect: true })
    },
    recovery(challenge: string, recoveryCode: string): Promise<LoginResult> {
      return post<LoginResult>('/api/auth/totp', { challenge, recoveryCode }, { skipAuthRedirect: true })
    },
    logout(): Promise<OkResult> {
      return post<OkResult>('/api/auth/logout')
    },
    me(): Promise<MeResult> {
      return get<MeResult>('/api/auth/me', { skipAuthRedirect: true })
    },
  },
  account: {
    changePassword(currentPassword: string, newPassword: string): Promise<OkResult> {
      return post<OkResult>('/api/account/password', { currentPassword, newPassword })
    },
    generateRecoveryCodes(password: string): Promise<{ codes: string[] }> {
      return post<{ codes: string[] }>('/api/account/recovery-codes', { password })
    },
    logoutAll(): Promise<OkResult> {
      return post<OkResult>('/api/account/logout-all')
    },
  },
  getDashboard(): Promise<DashboardData> {
    return get<DashboardData>('/api/dashboard')
  },
  getAudit(limit = 50, offset = 0): Promise<AuditPage> {
    return get<AuditPage>(`/api/audit${buildQuery({ limit, offset })}`)
  },
  getVersion(): Promise<VersionResult> {
    return get<VersionResult>('/api/version')
  },
  files: {
    list(query: FileListQuery = {}): Promise<FileListResult> {
      return get<FileListResult>(
        `/api/files${buildQuery({
          parentId: query.parentId ?? null,
          page: query.page,
          pageSize: query.pageSize,
          sort: query.sort,
          dir: query.dir,
        })}`,
      )
    },
    search(keyword: string): Promise<FileSearchResult> {
      return get<FileSearchResult>(`/api/files/search${buildQuery({ q: keyword })}`)
    },
    detail(id: string): Promise<FileDetailResult> {
      return get<FileDetailResult>(`/api/files/${encodeId(id)}`)
    },
    createFolder(parentId: string | null, name: string): Promise<FileItem> {
      return post<FileItem>('/api/files/folder', { parentId, name })
    },
    update(id: string, changes: { name?: string; parentId?: string | null }): Promise<FileItem> {
      return patch<FileItem>(`/api/files/${encodeId(id)}`, changes)
    },
    remove(id: string): Promise<OkResult> {
      return del<OkResult>(`/api/files/${encodeId(id)}`)
    },
    getText(id: string): Promise<TextPreviewResult> {
      return get<TextPreviewResult>(`/api/files/${encodeId(id)}/text`)
    },
    contentUrl: fileContentUrl,
  },
  trash: {
    list(page = 1, pageSize = 200): Promise<TrashListResult> {
      return get<TrashListResult>(`/api/trash${buildQuery({ page, pageSize })}`)
    },
    restore(id: string): Promise<FileItem> {
      return post<FileItem>(`/api/trash/${encodeId(id)}/restore`)
    },
    remove(id: string): Promise<OkResult> {
      return del<OkResult>(`/api/trash/${encodeId(id)}`)
    },
    clear(): Promise<ClearTrashResult> {
      return del<ClearTrashResult>('/api/trash')
    },
  },
  mc: {
    status(): Promise<MinecraftStatus> {
      return get<MinecraftStatus>('/api/mc/status')
    },
    whitelist(): Promise<WhitelistResult> {
      return get<WhitelistResult>('/api/mc/whitelist')
    },
    addWhitelist(name: string): Promise<WhitelistMutationResult> {
      return post<WhitelistMutationResult>('/api/mc/whitelist', { name })
    },
    removeWhitelist(name: string): Promise<WhitelistMutationResult> {
      return del<WhitelistMutationResult>(`/api/mc/whitelist/${encodeId(name)}`)
    },
  },
}
