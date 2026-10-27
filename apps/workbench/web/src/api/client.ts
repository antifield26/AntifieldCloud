// 统一 HTTP 客户端。
// 职责：同源 fetch、credentials include、自动附带 CSRF 头、统一错误解析、401 会话失效回调。
// 安全边界：不把密码、TOTP、恢复码写日志；不解析文件 ID 含义；错误信息只保留服务端可展示文案。
// 公开接口（登录页/分享页）使用 skipAuthRedirect，避免匿名访问触发全局登录跳转。

import type {
  AlertListQuery,
  AlertTestResult,
  AlertsResult,
  AuditPage,
  AuditQuery,
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
  ChatbotCreateInput,
  ChatbotDelivery,
  ChatbotEventItem,
  ChatbotHealthCheck,
  ChatbotInboundTarget,
  ChatbotMemoryItemSummary,
  ChatbotMemoryGroupSummary,
  ChatbotMemoryUserSummary,
  ChatbotMetrics,
  ChatbotConnectivitySnapshot,
  ChatbotGroupRoleDetail,
  ChatbotGroupRoleSummary,
  ChatbotPublishInput,
  ChatbotPublishJob,
  ChatbotRoleSummary,
  ChatbotStatus,
  ChatbotSummary,
  ChatbotTarget,
  ChatbotTargetInput,
  ChatbotTargetPatch,
  ChatbotUpdateInput,
  ClearTrashResult,
  ChunkUploadInit,
  ChunkUploadStatus,
  CreateShareBundleInput,
  CreateShareInput,
  CreateShareResult,
  DashboardData,
  DeleteFileResult,
  FileItem,
  FileListQuery,
  FileListResult,
  FileSearchResult,
  KnowledgeQuery,
  McbotActionResult,
  McbotHistory,
  McbotHistoryQuery,
  McbotMoveAction,
  McbotSnapshot,
  McbotTaskName,
  LoginResult,
  MeResult,
  MetricsRange,
  MetricsResult,
  MinecraftStatus,
  Note,
  NoteAttachment,
  NoteAttachmentListResult,
  NoteInput,
  NoteListResult,
  NotePatch,
  NoteVersionListResult,
  NoteVersionQuery,
  NoteVersionResult,
  OkResult,
  PasswordChallenge,
  PublicShareInfo,
  PublicShareUnlockResult,
  RestoreExecuteResult,
  RestorePlan,
  RestorePlanResult,
  RevokeShareResult,
  ShareListResult,
  StorageInfo,
  TagsResult,
  TextPreviewResult,
  TrashListResult,
  UploadResult,
  VersionResult,
  WhitelistMutationResult,
  WhitelistResult,
} from './types'
import { chunkCount, isValidResumeRecord, resumeStorageKey, uploadFingerprint, type ResumeRecord } from '../lib/chunked'

const CSRF_COOKIE = 'af_csrf'
const CSRF_HEADER = 'X-CSRF-Token'
const JSON_HEADERS = { Accept: 'application/json' }
const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
/**
 * 备份/恢复是服务端长任务：prepare 由 BACKUP_PREPARE_TIMEOUT_SEC（默认 3300s）控制，
 * verify/entries/restore-plan 需解包归档，execute 需解包 + 写盘。客户端默认 20s 超时会把
 * “仍在执行”误报成失败并导致重试 409，因此这些端点显式放宽；超时后 UI 必须提示
 * “服务端可能仍在执行，请刷新/查询状态”而不是让用户直接重试。
 */
