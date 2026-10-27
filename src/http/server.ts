import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Bot } from 'mineflayer'
import type { AuditLogger } from '../audit.ts'
import type { Config } from '../config.ts'
import type { EventBus } from '../events/bus.ts'
import { SseHub } from '../events/sse.ts'
import type { HistoryStore } from '../history/store.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState, TaskName } from '../state.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import { InvalidMessageError, NotConnectedError } from '../errors.ts'
import { TaskError, type TaskController } from '../tasks/types.ts'
import { isAuthorized } from './auth.ts'

export interface HttpDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
  movement: MovementManager
  tasks: TaskController
  events: EventBus
  audit: AuditLogger
  history?: HistoryStore
  getBot: () => Bot | null
}

interface JsonResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

type MoveAction = 'home' | 'come' | 'follow' | 'stop'

const BODY_LIMIT = 8192
const SAY_LIMIT = 10
const SAY_WINDOW_MS = 60_000
const CONTROL_WINDOW_MS = 60_000

class BodyTooLargeError extends Error {}
class UnsupportedMediaTypeError extends Error {}

function sendJson (res: ServerResponse, response: JsonResponse): void {
  const payload = JSON.stringify(response.body)
  res.writeHead(response.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...response.headers
  })
  res.end(payload)
}

function sendError (res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, { status, body: { error: code, message } })
}

async function readJsonBody (req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new InvalidMessageError('request body is empty')
  try {
    return JSON.parse(text)
  } catch {
    throw new InvalidMessageError('request body must be valid JSON')
  }
}

function isJsonRequest (req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'] ?? ''
  return contentType.toString().toLowerCase().startsWith('application/json')
}

function isObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class HttpApi {
  private readonly deps: HttpDeps
  private readonly sse: SseHub
  private server: Server | null = null
  private readonly sayTimestamps: number[] = []
  private readonly controlTimestamps: number[] = []

  constructor (deps: HttpDeps) {
    this.deps = deps
    this.sse = new SseHub({
      events: deps.events,
      logger: deps.logger,
      maxClients: deps.config.sseMaxClients,
      heartbeatMs: deps.config.sseHeartbeatMs,
      getSnapshot: () => deps.state.snapshot()
    })
  }

  async start (): Promise<number> {
    const { config, logger } = this.deps
    const server = createServer((req, res) => {
      const startedAt = Date.now()
      void this.handle(req, res).catch(error => {
        logger.error('http handler crashed', { error: error instanceof Error ? error.message : String(error) })
        if (!res.headersSent) sendError(res, 500, 'internal_error', 'internal error')
        else res.end()
      }).finally(() => {
        logger.debug('http request', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          ms: Date.now() - startedAt
        })
      })
    })
    server.keepAliveTimeout = 5000
    server.headersTimeout = 6000
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(config.httpPort, config.httpHost, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : config.httpPort
    logger.info('http listening', { host: config.httpHost, port })
    return port
  }

  private async handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    if (pathname === '/healthz') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      const snapshot = this.deps.state.snapshot()
      sendJson(res, {
        status: 200,
        body: {
          status: 'ok',
          version: snapshot.version,
          uptimeSec: snapshot.uptimeSec,
          state: snapshot.state,
          connected: snapshot.minecraft.connected
        }
      })
      return
    }
    if (pathname === '/events') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      if (!this.authorizeRead(req, res)) return
      this.sse.handle(req, res)
      return
    }
    if (pathname === '/status') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      if (!this.authorizeRead(req, res)) return
      sendJson(res, { status: 200, body: this.deps.state.snapshot() })
      return
    }
    if (pathname === '/admin/status') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      if (!this.authorizeRead(req, res)) return
      sendJson(res, { status: 200, body: { admin: this.deps.state.snapshot().admin } })
      return
    }
    if (pathname === '/history') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      if (!this.authorizeRead(req, res)) return
      if (!this.deps.config.history.enabled || !this.deps.history) {
        return sendError(res, 503, 'history_disabled', 'history is disabled')
      }
      try {
        const kind = url.searchParams.get('kind') ?? 'samples'
        if (kind !== 'samples' && kind !== 'alerts') throw new InvalidMessageError('kind must be samples or alerts')
        const limitRaw = url.searchParams.get('limit')
        let limit: number | undefined
        if (limitRaw !== null) {
          limit = Number(limitRaw)
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new InvalidMessageError('limit must be 1..1000')
        }
        const from = url.searchParams.get('from') ?? undefined
        const to = url.searchParams.get('to') ?? undefined
        const query = { from, to, limit }
        const rows = kind === 'samples'
          ? this.deps.history.querySamples(query)
          : this.deps.history.queryAlerts(query)
        sendJson(res, {
          status: 200,
          body: {
            kind,
            from: from ?? null,
            to: to ?? null,
            count: rows.length,
            [kind]: rows
          }
        })
      } catch (error) {
        if (error instanceof InvalidMessageError) return sendError(res, 400, 'invalid_request', error.message)
        if (error instanceof Error && /ISO-8601/.test(error.message)) return sendError(res, 400, 'invalid_request', error.message)
        throw error
      }
      return
    }
    if (pathname === '/task') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      if (!this.authorizeRead(req, res)) return
      sendJson(res, { status: 200, body: { task: this.deps.state.snapshot().task } })
      return
    }
    if (pathname === '/task/start') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
      if (!this.authorizeControl(req, res)) return
      if (!this.takeControlSlot()) return this.rateLimited(res, 'control')
      return this.handleTaskStart(req, res)
    }
    if (pathname === '/task/stop') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
      if (!this.authorizeControl(req, res)) return
      if (!this.takeControlSlot()) return this.rateLimited(res, 'control')
      return this.handleTaskStop(req, res)
    }
    if (pathname === '/task/resume') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
      if (!this.authorizeControl(req, res)) return
      if (!this.takeControlSlot()) return this.rateLimited(res, 'control')
      return this.handleTaskResume(req, res)
    }
    if (pathname === '/move') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
      if (!this.authorizeControl(req, res)) return
      if (!this.takeControlSlot()) return this.rateLimited(res, 'control')
      return this.handleMove(req, res)
    }
    if (pathname === '/say') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
      if (!this.authorizeRead(req, res)) return
      if (!this.takeSaySlot()) return this.rateLimited(res, 'say')
      if (!this.deps.chatSender.isConnected()) return sendError(res, 409, 'not_connected', 'bot is not connected')
      if (!isJsonRequest(req)) return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      try {
        const body = await readJsonBody(req)
        if (!isObject(body)) throw new InvalidMessageError('body must be an object')
        const message = body.message
        if (typeof message !== 'string') throw new InvalidMessageError('message must be a string')
        const trimmed = message.trim()
        if (trimmed === '') throw new InvalidMessageError('message must not be empty')
        if (trimmed.length > 720) throw new InvalidMessageError('message is too long (max 720)')
        if (trimmed.startsWith('/')) return sendError(res, 400, 'message_must_not_start_with_slash', 'chat messages must not start with /')
        const lines = await this.deps.chatSender.say(trimmed, 'http')
        sendJson(res, { status: 200, body: { ok: true, lines: lines.length } })
      } catch (error) {
        if (error instanceof BodyTooLargeError) return sendError(res, 413, 'payload_too_large', 'request body is too large')
        if (error instanceof InvalidMessageError) return sendError(res, 400, 'invalid_request', error.message)
        if (error instanceof NotConnectedError) return sendError(res, 409, 'not_connected', 'bot is not connected')
        throw error
      }
      return
    }
    sendError(res, 404, 'not_found', 'not found')
  }

  private async handleTaskStart (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, state, tasks } = this.deps
    const requestId = this.requestId(req)
    if (!isJsonRequest(req)) return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
    if (!config.taskEnabled) return sendError(res, 503, 'task_disabled', 'tasks are disabled')
    try {
      const body = await readJsonBody(req)
      const taskNames = new Set(['fishing', 'farming', 'woodcutting', 'mining', 'forest', 'sleep', 'patrol'])
      if (!isObject(body) || typeof body.name !== 'string' || !taskNames.has(body.name)) {
        throw new InvalidMessageError('name must be fishing, farming, woodcutting, mining, forest, sleep or patrol')
      }
      if (state.task.pendingResume) {
        this.auditDenied('task.start', 'resume_pending', requestId, body.name)
        return sendError(res, 409, 'resume_pending', 'a pending task must be resumed or discarded first')
      }
      const result = await tasks.start(body.name as TaskName, 'panel')
      if (result.status === 'rejected') {
        this.auditDenied('task.start', result.reason ?? 'rejected', requestId, body.name)
        if (result.reason === 'queue_full') return sendError(res, 409, 'queue_full', 'task queue is full')
        if (result.reason === 'resume_pending') return sendError(res, 409, 'resume_pending', 'a pending task must be resumed first')
        if (result.reason === 'task_disabled') return sendError(res, 503, 'task_disabled', 'tasks are disabled')
        return sendError(res, 409, 'task_rejected', 'task was rejected')
      }
      this.deps.audit.append({
        event: result.status === 'queued' ? 'task.queued' : 'task.start',
        source: 'http_control',
        actor: 'panel',
        action: body.name,
        result: 'accepted',
        requestId,
        details: result.status === 'queued' ? { position: result.position } : {}
      })
      sendJson(res, {
        status: 202,
        body: {
          ok: true,
          queued: result.status === 'queued',
          position: result.position ?? null,
          requestId,
          task: this.deps.state.task
        }
      })
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendError(res, 413, 'payload_too_large', 'request body is too large')
      if (error instanceof InvalidMessageError) return sendError(res, 400, 'invalid_request', error.message)
      throw error
    }
  }

  private async handleTaskStop (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { state, tasks } = this.deps
    const requestId = this.requestId(req)
    if (state.task.active || state.task.queue.length > 0) {
      tasks.requestStop('http')
      this.deps.audit.append({
        event: 'task.stop',
        source: 'http_control',
        actor: 'panel',
        action: state.task.name ?? 'queue',
        result: 'accepted',
        requestId,
        details: { clearedQueue: state.task.queue.length }
      })
      sendJson(res, { status: 202, body: { ok: true, requestId, task: this.deps.state.task } })
      return
    }
    if (state.task.pendingResume) {
      const name = state.task.pendingResume.name
      await tasks.discardPending('http')
      this.deps.audit.append({
        event: 'task.discard_pending',
        source: 'http_control',
        actor: 'panel',
        action: name,
        result: 'accepted',
        requestId
      })
      sendJson(res, { status: 202, body: { ok: true, requestId, task: this.deps.state.task } })
      return
    }
    this.auditDenied('task.stop', 'no_active_task', requestId, 'task')
    sendError(res, 409, 'no_active_task', 'no active task')
  }

  private async handleTaskResume (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { state, tasks } = this.deps
    const requestId = this.requestId(req)
    if (!state.task.pendingResume) {
      this.auditDenied('task.resume', 'no_pending_task', requestId, 'task')
      return sendError(res, 409, 'no_pending_task', 'no pending task')
    }
    try {
      let taskId: string | undefined
      if (isJsonRequest(req)) {
        const body = await readJsonBody(req)
        if (isObject(body) && body.taskId !== undefined) {
          if (typeof body.taskId !== 'string') throw new InvalidMessageError('taskId must be a string')
          taskId = body.taskId
        }
      }
      await tasks.confirmResume(taskId)
      this.deps.audit.append({
        event: 'task.resume',
        source: 'http_control',
        actor: 'panel',
        action: state.task.name ?? 'task',
        result: 'accepted',
        requestId,
        details: { taskId: taskId ?? null }
      })
      sendJson(res, { status: 202, body: { ok: true, requestId, task: this.deps.state.task } })
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendError(res, 413, 'payload_too_large', 'request body is too large')
      if (error instanceof InvalidMessageError) return sendError(res, 400, 'invalid_request', error.message)
      if (error instanceof TaskError) {
        this.auditDenied('task.resume', error.message, requestId, 'task')
        return sendError(res, 409, 'resume_failed', error.message)
      }
      throw error
    }
  }

  private async handleMove (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { state, tasks, movement, config } = this.deps
    const requestId = this.requestId(req)
    if (!isJsonRequest(req)) return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
    if (state.task.active) {
      this.auditDenied('move', 'task_active', requestId, 'move')
      return sendError(res, 409, 'task_active', 'stop the task before moving')
    }
    if (!this.deps.chatSender.isConnected()) return sendError(res, 409, 'not_connected', 'bot is not connected')
    try {
      const body = await readJsonBody(req)
      if (!isObject(body) || (body.action !== 'home' && body.action !== 'come' && body.action !== 'follow' && body.action !== 'stop')) {
        throw new InvalidMessageError('action must be home, come, follow or stop')
      }
      const action = body.action as MoveAction
      let target: string | undefined
      if (action === 'come' || action === 'follow') {
        target = typeof body.target === 'string' ? body.target : config.commandAllowlist[0]
        if (!target || !/^[A-Za-z0-9_]{1,16}$/.test(target)) throw new InvalidMessageError('target must be a valid player name')
        if (!this.deps.getBot()?.players[target]) return sendError(res, 409, 'target_not_online', `${target} is not online`)
      }
      this.deps.audit.append({
        event: 'movement.start',
        source: 'http_control',
        actor: 'panel',
        action,
        result: 'accepted',
        requestId,
        details: { target: target ?? null }
      })
      this.deps.events.emit('movement', { action, target: target ?? null, status: 'started', requestId })
      sendJson(res, { status: 202, body: { ok: true, requestId, action, target: target ?? null } })
      void this.runMove(action, target, requestId)
      return
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendError(res, 413, 'payload_too_large', 'request body is too large')
      if (error instanceof InvalidMessageError) return sendError(res, 400, 'invalid_request', error.message)
      throw error
    }
  }

  private async runMove (action: MoveAction, target: string | undefined, requestId: string): Promise<void> {
    const { movement, events, audit } = this.deps
    try {
      let status: 'completed' | 'started' = 'completed'
      if (action === 'home') await movement.home()
      else if (action === 'come' && target) await movement.comeTo(target)
      else if (action === 'follow' && target) {
        movement.follow(target)
        status = 'started'
      } else if (action === 'stop') movement.stop('http')
      events.emit('movement', { action, target: target ?? null, status, requestId })
      audit.append({
        event: 'movement.finish',
        source: 'http_control',
        actor: 'panel',
        action,
        result: status === 'completed' ? 'completed' : 'accepted',
        requestId,
        details: { target: target ?? null }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      events.emit('movement', { action, target: target ?? null, status: 'failed', error: message, requestId })
      audit.append({
        event: 'movement.finish',
        source: 'http_control',
        actor: 'panel',
        action,
        result: 'failed',
        requestId,
        details: { target: target ?? null, error: message }
      })
    }
  }

  private authorizeRead (req: IncomingMessage, res: ServerResponse): boolean {
    if (!isAuthorized(req, this.deps.config.httpToken)) {
      sendError(res, 401, 'unauthorized', 'invalid or missing bearer token')
      return false
    }
    return true
  }

  private authorizeControl (req: IncomingMessage, res: ServerResponse): boolean {
    const { config } = this.deps
    if (!config.httpControlEnabled || config.httpControlToken === '') {
      sendError(res, 503, 'control_disabled', 'HTTP control is disabled')
      return false
    }
    if (!isAuthorized(req, config.httpControlToken)) {
      this.deps.audit.append({
        event: 'http.auth',
        source: 'http_control',
        actor: 'unknown',
        action: req.url ?? '/',
        result: 'denied'
      })
      sendError(res, 401, 'unauthorized', 'invalid or missing control token')
      return false
    }
    return true
  }

  private requestId (req: IncomingMessage): string {
    const raw = req.headers['x-request-id']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value)) return value
    return randomUUID()
  }

  private auditDenied (action: string, reason: string, requestId: string, detail: unknown): void {
    this.deps.audit.append({
      event: 'http.control',
      source: 'http_control',
      actor: 'panel',
      action,
      result: 'denied',
      requestId,
      details: { reason, detail: typeof detail === 'string' ? detail : null }
    })
  }

  private rateLimited (res: ServerResponse, scope: string): void {
    sendError(res, 429, 'rate_limited', `too many ${scope} requests`)
  }

  private takeSaySlot (): boolean {
    const now = Date.now()
    while (this.sayTimestamps.length > 0 && now - (this.sayTimestamps[0] ?? 0) > SAY_WINDOW_MS) {
      this.sayTimestamps.shift()
    }
    if (this.sayTimestamps.length >= SAY_LIMIT) return false
    this.sayTimestamps.push(now)
    return true
  }

  private takeControlSlot (): boolean {
    const limit = this.deps.config.controlRateLimit
    const now = Date.now()
    while (this.controlTimestamps.length > 0 && now - (this.controlTimestamps[0] ?? 0) > CONTROL_WINDOW_MS) {
      this.controlTimestamps.shift()
    }
    if (this.controlTimestamps.length >= limit) return false
    this.controlTimestamps.push(now)
    return true
  }

  private methodNotAllowed (res: ServerResponse, allowed: string): void {
    sendJson(res, {
      status: 405,
      body: { error: 'method_not_allowed', message: `use ${allowed}` },
      headers: { Allow: allowed }
    })
  }

  async stop (): Promise<void> {
    this.sse.stop()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
      setTimeout(resolve, 2000).unref?.()
    })
  }
}
