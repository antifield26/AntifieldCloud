import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import { loadConfig, ConfigError } from '../../src/config.ts'
import { parseCommand } from '../../src/minecraft/commands.ts'
import { buildStatusLines } from '../../src/minecraft/status.ts'
import { insideFarm, insideSafeZone, isMatureWheat } from '../../src/tasks/navigation.ts'
import { isKeptItem } from '../../src/tasks/inventory.ts'
import { nearbyHostile } from '../../src/tasks/safety.ts'
import type { TaskSnapshot } from '../../src/state.ts'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import { baseEnv, makeConfig } from '../helpers.ts'

test('v0.2 config defaults match the prepared base', () => {
  const config = loadConfig(baseEnv(), '0.2.0')
  assert.equal(config.home.x, 175.5)
  assert.equal(config.home.z, 410.5)
  assert.deepEqual(config.safeZone, { minX: 111, maxX: 239, minZ: 410, maxZ: 474 })
  assert.deepEqual(config.farm, { minX: 177, maxX: 183, minZ: 432, maxZ: 439, groundY: 63, cropY: 64 })
  assert.deepEqual(config.chest, { x: 184, y: 64, z: 435 })
  assert.deepEqual(config.fishStand, { x: 204.5, y: 63, z: 469.5 })
  assert.equal(config.taskMaxMinutes, 60)
  assert.equal(config.taskRecoveryMax, 3)
})

test('v0.2 config rejects a farm outside the safe zone', () => {
  assert.throws(
    () => loadConfig(baseEnv({ FARM_MIN_X: '300' }), '0.2.0'),
    (error: unknown) => error instanceof ConfigError && /FARM_MIN|must be inside/.test(error.message)
  )
})

test('v0.2 task phrases parse before movement commands', () => {
  assert.deepEqual(parseCommand('去钓鱼'), { name: 'fish' })
  assert.deepEqual(parseCommand('种田'), { name: 'farm' })
  assert.deepEqual(parseCommand('收工'), { name: 'stopTask' })
  assert.deepEqual(parseCommand('停止任务'), { name: 'stopTask' })
  assert.deepEqual(parseCommand('回家'), { name: 'home' })
  assert.deepEqual(parseCommand('存东西'), { name: 'deposit' })
  assert.deepEqual(parseCommand('挖矿'), { name: 'mining' })
  assert.deepEqual(parseCommand('砍天然林'), { name: 'forest' })
  assert.deepEqual(parseCommand('睡觉'), { name: 'sleep' })
  assert.deepEqual(parseCommand('巡逻'), { name: 'patrol' })
  assert.deepEqual(parseCommand('停下'), { name: 'stop' })
  assert.equal(parseCommand('你好呀'), null)
})

test('task bounds and mature wheat detection', () => {
  const config = makeConfig()
  assert.equal(insideSafeZone(config, 111, 410), true)
  assert.equal(insideSafeZone(config, 110, 410), false)
  assert.equal(insideFarm(config, 177, 432), true)
  assert.equal(insideFarm(config, 184, 435), false)
  assert.equal(isMatureWheat({ name: 'wheat', getProperties: () => ({ age: 7 }) } as never), true)
  assert.equal(isMatureWheat({ name: 'wheat', getProperties: () => ({ age: 3 }) } as never), false)
  assert.equal(isMatureWheat({ name: 'carrots', getProperties: () => ({ age: 7 }) } as never), false)
})

test('fish are deposited even though they are edible', () => {
  const bot = {
    registry: { foodsByName: { cod: {}, cooked_beef: {} } }
  } as unknown as Bot
  assert.equal(isKeptItem(bot, { name: 'cod' } as Item), false)
  assert.equal(isKeptItem(bot, { name: 'cooked_beef' } as Item), true)
  assert.equal(isKeptItem(bot, { name: 'fishing_rod' } as Item), true)
  assert.equal(isKeptItem(bot, { name: 'wheat' } as Item), false)
})

test('detects nearby hostile mobs', () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      1: { name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) },
      2: { name: 'cow', type: 'mob', position: new Vec3(1, 64, 0) }
    }
  } as unknown as Bot
  assert.equal(nearbyHostile(bot), 'zombie')
  const farBot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 1: { name: 'zombie', type: 'mob', position: new Vec3(30, 64, 0) } }
  } as unknown as Bot
  assert.equal(nearbyHostile(farBot), null)
})

test('status lines include the active task progress', () => {
  const bot = {
    entity: { position: { x: 1, y: 64, z: 2, toFixed: () => '1' } },
    health: 20,
    food: 20,
    time: { timeOfDay: 0 },
    players: { lofii: {} },
    game: { dimension: 'minecraft:overworld' }
  } as unknown as Bot
  const task: TaskSnapshot = {
    enabled: true,
    active: true,
    name: 'fishing',
    state: 'running',
    startedAt: new Date().toISOString(),
    elapsedSec: 12,
    progress: {
      fishCaught: 3,
      wheatHarvested: 0,
      planted: 0,
      deposited: 0,
      treesChopped: 0,
      logsChopped: 0,
      saplingsPlanted: 0,
      mobsKilled: 0,
      oresMined: 0,
      coalMined: 0,
      ironMined: 0,
      copperMined: 0,
      forestTreesChopped: 0,
      naturalLogsChopped: 0,
      naturalSaplingsPlanted: 0,
      sleepVotes: 0,
      nightSkipped: 0,
      patrolWaypoints: 0,
      patrolDistance: 0,
      guardKills: 0,
      escortDistance: 0,
      exploreWaypoints: 0
    },
    failures: 0,
    lastError: null,
    pendingResume: null,
    queue: []
  }
  const lines = buildStatusLines(bot, { describe: () => '待机' } as never, task)
  assert.equal(lines.length, 3)
  assert.match(lines[2] ?? '', /钓鱼/)
  assert.match(lines[2] ?? '', /鱼 3/)
})
