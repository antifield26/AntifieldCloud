// mcbot 展示层辅助：中文标签、任务进度映射与事件纯文本摘要。
// 安全边界：事件 data 来自 mcbot，一律视为不可信 unknown，只读取已知字段并输出纯文本；
// 不拼接 HTML、不展示 Token/密码/URL/内部路径，未知字段不渲染。

import type {
  McbotAutonomySnapshot,
  McbotAutonomyState,
  McbotBotState,
  McbotEvent,
  McbotEventType,
  McbotHistoryAlert,
  McbotMoveAction,
  McbotQueuedTask,
  McbotSnapshot,
  McbotStatus,
  McbotTask,
  McbotTaskName,
  McbotTaskProgress,
  McbotTaskState,
} from '../api/types'

/** 10 种可启动任务的中文名与固定顺序（下拉框顺序）。 */
export const MCBOT_TASK_NAME_LABELS: Record<McbotTaskName, string> = {
  fishing: '钓鱼',
  farming: '种田',
  woodcutting: '砍树',
  mining: '挖矿',
  forest: '砍天然林',
  sleep: '睡觉',
  patrol: '巡逻',
  guard: '守卫',
  escort: '护送',
  explore: '探索',
  clearing: '清理安全区',
}

export const MCBOT_TASK_NAMES: readonly McbotTaskName[] = [
  'fishing',
  'farming',
  'woodcutting',
  'mining',
  'forest',
  'sleep',
  'patrol',
  'guard',
  'escort',
  'explore',
  'clearing',
]

export const MCBOT_TASK_STATE_LABELS: Record<McbotTaskState, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '进行中',
  depositing: '存物中',
  recovering: '恢复中',
  stopping: '停止中',
  defending: '防御中',
  pending_resume: '待恢复',
}

export const MCBOT_BOT_STATE_LABELS: Record<McbotBotState, string> = {
  idle: '空闲（动态下线）',
  connecting: '连接中',
  connected: '已连接',
  backoff: '重连等待',
  cooldown: '冷却中',
}

export const MCBOT_MOVE_ACTION_LABELS: Record<McbotMoveAction, string> = {
  home: '回家',
  come: '过来',
  follow: '跟随',
  stop: '停下',
}

export const MCBOT_EVENT_TYPE_LABELS: Record<string, string> = {
  hello: '握手',
  presence: '状态',
  task: '任务',
  chat: '聊天',
  movement: '移动',
  alert: '告警',
  autonomy: '自主',
}

/** AI 自主模式状态的中文名（未知状态由调用方兜底显示原值）。 */
export const MCBOT_AUTONOMY_STATE_LABELS: Record<McbotAutonomyState, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  finished: '已结束',
  failed: '失败',
}

