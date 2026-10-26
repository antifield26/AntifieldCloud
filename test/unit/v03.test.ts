import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Bot } from 'mineflayer'
import { AuditLogger } from '../../src/audit.ts'
import { EventBus } from '../../src/events/bus.ts'
import { HttpApi } from '../../src/http/server.ts'
import { createLogger } from '../../src/logger.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import { TaskManager } from '../../src/tasks/manager.ts'
import { TaskStore, type PersistedTask } from '../../src/tasks/store.ts'
import type { TaskController } from '../../src/tasks/types.ts'
import { makeConfig, makeState } from '../helpers.ts'

const logger = createLogger('error')
const readToken = '0123456789abcdef0123456789abcdef'
const controlToken = 'abcdef0123456789abcdef0123456789'

test('event bus replays and resyncs on unknown event IDs', () => {
  const bus = new EventBus(10)
  const first = bus.emit('presence', { state: 'idle' })
  const second = bus.emit('chat', { message: 'hi' })
  assert.equal(bus.lastEventId, second.id)
  assert.deepEqual(bus.replayAfter(first.id).events.map(event => event.id), [second.id])
  assert.equal(bus.replayAfter(null).events.length, 0)
  assert.equal(bus.replayAfter('other-boot-1').resync, true)
  assert.equal(bus.replayAfter('deadbeef-99').resync, true)
})

