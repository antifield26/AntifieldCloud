/**
 * Lofii 对接 HTTP 路由（v0.8.0）。
 *
 * 边界：
 * - 全部需要登录；控制接口额外校验 CSRF，并按 IP 限流（控制 20/min，聊天 10/min）。
 * - 上游错误统一映射为 AppError：禁用/不可用 503、鉴权/上游异常 502、上游 400/409
 *   保留状态码并透传稳定码 `lofii_<上游 code>`；message 不含内部 URL/Token。
 * - 审计记录控制动作元数据；/say 只记录字符数，绝不记录聊天正文。
 */
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../../config.ts'
import { LofiiError } from '../../lofii/client.ts'
import type { LofiiService } from '../../lofii/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { AppError, badRequest, rateLimited } from '../../util/errors.ts'
import { audit } from '../../auth/audit.ts'
import { asRecord, clientIp, parsePositiveInt } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

/** Lofii 支持的 7 种任务名（与上游 /task/start 一致）。 */
export const LOFII_TASK_NAMES = ['fishing', 'farming', 'woodcutting', 'mining', 'forest', 'sleep', 'patrol'] as const
export type LofiiTaskName = (typeof LOFII_TASK_NAMES)[number]
export const LOFII_MOVE_ACTIONS = ['home', 'come', 'follow', 'stop'] as const
export type LofiiMoveAction = (typeof LOFII_MOVE_ACTIONS)[number]
/** 与上游 /say 一致：trim 后 1..720 字符。 */
export const LOFII_SAY_MAX_CHARS = 720

const TASK_NAMES = new Set<string>(LOFII_TASK_NAMES)
const MOVE_ACTIONS = new Set<string>(LOFII_MOVE_ACTIONS)

/** 上游稳定错误码的中文兜底文案；不含上游 message，避免英文/内部细节外泄。 */
const ERROR_MESSAGES: Record<string, string> = {
  lofii_disabled: 'Lofii 对接未启用',
  lofii_control_disabled: 'Lofii 控制接口未启用（未配置控制 Token）',
  lofii_unavailable: 'Lofii 服务不可用',
  lofii_auth_failed: 'Lofii 鉴权失败（Token 无效）',
  lofii_upstream_error: 'Lofii 上游响应异常',
  lofii_rate_limited: 'Lofii 请求过于频繁，请稍后重试',
  lofii_resume_pending: 'Lofii 有待恢复任务，请先恢复或停止',
  lofii_queue_full: 'Lofii 任务队列已满',
  lofii_no_active_task: 'Lofii 当前没有运行中的任务',
  lofii_no_pending_task: 'Lofii 当前没有待恢复的任务',
  lofii_resume_failed: 'Lofii 任务恢复失败（可能已过期或 taskId 不匹配）',
  lofii_task_active: 'Lofii 任务运行中，请先停止任务再移动',
  lofii_target_not_online: '目标玩家不在线',
  lofii_not_connected: 'Lofii 当前未连接 Minecraft',
  lofii_task_disabled: 'Lofii 任务功能已关闭',
  lofii_invalid_request: 'Lofii 拒绝了请求参数',
}

function errorMessageFor(code: string, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback
}

/** LofiiError → 稳定的 AppError（保留上游 400/409，其余按契约 503/502/429）。 */
export function toLofiiAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof LofiiError) {
    const code = error.code
    if (error.statusCode === 400 || error.statusCode === 409) {
      return new AppError(error.statusCode, code, errorMessageFor(code, 'Lofii 拒绝了请求'))
    }
    if (error.statusCode === 429) {
      return new AppError(429, 'lofii_rate_limited', errorMessageFor('lofii_rate_limited', '请稍后重试'), {
        retryAfterSec: 60,
      })
    }
    if (code === 'lofii_auth_failed' || code === 'lofii_upstream_error') {
      return new AppError(502, code, errorMessageFor(code, 'Lofii 上游响应异常'))
    }
    return new AppError(503, code, errorMessageFor(code, 'Lofii 服务不可用'))
  }
  return new AppError(502, 'lofii_upstream_error', errorMessageFor('lofii_upstream_error', 'Lofii 上游响应异常'))
}

/** 查询参数时间：空值忽略；非 ISO 返回 400，避免静默变全量查询。 */
function timeParam(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw badRequest(`参数 ${field} 必须是 ISO 时间`, 'invalid_request')
  return new Date(Date.parse(text)).toISOString()
}

