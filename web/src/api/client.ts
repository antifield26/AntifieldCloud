// 统一 HTTP 客户端。
// 职责：同源 fetch、credentials include、自动附带 CSRF 头、统一错误解析、401 会话失效回调。
// 安全边界：不把密码、TOTP、恢复码写日志；不解析文件 ID 含义；错误信息只保留服务端可展示文案。
// 公开接口（登录页/分享页）使用 skipAuthRedirect，避免匿名访问触发全局登录跳转。

import type {
  AlertTestResult,
  AlertsResult,
  AuditPage,
  BackupArchive,
  BackupEntriesResult,
  BackupImportResult,
  BackupListResult,
  BackupPrepareResult,
  BackupVerifyResult,
  Bookmark,
  BookmarkInput,
  BookmarkListResult,
  BookmarkPatch,
  ClearTrashResult,
  CreateShareInput,
  CreateShareResult,
  DashboardData,
  DeleteFileResult,
  FileItem,
  FileListQuery,
  FileListResult,
  FileSearchResult,
  KnowledgeQuery,
  LoginResult,
  MeResult,
  MinecraftStatus,
  Note,
  NoteInput,
  NoteListResult,
  NotePatch,
  OkResult,
  PasswordChallenge,
  PublicShareInfo,
  PublicShareUnlockResult,
  RestoreExecuteResult,
  RestorePlan,
  RestorePlanResult,
  RevokeShareResult,
  ShareListResult,
  TagsResult,
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
const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000

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
  invalid_totp: '验证码无效',
  challenge_expired: '验证已过期，请重新登录',
  rcon_unavailable: 'RCON 不可用，暂时无法读取或修改白名单',
  already_whitelisted: '该玩家已在白名单中',
  not_whitelisted: '该玩家不在白名单中',
  invalid_name: '名称不合法',
  cycle_detected: '不能把文件夹移动到自身或子目录中',
  network_error: '网络连接失败，请检查网络后重试',
  timeout: '请求超时，请检查网络后重试',
  aborted: '操作已取消',
  invalid_password: '密码错误',
  share_expired: '分享链接已过期',
  share_exhausted: '分享链接的下载次数已用尽',
  share_revoked: '分享链接已被吊销',
  webhook_not_configured: '未配置 Webhook，无法发送测试消息',
  invalid_url: '链接格式不合法',
  confirmation_failed: '确认文本不正确',
  checksum_mismatch: '归档 SHA-256 校验失败',
  invalid_archive: '归档内容不合法或已损坏',
  plan_expired: '恢复计划已过期，请重新创建',
  restore_busy: '已有恢复任务在执行，请稍后再试',
  backup_not_verified: '恢复链中的归档尚未校验通过',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec: number | null
  readonly details: Record<string, unknown> | null

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSec: number | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
    this.details = details
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

/** AbortController 取消属于正常控制流，页面不应展示为错误。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
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

function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null
  const seconds = Number(headerValue)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = new Date(headerValue)
  if (Number.isNaN(date.getTime())) return null
  return Math.max(0, Math.round((date.getTime() - Date.now()) / 1000))
}

/**
 * 解析统一错误体：
 * - 优先 `error.details.retryAfterSec`，其次 `error.retryAfterSec`、顶层 retryAfterSec、Retry-After 头
 * - 无 body / 无 code 时按状态码回退
 */
export function parseApiError(body: unknown, status: number, retryAfterHeader: number | null): ApiError {
  let code = status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'internal_error'
  let message = ''
  let retryAfterSec = retryAfterHeader
  let details: Record<string, unknown> | null = null

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const nested = record.error
    if (typeof record.retryAfterSec === 'number') retryAfterSec = record.retryAfterSec
    if (nested && typeof nested === 'object') {
      const errorRecord = nested as Record<string, unknown>
      if (typeof errorRecord.code === 'string' && errorRecord.code) code = errorRecord.code
      if (typeof errorRecord.message === 'string') message = errorRecord.message
      if (typeof errorRecord.retryAfterSec === 'number') retryAfterSec = errorRecord.retryAfterSec
      if (errorRecord.details && typeof errorRecord.details === 'object') {
        details = errorRecord.details as Record<string, unknown>
        if (typeof details.retryAfterSec === 'number') retryAfterSec = details.retryAfterSec
      }
    } else if (typeof record.message === 'string') {
      message = record.message
    }
  }

  if (!message) message = ERROR_MESSAGES[code] ?? `请求失败（HTTP ${status}）`
  return new ApiError(status, code, message, retryAfterSec, details)
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
  /** 认证类/公开接口不触发全局 401 跳转。 */
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
    if (isAbortError(error)) throw error
    throw new ApiError(0, 'network_error', ERROR_MESSAGES.network_error ?? '网络连接失败')
  }

  if (!response.ok) {
    const error = parseApiError(
      await readJsonBody(response),
      response.status,
      parseRetryAfter(response.headers.get('Retry-After')),
    )
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

/** 公开分享内容地址：Cookie 由解锁接口写入，前端不附加任何查询参数。 */
export function publicShareContentUrl(token: string): string {
  return `/api/public/shares/${encodeURIComponent(token)}/content`
}

export interface UploadCallbacks {
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  /** 默认 15 分钟，超时后拒绝为 timeout 错误 */
  timeoutMs?: number
}

/**
 * 使用 XMLHttpRequest 上传以获得进度事件。
 * 每个文件单独一次请求，便于页面按文件展示进度、取消与重试。
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
    if (callbacks.signal?.aborted) {
      reject(new ApiError(0, 'aborted', '上传已取消'))
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files/upload')
    xhr.withCredentials = true
    xhr.responseType = 'text'
    xhr.timeout = callbacks.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS

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
      const error = parseApiError(body, xhr.status, parseRetryAfter(xhr.getResponseHeader('Retry-After')))
      if (error.status === 401 && error.code === 'unauthenticated') unauthorizedHandler?.()
      reject(error)
    }

    xhr.onerror = () => reject(new ApiError(0, 'network_error', '上传失败：网络连接异常'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '上传已取消'))
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', '上传超时，请检查网络后重试'))

    if (callbacks.signal) {
      callbacks.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    const form = new FormData()
    if (parentId) form.append('parentId', parentId)
    for (const file of files) form.append('files', file, file.name)
    xhr.send(form)
  })
}

/* ---------- 备份归档上传（独立 multipart，不进入文件列表上传队列） ---------- */

export interface BackupUploadCallbacks {
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  /** 默认 30 分钟 */
  timeoutMs?: number
}

const DEFAULT_BACKUP_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 上传备份归档（POST /api/backups/import，multipart 字段 file）。
 * multipart 无法在读取 body 前校验 TOTP，服务端要求 `X-TOTP-Code` 请求头。
 * 归档不进入文件配额；服务端负责名称白名单、SHA-256 与 tar 安全校验。
 */
export function uploadBackupArchive(
  file: File,
  totpCode: string,
  callbacks: BackupUploadCallbacks = {},
): Promise<BackupImportResult> {
  return new Promise((resolve, reject) => {
    if (callbacks.signal?.aborted) {
      reject(new ApiError(0, 'aborted', '上传已取消'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/backups/import')
    xhr.withCredentials = true
    xhr.responseType = 'text'
    xhr.timeout = callbacks.timeoutMs ?? DEFAULT_BACKUP_UPLOAD_TIMEOUT_MS

    const token = getCsrfToken()
    if (token) xhr.setRequestHeader(CSRF_HEADER, token)
    xhr.setRequestHeader('X-TOTP-Code', totpCode)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      callbacks.onProgress?.(event.loaded, event.total)
    }

    const normalize = (body: unknown): BackupImportResult => {
      if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>
        if (record.archive && typeof record.archive === 'object') {
          const verify =
            record.verify && typeof record.verify === 'object'
              ? (record.verify as BackupImportResult['verify'])
              : undefined
          return { archive: record.archive as BackupArchive, verify }
        }
        if (typeof record.id === 'string') return { archive: record as unknown as BackupArchive }
      }
      throw new ApiError(0, 'invalid_response', '服务端返回的归档信息无法解析')
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
        try {
          resolve(normalize(body))
        } catch (normalizeError) {
          reject(normalizeError)
        }
        return
      }
      const error = parseApiError(body, xhr.status, parseRetryAfter(xhr.getResponseHeader('Retry-After')))
      if (error.status === 401 && error.code === 'unauthenticated') unauthorizedHandler?.()
      reject(error)
    }
    xhr.onerror = () => reject(new ApiError(0, 'network_error', '归档上传失败：网络连接异常'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '上传已取消'))
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', '归档上传超时，请检查网络后重试'))

    if (callbacks.signal) {
      callbacks.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    const form = new FormData()
    form.append('file', file, file.name)
    xhr.send(form)
  })
}

function normalizeRestorePlan(body: unknown): RestorePlanResult {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (record.plan && typeof record.plan === 'object') return { plan: record.plan as RestorePlan }
    if (typeof record.id === 'string') return { plan: record as unknown as RestorePlan }
  }
  throw new ApiError(0, 'invalid_response', '服务端返回的恢复计划无法解析')
}

function normalizeExecuteResult(body: unknown): RestoreExecuteResult {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const plan = record.plan && typeof record.plan === 'object' ? (record.plan as RestorePlan) : null
    const result = record.result && typeof record.result === 'object' ? (record.result as RestoreExecuteResult['result']) : null
    if (plan && result) return { ok: record.ok === undefined ? true : Boolean(record.ok), plan, result }
  }
  throw new ApiError(0, 'invalid_response', '服务端返回的恢复结果无法解析')
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
    /** 修改密码：需要当前密码 + TOTP；成功后其它会话失效。 */
    changePassword(currentPassword: string, newPassword: string, totpCode: string): Promise<OkResult> {
      return post<OkResult>('/api/account/password', { currentPassword, newPassword, totpCode })
    },
    /** 重新生成恢复码：需要当前密码 + TOTP；旧码立即失效。 */
    generateRecoveryCodes(password: string, totpCode: string): Promise<{ codes: string[] }> {
      return post<{ codes: string[] }>('/api/account/recovery-codes', { password, totpCode })
    },
    logoutAll(): Promise<OkResult> {
      return post<OkResult>('/api/account/logout-all')
    },
  },
  getDashboard(): Promise<DashboardData> {
    return get<DashboardData>('/api/dashboard')
  },
  getAudit(limit = 50, offset = 0, action?: string, signal?: AbortSignal): Promise<AuditPage> {
    return get<AuditPage>(`/api/audit${buildQuery({ limit, offset, action })}`, { signal })
  },
  /** /api/version 同时下发站点元数据；旧服务端只有 version。 */
  getVersion(): Promise<VersionResult> {
    return get<VersionResult>('/api/version')
  },
  backups: {
    /** 归档列表：Pi pending/acked + 导入归档 + inbox/orphans + 汇总状态。 */
    list(signal?: AbortSignal): Promise<BackupListResult> {
      return get<BackupListResult>('/api/backups', { signal })
    },
    /** 触发 Pi 端备份准备（只生成 pending，不 ack、不推进游标）。 */
    prepare(totpCode?: string): Promise<BackupPrepareResult> {
      return post<BackupPrepareResult>('/api/backups/prepare', {
        confirmText: 'PREPARE',
        ...(totpCode ? { totpCode } : {}),
      })
    },
    /** 上传归档：multipart + X-TOTP-Code 头，返回 archive 与自动校验结果。 */
    importArchive: uploadBackupArchive,
    /** 流式 SHA-256 + tar 安全校验；失败 409 checksum_mismatch / 422 invalid_archive。 */
    verify(name: string): Promise<BackupVerifyResult> {
      return post<BackupVerifyResult>('/api/backups/verify', { name })
    },
    /** 只读归档内容（最多 500 条），用于恢复时选择文件/目录。 */
    entries(name: string, path = '/'): Promise<BackupEntriesResult> {
      return get<BackupEntriesResult>(
        `/api/backups/archives/${encodeId(name)}/entries${buildQuery({ path })}`,
      )
    },
    /** 创建恢复计划：选择归档（链由服务端按 manifest 解析）与可选文件路径。 */
    async restorePlan(input: {
      archive: string
      paths?: string[]
      totpCode: string
    }): Promise<RestorePlanResult> {
      return normalizeRestorePlan(
        await post<unknown>('/api/backups/restore-plan', {
          archive: input.archive,
          ...(input.paths && input.paths.length > 0 ? { paths: input.paths } : {}),
          totpCode: input.totpCode,
          confirmText: 'RESTORE',
        }),
      )
    },
    /** 计划详情（轮询执行状态）。 */
    async getRestore(planId: string): Promise<RestorePlanResult> {
      return normalizeRestorePlan(await get<unknown>(`/api/restores/${encodeId(planId)}`))
    },
    /** 执行恢复：TOTP + typed confirmation；服务端只恢复到新目录，失败可重试。 */
    async executeRestore(planId: string, totpCode: string): Promise<RestoreExecuteResult> {
      return normalizeExecuteResult(
        await post<unknown>(`/api/restores/${encodeId(planId)}/execute`, {
          totpCode,
          confirmText: 'RESTORE',
        }),
      )
    },
  },
  files: {
    list(query: FileListQuery = {}, signal?: AbortSignal): Promise<FileListResult> {
      return get<FileListResult>(
        `/api/files${buildQuery({
          parentId: query.parentId ?? null,
          page: query.page,
          pageSize: query.pageSize,
          sort: query.sort,
          dir: query.dir,
        })}`,
        { signal },
      )
    },
    search(keyword: string, signal?: AbortSignal): Promise<FileSearchResult> {
      return get<FileSearchResult>(`/api/files/search${buildQuery({ q: keyword })}`, { signal })
    },
    createFolder(parentId: string | null, name: string): Promise<FileItem> {
      return post<FileItem>('/api/files/folder', { parentId, name })
    },
    update(id: string, changes: { name?: string; parentId?: string | null }): Promise<FileItem> {
      return patch<FileItem>(`/api/files/${encodeId(id)}`, changes)
    },
    remove(id: string): Promise<DeleteFileResult> {
      return del<DeleteFileResult>(`/api/files/${encodeId(id)}`)
    },
    getText(id: string): Promise<TextPreviewResult> {
      return get<TextPreviewResult>(`/api/files/${encodeId(id)}/text`)
    },
    contentUrl: fileContentUrl,
    /** 创建文件分享链接（仅文件） */
    createShare(id: string, input: CreateShareInput): Promise<CreateShareResult> {
      return post<CreateShareResult>(`/api/files/${encodeId(id)}/shares`, input)
    },
  },
  shares: {
    list(): Promise<ShareListResult> {
      return get<ShareListResult>('/api/shares')
    },
    revoke(id: string): Promise<RevokeShareResult> {
      return del<RevokeShareResult>(`/api/shares/${encodeId(id)}`)
    },
  },
  /** 公开分享接口：无需登录，不能触发全局登录跳转。 */
  publicShares: {
    info(token: string): Promise<PublicShareInfo> {
      return get<PublicShareInfo>(`/api/public/shares/${encodeId(token)}`, { skipAuthRedirect: true })
    },
    unlock(token: string, password: string | null): Promise<PublicShareUnlockResult> {
      return post<PublicShareUnlockResult>(
        `/api/public/shares/${encodeId(token)}/unlock`,
        password === null ? {} : { password },
        { skipAuthRedirect: true },
      )
    },
    contentUrl: publicShareContentUrl,
  },
  trash: {
    list(page = 1, pageSize = 200, signal?: AbortSignal): Promise<TrashListResult> {
      return get<TrashListResult>(`/api/trash${buildQuery({ page, pageSize })}`, { signal })
    },
    restore(id: string): Promise<FileItem> {
      return post<FileItem>(`/api/trash/${encodeId(id)}/restore`)
    },
    remove(id: string): Promise<DeleteFileResult> {
      return del<DeleteFileResult>(`/api/trash/${encodeId(id)}`)
    },
    clear(): Promise<ClearTrashResult> {
      return del<ClearTrashResult>('/api/trash')
    },
  },
  mc: {
    /** force=1 跳过服务端 10 秒缓存，用于手动刷新。 */
    status(force = false): Promise<MinecraftStatus> {
      return get<MinecraftStatus>(`/api/mc/status${force ? '?force=1' : ''}`)
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
  notes: {
    list(query: KnowledgeQuery = {}, signal?: AbortSignal): Promise<NoteListResult> {
      return get<NoteListResult>(
        `/api/notes${buildQuery({
          q: query.q,
          tag: query.tag,
          pinned: query.pinned,
          page: query.page,
          pageSize: query.pageSize,
        })}`,
        { signal },
      )
    },
    get(id: string): Promise<Note> {
      return get<Note>(`/api/notes/${encodeId(id)}`)
    },
    create(input: NoteInput): Promise<Note> {
      return post<Note>('/api/notes', input)
    },
    update(id: string, patchBody: NotePatch): Promise<Note> {
      return patch<Note>(`/api/notes/${encodeId(id)}`, patchBody)
    },
    remove(id: string): Promise<OkResult> {
      return del<OkResult>(`/api/notes/${encodeId(id)}`)
    },
    tags(): Promise<TagsResult> {
      return get<TagsResult>('/api/notes/tags')
    },
  },
  bookmarks: {
    list(query: KnowledgeQuery = {}, signal?: AbortSignal): Promise<BookmarkListResult> {
      return get<BookmarkListResult>(
        `/api/bookmarks${buildQuery({
          q: query.q,
          tag: query.tag,
          pinned: query.pinned,
          page: query.page,
          pageSize: query.pageSize,
        })}`,
        { signal },
      )
    },
    get(id: string): Promise<Bookmark> {
      return get<Bookmark>(`/api/bookmarks/${encodeId(id)}`)
    },
    create(input: BookmarkInput): Promise<Bookmark> {
      return post<Bookmark>('/api/bookmarks', input)
    },
    update(id: string, patchBody: BookmarkPatch): Promise<Bookmark> {
      return patch<Bookmark>(`/api/bookmarks/${encodeId(id)}`, patchBody)
    },
    remove(id: string): Promise<OkResult> {
      return del<OkResult>(`/api/bookmarks/${encodeId(id)}`)
    },
    tags(): Promise<TagsResult> {
      return get<TagsResult>('/api/bookmarks/tags')
    },
  },
  alerts: {
    list(limit = 20): Promise<AlertsResult> {
      return get<AlertsResult>(`/api/alerts${buildQuery({ limit })}`)
    },
    test(): Promise<AlertTestResult> {
      return post<AlertTestResult>('/api/alerts/test')
    },
  },
}
