// Bot 目标管理：新增、启停命令/通知权限、删除 QQ 目标（用户/群组/频道）。
// 目标 externalId 由平台生成并直接传给服务端；页面不解析其含义，也不发起任何命令。

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Radio, Trash2, Users } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BotInboundTarget, BotSummary, BotTarget, BotTargetKind } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { FormField } from '../FormField'
import { useToast } from '../Toast'
import { targetKindLabel, targetQqLabel } from '../../lib/bots'

interface BotTargetsPanelProps {
  bot: BotSummary | null
  /** 页面级刷新令牌变化时重新拉取目标。 */
  refreshToken: number
  /** 目标增删后回传最新数量，供配置分区判断“测试连接”是否可用。 */
  onChanged: (targetCount: number) => void
}

const TARGET_KINDS: readonly BotTargetKind[] = ['channel', 'user', 'group']

function timeToMinute(value: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function minuteToTime(value: number | null): string {
  if (value === null) return ''
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

/** QQ 目标 ID 说明：C2C 用 user_openid，群聊用 group_openid，频道用 channel_id。 */
function externalIdHint(): string {
  return 'C2C 用户填 user_openid，群聊填 group_openid，频道填 channel_id。'
}

/** QQ 号/群号只作页面识别；平台回调不含真实号码，不用于发送。 */
function normalizeQqNumberInput(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function validQqNumber(value: string): boolean {
  return /^\d{5,12}$/.test(value)
}

/** 目标分区：先选 Bot，再维护 QQ 目标与权限。 */
export function BotTargetsPanel({ bot, refreshToken, onChanged }: BotTargetsPanelProps) {
  const toast = useToast()
  const fieldId = useId()
  const [targets, setTargets] = useState<BotTarget[]>([])
  const [inboundTargets, setInboundTargets] = useState<BotInboundTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [externalId, setExternalId] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<BotTargetKind>('channel')
  const [qqNumber, setQqNumber] = useState('')
  const [allowCommands, setAllowCommands] = useState(false)
  const [allowNotifications, setAllowNotifications] = useState(true)
  const [allowChat, setAllowChat] = useState(false)
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ externalId?: string; label?: string; qqNumber?: string; quiet?: string }>({})
  const [adding, setAdding] = useState(false)
  const [savingQqId, setSavingQqId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [removeTarget, setRemoveTarget] = useState<BotTarget | null>(null)
  const [removing, setRemoving] = useState(false)

  const botId = bot?.id ?? ''

  useEffect(() => {
    if (!botId) {
      setTargets([])
      setInboundTargets([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    Promise.all([api.bots.targets.list(botId), api.bots.targets.listInbound(botId)])
      .then(([items, inbound]) => {
        if (active) {
          setTargets(items)
          setInboundTargets(inbound)
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(toErrorMessage(loadError, '读取目标列表失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [botId, refreshToken, reloadKey])

  const markBusy = (targetId: string, busy: boolean): void => {
    setBusyIds((previous) => {
      const next = new Set(previous)
      if (busy) next.add(targetId)
      else next.delete(targetId)
      return next
    })
  }

  const handleAdd = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!bot || adding) return
    const nextErrors: { externalId?: string; label?: string; qqNumber?: string; quiet?: string } = {}
    if (!externalId.trim()) nextErrors.externalId = '请输入平台目标 ID'
    if (!label.trim()) nextErrors.label = '请输入目标名称'
    const nextQqNumber = kind === 'channel' ? null : normalizeQqNumberInput(qqNumber)
    if (nextQqNumber && !validQqNumber(nextQqNumber)) nextErrors.qqNumber = 'QQ 号/群号需为 5–12 位数字'
    const startMinute = timeToMinute(quietStart)
    const endMinute = timeToMinute(quietEnd)
    if ((quietStart && !quietEnd) || (!quietStart && quietEnd)) nextErrors.quiet = '静默时段起止必须同时填写'
    else if (quietStart && quietEnd && (startMinute === null || endMinute === null)) nextErrors.quiet = '静默时段格式应为 HH:mm'
    else if (startMinute !== null && startMinute === endMinute) nextErrors.quiet = '静默时段起止不能相同'
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setAdding(true)
    try {
      const created = await api.bots.targets.create(bot.id, {
        externalId: externalId.trim(),
        label: label.trim(),
        kind,
        qqNumber: nextQqNumber,
        allowCommands,
        allowNotifications,
        allowChat,
        ...(startMinute !== null && endMinute !== null
          ? { quietStartMinute: startMinute, quietEndMinute: endMinute }
          : {}),
      })
      setTargets((previous) => [...previous, created])
      setExternalId('')
      setLabel('')
      setKind('channel')
      setQqNumber('')
      setAllowCommands(false)
      setAllowNotifications(true)
      setAllowChat(false)
      setQuietStart('')
      setQuietEnd('')
      toast.success(`已添加目标「${created.label}」`)
      onChanged(targets.length + 1)
    } catch (addError) {
      toast.error(toErrorMessage(addError, '添加目标失败，请检查 ID 是否重复'))
    } finally {
      setAdding(false)
    }
  }

  const handleToggle = async (
    target: BotTarget,
    patch: { allowCommands?: boolean; allowNotifications?: boolean; allowChat?: boolean },
  ): Promise<void> => {
    if (!bot || busyIds.has(target.id)) return
    markBusy(target.id, true)
    try {
      const updated = await api.bots.targets.update(bot.id, target.id, patch)
      setTargets((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
      toast.success('目标权限已更新')
    } catch (updateError) {
      toast.error(toErrorMessage(updateError, '更新目标权限失败，请重试'))
    } finally {
      markBusy(target.id, false)
    }
  }

  const handlePrefillInbound = (item: BotInboundTarget): void => {
    setExternalId(item.targetExternalId)
    setKind(item.targetKind)
    setLabel(
      item.userName
        ? `${item.userName}（${targetKindLabel(item.targetKind)}）`
        : `${targetKindLabel(item.targetKind)} ${item.targetExternalId.slice(-6)}`,
    )
    toast.info('已填入最近入站目标，请确认后添加')
  }

  const handleSaveQqNumber = async (event: FormEvent<HTMLFormElement>, target: BotTarget): Promise<void> => {
    event.preventDefault()
    if (!bot || savingQqId === target.id) return
    const form = event.currentTarget
    const raw = form.elements.namedItem('qqNumber')
    const value = raw instanceof HTMLInputElement ? raw.value.trim() : ''
    if (value && !validQqNumber(value)) {
      toast.error('QQ 号/群号需为 5–12 位数字')
      return
    }
    setSavingQqId(target.id)
    try {
      const updated = await api.bots.targets.update(bot.id, target.id, {
        qqNumber: value || null,
      })
      setTargets((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
      toast.success('QQ 号/群号已更新')
    } catch (updateError) {
      toast.error(toErrorMessage(updateError, '更新 QQ 号/群号失败，请重试'))
    } finally {
      setSavingQqId(null)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (!bot || !removeTarget) return
    setRemoving(true)
    try {
      await api.bots.targets.remove(bot.id, removeTarget.id)
      setTargets((previous) => previous.filter((item) => item.id !== removeTarget.id))
      toast.success(`已删除目标「${removeTarget.label}」`)
      setRemoveTarget(null)
      onChanged(Math.max(0, targets.length - 1))
    } catch (removeError) {
      toast.error(toErrorMessage(removeError, '删除目标失败，请重试'))
    } finally {
      setRemoving(false)
    }
  }

  if (!bot) {
    return (
      <Card title="目标">
        <EmptyState
          icon={<Users size={24} />}
          title="请选择一个 Bot"
          description="在顶部选择 Bot 后，可在这里维护命令与通知目标。"
        />
      </Card>
    )
  }

  return (
    <>
      <Card
        title="目标"
        description="目标决定哪些 QQ 频道/群组/用户可以接收通知；允许命令的目标可执行只读命令。"
        actions={<Badge tone="muted"><Users size={13} aria-hidden="true" /> {targets.length} 个</Badge>}
        loading={loading}
        error={error}
        onRetry={() => setReloadKey((value) => value + 1)}
      >
        <form className="bot-target-form" onSubmit={(event) => void handleAdd(event)} noValidate>
          <div className="bot-target-form-grid">
            <FormField
              label="平台目标 ID"
              htmlFor={`${fieldId}-external-id`}
              required
              error={fieldErrors.externalId}
              hint={externalIdHint()}
            >
              <input
                id={`${fieldId}-external-id`}
                className="input mono"
                value={externalId}
                onChange={(event) => {
                  setExternalId(event.target.value)
                  setFieldErrors((previous) => ({ ...previous, externalId: undefined }))
                }}
                autoComplete="off"
                spellCheck={false}
                placeholder="openid / group_openid / channel_id"
                maxLength={128}
                disabled={adding}
              />
            </FormField>
            <FormField
              label="名称"
              htmlFor={`${fieldId}-label`}
              required
              error={fieldErrors.label}
              hint="仅用于本页识别，可随时修改。"
            >
              <input
                id={`${fieldId}-label`}
                className="input"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value)
                  setFieldErrors((previous) => ({ ...previous, label: undefined }))
                }}
                autoComplete="off"
                placeholder="例如：运维告警频道"
                maxLength={80}
                disabled={adding}
              />
            </FormField>
            <FormField label="类型" htmlFor={`${fieldId}-kind`} hint="发布任务只支持频道/群组。">
              <div className="select-field bot-field-select">
                <select
                  id={`${fieldId}-kind`}
                  className="select"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as BotTargetKind)}
                  disabled={adding}
                >
                  {TARGET_KINDS.map((item) => (
                    <option key={item} value={item}>
                      {targetKindLabel(item)}
                    </option>
                  ))}
                </select>
              </div>
            </FormField>
            {kind !== 'channel' ? (
              <FormField
                label={`${targetQqLabel(kind)}（可选）`}
                htmlFor={`${fieldId}-qq-number`}
                error={fieldErrors.qqNumber}
                hint="仅用于页面识别；QQ 官方 Bot 回调不含真实号码，不会用于平台发送。"
              >
                <input
                  id={`${fieldId}-qq-number`}
                  className="input mono"
                  value={qqNumber}
                  onChange={(event) => {
                    setQqNumber(event.target.value)
                    setFieldErrors((previous) => ({ ...previous, qqNumber: undefined }))
                  }}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={12}
                  autoComplete="off"
                  placeholder="例如：123456789"
                  disabled={adding}
                />
              </FormField>
            ) : null}
            <FormField
              label="静默开始（可选）"
              htmlFor={`${fieldId}-quiet-start`}
              error={fieldErrors.quiet}
              hint="Asia/Shanghai；通知在窗口内延后到结束时刻，起止需同时填写。"
            >
              <input
                id={`${fieldId}-quiet-start`}
                className="input"
                type="time"
                value={quietStart}
                onChange={(event) => {
                  setQuietStart(event.target.value)
                  setFieldErrors((previous) => ({ ...previous, quiet: undefined }))
                }}
                disabled={adding}
              />
            </FormField>
            <FormField label="静默结束（可选）" htmlFor={`${fieldId}-quiet-end`} hint="与开始时间相同则不静默。">
              <input
                id={`${fieldId}-quiet-end`}
                className="input"
                type="time"
                value={quietEnd}
                onChange={(event) => {
                  setQuietEnd(event.target.value)
                  setFieldErrors((previous) => ({ ...previous, quiet: undefined }))
                }}
                disabled={adding}
              />
            </FormField>
          </div>
          <div className="bot-target-form-flags">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={allowCommands}
                onChange={(event) => setAllowCommands(event.target.checked)}
                disabled={adding}
              />
              <span>允许命令</span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={allowNotifications}
                onChange={(event) => setAllowNotifications(event.target.checked)}
                disabled={adding}
              />
              <span>接收通知</span>
            </label>
            <label className="checkbox-field" title="群/频道内成员无需逐个登记即可与 AI 对话；斜杠命令仍只限命令白名单用户">
              <input
                type="checkbox"
                checked={allowChat}
                onChange={(event) => setAllowChat(event.target.checked)}
                disabled={adding}
              />
              <span>允许 Chat</span>
            </label>
            <Button
              type="submit"
              variant="primary"
              icon={<Plus size={15} aria-hidden="true" />}
              loading={adding}
            >
              添加目标
            </Button>
          </div>
        </form>

        {inboundTargets.length > 0 ? (
          <div className="bot-inbound-targets">
            <h3 className="subsection-title">最近入站目标</h3>
            <p className="field-hint">来自最近的命令或 Chat 事件，只显示平台 ID 与用户；点击「登记」填入上方表单。</p>
            <ul className="bot-target-list">
              {inboundTargets.slice(0, 8).map((item) => (
                <li
                  key={`${item.targetExternalId}:${item.userId}`}
                  className="bot-target-item"
                >
                  <div className="bot-target-main">
                    <div className="bot-target-title-row">
                      <span className="bot-target-name">
                        {item.userName || item.userId.slice(-8)}
                      </span>
                      <Badge tone="muted">{targetKindLabel(item.targetKind)}</Badge>
                      {item.isDirect ? <Badge tone="info">私聊</Badge> : null}
                    </div>
                    <code className="bot-target-id">{item.targetExternalId}</code>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => handlePrefillInbound(item)}>
                    登记
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <h3 className="subsection-title bot-target-list-title">已配置目标</h3>
        {targets.length === 0 ? (
          <EmptyState
            compact
            icon={<Radio size={22} />}
            title="还没有目标"
            description="在上方填写平台目标 ID 与名称，添加后才能测试连接或发布消息。"
          />
        ) : (
          <ul className="bot-target-list">
            {targets.map((target) => {
              const busy = busyIds.has(target.id)
              return (
                <li key={target.id} className="bot-target-item">
                  <div className="bot-target-main">
                    <div className="bot-target-title-row">
                      <span className="bot-target-name">{target.label}</span>
                      <Badge tone="muted">{targetKindLabel(target.kind)}</Badge>
                      {target.quietStartMinute !== null && target.quietEndMinute !== null ? (
                        <Badge tone="info">
                          静默 {minuteToTime(target.quietStartMinute)}–{minuteToTime(target.quietEndMinute)}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="bot-target-meta">
                      <span className="bot-target-meta-label">平台目标 ID</span>
                      <code className="bot-target-id">{target.externalId}</code>
                    </p>
                    {target.kind !== 'channel' ? (
                      <form
                        className="bot-target-qq-form"
                        onSubmit={(event) => void handleSaveQqNumber(event, target)}
                      >
                        <label className="bot-target-qq-label" htmlFor={`${fieldId}-qq-${target.id}`}>
                          {targetQqLabel(target.kind)}
                        </label>
                        <input
                          key={`${target.id}:${target.qqNumber ?? ''}`}
                          id={`${fieldId}-qq-${target.id}`}
                          name="qqNumber"
                          className="input mono bot-target-qq-input"
                          defaultValue={target.qqNumber ?? ''}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={12}
                          autoComplete="off"
                          placeholder="未填写"
                          aria-label={`${target.label} ${targetQqLabel(target.kind)}`}
                          disabled={busy || savingQqId === target.id}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          loading={savingQqId === target.id}
                          disabled={busy}
                        >
                          保存
                        </Button>
                      </form>
                    ) : null}
                  </div>
                  <div className="bot-target-flags">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={target.allowCommands}
                        onChange={(event) => void handleToggle(target, { allowCommands: event.target.checked })}
                        disabled={busy}
                        aria-label={`${target.label} 允许命令`}
                      />
                      <span>允许命令</span>
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={target.allowNotifications}
                        onChange={(event) => void handleToggle(target, { allowNotifications: event.target.checked })}
                        disabled={busy}
                        aria-label={`${target.label} 接收通知`}
                      />
                      <span>接收通知</span>
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={target.allowChat}
                        onChange={(event) => void handleToggle(target, { allowChat: event.target.checked })}
                        disabled={busy}
                        aria-label={`${target.label} 允许 Chat`}
                      />
                      <span>允许 Chat</span>
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      icon={<Trash2 size={15} aria-hidden="true" />}
                      aria-label={`删除目标 ${target.label}`}
                      onClick={() => setRemoveTarget(target)}
                      disabled={busy || removing}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <p className="field-hint">
          命令只读：/help、/status、/backup、/world、/mc、/files；/help、/role、/reset、/forget 对普通用户开放。
          执行管理命令需同时满足：当前目标开启“允许命令”，且发送者已登记为“用户”类型并开启“允许命令”（管理员白名单）。
          开启“允许 Chat”后，目标内成员可发送普通消息与 AI 对话，不能执行斜杠命令；每 Bot×用户默认每分钟 30 次 Chat、
          每小时 120 次 AI 调用。QQ 群/频道只有 @Bot 消息触发（平台限制），C2C 私聊直接进入 Chat；仅支持文本。
        </p>
      </Card>

      <ConfirmDialog
        open={removeTarget !== null}
        title="删除目标"
        message={removeTarget ? `确定删除目标「${removeTarget.label}」？` : ''}
        details="删除后该目标不再接收通知，也不能再执行命令；历史投递记录会保留。"
        confirmText="删除目标"
        loading={removing}
        onConfirm={() => void handleRemove()}
        onClose={() => {
          if (!removing) setRemoveTarget(null)
        }}
      />
    </>
  )
}
