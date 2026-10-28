import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot } from 'mineflayer'
import { HttpApi } from '../../src/http/server.ts'
import type { AuditLogger } from '../../src/audit.ts'
import type { AutonomySessionClient, SessionPermission } from '../../src/ai/session.ts'
import { AutonomyService } from '../../src/autonomy/service.ts'
import { EventBus } from '../../src/events/bus.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import type { TaskController, TaskStartResult } from '../../src/tasks/types.ts'
import type { TaskName, TaskSnapshot } from '../../src/state.ts'
import { createLogger } from '../../src/logger.ts'
import { baseEnv, makeConfig, makeState } from '../helpers.ts'

function autonomyConfig (env: Record<string, string | undefined> = {}) {
  return makeConfig({}, {
    ...baseEnv(),
    AI_ENABLED: 'true',
    OPENCODE_PASSWORD: 'test-password',
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_MAX_TOOL_CALLS: '3',
    TASK_ENABLED: 'true',
    HTTP_CONTROL_ENABLED: 'true',
    ...env
  })
}

class FakeTasks implements TaskController {
  stateRef: ReturnType<typeof makeState>
  active = false
  started: Array<{ name: TaskName, username: string, source?: string }> = []
  stopped = 0
  deposited = 0
  stopWaited = 0
  constructor (stateRef: ReturnType<typeof makeState>) {
    this.stateRef = stateRef
  }

  async start (name: TaskName, username: string, source?: 'chat' | 'http_control' | 'autonomy'): Promise<TaskStartResult> {
    this.started.push({ name, username, source })
    this.active = true
    this.stateRef.setTask({ active: true, name, state: 'running', startedAt: new Date().toISOString() })
    return { status: 'started' }
  }

  requestStop (_reason: string): void {
    this.stopped += 1
    this.active = false
    this.stateRef.setTask({ active: false, name: null, state: 'idle' })
  }

  async stopAndWait (_reason: string): Promise<void> {
    this.stopWaited += 1
    this.active = false
    this.stateRef.setTask({ active: false, name: null, state: 'idle' })
  }

  async depositNow (): Promise<void> {
    this.deposited += 1
  }

  async confirmResume (_taskId?: string): Promise<void> {}
  async discardPending (_reason: string): Promise<void> {}

  snapshot (): TaskSnapshot {
    return this.stateRef.snapshot().task
  }

  keepOnline (): boolean {
    return this.active
  }

  isActive (): boolean {
    return this.active
  }
}

class FakeSession implements AutonomySessionClient {
  token = ''
  promptText = ''
  permissions: SessionPermission[] = []
  registered = 0
  removed = 0
  deleted = 0
  interrupted = 0
  private resolveWait: (() => void) | null = null
  private readonly waitPromise = new Promise<void>(resolve => { this.resolveWait = resolve })

  async registerMcp (_name: string, _url: string, bearer: string): Promise<void> {
    this.token = bearer
    this.registered += 1
  }

  async removeMcp (_name: string): Promise<void> {
    this.removed += 1
  }

  async createSession (_title: string, permissions: SessionPermission[]): Promise<string> {
    this.permissions = permissions
    return 'sess-test'
  }

  async prompt (_sessionId: string, text: string): Promise<void> {
    this.promptText = text
  }

  async wait (_sessionId: string, _signal?: AbortSignal): Promise<void> {
    await this.waitPromise
  }

  async interrupt (_sessionId: string): Promise<void> {
    this.interrupted += 1
  }

  async deleteSession (_sessionId: string): Promise<void> {
    this.deleted += 1
  }

  async assistantText (_sessionId: string): Promise<string> {
    return 'finished'
  }

  finishWait (): void {
    this.resolveWait?.()
  }
}

function setup (env: Record<string, string | undefined> = {}) {
  const config = autonomyConfig(env)
  const state = makeState(config)
  const tasks = new FakeTasks(state)
  const session = new FakeSession()
  const events = new EventBus(100)
  const audit: AuditLogger = { append: () => {} } as unknown as AuditLogger
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, food: 20 } as unknown as Bot
  const movement = { home: async () => {} } as unknown as MovementManager
  const chatSender = { say: async () => ['ok'], isConnected: () => true } as unknown as ChatSender
  const service = new AutonomyService({
    config,
    logger: createLogger('error'),
    state,
    audit,
    events,
    chatSender,
    movement,
    tasks,
    opencode: session,
    getBot: () => bot
  })
  return { config, state, tasks, session, events, audit, service, movement, chatSender, getBot: () => bot }
}

function runIdFromPrompt (prompt: string): string {
  const match = /当前 run_id：([0-9a-f-]+)/.exec(prompt)
  assert.ok(match, 'prompt contains run id')
  return match[1] ?? ''
}

async function startAndGet (setupResult: ReturnType<typeof setup>) {
  const result = await setupResult.service.start(null, 'Antifield')
  assert.equal(result.ok, true)
  await Promise.resolve()
  return { result, runId: runIdFromPrompt(setupResult.session.promptText), token: setupResult.session.token }
}

test('autonomy start registers native MCP, creates permissions and exposes tools', async () => {
  const s = setup()
  const { result, runId, token } = await startAndGet(s)
  assert.equal(result.autonomy.state, 'running')
  assert.equal(s.session.registered, 1)
  assert.deepEqual(s.session.permissions[0], { action: '*', resource: '*', effect: 'deny' })
  assert.deepEqual(s.session.permissions[1], { action: 'mcbot_autonomy_*', resource: '*', effect: 'allow' })
  assert.equal(runId.length, 36)
  assert.ok(token.length >= 40)

  const list = await s.service.handleMcpHttp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(list.status, 200)
  const body = list.body as { result: { tools: Array<{ name: string }> } }
  assert.ok(body.result.tools.some(tool => tool.name === 'start_task'))
  await s.service.stop('test')
})

