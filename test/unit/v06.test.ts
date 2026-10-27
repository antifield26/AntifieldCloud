import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import type { AuditLogger } from '../../src/audit.ts'
import { CONTRACT_VERSION } from '../../src/contract.ts'
import { EventBus } from '../../src/events/bus.ts'
import { HttpApi } from '../../src/http/server.ts'
import { createLogger } from '../../src/logger.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import type { TaskController } from '../../src/tasks/types.ts'
import { makeConfig, makeState } from '../helpers.ts'

const READ_TOKEN = '0123456789abcdef0123456789abcdef'
const CONTROL_TOKEN = 'fedcba9876543210fedcba9876543210'

interface RecentEventShape {
  id: string
  type: string
  ts: string
  data: unknown
}

interface RecentBodyShape {
  contractVersion: number
  bootId: string
  lastEventId: string | null
  events: RecentEventShape[]
}

async function withApi (events: EventBus, run: (base: string) => Promise<void>): Promise<void> {
  const config = makeConfig({ httpPort: 0, httpHost: '127.0.0.1' }, {
    HTTP_TOKEN: READ_TOKEN,
    HTTP_CONTROL_TOKEN: CONTROL_TOKEN
  })
  const state = makeState(config)
  const api = new HttpApi({
    config,
    logger: createLogger('error'),
    state,
    chatSender: { isConnected: () => false } as unknown as ChatSender,
    movement: {} as MovementManager,
    tasks: { snapshot: () => state.task } as unknown as TaskController,
    events,
    audit: { append: () => {} } as unknown as AuditLogger,
    getBot: () => null as Bot | null
  })
  const port = await api.start()
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await api.stop()
  }
}

test('EventBus recent returns the ring tail in ascending order', () => {
  const bus = new EventBus(20)
  assert.match(bus.bootId, /^[0-9a-f]{8}$/)
  assert.deepEqual(bus.recent(50), { bootId: bus.bootId, lastEventId: null, events: [] })

  for (let seq = 1; seq <= 5; seq += 1) bus.emit('presence', { seq })
  const all = bus.recent(50)
  assert.equal(all.bootId, bus.bootId)
  assert.equal(all.lastEventId, `${bus.bootId}-5`)
  assert.deepEqual(all.events.map(event => event.id), [1, 2, 3, 4, 5].map(seq => `${bus.bootId}-${seq}`))
  assert.deepEqual(all.events.map(event => event.data), [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }])
  assert.ok(all.events.every(event => event.type === 'presence'), 'ring events keep their type')

  const tail = bus.recent(2)
  assert.equal(tail.events.length, 2)
  assert.deepEqual(tail.events.map(event => event.data), [{ seq: 4 }, { seq: 5 }])
  assert.equal(tail.lastEventId, `${bus.bootId}-5`)

  assert.deepEqual(bus.recent(0).events, [])
  assert.deepEqual(bus.recent(-3).events, [])

  // ring 语义不变：超过容量时淘汰最旧事件，recent 只返回现存事件。
  for (let seq = 6; seq <= 25; seq += 1) bus.emit('task', { seq })
  assert.equal(bus.size, 20)
  const ring = bus.recent(200)
  assert.equal(ring.events.length, 20)
  assert.equal(ring.events[0]?.id, `${bus.bootId}-6`)
  assert.equal(ring.events.at(-1)?.id, `${bus.bootId}-25`)
  assert.equal(ring.events.at(-1)?.data && (ring.events.at(-1)?.data as { seq: number }).seq, 25)
  assert.equal(bus.lastEventId, `${bus.bootId}-25`)
})

test('GET /events/recent is read-only, token-scoped and limit-validated', async () => {
  const events = new EventBus(500)
  for (let seq = 1; seq <= 60; seq += 1) events.emit('presence', { seq })
  await withApi(events, async base => {
    const readHeaders = { Authorization: `Bearer ${READ_TOKEN}` }
    const controlHeaders = { Authorization: `Bearer ${CONTROL_TOKEN}` }

    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    assert.equal((await health.json() as { contractVersion?: unknown }).contractVersion, CONTRACT_VERSION)

    assert.equal((await fetch(`${base}/events/recent`)).status, 401)
    const denied = await fetch(`${base}/events/recent`, { headers: controlHeaders })
    assert.equal(denied.status, 401)
    assert.equal((await denied.json() as { error?: string }).error, 'unauthorized')

    const response = await fetch(`${base}/events/recent`, { headers: readHeaders })
    assert.equal(response.status, 200)
    const body = await response.json() as RecentBodyShape
    assert.equal(body.contractVersion, 1)
    assert.equal(body.bootId, events.bootId)
    assert.equal(body.lastEventId, `${events.bootId}-60`)
    assert.equal(body.events.length, 50, 'default limit is 50')
    assert.deepEqual(
      body.events.map(event => event.id),
      Array.from({ length: 50 }, (_, index) => `${events.bootId}-${index + 11}`)
    )
    assert.ok(body.events.every(event => event.type !== 'hello'))
    assert.deepEqual(Object.keys(body.events[0] ?? {}).sort(), ['data', 'id', 'ts', 'type'])
    assert.deepEqual(body.events.at(-1)?.data, { seq: 60 })

    const one = await fetch(`${base}/events/recent?limit=1`, { headers: readHeaders })
    assert.equal(one.status, 200)
    const oneBody = await one.json() as RecentBodyShape
    assert.equal(oneBody.events.length, 1)
    assert.equal(oneBody.events[0]?.id, `${events.bootId}-60`)

    const max = await fetch(`${base}/events/recent?limit=200`, { headers: readHeaders })
    assert.equal(max.status, 200)
    assert.equal((await max.json() as RecentBodyShape).events.length, 60)

    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=', 'limit=-1']) {
      const invalid = await fetch(`${base}/events/recent?${query}`, { headers: readHeaders })
      assert.equal(invalid.status, 400, query)
      const invalidBody = await invalid.json() as { error?: string, message?: unknown }
      assert.equal(invalidBody.error, 'invalid_request', query)
      assert.equal(typeof invalidBody.message, 'string', query)
    }

    const wrongMethod = await fetch(`${base}/events/recent`, { method: 'POST', headers: readHeaders })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET')
  })
})
