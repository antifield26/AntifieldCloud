/**
 * Chatbot 出站可用性快照：只读聚合投递/发布队列，供管理状态与告警条件共用。
 *
 * 安全边界：只统计计数、时间与脱敏错误提示；不读取消息正文、目标外部 ID 或任何凭据。
 * 历史死信只计入总数；是否 degraded 只看当前窗口内的失败，并由最近成功时间恢复。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import { describeBotError } from './errors.ts'

export interface ChatbotOutboundHealth {
  /** Chatbot 总开关开启且存在 enabled bot 时为 true；否则 false。 */
  active: boolean
  /** 当前窗口内失败且晚于最近成功；无 active bot 时为 null。 */
  degraded: boolean | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  lastErrorHint: string | null
  queuedDeliveries: number
  failedDeliveries: number
  deadDeliveries: number
  queuedPublishes: number
  failedPublishes: number
  /** 当前窗口内 failed/dead 投递 + failed 发布任务数。 */
  recentFailures: number
  windowMinutes: number
}

interface CountRow {
  c: number
}

interface DeliveryAggRow {
  queued: number | null
  failed: number | null
  dead: number | null
  recent: number | null
  last_success: string | null
  last_failure: string | null
}

interface PublishAggRow {
  queued: number | null
  failed: number | null
  recent: number | null
  last_success: string | null
  last_failure: string | null
}

interface ErrorRow {
  last_error: string
}

const ENABLED_BOTS_SQL = 'SELECT id FROM chatbots WHERE enabled = 1'

/** 读取只读出站健康快照；now 仅用于窗口计算与确定性测试。 */
export function readOutboundHealth(
  db: DatabaseSync,
  config: Config,
  now: Date = new Date(),
): ChatbotOutboundHealth {
  const windowMinutes = config.chatbotOutboundFailureWindowMinutes
  const empty: ChatbotOutboundHealth = {
    active: false,
    degraded: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastErrorHint: null,
    queuedDeliveries: 0,
    failedDeliveries: 0,
    deadDeliveries: 0,
    queuedPublishes: 0,
    failedPublishes: 0,
    recentFailures: 0,
    windowMinutes,
  }

  try {
    const bots = db.prepare('SELECT COUNT(*) AS c FROM chatbots WHERE enabled = 1').get() as unknown as CountRow
    if (!config.chatbotEnabled || bots.c === 0) return empty

    const cutoff = new Date(now.getTime() - windowMinutes * 60_000).toISOString()
    const deliveries = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
           SUM(CASE WHEN status IN ('failed','dead') AND updated_at >= ? THEN 1 ELSE 0 END) AS recent,
           MAX(CASE WHEN status = 'sent' THEN sent_at END) AS last_success,
           MAX(CASE WHEN status IN ('failed','dead') THEN updated_at END) AS last_failure
         FROM chatbot_deliveries
         WHERE chatbot_id IN (${ENABLED_BOTS_SQL})`,
      )
      .get(cutoff) as unknown as DeliveryAggRow
    const publishes = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS recent,
           MAX(CASE WHEN status = 'sent' THEN sent_at END) AS last_success,
           MAX(CASE WHEN status = 'failed' THEN updated_at END) AS last_failure
         FROM chatbot_publish_jobs
         WHERE chatbot_id IN (${ENABLED_BOTS_SQL})`,
      )
      .get(cutoff) as unknown as PublishAggRow

    const lastErrorRow = db
      .prepare(
        `SELECT last_error FROM (
           SELECT last_error, updated_at FROM chatbot_deliveries
           WHERE chatbot_id IN (${ENABLED_BOTS_SQL}) AND last_error IS NOT NULL
           UNION ALL
           SELECT last_error, updated_at FROM chatbot_publish_jobs
           WHERE chatbot_id IN (${ENABLED_BOTS_SQL}) AND last_error IS NOT NULL
         ) ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as ErrorRow | undefined
    const lastError = lastErrorRow?.last_error ?? null

    const queuedDeliveries = Number(deliveries.queued ?? 0)
    const failedDeliveries = Number(deliveries.failed ?? 0)
    const deadDeliveries = Number(deliveries.dead ?? 0)
    const queuedPublishes = Number(publishes.queued ?? 0)
    const failedPublishes = Number(publishes.failed ?? 0)
    const recentFailures = Number(deliveries.recent ?? 0) + Number(publishes.recent ?? 0)
    const lastSuccessAt = laterIso(deliveries.last_success, publishes.last_success)
    const lastFailureAt = laterIso(deliveries.last_failure, publishes.last_failure)
    const failureAfterSuccess =
      lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt)
    const degraded =
      recentFailures >= config.chatbotOutboundFailureThreshold && failureAfterSuccess

    return {
      active: true,
      degraded,
      lastSuccessAt,
      lastFailureAt,
      lastError,
      lastErrorHint: describeBotError(lastError),
      queuedDeliveries,
      failedDeliveries,
      deadDeliveries,
      queuedPublishes,
      failedPublishes,
      recentFailures,
      windowMinutes,
    }
  } catch {
    // 健康查询失败不应让管理状态/告警评估整体失败；返回非 active，避免误 firing。
    return empty
  }
}

function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return a >= b ? a : b
}
