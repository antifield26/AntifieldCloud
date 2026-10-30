import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Moon, Play, Square, Target } from 'lucide-react'
import { api, isAbortError, isApiError, toErrorMessage } from '../../api/client'
import type {
  McbotGoal,
  McbotGoalKind,
  McbotPresenceInfo,
  McbotPresenceMode,
  McbotTaskName,
} from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { InlineError } from '../InlineError'
import { RelativeTime } from '../RelativeTime'
import { useToast } from '../Toast'
import { mcbotTaskNameLabel } from '../../lib/mcbot'

const PRESENCE_LABELS: Record<McbotPresenceMode, string> = {
  auto: '自动在线',
  always: '常驻在线',
  off: '不主动上线',
}

const PRESENCE_HINTS: Record<McbotPresenceMode, string> = {
  auto: '有玩家或任务时在线，空服自动离开。',
  always: '空服也保持在线，占用服务器资源；仅在你确认时使用。',
  off: '不主动上线；不会打断正在运行的任务或自主会话。',
}

/** 预设计划：只使用任务白名单，创建后仍需显式开始。 */
const PRESET_PLANS: Array<{ label: string, objective: string, steps: Array<{ kind: McbotGoalKind, taskName?: McbotTaskName }> }> = [
  {
    label: '采集→存箱→补种',
    objective: '采集资源、存入分类箱并补种',
    steps: [
      { kind: 'task', taskName: 'woodcutting' },
      { kind: 'deposit' },
      { kind: 'task', taskName: 'farming' },
    ],
  },
  {
    label: '清理安全区→存箱',
    objective: '清理安全区并整理战利品',
    steps: [{ kind: 'task', taskName: 'clearing' }, { kind: 'deposit' }],
  },
]

interface PendingConfirm {
  kind: 'presence' | 'start' | 'pause' | 'cancel'
  goalId?: string
  mode?: McbotPresenceMode
  label: string
}

function goalStatusTone (status: string): 'muted' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'running') return 'success'
  if (status === 'paused') return 'warning'
  if (status === 'completed') return 'info'
  if (status === 'failed' || status === 'canceled') return 'danger'
  return 'muted'
}

function goalStatusLabel (status: string): string {
  switch (status) {
    case 'running': return '执行中'
    case 'paused': return '已暂停'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'canceled': return '已取消'
    default: return '待开始'
  }
}