/** 只读属性查表：避免 `__proto__`/`constructor` 等键命中原型链。 */
function ownLabel(map: object, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null
  const value = (map as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

export function mcbotAutonomyStateLabel(state: string | null | undefined): string {
  if (!state) return '—'
  return ownLabel(MCBOT_AUTONOMY_STATE_LABELS, state) ?? state
}

/** 事件流筛选：全部 / 聊天 / 任务 / 状态 / 移动 / 告警 / 自主。 */
export const MCBOT_EVENT_FILTERS: readonly { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'chat', label: '聊天' },
  { id: 'task', label: '任务' },
  { id: 'presence', label: '状态' },
  { id: 'movement', label: '移动' },
  { id: 'alert', label: '告警' },
  { id: 'autonomy', label: '自主' },
]

/** 任务事件 action 的中文名（只映射已知值，未知值按原样展示）。 */
const TASK_ACTION_LABELS: Record<string, string> = {
  started: '已开始',
  progress: '进度更新',
  depositing: '开始存物',
  recovering: '开始恢复',
  stopping: '停止中',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
  resume_required: '需要恢复',
  resumed: '已恢复',
  interrupted: '已中断',
  queued: '已排队',
  queue_started: '开始队列任务',
  queue_cleared: '队列已清空',
  defending: '防御中',
  alert: '告警',
  no_active_task: '没有进行中的任务',
}

/** 移动事件 status 的中文名。 */
const MOVEMENT_STATUS_LABELS: Record<string, string> = {
  started: '已开始',
  completed: '已完成',
  failed: '失败',
}

/** mcbot 历史告警 type 的中文名（兼容 mcbot_ 前缀）。 */
export const MCBOT_ALERT_TYPE_LABELS: Record<string, string> = {
  low_health: '血量过低',
  task_failed: '任务失败',
  disconnected: '断线',
  chest_full: '箱子已满',
  defense_retreat: '防御撤退',
}

/** 服务端 /api/mcbot/status 的 error 字段是稳定错误码，展示时转为中文。 */
const MCBOT_ERROR_LABELS: Record<string, string> = {
  mcbot_disabled: 'mcbot 对接未启用',
  mcbot_control_disabled: 'mcbot 控制接口未启用',
  mcbot_unavailable: 'mcbot 服务不可达',
  mcbot_auth_failed: 'mcbot 鉴权失败',
  mcbot_upstream_error: 'mcbot 上游响应异常',
  mcbot_rate_limited: 'mcbot 请求过于频繁',
  mcbot_resume_pending: 'mcbot 有待恢复任务',
  mcbot_resume_failed: 'mcbot 任务恢复失败',
  mcbot_queue_full: 'mcbot 任务队列已满',
  mcbot_no_active_task: 'mcbot 没有进行中的任务',
  mcbot_no_pending_task: 'mcbot 没有待恢复任务',
  mcbot_task_disabled: 'mcbot 任务功能已关闭',
  mcbot_history_disabled: 'mcbot 历史功能已关闭',
  mcbot_task_active: 'mcbot 任务进行中',
  mcbot_target_not_online: '目标玩家不在线',
  mcbot_not_connected: 'mcbot 未连接 Minecraft',
  mcbot_invalid_request: 'mcbot 请求参数不合法',
  mcbot_cursor_failed: 'mcbot 告警游标写入失败',
  mcbot_not_found: 'mcbot 接口不可用',
  mcbot_autonomy_disabled: 'mcbot 自主模式未启用',
  mcbot_autonomy_busy: 'mcbot 自主模式正在运行',
  mcbot_autonomy_unavailable: 'mcbot 自主模式不可用',
  mcbot_autonomy_failed: 'mcbot 自主模式启动失败',
}

/** 把状态快照里的稳定错误码转成中文文案（未知码原样展示）。 */
export function mcbotErrorLabel(code: string | null | undefined): string {
  if (!code) return '未知错误'
  return ownLabel(MCBOT_ERROR_LABELS, code) ?? code
}

export const MCBOT_SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  error: '错误',
  warning: '警告',
  warn: '警告',
  info: '提示',
  ok: '正常',
}

/** 任务进度字段到中文标签的映射；未使用的计数不展示。 */
const TASK_PROGRESS_LABELS: Record<McbotTaskName, readonly { key: keyof McbotTaskProgress; label: string }[]> = {
  fishing: [{ key: 'fishCaught', label: '钓到鱼' }],
  farming: [
    { key: 'wheatHarvested', label: '收获小麦' },
    { key: 'planted', label: '补种作物' },
    { key: 'deposited', label: '存入箱子' },
  ],
  woodcutting: [
    { key: 'treesChopped', label: '砍树' },
    { key: 'logsChopped', label: '原木' },
    { key: 'saplingsPlanted', label: '补种树苗' },
    { key: 'deposited', label: '存入箱子' },
  ],
  mining: [
    { key: 'oresMined', label: '矿石' },
    { key: 'coalMined', label: '煤炭' },
    { key: 'ironMined', label: '铁' },
    { key: 'copperMined', label: '铜' },
    { key: 'deposited', label: '存入箱子' },
  ],
  forest: [
    { key: 'forestTreesChopped', label: '砍天然树' },
    { key: 'naturalLogsChopped', label: '天然原木' },
    { key: 'naturalSaplingsPlanted', label: '补种树苗' },
    { key: 'deposited', label: '存入箱子' },
  ],
  sleep: [
    { key: 'sleepVotes', label: '睡觉投票' },
    { key: 'nightSkipped', label: '跳过夜晚' },
  ],
  patrol: [
    { key: 'patrolWaypoints', label: '巡逻点' },
    { key: 'patrolDistance', label: '巡逻距离' },
  ],
  guard: [{ key: 'guardKills', label: '击杀怪物' }],
  escort: [{ key: 'escortDistance', label: '护送距离' }],
  explore: [{ key: 'exploreWaypoints', label: '探索点' }],
  clearing: [{ key: 'mobsKilled', label: '清理怪物' }],
}

