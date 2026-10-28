/**
 * Agentic 验收 harness：用脚本化“模型”通过 MCP 工具调用驱动真实 autonomy 策略层。
 * 不访问网络/真实 Minecraft/OpenCode；用于 CI 的 offline scenario。
 */
import type { Bot } from 'mineflayer'
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

export class FakeTasks implements TaskController {
  readonly stateRef: ReturnType<typeof makeState>
  active = false
  started: Array<{ name: TaskName, username: string, source?: string }> = []
  stopWaited = 0
  deposited = 0
  constructor (stateRef: ReturnType<typeof makeState>) { this.stateRef = stateRef }
  async start (name: TaskName, username: string, source?: 'chat' | 'http_control' | 'autonomy'): Promise<TaskStartResult> {
    this.started.push({ name, username, source })
    this.active = true
    this.stateRef.setTask({ active: true, name, state: 'running', startedAt: new Date().toISOString() })
    return { status: 'started' }
  }
  requestStop (_reason: string): void { this.active = false; this.stateRef.setTask({ active: false, name: null, state: 'idle' }) }
  async stopAndWait (_reason: string): Promise<void> { this.stopWaited += 1; this.active = false; this.stateRef.setTask({ active: false, name: null, state: 'idle' }) }
  async depositNow (): Promise<void> { this.deposited += 1 }
  async confirmResume (_taskId?: string): Promise<void> {}
  async discardPending (_reason: string): Promise<void> {}
  snapshot (): TaskSnapshot { return this.stateRef.snapshot().task }
  keepOnline (): boolean { return this.active }
  isActive (): boolean { return this.active }
}

export class FakeSession implements AutonomySessionClient {
  token = ''
  promptText = ''
  permissions: SessionPermission[] = []
  registered = 0
  removed = 0
  deleted = 0
  interrupted = 0
  waitResolve: (() => void) | null = null
  private readonly waitPromise = new Promise<void>(resolve => { this.waitResolve = resolve })
  async registerMcp (_name: string, _url: string, bearer: string): Promise<void> { this.token = bearer; this.registered += 1 }
  async removeMcp (_name: string): Promise<void> { this.removed += 1 }
  async createSession (_title: string, permissions: SessionPermission[]): Promise<string> { this.permissions = permissions; return 'sess-agentic' }
  async prompt (_sessionId: string, text: string): Promise<void> { this.promptText = text }
  async wait (_sessionId: string, _signal?: AbortSignal): Promise<void> { await this.waitPromise }
  async interrupt (_sessionId: string): Promise<void> { this.interrupted += 1 }
  async deleteSession (_sessionId: string): Promise<void> { this.deleted += 1 }
  async assistantText (_sessionId: string): Promise<string> { return 'done' }
  finish (): void { this.waitResolve?.() }
}

export function autonomyFixture (env: Record<string, string | undefined> = {}) {
  const config = makeConfig({}, {
    ...baseEnv(),
    AI_ENABLED: 'true',
    OPENCODE_PASSWORD: 'test-password',
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_MAX_TOOL_CALLS: '6',
    TASK_ENABLED: 'true',
    HTTP_CONTROL_ENABLED: 'true',
    ...env
  })
  const state = makeState(config)
  const tasks = new FakeTasks(state)
  const session = new FakeSession()
  const events = new EventBus(100)
  const auditEntries: unknown[] = []
  const audit = { append: (entry: unknown) => { auditEntries.push(entry) } } as unknown as AuditLogger
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
  return { config, state, tasks, session, events, auditEntries, service }
}

export type AgenticFixture = ReturnType<typeof autonomyFixture>

export function runIdOf (fixture: AgenticFixture): string {
  const match = /当前 run_id：([0-9a-f-]+)/.exec(fixture.session.promptText)
  if (!match?.[1]) throw new Error('run id missing from prompt')
  return match[1]
}

export async function callTool (
  fixture: AgenticFixture,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 1
): Promise<{ status: number, body: unknown, isError: boolean, text: string }> {
  const response = await fixture.service.handleMcpHttp(token, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  const body = response.body as { result?: { isError?: boolean, content?: Array<{ text?: string }> } } | null
  return {
    status: response.status,
    body,
    isError: body?.result?.isError === true,
    text: body?.result?.content?.[0]?.text ?? ''
  }
}

export async function startFixture (fixture: AgenticFixture, goal: string | null = null): Promise<{ token: string, runId: string }> {
  const result = await fixture.service.start(goal, 'Antifield')
  if (!result.ok) throw new Error(`autonomy start failed: ${result.code ?? 'unknown'}`)
  return { token: fixture.session.token, runId: runIdOf(fixture) }
}
