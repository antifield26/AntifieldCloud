import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { AuditLogger } from '../../src/audit.ts'
import { Defender } from '../../src/combat/defender.ts'
import { EventBus } from '../../src/events/bus.ts'
import { createLogger } from '../../src/logger.ts'
import { MemoryStore } from '../../src/memory/store.ts'
import { buildPrompt, buildSummaryPrompt } from '../../src/ai/prompt.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import { TaskManager } from '../../src/tasks/manager.ts'
import { TaskStore } from '../../src/tasks/store.ts'
import { scanOakTrees } from '../../src/tasks/woodcutting.ts'
import type { TaskController } from '../../src/tasks/types.ts'
import { makeConfig, makeState } from '../helpers.ts'

const logger = createLogger('error')

test('woodcutting scan finds oak trunks only inside the farm', () => {
  const config = makeConfig({
    treeFarm: {
      minX: 0, maxX: 4, minZ: 0, maxZ: 4,
      groundY: 63, logMinY: 64, maxY: 80,
      logType: 'oak_log', saplingType: 'oak_sapling'
    }
  })
  const blocks = new Map<string, { name: string }>()
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  for (let y = 64; y <= 66; y++) blocks.set(key(2, y, 2), { name: 'oak_log' })
  blocks.set(key(2, 67, 2), { name: 'oak_leaves' })
  for (let y = 64; y <= 65; y++) blocks.set(key(4, y, 4), { name: 'oak_log' })
  // A log outside the farm must not be scanned.
  for (let y = 64; y <= 66; y++) blocks.set(key(9, y, 9), { name: 'oak_log' })
  const bot = {
    blockAt: (position: Vec3) => blocks.get(key(position.x, position.y, position.z)) ?? { name: 'air' }
  } as unknown as Bot
  const trees = scanOakTrees(bot, config)
  assert.equal(trees.length, 2)
  assert.deepEqual(trees.map(tree => tree.logs.length).sort(), [2, 3])
  assert.deepEqual(trees.map(tree => tree.base.y).sort(), [64, 64])
})

test('defender filters targets and respects safe zone/forbidden mobs', () => {
  const config = makeConfig({
    safeZone: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    defenseRadius: 12,
    defenseTargets: ['zombie', 'skeleton', 'spider']
  })
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    food: 20,
    entities: {
      1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0) },
      2: { id: 2, type: 'hostile', name: 'creeper', position: new Vec3(3, 64, 0) },
      3: { id: 3, type: 'hostile', name: 'zombie', position: new Vec3(30, 64, 0) },
      4: { id: 4, type: 'player', name: 'Antifield', position: new Vec3(1, 64, 0) }
    },
    inventory: { items: () => [] }
  } as unknown as Bot
  const defender = new Defender({
    config,
    logger,
    movement: {} as MovementManager,
    audit: { append: () => {} } as unknown as AuditLogger,
    getBot: () => bot
  })
  assert.equal(defender.hasThreat(), true)
  bot.entities = {
    2: { id: 2, type: 'hostile', name: 'creeper', position: new Vec3(3, 64, 0) }
  } as never
  assert.equal(defender.hasThreat(), false)
  bot.health = 10
  bot.entities = {
    1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0) }
  } as never
  assert.equal(defender.hasThreat(), true)
})

test('memory summary is stored, injected into prompts and migrated from v1', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-summary-'))
  const store = new MemoryStore({ dir, maxTurns: 20, retentionDays: 30, logger })
  try {
    await store.init()
    for (let index = 0; index < 20; index++) {
      await store.append('Antifield', 'uuid-1', `message-${index}`, `reply-${index}`)
    }
    assert.equal(store.summaryDue('Antifield', 'uuid-1', 40), true)
    assert.equal(store.summaryTurns('Antifield', 'uuid-1'), 40)
    const prompt = buildSummaryPrompt('Antifield', null, store.load('Antifield', 'uuid-1'), 1000)
    assert.match(prompt, /不要写坐标/)
    await store.applySummary('Antifield', 'uuid-1', '玩家喜欢安静地聊天。', 20)
    assert.equal(store.summary('Antifield', 'uuid-1')?.text, '玩家喜欢安静地聊天。')
    assert.equal(store.summaryDue('Antifield', 'uuid-1', 40), false)
    const normal = buildPrompt({
      player: 'Antifield',
      message: '你好',
      context: '游戏状态：测试',
      turns: store.load('Antifield', 'uuid-1'),
      summary: store.summary('Antifield', 'uuid-1')?.text ?? null,
      maxChars: 6000
    })
    assert.match(normal, /长期记忆摘要/)
    assert.match(normal, /玩家喜欢安静地聊天/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'lofii-summary-v1-'))
  try {
    await writeFile(path.join(legacyDir, 'uuid-2.json'), JSON.stringify({
      version: 1,
      player: 'Antifield',
      uuid: 'uuid-2',
      updatedAt: new Date().toISOString(),
      turns: [{ role: 'user', text: '旧消息', at: new Date().toISOString() }]
    }), 'utf8')
    const legacy = new MemoryStore({ dir: legacyDir, maxTurns: 20, retentionDays: 30, logger })
    await legacy.init()
    assert.equal(legacy.load('Antifield', 'uuid-2').length, 1)
    assert.equal(legacy.summary('Antifield', 'uuid-2'), null)
    await legacy.stop()
  } finally {
    await rm(legacyDir, { recursive: true, force: true })
  }
})