export function mcbotTaskNameLabel(name: string | null | undefined): string {
  if (!name) return '—'
  return ownLabel(MCBOT_TASK_NAME_LABELS, name) ?? name
}

export function mcbotTaskStateLabel(state: string | null | undefined): string {
  if (!state) return '—'
  return ownLabel(MCBOT_TASK_STATE_LABELS, state) ?? state
}

export function mcbotBotStateLabel(state: string | null | undefined): string {
  if (!state) return '—'
  return ownLabel(MCBOT_BOT_STATE_LABELS, state) ?? state
}

export function mcbotEventTypeLabel(type: McbotEventType | string): string {
  return ownLabel(MCBOT_EVENT_TYPE_LABELS, type) ?? (type || '其他')
}

export function mcbotAlertTypeLabel(type: string | null | undefined): string {
  if (!type) return '—'
  const normalized = type.startsWith('mcbot_') ? type.slice('mcbot_'.length) : type
  return ownLabel(MCBOT_ALERT_TYPE_LABELS, normalized) ?? type
}

export function mcbotSeverityLabel(severity: string | null | undefined): string {
  if (!severity) return '—'
  return ownLabel(MCBOT_SEVERITY_LABELS, severity.toLowerCase()) ?? severity
}

/* ---------- 事件 data 安全读取 ---------- */

const MAX_EVENT_TEXT = 2000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed.slice(0, MAX_EVENT_TEXT) : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asLines(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const lines = value
    .map((line) => asText(line))
    .filter((line): line is string => Boolean(line))
  return lines.length > 0 ? lines.join('\n').slice(0, MAX_EVENT_TEXT) : null
}

function actionLabel(value: string | null): string {
  if (!value) return '状态更新'
  return ownLabel(TASK_ACTION_LABELS, value) ?? value
}

/** 事件渲染视图：聊天正文与结构化摘要互斥，均为纯文本。 */
export interface McbotEventView {
  typeLabel: string
  /** 聊天事件正文；非聊天事件或缺失正文时为 null。 */
  chatText: string | null
  /** 非聊天事件的结构化摘要；聊天事件缺失正文时给出降级文案。 */
  summary: string
}

function describeChat(data: Record<string, unknown> | null): string {
  if (!data) return ''
  if (data.direction === 'in') {
    const username = asText(data.username)
    const message = asText(data.message)
    if (!message) return ''
    return username ? `${username}：${message}` : message
  }
  const text = asText(data.text) ?? asLines(data.lines)
  return text ? `mcbot：${text}` : ''
}

function describeStructuredEvent(type: string, data: Record<string, unknown> | null): string {
  if (type === 'task') {
    const action = asText(data?.action)
    const task = asRecord(data?.task)
    const name = asText(task?.name)
    const state = asText(task?.state)
    const parts = [`任务${actionLabel(action)}`]
    if (name) parts.push(mcbotTaskNameLabel(name))
    if (state) parts.push(mcbotTaskStateLabel(state))
    return parts.join(' · ')
  }
  if (type === 'presence') {
    const state = asText(data?.state)
    const otherPlayers = asCount(data?.otherPlayers)
    const parts = [state ? `连接状态：${mcbotBotStateLabel(state)}` : '连接状态更新']
    if (otherPlayers !== null) parts.push(`其他玩家 ${otherPlayers}`)
    const taskName = asText(data?.taskName)
    const taskState = asText(data?.taskState)
    if (taskName) parts.push(`任务 ${mcbotTaskNameLabel(taskName)}`)
    if (taskState) parts.push(mcbotTaskStateLabel(taskState))
    return parts.join(' · ')
  }
  if (type === 'movement') {
    const action = asText(data?.action)
    const target = asText(data?.target)
    const status = asText(data?.status)
    const parts = [`移动：${action ? (ownLabel(MCBOT_MOVE_ACTION_LABELS, action) ?? action) : '未知动作'}`]
    if (target) parts.push(`目标 ${target}`)
    if (status) parts.push(ownLabel(MOVEMENT_STATUS_LABELS, status) ?? status)
    const error = asText(data?.error)
    if (error) parts.push(`错误：${error}`)
    return parts.join(' · ')
  }
  if (type === 'autonomy') {
    const state = asText(data?.state)
    const action = asText(data?.action)
    const reason = asText(data?.reason)
    const parts = ['自主模式']
    if (state) parts.push(mcbotAutonomyStateLabel(state))
    if (action) parts.push(action)
    if (reason) parts.push(reason)
    return parts.join(' · ')
  }
  if (type === 'alert') {
    const alertType = asText(data?.type)
    const severity = asText(data?.severity)
    const message = asText(data?.message)
    const head = [alertType ? mcbotAlertTypeLabel(alertType) : '告警', severity ? mcbotSeverityLabel(severity) : null]
      .filter((part): part is string => Boolean(part))
      .join(' · ')
    return message ? `${head}：${message}` : head
  }
  if (type === 'hello') return '握手事件（连接建立快照）'
  return `${mcbotEventTypeLabel(type)}事件`
}

