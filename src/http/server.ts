import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import { InvalidMessageError, NotConnectedError, RateLimitError } from '../errors.ts'
import { isAuthorized } from './auth.ts'

export interface HttpDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
}

interface JsonResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

const BODY_LIMIT = 8192
const SAY_LIMIT = 10
const SAY_WINDOW_MS = 60_000

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

export class HttpApi {
  private readonly deps: HttpDeps
  private server: Server | null = null
  private readonly sayTimestamps: number[] = []

  constructor (deps: HttpDeps) {
    this.deps = deps
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
    if (pathname === '/status') {
      if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET')
      if (!isAuthorized(req, this.deps.config.httpToken)) return sendError(res, 401, 'unauthorized', 'invalid or missing bearer token')
      sendJson(res, { status: 200, body: this.deps.state.snapshot() })
      return
    }
    if (pathname === '/say') {
      if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST')
      if (!isAuthorized(req, this.deps.config.httpToken)) return sendError(res, 401, 'unauthorized', 'invalid or missing bearer token')
      if (!this.takeSaySlot()) return sendError(res, 429, 'rate_limited', 'too many requests')
      if (!this.deps.chatSender.isConnected()) return sendError(res, 409, 'not_connected', 'bot is not connected')
      const contentType = req.headers['content-type'] ?? ''
      if (!contentType.toString().toLowerCase().startsWith('application/json')) {
        return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      }
      try {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') throw new InvalidMessageError('body must be an object')
        const message = (body as Record<string, unknown>).message
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
        if (error instanceof RateLimitError) return sendError(res, 429, 'rate_limited', error.message)
        throw error
      }
      return
    }
    sendError(res, 404, 'not_found', 'not found')
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

  private methodNotAllowed (res: ServerResponse, allowed: string): void {
    sendJson(res, {
      status: 405,
      body: { error: 'method_not_allowed', message: `use ${allowed}` },
      headers: { Allow: allowed }
    })
  }

  async stop (): Promise<void> {
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