export const BACKUP_LONG_OPERATION_TIMEOUTS = {
  prepare: 3_400_000,
  verify: 600_000,
  entries: 600_000,
  restorePlan: 600_000,
  executeRestore: 3_600_000,
  getRestore: 60_000,
} as const

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
  checksum_mismatch: 'SHA-256 校验失败，请重新上传',
  invalid_archive: '归档内容不合法或已损坏',
  plan_expired: '恢复计划已过期，请重新创建',
  restore_busy: '已有恢复任务在执行，请稍后再试',
  backup_not_verified: '恢复链中的归档尚未校验通过',
  archive_not_verified: '归档尚未校验通过，请先校验',
  archive_chain_invalid: '恢复链不完整或清单不一致',
  archive_not_found: '归档不存在',
  invalid_selection: '选择的内容不合法',
  restore_too_many_files: '恢复文件数超过服务端上限',
  restore_disabled: '服务端未启用恢复向导',
  // v0.4.0：指标、多文件分享与笔记附件/版本
  invalid_range: '指标时间范围不合法',
  share_bundle: '该分享包含多个文件，请逐个下载',
  share_item_not_found: '分享中的文件不存在或已被移除',
  share_gone: '分享的文件已被删除',
  attachment_limit: '附件数量超过限制',
  invalid_response: '服务端返回的数据无法解析',
  too_many_uploads: '未完成的分片上传会话过多，请清理后重试',
  chunks_missing: '仍有分片未上传，请重试',
  chunk_conflict: '同一分片内容不一致，请放弃后重新上传',
  upload_completed: '上传会话已完成，无法取消',
  invalid_chunk_index: '分片序号不合法',
  invalid_chunk_size: '分片大小不合法',
  // v0.5.0：Chatbot 配置与队列
  chatbot_disabled: 'Chatbot 功能未启用',
  chatbot_key_missing: '未配置 CHATBOT_SECRET_KEY，Chatbot 功能暂不可用',
  chatbot_key_invalid: 'CHATBOT_SECRET_KEY 配置无效',
  totp_required: '发布需要 TOTP 验证码',
  invalid_chatbot_config: 'Chatbot 配置不合法，请检查 Token 与密钥',
  target_missing: '投递目标不存在或已被删除',
  media_missing: '媒体文件不存在或不可发布',
  empty_payload: '投递内容为空',
  // v0.7.0：备份整包加密 + 异地副本（加密归档只能在 PC/离线私钥侧校验/恢复）
  archive_encrypted: '该归档已加密，Web 无法校验或恢复，请在 PC 上用 age 私钥处理',
  verify_requires_decryption: '该归档已加密，需要离线私钥解密后才能校验',
  restore_requires_private_key: '该归档已加密，需要离线私钥解密后才能恢复',
  encryption_key_missing: 'Pi 端未配置备份 age 公钥，加密备份暂不可用',
  encryption_disabled: '备份加密未启用',
  archive_missing: '归档文件不存在',
  backup_busy: '已有备份生成任务在执行，请稍后刷新查看',
  backup_prepare_timeout: '备份生成超时，请查看 pending 归档或稍后重试',
  backup_prepare_failed: '生成备份失败，请查看服务端日志',
  plan_not_pending: '恢复计划当前不可执行（可能已完成或正在执行）',
  plan_completed: '恢复计划已完成',
  upload_assembling: '服务端正在拼接文件，请稍后重试（断点已保留）',
  upload_expired: '上传会话已过期，请重新上传',
  too_many_attachments: '附件数量超过限制',
  // v0.7.0：Chatbot AI 工具隔离 fail-closed（不降级为无工具模式）
  chatbot_ai_tool_isolation_unavailable: 'Chatbot AI 工具安全隔离不可用，已拒绝本轮 AI 请求（请检查 botmsg MCP 与隔离配置）',
  // v0.8.0：mcbot 集成（服务端把 mcbot 上游错误映射为 mcbot_* 前缀）
  mcbot_disabled: 'mcbot 集成未启用（MCBOT_ENABLED=false）',
  mcbot_unavailable: 'mcbot 服务不可达，请检查 mcbot 进程与 Token 配置',
  mcbot_control_disabled: 'mcbot 控制未启用（服务端未配置 MCBOT_CONTROL_TOKEN）',
  mcbot_auth_failed: 'mcbot Token 认证失败，请检查服务端 mcbot 配置',
  mcbot_upstream_error: 'mcbot 上游返回异常，请查看 mcbot 日志',
  mcbot_resume_pending: 'mcbot 有可恢复任务，请先恢复或停止任务',
  mcbot_resume_failed: 'mcbot 任务恢复失败（可能已过期或 taskId 不匹配）',
  mcbot_queue_full: 'mcbot 任务队列已满（最多 3 个）',
  mcbot_no_active_task: 'mcbot 当前没有进行中的任务',
  mcbot_no_pending_task: 'mcbot 没有可恢复的任务',
  mcbot_task_disabled: 'mcbot 任务功能已关闭',
  mcbot_task_active: 'mcbot 任务进行中，请先停止任务',
  mcbot_target_not_online: '目标玩家不在线',
  mcbot_not_connected: 'mcbot 尚未连接 Minecraft',
  mcbot_rate_limited: 'mcbot 操作过于频繁，请稍后再试',
  mcbot_invalid_request: 'mcbot 请求参数不合法',
  message_must_not_start_with_slash: '聊天内容不能以 / 开头（不会执行任何命令）',
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
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  /** 认证类/公开接口不触发全局 401 跳转。 */
  skipAuthRedirect?: boolean
  /** 单请求超时（毫秒）；<=0 表示不设置超时（仅用于服务端长任务端点）。默认 20s。 */
  timeoutMs?: number
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null
    const signal =
      timeoutSignal === null
        ? options.signal
        : options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal
    response = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'include',
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError(0, 'timeout', ERROR_MESSAGES.timeout ?? '请求超时，请检查网络后重试')
    }
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

function put<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', body })
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

