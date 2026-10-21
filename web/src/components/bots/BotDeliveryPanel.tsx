// 投递与发布分区：投递状态/重试，发布表单、定时任务与取消。
// 安全边界：只展示队列状态，不执行 Bot 命令；发布只允许管理员手动创建，媒体最多 1 个。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Inbox, ListChecks, RotateCcw, Send, XCircle } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type {
  BotDelivery,
  BotPublishJob,
  BotSummary,
  BotTarget,
} from '../../api/types'
import type { FileItem } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { FormField } from '../FormField'
import { useToast } from '../Toast'
import { BotMediaPicker } from './BotMediaPicker'
import {
  BOT_DELIVERY_KIND_LABELS,
  BOT_DELIVERY_STATUS_META,
  BOT_PUBLISH_STATUS_META,
  BOT_TEXT_LIMITS,
  publishableTargets,
  targetLabel,
} from '../../lib/bots'
import { formatBytes, formatDateTime, truncateText } from '../../lib/format'

interface BotDeliveryPanelProps {
  bot: BotSummary | null
  /** 页面级刷新令牌变化时重新拉取目标、投递与发布任务。 */
  refreshToken: number
  onChanged: () => void
}

function scheduleIso(value: string): { iso: string | null; error: string | null } {
  if (!value) return { iso: null, error: null }
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return { iso: null, error: '定时时间格式无效' }
  if (time <= Date.now()) return { iso: null, error: '定时时间必须晚于当前时间' }
  return { iso: new Date(time).toISOString(), error: null }
}

