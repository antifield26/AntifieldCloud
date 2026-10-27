import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { createLogger } from '../../src/logger.ts'
import { AuditLogger } from '../../src/audit.ts'
import { HttpApi } from '../../src/http/server.ts'
import type { TaskController } from '../../src/tasks/types.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import { AdminService, parseList, parseTime, parseTps, parseWhitelist } from '../../src/admin/service.ts'
import { isReadOnlyCommand, RconClient, RconError } from '../../src/admin/rcon.ts'
import { EventBus } from '../../src/events/bus.ts'
import { AlertManager } from '../../src/alerts/manager.ts'
import { HistoryStore } from '../../src/history/store.ts'
import { findBedNear } from '../../src/tasks/sleep.ts'
import { patrolCorners } from '../../src/tasks/patrol.ts'
import { scanNaturalTrees } from '../../src/tasks/forest.ts'
import { scanExposedOres } from '../../src/tasks/resources.ts'
import { makeConfig, makeState } from '../helpers.ts'

const logger = createLogger('error')

function fakeBlockBot (blocks: Map<string, string>, position = new Vec3(5, 65, 5)): Bot {
  return {
    username: 'lofii',
    entity: { position },
    players: {},
    blockAt: (point: Vec3) => {
      const name = blocks.get(`${point.x},${point.y},${point.z}`) ?? 'air'
      return { name }
    }
  } as unknown as Bot
}

test('v0.5 expanded safe zone and 60-minute task limit', () => {
  const config = makeConfig()
  assert.deepEqual(config.safeZone, { minX: 111, maxX: 239, minZ: 410, maxZ: 474 })
  assert.equal(config.taskMaxMinutes, 60)
  assert.equal(config.mining.ores.includes('iron_ore'), true)
  assert.deepEqual(config.forest.species, ['oak', 'spruce', 'birch'])
})

test('v0.5 admin tps/list/whitelist parsing', () => {
  assert.deepEqual(parseTps('§6TPS from last 1m, 5m, 15m: §a19.9§r, §a20.0§r, §a20.0'), {
    one: 19.9, five: 20, fifteen: 20
  })
  assert.deepEqual(parseList('There are 2 of a max of 6 players online: Antifield, lofii'), {
    count: 2, max: 6, players: ['Antifield', 'lofii']
  })
  assert.deepEqual(parseWhitelist('There are 2 whitelisted player(s): Antifield, lofii'), {
    count: 2, names: ['Antifield', 'lofii']
  })
  assert.deepEqual(parseTime('21:02 (15035 ticks)'), { ticks: 15035, label: '21:02' })
  assert.deepEqual(parseList('§6当前有§c2§6位玩家在线，可容纳最大在线人数为§c6§6位玩家'), {
    count: 2, max: 6, players: []
  })
})

test('v0.5 RCON only accepts the three read-only commands', async () => {
  assert.equal(isReadOnlyCommand('tps'), true)
  assert.equal(isReadOnlyCommand('list'), true)
  assert.equal(isReadOnlyCommand('whitelist list'), true)
  assert.equal(isReadOnlyCommand('time'), true)
  assert.equal(isReadOnlyCommand('op Antifield'), false)
  const client = new RconClient({ host: '127.0.0.1', port: 25575, password: 'secret', timeoutMs: 200 })
  await assert.rejects(() => client.command('stop'), RconError)
})

test('v0.5 admin service fills the state snapshot from a read-only source', async () => {
  const config = makeConfig({}, { RCON_ENABLED: 'true', RCON_PASSWORD: 'test-password' })
  const state = makeState(config)
  const service = new AdminService({
    config,
    logger,
    state,
    client: {
      command: async command => {
        if (command === 'tps') return 'TPS from last 1m, 5m, 15m: 20.0, 19.8, 19.5'
        if (command === 'list') return 'There are 1 of a max of 6 players online: lofii'
        if (command === 'time') return 'world time is 02:14 (20247 ticks)'
        return 'There are 2 whitelisted player(s): Antifield, lofii'
      }
    }
  })
  await service.refresh()
  assert.equal(state.admin.rcon, true)
  assert.deepEqual(state.admin.tps, { one: 20, five: 19.8, fifteen: 19.5 })
  assert.equal(state.admin.online.count, 1)
  assert.equal(state.admin.whitelist.count, 2)
  assert.equal(state.admin.backup.status, 'unknown')
  service.stop()
})

test('v0.5 mining only finds exposed, allowed ore outside protection', () => {
  const config = makeConfig({
    safeZone: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    mining: {
      ...makeConfig().mining,
      minY: 60,
      maxY: 61,
      protectRadius: 0
    }
  })
  const blocks = new Map<string, string>()
  blocks.set('2,60,2', 'coal_ore')
  blocks.set('2,61,2', 'air')
  blocks.set('4,60,2', 'iron_ore') // buried: no air neighbor
  blocks.set('4,61,2', 'stone')
  blocks.set('3,60,2', 'stone')
  blocks.set('5,60,2', 'stone')
  blocks.set('4,60,1', 'stone')
  blocks.set('4,60,3', 'stone')
  blocks.set('4,59,2', 'stone')
  blocks.set('6,60,2', 'diamond_ore')
  const targets = scanExposedOres(fakeBlockBot(blocks), config)
  assert.equal(targets.length, 1)
  assert.equal(targets[0]?.name, 'coal_ore')
  assert.equal(targets[0]?.kind, 'coal')
})

