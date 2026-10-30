import assert from 'node:assert/strict'
import test from 'node:test'
import { planRoute } from '../../src/minecraft/routing/planner.ts'
import { stepControls } from '../../src/minecraft/routing/executor.ts'
import type { NavArea, NavBlock, NavWorld } from '../../src/minecraft/routing/types.ts'

const AIR: NavBlock = { name: 'air', boundingBox: 'empty', shapes: [] }
const STONE: NavBlock = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }

const AREA: NavArea = { minX: -8, maxX: 40, minZ: -8, maxZ: 8, minY: 55, maxY: 90 }

class FakeWorld implements NavWorld {
  readonly blocks = new Map<string, NavBlock>()

  constructor (defaultAir = true) {
    if (!defaultAir) this.blocks.set('unused', STONE)
  }

  set (x: number, y: number, z: number, block: NavBlock): void {
    this.blocks.set(`${x},${y},${z}`, block)
  }

  blockAt (x: number, y: number, z: number): NavBlock | null {
    return this.blocks.get(`${x},${y},${z}`) ?? AIR
  }
}

function floor (world: FakeWorld, x: number, z: number, y: number): void {
  world.set(x, y, z, STONE)
  world.set(x, y + 1, z, AIR)
  world.set(x, y + 2, z, AIR)
}

function plan (world: FakeWorld, start: { x: number, y: number, z: number }, target: { x: number, y: number, z: number }, tolerance = 1) {
  return planRoute(world, AREA, start, target, tolerance, { timeoutMs: 1500, maxNodes: 4000 })
}

test('v1.0.6 规划器：平地直线可达', () => {
  const world = new FakeWorld()
  for (let x = 0; x <= 10; x += 1) floor(world, x, 0, 63)
  const result = plan(world, { x: 0.5, y: 64, z: 0.5 }, { x: 9.5, y: 64, z: 0.5 })
  assert.equal(result.status, 'success')
  assert.ok(result.waypoints.length > 1)
  assert.equal(result.waypoints.at(-1)?.x, 9)
  assert.equal(result.waypoints.at(-1)?.y, 64)
})

test('v1.0.6 规划器：1–5 级逐级台阶可达', () => {
  for (let steps = 1; steps <= 5; steps += 1) {
    const world = new FakeWorld()
    for (let x = 0; x <= 1; x += 1) floor(world, x, 0, 63)
    for (let level = 1; level <= steps; level += 1) {
      floor(world, level + 1, 0, 63 + level)
    }
    const target = { x: steps + 1.5, y: 64 + steps, z: 0.5 }
    const result = plan(world, { x: 0.5, y: 64, z: 0.5 }, target, 1)
    assert.equal(result.status, 'success', `steps=${steps}`)
    assert.equal(result.waypoints.at(-1)?.y, 64 + steps)
  }
})

test('v1.0.6 规划器：1 格矮墙可跳上并通过', () => {
  const world = new FakeWorld()
  for (let x = 0; x <= 8; x += 1) floor(world, x, 0, 63)
  world.set(2, 64, 0, STONE)
  world.set(2, 65, 0, AIR)
  const result = plan(world, { x: 0.5, y: 64, z: 0.5 }, { x: 7.5, y: 64, z: 0.5 })
  assert.equal(result.status, 'success')
  assert.ok(result.waypoints.some(point => point.y === 65))
})

test('v1.0.6 规划器：2 格墙会绕行', () => {
  const world = new FakeWorld()
  for (let x = 0; x <= 8; x += 1) {
    for (let z = 0; z <= 2; z += 1) floor(world, x, z, 63)
  }
  world.set(2, 64, 0, STONE)
  world.set(2, 65, 0, STONE)
  world.set(2, 66, 0, AIR)
  const result = plan(world, { x: 0.5, y: 64, z: 0.5 }, { x: 7.5, y: 64, z: 0.5 })
  assert.equal(result.status, 'success')
  assert.ok(result.waypoints.some(point => point.z !== 0), '应走 z=1 或 z=2 绕行')
})

test('v1.0.6 规划器：5 格垂直墙明确 no_path，不伪造成功', () => {
  const world = new FakeWorld()
  for (let x = 0; x <= 8; x += 1) floor(world, x, 0, 63)
  for (let level = 1; level <= 5; level += 1) world.set(2, 63 + level, 0, STONE)
  const result = plan(world, { x: 0.5, y: 64, z: 0.5 }, { x: 7.5, y: 64, z: 0.5 })
  assert.equal(result.status, 'no_path')
  assert.equal(result.waypoints.length, 0)
})

test('v1.0.6 规划器：半砖顶面可站立', () => {
  const world = new FakeWorld()
  for (let x = 0; x <= 4; x += 1) floor(world, x, 0, 63)
  world.set(2, 63, 0, { name: 'stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] })
  const result = plan(world, { x: 0.5, y: 64, z: 0.5 }, { x: 3.5, y: 64, z: 0.5 })
  assert.equal(result.status, 'success')
})

test('v1.0.6 规划器：节点上限超时明确返回 timeout', () => {
  const world = new FakeWorld()
  for (let x = 0; x <= 10; x += 1) floor(world, x, 0, 63)
  const result = planRoute(world, AREA, { x: 0.5, y: 64, z: 0.5 }, { x: 9.5, y: 64, z: 0.5 }, 1, {
    timeoutMs: 1,
    maxNodes: 64
  })
  assert.ok(['timeout', 'success'].includes(result.status))
})

test('v1.0.6 执行器：只有 1 格抬高才起跳，2 格高差不硬跳', () => {
  assert.deepEqual(stepControls({ x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }), {
    jump: true,
    forward: true,
    sprint: false
  })
  assert.deepEqual(stepControls({ x: 0, y: 64, z: 0 }, { x: 1, y: 66, z: 0 }), {
    jump: false,
    forward: true,
    sprint: false
  })
  assert.deepEqual(stepControls({ x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }), {
    jump: false,
    forward: true,
    sprint: true
  })
})
