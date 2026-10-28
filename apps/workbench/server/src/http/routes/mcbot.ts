/**
 * mcbot 对接 HTTP 路由（v0.8.0；v1.0.2 增加 AI 自主模式代理）。
 *
 * 边界：
 * - 全部需要登录；GET 按 IP 限流 60/min；控制接口额外校验 CSRF，并按 IP 限流（控制 20/min，聊天 10/min）。
 * - 上游错误统一映射为 AppError：禁用/不可用 503、鉴权/上游异常 502、上游 400/409
 *   保留状态码并透传稳定码 `mcbot_<上游 code>`；message 不含内部 URL/Token。
 * - 自主目标/停止原因只做长度与控制字符校验；审计只记字符数，不记录目标/原因正文。
 * - 审计记录控制动作元数据；/say 只记录字符数，绝不记录聊天正文。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../../config.ts'
import { McbotError } from '../../mcbot/client.ts'
import type { McbotService } from '../../mcbot/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { AppError, badRequest, rateLimited } from '../../util/errors.ts'
import { audit } from '../../auth/audit.ts'
import { asRecord, clientIp, parsePositiveInt } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

/** mcbot 支持的 10 种任务名（与上游 /task/start 一致）。 */
export const MCBOT_TASK_NAMES = [
  'fishing',
  'farming',
  'woodcutting',
  'mining',
  'forest',
  'sleep',
  'patrol',
  'guard',
  'escort',
  'explore',
] as const
export type McbotTaskName = (typeof MCBOT_TASK_NAMES)[number]
export const MCBOT_MOVE_ACTIONS = ['home', 'come', 'follow', 'stop'] as const
export type McbotMoveAction = (typeof MCBOT_MOVE_ACTIONS)[number]
/** 与上游 /say 一致：trim 后 1..720 字符。 */
export const MCBOT_SAY_MAX_CHARS = 720
/** 自主目标上限（与上游 AUTONOMY_GOAL_MAX_CHARS 默认值一致）。 */
export const MCBOT_AUTONOMY_GOAL_MAX_CHARS = 200
/** 自主停止原因上限。 */
export const MCBOT_AUTONOMY_REASON_MAX_CHARS = 200

const TASK_NAMES = new Set<string>(MCBOT_TASK_NAMES)
const MOVE_ACTIONS = new Set<string>(MCBOT_MOVE_ACTIONS)

/** 聊天/taskId 不允许 C0 控制字符与 DEL（避免命令/日志/上游参数注入面）。 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** 可选文本参数：缺省/null/纯空白视为未提供；非字符串、超长、含控制字符返回 400。 */
function optionalBoundedText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw badRequest(`${field} 不合法`, 'invalid_request')
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > max) throw badRequest(`${field} 最多 ${max} 字符`, 'invalid_request')
  if (hasControlChars(trimmed)) throw badRequest(`${field} 不能包含控制字符`, 'invalid_request')
  return trimmed
}

/** 上游稳定错误码的中文兜底文案；不含上游 message，避免英文/内部细节外泄。 */
const ERROR_MESSAGES: Record<string, string> = {
  mcbot_disabled: 'mcbot 对接未启用',
  mcbot_control_disabled: 'mcbot 控制接口未启用（未配置控制 Token）',
  mcbot_unavailable: 'mcbot 服务不可用',
  mcbot_auth_failed: 'mcbot 鉴权失败（Token 无效）',
  mcbot_upstream_error: 'mcbot 上游响应异常',
  mcbot_rate_limited: 'mcbot 请求过于频繁，请稍后重试',
  mcbot_resume_pending: 'mcbot 有待恢复任务，请先恢复或停止',
  mcbot_queue_full: 'mcbot 任务队列已满',
  mcbot_no_active_task: 'mcbot 当前没有运行中的任务',
  mcbot_no_pending_task: 'mcbot 当前没有待恢复的任务',
  mcbot_resume_failed: 'mcbot 任务恢复失败（可能已过期或 taskId 不匹配）',
  mcbot_task_active: 'mcbot 任务运行中，请先停止任务再移动',
  mcbot_target_not_online: '目标玩家不在线',
  mcbot_not_connected: 'mcbot 当前未连接 Minecraft',
  mcbot_task_disabled: 'mcbot 任务功能已关闭',
  mcbot_history_disabled: 'mcbot 历史功能已关闭',
  mcbot_invalid_request: 'mcbot 拒绝了请求参数',
  mcbot_autonomy_disabled: 'mcbot 自主模式未启用',
  mcbot_autonomy_busy: 'mcbot 自主模式正在运行，请先停止',
  mcbot_autonomy_unavailable: 'mcbot 自主模式不可用',
  mcbot_autonomy_failed: 'mcbot 自主模式启动失败',
}