/** 把事件转换为可安全渲染的纯文本视图；聊天正文只在 chat 事件下读取。 */
export function describeLofiiEvent(event: McbotEvent): McbotEventView {
  const typeLabel = mcbotEventTypeLabel(event.type)
  const data = asRecord(event.data)
  if (event.type === 'chat') {
    const chatText = describeChat(data)
    return { typeLabel, chatText: chatText || null, summary: chatText ? '' : '聊天事件（无正文）' }
  }
  return { typeLabel, chatText: null, summary: describeStructuredEvent(event.type, data) }
}

/* ---------- 状态快照容错 ---------- */

/**
 * 自主模式快照容错：旧服务端缺失（undefined/null）返回 null；字段类型漂移时补安全默认值，
 * 未知 state 保留原字符串供 label 兜底。数值只接受有限非负数。
 */
export function safeMcbotAutonomy(value: unknown): McbotAutonomySnapshot | null {
  const raw = asRecord(value)
  if (!raw) return null
  const text = (field: unknown): string | null => {
    const parsed = asText(field)
    return parsed ? parsed.slice(0, 300) : null
  }
  const count = (field: unknown): number => {
    const parsed = asCount(field)
    return parsed !== null && parsed >= 0 ? Math.floor(parsed) : 0
  }
  return {
    enabled: raw.enabled === true,
    active: raw.active === true,
    state: (asText(raw.state) ?? 'idle') as McbotAutonomyState,
    goal: text(raw.goal)?.slice(0, 200) ?? null,
    startedAt: text(raw.startedAt),
    elapsedSec: count(raw.elapsedSec),
    remainingSec: count(raw.remainingSec),
    toolCalls: count(raw.toolCalls),
    maxToolCalls: count(raw.maxToolCalls),
    lastAction: text(raw.lastAction),
    lastReason: text(raw.lastReason),
    lastError: text(raw.lastError),
    lastDecisionAt: text(raw.lastDecisionAt),
  }
}

/** 空任务进度：快照缺段时用于稳定渲染，不伪造实际进度。 */
const EMPTY_TASK_PROGRESS: McbotTaskProgress = {
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
  exploreWaypoints: 0,
}

/**
 * 把上游 `/status` 快照规范化为可渲染结构：文档承诺“前端容忍缺失字段”，
 * 因此嵌套段缺失/类型漂移时填入安全默认值，避免整页 TypeError。
 */