/** 投递与发布：左侧队列状态与重试，右侧发布表单与任务列表。 */
export function BotDeliveryPanel({ bot, refreshToken, onChanged }: BotDeliveryPanelProps) {
  const toast = useToast()
  const [targets, setTargets] = useState<BotTarget[]>([])
  const [deliveries, setDeliveries] = useState<BotDelivery[]>([])
  const [jobs, setJobs] = useState<BotPublishJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [publishTargetId, setPublishTargetId] = useState('')
  const [text, setText] = useState('')
  const [mediaId, setMediaId] = useState('')
  const [mediaFile, setMediaFile] = useState<FileItem | null>(null)
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<BotPublishJob | null>(null)
  const [canceling, setCanceling] = useState(false)
  const requestSeq = useRef(0)

  const botId = bot?.id ?? ''

  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (!botId) return
      const seq = ++requestSeq.current
      if (!silent) setLoading(true)
      setError(null)
      try {
        const [targetItems, deliveryItems, jobItems] = await Promise.all([
          api.bots.targets.list(botId),
          api.bots.deliveries.list(botId),
          api.bots.publish.list(botId),
        ])
        if (requestSeq.current !== seq) return
        setTargets(targetItems)
        setDeliveries(deliveryItems)
        setJobs(jobItems)
        setPublishTargetId((previous) => {
          const eligible = publishableTargets(targetItems)
          if (previous && eligible.some((target) => target.id === previous)) return previous
          return eligible[0]?.id ?? ''
        })
      } catch (loadError) {
        if (requestSeq.current === seq) {
          setError(toErrorMessage(loadError, '读取投递与发布数据失败'))
        }
      } finally {
        if (requestSeq.current === seq && !silent) setLoading(false)
      }
    },
    [botId],
  )

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const eligibleTargets = publishableTargets(targets)
  const textLimit = bot ? BOT_TEXT_LIMITS[bot.platform] : 4096

  const handleRetry = async (delivery: BotDelivery): Promise<void> => {
    if (!bot || retryingId) return
    setRetryingId(delivery.id)
    try {
      await api.bots.deliveries.retry(bot.id, delivery.id)
      toast.success('投递已重新排队')
      await load(true)
      onChanged()
    } catch (retryError) {
      toast.error(toErrorMessage(retryError, '重试投递失败，可能已不可重试'))
    } finally {
      setRetryingId(null)
    }
  }

  const handlePublish = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!bot || publishing) return
    setFormError(null)
    if (!publishTargetId) {
      setFormError('请选择一个频道或群组目标')
      return
    }
    if (!text.trim()) {
      setFormError('请输入发布内容')
      return
    }
    if (text.length > textLimit) {
      setFormError(`内容超过 ${textLimit} 字符上限`)
      return
    }
    const schedule = scheduleIso(scheduledAt)
    if (schedule.error) {
      setFormError(schedule.error)
      return
    }
    if (!/^\d{6}$/.test(totpCode)) {
      setFormError('请输入 6 位 TOTP 验证码（发布需要再认证）')
      return
    }
    setPublishing(true)
    try {
      const created = await api.bots.publish.create(bot.id, {
        targetId: publishTargetId,
        text: text.trim(),
        mediaFileIds: mediaId.trim() ? [mediaId.trim()] : [],
        scheduledAt: schedule.iso,
        totpCode,
      })
      setText('')
      setMediaId('')
      setMediaFile(null)
      setScheduledAt('')
      setTotpCode('')
      toast.success(created.scheduledAt ? '发布任务已排期' : '发布任务已创建')
      await load(true)
      onChanged()
    } catch (publishError) {
      setFormError(toErrorMessage(publishError, '创建发布任务失败，请检查目标与媒体文件'))
    } finally {
      setPublishing(false)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (!bot || !cancelTarget) return
    setCanceling(true)
    try {
      await api.bots.publish.cancel(bot.id, cancelTarget.id)
      toast.success('发布任务已取消')
      setCancelTarget(null)
      await load(true)
      onChanged()
    } catch (cancelError) {
      toast.error(toErrorMessage(cancelError, '取消发布任务失败，任务可能已开始发送'))
    } finally {
      setCanceling(false)
    }
  }

  if (!bot) {
    return (
      <Card title="投递与发布">
        <EmptyState
          icon={<Inbox size={24} />}
          title="请选择一个 Bot"
          description="在顶部选择 Bot 后，可查看投递状态并创建发布任务。"
        />
      </Card>
    )
  }

  return (
    <div className="bot-delivery-grid">
      <Card
        title="投递记录"
        description="通知、命令回复、发布与测试消息的发送状态；失败任务可重新排队。"
        actions={<Badge tone="muted"><Inbox size={13} aria-hidden="true" /> {deliveries.length} 条</Badge>}
        loading={loading}
        error={error}
        onRetry={() => void load()}
      >
        {deliveries.length === 0 ? (
          <EmptyState
            compact
            icon={<Inbox size={22} />}
            title="暂无投递记录"
            description="告警通知、测试消息与发布任务发送后会在这里出现。"
          />
        ) : (
          <ul className="bot-queue-list">
            {deliveries.map((delivery) => {
              const status = BOT_DELIVERY_STATUS_META[delivery.status]
              const retryable = delivery.status === 'failed' || delivery.status === 'dead'
              return (
                <li key={delivery.id} className="bot-queue-item">
                  <div className="bot-queue-head">
                    <div className="bot-queue-title">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="bot-queue-kind">
                        {BOT_DELIVERY_KIND_LABELS[delivery.kind]}
                      </span>
                    </div>
                    {retryable ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<RotateCcw size={14} aria-hidden="true" />}
                        loading={retryingId === delivery.id}
                        onClick={() => void handleRetry(delivery)}
                      >
                        重试
                      </Button>
                    ) : null}
                  </div>
                  <p className="bot-queue-summary">
                    目标：{targetLabel(targets, delivery.targetId)} · 尝试 {delivery.attempts} 次
                  </p>
                  <p className="bot-queue-meta">
                    创建 {formatDateTime(delivery.createdAt)}
                    {delivery.sentAt ? ` · 发送 ${formatDateTime(delivery.sentAt)}` : ''}
                    {delivery.nextAttemptAt ? ` · 下次重试 ${formatDateTime(delivery.nextAttemptAt)}` : ''}
                  </p>
                  {delivery.lastError ? (
                    <p className="bot-queue-error" role="alert">错误：{delivery.lastError}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card
        title="发布消息"
        description={`向频道/群组发布文本或单个媒体文件；${bot.platform === 'discord' ? 'Discord' : bot.platform === 'slack' ? 'Slack' : 'Telegram'} 文本上限 ${textLimit} 字符。`}
        actions={<Badge tone="accent"><Send size={13} aria-hidden="true" /> 手动发布</Badge>}
        error={error}
        onRetry={() => void load()}
      >
        <form className="bot-publish-form" onSubmit={(event) => void handlePublish(event)} noValidate>
          <FormField
            label="发布目标"
            htmlFor="bot-publish-target"
            required
            hint="只允许频道/群组；用户目标仅用于命令与通知。"
          >
            <div className="select-field bot-field-select">
              <select
                id="bot-publish-target"
                className="select"
                value={publishTargetId}
                onChange={(event) => setPublishTargetId(event.target.value)}
                disabled={publishing || eligibleTargets.length === 0}
              >
                {eligibleTargets.length === 0 ? <option value="">没有可发布的频道/群组</option> : null}
                {eligibleTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}（{target.kind === 'group' ? '群组' : '频道'}）
                  </option>
                ))}
              </select>
            </div>
          </FormField>

          {eligibleTargets.length === 0 ? (
            <div className="notice notice-warning">请先在“目标”分区添加频道或群组目标。</div>
          ) : null}

          <FormField
            label="发布内容"
            htmlFor="bot-publish-text"
            required
            hint={`${text.length} / ${textLimit} 字符；仅支持纯文本。`}
          >
            <textarea
              id="bot-publish-text"
              className="input bot-textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={4}
              maxLength={textLimit}
              placeholder="输入要发布到目标的文本…"
              disabled={publishing}
            />
          </FormField>

          <div className="bot-publish-row">
            <FormField
              label="媒体文件（可选）"
              htmlFor="bot-publish-media"
              hint="从云端普通文件选择 1 个（≤10 MiB）；也可粘贴文件 ID。"
            >
              <div className="bot-media-input">
                <input
                  id="bot-publish-media"
                  className="input mono"
                  value={mediaId}
                  onChange={(event) => {
                    setMediaId(event.target.value)
                    setMediaFile(null)
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="选择文件或粘贴文件 ID"
                  maxLength={64}
                  disabled={publishing}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMediaPickerOpen(true)}
                  disabled={publishing}
                >
                  选择文件
                </Button>
              </div>
              {mediaFile ? (
                <p className="bot-picker-selected">
                  已选：{mediaFile.name}（{formatBytes(mediaFile.size)}）
                </p>
              ) : null}
            </FormField>
            <FormField
              label="定时时间（可选）"
              htmlFor="bot-publish-schedule"
              hint="留空立即进入队列；按本地时区选择。"
            >
              <input
                id="bot-publish-schedule"
                className="input"
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                disabled={publishing}
              />
            </FormField>
          </div>

          <FormField
            label="TOTP 验证码"
            htmlFor="bot-publish-totp"
            required
            hint="发布=内容外发到第三方平台，需要当前 6 位 TOTP 再认证；验证码只用于本次请求，不会保存。"
          >
            <input
              id="bot-publish-totp"
              className="input mono"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              disabled={publishing}
            />
          </FormField>

          <p className="bot-publish-warning" role="note">
            发布内容与媒体会发送到外部平台；请确认目标与文件均不包含敏感信息。
          </p>

          {formError ? <p className="field-error" role="alert">{formError}</p> : null}

          <div className="form-actions">
            <Button
              type="submit"
              variant="primary"
              icon={<Send size={16} aria-hidden="true" />}
              loading={publishing}
              disabled={eligibleTargets.length === 0}
            >
              创建发布任务
            </Button>
          </div>
        </form>

        <h3 className="subsection-title bot-publish-jobs-title">发布任务</h3>
        {jobs.length === 0 ? (
          <EmptyState
            compact
            icon={<ListChecks size={22} />}
            title="暂无发布任务"
            description="在上方创建任务后，可在这里查看状态或取消未开始的任务。"
          />
        ) : (
          <ul className="bot-queue-list">
            {jobs.map((job) => {
              const status = BOT_PUBLISH_STATUS_META[job.status]
              const cancelable = job.status === 'queued' || job.status === 'draft'
              return (
                <li key={job.id} className="bot-queue-item">
                  <div className="bot-queue-head">
                    <div className="bot-queue-title">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="bot-queue-kind">发布</span>
                    </div>
                    {cancelable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        icon={<XCircle size={14} aria-hidden="true" />}
                        onClick={() => setCancelTarget(job)}
                      >
                        取消
                      </Button>
                    ) : null}
                  </div>
                  <p className="bot-queue-text" title={job.text}>{truncateText(job.text, 160)}</p>
                  <p className="bot-queue-summary">
                    目标：{targetLabel(targets, job.targetId)} · 尝试 {job.attempts} 次
                    {job.mediaFileIds.length > 0 ? ` · 媒体 ${job.mediaFileIds.join('、')}` : ''}
                  </p>
                  <p className="bot-queue-meta">
                    创建 {formatDateTime(job.createdAt)}
                    {job.scheduledAt ? ` · 计划 ${formatDateTime(job.scheduledAt)}` : ' · 立即发送'}
                    {job.sentAt ? ` · 发送 ${formatDateTime(job.sentAt)}` : ''}
                  </p>
                  {job.lastError ? (
                    <p className="bot-queue-error" role="alert">错误：{job.lastError}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <BotMediaPicker
        open={mediaPickerOpen}
        onClose={() => setMediaPickerOpen(false)}
        onSelect={(file) => {
          setMediaId(file.id)
          setMediaFile(file)
        }}
      />

      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消发布任务"
        message={cancelTarget ? `确定取消发布任务「${truncateText(cancelTarget.text, 60)}」？` : ''}
        details="仅排队中的任务可取消；开始发送后取消会失败。"
        confirmText="取消任务"
        loading={canceling}
        onConfirm={() => void handleCancel()}
        onClose={() => {
          if (!canceling) setCancelTarget(null)
        }}
      />
    </div>
  )
}
