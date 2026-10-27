// mcbot 面板（/minecraft 的 mcbot 标签页）：状态、任务控制、移动、游戏内聊天、事件流与历史。
// 数据来自 GET /api/mcbot/status（5 秒轮询）与 GET /api/mcbot/history；写操作走 /api/mcbot/*。
// 安全边界：不展示 mcbot Token/地址/内部路径，聊天与事件一律纯文本渲染；开始/停止/恢复/发送均需二次确认。
// 降级：禁用显示说明；不可达/过期显示缓存数据与警告；控制未启用时禁用全部写操作。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Clock,
  Crosshair,
  Footprints,
  Home,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Users,
} from 'lucide-react'
import { api, isAbortError, isApiError, toErrorMessage } from '../../api/client'
import type {
  McbotActionResult,
  McbotMoveAction,
  McbotPendingResume,
  McbotSnapshot,
  McbotStatus,
  McbotTask,
  McbotTaskName,
} from '../../api/types'
import { usePolling } from '../../hooks/usePolling'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { InlineError } from '../InlineError'
import { RelativeTime } from '../RelativeTime'
import { SkeletonText } from '../Skeleton'
import { useToast } from '../Toast'
import { McbotEventsCard } from './McbotEventsCard'
import { McbotHistoryCard } from './McbotHistoryCard'
import { formatDuration } from '../../lib/format'
import {
  MCBOT_MOVE_ACTION_LABELS,
  MCBOT_TASK_NAMES,
  mcbotBotStateLabel,
  mcbotErrorLabel,
  mcbotOnlinePlayers,
  mcbotTaskNameLabel,
  mcbotTaskProgressRows,
  mcbotTaskStateLabel,
  safeLofiiStatus,
} from '../../lib/mcbot'

/** /api/mcbot/status 轮询间隔。 */
const STATUS_POLL_MS = 5000
/** /say 内容上限（mcbot 契约）。 */
const SAY_MAX_CHARS = 720

/** 聊天内容不允许 C0 控制字符与 DEL。 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

type ConfirmState =
  | { type: 'start'; name: McbotTaskName }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'say'; message: string }
  | null

function dashNumber(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function Fact({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mcbot-fact">
      <span className="mcbot-fact-label">{label}</span>
      <span className="mcbot-fact-value">{children}</span>
      {hint ? <span className="mcbot-fact-hint">{hint}</span> : null}
    </div>
  )
}

/* ---------- 状态卡 ---------- */

