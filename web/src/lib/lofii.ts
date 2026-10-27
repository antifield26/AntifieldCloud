// Lofii 展示层辅助：中文标签、任务进度映射与事件纯文本摘要。
// 安全边界：事件 data 来自 Lofii，一律视为不可信 unknown，只读取已知字段并输出纯文本；
// 不拼接 HTML、不展示 Token/密码/URL/内部路径，未知字段不渲染。

import type {
  LofiiBotState,
  LofiiEvent,
  LofiiEventType,
  LofiiHistoryAlert,
  LofiiMoveAction,
  LofiiSnapshot,
  LofiiStatus,
  LofiiTask,
  LofiiTaskName,
  LofiiTaskProgress,
  LofiiTaskState,
} from '../api/types'

/** 7 种可启动任务的中文名与固定顺序（下拉框顺序）。 */
export const LOFII_TASK_NAME_LABELS: Record<LofiiTaskName, string> = {
  fishing: '钓鱼',
  farming: '种田',
  woodcutting: '砍树',
  mining: '挖矿',
  forest: '砍天然林',
  sleep: '睡觉',
  patrol: '巡逻',
}

export const LOFII_TASK_NAMES: readonly LofiiTaskName[] = [
  'fishing',
  'farming',
  'woodcutting',
  'mining',
  'forest',
  'sleep',
  'patrol',
]

export const LOFII_TASK_STATE_LABELS: Record<LofiiTaskState, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '进行中',
  depositing: '存物中',
  recovering: '恢复中',
  stopping: '停止中',
  defending: '防御中',
  pending_resume: '待恢复',
}

export const LOFII_BOT_STATE_LABELS: Record<LofiiBotState, string> = {
  idle: '空闲（动态下线）',
  connecting: '连接中',
  connected: '已连接',
  backoff: '重连等待',
  cooldown: '冷却中',
}

export const LOFII_MOVE_ACTION_LABELS: Record<LofiiMoveAction, string> = {
  home: '回家',
  come: '过来',
  follow: '跟随',
  stop: '停下',
}

export const LOFII_EVENT_TYPE_LABELS: Record<string, string> = {
  hello: '握手',
  presence: '状态',
  task: '任务',
  chat: '聊天',
  movement: '移动',
  alert: '告警',
}

/** 事件流筛选：全部 / 聊天 / 任务 / 状态 / 移动 / 告警。 */
export const LOFII_EVENT_FILTERS: readonly { id: string; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'chat', label: '聊天' },
  { id: 'task', label: '任务' },
  { id: 'presence', label: '状态' },
  { id: 'movement', label: '移动' },
  { id: 'alert', label: '告警' },
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

/** Lofii 历史告警 type 的中文名（兼容 lofii_ 前缀）。 */
export const LOFII_ALERT_TYPE_LABELS: Record<string, string> = {
  low_health: '血量过低',
  task_failed: '任务失败',
  disconnected: '断线',
  chest_full: '箱子已满',
  defense_retreat: '防御撤退',
}

/** 服务端 /api/lofii/status 的 error 字段是稳定错误码，展示时转为中文。 */
const LOFII_ERROR_LABELS: Record<string, string> = {
  lofii_disabled: 'Lofii 对接未启用',
  lofii_control_disabled: 'Lofii 控制接口未启用',
  lofii_unavailable: 'Lofii 服务不可达',
  lofii_auth_failed: 'Lofii 鉴权失败',
  lofii_upstream_error: 'Lofii 上游响应异常',
  lofii_rate_limited: 'Lofii 请求过于频繁',
  lofii_resume_pending: 'Lofii 有待恢复任务',
  lofii_resume_failed: 'Lofii 任务恢复失败',
  lofii_queue_full: 'Lofii 任务队列已满',
  lofii_no_active_task: 'Lofii 没有进行中的任务',
  lofii_no_pending_task: 'Lofii 没有待恢复任务',
  lofii_task_disabled: 'Lofii 任务功能已关闭',
  lofii_task_active: 'Lofii 任务进行中',
  lofii_target_not_online: '目标玩家不在线',
  lofii_not_connected: 'Lofii 未连接 Minecraft',
  lofii_invalid_request: 'Lofii 请求参数不合法',
}

/** 把状态快照里的稳定错误码转成中文文案（未知码原样展示）。 */
export function lofiiErrorLabel(code: string | null | undefined): string {
  if (!code) return '未知错误'
  return LOFII_ERROR_LABELS[code] ?? code
}

export const LOFII_SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  error: '错误',
  warning: '警告',
  warn: '警告',
  info: '提示',
  ok: '正常',
}

/** 任务进度字段到中文标签的映射；未使用的计数不展示。 */
const TASK_PROGRESS_LABELS: Record<LofiiTaskName, readonly { key: keyof LofiiTaskProgress; label: string }[]> = {
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
}

export function lofiiTaskNameLabel(name: string | null | undefined): string {
  if (!name) return '—'
  return LOFII_TASK_NAME_LABELS[name as LofiiTaskName] ?? name
}

export function lofiiTaskStateLabel(state: string | null | undefined): string {
  if (!state) return '—'
  return LOFII_TASK_STATE_LABELS[state as LofiiTaskState] ?? state
}

export function lofiiBotStateLabel(state: string | null | undefined): string {
  if (!state) return '—'
  return LOFII_BOT_STATE_LABELS[state as LofiiBotState] ?? state
}

export function lofiiEventTypeLabel(type: LofiiEventType | string): string {
  return LOFII_EVENT_TYPE_LABELS[type] ?? (type || '其他')
}

