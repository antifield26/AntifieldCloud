/**
 * Chatbot 出站队列（D-16 行为保持重构）：通知/命令回复/发布的入队、claim、退避、死信与清理。
 *
 * 安全边界（与重构前一致）：
 * - 内容只按目标发送；发布内容在入队前由 facade 校验长度/二次确认；
 * - partial（长文本分段中途失败）不自动重试，标记 failed 交人工确认；
 * - `sending` 超过 10 分钟视为进程中断并回队；通知静默时段只延迟 `next_attempt_at`。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import { AppError } from '../util/errors.ts'
import { isoAfterSeconds, nowIso } from '../util/time.ts'
import { newId } from '../util/ids.ts'
import type {
  ChatbotAdapter,
  ChatbotDeliveryRow,
  ChatbotPublishRow,
  ChatbotRow,
  ChatbotTargetRow,
} from './types.ts'
import { sanitizeExternalText, sentExternalIdsOf } from './inbound.ts'

/** 告警事件（与 ChatbotService 的 ChatbotAlertEvent 结构一致；由 facade 传入）。 */
export interface ChatbotAlertEvent {
  id: number | string
  event: string
  severity: string
  status: string
  title: string
  message: string
  createdAt: string
}

/** 目标静默时段：Asia/Shanghai 本地分钟；起止相等视为未配置。 */
function localMinute(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

function inQuietWindow(now: Date, target: ChatbotTargetRow): boolean {
  const start = target.quiet_start_minute
  const end = target.quiet_end_minute
  if (start === null || end === null || start === end) return false
  const minute = localMinute(now)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** 静默窗口结束时刻（最多向后找 24 小时，按上海本地分钟匹配）。 */
function quietUntil(now: Date, target: ChatbotTargetRow): Date {
  const end = target.quiet_end_minute ?? 0
  for (let offset = 1; offset <= 24 * 60; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 60_000)
    if (localMinute(candidate) === end) return candidate
  }
  return new Date(now.getTime() + 24 * 3_600_000)
}

export interface ChatbotQueueDeps {
  db: DatabaseSync
  config: Config
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  audit: (action: string, target: string | null, detail?: Record<string, unknown>) => void
  chatbotRow: (id: string) => ChatbotRow
  targetRow: (id: string) => ChatbotTargetRow
  publishRow: (id: string) => ChatbotPublishRow
  adapterFor: (chatbot: ChatbotRow) => ChatbotAdapter
  /** 测试可注入固定时钟（静默窗口/时间字段）。 */
  now?: () => Date
}

export class ChatbotQueue {
  private readonly deps: ChatbotQueueDeps
  private readonly db: DatabaseSync
  private readonly config: Config

  constructor(deps: ChatbotQueueDeps) {
    this.deps = deps
    this.db = deps.db
    this.config = deps.config
  }

  /** 进程重启/异常后，把长时间停留在 sending 的记录重新排队，避免永久卡死。 */
  recoverStaleQueue(): void {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
    try {
      this.db
        .prepare(
          "UPDATE chatbot_deliveries SET status = 'queued', next_attempt_at = NULL, updated_at = ? WHERE status = 'sending' AND updated_at < ?",
        )
        .run(nowIso(), cutoff)
      this.db
        .prepare("UPDATE chatbot_publish_jobs SET status = 'queued', updated_at = ? WHERE status = 'sending' AND updated_at < ?")
        .run(nowIso(), cutoff)
    } catch {
      // 恢复失败不阻断本轮投递。
    }
  }

  notifyAlert(event: ChatbotAlertEvent): void {
    const chatbots = this.db.prepare('SELECT * FROM chatbots WHERE enabled = 1').all() as unknown as ChatbotRow[]
    for (const chatbot of chatbots) {
      const targets = this.db
        .prepare('SELECT * FROM chatbot_targets WHERE chatbot_id = ? AND allow_notifications = 1')
        .all(chatbot.id) as unknown as ChatbotTargetRow[]
      for (const target of targets) {
        const text = [
          `【${event.severity}】${sanitizeExternalText(event.title)}`,
          sanitizeExternalText(event.message),
          `事件：${event.event}（${event.status}）`,
          `时间：${event.createdAt}`,
        ].join('\n')
        const now = this.deps.now?.() ?? new Date()
        const notBefore = inQuietWindow(now, target) ? quietUntil(now, target) : undefined
        this.enqueueDelivery(
          chatbot.id,
          target.id,
          'notification',
          { text },
          `alert:${event.id}:${chatbot.id}:${target.id}`,
          notBefore,
        )
      }
    }
  }

  async processDeliveries(): Promise<void> {
    const now = nowIso()
    const rows = this.db
      .prepare(
        `SELECT * FROM chatbot_deliveries WHERE status IN ('queued','failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND attempts < ? ORDER BY created_at ASC LIMIT 20`,
      )
      .all(now, this.config.chatbotDeliveryMaxAttempts) as unknown as ChatbotDeliveryRow[]
    for (const row of rows) {
      await this.deliverOne(row)
    }
  }

  private async deliverOne(row: ChatbotDeliveryRow): Promise<void> {
    const claimed = this.db
      .prepare("UPDATE chatbot_deliveries SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('queued','failed')")
      .run(nowIso(), row.id)
    if (Number(claimed.changes) !== 1) return
    const delivery = this.db.prepare('SELECT * FROM chatbot_deliveries WHERE id = ?').get(row.id) as unknown as ChatbotDeliveryRow
    if (delivery.status !== 'sending') return
    try {
      const chatbot = this.deps.chatbotRow(delivery.chatbot_id)
      if (!chatbot.enabled) throw new AppError(400, 'chatbot_disabled', 'Chatbot 已停用')
      const target = delivery.target_id ? this.deps.targetRow(delivery.target_id) : null
      if (!target) throw new AppError(400, 'target_missing', '目标不存在')
      const payload = JSON.parse(delivery.payload_json) as { text?: unknown }
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!text) throw new AppError(400, 'empty_payload', '投递内容为空')
      const adapter = this.deps.adapterFor(chatbot)
      const result = await adapter.send(target, { text })
      this.db
        .prepare(
          "UPDATE chatbot_deliveries SET status = 'sent', external_id = ?, sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?",
        )
        .run(result.externalId, nowIso(), nowIso(), delivery.id)
    } catch (error) {
      this.failDelivery(delivery, error)
    }
  }

  private failDelivery(delivery: ChatbotDeliveryRow, error: unknown): void {
    const attempts = delivery.attempts + 1
    const message = error instanceof Error ? error.message.slice(0, 500) : '投递失败'
    const sentIds = sentExternalIdsOf(error)
    if (sentIds.length > 0) {
      // 长消息已部分外发：自动重试会重复发送，标记 failed 且 attempts 用尽，交人工确认。
      this.db
        .prepare(
          "UPDATE chatbot_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(
          this.config.chatbotDeliveryMaxAttempts,
          `partial_text_sent（已发送 ${sentIds.length} 段）：${message}`.slice(0, 500),
          nowIso(),
          delivery.id,
        )
      this.deps.log('warn', 'Chatbot 投递部分外发，停止自动重试', {
        chatbot: delivery.chatbot_id,
        delivery: delivery.id,
        sent: sentIds.length,
      })
      this.deps.audit('chatbot.delivery.partial', `${delivery.chatbot_id}:${delivery.id}`, { sent: sentIds.length })
      return
    }
    if (attempts >= this.config.chatbotDeliveryMaxAttempts) {
      this.db
        .prepare("UPDATE chatbot_deliveries SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, nowIso(), delivery.id)
      this.deps.log('warn', 'Chatbot 投递进入死信', { chatbot: delivery.chatbot_id, delivery: delivery.id })
      return
    }
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(6, attempts))
    this.db
      .prepare(
        "UPDATE chatbot_deliveries SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(attempts, message, isoAfterSeconds(delaySeconds, new Date()), nowIso(), delivery.id)
  }

  async processPublishJobs(): Promise<void> {
    const now = nowIso()
    const rows = this.db
      .prepare(
        `SELECT * FROM chatbot_publish_jobs WHERE status = 'queued'
         AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY scheduled_at ASC LIMIT 10`,
      )
      .all(now) as unknown as ChatbotPublishRow[]
    for (const row of rows) {
      await this.publishOne(row)
    }
  }

  private async publishOne(row: ChatbotPublishRow): Promise<void> {
    const claimed = this.db
      .prepare("UPDATE chatbot_publish_jobs SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso(), row.id)
    if (Number(claimed.changes) !== 1) return
    const job = this.deps.publishRow(row.id)
    if (job.status !== 'sending') return
    try {
      const chatbot = this.deps.chatbotRow(job.chatbot_id)
      if (!chatbot.enabled) throw new AppError(400, 'chatbot_disabled', 'Chatbot 已停用')
      const target = this.deps.targetRow(job.target_id)
      const content = JSON.parse(job.content_json) as { text?: unknown }
      const text = typeof content.text === 'string' ? content.text : ''
      if (!text) throw new AppError(400, 'empty_payload', '发布内容为空')
      const adapter = this.deps.adapterFor(chatbot)
      const result = await adapter.send(target, { text })
      if (result.partial) {
        const message = 'partial_text_sent：部分段落已发送，需人工确认后重建发布任务'
        this.db
          .prepare("UPDATE chatbot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .run(this.config.chatbotDeliveryMaxAttempts, message, nowIso(), job.id)
        this.deps.audit('chatbot.publish.partial', `${chatbot.id}:${job.id}`)
        return
      }
      this.db
        .prepare("UPDATE chatbot_publish_jobs SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?")
        .run(nowIso(), nowIso(), job.id)
      this.deps.audit('chatbot.publish.sent', `${chatbot.id}:${job.id}`, { externalId: result.externalId })
    } catch (error) {
      this.failPublish(job, error)
    }
  }

  private failPublish(job: ChatbotPublishRow, error: unknown): void {
    const attempts = job.attempts + 1
    const partialIds = sentExternalIdsOf(error)
    const message = error instanceof Error ? error.message.slice(0, 500) : '发布失败'
    if (partialIds.length > 0) {
      // 长文本已部分外发，自动重试会重复发送；保留证据交管理员人工重建。
      this.db
        .prepare("UPDATE chatbot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(
          this.config.chatbotDeliveryMaxAttempts,
          `partial_text_sent（已发送 ${partialIds.length} 段）：${message}`.slice(0, 500),
          nowIso(),
          job.id,
        )
      this.deps.audit('chatbot.publish.partial', `${job.chatbot_id}:${job.id}`, { sent: partialIds.length })
      return
    }
    if (attempts >= this.config.chatbotDeliveryMaxAttempts) {
      this.db
        .prepare("UPDATE chatbot_publish_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(attempts, message, nowIso(), job.id)
      return
    }
    const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(6, attempts))
    this.db
      .prepare(
        "UPDATE chatbot_publish_jobs SET status = 'queued', attempts = ?, last_error = ?, scheduled_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(attempts, message, isoAfterSeconds(delaySeconds), nowIso(), job.id)
  }

  /** 入队通知/命令回复/发布；dedupe_key 唯一，重复告警不重复外发。 */
  enqueueDelivery(
    chatbotId: string,
    targetId: string | null,
    kind: ChatbotDeliveryRow['kind'],
    payload: Record<string, unknown>,
    dedupeKey: string | null,
    notBefore?: Date,
  ): void {
    const now = nowIso()
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO chatbot_deliveries
           (id, chatbot_id, target_id, kind, dedupe_key, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        )
        .run(
          newId(),
          chatbotId,
          targetId,
          kind,
          dedupeKey,
          JSON.stringify(payload),
          notBefore ? notBefore.toISOString() : null,
          now,
          now,
        )
    } catch {
      // 队列写入失败不应影响告警/请求主路径。
    }
  }

  /** 管理端手动重投：只允许 failed/dead。 */
  retryDelivery(chatbotId: string, deliveryId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE chatbot_deliveries SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND chatbot_id = ? AND status IN ('failed','dead')",
      )
      .run(deliveryId, chatbotId)
    return Number(result.changes) > 0
  }

  /** 管理端“发送测试消息”：直接发送并记录一条已发送的 test 投递。 */
  async sendTest(chatbot: ChatbotRow, target: ChatbotTargetRow): Promise<void> {
    const adapter = this.deps.adapterFor(chatbot)
    const result = await adapter.send(target, { text: 'AntifieldComplexx Chatbot 测试消息：配置可用。' })
    this.db
      .prepare(
        `INSERT INTO chatbot_deliveries (id, chatbot_id, target_id, kind, payload_json, status, attempts, external_id, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, 'test', ?, 'sent', 1, ?, ?, ?, ?)`,
      )
      .run(newId(), chatbot.id, target.id, JSON.stringify({ text: 'test' }), result.externalId, nowIso(), nowIso(), nowIso())
    this.deps.audit('chatbot.test', `${chatbot.id}:${target.id}`)
  }

  /** 已发送/永久失败记录与发布任务 TTL（默认 30 天）。 */
  cleanupExpired(): void {
    const deliveryCutoff = new Date(Date.now() - 30 * 86400_000).toISOString()
    this.db.prepare('DELETE FROM chatbot_deliveries WHERE sent_at IS NOT NULL AND sent_at < ?').run(deliveryCutoff)
    this.db.prepare('DELETE FROM chatbot_publish_jobs WHERE sent_at IS NOT NULL AND sent_at < ?').run(deliveryCutoff)
    // 永久失败/死信也需要 TTL，避免 Chatbot 长期运行后队列无限增长。
    this.db.prepare("DELETE FROM chatbot_deliveries WHERE status IN ('dead','failed') AND updated_at < ?").run(deliveryCutoff)
    this.db.prepare("DELETE FROM chatbot_publish_jobs WHERE status = 'failed' AND updated_at < ?").run(deliveryCutoff)
  }
}

/** 测试/诊断用：静默窗口辅助函数（仅供单测引用，不改变服务语义）。 */
export const __queueInternals = { localMinute, inQuietWindow, quietUntil }