/** 多文件公开分享的逐文件下载地址；itemId 越权时服务端返回 404。 */
export function publicShareItemContentUrl(token: string, itemId: string): string {
  return `/api/public/shares/${encodeURIComponent(token)}/items/${encodeURIComponent(itemId)}/content`
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

/* ---------- 笔记附件上传（v0.4.0，独立 multipart，不进入文件上传队列） ---------- */

export interface NoteAttachmentUploadCallbacks {
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  /** 默认 15 分钟 */
  timeoutMs?: number
}

/**
 * 上传笔记附件（POST /api/notes/:id/attachments，multipart 字段 files，1–5 个）。
 * 附件计入总配额但属于笔记私有数据：不出现在文件列表/搜索/回收站，仅经笔记接口管理。
 * 前端只做数量/大小预检，限额与命名去重由服务端最终裁决。
 */
export function uploadNoteAttachments(
  noteId: string,
  files: File[],
  callbacks: NoteAttachmentUploadCallbacks = {},
): Promise<NoteAttachmentListResult> {
  return new Promise((resolve, reject) => {
    if (files.length === 0) {
      resolve({ items: [] })
      return
    }
    if (callbacks.signal?.aborted) {
      reject(new ApiError(0, 'aborted', '附件上传已取消'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/notes/${encodeId(noteId)}/attachments`)
    xhr.withCredentials = true
    xhr.responseType = 'text'
    xhr.timeout = callbacks.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS

    const token = getCsrfToken()
    if (token) xhr.setRequestHeader(CSRF_HEADER, token)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) callbacks.onProgress?.(event.loaded, event.total)
    }

    const parseBody = (): unknown => {
      if (!xhr.responseText) return null
      try {
        return JSON.parse(xhr.responseText) as unknown
      } catch {
        return null
      }
    }

    xhr.onload = () => {
      const body = parseBody()
      if (xhr.status >= 200 && xhr.status < 300) {
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
        const items = record && Array.isArray(record.items) ? (record.items as NoteAttachment[]) : []
        resolve({ items })
        return
      }
      const error = parseApiError(body, xhr.status, parseRetryAfter(xhr.getResponseHeader('Retry-After') ?? null))
      if (error.status === 401 && error.code === 'unauthenticated') unauthorizedHandler?.()
      reject(error)
    }
    xhr.onerror = () => reject(new ApiError(0, 'network_error', '附件上传失败：网络连接异常'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '附件上传已取消'))
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', '附件上传超时，请检查网络后重试'))

    if (callbacks.signal) {
      callbacks.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)
    xhr.send(form)
  })
}

/* ---------- 大文件分片上传（v0.3.1） ---------- */

export interface ChunkedUploadOptions {
  chunkSize?: number
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number) => void
  /** 并发块数；默认 2。 */
  concurrency?: number
}

function readResumeRecord(key: string): ResumeRecord | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isValidResumeRecord(parsed)) return null
    // 过期断点不再使用：服务端会话已过期/被清理，继续用只会得到 404。
    const expiresAt = Date.parse(parsed.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      localStorage.removeItem(key)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeResumeRecord(key: string, record: ResumeRecord): void {
  try {
    localStorage.setItem(key, JSON.stringify(record))
  } catch {
    // 隐私模式/配额不足时只放弃断点，不影响本次上传。
  }
}

function clearResumeRecord(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function uploadChunkXhr(
  uploadId: string,
  index: number,
  data: Blob,
  callbacks: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; timeoutMs?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (callbacks.signal?.aborted) {
      reject(new ApiError(0, 'aborted', '上传已取消'))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/uploads/${encodeId(uploadId)}/chunks/${index}`)
    xhr.withCredentials = true
    xhr.responseType = 'text'
    xhr.timeout = callbacks.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    const token = getCsrfToken()
    if (token) xhr.setRequestHeader(CSRF_HEADER, token)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) callbacks.onProgress?.(event.loaded, event.total)
    }
    xhr.onload = () => {
      let body: unknown
      try {
        body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      const error = parseApiError(body, xhr.status, parseRetryAfter(xhr.getResponseHeader('Retry-After')))
      if (error.status === 401 && error.code === 'unauthenticated') unauthorizedHandler?.()
      reject(error)
    }
    xhr.onerror = () => reject(new ApiError(0, 'network_error', '分片上传失败：网络连接异常'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '上传已取消'))
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', '分片上传超时，请重试'))
    callbacks.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(data)
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, 'aborted', '上传已取消'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      window.clearTimeout(timer)
      reject(new ApiError(0, 'aborted', '上传已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 服务端已登记文件（completed 会话）→ 读取 FileItem 以便上传队列直接标记成功。 */
async function registeredFileItem(fileId: string, signal?: AbortSignal): Promise<FileItem> {
  const result = await get<{ item?: FileItem }>(`/api/files/${encodeId(fileId)}`, { signal })
  if (!result?.item) throw new ApiError(0, 'invalid_response', '上传已完成，但读取已登记文件失败，请刷新文件列表')
  return result.item
}

/**
 * 处理断点会话状态：
 * - completed：服务端已拼接登记，直接用 fileId 结束（不重传，API.md §4 契约）；
 * - assembling：服务端正在拼接，短暂轮询等待完成；超时则保留断点让用户稍后重试；
 * - aborted/expired：清断点并重新 init。
 * 返回 session 表示需要继续上传；返回 UploadResult 表示上传已完成。
 */
async function resumeOrRestartUpload(
  status: ChunkUploadStatus,
  storageKey: string,
  file: File,
  parentId: string | null,
  chunkSize: number,
  signal?: AbortSignal,
): Promise<ChunkUploadInit | UploadResult> {
  if (status.status === 'completed') {
    clearResumeRecord(storageKey)
    if (!status.fileId) {
      throw new ApiError(0, 'invalid_response', '上传已完成，但服务端未返回文件 id，请刷新文件列表确认')
    }
    return { items: [await registeredFileItem(status.fileId, signal)], errors: [] }
  }
  if (status.status === 'assembling') {
    let current = status
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(1000, signal)
      current = await get<ChunkUploadStatus>(`/api/uploads/${encodeId(status.uploadId)}`, { signal })
      if (current.status === 'completed') {
        clearResumeRecord(storageKey)
        if (!current.fileId) {
          throw new ApiError(0, 'invalid_response', '上传已完成，但服务端未返回文件 id，请刷新文件列表确认')
        }
        return { items: [await registeredFileItem(current.fileId, signal)], errors: [] }
      }
      if (current.status === 'uploading' || current.status === 'aborted' || current.status === 'expired') break
    }
    if (current.status === 'completed') {
      clearResumeRecord(storageKey)
      if (!current.fileId) throw new ApiError(0, 'invalid_response', '上传已完成，但服务端未返回文件 id')
      return { items: [await registeredFileItem(current.fileId, signal)], errors: [] }
    }
    if (current.status === 'assembling') {
      throw new ApiError(0, 'upload_assembling', ERROR_MESSAGES.upload_assembling ?? '服务端正在拼接文件，请稍后重试')
    }
    if (current.status === 'uploading') {
      return {
        uploadId: current.uploadId,
        chunkSize: current.chunkSize,
        totalChunks: current.totalChunks,
        expiresAt: current.expiresAt,
        received: current.received,
      }
    }
    clearResumeRecord(storageKey)
    return post<ChunkUploadInit>('/api/uploads', { name: file.name, parentId, size: file.size }, { signal })
  }
  if (status.status === 'uploading' && status.chunkSize === chunkSize && status.size === file.size) {
    return {
      uploadId: status.uploadId,
      chunkSize: status.chunkSize,
      totalChunks: status.totalChunks,
      expiresAt: status.expiresAt,
      received: status.received,
    }
  }
  clearResumeRecord(storageKey)
  return post<ChunkUploadInit>('/api/uploads', { name: file.name, parentId, size: file.size }, { signal })
}

/**
 * 大文件分片上传：先恢复同文件/同目录的会话，缺块并发上传，最后 complete。
 * 断点只保存 uploadId/已收块号与恢复所需元数据，不缓存文件内容；取消后下次重试仍可续传。
 */
export async function uploadFileChunked(
  file: File,
  parentId: string | null,
  options: ChunkedUploadOptions = {},
): Promise<UploadResult> {
  const chunkSize = options.chunkSize ?? 8 * 1024 * 1024
  const fingerprint = uploadFingerprint(file, parentId)
  const storageKey = resumeStorageKey(fingerprint)
  const total = file.size
  const totalChunks = chunkCount(file.size, chunkSize)
  if (totalChunks <= 0) throw new ApiError(0, 'invalid_file', '文件大小不正确')

  const sendProgress = (completed: number, current: number): void => {
    options.onProgress?.(Math.min(total, completed + current), total)
  }

  let session: ChunkUploadInit
  const resumed = readResumeRecord(storageKey)
  if (resumed) {
    try {
      const status = await get<ChunkUploadStatus>(`/api/uploads/${encodeId(resumed.uploadId)}`, { signal: options.signal })
      const outcome = await resumeOrRestartUpload(status, storageKey, file, parentId, chunkSize, options.signal)
      if ('items' in outcome) return outcome
      session = outcome
    } catch (error) {
      if (isAbortError(error) || isApiError(error, 'upload_assembling')) throw error
      clearResumeRecord(storageKey)
      session = await post<ChunkUploadInit>('/api/uploads', { name: file.name, parentId, size: file.size }, {
        signal: options.signal,
      })
    }
  } else {
    session = await post<ChunkUploadInit>('/api/uploads', { name: file.name, parentId, size: file.size }, {
      signal: options.signal,
    })
  }

  // 只持久化续传所需最小字段；文件身份由 storage key 指纹保证。
  const record: ResumeRecord = {
    uploadId: session.uploadId,
    received: [...session.received],
    expiresAt: session.expiresAt,
  }
  writeResumeRecord(storageKey, record)
  const received = new Set(session.received)
  const missing: number[] = []
  for (let index = 0; index < totalChunks; index++) if (!received.has(index)) missing.push(index)

  const completedBytes = (): number => {
    let bytes = 0
    for (const index of received) {
      const start = index * chunkSize
      bytes += Math.min(chunkSize, file.size - start)
    }
    return bytes
  }
  let next = 0
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 2)))
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, missing.length)) }, async () => {
    while (next < missing.length) {
      if (options.signal?.aborted) throw new ApiError(0, 'aborted', '上传已取消')
      const index = missing[next++]!
      const start = index * chunkSize
      const end = Math.min(file.size, start + chunkSize)
      await uploadChunkXhr(session.uploadId, index, file.slice(start, end), {
        signal: options.signal,
        timeoutMs: DEFAULT_UPLOAD_TIMEOUT_MS,
        onProgress: (loaded) => sendProgress(completedBytes(), loaded),
      })
      received.add(index)
      record.received = [...received].sort((a, b) => a - b)
      writeResumeRecord(storageKey, record)
      sendProgress(completedBytes(), 0)
    }
  })
  await Promise.all(workers)
  const result = await post<{ ok: true; file: FileItem }>(`/api/uploads/${encodeId(session.uploadId)}/complete`, {}, {
    signal: options.signal,
  })
  clearResumeRecord(storageKey)
  return { items: [result.file], errors: [] }
}

