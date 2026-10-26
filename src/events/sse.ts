import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../logger.ts'
import type { StatusSnapshot } from '../state.ts'
import type { BotEvent, EventBus } from './bus.ts'

export interface SseDeps {
  events: EventBus
  logger: Logger
  maxClients: number
  heartbeatMs: number
  getSnapshot: () => StatusSnapshot
}

interface Client {
  res: ServerResponse
  unsubscribe: () => void
  heartbeat: NodeJS.Timeout
}

const MAX_BUFFERED_BYTES = 1024 * 1024

export class SseHub {
  private readonly deps: SseDeps
  private readonly clients = new Set<Client>()

  constructor (deps: SseDeps) {
    this.deps = deps
  }

  get clientCount (): number {
    return this.clients.size
  }

  handle (req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= this.deps.maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'sse_capacity', message: 'too many SSE clients' }))
      return
    }
    const lastEventId = this.lastEventId(req)
    const replay = this.deps.events.replayAfter(lastEventId)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders?.()
    res.write('retry: 5000\n\n')

    let ready = false
    const queued: BotEvent[] = []
    const unsubscribe = this.deps.events.subscribe(event => {
      if (!ready) {
        queued.push(event)
        return
      }
      this.sendEvent(res, event)
    })

    const hello = {
      version: this.deps.getSnapshot().version,
      bootId: this.deps.events.bootId,
      lastEventId: this.deps.events.lastEventId,
      resync: replay.resync,
      snapshot: this.deps.getSnapshot()
    }
    this.sendRaw(res, 'hello', JSON.stringify(hello), null)
    for (const event of replay.events) this.sendEvent(res, event)

    ready = true
    for (const event of queued) this.sendEvent(res, event)

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return
      res.write(': ping\n\n')
    }, this.deps.heartbeatMs)
    heartbeat.unref?.()

    const client: Client = { res, unsubscribe, heartbeat }
    this.clients.add(client)
    const cleanup = (): void => {
      if (!this.clients.delete(client)) return
      clearInterval(heartbeat)
      unsubscribe()
      this.deps.logger.debug('sse client disconnected', { clients: this.clients.size })
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
    this.deps.logger.info('sse client connected', { clients: this.clients.size, replay: replay.events.length, resync: replay.resync })
  }

  private lastEventId (req: IncomingMessage): string | null {
    const raw = req.headers['last-event-id']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string' || value.trim() === '') return null
    return value.trim()
  }

  private sendEvent (res: ServerResponse, event: BotEvent): void {
    if (res.writableEnded) return
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      this.deps.logger.warn('sse client too slow; closing')
      res.destroy()
      return
    }
    this.sendRaw(res, event.type, JSON.stringify({
      id: event.id,
      type: event.type,
      ts: event.ts,
      data: event.data
    }), event.id)
  }

  private sendRaw (res: ServerResponse, event: string, data: string, id: string | null): void {
    if (res.writableEnded) return
    let frame = ''
    if (id) frame += `id: ${id}\n`
    frame += `event: ${event}\n`
    frame += `data: ${data}\n\n`
    res.write(frame)
  }

  stop (): void {
    for (const client of this.clients) {
      clearInterval(client.heartbeat)
      client.unsubscribe()
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
    this.clients.clear()
  }
}
