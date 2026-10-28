import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { AuditLogger } from '../../src/audit.ts'
import type { AutonomySessionClient, SessionPermission } from '../../src/ai/session.ts'
import { AutonomyService } from '../../src/autonomy/service.ts'
import { EventBus } from '../../src/events/bus.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import type { TaskController, TaskStartResult } from '../../src/tasks/types.ts'
import type { TaskName, TaskSnapshot } from '../../src/state.ts'
import { createLogger } from '../../src/logger.ts'
import { baseEnv, makeConfig, makeState, waitFor } from '../helpers.ts'

class FakeTasks implements TaskController {
  stateRef: ReturnType<typeof makeState>
  active = false
  stopped = 0
  constructor (stateRef: ReturnType<typeof makeState>) {
    this.stateRef = stateRef
  }

  async start (name: TaskName): Promise<TaskStartResult> {
    this.active = true
    this.stateRef.setTask({ active: true, name, state: 'running', startedAt: new Date().toISOString() })
    return { status: 'started' }
  }

  requestStop (_reason: string): void {
    this.stopped += 1
    this.active = false
    this.stateRef.setTask({ active: false, name: null, state: 'idle' })
  }

  async stopAndWait (reason: string): Promise<void> { this.requestStop(reason) }
  async depositNow (): Promise<void> {}
  async confirmResume (_taskId?: string): Promise<void> {}
  async discardPending (_reason: string): Promise<void> {}
  snapshot (): TaskSnapshot { return this.stateRef.task }
  keepOnline (): boolean { return this.active }
  isActive (): boolean { return this.active }
}

class FakeSession implements AutonomySessionClient {
  token = ''
  prompts: string[] = []
  permissions: SessionPermission[] = []
  registered = 0
  removed = 0
  deleted = 0
  interrupted = 0
  private waiters: Array<() => void> = []

  async registerMcp (_name: string, _url: string, bearer: string): Promise<void> {
    this.token = bearer
    this.registered += 1
  }

  async removeMcp (_name: string): Promise<void> { this.removed += 1 }
  async createSession (_title: string, permissions: SessionPermission[]): Promise<string> {
    this.permissions = permissions
    return 'sess-v103'
  }

  async prompt (_sessionId: string, text: string): Promise<void> { this.prompts.push(text) }
  async wait (_sessionId: string, _signal?: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => { this.waiters.push(resolve) })
  }

  async interrupt (_sessionId: string): Promise<void> { this.interrupted += 1 }
  async deleteSession (_sessionId: string): Promise<void> { this.deleted += 1 }
  async assistantText (_sessionId: string): Promise<string> { return '' }

  finishWait (): void {
    this.waiters.shift()?.()
  }
}

interface Fixture {
  config: ReturnType<typeof makeConfig>
  state: ReturnType<typeof makeState>
  tasks: FakeTasks
  session: FakeSession
  events: EventBus
  service: AutonomyService
  bot: Bot
  opened: { count: number }
  equipped: Array<{ item: string, destination: string }>
  consumed: { count: number }
  moved: { teleports: boolean, allowTeleport: boolean | null }
}