export function safeLofiiStatus(value: unknown): McbotStatus | null {
  const raw = asRecord(value)
  if (!raw) return null
  const minecraft = asRecord(raw.minecraft) ?? {}
  const player = asRecord(raw.player) ?? {}
  const server = asRecord(raw.server) ?? {}
  const presence = asRecord(raw.presence) ?? {}
  const ai = asRecord(raw.ai) ?? {}
  const memory = asRecord(raw.memory) ?? {}
  const task = asRecord(raw.task) ?? {}
  const survival = asRecord(raw.survival) ?? {}
  const admin = asRecord(raw.admin) ?? {}
  const position = asRecord(player.position)
  const lastDisconnect = asRecord(minecraft.lastDisconnect)
  const tps = asRecord(admin.tps) ?? {}
  const online = asRecord(admin.online) ?? {}
  const whitelist = asRecord(admin.whitelist) ?? {}
  const time = asRecord(admin.time) ?? {}
  const backup = asRecord(admin.backup) ?? {}
  const progress = asRecord(task.progress)
  const pendingResume = asRecord(task.pendingResume)

  const readProgress = (source: Record<string, unknown> | null): McbotTaskProgress => {
    const result = { ...EMPTY_TASK_PROGRESS }
    for (const key of Object.keys(result) as (keyof McbotTaskProgress)[]) {
      const count = asCount(source?.[key])
      if (count !== null) result[key] = count
    }
    return result
  }

  return {
    version: asText(raw.version) ?? '',
    uptimeSec: asCount(raw.uptimeSec) ?? 0,
    state: (asText(raw.state) ?? 'idle') as McbotBotState,
    minecraft: {
      connected: minecraft.connected === true,
      username: asText(minecraft.username) ?? '',
      host: asText(minecraft.host) ?? '',
      port: asCount(minecraft.port) ?? 0,
      version: asText(minecraft.version) ?? '',
      reconnects: asCount(minecraft.reconnects) ?? 0,
      lastDisconnect: lastDisconnect
        ? {
            at: asText(lastDisconnect.at) ?? '',
            reason: asText(lastDisconnect.reason) ?? '',
          }
        : null,
    },
    player: {
      dimension: asText(player.dimension),
      position:
        position && asCount(position.x) !== null && asCount(position.y) !== null && asCount(position.z) !== null
          ? { x: asCount(position.x)!, y: asCount(position.y)!, z: asCount(position.z)! }
          : null,
      health: asCount(player.health),
      food: asCount(player.food),
    },
    server: {
      reachable: server.reachable === true,
      online: asCount(server.online) ?? 0,
      max: asCount(server.max) ?? 0,
      versionName: asText(server.versionName),
      motd: asText(server.motd),
      latencyMs: asCount(server.latencyMs),
      lastPingAt: asText(server.lastPingAt),
    },
    presence: {
      enabled: presence.enabled === true,
      mode:
        presence.mode === 'always' || presence.mode === 'off'
          ? presence.mode
          : 'auto',
      modeSource:
        presence.modeSource === 'env' || presence.modeSource === 'persisted'
          ? presence.modeSource
          : 'default',
      modeUpdatedAt: asText(presence.modeUpdatedAt),
      pollMs: asCount(presence.pollMs) ?? 0,
      graceMs: asCount(presence.graceMs) ?? 0,
      checkMs: asCount(presence.checkMs) ?? 0,
      otherPlayers: asCount(presence.otherPlayers) ?? 0,
      lastDecision: asText(presence.lastDecision) ?? '',
    },
    ai: {
      enabled: ai.enabled === true,
      provider: asText(ai.provider) ?? '',
      model: asText(ai.model) ?? '',
      inFlight: asCount(ai.inFlight) ?? 0,
      queued: asCount(ai.queued) ?? 0,
      failures: asCount(ai.failures) ?? 0,
      lastLatencyMs: asCount(ai.lastLatencyMs),
      lastError: asText(ai.lastError),
    },
    memory: {
      players: asCount(memory.players) ?? 0,
      turns: asCount(memory.turns) ?? 0,
    },
    task: {
      enabled: task.enabled === true,
      active: task.active === true,
      name: asText(task.name) as McbotTaskName | null,
      state: (asText(task.state) ?? 'idle') as McbotTaskState,
      startedAt: asText(task.startedAt),
      elapsedSec: asCount(task.elapsedSec) ?? 0,
      progress: readProgress(progress),
      failures: asCount(task.failures) ?? 0,
      lastError: asText(task.lastError),
      pendingResume:
        pendingResume && asText(pendingResume.taskId)
          ? {
              taskId: asText(pendingResume.taskId)!,
              name: (asText(pendingResume.name) ?? 'idle') as McbotTaskName,
              startedAt: asText(pendingResume.startedAt) ?? '',
              elapsedSec: asCount(pendingResume.elapsedSec) ?? 0,
              progress: readProgress(asRecord(pendingResume.progress)),
              expiresAt: asText(pendingResume.expiresAt) ?? '',
            }
          : null,
      queue: Array.isArray(task.queue)
        ? task.queue
            .map((item): McbotQueuedTask | null => {
              const queueItem = asRecord(item)
              const taskId = asText(queueItem?.taskId)
              if (!queueItem || !taskId) return null
              return {
                taskId,
                name: (asText(queueItem.name) ?? 'idle') as McbotTaskName,
                requestedBy: asText(queueItem.requestedBy) ?? '',
                requestedAt: asText(queueItem.requestedAt) ?? '',
              }
            })
            .filter((item): item is McbotQueuedTask => item !== null)
        : [],
    },
    survival: {
      enabled: survival.enabled === true,
      lastRunAt: asText(survival.lastRunAt),
      lastAction: asText(survival.lastAction),
      lastError: asText(survival.lastError),
    },
    admin: {
      enabled: admin.enabled === true,
      rcon: admin.rcon === true,
      updatedAt: asText(admin.updatedAt),
      lastError: asText(admin.lastError),
      tps: {
        one: asCount(tps.one),
        five: asCount(tps.five),
        fifteen: asCount(tps.fifteen),
      },
      online: {
        count: asCount(online.count),
        max: asCount(online.max),
        players: Array.isArray(online.players)
          ? online.players.filter((name): name is string => typeof name === 'string')
          : [],
      },
      whitelist: {
        count: asCount(whitelist.count),
        names: Array.isArray(whitelist.names)
          ? whitelist.names.filter((name): name is string => typeof name === 'string')
          : [],
      },
      time: {
        ticks: asCount(time.ticks),
        label: asText(time.label),
      },
      backup: { status: asText(backup.status) ?? 'unknown' },
    },
  }
}