export function lofiiAlertTypeLabel(type: string | null | undefined): string {
  if (!type) return '—'
  const normalized = type.startsWith('lofii_') ? type.slice('lofii_'.length) : type
  return LOFII_ALERT_TYPE_LABELS[normalized] ?? type
}

export function lofiiSeverityLabel(severity: string | null | undefined): string {
  if (!severity) return '—'
  return LOFII_SEVERITY_LABELS[severity.toLowerCase()] ?? severity
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
  return TASK_ACTION_LABELS[value] ?? value
}

/** 事件渲染视图：聊天正文与结构化摘要互斥，均为纯文本。 */
export interface LofiiEventView {
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
  return text ? `Lofii：${text}` : ''
}

function describeStructuredEvent(type: string, data: Record<string, unknown> | null): string {
  if (type === 'task') {
    const action = asText(data?.action)
    const task = asRecord(data?.task)
    const name = asText(task?.name)
    const state = asText(task?.state)
    const parts = [`任务${actionLabel(action)}`]
    if (name) parts.push(lofiiTaskNameLabel(name))
    if (state) parts.push(lofiiTaskStateLabel(state))
    return parts.join(' · ')
  }
  if (type === 'presence') {
    const state = asText(data?.state)
    const otherPlayers = asCount(data?.otherPlayers)
    const parts = [state ? `连接状态：${lofiiBotStateLabel(state)}` : '连接状态更新']
    if (otherPlayers !== null) parts.push(`其他玩家 ${otherPlayers}`)
    const taskName = asText(data?.taskName)
    const taskState = asText(data?.taskState)
    if (taskName) parts.push(`任务 ${lofiiTaskNameLabel(taskName)}`)
    if (taskState) parts.push(lofiiTaskStateLabel(taskState))
    return parts.join(' · ')
  }
  if (type === 'movement') {
    const action = asText(data?.action)
    const target = asText(data?.target)
    const status = asText(data?.status)
    const parts = [`移动：${action ? (LOFII_MOVE_ACTION_LABELS[action as LofiiMoveAction] ?? action) : '未知动作'}`]
    if (target) parts.push(`目标 ${target}`)
    if (status) parts.push(MOVEMENT_STATUS_LABELS[status] ?? status)
    const error = asText(data?.error)
    if (error) parts.push(`错误：${error}`)
    return parts.join(' · ')
  }
  if (type === 'alert') {
    const alertType = asText(data?.type)
    const severity = asText(data?.severity)
    const message = asText(data?.message)
    const head = [alertType ? lofiiAlertTypeLabel(alertType) : '告警', severity ? lofiiSeverityLabel(severity) : null]
      .filter((part): part is string => Boolean(part))
      .join(' · ')
    return message ? `${head}：${message}` : head
  }
  if (type === 'hello') return '握手事件（连接建立快照）'
  return `${lofiiEventTypeLabel(type)}事件`
}

/** 把事件转换为可安全渲染的纯文本视图；聊天正文只在 chat 事件下读取。 */
export function describeLofiiEvent(event: LofiiEvent): LofiiEventView {
  const typeLabel = lofiiEventTypeLabel(event.type)
  const data = asRecord(event.data)
  if (event.type === 'chat') {
    const chatText = describeChat(data)
    return { typeLabel, chatText: chatText || null, summary: chatText ? '' : '聊天事件（无正文）' }
  }
  return { typeLabel, chatText: null, summary: describeStructuredEvent(event.type, data) }
}

/* ---------- 任务进度 ---------- */

export interface LofiiProgressRow {
  label: string
  value: string
}

/** 按任务类型提取非零进度计数；全部为 0 时返回空数组（UI 显示暂无进度）。 */
export function lofiiTaskProgressRows(task: LofiiTask | null | undefined): LofiiProgressRow[] {
  if (!task || !task.progress) return []
  const fields = task.name ? TASK_PROGRESS_LABELS[task.name] : null
  if (!fields) return []
  const rows: LofiiProgressRow[] = []
  for (const field of fields) {
    const raw = task.progress[field.key]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    if (value <= 0) continue
    rows.push({
      label: field.label,
      value: field.key === 'patrolDistance' ? `${value} 格` : String(value),
    })
  }
  if (task.progress.mobsKilled > 0 && !rows.some((row) => row.label === '击杀怪物')) {
    rows.push({ label: '击杀怪物', value: String(task.progress.mobsKilled) })
  }
  return rows
}

/* ---------- Lofii 快照派生 ---------- */

/**
 * 在线玩家列表：来自 admin.online.players，排除 Lofii 自己并去重；
 * 用于“过来/跟随”目标选择。列表缺失或 RCON 不可用时返回空数组。
 */
export function lofiiOnlinePlayers(status: LofiiStatus | null | undefined): string[] {
  const players = status?.admin?.online?.players
  if (!Array.isArray(players)) return []
  const self = (status?.minecraft?.username ?? 'lofii').trim().toLowerCase()
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
export function lofiiEventsSupported(snapshot: LofiiSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  if (typeof snapshot.eventsSupported === 'boolean') return snapshot.eventsSupported
  return snapshot.contractVersion !== null || snapshot.events.length > 0
}

/** 历史告警行的展示文案（纯文本，不含 details 任意字段）。 */
export function lofiiHistoryAlertText(alert: LofiiHistoryAlert): string {
  const head = `${lofiiAlertTypeLabel(alert.type)} · ${lofiiSeverityLabel(alert.severity)}`
  return alert.message ? `${head}：${alert.message}` : head
}