function McbotStatusCard({
  snapshot,
  error,
  refreshing,
  onRefresh,
}: {
  snapshot: McbotSnapshot
  error: string | null
  refreshing: boolean
  onRefresh: () => void
}) {
  const status = safeLofiiStatus(snapshot.status)
  const connected = status?.minecraft.connected === true
  const tps = status?.admin.tps
  const tpsOne = tps?.one ?? null
  const tpsFive = tps?.five ?? null
  const tpsFifteen = tps?.fifteen ?? null
  const tpsReady =
    typeof tpsOne === 'number' && typeof tpsFive === 'number' && typeof tpsFifteen === 'number'
  const tpsText = tpsReady
    ? `${tpsOne.toFixed(1)} / ${tpsFive.toFixed(1)} / ${tpsFifteen.toFixed(1)}`
    : '—'

  return (
    <Card
      title="mcbot 状态"
      description="mcbot 每 5 秒被轮询一次；页面隐藏时暂停请求，刷新失败时保留上次成功的数据。"
      actions={
        <div className="card-actions-inline">
          <Badge tone={snapshot.reachable ? 'success' : 'danger'} dot>
            {snapshot.reachable ? '可达' : '不可达'}
          </Badge>
          <Badge tone={snapshot.controlEnabled ? 'accent' : 'muted'}>
            {snapshot.controlEnabled ? '控制可用' : '控制未启用'}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新 mcbot 状态"
            title="刷新"
            loading={refreshing}
            onClick={onRefresh}
            icon={<RefreshCw size={16} aria-hidden="true" />}
          />
        </div>
      }
    >
      {error ? <InlineError message={`${error}（显示上次成功获取的数据）`} onRetry={onRefresh} /> : null}

      {status ? (
        <div className="mcbot-status-grid">
          <Fact label="运行状态">
            <Badge tone={status.state === 'connected' ? 'success' : status.state === 'idle' ? 'muted' : 'warning'}>
              {mcbotBotStateLabel(status.state)}
            </Badge>
          </Fact>
          <Fact label="Minecraft 连接">
            <Badge tone={connected ? 'success' : 'danger'} dot>
              {connected ? `已连接（${status.minecraft.username}）` : '未连接'}
            </Badge>
          </Fact>
          <Fact label="服务器在线 / 上限" hint={status.server.reachable ? status.server.versionName ?? undefined : '服务器状态不可达'}>
            {status.server.reachable ? `${status.server.online} / ${status.server.max}` : '—'}
          </Fact>
          <Fact
            label="TPS（1m / 5m / 15m）"
            hint={status.admin.rcon ? undefined : 'RCON 不可用'}
          >
            {tpsText}
          </Fact>
          <Fact label="mcbot 血量 / 饥饿" hint={status.player.dimension ?? undefined}>
            {dashNumber(status.player.health)} / {dashNumber(status.player.food)}
          </Fact>
          <Fact
            label="AI 队列"
            hint={
              status.ai.enabled
                ? `失败 ${status.ai.failures} 次 · 最近延迟 ${dashNumber(status.ai.lastLatencyMs)} ms`
                : 'AI 已关闭'
            }
          >
            {status.ai.enabled ? `${status.ai.queued} 排队 / ${status.ai.inFlight} 处理中` : '—'}
          </Fact>
          <Fact label="记忆">
            {status.memory.players} 位玩家 / {status.memory.turns} 轮
          </Fact>
          <Fact label="mcbot 版本">
            {snapshot.version ?? status.version ?? '未知'}
            <span className="mcbot-fact-sub">
              {' '}
              · 契约 {typeof snapshot.contractVersion === 'number' ? `v${snapshot.contractVersion}` : '—'}
            </span>
          </Fact>
          <Fact label="mcbot 运行时长">{formatDuration(status.uptimeSec)}</Fact>
          <Fact label="白名单数量" hint={status.admin.lastError ?? undefined}>
            {status.admin.whitelist.count ?? '—'}
          </Fact>
          <Fact label="告警联动">
            <Badge tone={snapshot.alertsEnabled ? 'success' : 'muted'}>
              {snapshot.alertsEnabled ? '已启用' : '未启用'}
            </Badge>
          </Fact>
          <Fact label="事件流">
            {Array.isArray(snapshot.events) ? snapshot.events.length : 0} 条
            <span className="mcbot-fact-sub"> · 内存环</span>
          </Fact>
        </div>
      ) : (
        <EmptyState
          compact
          icon={<Clock size={22} />}
          title="暂无 mcbot 状态快照"
          description="mcbot 不可达或尚未完成首次轮询；可稍后重试或查看下方缓存的事件与历史。"
        />
      )}

      {status?.minecraft.lastDisconnect ? (
        <div className="notice notice-warning">
          <span>
            上次 Minecraft 断线：<RelativeTime ts={status.minecraft.lastDisconnect.at} />
            {status.minecraft.lastDisconnect.reason ? `（${status.minecraft.lastDisconnect.reason}）` : ''}；累计重连{' '}
            {status.minecraft.reconnects} 次。
          </span>
        </div>
      ) : null}

      {status?.ai.lastError ? (
        <div className="notice notice-warning">AI 最近错误：{status.ai.lastError}</div>
      ) : null}

      <p className="card-footnote">
        上次轮询 <RelativeTime ts={snapshot.lastPollAt} fallback="—" />
        {typeof snapshot.contractVersion === 'number' && snapshot.contractVersion < 1
          ? ' · mcbot 契约版本过低'
          : ''}
      </p>
    </Card>
  )
}

/* ---------- 任务卡 ---------- */