test('autonomy tool call starts a task through the deterministic controller', async () => {
  const s = setup()
  const { runId, token } = await startAndGet(s)
  const response = await s.service.handleMcpHttp(token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'start_task', arguments: { run_id: runId, task: 'fishing', reason: '需要食物' } }
  })
  const body = response.body as { result: { isError: boolean, content: Array<{ text: string }> } }
  assert.equal(body.result.isError, false)
  assert.deepEqual(s.tasks.started[0], { name: 'fishing', username: 'autonomy', source: 'autonomy' })
  await s.service.stop('test')
})

test('autonomy rejects bad run_id and unknown tools without executing', async () => {
  const s = setup()
  const { runId, token } = await startAndGet(s)
  const bad = await s.service.handleMcpHttp(token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'start_task', arguments: { run_id: 'wrong-run-id', task: 'fishing', reason: 'x' } }
  })
  const badBody = bad.body as { result: { isError: boolean } }
  assert.equal(badBody.result.isError, true)
  assert.equal(s.tasks.started.length, 0)

  const unknown = await s.service.handleMcpHttp(token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'shell', arguments: { run_id: runId, reason: 'x' } }
  })
  assert.equal((unknown.body as { result: { isError: boolean } }).result.isError, true)
  await s.service.stop('test')
})

test('autonomy stop is idempotent and removes MCP/session', async () => {
  const s = setup()
  await startAndGet(s)
  await s.service.stop('owner_stop')
  assert.equal(s.session.interrupted, 1)
  assert.equal(s.session.deleted, 1)
  assert.equal(s.session.removed >= 1, true)
  assert.equal(s.tasks.stopWaited, 0)
  assert.equal(s.service.snapshot().state, 'finished')
  await s.service.stop('again')
  assert.equal(s.session.deleted, 1)
})

test('autonomy rejects when another task is active', async () => {
  const s = setup()
  s.tasks.active = true
  s.state.setTask({ active: true, name: 'farming', state: 'running' })
  const result = await s.service.start(null, 'Antifield')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'autonomy_busy')
  assert.equal(s.session.registered, 0)
})

test('autonomy token is invalid after stop', async () => {
  const s = setup()
  const { token } = await startAndGet(s)
  await s.service.stop('done')
  const response = await s.service.handleMcpHttp(token, { jsonrpc: '2.0', id: 5, method: 'tools/list' })
  assert.equal(response.status, 401)
})

test('autonomy enforces the tool-call budget', async () => {
  const s = setup({ AUTONOMY_MAX_TOOL_CALLS: '1' })
  const { runId, token } = await startAndGet(s)
  const call = async (id: number) => {
    const response = await s.service.handleMcpHttp(token, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'task_status', arguments: { run_id: runId } }
    })
    const body = response.body as { result: { isError: boolean, content: Array<{ text: string }> } }
    return { isError: body.result.isError, text: body.result.content[0]?.text ?? '' }
  }
  const first = await call(1)
  assert.equal(first.isError, false)
  const second = await call(2)
  assert.equal(second.isError, true)
  assert.match(second.text, /tool_budget_exhausted/)
  await s.service.stop('test')
})

test('autonomy fails closed when model never completes', async () => {
  const s = setup()
  await startAndGet(s)
  s.session.finishWait()
  await new Promise(resolve => setTimeout(resolve, 10))
  const snapshot = s.service.snapshot()
  assert.equal(snapshot.active, false)
  assert.equal(snapshot.state, 'finished')
})

test('HTTP autonomy routes enforce read/control tokens and mount MCP', async () => {
  const s = setup({ HTTP_CONTROL_TOKEN: 'control-token-0123456789abcdef' })
  const api = new HttpApi({
    config: { ...s.config, httpPort: 0, httpHost: '127.0.0.1' },
    logger: createLogger('error'),
    state: s.state,
    chatSender: s.chatSender,
    movement: s.movement,
    tasks: s.tasks,
    events: s.events,
    audit: s.audit,
    getBot: s.getBot,
    autonomy: s.service
  })
  const port = await api.start()
  const base = `http://127.0.0.1:${port}`
  const read = { Authorization: 'Bearer 0123456789abcdef0123456789abcdef' }
  const control = { Authorization: 'Bearer control-token-0123456789abcdef', 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(`${base}/autonomy`)).status, 401)
    assert.equal((await fetch(`${base}/autonomy`, { headers: read })).status, 200)
    assert.equal((await fetch(`${base}/autonomy/start`, { method: 'POST', headers: read, body: '{}' })).status, 401)
    const started = await fetch(`${base}/autonomy/start`, {
      method: 'POST', headers: control, body: JSON.stringify({ goal: '整理基地' })
    })
    assert.equal(started.status, 202)
    const startedBody = await started.json() as { ok: boolean, autonomy: { active: boolean } }
    assert.equal(startedBody.ok, true)
    assert.equal(startedBody.autonomy.active, true)
    const token = s.session.token
    const mcp = await fetch(`${base}/autonomy/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    assert.equal(mcp.status, 200)
    const mcpBody = await mcp.json() as { result: { tools: Array<{ name: string }> } }
    assert.ok(mcpBody.result.tools.some(tool => tool.name === 'start_task'))
    const stopped = await fetch(`${base}/autonomy/stop`, {
      method: 'POST', headers: control, body: JSON.stringify({ reason: 'test_stop' })
    })
    assert.equal(stopped.status, 202)
    assert.equal((await stopped.json() as { ok: boolean }).ok, true)
    assert.equal(s.service.snapshot().active, false)
  } finally {
    await api.stop()
    await s.service.stop('test_cleanup')
  }
})
