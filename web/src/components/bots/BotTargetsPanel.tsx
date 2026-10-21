// Bot 目标管理：新增、启停命令/通知权限、删除。
// 目标 externalId 由平台生成并直接传给服务端；页面不解析其含义，也不发起任何命令。

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Radio, Trash2, Users } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BotSummary, BotTarget, BotTargetKind } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { FormField } from '../FormField'
import { useToast } from '../Toast'
import { targetKindLabel } from '../../lib/bots'

interface BotTargetsPanelProps {
  bot: BotSummary | null
  /** 页面级刷新令牌变化时重新拉取目标。 */
  refreshToken: number
  /** 目标增删后回传最新数量，供配置分区判断“测试连接”是否可用。 */
  onChanged: (targetCount: number) => void
}

const TARGET_KINDS: readonly BotTargetKind[] = ['channel', 'user', 'group']

function externalIdHint(bot: BotSummary): string {
  if (bot.platform === 'telegram') return '频道/群组使用负数 chat id（如 -1001234567890），用户使用数字 ID。'
  if (bot.platform === 'discord') return 'Discord 频道/用户 ID 为数字 Snowflake，可在开发者模式右键复制。'
  return 'Slack 频道 ID 形如 C01234567，用户 ID 形如 U01234567。'
}

/** 目标分区：先选 Bot，再维护目标与权限。 */
export function BotTargetsPanel({ bot, refreshToken, onChanged }: BotTargetsPanelProps) {
  const toast = useToast()
  const fieldId = useId()
  const [targets, setTargets] = useState<BotTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [externalId, setExternalId] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<BotTargetKind>('channel')
  const [allowCommands, setAllowCommands] = useState(false)
  const [allowNotifications, setAllowNotifications] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<{ externalId?: string; label?: string }>({})
  const [adding, setAdding] = useState(false)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [removeTarget, setRemoveTarget] = useState<BotTarget | null>(null)
  const [removing, setRemoving] = useState(false)

  const botId = bot?.id ?? ''

  useEffect(() => {
    if (!botId) {
      setTargets([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    api.bots.targets
      .list(botId)
      .then((items) => {
        if (active) setTargets(items)
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
    const nextErrors: { externalId?: string; label?: string } = {}
    if (!externalId.trim()) nextErrors.externalId = '请输入平台目标 ID'
    if (!label.trim()) nextErrors.label = '请输入目标名称'
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setAdding(true)
    try {
      const created = await api.bots.targets.create(bot.id, {
        externalId: externalId.trim(),
        label: label.trim(),
        kind,
        allowCommands,
        allowNotifications,
      })
      setTargets((previous) => [...previous, created])
      setExternalId('')
      setLabel('')
      setKind('channel')
      setAllowCommands(false)
      setAllowNotifications(true)
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
    patch: { allowCommands?: boolean; allowNotifications?: boolean },
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
        description="目标决定哪些频道/群组/用户可以接收通知；允许命令的目标可执行只读命令。"
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
              hint={externalIdHint(bot)}
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
                placeholder="频道/用户/群组 ID"
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
                    </div>
                    <code className="bot-target-id">{target.externalId}</code>
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
          命令只读：/help、/status、/backup、/world、/mc、/files。执行命令需同时满足：当前目标开启“允许命令”，
          且发送者已登记为“用户”类型并开启“允许命令”（显式用户白名单）。
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
