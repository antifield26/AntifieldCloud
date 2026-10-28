/**
 * mcbot AI 自主会话：显式启动、OpenCode 原生 MCP 工具、确定性策略与急停。
 *
 * 边界：
 * - 只有主人/面板显式启动；默认关闭。
 * - 模型只能调用 {start_task, stop_task, go_home, deposit, task_status, finish}。
 * - 所有工具参数、任务白名单、并发/预算/连接状态由本模块校验；模型不能执行任意命令。
 * - 不持久化；服务重启或会话结束即清理，不会自动恢复。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Bot } from 'mineflayer'
import type { AuditLogger } from '../audit.ts'
import type { Config } from '../config.ts'
import type { AutonomySessionClient, SessionPermission } from '../ai/session.ts'
import { OpenCodeSessionError } from '../ai/session.ts'
import type { EventBus } from '../events/bus.ts'
import type { Logger } from '../logger.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import type { AutonomySnapshot, AutonomyState, TaskName } from '../state.ts'
import type { RuntimeState } from '../state.ts'
import type { TaskController } from '../tasks/types.ts'
import { safeEqual } from '../http/auth.ts'
import {
  AUTONOMY_MCP_SERVER,
  AUTONOMY_PERMISSION_PREFIX,
  AUTONOMY_RAW_TOOLS,
  AUTONOMY_TASK_NAMES,
  AUTONOMY_TOOL_NAME_PREFIX,
  buildToolDefinitions,
  type AutonomyToolName,
  toolDisplayName
} from './tools.ts'

const FINISH_GRACE_MS = 5000
const MAX_REASON_CHARS = 120
const MAX_SUMMARY_CHARS = 200

export interface AutonomyStartResult {
  ok: boolean
  code?: string
  autonomy: AutonomySnapshot
}

interface ActiveRun {
  runId: string
  token: string
  goal: string
  startedAt: number
  deadline: number
  maxToolCalls: number
  state: AutonomyState
  active: boolean
  sessionId: string | null
  mcpRegistered: boolean
  toolCalls: number
  failures: number
  lastAction: string | null
  lastReason: string | null
  lastError: string | null
  lastDecisionAt: string | null
  finishRequested: boolean
  stopRequested: boolean
  abort: AbortController
  loop: Promise<void> | null
  finalizing: Promise<void> | null
}

export interface AutonomyServiceDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  audit: AuditLogger
  events: EventBus
  chatSender: ChatSender
  movement: MovementManager
  tasks: TaskController
  opencode: AutonomySessionClient
  getBot: () => Bot | null
}

interface McpHttpResult {
  status: number
  body: unknown
}

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: unknown
}

function nowIso (): string {
  return new Date().toISOString()
}

function sanitizeText (value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

function asRecord (value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isTaskName (value: string): value is TaskName {
  return (AUTONOMY_TASK_NAMES as string[]).includes(value)
}

function isToolName (value: string): value is AutonomyToolName {
  return (AUTONOMY_RAW_TOOLS as readonly string[]).includes(value)
}

function jsonRpcResult (id: string | number | null | undefined, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function jsonRpcError (id: string | number | null | undefined, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export class AutonomyService {
  private readonly deps: AutonomyServiceDeps
  private readonly logger: Logger
  private run: ActiveRun | null = null

  constructor (deps: AutonomyServiceDeps) {
    this.deps = deps
    this.logger = deps.logger
  }

  get enabled (): boolean {
    return this.deps.config.autonomyEnabled
  }

  isActive (): boolean {
    return this.run?.active === true
  }

  keepOnline (): boolean {
    return this.isActive()
  }

  snapshot (): AutonomySnapshot {
    const run = this.run
    const maxToolCalls = this.deps.config.autonomyMaxToolCalls
    if (!run) {
      return {
        enabled: this.enabled,
        active: false,
        state: 'idle',
        goal: null,
        startedAt: null,
        elapsedSec: 0,
        remainingSec: 0,
        toolCalls: 0,
        maxToolCalls,
        lastAction: null,
        lastReason: null,
        lastError: null,
        lastDecisionAt: null
      }
    }
    const now = Date.now()
    return {
      enabled: this.enabled,
      active: run.active,
      state: run.state,
      goal: run.goal,
      startedAt: new Date(run.startedAt).toISOString(),
      elapsedSec: Math.max(0, Math.floor((now - run.startedAt) / 1000)),
      remainingSec: Math.max(0, Math.floor((run.deadline - now) / 1000)),
      toolCalls: run.toolCalls,
      maxToolCalls: run.maxToolCalls,
      lastAction: run.lastAction,
      lastReason: run.lastReason,
      lastError: run.lastError,
      lastDecisionAt: run.lastDecisionAt
    }
  }

  private publish (): void {
    this.deps.state.setAutonomy(this.snapshot())
  }

  private emit (action: string, reason: string | null = null, error: string | null = null): void {
    this.deps.events.emit('autonomy', {
      action,
      state: this.snapshot().state,
      reason: reason ? sanitizeText(reason, MAX_REASON_CHARS) : null,
      error
    })
  }

  async start (goal: string | null, actor: string): Promise<AutonomyStartResult> {
    if (!this.enabled) return { ok: false, code: 'autonomy_disabled', autonomy: this.snapshot() }
    if (this.run?.active) return { ok: false, code: 'autonomy_busy', autonomy: this.snapshot() }
    if (!this.deps.config.aiEnabled) return { ok: false, code: 'autonomy_disabled', autonomy: this.snapshot() }
    const bot = this.deps.getBot()
    if (!bot?.entity) return { ok: false, code: 'autonomy_unavailable', autonomy: this.snapshot() }
    const task = this.deps.state.task
    if (task.pendingResume || task.active || task.queue.length > 0) {
      return { ok: false, code: 'autonomy_busy', autonomy: this.snapshot() }
    }
    const requested = goal === null ? '' : sanitizeText(goal, this.deps.config.autonomyGoalMaxChars)
    if (goal !== null && requested.length === 0) {
      return { ok: false, code: 'invalid_goal', autonomy: this.snapshot() }
    }
    const goalText = requested || '保持基地运转，并做当前最需要的一件事。'
    const startedAt = Date.now()
    const run: ActiveRun = {
      runId: randomUUID(),
      token: randomBytes(32).toString('hex'),
      goal: goalText,
      startedAt,
      deadline: startedAt + this.deps.config.autonomyMaxMinutes * 60_000,
      maxToolCalls: this.deps.config.autonomyMaxToolCalls,
      state: 'starting',
      active: true,
      sessionId: null,
      mcpRegistered: false,
      toolCalls: 0,
      failures: 0,
      lastAction: null,
      lastReason: null,
      lastError: null,
      lastDecisionAt: null,
      finishRequested: false,
      stopRequested: false,
      abort: new AbortController(),
      loop: null,
      finalizing: null
    }
    this.run = run
    this.publish()
    this.emit('start', goalText)
    this.deps.audit.append({
      event: 'autonomy.start',
      source: 'autonomy',
      actor,
      action: 'start',
      result: 'accepted',
      details: { goalChars: goalText.length, maxToolCalls: run.maxToolCalls }
    })
    try {
      await this.deps.opencode.removeMcp(AUTONOMY_MCP_SERVER).catch(() => undefined)
      await this.deps.opencode.registerMcp(AUTONOMY_MCP_SERVER, this.mcpUrl(), run.token)
      run.mcpRegistered = true
      if (run.stopRequested) return this.stoppedDuringStart(run)
      const permissions: SessionPermission[] = [
        { action: '*', resource: '*', effect: 'deny' },
        { action: AUTONOMY_PERMISSION_PREFIX, resource: '*', effect: 'allow' }
      ]
      run.sessionId = await this.deps.opencode.createSession(`mcbot-autonomy-${run.runId.slice(0, 8)}`, permissions)
      if (run.stopRequested) return this.stoppedDuringStart(run)
      run.state = 'running'
      this.publish()
      await this.deps.opencode.prompt(run.sessionId, this.buildPrompt(run))
      if (run.stopRequested) return this.stoppedDuringStart(run)
      run.loop = this.waitLoop(run)
      return { ok: true, autonomy: this.snapshot() }
    } catch (error) {
      await this.finalize(run, 'failed', this.errorCode(error))
      return { ok: false, code: this.errorCode(error), autonomy: this.snapshot() }
    }
  }

  private async stoppedDuringStart (run: ActiveRun): Promise<AutonomyStartResult> {
    if (run.sessionId) {
      await this.deps.opencode.deleteSession(run.sessionId).catch(() => undefined)
      run.sessionId = null
    }
    if (run.mcpRegistered) {
      await this.deps.opencode.removeMcp(AUTONOMY_MCP_SERVER).catch(() => undefined)
      run.mcpRegistered = false
    }
    await this.finalize(run, 'finished', null, 'stopped')
    return { ok: false, code: 'autonomy_stopped', autonomy: this.snapshot() }
  }

  async stop (reason: string): Promise<void> {
    const run = this.run
    if (!run || !run.active) return
    run.stopRequested = true
    await this.finalize(run, 'finished', null, reason)
  }

  interrupt (reason: string): void {
    void this.stop(reason).catch(error => {
      this.logger.warn('autonomy stop failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }

  async shutdown (): Promise<void> {
    const run = this.run
    if (!run) return
    run.stopRequested = true
    await this.finalize(run, 'finished', null, 'shutdown')
  }

  private mcpUrl (): string {
    const host = this.deps.config.httpHost === '0.0.0.0' || this.deps.config.httpHost === '::'
      ? '127.0.0.1'
      : this.deps.config.httpHost
    return `http://${host}:${this.deps.config.httpPort}/autonomy/mcp`
  }

  private buildPrompt (run: ActiveRun): string {
    const tools = AUTONOMY_RAW_TOOLS.map(name => `${AUTONOMY_TOOL_NAME_PREFIX}${name}`).join(', ')
    return [
      '你正在执行一次受限的 Minecraft 自主会话。你会看到一个工具列表；只能使用这些工具，不能调用其他工具。',
      `当前 run_id：${run.runId}`,
      `目标：${run.goal}`,
      `本次最多 ${run.maxToolCalls} 次工具调用，最多 ${this.deps.config.autonomyMaxMinutes} 分钟。`,
      '规则：',
      '1. 先判断当前状态；只有没有活动任务/排队任务时才能 start_task。',
      '2. 每次只调用一个工具，并把当前 run_id 原样放进 run_id 参数。',
      '3. 任务开始后，等待/查询 task_status，不要重复启动同一任务；失败时最多调整一次。',
      '4. 目标完成、无法继续或需要结束会话时调用 finish。',
      '5. 不要尝试聊天、执行命令、生成坐标/玩家名，或使用未列出的工具。',
      `可用工具（完整名称以工具列表为准）：${tools}`
    ].join('\n')
  }

  private async waitLoop (run: ActiveRun): Promise<void> {
    try {
      await this.deps.opencode.wait(run.sessionId ?? '', run.abort.signal)
      if (run.finishRequested) {
        await this.sleep(200)
      }
      await this.finalize(run, 'finished', null)
    } catch (error) {
      if (run.stopRequested || run.abort.signal.aborted) {
        await this.finalize(run, 'finished', null)
        return
      }
      await this.finalize(run, 'failed', this.errorCode(error))
    }
  }

  private async finalize (
    run: ActiveRun,
    outcome: 'finished' | 'failed',
    errorCode: string | null,
    reason: string | null = null
  ): Promise<void> {
    if (run.finalizing) return run.finalizing
    run.finalizing = (async () => {
      run.state = 'stopping'
      run.abort.abort()
      this.publish()
      try {
        if (run.sessionId) {
          await this.deps.opencode.interrupt(run.sessionId).catch(() => undefined)
        }
      } catch { /* best effort */ }
      try {
        if (this.deps.tasks.isActive()) {
          await this.deps.tasks.stopAndWait('autonomy_end')
        }
      } catch (error) {
        this.logger.warn('autonomy task cleanup failed', { error: error instanceof Error ? error.message : String(error) })
      }
      try {
        if (run.sessionId) await this.deps.opencode.deleteSession(run.sessionId).catch(() => undefined)
        if (run.mcpRegistered) await this.deps.opencode.removeMcp(AUTONOMY_MCP_SERVER).catch(() => undefined)
      } finally {
        run.state = outcome
        run.active = false
        run.lastError = errorCode
        run.stopRequested = true
        this.publish()
        this.deps.audit.append({
          event: 'autonomy.end',
          source: 'autonomy',
          actor: 'lofii',
          action: outcome,
          result: outcome === 'finished' ? 'completed' : 'failed',
          details: {
            reason: reason ? sanitizeText(reason, MAX_REASON_CHARS) : null,
            error: errorCode,
            toolCalls: run.toolCalls,
            failures: run.failures,
            elapsedSec: Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000))
          }
        })
        this.emit(outcome, reason, errorCode)
      }
    })()
    return run.finalizing
  }

  private sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private errorCode (error: unknown): string {
    if (error instanceof OpenCodeSessionError) {
      if (error.kind === 'timeout') return 'autonomy_timeout'
      if (error.kind === 'aborted') return 'autonomy_aborted'
      if (error.kind === 'invalid') return 'autonomy_invalid_response'
      if (error.status === 401 || error.status === 403) return 'autonomy_auth_failed'
      if (error.status === 400) return 'autonomy_permissions_rejected'
      return 'autonomy_unavailable'
    }
    return 'autonomy_failed'
  }

  /**
   * HTTP MCP 入口：只接受当前 run 的 Bearer token；JSON-RPC 响应体保持最小。
   * 401/400 由 HTTP 层转为 JSON；成功时返回 JSON-RPC response 或 null（notification）。
   */
  async handleMcpHttp (bearer: string, body: unknown): Promise<McpHttpResult> {
    if (!this.enabled) return { status: 404, body: { error: 'autonomy_disabled' } }
    const run = this.run
    if (!run || !run.active || !safeEqual(bearer, run.token)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    const requests = Array.isArray(body) ? body : [body]
    const responses: unknown[] = []
    for (const item of requests) {
      const response = await this.handleMcpMessage(run, item)
      if (response !== null) responses.push(response)
    }
    if (responses.length === 0) return { status: 202, body: null }
    return { status: 200, body: Array.isArray(body) ? responses : responses[0] }
  }

  private async handleMcpMessage (run: ActiveRun, value: unknown): Promise<unknown | null> {
    const message = asRecord(value) as JsonRpcRequest | null
    if (!message || (typeof message.method !== 'string' && message.id !== undefined)) {
      return jsonRpcError(message?.id, -32600, 'invalid request')
    }
    const method = typeof message.method === 'string' ? message.method : ''
    const id = message.id
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
    if (method === 'initialize') {
      return jsonRpcResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: AUTONOMY_MCP_SERVER, version: this.deps.config.version }
      })
    }
    if (method === 'ping') return jsonRpcResult(id, {})
    if (method === 'tools/list') return jsonRpcResult(id, { tools: buildToolDefinitions() })
    if (method === 'resources/list') return jsonRpcResult(id, { resources: [] })
    if (method === 'prompts/list') return jsonRpcResult(id, { prompts: [] })
    if (method === 'tools/call') {
      const params = asRecord(message.params)
      const name = typeof params?.name === 'string' ? params.name : ''
      const args = asRecord(params?.arguments) ?? {}
      const result = await this.callTool(run, name, args)
      return jsonRpcResult(id, result)
    }
    return jsonRpcError(id, -32601, 'method not found')
  }

  private async callTool (
    run: ActiveRun,
    rawName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: 'text', text: string }>, isError: boolean }> {
    const name = toolDisplayName(rawName)
    const fail = (error: string, message: string): { content: Array<{ type: 'text', text: string }>, isError: boolean } => {
      run.failures += 1
      run.lastError = error
      this.publish()
      this.deps.audit.append({
        event: 'autonomy.reject',
        source: 'autonomy',
        actor: 'lofii',
        action: name || 'unknown',
        result: 'denied',
        details: { error, reason: sanitizeText(String(args.reason ?? ''), MAX_REASON_CHARS) }
      })
      this.emit('reject', typeof args.reason === 'string' ? args.reason : null, error)
      if (run.failures >= this.deps.config.autonomyMaxFailures) {
        run.stopRequested = true
        setImmediate(() => { void this.stop('too_many_failures') })
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error, message }) }], isError: true }
    }
    if (!isToolName(name)) return fail('tool_not_allowed', 'tool is not allowed')
    if (!run.active || run.stopRequested) return fail('autonomy_stopped', 'autonomy session is not active')
    if (Date.now() >= run.deadline) {
      run.stopRequested = true
      setImmediate(() => { void this.stop('deadline') })
      return fail('autonomy_deadline', 'autonomy time budget exhausted')
    }
    if (run.toolCalls >= run.maxToolCalls) return fail('tool_budget_exhausted', 'tool budget exhausted')
    if (typeof args.run_id !== 'string' || !safeEqual(args.run_id, run.runId)) {
      return fail('run_id_mismatch', 'run_id does not match this session')
    }
    const reason = typeof args.reason === 'string' ? sanitizeText(args.reason, MAX_REASON_CHARS) : ''
    if (name !== 'task_status' && name !== 'finish' && reason.length === 0) {
      return fail('reason_required', 'reason is required')
    }
    run.toolCalls += 1
    run.lastAction = name
    run.lastReason = reason || null
    run.lastDecisionAt = nowIso()
    this.publish()

    try {
      switch (name) {
        case 'start_task': {
          const taskName = typeof args.task === 'string' ? args.task : ''
          if (!isTaskName(taskName)) return fail('invalid_task', 'task is not allowed')
          if (!this.deps.config.autonomyTasks.includes(taskName)) return fail('task_not_allowed', 'task is not enabled for autonomy')
          const state = this.deps.state.task
          if (state.pendingResume) return fail('resume_pending', 'a pending task blocks autonomy')
          if (state.active || state.queue.length > 0) return fail('task_active', 'a task is already active or queued')
          const bot = this.deps.getBot()
          if (bot?.health !== undefined && bot.health !== null && bot.health <= this.deps.config.defenseHealthThreshold) {
            return fail('low_health', 'health is too low to start a task')
          }
          if (bot?.food !== undefined && bot.food !== null && bot.food <= this.deps.config.defenseFoodThreshold) {
            return fail('low_food', 'food is too low to start a task')
          }
          const result = await this.deps.tasks.start(taskName, 'autonomy', 'autonomy')
          if (result.status !== 'started') {
            return fail('task_start_failed', `task was not started (${result.status})`)
          }
          this.auditTool(name, taskName, reason)
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, task: taskName, state: this.deps.state.task }) }],
            isError: false
          }
        }
        case 'stop_task': {
          if (!this.deps.state.task.active) return fail('no_active_task', 'no active task')
          this.deps.tasks.requestStop('autonomy')
          this.auditTool(name, 'task', reason)
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'stop_task' }) }], isError: false }
        }
        case 'go_home': {
          if (this.deps.state.task.active || this.deps.state.task.pendingResume) {
            return fail('task_active', 'stop the active task before going home')
          }
          await this.deps.movement.home()
          this.auditTool(name, 'home', reason)
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'go_home' }) }], isError: false }
        }
        case 'deposit': {
          if (this.deps.state.task.active || this.deps.state.task.pendingResume) {
            return fail('task_active', 'stop the active task before depositing')
          }
          await this.deps.tasks.depositNow()
          this.auditTool(name, 'deposit', reason)
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'deposit' }) }], isError: false }
        }
        case 'task_status': {
          this.auditTool(name, 'status', reason)
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, task: this.deps.state.task }) }],
            isError: false
          }
        }
        case 'finish': {
          const summary = sanitizeText(String(args.summary ?? ''), MAX_SUMMARY_CHARS)
          run.finishRequested = true
          if (run.toolCalls >= run.maxToolCalls) run.stopRequested = true
          this.auditTool(name, summary || 'summary', reason || 'finish')
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'finish', summary }) }],
            isError: false
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail('tool_execution_failed', sanitizeText(message, 160))
    }
    return fail('tool_not_allowed', 'tool is not allowed')
  }

  private auditTool (name: string, action: string, reason: string): void {
    this.deps.audit.append({
      event: 'autonomy.tool',
      source: 'autonomy',
      actor: 'lofii',
      action: name,
      result: 'accepted',
      details: { target: sanitizeText(action, 160), reason: sanitizeText(reason, MAX_REASON_CHARS) }
    })
    this.emit('tool', reason)
  }
}