function errorMessageFor(code: string, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback
}

/** McbotError → 稳定的 AppError（保留上游 400/409，其余按契约 503/502/429）。 */
export function toLofiiAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof McbotError) {
    const code = error.code
    if (error.statusCode === 400 || error.statusCode === 409) {
      return new AppError(error.statusCode, code, errorMessageFor(code, 'mcbot 拒绝了请求'))
    }
    if (error.statusCode === 429) {
      return new AppError(429, 'mcbot_rate_limited', errorMessageFor('mcbot_rate_limited', '请稍后重试'), {
        retryAfterSec: 60,
      })
    }
    if (code === 'mcbot_auth_failed' || code === 'mcbot_upstream_error') {
      return new AppError(502, code, errorMessageFor(code, 'mcbot 上游响应异常'))
    }
    return new AppError(503, code, errorMessageFor(code, 'mcbot 服务不可用'))
  }
  return new AppError(502, 'mcbot_upstream_error', errorMessageFor('mcbot_upstream_error', 'mcbot 上游响应异常'))
}

/** 查询参数时间：空值忽略；非 ISO 返回 400，避免静默变全量查询。 */
function timeParam(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (!Number.isFinite(Date.parse(text))) throw badRequest(`参数 ${field} 必须是 ISO 时间`, 'invalid_request')
  return new Date(Date.parse(text)).toISOString()
}

function requireEnabled(mcbot: McbotService): void {
  if (!mcbot.enabled) throw new AppError(503, 'mcbot_disabled', errorMessageFor('mcbot_disabled', 'mcbot 对接未启用'))
}