export function McbotPresenceGoalsCard({
  controlReady,
  onChanged,
}: {
  controlReady: boolean
  onChanged?: () => void
}) {
  const toast = useToast()
  const [presence, setPresence] = useState<McbotPresenceInfo | null>(null)
  const [goals, setGoals] = useState<McbotGoal[]>([])
  const [error, setError] = useState<string | null>(null)
  const [goalsError, setGoalsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [planIndex, setPlanIndex] = useState(0)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    const [presenceResult, goalsResult] = await Promise.allSettled([
      api.mcbot.presence(signal),
      api.mcbot.goals(10, signal),
    ])
    if (signal?.aborted) return
    if (presenceResult.status === 'fulfilled') {
      setPresence(presenceResult.value.presence ?? null)
      setError(null)
    } else {
      const failure = presenceResult.reason
      if (isAbortError(failure)) return
      setError(isApiError(failure) ? toErrorMessage(failure) : '在线模式读取失败')
    }
    if (goalsResult.status === 'fulfilled') {
      setGoals(goalsResult.value.goals)
      setGoalsError(null)
    } else {
      const failure = goalsResult.reason
      if (isAbortError(failure)) return
      setGoalsError(isApiError(failure) ? toErrorMessage(failure) : '长期目标读取失败')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [load])

  async function runAction (work: () => Promise<void>, success: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await work()
      toast.success(success)
      onChanged?.()
      await load()
    } catch (failure) {
      if (!isAbortError(failure)) toast.error(isApiError(failure) ? toErrorMessage(failure) : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  function confirmAction (): void {
    if (!confirm) return
    if (confirm.kind === 'presence') {
      void runAction(async () => {
        if (confirm.mode) await api.mcbot.setPresence(confirm.mode)
      }, `在线模式已切换为「${confirm.mode ? PRESENCE_LABELS[confirm.mode] : ''}」`)
    } else if (confirm.kind === 'start' && confirm.goalId) {
      void runAction(() => api.mcbot.goalAction(confirm.goalId!, 'start').then(() => {}), '目标已开始')
    } else if (confirm.kind === 'pause' && confirm.goalId) {
      void runAction(() => api.mcbot.goalAction(confirm.goalId!, 'pause').then(() => {}), '目标已暂停')
    } else if (confirm.kind === 'cancel' && confirm.goalId) {
      void runAction(() => api.mcbot.goalAction(confirm.goalId!, 'cancel').then(() => {}), '目标已取消')
    }
    setConfirm(null)
  }

  function createPlan (event: FormEvent): void {
    event.preventDefault()
    const plan = PRESET_PLANS[planIndex]
    if (!plan) return
    void runAction(async () => {
      await api.mcbot.createGoal(plan.objective, plan.steps)
    }, '目标已创建，请确认后开始')
  }

  function confirmTitle (): string {
    if (!confirm) return ''
    if (confirm.kind === 'presence') return '切换在线模式'
    if (confirm.kind === 'start') return '开始长期目标'
    if (confirm.kind === 'pause') return '暂停长期目标'
    return '取消长期目标'
  }

  function confirmMessage (): string {
    if (!confirm) return ''
    if (confirm.kind === 'presence') return `确定切换到「${confirm.mode ? PRESENCE_LABELS[confirm.mode] : ''}」？`
    if (confirm.kind === 'start') return '目标将按步骤串行执行；失败会暂停并等待处理。确定开始？'
    if (confirm.kind === 'pause') return '暂停会停止当前任务，目标保留以便稍后恢复。确定暂停？'
    return '取消后不可恢复，已完成的步骤保留。确定取消？'
  }

  return (
    <>
      <Card
        title="在线模式与长期目标"
        description="常驻在线、自动生存和多步目标均由 mcbot 执行；切换与开始需要二次确认。"
        actions={<Badge tone={controlReady ? 'success' : 'muted'}>{controlReady ? '可控' : '只读'}</Badge>}
      >
        {error ? <InlineError message={error} /> : null}
        <div className="mcbot-task-facts">
          <span className="mcbot-fact-label">在线模式</span>
          <div className="mcbot-task-controls" role="group" aria-label="在线模式">
            {(Object.keys(PRESENCE_LABELS) as McbotPresenceMode[]).map((mode) => (
              <Button
                key={mode}
                variant={presence?.mode === mode ? 'primary' : 'secondary'}
                size="sm"
                disabled={!controlReady || busy}
                onClick={() => setConfirm({ kind: 'presence', mode, label: PRESENCE_LABELS[mode] })}
              >
                {PRESENCE_LABELS[mode]}
              </Button>
            ))}
          </div>
          {presence ? (
            <span className="mcbot-fact-hint">
              {PRESENCE_HINTS[presence.mode]}
              {presence.source === 'persisted' && presence.updatedAt ? (
                <> · 已持久化 <RelativeTime ts={presence.updatedAt} /></>
              ) : null}
            </span>
          ) : null}
        </div>

        <h3 className="subsection-title">多步目标</h3>
        {goalsError ? <InlineError message={goalsError} /> : null}
        <form className="mcbot-task-controls" onSubmit={createPlan}>
          <label className="field-label" htmlFor="mcbot-goal-preset">预设计划</label>
          <div className="select-field">
            <select
              id="mcbot-goal-preset"
              className="select"
              value={planIndex}
              disabled={!controlReady || busy}
              onChange={(event) => setPlanIndex(Number(event.target.value))}
            >
              {PRESET_PLANS.map((plan, index) => (
                <option key={plan.label} value={index}>{plan.label}</option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary" disabled={!controlReady || busy} loading={busy}>
            创建计划
          </Button>
        </form>

        {goals.length === 0 ? (
          <EmptyState compact icon={<Target size={22} />} title="暂无长期目标" description="创建预设计划后，目标默认待开始；需要显式点击开始。" />
        ) : (
          <ul className="mcbot-queue">
            {goals.map((goal) => (
              <li className="mcbot-queue-item" key={goal.id}>
                <div>
                  <div className="mcbot-queue-name">{goal.objective}</div>
                  <div className="mcbot-fact-hint">
                    <Badge tone={goalStatusTone(goal.status)}>{goalStatusLabel(goal.status)}</Badge>
                    {' '}
                    {goal.steps.map((step, index) => (
                      <span key={`${goal.id}-${index}`}>
                        {index > 0 ? ' → ' : ''}
                        {step.kind === 'task'
                          ? mcbotTaskNameLabel(step.taskName)
                          : step.kind === 'deposit' ? '存箱' : '回家'}
                      </span>
                    ))}
                  </div>
                  {goal.lastError ? <div className="notice notice-warning">{goal.lastError}</div> : null}
                </div>
                <div className="mcbot-pending-actions">
                  {goal.status === 'pending' || goal.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!controlReady || busy}
                      icon={<Play size={14} />}
                      onClick={() => setConfirm({ kind: 'start', goalId: goal.id, label: '开始' })}
                    >
                      开始
                    </Button>
                  ) : null}
                  {goal.status === 'running' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!controlReady || busy}
                      icon={<Moon size={14} />}
                      onClick={() => setConfirm({ kind: 'pause', goalId: goal.id, label: '暂停' })}
                    >
                      暂停
                    </Button>
                  ) : null}
                  {goal.status === 'pending' || goal.status === 'paused' || goal.status === 'running' ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!controlReady || busy}
                      icon={<Square size={14} />}
                      onClick={() => setConfirm({ kind: 'cancel', goalId: goal.id, label: '取消' })}
                    >
                      取消
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        title={confirmTitle()}
        message={confirmMessage()}
        confirmText={confirm?.kind === 'cancel' ? '取消目标' : '确认'}
        tone={confirm?.kind === 'cancel' ? 'danger' : 'primary'}
        loading={busy}
        onConfirm={confirmAction}
        onClose={() => setConfirm(null)}
      />
    </>
  )
}