function fixture (env: Record<string, string | undefined> = {}): Fixture {
  const config = makeConfig({}, {
    ...baseEnv(),
    AI_ENABLED: 'true',
    OPENCODE_PASSWORD: 'test-password',
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_MAX_TOOL_CALLS: '10',
    AUTONOMY_MCP_WARMUP_MS: '0',
    AUTONOMY_SCAN_RADIUS: '16',
    AUTONOMY_SCAN_MAX_BLOCKS: '48',
    AUTONOMY_SCAN_BLOCKS: 'chest,*_bed',
    AUTONOMY_CHEST_READ_ENABLED: 'true',
    AUTONOMY_ACTION_COOLDOWN_MS: '0',
    AUTONOMY_EVENT_DEBOUNCE_MS: '0',
    AUTONOMY_MAX_REPROMPTS: '6',
    TASK_ENABLED: 'true',
    HTTP_CONTROL_ENABLED: 'true',
    ...env
  })
  const state = makeState(config)
  const events = new EventBus(100)
  const tasks = new FakeTasks(state)
  const session = new FakeSession()
  const opened = { count: 0 }
  const equipped: Array<{ item: string, destination: string }> = []
  const consumed = { count: 0 }
  const moved = { teleports: false, allowTeleport: null as boolean | null }
  const chestItem = { name: 'bread', count: 3, type: 1 }
  const bread = { name: 'bread', count: 2, type: 1 }
  const helmet = { name: 'iron_helmet', count: 1, type: 1 }
  const bot = {
    entity: { position: new Vec3(180, 64, 440) },
    username: 'lofii',
    health: 20,
    food: 10,
    game: { dimension: 'minecraft:overworld' },
    time: { timeOfDay: 6000 },
    players: { lofii: {} },
    entities: {},
    heldItem: null,
    currentWindow: null,
    inventory: {
      items: () => [bread, helmet],
      emptySlotCount: () => 20,
      slots: []
    },
    registry: {
      blocksByName: { chest: {}, red_bed: {}, iron_helmet: {} },
      foodsByName: { bread: {} }
    },
    findBlocks: () => [new Vec3(190, 64, 440)],
    blockAt: (position: Vec3) => position.x === 190 && position.y === 64 && position.z === 440
      ? { name: 'chest', position }
      : null,
    openContainer: async () => {
      opened.count += 1
      return {
        containerItems: () => [chestItem],
        close: async () => {}
      }
    },
    closeWindow: async () => {},
    equip: async (item: { name: string }, destination: string) => {
      equipped.push({ item: item.name, destination })
    },
    consume: async () => {
      consumed.count += 1
      bot.food = 20
    }
  } as unknown as Bot
  const movement = {
    home: async () => {},
    goNearPoint: async (_x: number, _y: number, _z: number, _r: number, _t: number, allowTeleport: boolean) => {
      moved.allowTeleport = allowTeleport
      if (allowTeleport) moved.teleports = true
    },
    stop: () => {}
  } as unknown as MovementManager
  const chatSender = { say: async () => ['ok'], isConnected: () => true } as unknown as ChatSender
  const audit: AuditLogger = { append: () => {} } as unknown as AuditLogger
  const service = new AutonomyService({
    config,
    logger: createLogger('error'),
    state,
    audit,
    events,
    chatSender,
    movement,
    tasks: {
      ...tasks,
      isActive: () => tasks.active,
      start: (name: string) => tasks.start(name as TaskName)
    } as unknown as TaskController,
    opencode: session,
    getBot: () => bot
  })
  return { config, state, tasks, session, events, service, bot, opened, equipped, consumed, moved }
}

async function startRun (f: Fixture): Promise<{ runId: string, token: string }> {
  const result = await f.service.start(null, 'Antifield')
  assert.equal(result.ok, true)
  const prompt = f.session.prompts[0] ?? ''
  const match = /当前 run_id：([0-9a-f-]+)/.exec(prompt)
  assert.ok(match)
  return { runId: match[1] ?? '', token: f.session.token }
}

async function call (f: Fixture, token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await f.service.handleMcpHttp(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  assert.equal(response.status, 200)
  const body = response.body as { result?: { content?: Array<{ text: string }> } }
  const text = body.result?.content?.[0]?.text ?? ''
  return JSON.parse(text)
}

test('v1.0.3 exposes observe and guarded action tools', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  const list = await f.service.handleMcpHttp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const body = list.body as { result: { tools: Array<{ name: string }> } }
  const names = body.result.tools.map(tool => tool.name)
  assert.deepEqual(names, ['start_task', 'stop_task', 'go_home', 'deposit', 'task_status', 'observe', 'inspect_chest', 'eat', 'equip', 'finish'])

  const observed = await call(f, token, 'observe', { run_id: runId })
  assert.equal((observed as { ok: boolean }).ok, true)
  const environment = (observed as { environment: { blocks: Array<{ name: string }>, chests: Array<{ type: string }> } }).environment
  assert.ok(environment.blocks.some(block => block.name === 'chest'))
  assert.equal(environment.chests[0]?.type, 'chest')
  await f.service.stop('test')
})

test('v1.0.3 inspect_chest reads without withdrawing and never teleports', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  const result = await call(f, token, 'inspect_chest', { run_id: runId, target: '190,64,440', reason: '查看容器' })
  assert.equal((result as { ok: boolean }).ok, true)
  assert.equal(f.opened.count, 1)
  assert.equal(f.moved.allowTeleport, false)
  assert.equal(f.moved.teleports, false)
  const chest = (result as { chest: { items: Array<{ name: string }> } }).chest
  assert.deepEqual(chest.items, [{ name: 'bread', count: 3 }])
  await f.service.stop('test')
})

