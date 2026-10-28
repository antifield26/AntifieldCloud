import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { buildEnvironment, formatEnvironment, scanEnvironment } from '../../src/ai/environment.ts'
import { makeConfig, makeState } from '../helpers.ts'

function fakeBot (overrides: Record<string, unknown> = {}): Bot {
  const blocks: Record<string, { name: string }> = {
    '180,64,440': { name: 'chest' },
    '182,64,440': { name: 'red_bed' },
    '300,64,440': { name: 'chest' }
  }
  return {
    entity: { position: new Vec3(180, 64, 440) },
    username: 'lofii',
    health: 20,
    food: 20,
    game: { dimension: 'minecraft:overworld' },
    time: { timeOfDay: 6000 },
    players: { lofii: {}, Steve: {} },
    entities: {
      1: { type: 'mob', name: 'zombie', position: new Vec3(182, 64, 440) },
      2: { type: 'player', name: 'Steve', position: new Vec3(183, 64, 440) }
    },
    heldItem: { name: 'iron_pickaxe' },
    inventory: {
      items: () => [],
      emptySlotCount: () => 20,
      slots: []
    },
    registry: {
      blocksByName: {
        chest: {},
        trapped_chest: {},
        red_bed: {},
        oak_log: {},
        coal_ore: {}
      }
    },
    findBlocks: () => [new Vec3(180, 64, 440), new Vec3(182, 64, 440), new Vec3(300, 64, 440)],
    blockAt: (position: Vec3) => blocks[`${position.x},${position.y},${position.z}`] ?? null,
    ...overrides
  } as unknown as Bot
}

function config (env: Record<string, string | undefined> = {}) {
  return makeConfig({}, env)
}

test('environment snapshot is bounded and reports blockers', () => {
  const cfg = config()
  const state = makeState(cfg)
  const snapshot = buildEnvironment(fakeBot({ health: 6, food: 4 }), state.task, cfg)
  assert.equal(snapshot.connected, true)
  assert.equal(snapshot.dimension, '主世界')
  assert.equal(snapshot.position?.x, 180)
  assert.equal(snapshot.clock, '12:00')
  assert.deepEqual(snapshot.players, ['Steve'])
  assert.equal(snapshot.hostiles[0]?.name, 'zombie')
  assert.equal(snapshot.heldItem, 'iron_pickaxe')
  assert.equal(snapshot.blockers.includes('low_health'), true)
  assert.equal(snapshot.blockers.includes('low_food'), true)
  assert.equal(snapshot.blocks, undefined)
  assert.match(formatEnvironment(snapshot), /环境：主世界/)
})

test('disconnected environment stays readable and fail-closed', () => {
  const cfg = config()
  const state = makeState(cfg)
  const snapshot = buildEnvironment(null, state.task, cfg)
  assert.equal(snapshot.connected, false)
  assert.deepEqual(snapshot.players, [])
  assert.ok(snapshot.blockers.includes('not_connected'))
  assert.match(formatEnvironment(snapshot), /未连接/)
})

test('block scan expands leading wildcards and filters safe zone', () => {
  const cfg = config()
  const bot = fakeBot()
  const result = scanEnvironment(bot, cfg, {
    radius: 16,
    maxBlocks: 48,
    patterns: ['chest', '*_bed']
  })
  assert.deepEqual(result.blocks.map(block => block.name), ['chest', 'red_bed'])
  assert.equal(result.chests.length, 1)
  assert.equal(result.chests[0]?.type, 'chest')
  assert.equal(result.chests[0]?.x, 180)
  assert.equal(result.truncated, false)
})

test('block scan caps results and marks truncation', () => {
  const cfg = config()
  const bot = fakeBot({
    findBlocks: () => Array.from({ length: 8 }, () => new Vec3(180, 64, 440))
  })
  const result = scanEnvironment(bot, cfg, {
    radius: 16,
    maxBlocks: 8,
    patterns: ['chest']
  })
  assert.equal(result.truncated, true)
  assert.equal(result.blocks[0]?.count, 8)
})