/* ---------- 任务进度 ---------- */

export interface McbotProgressRow {
  label: string
  value: string
}

/** 按任务类型提取非零进度计数；全部为 0 时返回空数组（UI 显示暂无进度）。 */
export function mcbotTaskProgressRows(task: McbotTask | null | undefined): McbotProgressRow[] {
  if (!task || !task.progress) return []
  const fields =
    task.name && Object.prototype.hasOwnProperty.call(TASK_PROGRESS_LABELS, task.name)
      ? TASK_PROGRESS_LABELS[task.name]
      : null
  if (!fields) return []
  const rows: McbotProgressRow[] = []
  for (const field of fields) {
    const raw = task.progress[field.key]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    if (value <= 0) continue
    rows.push({
      label: field.label,
      value: field.key === 'patrolDistance' || field.key === 'escortDistance' ? `${value} 格` : String(value),
    })
  }
  if (task.progress.mobsKilled > 0 && !rows.some((row) => row.label === '击杀怪物')) {
    rows.push({ label: '击杀怪物', value: String(task.progress.mobsKilled) })
  }
  return rows
}

/* ---------- mcbot 快照派生 ---------- */

/**
 * 在线玩家列表：来自 admin.online.players，排除 mcbot 自己并去重；
 * 用于“过来/跟随”目标选择。列表缺失或 RCON 不可用时返回空数组。
 */
export function mcbotOnlinePlayers(status: McbotStatus | null | undefined): string[] {
  const players = status?.admin?.online?.players
  if (!Array.isArray(players)) return []
  const self = (status?.minecraft?.username ?? 'mcbot').trim().toLowerCase()
  const seen = new Set<string>()
  const result: string[] = []
  for (const player of players) {
    if (typeof player !== 'string') continue
    const name = player.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (key === self || seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

/**
 * 事件流是否可用：优先使用服务端下发的 eventsSupported；
 * 旧服务端没有该字段时按 contractVersion/是否有事件回退判断。
 */
export function mcbotEventsSupported(snapshot: McbotSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  if (typeof snapshot.eventsSupported === 'boolean') return snapshot.eventsSupported
  // 旧服务端可能完全没有这些字段：undefined 不能当作“有契约版本”。
  return typeof snapshot.contractVersion === 'number' || (Array.isArray(snapshot.events) && snapshot.events.length > 0)
}

/** 历史告警行的展示文案（纯文本，不含 details 任意字段）。 */
export function mcbotHistoryAlertText(alert: McbotHistoryAlert): string {
  const head = `${mcbotAlertTypeLabel(alert.type)} · ${mcbotSeverityLabel(alert.severity)}`
  return alert.message ? `${head}：${alert.message}` : head
}