/* ---------- 分片上传断点清理（v0.4.0） ---------- */

/**
 * 放弃某个文件的分片上传：DELETE 服务端会话并清除 localStorage 断点。
 * - 没有断点记录时为空操作；
 * - 服务端会话已完成/不存在（409/404）视为已清理，不向上抛错；
 * - 其它错误向上抛出，由调用方提示，但断点记录已清除，避免永久占用并发会话。
 */
export async function abandonChunkedUpload(file: File, parentId: string | null): Promise<void> {
  const fingerprint = uploadFingerprint(file, parentId)
  const key = resumeStorageKey(fingerprint)
  const record = readResumeRecord(key)
  clearResumeRecord(key)
  if (!record) return
  try {
    await del<{ ok: boolean }>(`/api/uploads/${encodeId(record.uploadId)}`)
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.status === 409)) return
    throw error
  }
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
  /** 轻量存储配额（v0.4.0）：文件页使用，避免为取配额触发 Dashboard 聚合。 */
  getStorage(signal?: AbortSignal): Promise<StorageInfo> {
    return get<StorageInfo>('/api/storage', { signal })
  },
  /** 指标历史（v0.4.0）：服务端按桶聚合，最多 240 点；非法 range 返回 400 invalid_range。 */
  getMetrics(range: MetricsRange = '24h', signal?: AbortSignal): Promise<MetricsResult> {
    return get<MetricsResult>(`/api/metrics${buildQuery({ range })}`, { signal })
  },
  getAudit(limit = 50, offset = 0, action?: string, signal?: AbortSignal): Promise<AuditPage> {
    return get<AuditPage>(`/api/audit${buildQuery({ limit, offset, action })}`, { signal })
  },
  /** 审计查询（v0.4.0）：支持动作/关键词/时间范围与分页，参数全部可选。 */
  getAuditPage(query: AuditQuery = {}, signal?: AbortSignal): Promise<AuditPage> {
    return get<AuditPage>(
      `/api/audit${buildQuery({
        limit: query.limit,
        offset: query.offset,
        action: query.action,
        q: query.q,
        from: query.from,
        to: query.to,
      })}`,
      { signal },
    )
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
    /**
     * 触发 Pi 端备份准备（只生成 pending，不 ack、不推进游标）。
     * 服务端上限 BACKUP_PREPARE_TIMEOUT_SEC（默认 3300s），必须放宽客户端超时；
     * 调用方在 timeout 时不得把它当作“未执行”（服务端可能仍在生成）。
     */
    prepare(totpCode?: string): Promise<BackupPrepareResult> {
      return post<BackupPrepareResult>(
        '/api/backups/prepare',
        {
          confirmText: 'PREPARE',
          ...(totpCode ? { totpCode } : {}),
        },
        { timeoutMs: BACKUP_LONG_OPERATION_TIMEOUTS.prepare },
      )
    },
    /** 上传归档：multipart + X-TOTP-Code 头，返回 archive 与自动校验结果。 */
    importArchive: uploadBackupArchive,
    /** 流式 SHA-256 + tar 安全校验；失败 409 checksum_mismatch / 422 invalid_archive。 */
    verify(name: string): Promise<BackupVerifyResult> {
      return post<BackupVerifyResult>(
        '/api/backups/verify',
        { name },
        { timeoutMs: BACKUP_LONG_OPERATION_TIMEOUTS.verify },
      )
    },
    /** 只读归档内容（最多 500 条），用于恢复时选择文件/目录。 */
    entries(name: string, path = '/'): Promise<BackupEntriesResult> {
      return get<BackupEntriesResult>(
        `/api/backups/archives/${encodeId(name)}/entries${buildQuery({ path })}`,
        { timeoutMs: BACKUP_LONG_OPERATION_TIMEOUTS.entries },
      )
    },
    /** 创建恢复计划：选择归档（链由服务端按 manifest 解析）与可选文件路径。 */
    async restorePlan(input: {
      archive: string
      paths?: string[]
      totpCode: string
    }): Promise<RestorePlanResult> {
      return normalizeRestorePlan(
        await post<unknown>(
          '/api/backups/restore-plan',
          {
            archive: input.archive,
            ...(input.paths && input.paths.length > 0 ? { paths: input.paths } : {}),
            totpCode: input.totpCode,
            confirmText: 'RESTORE',
          },
          { timeoutMs: BACKUP_LONG_OPERATION_TIMEOUTS.restorePlan },
        ),
      )
    },
    /** 计划详情（轮询执行状态）。 */
    async getRestore(planId: string): Promise<RestorePlanResult> {
      return normalizeRestorePlan(
        await get<unknown>(`/api/restores/${encodeId(planId)}`, {
          timeoutMs: BACKUP_LONG_OPERATION_TIMEOUTS.getRestore,
        }),
      )
    },
    /** 执行恢复：TOTP + typed confirmation；服务端只恢复到新目录，失败可重试。 */
    async executeRestore(planId: string, totpCode: string): Promise<RestoreExecuteResult> {
      return normalizeExecuteResult(
        await post<unknown>(
          `/api/restores/${encodeId(planId)}/execute`,
          {
            totpCode,
            confirmText: 'RESTORE',
          },
          { timeoutMs: BACKUP_LONG_OPERATION_TIMEOUTS.executeRestore },
        ),
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
    /** 单个文件详情（GET /api/files/:id → {item,path}）；分片上传断点恢复时用于取回已登记文件。 */
    async get(id: string, signal?: AbortSignal): Promise<FileItem> {
      const result = await get<{ item?: FileItem }>(`/api/files/${encodeId(id)}`, { signal })
      if (!result?.item) throw new ApiError(0, 'invalid_response', ERROR_MESSAGES.invalid_response ?? '服务端返回的数据无法解析')
      return result.item
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
    list(page = 1, pageSize = 100, signal?: AbortSignal): Promise<ShareListResult> {
      return get<ShareListResult>(`/api/shares${buildQuery({ page, pageSize })}`, { signal })
    },
    /** v0.4.0 多文件分享：fileIds 1–50、去重，全部为活动普通文件。 */
    createBundle(input: CreateShareBundleInput): Promise<CreateShareResult> {
      return post<CreateShareResult>('/api/shares', input)
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
    itemContentUrl: publicShareItemContentUrl,
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
  /**
   * mcbot 集成（v0.8.0）：状态/历史为只读 GET；任务/移动/聊天为写操作，
   * 服务端校验登录态与 CSRF，并可能返回 mcbot_disabled/mcbot_control_disabled 等降级错误。
   * 本客户端不接触 mcbot Token/URL，控制操作后由调用方重新拉取 status 校验结果。
   */
  mcbot: {
    status(signal?: AbortSignal): Promise<McbotSnapshot> {
      return get<McbotSnapshot>('/api/mcbot/status', { signal })
    },
    /** mcbot 历史：kind=samples|alerts；服务端透传 mcbot 形状（samples/alerts 动态键）。 */
    history(query: McbotHistoryQuery, signal?: AbortSignal): Promise<McbotHistory> {
      return get<McbotHistory>(
        `/api/mcbot/history${buildQuery({
          kind: query.kind,
          from: query.from,
          to: query.to,
          limit: query.limit,
        })}`,
        { signal },
      )
    },
    startTask(name: McbotTaskName): Promise<McbotActionResult> {
      return post<McbotActionResult>('/api/mcbot/tasks', { name })
    },
    stopTask(): Promise<McbotActionResult> {
      return post<McbotActionResult>('/api/mcbot/tasks/stop', {})
    },
    /** 省略 taskId 时由服务端恢复唯一 pending 任务；带 taskId 校验是否匹配。 */
    resumeTask(taskId?: string): Promise<McbotActionResult> {
      return post<McbotActionResult>('/api/mcbot/tasks/resume', taskId ? { taskId } : {})
    },
    /** home 忽略 target；come/follow 的 target 必须在 mcbot 在线玩家列表中。 */
    move(action: McbotMoveAction, target?: string): Promise<McbotActionResult> {
      return post<McbotActionResult>('/api/mcbot/move', target ? { action, target } : { action })
    },
    say(message: string): Promise<McbotActionResult> {
      return post<McbotActionResult>('/api/mcbot/say', { message })
    },
  },
  /**
   * 机器人管理（v0.5.0）：所有接口要求登录；配置接口在功能未启用时返回
   * 503 chatbot_disabled / chatbot_key_missing。密钥只写不读，响应中不含密钥。
   */
  chatbots: {
    status(signal?: AbortSignal): Promise<ChatbotStatus> {
      return get<ChatbotStatus>('/api/chatbots/status', { signal })
    },
    connectivity(signal?: AbortSignal): Promise<ChatbotConnectivitySnapshot> {
      return get<ChatbotConnectivitySnapshot>('/api/chatbots/connectivity', { signal })
    },
    checkConnectivity(): Promise<ChatbotConnectivitySnapshot> {
      return post<ChatbotConnectivitySnapshot>('/api/chatbots/connectivity/check')
    },
    async list(signal?: AbortSignal): Promise<ChatbotSummary[]> {
      const result = await get<{ items: ChatbotSummary[] }>('/api/chatbots', { signal })
      return result.items
    },
    async get(id: string, signal?: AbortSignal): Promise<ChatbotSummary> {
      const result = await get<{ chatbot: ChatbotSummary }>(`/api/chatbots/${encodeId(id)}`, { signal })
      return result.chatbot
    },
    async metrics(id: string, hours = 24, signal?: AbortSignal): Promise<ChatbotMetrics> {
      const result = await get<{ metrics: ChatbotMetrics }>(
        `/api/chatbots/${encodeId(id)}/metrics${buildQuery({ hours })}`,
        { signal },
      )
      return result.metrics
    },
    async create(input: ChatbotCreateInput): Promise<ChatbotSummary> {
      const result = await post<{ chatbot: ChatbotSummary }>('/api/chatbots', input)
      return result.chatbot
    },
    async update(id: string, input: ChatbotUpdateInput): Promise<ChatbotSummary> {
      const result = await patch<{ chatbot: ChatbotSummary }>(`/api/chatbots/${encodeId(id)}`, input)
      return result.chatbot
    },
    remove(id: string): Promise<OkResult> {
      return del<OkResult>(`/api/chatbots/${encodeId(id)}`)
    },
    /** 发送测试消息；省略 targetId 时服务端使用该 Chatbot 的第一个目标。 */
    test(id: string, targetId?: string): Promise<OkResult> {
      return post<OkResult>(
        `/api/chatbots/${encodeId(id)}/test`,
        targetId ? { targetId } : {},
      )
    },
    /**
     * 连接自检（v0.5.7）：服务端校验 Token/Webhook/公开配置并更新 last_checked_at。
     * 返回项只描述可用性与脱敏原因，不含任何密钥。
     */
    async check(id: string): Promise<ChatbotHealthCheck> {
      const result = await post<{ health: ChatbotHealthCheck }>(`/api/chatbots/${encodeId(id)}/check`)
      return result.health
    },
    /** 入站事件元数据（v0.5.7）：支持时间范围/结果筛选与分页，不返回消息正文。 */
    events(
      id: string,
      options: { hours?: number; outcome?: string; limit?: number; offset?: number } = {},
    ): Promise<{ items: ChatbotEventItem[]; total: number }> {
      return get<{ items: ChatbotEventItem[]; total: number }>(
        `/api/chatbots/${encodeId(id)}/events${buildQuery({
          hours: options.hours,
          outcome: options.outcome,
          limit: options.limit,
          offset: options.offset,
        })}`,
      )
    },
    /** 私聊角色卡与长期记忆管理（v0.5.7）：只操作元数据，正文不通过 Web 读写。 */
    roles: {
      list(
        id: string,
        options: { limit?: number; offset?: number } = {},
      ): Promise<{ items: ChatbotRoleSummary[]; total: number }> {
        return get<{ items: ChatbotRoleSummary[]; total: number }>(
          `/api/chatbots/${encodeId(id)}/roles${buildQuery({ limit: options.limit, offset: options.offset })}`,
        )
      },
      /** 启用/停用某个用户的角色卡，不修改角色正文。 */
      async setEnabled(id: string, userId: string, enabled: boolean): Promise<void> {
        await patch<OkResult>(`/api/chatbots/${encodeId(id)}/roles/${encodeId(userId)}`, { enabled })
      },
      async remove(id: string, userId: string): Promise<void> {
        await del<OkResult>(`/api/chatbots/${encodeId(id)}/roles/${encodeId(userId)}`)
      },
    },
    /** 群聊角色卡：管理员可读写名字与正文；普通用户不可见。 */
    groupRoles: {
      list(id: string): Promise<{ items: ChatbotGroupRoleSummary[] }> {
        return get<{ items: ChatbotGroupRoleSummary[] }>(`/api/chatbots/${encodeId(id)}/group-roles`)
      },
      get(id: string, targetId: string): Promise<{ groupRole: ChatbotGroupRoleDetail | null }> {
        return get<{ groupRole: ChatbotGroupRoleDetail | null }>(
          `/api/chatbots/${encodeId(id)}/group-roles/${encodeId(targetId)}`,
        )
      },
      async save(id: string, targetId: string, input: { name: string; prompt: string }): Promise<ChatbotGroupRoleDetail> {
        const result = await put<{ groupRole: ChatbotGroupRoleDetail }>(
          `/api/chatbots/${encodeId(id)}/group-roles/${encodeId(targetId)}`,
          input,
        )
        return result.groupRole
      },
      async setEnabled(id: string, targetId: string, enabled: boolean): Promise<void> {
        await patch<OkResult>(`/api/chatbots/${encodeId(id)}/group-roles/${encodeId(targetId)}`, { enabled })
      },
      async remove(id: string, targetId: string): Promise<void> {
        await del<OkResult>(`/api/chatbots/${encodeId(id)}/group-roles/${encodeId(targetId)}`)
      },
    },
    memories: {
      /** 用户级结构化记忆元数据：条目数/类型分布/启用状态，不含正文。 */
      list(
        id: string,
        options: { limit?: number; offset?: number } = {},
      ): Promise<{ items: ChatbotMemoryUserSummary[]; total: number }> {
        return get<{ items: ChatbotMemoryUserSummary[]; total: number }>(
          `/api/chatbots/${encodeId(id)}/memories${buildQuery({ limit: options.limit, offset: options.offset })}`,
        )
      },
      /** 单用户记忆条目元数据：只含类型/权重/时间，不含 key/value。 */
      items(
        id: string,
        userId: string,
        options: { limit?: number; offset?: number } = {},
      ): Promise<{ items: ChatbotMemoryItemSummary[]; total: number }> {
        return get<{ items: ChatbotMemoryItemSummary[]; total: number }>(
          `/api/chatbots/${encodeId(id)}/memories/${encodeId(userId)}/items${buildQuery({
            limit: options.limit,
            offset: options.offset,
          })}`,
        )
      },
      /** 删除单条记忆；只提交条目 id，服务端不回传正文。 */
      async removeItem(id: string, userId: string, itemId: string): Promise<void> {
        await del<OkResult>(
          `/api/chatbots/${encodeId(id)}/memories/${encodeId(userId)}/items/${encodeId(itemId)}`,
        )
      },
      /** 删除某用户的全部记忆条目。 */
      async remove(id: string, userId: string): Promise<void> {
        await del<OkResult>(`/api/chatbots/${encodeId(id)}/memories/${encodeId(userId)}`)
      },
    },
    groupMemories: {
      /** 群聊共享记忆元数据：按群目标聚合，不含正文。 */
      list(
        id: string,
        options: { limit?: number; offset?: number } = {},
      ): Promise<{ items: ChatbotMemoryGroupSummary[]; total: number }> {
        return get<{ items: ChatbotMemoryGroupSummary[]; total: number }>(
          `/api/chatbots/${encodeId(id)}/group-memories${buildQuery({ limit: options.limit, offset: options.offset })}`,
        )
      },
      /** 清空某个群目标的共享记忆。 */
      async remove(id: string, scope: string): Promise<void> {
        await del<OkResult>(`/api/chatbots/${encodeId(id)}/group-memories/${encodeId(scope)}`)
      },
    },
    targets: {
      async list(chatbotId: string, signal?: AbortSignal): Promise<ChatbotTarget[]> {
        const result = await get<{ items: ChatbotTarget[] }>(`/api/chatbots/${encodeId(chatbotId)}/targets`, { signal })
        return result.items
      },
      async listInbound(chatbotId: string, limit = 50, signal?: AbortSignal): Promise<ChatbotInboundTarget[]> {
        const result = await get<{ items: ChatbotInboundTarget[] }>(
          `/api/chatbots/${encodeId(chatbotId)}/inbound-targets${buildQuery({ limit })}`,
          { signal },
        )
        return result.items
      },
      async create(chatbotId: string, input: ChatbotTargetInput): Promise<ChatbotTarget> {
        const result = await post<{ target: ChatbotTarget }>(`/api/chatbots/${encodeId(chatbotId)}/targets`, input)
        return result.target
      },
      async update(chatbotId: string, targetId: string, patchBody: ChatbotTargetPatch): Promise<ChatbotTarget> {
        const result = await patch<{ target: ChatbotTarget }>(
          `/api/chatbots/${encodeId(chatbotId)}/targets/${encodeId(targetId)}`,
          patchBody,
        )
        return result.target
      },
      remove(chatbotId: string, targetId: string): Promise<OkResult> {
        return del<OkResult>(`/api/chatbots/${encodeId(chatbotId)}/targets/${encodeId(targetId)}`)
      },
    },
    deliveries: {
      async list(chatbotId: string, limit = 50, signal?: AbortSignal): Promise<ChatbotDelivery[]> {
        const result = await get<{ items: ChatbotDelivery[] }>(
          `/api/chatbots/${encodeId(chatbotId)}/deliveries${buildQuery({ limit })}`,
          { signal },
        )
        return result.items
      },
      /** 仅 failed/dead 可重试；服务端返回 404 表示不可重试。 */
      retry(chatbotId: string, deliveryId: string): Promise<OkResult> {
        return post<OkResult>(`/api/chatbots/${encodeId(chatbotId)}/deliveries/${encodeId(deliveryId)}/retry`)
      },
    },
    publish: {
      async list(chatbotId: string, limit = 50, signal?: AbortSignal): Promise<ChatbotPublishJob[]> {
        const result = await get<{ items: ChatbotPublishJob[] }>(
          `/api/chatbots/${encodeId(chatbotId)}/publish${buildQuery({ limit })}`,
          { signal },
        )
        return result.items
      },
      async create(chatbotId: string, input: ChatbotPublishInput): Promise<ChatbotPublishJob> {
        const result = await post<{ job: ChatbotPublishJob }>(`/api/chatbots/${encodeId(chatbotId)}/publish`, input)
        return result.job
      },
      /** 取消 queued/draft 任务；已进入发送流程的任务返回 404。 */
      cancel(chatbotId: string, jobId: string): Promise<OkResult> {
        return del<OkResult>(`/api/chatbots/${encodeId(chatbotId)}/publish/${encodeId(jobId)}`)
      },
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
    /** v0.4.0 笔记附件：计入总配额，不出现在普通文件列表/搜索/回收站。 */
    attachments: {
      list(noteId: string, signal?: AbortSignal): Promise<NoteAttachmentListResult> {
        return get<NoteAttachmentListResult>(`/api/notes/${encodeId(noteId)}/attachments`, { signal })
      },
      upload: uploadNoteAttachments,
      /** 硬删除附件并释放配额（不进入回收站）。 */
      remove(noteId: string, fileId: string): Promise<OkResult> {
        return del<OkResult>(`/api/notes/${encodeId(noteId)}/attachments/${encodeId(fileId)}`)
      },
    },
    /** v0.4.0 笔记历史版本：更新标题/正文/标签时自动快照。 */
    versions: {
      list(noteId: string, query: NoteVersionQuery = {}, signal?: AbortSignal): Promise<NoteVersionListResult> {
        return get<NoteVersionListResult>(
          `/api/notes/${encodeId(noteId)}/versions${buildQuery({ limit: query.limit, offset: query.offset })}`,
          { signal },
        )
      },
      get(noteId: string, versionId: string, signal?: AbortSignal): Promise<NoteVersionResult> {
        return get<NoteVersionResult>(
          `/api/notes/${encodeId(noteId)}/versions/${encodeId(versionId)}`,
          { signal },
        )
      },
      /** 恢复历史版本；恢复前服务端会先保存当前版本快照。 */
      restore(noteId: string, versionId: string): Promise<Note> {
        return post<Note>(`/api/notes/${encodeId(noteId)}/versions/${encodeId(versionId)}/restore`)
      },
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
    /** 告警历史：limit/offset 分页，可按事件/状态/严重度筛选（v0.4.0，参数均可选）。 */
    list(limit = 20, query: Omit<AlertListQuery, 'limit'> = {}, signal?: AbortSignal): Promise<AlertsResult> {
      return get<AlertsResult>(
        `/api/alerts${buildQuery({
          limit,
          offset: query.offset,
          event: query.event,
          status: query.status,
          severity: query.severity,
        })}`,
        { signal },
      )
    },
    test(): Promise<AlertTestResult> {
      return post<AlertTestResult>('/api/alerts/test')
    },
  },
}
