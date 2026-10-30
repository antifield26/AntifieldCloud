import assert from 'node:assert/strict'
import test from 'node:test'
import { PathAdvisor, buildTerrainSummary } from '../../src/ai/path-advisor.ts'
import type { OpenCodeClient } from '../../src/ai/opencode.ts'
import type { AdvisorInput, NavArea, NavBlock, NavWorld } from '../../src/minecraft/routing/types.ts'
import { makeConfig } from '../helpers.ts'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withScope: () => logger
}

const AREA: NavArea = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 60, maxY: 80 }

const AIR: NavBlock = { name: 'air', boundingBox: 'empty', shapes: [] }
const STONE: NavBlock = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }

function fakeClient (text: string): OpenCodeClient {
  return {
    generate: async () => ({ text, latencyMs: 1 })
  } as unknown as OpenCodeClient
}

function advisor (text: string): PathAdvisor {
  const config = makeConfig({
    aiEnabled: true,
    opencodePassword: 'test-password',
    pathAiEnabled: true,
    pathAiTimeoutMs: 500
  })
  return new PathAdvisor(config, logger as never, fakeClient(text))
}

function input (): AdvisorInput {
  return {
    start: { x: 0, y: 64, z: 0 },
    target: { x: 5, y: 64, z: 0 },
    failure: 'no_path',
    bounds: AREA,
    allowOutsideSafeZone: false,
    terrain: ['0:stone 0:stone']
  }
}

test('v1.0.6 AI advisor：有效 JSON 被解析为受控路点', async () => {
  const result = await advisor('{"waypoints":[{"x":2,"y":64,"z":0},{"x":4,"y":65,"z":0}],"reason":"绕台阶"}').suggest(input())
  assert.deepEqual(result?.waypoints, [{ x: 2, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }])
  assert.equal(result?.reason, '绕台阶')
})

test('v1.0.6 AI advisor：非法 JSON/超量路点返回 null', async () => {
  assert.equal(await advisor('not json').suggest(input()), null)
  assert.equal(await advisor('{"waypoints":[{"x":1,"y":64,"z":0},{"x":2,"y":64,"z":0},{"x":3,"y":64,"z":0},{"x":4,"y":64,"z":0}]}').suggest(input()), null)
  assert.equal(await advisor('{"waypoints":[{"x":"bad","y":64,"z":0}]}').suggest(input()), null)
})

test('v1.0.6 AI advisor：未配置 OpenCode 时不可用', () => {
  const config = makeConfig({ aiEnabled: false, opencodePassword: '', pathAiEnabled: true })
  const instance = new PathAdvisor(config, logger as never, fakeClient('{}'))
  assert.equal(instance.available, false)
})

test('v1.0.6 AI advisor：局部高度摘要只读且有界', () => {
  const world: NavWorld = {
    blockAt: (x, y, z) => (x >= 0 && x <= 6 && z >= 0 && z <= 6 && y === 63 ? STONE : AIR)
  }
  const summary = buildTerrainSummary(world, AREA, { x: 3, y: 64, z: 3 })
  assert.equal(summary.length, 7)
  assert.equal(summary[0]?.split(' ').length, 7)
  assert.ok(summary.some(line => line.includes('stone')))
})