function McbotTaskCard({
  status,
  controlReady,
  taskName,
  onTaskNameChange,
  onStart,
  onStop,
  onResume,
  onDiscardPending,
}: {
  status: McbotStatus
  controlReady: boolean
  taskName: McbotTaskName
  onTaskNameChange: (name: McbotTaskName) => void
  onStart: () => void
  onStop: () => void
  onResume: () => void
  onDiscardPending: () => void
}) {
  const task: McbotTask = status.task
  const pending: McbotPendingResume | null = task.pendingResume
  const progressRows = mcbotTaskProgressRows(task)
  const taskFeatureDisabled = task.enabled === false
  const startDisabled = !controlReady || taskFeatureDisabled || pending !== null
  const stopDisabled =
    !controlReady || (!task.active && pending === null && task.queue.length === 0)

  const startHint = !controlReady
    ? '控制未启用或 mcbot 不可达，任务操作不可用。'
    : taskFeatureDisabled
      ? 'mcbot 任务功能未启用（TASK_ENABLED=false）。'
      : pending
        ? '有待恢复任务，需先恢复或放弃后才能开始新任务。'
        : task.active
          ? '任务进行中：继续开始会加入队列（最多 3 个），排队任务会依次执行。'
          : undefined

  return (
    <Card
      title="任务"
      description="任务由 mcbot 自动执行；开始、停止与恢复都需要二次确认。"
      actions={
        <Badge tone={task.active ? 'success' : pending ? 'warning' : 'muted'}>
          {task.active ? '进行中' : pending ? '待恢复' : '空闲'}
        </Badge>
      }
    >
      {pending ? (
        <div className="notice notice-warning mcbot-pending">
          <span>
            有待恢复任务「{mcbotTaskNameLabel(pending.name)}」：已运行 {formatDuration(pending.elapsedSec)}，
            需在 <RelativeTime ts={pending.expiresAt} fallback="截止时间未知" /> 前确认恢复，否则 mcbot 会自动中断。
          </span>
          <div className="mcbot-pending-actions">
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCcw size={15} aria-hidden="true" />}
              disabled={!controlReady}
              onClick={onResume}
            >
              恢复
            </Button>
            <Button size="sm" variant="ghost" disabled={!controlReady} onClick={onDiscardPending}>
              放弃
            </Button>
          </div>
        </div>
      ) : null}

      {taskFeatureDisabled ? (
        <div className="notice notice-muted">mcbot 任务功能未启用（TASK_ENABLED=false）。</div>
      ) : null}
      {task.lastError ? <div className="notice notice-warning">任务最近错误：{task.lastError}</div> : null}

      <div className="mcbot-task-facts">
        <Fact label="当前任务">{task.active || pending ? mcbotTaskNameLabel(task.name) : '空闲'}</Fact>
        <Fact label="任务状态">
          <Badge tone={task.active ? 'success' : pending ? 'warning' : 'muted'}>
            {mcbotTaskStateLabel(task.state)}
          </Badge>
        </Fact>
        <Fact label="已运行">
          {task.active || pending ? formatDuration(task.elapsedSec) : '—'}
        </Fact>
        <Fact label="失败次数">{task.failures}</Fact>
        <Fact label="排队任务">{task.queue.length} 个</Fact>
      </div>

      <h3 className="subsection-title">任务进度</h3>
      {progressRows.length > 0 ? (
        <dl className="mcbot-progress">
          {progressRows.map((row) => (
            <div className="mcbot-progress-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mcbot-muted">当前任务没有进度数据。</p>
      )}

      <h3 className="subsection-title">任务队列</h3>
      {task.queue.length > 0 ? (
        <ol className="mcbot-queue">
          {task.queue.map((item, index) => (
            <li className="mcbot-queue-item" key={`${item.taskId}-${index}`}>
              <span className="mcbot-queue-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="mcbot-queue-name">{mcbotTaskNameLabel(item.name)}</span>
              <RelativeTime ts={item.requestedAt} className="mcbot-queue-time" />
            </li>
          ))}
        </ol>
      ) : (
        <p className="mcbot-muted">队列为空。</p>
      )}

      <div className="mcbot-task-controls">
        <div className="mcbot-task-select">
          <label className="field-label" htmlFor="mcbot-task-select">
            任务
          </label>
          <div className="select-field">
            <select
              id="mcbot-task-select"
              className="select"
              value={taskName}
              disabled={!controlReady || taskFeatureDisabled}
              onChange={(event) => onTaskNameChange(event.target.value as McbotTaskName)}
            >
              {MCBOT_TASK_NAMES.map((name) => (
                <option key={name} value={name}>
                  {mcbotTaskNameLabel(name)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button
          variant="primary"
          icon={<Play size={16} aria-hidden="true" />}
          disabled={startDisabled}
          title={startHint}
          onClick={onStart}
        >
          开始任务
        </Button>
        <Button
          variant="danger"
          icon={<Square size={15} aria-hidden="true" />}
          disabled={stopDisabled}
          onClick={onStop}
        >
          停止任务
        </Button>
        {pending ? (
          <Button
            variant="secondary"
            icon={<RotateCcw size={16} aria-hidden="true" />}
            disabled={!controlReady}
            onClick={onResume}
          >
            恢复任务
          </Button>
        ) : null}
      </div>
      {startHint ? <p className="field-hint">{startHint}</p> : null}
      <p className="field-hint">停止任务会中断当前任务并清空排队任务，需要二次确认。</p>
    </Card>
  )
}

/* ---------- 移动 / 聊天 ---------- */

function McbotMoveCard({
  status,
  controlReady,
  moveBusy,
  onMove,
}: {
  status: McbotStatus
  controlReady: boolean
  moveBusy: McbotMoveAction | null
  onMove: (action: McbotMoveAction, target: string | undefined) => void
}) {
  const players = mcbotOnlinePlayers(status)
  const [selected, setSelected] = useState('')
  const selectedTarget = players.includes(selected) ? selected : players[0] ?? ''
  const taskActive = status.task.active === true
  const connected = status.minecraft.connected === true
  const targetsDisabled = !controlReady || taskActive || !connected || players.length === 0
  const moveDisabled = !controlReady || taskActive || !connected

  const hint = !controlReady
    ? '控制未启用或 mcbot 不可达，移动不可用。'
    : taskActive
      ? 'mcbot 任务进行中，需先停止任务才能手动移动。'
      : !connected
        ? 'mcbot 尚未连接 Minecraft，移动不可用。'
        : players.length === 0
          ? '暂无其他在线玩家，过来/跟随不可用。'
          : '移动结果会以事件形式返回；回家/停下不需要目标玩家。'

  return (
    <Card title="移动控制" description="手动让 mcbot 移动；移动可随时停下，不改变任务状态。">
      <div className="mcbot-move-form">
        <label className="field-label" htmlFor="mcbot-move-target">
          目标玩家
        </label>
        <div className="select-field">
          <select
            id="mcbot-move-target"
            className="select"
            value={selectedTarget}
            disabled={targetsDisabled}
            aria-label="选择移动目标玩家"
            onChange={(event) => setSelected(event.target.value)}
          >
            {players.length === 0 ? (
              <option value="">暂无在线玩家</option>
            ) : (
              players.map((player) => (
                <option key={player} value={player}>
                  {player}
                </option>
              ))
            )}
          </select>
        </div>
      </div>
      <div className="mcbot-move-actions">
        <Button
          icon={<Home size={16} aria-hidden="true" />}
          disabled={moveDisabled}
          loading={moveBusy === 'home'}
          onClick={() => onMove('home', undefined)}
        >
          回家
        </Button>
        <Button
          icon={<Users size={16} aria-hidden="true" />}
          disabled={moveDisabled || !selectedTarget}
          loading={moveBusy === 'come'}
          onClick={() => onMove('come', selectedTarget || undefined)}
        >
          过来
        </Button>
        <Button
          icon={<Footprints size={16} aria-hidden="true" />}
          disabled={moveDisabled || !selectedTarget}
          loading={moveBusy === 'follow'}
          onClick={() => onMove('follow', selectedTarget || undefined)}
        >
          跟随
        </Button>
        <Button
          icon={<Crosshair size={16} aria-hidden="true" />}
          disabled={moveDisabled}
          loading={moveBusy === 'stop'}
          onClick={() => onMove('stop', undefined)}
        >
          停下
        </Button>
      </div>
      <p className="field-hint">{hint}</p>
    </Card>
  )
}

function McbotSayCard({
  ready,
  text,
  error,
  onTextChange,
  onSubmit,
}: {
  ready: boolean
  text: string
  error: string | null
  onTextChange: (value: string) => void
  onSubmit: () => void
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onSubmit()
  }

  return (
    <Card title="游戏内聊天" description="以 mcbot 的身份向游戏内发送聊天；只聊天，绝不执行命令。">
      <form className="mcbot-say-form" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="mcbot-say-input">
          游戏内聊天内容
        </label>
        <textarea
          id="mcbot-say-input"
          className="input mcbot-say-input"
          value={text}
          rows={3}
          maxLength={SAY_MAX_CHARS}
          placeholder="输入要发送到游戏内的聊天内容（不能包含 /）"
          aria-label="游戏内聊天内容"
          disabled={!ready}
          onChange={(event) => onTextChange(event.target.value)}
        />
        <div className="mcbot-say-footer">
          <span className="field-hint">
            {text.length}/{SAY_MAX_CHARS} · 发送前需要二次确认
          </span>
          <Button
            type="submit"
            variant="primary"
            icon={<Send size={16} aria-hidden="true" />}
            disabled={!ready || text.trim().length === 0}
          >
            发送
          </Button>
        </div>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="field-hint">内容不能包含 /，也不会执行任何命令；本页不展示任何 Token 或内部地址。</p>
      </form>
    </Card>
  )
}

/* ---------- 面板 ---------- */

export function McbotPanel() {
  const toast = useToast()
  const [snapshot, setSnapshot] = useState<McbotSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [taskName, setTaskName] = useState<McbotTaskName>('fishing')
  const [sayText, setSayText] = useState('')
  const [sayError, setSayError] = useState<string | null>(null)
  const [moveBusy, setMoveBusy] = useState<McbotMoveAction | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (): Promise<void> => {
    // 轮询与手动刷新可能并发：旧请求先完成时不得覆盖新请求结果。
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    try {
      const next = await api.mcbot.status(controller.signal)
      if (requestId !== requestIdRef.current) return
      setSnapshot(next)
      setError(null)
      setErrorCode(null)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      // 刷新失败保留上次成功的数据，只更新错误提示。
      setError(toErrorMessage(loadError, '加载 mcbot 状态失败'))
      setErrorCode(isApiError(loadError) ? loadError.code : null)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  usePolling(() => load(), STATUS_POLL_MS)

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const runAction = async (
    action: () => Promise<McbotActionResult>,
    successText: (result: McbotActionResult) => string,
  ): Promise<boolean> => {
    setActionBusy(true)
    try {
      const result = await action()
      toast.success(successText(result))
      await load()
      return true
    } catch (actionError) {
      toast.error(toErrorMessage(actionError, 'mcbot 操作失败，请重试'))
      return false
    } finally {
      setActionBusy(false)
      setConfirm(null)
    }
  }

  const status = snapshot ? safeLofiiStatus(snapshot.status) : null
  const controlReady = snapshot?.enabled === true && snapshot.reachable && snapshot.controlEnabled
  // /say 是写操作：只读模式（未配置控制 Token）必须禁用，避免成为绕过权限的写通道。
  const sayReady = controlReady
  const disabled = snapshot ? !snapshot.enabled : errorCode === 'mcbot_disabled'
  const pendingResume = status?.task.pendingResume ?? null
  /** 应用刚启动时首次轮询完成前 reachable=false/lastPollAt=null 属正常，不提示“不可达”。 */
  const awaitingFirstPoll =
    snapshot !== null && !snapshot.reachable && snapshot.lastPollAt === null && snapshot.error === null

  /* 集成禁用：只显示说明，不渲染任何控制与数据区。 */
  if (disabled) {
    return (
      <div className="mcbot-panel">
        <div className="notice notice-muted">
          <span>
            mcbot 集成未启用（服务端 MCBOT_ENABLED=false）。启用后需要配置 mcbot 地址与 Token 并重启应用；
            本页不展示任何 Token、内部地址或凭据。
          </span>
          <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void refresh()}>
            重新检测
          </Button>
        </div>
      </div>
    )
  }

  /* 首次加载失败：给出错误与重试入口。 */
  if (!snapshot) {
    return (
      <div className="mcbot-panel">
        <Card
          title="mcbot 状态"
          loading={loading}
          skeleton={<SkeletonText lines={5} />}
          error={loading ? null : error ?? '无法获取 mcbot 状态'}
          onRetry={() => void refresh()}
        >
          <p className="mcbot-muted">mcbot 状态不可用。</p>
        </Card>
      </div>
    )
  }

  /* 确认对话框文案：开始/停止/恢复/发送各有独立说明。 */
  let confirmTitle = ''
  let confirmMessage = ''
  let confirmDetails: ReactNode = undefined
  let confirmText = '确认'
  let confirmTone: 'danger' | 'primary' = 'primary'
  if (confirm?.type === 'start') {
    confirmTitle = '开始任务'
    confirmMessage = `确定让 mcbot 开始「${mcbotTaskNameLabel(confirm.name)}」任务？`
    confirmDetails = '任务由 mcbot 自动执行；进行中可在本页停止，停止会清空排队任务。'
    confirmText = '开始'
  } else if (confirm?.type === 'stop') {
    const discardingPending = pendingResume !== null && status?.task.active !== true
    confirmTitle = discardingPending ? '放弃待恢复任务' : '停止任务'
    confirmMessage = discardingPending
      ? '确定放弃待恢复任务并清空队列？'
      : '确定停止当前任务并清空队列？'
    confirmDetails = discardingPending
      ? '待恢复任务和排队中的任务都会被清除，此操作不可撤销。'
      : '停止会中断正在执行的任务，并清空排队中的任务。'
    confirmText = discardingPending ? '放弃' : '停止'
    confirmTone = 'danger'
  } else if (confirm?.type === 'resume') {
    confirmTitle = '恢复任务'
    confirmMessage = pendingResume
      ? `确定恢复「${mcbotTaskNameLabel(pendingResume.name)}」任务？`
      : '确定恢复待恢复任务？'
    confirmDetails = pendingResume
      ? `将从原进度继续；需在 ${formatDuration(Math.max(0, Math.round((Date.parse(pendingResume.expiresAt) - Date.now()) / 1000)))} 内确认，否则 mcbot 自动中断。`
      : '将从原进度继续。'
    confirmText = '恢复'
  } else if (confirm?.type === 'say') {
    confirmTitle = '发送游戏内聊天'
    confirmMessage = `确定向游戏内发送这条消息（${confirm.message.length} 个字符）？`
    confirmDetails = <p className="mcbot-say-preview">{confirm.message}</p>
    confirmText = '发送'
  }

  const handleConfirm = (): void => {
    if (!confirm || actionBusy) return
    switch (confirm.type) {
      case 'start': {
        const label = mcbotTaskNameLabel(confirm.name)
        void runAction(
          () => api.mcbot.startTask(confirm.name),
          (result) =>
            result.queued
              ? `「${label}」已加入任务队列${typeof result.position === 'number' ? `（第 ${result.position} 位）` : ''}`
              : `已请求 mcbot 开始「${label}」任务`,
        )
        break
      }
      case 'stop':
        void runAction(() => api.mcbot.stopTask(), () => '已请求 mcbot 停止任务')
        break
      case 'resume':
        void runAction(() => api.mcbot.resumeTask(pendingResume?.taskId), () => '已请求 mcbot 恢复任务')
        break
      case 'say':
        void runAction(() => api.mcbot.say(confirm.message), () => '已发送游戏内聊天').then((ok) => {
          if (!ok) return
          setSayText('')
          setSayError(null)
        })
        break
      default:
        setConfirm(null)
    }
  }

  const handleSaySubmit = (): void => {
    const message = sayText.trim()
    if (!message) {
      setSayError('请输入聊天内容')
      return
    }
    if (message.includes('/')) {
      setSayError('聊天内容不能包含 /（不会执行任何命令，含上游切分后的命令行）')
      return
    }
    if (hasControlChars(message)) {
      setSayError('聊天内容不能包含控制字符')
      return
    }
    if (message.length > SAY_MAX_CHARS) {
      setSayError(`聊天内容最多 ${SAY_MAX_CHARS} 个字符`)
      return
    }
    setSayError(null)
    setConfirm({ type: 'say', message })
  }

  const handleMove = async (action: McbotMoveAction, target: string | undefined): Promise<void> => {
    if (moveBusy) return
    setMoveBusy(action)
    try {
      await api.mcbot.move(action, target)
      toast.success(
        target
          ? `已请求 mcbot ${MCBOT_MOVE_ACTION_LABELS[action]}（目标 ${target}）`
          : `已请求 mcbot ${MCBOT_MOVE_ACTION_LABELS[action]}`,
      )
      await load()
    } catch (moveError) {
      toast.error(toErrorMessage(moveError, 'mcbot 移动请求失败，请重试'))
    } finally {
      setMoveBusy(null)
    }
  }

  return (
    <div className="mcbot-panel">
      {awaitingFirstPoll ? (
        <div className="notice notice-muted">
          <span>正在等待 mcbot 首次轮询结果；轮询完成前状态可能为空，控制操作暂不可用。</span>
        </div>
      ) : !snapshot.reachable ? (
        <div className="notice notice-warning">
          <span>
            无法连接 mcbot：{mcbotErrorLabel(snapshot.error)}。当前显示上次成功轮询的缓存数据，控制操作不可用。
          </span>
        </div>
      ) : null}
      {snapshot.stale ? (
        <div className="notice notice-warning">
          <span>
            mcbot 数据已过期（上次成功轮询 <RelativeTime ts={snapshot.lastPollAt} fallback="未知时间" />
            ），请检查 mcbot 进程；新数据恢复前请勿依赖当前状态。
          </span>
        </div>
      ) : null}
      {snapshot.reachable && snapshot.error ? (
        <div className="notice notice-warning">
          <span>
            mcbot 状态可达，但事件流/告警游标异常：{mcbotErrorLabel(snapshot.error)}；事件流可能停止更新，控制仍可尝试。
          </span>
        </div>
      ) : null}
      {!snapshot.controlEnabled ? (
        <div className="notice notice-muted">
          mcbot 控制未启用（服务端未配置 MCBOT_CONTROL_TOKEN）：任务/移动/聊天操作已禁用。
        </div>
      ) : null}

      <McbotStatusCard
        snapshot={snapshot}
        error={error}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
      />

      {status ? (
        <>
          <McbotTaskCard
            status={status}
            controlReady={controlReady}
            taskName={taskName}
            onTaskNameChange={setTaskName}
            onStart={() => setConfirm({ type: 'start', name: taskName })}
            onStop={() => setConfirm({ type: 'stop' })}
            onResume={() => setConfirm({ type: 'resume' })}
            onDiscardPending={() => setConfirm({ type: 'stop' })}
          />
          <div className="mcbot-columns">
            <McbotMoveCard
              status={status}
              controlReady={controlReady}
              moveBusy={moveBusy}
              onMove={(action, target) => void handleMove(action, target)}
            />
            <McbotSayCard
              ready={sayReady}
              text={sayText}
              error={sayError}
              onTextChange={(value) => {
                setSayText(value)
                setSayError(null)
              }}
              onSubmit={handleSaySubmit}
            />
          </div>
        </>
      ) : null}

      <McbotEventsCard snapshot={snapshot} />
      <McbotHistoryCard />

      <ConfirmDialog
        open={confirm !== null}
        title={confirmTitle}
        message={confirmMessage}
        details={confirmDetails}
        confirmText={confirmText}
        tone={confirmTone}
        loading={actionBusy}
        onConfirm={handleConfirm}
        onClose={() => {
          if (!actionBusy) setConfirm(null)
        }}
      />
    </div>
  )
}
