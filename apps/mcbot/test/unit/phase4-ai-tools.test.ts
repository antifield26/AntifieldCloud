import test from 'node:test'
import assert from 'node:assert/strict'
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { loadConfig } from '../../src/config.ts'
import { buildAiToolContext, READ_ONLY_AI_TOOL_NAMES } from '../../src/ai/tools.ts'
import type { TaskSnapshot } from '../../src/state.ts'

const EMPTY_TASK: TaskSnapshot = {
  enabled: true,
  active: false,
  name: null,
  state: 'idle',
  startedAt: null,
  elapsedSec: 0,
  progress: {
    fishCaught: 0,
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

function baseEnv (overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HTTP_TOKEN: 'x'.repeat(24),
    AI_ENABLED: 'false',
    AI_TOOLS_ENABLED: 'true',
    ...overrides
  }
}

function fakeBot (): Bot {
  const items = [
    { name: 'iron_ore', count: 3 },
    { name: 'bread', count: 2 },
    { name: 'oak_sapling', count: 4 },
    { name: 'oak_log', count: 1 }
  ]
  return {
    username: 'lofii',
    entity: { position: { x: 175.5, y: 64, z: 410.5 } },
    health: 20,
    food: 18,
    players: { lofii: {}, Antifield: {} },
    inventory: {
      items: () => items as Item[],
      emptySlotCount: () => 30
    },
    registry: { foodsByName: { bread: {} } }
  } as unknown as Bot
}

test('AI 受控工具：只读工具白名单与上下文内容', () => {
  assert.deepEqual([...READ_ONLY_AI_TOOL_NAMES], ['status', 'inventory', 'task_status'])
  const config = loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: 'status,inventory,task_status' }))
  const context = buildAiToolContext(config, { bot: fakeBot(), task: EMPTY_TASK })
  assert.match(context, /只读工具资料/)
  assert.match(context, /坐标 \(175\.5, 64\.0, 410\.5\)/)
  assert.match(context, /剩余 30 格/)
  assert.match(context, /食物 2 个/)
  assert.match(context, /矿石 3/)
  assert.match(context, /任务：当前空闲/)
  assert.doesNotMatch(context, /HTTP_TOKEN|OPENCODE_PASSWORD/)
})

test('AI 受控工具：默认关闭/未知工具 fail-closed/未连接降级', () => {
  const disabled = loadConfig(baseEnv({ AI_TOOLS_ENABLED: 'false' }))
  assert.equal(buildAiToolContext(disabled, { bot: null, task: EMPTY_TASK }), '')
  const emptyAllowlist = loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: '' }))
  assert.equal(emptyAllowlist.aiToolAllowlist.length, 3, '空值回退默认只读工具')
  const offline = loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: 'status, inventory' }))
  const context = buildAiToolContext(offline, { bot: null, task: EMPTY_TASK })
  assert.match(context, /未连接/)
  assert.throws(() => loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: 'status, shell' })), /unknown tool/)
  assert.throws(() => loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: 'task_start' })), /unknown tool/)
})

test('AI 受控工具：任务进度只暴露只读摘要', () => {
  const config = loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: 'task_status' }))
  const task: TaskSnapshot = {
    ...EMPTY_TASK,
    active: true,
    name: 'mining',
    state: 'running',
    elapsedSec: 42,
    progress: { ...EMPTY_TASK.progress, deposited: 7 },
    queue: [{ taskId: 'q1', name: 'fishing', requestedBy: 'Antifield', requestedAt: '2026-10-27T00:00:00.000Z' }]
  }
  const context = buildAiToolContext(config, { bot: fakeBot(), task })
  assert.match(context, /mining running/)
  assert.match(context, /已存 7 个物品/)
  assert.match(context, /队列 1/)
  const pending = buildAiToolContext(config, {
    bot: fakeBot(),
    task: { ...EMPTY_TASK, pendingResume: { taskId: 'p', name: 'farming', startedAt: '2026-10-27T00:00:00.000Z', elapsedSec: 10, progress: EMPTY_TASK.progress, expiresAt: '2026-10-27T00:10:00.000Z' } }
  })
  assert.match(pending, /待恢复 farming/)
})