export function registerLofiiRoutes(
  app: FastifyInstance,
  config: Config,
  mcbot: McbotService,
  db: DatabaseSync,
): void {
  const csrf = csrfGuard(config)
  const controlLimiter = new SlidingWindowLimiter(60_000, 20)
  const sayLimiter = new SlidingWindowLimiter(60_000, 10)
  // 只读 GET 限流：覆盖 /status、/history、/autonomy，UI 5 秒轮询（12/min）不受影响。
  const getLimiter = new SlidingWindowLimiter(60_000, 60)

  /** GET 限流：超限返回 429 + Retry-After。 */
  function limitGet(request: FastifyRequest): void {
    const retry = getLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
  }

  /** 控制失败审计：只记稳定错误码，不记 Token/URL/上游原文。 */
  function auditFailure(actor: { username: string; ip: string | null }, action: string, error: unknown): void {
    const code = error instanceof McbotError ? error.code : 'mcbot_upstream_error'
    audit(db, actor.username, 'mcbot.control_failed', action, { code }, actor.ip)
  }

  app.get('/api/mcbot/status', { preHandler: [requireAuth] }, async (request) => {
    limitGet(request)
    return mcbot.snapshot()
  })

  app.get('/api/mcbot/history', { preHandler: [requireAuth] }, async (request) => {
    limitGet(request)
    requireEnabled(mcbot)
    const query = asRecord(request.query)
    const rawKind = query.kind === undefined || query.kind === '' ? 'samples' : query.kind
    if (rawKind !== 'samples' && rawKind !== 'alerts') throw badRequest('kind 必须是 samples 或 alerts', 'invalid_request')
    const from = timeParam(query.from, 'from')
    const to = timeParam(query.to, 'to')
    const limit = parsePositiveInt(query.limit, 100, 1, 200)
    try {
      return await mcbot.history(rawKind, {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit,
      })
    } catch (error) {
      throw toLofiiAppError(error)
    }
  })

  app.get('/api/mcbot/autonomy', { preHandler: [requireAuth] }, async (request) => {
    limitGet(request)
    requireEnabled(mcbot)
    try {
      return { autonomy: await mcbot.autonomy() }
    } catch (error) {
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/autonomy/start', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const goal = optionalBoundedText(body.goal, 'goal', MCBOT_AUTONOMY_GOAL_MAX_CHARS)
    try {
      const result = await mcbot.startAutonomy(goal)
      // 自主目标可能包含用户描述：审计只记录字符数，不记录正文。
      audit(db, actor.username, 'mcbot.autonomy.start', null, { goalChars: goal?.length ?? 0 }, actor.ip)
      return { ok: true, autonomy: result.autonomy }
    } catch (error) {
      auditFailure(actor, 'mcbot.autonomy.start', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/autonomy/stop', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const reason = optionalBoundedText(body.reason, 'reason', MCBOT_AUTONOMY_REASON_MAX_CHARS)
    try {
      const result = await mcbot.stopAutonomy(reason)
      audit(db, actor.username, 'mcbot.autonomy.stop', null, { reasonChars: reason?.length ?? 0 }, actor.ip)
      return { ok: true, autonomy: result.autonomy }
    } catch (error) {
      auditFailure(actor, 'mcbot.autonomy.stop', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/tasks', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!TASK_NAMES.has(name)) {
      throw badRequest(`任务名必须是 ${MCBOT_TASK_NAMES.join('/')} 之一`, 'invalid_request')
    }
    try {
      const result = await mcbot.startTask(name)
      audit(db, actor.username, 'mcbot.task.start', name, { name }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'mcbot.task.start', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/tasks/stop', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    try {
      const result = await mcbot.stopTask()
      audit(db, actor.username, 'mcbot.task.stop', 'task', null, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'mcbot.task.stop', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/tasks/resume', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    let taskId: string | undefined
    if (body.taskId !== undefined && body.taskId !== null) {
      if (typeof body.taskId !== 'string') {
        throw badRequest('taskId 不合法', 'invalid_request')
      }
      const normalized = body.taskId.trim()
      // 任务 id 不接受空白/控制字符：避免把日志/审计/上游参数注入面扩大。
      if (
        normalized.length === 0 ||
        normalized.length > 64 ||
        /\s/.test(normalized) ||
        hasControlChars(normalized)
      ) {
        throw badRequest('taskId 不合法', 'invalid_request')
      }
      taskId = normalized
    }
    try {
      const result = await mcbot.resumeTask(taskId)
      audit(db, actor.username, 'mcbot.task.resume', taskId ?? 'task', { taskId: taskId ?? null }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'mcbot.task.resume', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/move', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = controlLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const action = typeof body.action === 'string' ? body.action : ''
    if (!MOVE_ACTIONS.has(action)) {
      throw badRequest(`action 必须是 ${MCBOT_MOVE_ACTIONS.join('/')} 之一`, 'invalid_request')
    }
    let target: string | undefined
    if (body.target !== undefined && body.target !== null) {
      if (typeof body.target !== 'string') throw badRequest('target 不合法', 'invalid_request')
      const trimmed = body.target.trim()
      if (trimmed.length > 32) throw badRequest('target 不合法', 'invalid_request')
      if (trimmed) target = trimmed
    }
    try {
      const result = await mcbot.move(action, target)
      audit(db, actor.username, 'mcbot.move', action, { action, target: target ?? null }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'mcbot.move', error)
      throw toLofiiAppError(error)
    }
  })

  app.post('/api/mcbot/say', { preHandler: [requireAuth, csrf] }, async (request) => {
    requireEnabled(mcbot)
    // /say 是写操作；即使上游用读 Token，应用侧也必须要求控制 Token，
    // 避免只读模式成为绕过任务/移动权限的写通道。
    if (!mcbot.controlEnabled) {
      throw new AppError(503, 'mcbot_control_disabled', errorMessageFor('mcbot_control_disabled', 'mcbot 控制接口未启用'))
    }
    const actor = { username: request.auth?.user.username ?? '', ip: clientIp(request) }
    const retry = sayLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const raw = typeof body.message === 'string' ? body.message : ''
    const message = raw.trim()
    if (!message) throw badRequest('消息不能为空', 'invalid_request')
    if (message.length > MCBOT_SAY_MAX_CHARS) {
      throw badRequest(`消息最多 ${MCBOT_SAY_MAX_CHARS} 字符`, 'invalid_request')
    }
    // 上游 mcbot 会按行宽切分聊天且只在整段开头转义 /；必须拒绝任意位置的 ASCII /，
    // 否则“填充字符 + /命令”会在切分后的第二行命中 mineflayer 命令通道。
    if (message.includes('/')) {
      throw badRequest('聊天内容不能包含 /（不支持命令，含切分后的命令行）', 'message_must_not_start_with_slash')
    }
    if (hasControlChars(message)) {
      throw badRequest('聊天内容不能包含控制字符', 'invalid_request')
    }
    try {
      const result = await mcbot.say(message)
      // 审计只记录字符数，绝不记录聊天正文。
      audit(db, actor.username, 'mcbot.say', null, { chars: message.length }, actor.ip)
      return { ok: true, ...result }
    } catch (error) {
      auditFailure(actor, 'mcbot.say', error)
      throw toLofiiAppError(error)
    }
  })
}