test('task manager queues up to the configured limit and stop clears the queue', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-queue-'))
  const config = makeConfig({ queueMax: 3 })
  const state = makeState(config)
  const store = new TaskStore(path.join(dir, 'task-state.json'), logger)
  const manager = new TaskManager({
    config,
    logger,
    state,
    chatSender: { say: async () => [] } as unknown as ChatSender,
    movement: { stop: () => {} } as unknown as MovementManager,
    events: new EventBus(50),
    audit: { append: () => {} } as unknown as AuditLogger,
    store,
    getBot: () => null as Bot | null
  })
  const resolvers: Array<() => void> = []
  ;(manager as unknown as { run: (active: unknown) => Promise<void> }).run = async (active) => {
    await new Promise<void>(resolve => resolvers.push(resolve))
    await (manager as unknown as { finish: (active: unknown, attempts: number) => Promise<void> }).finish(active, 0)
  }
  try {
    assert.deepEqual(await manager.start('fishing', 'panel'), { status: 'started' })
    assert.deepEqual(await manager.start('farming', 'panel'), { status: 'queued', position: 1 })
    assert.deepEqual(await manager.start('woodcutting', 'panel'), { status: 'queued', position: 2 })
    assert.deepEqual(await manager.start('fishing', 'panel'), { status: 'queued', position: 3 })
    assert.equal((await manager.start('farming', 'panel')).status, 'rejected')
    assert.equal(state.task.queue.length, 3)
    const saved = await store.load()
    assert.equal(saved?.queue.length, 3)
    manager.requestStop('test')
    assert.equal(state.task.queue.length, 0)
    resolvers.shift()?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(state.task.active, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await manager.shutdown().catch(() => {})
  }
})

test('HTTP control queues a task when another is active', async () => {
  const config = makeConfig({ httpPort: 0, httpHost: '127.0.0.1', httpControlToken: 'abcdef0123456789abcdef0123456789' },
    { HTTP_CONTROL_TOKEN: 'abcdef0123456789abcdef0123456789' })
  const state = makeState(config)
  const events = new EventBus(50)
  const fakeTasks = {
    start: async (name: 'fishing' | 'farming' | 'woodcutting') => {
      const queue = [...state.task.queue, {
        taskId: `queued-${state.task.queue.length}`,
        name,
        requestedBy: 'panel',
        requestedAt: new Date().toISOString()
      }]
      state.setTask({
        enabled: true,
        active: true,
        name: 'fishing',
        state: 'running',
        startedAt: new Date().toISOString(),
        elapsedSec: 0,
        progress: state.task.progress,
        failures: 0,
        lastError: null,
        pendingResume: null,
        queue
      })
      return { status: 'queued' as const, position: queue.length }
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
  const { HttpApi } = await import('../../src/http/server.ts')
  const api = new HttpApi({
    config,
    logger,
    state,
    chatSender: { isConnected: () => true, say: async (text: string) => [text] } as unknown as ChatSender,
    movement: {} as MovementManager,
    tasks: fakeTasks,
    events,
    audit: { append: () => {} } as unknown as AuditLogger,
    getBot: () => null
  })
  const port = await api.start()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/task/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.httpControlToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'woodcutting' })
    })
    assert.equal(response.status, 202)
    const body = await response.json() as { queued: boolean, position: number }
    assert.equal(body.queued, true)
    assert.equal(body.position, 1)
  } finally {
    await api.stop()
  }
})