function requireEnabled(lofii: LofiiService): void {
  if (!lofii.enabled) throw new AppError(503, 'lofii_disabled', errorMessageFor('lofii_disabled', 'Lofii 对接未启用'))
}

export function registerLofiiRoutes(
  app: FastifyInstance,
  config: Config,
  lofii: LofiiService,
  db: DatabaseSync,
): void {
  const csrf = csrfGuard(config)
  const controlLimiter = new SlidingWindowLimiter(60_000, 20)
  const sayLimiter = new SlidingWindowLimiter(60_000, 10)

  /** 控制失败审计：只记稳定错误码，不记 Token/URL/上游原文。 */
  function auditFailure(actor: { username: string; ip: string | null }, action: string, error: unknown): void {
    const code = error instanceof LofiiError ? error.code : 'lofii_upstream_error'
    audit(db, actor.username, 'lofii.control_failed', action, { code }, actor.ip)
  }

  app.get('/api/lofii/status', { preHandler: [requireAuth] }, async () => lofii.snapshot())

  app.get('/api/lofii/history', { preHandler: [requireAuth] }, async (request) => {
    requireEnabled(lofii)
    const query = asRecord(request.query)
    const rawKind = query.kind === undefined || query.kind === '' ? 'samples' : query.kind
    if (rawKind !== 'samples' && rawKind !== 'alerts') throw badRequest('kind 必须是 samples 或 alerts', 'invalid_request')
    const from = timeParam(query.from, 'from')
    const to = timeParam(query.to, 'to')
    const limit = parsePositiveInt(query.limit, 100, 1, 200)
    try {
      return await lofii.history(rawKind, {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit,
      })
    } catch (error) {
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/lofii/tasks', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(lofii)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!TASK_NAMES.has(name)) {
      throw badRequest(`任务名必须是 ${LOFII_TASK_NAMES.join('/')} 之一`, 'invalid_request')
    }
    try {
      const result = await lofii.startTask(name)
      audit(db, actor.username, 'lofii.task.start', name, { name }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'lofii.task.start', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/lofii/tasks/stop', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(lofii)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    try {
      const result = await lofii.stopTask()
      audit(db, actor.username, 'lofii.task.stop', 'task', null, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'lofii.task.stop', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/lofii/tasks/resume', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(lofii)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    let taskId: string | undefined
    if (body.taskId !== undefined && body.taskId !== null) {
      if (typeof body.taskId !== 'string' || body.taskId.length === 0 || body.taskId.length > 64) {
        throw badRequest('taskId 不合法', 'invalid_request')
      }
      taskId = body.taskId
    }
    try {
      const result = await lofii.resumeTask(taskId)
      audit(db, actor.username, 'lofii.task.resume', taskId ?? 'task', { taskId: taskId ?? null }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'lofii.task.resume', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/lofii/move', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(lofii)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const action = typeof body.action === 'string' ? body.action : ''
    if (!MOVE_ACTIONS.has(action)) {
      throw badRequest(`action 必须是 ${LOFII_MOVE_ACTIONS.join('/')} 之一`, 'invalid_request')
    }
    let target: string | undefined
    if (body.target !== undefined && body.target !== null) {
      if (typeof body.target !== 'string') throw badRequest('target 不合法', 'invalid_request')
      const trimmed = body.target.trim()
      if (trimmed.length > 32) throw badRequest('target 不合法', 'invalid_request')
      if (trimmed) target = trimmed
    }
    try {
      const result = await lofii.move(action, target)
      audit(db, actor.username, 'lofii.move', action, { action, target: target ?? null }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'lofii.move', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/lofii/say', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(lofii)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = sayLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const raw = typeof body.message === 'string' ? body.message : ''
    const message = raw.trim()
    if (!message) throw badRequest('消息不能为空', 'invalid_request')
    if (message.length > LOFII_SAY_MAX_CHARS) {
      throw badRequest(`消息最多 ${LOFII_SAY_MAX_CHARS} 字符`, 'invalid_request')
    }
    if (message.startsWith('/')) {
      throw badRequest('消息不能以 / 开头（不支持命令）', 'message_must_not_start_with_slash')
    }
    try {
      const result = await lofii.say(message)
      // 审计只记录字符数，绝不记录聊天正文。
      audit(db, actor.username, 'lofii.say', null, { chars: message.length }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'lofii.say', error)
      throw toLofiiAppError(error)
    }
  })
}