test('audit logger writes and rotates JSONL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-audit-'))
  const file = path.join(dir, 'audit.jsonl')
  const audit = new AuditLogger({ file, maxBytes: 240, retentionDays: 30, logger })
  try {
    await audit.init()
    for (let index = 0; index < 20; index++) {
      audit.append({
        event: 'test',
        source: 'http_control',
        actor: 'panel',
        action: 'noop',
        result: 'accepted',
        requestId: `r${index}`
      })
    }
    await audit.close()
    const text = await readFile(file, 'utf8')
    assert.match(text, /"event":"test"/)
    assert.match(text, /"requestId":"r19"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('task store roundtrips and quarantines corrupt files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-taskstore-'))
  const file = path.join(dir, 'task-state.json')
  const store = new TaskStore(file, logger)
  const saved: PersistedTask = {
    version: 1,
    taskId: 'task-1',
    name: 'fishing',
    startedAt: 1000,
    deadline: 2000,
    progress: { fishCaught: 3, wheatHarvested: 0, planted: 0, deposited: 1 },
    failures: 0,
    savedAt: 1500
  }
  try {
    await store.save(saved)
    assert.deepEqual(await store.load(), saved)
    await store.clear()
    assert.equal(await store.load(), null)
    await writeFile(file, '{broken', 'utf8')
    assert.equal(await store.load(), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('task manager exposes a pending resume and can discard it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-pending-'))
  const config = makeConfig({ taskPendingTtlMs: 60000 })
  const state = makeState(config)
  const events = new EventBus(50)
  const audit = { append: () => {} } as unknown as AuditLogger
  const store = new TaskStore(path.join(dir, 'task-state.json'), logger)
  const manager = new TaskManager({
    config,
    logger,
    state,
    chatSender: { say: async () => [] } as unknown as ChatSender,
    movement: {} as MovementManager,
    events,
    audit,
    store,
    getBot: () => null as Bot | null
  })
  try {
    await store.save({
      version: 1,
      taskId: 'pending-1',
      name: 'farming',
      startedAt: Date.now() - 5000,
      deadline: Date.now() + 600000,
      progress: { fishCaught: 0, wheatHarvested: 2, planted: 3, deposited: 0 },
      failures: 1,
      savedAt: Date.now() - 1000
    })
    await manager.init()
    assert.equal(state.task.state, 'pending_resume')
    assert.equal(state.task.pendingResume?.taskId, 'pending-1')
    assert.equal(state.task.pendingResume?.name, 'farming')
    await manager.discardPending('test')
    assert.equal(state.task.state, 'idle')
    assert.equal(state.task.pendingResume, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
    manager.shutdown().catch(() => {})
  }
})

test('task manager expires an old pending resume', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-expire-'))
  const config = makeConfig({ taskPendingTtlMs: 1000 })
  const state = makeState(config)
  const events = new EventBus(50)
  const audit = { append: () => {} } as unknown as AuditLogger
  const store = new TaskStore(path.join(dir, 'task-state.json'), logger)
  const manager = new TaskManager({
    config,
    logger,
    state,
    chatSender: { say: async () => [] } as unknown as ChatSender,
    movement: {} as MovementManager,
    events,
    audit,
    store,
    getBot: () => null as Bot | null
  })
  try {
    await store.save({
      version: 1,
      taskId: 'expired-1',
      name: 'fishing',
      startedAt: Date.now() - 60_000,
      deadline: Date.now() + 600000,
      progress: { fishCaught: 1, wheatHarvested: 0, planted: 0, deposited: 0 },
      failures: 0,
      savedAt: Date.now() - 60_000
    })
    await manager.init()
    assert.equal(state.task.state, 'idle')
    assert.equal(state.task.pendingResume, null)
    assert.match(state.task.lastError ?? '', /过期/)
    assert.equal(await store.load(), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await manager.shutdown()
  }
})

test('HTTP control uses a separate token and emits SSE hello', async () => {
  const config = makeConfig(
    { httpPort: 0, httpHost: '127.0.0.1', httpControlToken: controlToken, httpControlEnabled: true },
    { HTTP_CONTROL_TOKEN: controlToken }
  )
  const state = makeState(config)
  const events = new EventBus(50)
  const audit = { append: () => {} } as unknown as AuditLogger
  const chatSender = {
    isConnected: () => true,
    say: async (text: string) => [text]
  } as unknown as ChatSender
  const fakeTasks = {
    start: async (name: 'fishing' | 'farming') => {
      state.setTask({
        enabled: true,
        active: true,
        name,
        state: 'running',
        startedAt: new Date().toISOString(),
        elapsedSec: 0,
        progress: { fishCaught: 0, wheatHarvested: 0, planted: 0, deposited: 0 },
        failures: 0,
        lastError: null,
        pendingResume: null
      })
    },
    requestStop: () => {},
    stopAndWait: async () => {},
    depositNow: async () => {},
    confirmResume: async () => {},
    discardPending: async () => {},
    snapshot: () => state.task,
    keepOnline: () => state.task.active,
    isActive: () => state.task.active
  } as unknown as TaskController
  const api = new HttpApi({
    config,
    logger,
    state,
    chatSender,
    movement: {} as MovementManager,
    tasks: fakeTasks,
    events,
    audit,
    getBot: () => null
  })
  const port = await api.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const noAuth = await fetch(`${base}/task/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fishing' })
    })
    assert.equal(noAuth.status, 401)
    const readAuth = await fetch(`${base}/task/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fishing' })
    })
    assert.equal(readAuth.status, 401)
    const ok = await fetch(`${base}/task/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fishing' })
    })
    assert.equal(ok.status, 202)
    const task = await fetch(`${base}/task`, { headers: { Authorization: `Bearer ${readToken}` } })
    assert.equal(task.status, 200)
    assert.equal(((await task.json()) as { task: { name: string } }).task.name, 'fishing')
    const move = await fetch(`${base}/move`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'home' })
    })
    assert.equal(move.status, 409)

    const controller = new AbortController()
    const sse = await fetch(`${base}/events`, {
      headers: { Authorization: `Bearer ${readToken}` },
      signal: controller.signal
    })
    assert.equal(sse.status, 200)
    const reader = sse.body?.getReader()
    const first = await reader?.read()
    controller.abort()
    const text = new TextDecoder().decode(first?.value)
    assert.match(text, /retry: 5000/)
    assert.match(text, /event: hello/)
  } finally {
    await api.stop()
  }
})
