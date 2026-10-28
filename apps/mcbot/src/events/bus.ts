import { randomBytes } from 'node:crypto'

export type BotEventType = 'hello' | 'presence' | 'task' | 'chat' | 'movement' | 'alert' | 'autonomy'

export interface BotEvent {
  id: string
  type: BotEventType
  ts: string
  data: unknown
}

export interface ReplayResult {
  events: BotEvent[]
  resync: boolean
}

export interface RecentEvents {
  bootId: string
  lastEventId: string | null
  events: BotEvent[]
}

type Subscriber = (event: BotEvent) => void

export class EventBus {
  readonly bootId = randomBytes(4).toString('hex')
  private readonly maxEvents: number
  private readonly ring: BotEvent[] = []
  private readonly subscribers = new Set<Subscriber>()
  private seq = 0

  constructor (maxEvents: number) {
    this.maxEvents = Math.max(10, maxEvents)
  }

  get lastEventId (): string | null {
    const last = this.ring[this.ring.length - 1]
    return last ? last.id : null
  }

  get size (): number {
    return this.ring.length
  }

  emit (type: Exclude<BotEventType, 'hello'>, data: unknown): BotEvent {
    this.seq += 1
    const event: BotEvent = {
      id: `${this.bootId}-${this.seq}`,
      type,
      ts: new Date().toISOString(),
      data
    }
    this.ring.push(event)
    while (this.ring.length > this.maxEvents) this.ring.shift()
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event)
      } catch {
        // A broken subscriber must not break the producer.
      }
    }
    return event
  }

  subscribe (subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  replayAfter (lastEventId: string | null): ReplayResult {
    if (!lastEventId) return { events: [], resync: false }
    const prefix = `${this.bootId}-`
    if (!lastEventId.startsWith(prefix)) return { events: [], resync: true }
    const index = this.ring.findIndex(event => event.id === lastEventId)
    if (index < 0) return { events: [], resync: true }
    return { events: this.ring.slice(index + 1), resync: false }
  }

  /**
   * 返回 ring 内最近 `limit` 条事件，按发生顺序（旧 → 新）排列。
   * 只读快照：不修改 ring，limit 超过 ring 长度时返回全部已有事件。
   */
  recent (limit: number): RecentEvents {
    const count = Number.isInteger(limit) && limit > 0 ? limit : 0
    const events = count === 0 ? [] : this.ring.slice(-count)
    return {
      bootId: this.bootId,
      lastEventId: this.lastEventId,
      events
    }
  }
}