test('v0.5 natural forest finds only species with leaves and soil', () => {
  const config = makeConfig({
    safeZone: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    forest: { ...makeConfig().forest, protectRadius: 0 }
  })
  const blocks = new Map<string, string>()
  blocks.set('2,59,2', 'dirt')
  blocks.set('2,60,2', 'oak_log')
  blocks.set('2,61,2', 'oak_log')
  blocks.set('3,61,2', 'oak_leaves')
  blocks.set('6,59,2', 'dirt')
  blocks.set('6,60,2', 'birch_log')
  // no birch leaves -> not natural
  const trees = scanNaturalTrees(fakeBlockBot(blocks), config)
  assert.equal(trees.length, 1)
  assert.equal(trees[0]?.species, 'oak')
  assert.equal(trees[0]?.base.y, 60)
})

test('v0.5 sleep finds a nearby bed and patrol uses the four safe-zone corners', () => {
  const config = makeConfig({
    safeZone: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 },
    home: { x: 5, y: 64, z: 5 }
  })
  const blocks = new Map<string, string>()
  blocks.set('6,64,5', 'red_bed')
  const bed = findBedNear(fakeBlockBot(blocks), config)
  assert.equal(bed?.name, 'red_bed')
  assert.deepEqual(patrolCorners(config).map(point => [point.x, point.z]), [
    [4, 4], [16, 4], [16, 16], [4, 16]
  ])
})

test('v0.5 history sqlite stores samples and alerts with retention/query', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-v05-history-'))
  const file = path.join(dir, 'history.db')
  const store = new HistoryStore(file, 30, logger)
  try {
    await store.init()
    store.insertSample({
      ts: new Date().toISOString(),
      connected: true,
      state: 'connected',
      taskName: 'mining',
      taskState: 'running',
      health: 20,
      food: 20,
      memoryMb: 50,
      tps: 20,
      queueLen: 0,
      rssMb: 120
    })
    const samples = store.querySamples({ limit: 10 })
    assert.equal(samples.length, 1)
    assert.equal(samples[0]?.taskName, 'mining')
    const id = store.insertAlert({
      ts: new Date().toISOString(),
      type: 'task_failed',
      severity: 'error',
      message: 'test',
      details: { task: 'mining' }
    })
    assert.equal(typeof id, 'number')
    const alerts = store.queryAlerts({ limit: 10 })
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.type, 'task_failed')
    assert.throws(() => store.querySamples({ from: 'not-a-date' }), /ISO/)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('v0.5 HTTP exposes admin status and history with the read token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-v05-http-'))
  const config = makeConfig({}, {
    HISTORY_DB: path.join(dir, 'history.db'),
    TASK_STATE_FILE: path.join(dir, 'task-state.json'),
    AUDIT_FILE: path.join(dir, 'audit.jsonl')
  })
  const state = makeState(config)
  const events = new EventBus(20)
  const audit = new AuditLogger({ file: config.auditFile, maxBytes: 1_000_000, retentionDays: 30, logger })
  await audit.init()
  const store = new HistoryStore(config.history.file, 30, logger)
  await store.init()
  store.insertSample({
    ts: new Date().toISOString(),
    connected: false,
    state: 'idle',
    taskName: null,
    taskState: 'idle',
    health: null,
    food: null,
    memoryMb: 10,
    tps: null,
    queueLen: 0,
    rssMb: 50
  })
  const tasks = {
    snapshot: () => state.task,
    requestStop: () => {},
    stopAndWait: async () => {},
    depositNow: async () => {},
    confirmResume: async () => {},
    discardPending: async () => {},
    keepOnline: () => false,
    isActive: () => false,
    start: async () => ({ status: 'started' as const })
  } as unknown as TaskController
  const api = new HttpApi({
    config,
    logger,
    state,
    chatSender: { isConnected: () => false } as ChatSender,
    movement: {} as MovementManager,
    tasks,
    events,
    audit,
    history: store,
    getBot: () => null
  })
  const port = await api.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const unauthorized = await fetch(`${base}/admin/status`)
    assert.equal(unauthorized.status, 401)
    const admin = await fetch(`${base}/admin/status`, {
      headers: { Authorization: `Bearer ${config.httpToken}` }
    })
    assert.equal(admin.status, 200)
    const adminBody = await admin.json() as { admin: { enabled: boolean } }
    assert.equal(adminBody.admin.enabled, false)
    const history = await fetch(`${base}/history?kind=samples&limit=10`, {
      headers: { Authorization: `Bearer ${config.httpToken}` }
    })
    assert.equal(history.status, 200)
    const historyBody = await history.json() as { count: number, samples: unknown[] }
    assert.equal(historyBody.count, 1)
    assert.equal(historyBody.samples.length, 1)
    const bad = await fetch(`${base}/history?limit=9999`, {
      headers: { Authorization: `Bearer ${config.httpToken}` }
    })
    assert.equal(bad.status, 400)
  } finally {
    await api.stop()
    store.close()
    await audit.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('v0.5 alerts are persisted, emitted and cooled down', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lofii-v05-alerts-'))
  const config = makeConfig({}, { HISTORY_DB: path.join(dir, 'history.db') })
  const state = makeState(config)
  const events = new EventBus(20)
  const store = new HistoryStore(path.join(dir, 'history.db'), 30, logger)
  try {
    await store.init()
    const alerts = new AlertManager({
      config: { ...config, alerts: { ...config.alerts, cooldownMs: 60_000 } },
      logger,
      state,
      events,
      store,
      getBot: () => null
    })
    const received: string[] = []
    events.subscribe(event => {
      if (event.type === 'alert') received.push((event.data as { type: string }).type)
    })
    alerts.raise('task_failed', 'failed', { task: 'mining' }, 'error')
    alerts.raise('task_failed', 'failed again', {}, 'error')
    assert.deepEqual(received, ['task_failed'])
    assert.equal(store.queryAlerts({ limit: 10 }).length, 1)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
