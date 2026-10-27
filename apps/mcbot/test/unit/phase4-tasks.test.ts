import test from 'node:test'
import assert from 'node:assert/strict'
import type { Bot } from 'mineflayer'
import { parseCommand } from '../../src/minecraft/commands.ts'
import { pickEscortTarget } from '../../src/tasks/escort.ts'
import { loadConfig } from '../../src/config.ts'

function env (overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HTTP_TOKEN: 'x'.repeat(24),
    AI_ENABLED: 'false',
    ...overrides
  }
}

test('v1.0.0 新任务指令：守卫/护送/探索且优先于普通聊天', () => {
  assert.deepEqual(parseCommand('守卫'), { name: 'guard' })
  assert.deepEqual(parseCommand('去守家'), { name: 'guard' })
  assert.deepEqual(parseCommand('guard'), { name: 'guard' })
  assert.deepEqual(parseCommand('护送我'), { name: 'escort' })
  assert.deepEqual(parseCommand('escort'), { name: 'escort' })
  assert.deepEqual(parseCommand('去探索'), { name: 'explore' })
  assert.deepEqual(parseCommand('航点探索'), { name: 'explore' })
  // 旧指令行为不变
  assert.deepEqual(parseCommand('去钓鱼'), { name: 'fish' })
  assert.deepEqual(parseCommand('收工'), { name: 'stopTask' })
})

test('v1.0.0 新任务配置：守卫半径/护送距离/探索航点', () => {
  const config = loadConfig(env({ EXPLORE_WAYPOINTS: 'home:175:64:410;farm:180:64:435' }), '1.0.0')
  assert.equal(config.guardRadius, 16)
  assert.equal(config.escortDistance, 12)
  assert.deepEqual(config.exploreWaypoints.map(point => point.name), ['home', 'farm'])
  assert.throws(() => loadConfig(env({ EXPLORE_WAYPOINTS: 'home:175:64:410;home:180:64:435' })), /duplicate/)
  assert.throws(() => loadConfig(env({ EXPLORE_WAYPOINTS: 'x:1:64:1' })), /SAFE_MIN_X/)
  assert.throws(() => loadConfig(env({ EXPLORE_WAYPOINTS: 'bad name:175:64:410' })), /name must be/)
})

test('护送目标选择：排除自己、按名字稳定排序、优先主人', () => {
  const bot = { username: 'lofii', players: { lofii: {}, Zed: {}, Antifield: {}, Bob: {} } } as unknown as Bot
  assert.equal(pickEscortTarget(bot), 'Antifield')
  assert.equal(pickEscortTarget(bot, 'Bob'), 'Bob')
  assert.equal(pickEscortTarget(bot, 'missing'), 'Antifield')
  const alone = { username: 'lofii', players: { lofii: {} } } as unknown as Bot
  assert.equal(pickEscortTarget(alone), null)
})