test('v1.0.3 eat validates food and requires low hunger', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  const eaten = await call(f, token, 'eat', { run_id: runId, item: 'bread', reason: '补充饥饿' })
  assert.equal((eaten as { ok: boolean }).ok, true)
  assert.equal(f.consumed.count, 1)
  assert.equal(f.equipped.at(-1)?.destination, 'hand')
  await f.service.stop('test')
})

test('v1.0.3 equip only accepts known equipment categories', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  const equipped = await call(f, token, 'equip', { run_id: runId, item: 'iron_helmet', reason: '提高防御' })
  assert.equal((equipped as { ok: boolean }).ok, true)
  assert.deepEqual(f.equipped.at(-1), { item: 'iron_helmet', destination: 'head' })
  await f.service.stop('test')
})

test('v1.0.3 action tools reject while a task is active', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  f.state.setTask({ active: true, name: 'fishing', state: 'running' })
  const result = await call(f, token, 'eat', { run_id: runId, item: 'bread', reason: '补充饥饿' })
  assert.equal((result as { ok: boolean }).ok, false)
  assert.equal((result as { error: string }).error, 'task_active')
  await f.service.stop('test')
})

test('v1.0.3 inspect_chest and eat/equip fail closed on invalid input', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  const disabled = await call(f, token, 'inspect_chest', { run_id: runId, target: '190,64,440', reason: '查看容器' })
  assert.equal((disabled as { ok: boolean }).ok, true, '默认配置允许读取')
  await f.service.stop('test')

  const disabledFixture = fixture({ AUTONOMY_CHEST_READ_ENABLED: 'false' })
  const disabledRun = await startRun(disabledFixture)
  const denied = await call(disabledFixture, disabledRun.token, 'inspect_chest', {
    run_id: disabledRun.runId,
    target: '190,64,440',
    reason: '查看容器'
  })
  assert.equal((denied as { error: string }).error, 'chest_disabled')
  await disabledFixture.service.stop('test')

  const g = fixture()
  const gr = await startRun(g)
  const badFood = await call(g, gr.token, 'eat', { run_id: gr.runId, item: 'iron_helmet', reason: '吃装备' })
  assert.equal((badFood as { error: string }).error, 'not_food')
  const badEquip = await call(g, gr.token, 'equip', { run_id: gr.runId, item: 'bread', reason: '装备食物' })
  assert.equal((badEquip as { error: string }).error, 'not_equippable')
  await g.service.stop('test')
})

test('v1.0.3 session without a task finishes after the initial turn', async () => {
  const f = fixture()
  await startRun(f)
  f.session.finishWait()
  await waitFor(() => !f.service.isActive())
})

test('v1.0.3 safety alerts trigger an event-driven re-prompt', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  await call(f, token, 'start_task', { run_id: runId, task: 'fishing', reason: '开始任务' })
  f.session.finishWait()
  f.events.emit('alert', { type: 'low_health', severity: 'warning', message: 'low', details: {}, ts: new Date().toISOString() })
  await waitFor(() => f.session.prompts.length === 2)
  assert.match(f.session.prompts[1] ?? '', /alert:low_health|本次触发/)
  await f.service.stop('test')
})

test('v1.0.3 inspect_chest rejects coordinates outside the safe zone', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  const result = await call(f, token, 'inspect_chest', { run_id: runId, target: '999,64,440', reason: '越界容器' })
  assert.equal((result as { error: string }).error, 'chest_out_of_range')
  await f.service.stop('test')
})

test('v1.0.3 task events trigger an event-driven re-prompt', async () => {
  const f = fixture()
  const { runId, token } = await startRun(f)
  await call(f, token, 'start_task', { run_id: runId, task: 'fishing', reason: '开始任务' })
  assert.equal(f.session.prompts.length, 1)
  f.session.finishWait()
  f.state.setTask({ active: false, name: null, state: 'idle' })
  f.events.emit('task', { action: 'completed', task: f.state.task })
  await waitFor(() => f.session.prompts.length === 2)
  assert.match(f.session.prompts[1] ?? '', /task:completed|本次触发/)
  f.session.finishWait()
  await waitFor(() => !f.service.isActive())
})
