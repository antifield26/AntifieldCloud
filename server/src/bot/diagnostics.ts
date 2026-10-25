/**
 * Bot 诊断/观测（D-16 行为保持重构）：入站事件元数据、投递/发布指标与最近错误。
 *
 * 安全边界（与重构前一致）：bot_events/bot_inbound_targets 只存元数据与短码，不存消息正文；
 * 管理接口只返回事件 ID/类型/结果/短码/目标/用户/时间。
 */
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from '../util/time.ts'
import { badRequest } from '../util/errors.ts'
import { describeBotError } from './errors.ts'
import type { BotEventItem, BotEventOutcome, BotInboundTargetRow, BotMetrics, BotRow, InboundVerification } from './types.ts'

const MAX_INBOUND_TARGETS_PER_BOT = 500
/** 诊断事件结果枚举；service 与 route 共用校验。 */
export const BOT_EVENT_OUTCOMES = ['received', 'ok', 'denied', 'rate_limited', 'ignored', 'error'] as const

export interface BotDiagnosticsDeps {
  db: DatabaseSync
}

/** 诊断事件/指标存储：纯 DB 操作，不含权限/开关校验（由 facade 负责）。 */
export class BotDiagnostics {
  private readonly db: DatabaseSync

  constructor(deps: BotDiagnosticsDeps) {
    this.db = deps.db
  }

  insertEvent(
    botId: string,
    eventId: string,
    kind: string,
    outcome: BotEventOutcome,
    detail: string | null,
    targetExternalId: string | null,
    userId: string | null,
  ): boolean {
    try {
      const now = nowIso()
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO bot_events
           (bot_id, platform_event_id, received_at, event_kind, outcome, detail, target_external_id, user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          botId,
          eventId,
          now,
          kind.slice(0, 32),
          outcome,
          detail === null ? null : detail.slice(0, 120),
          targetExternalId === null ? null : targetExternalId.slice(0, 128),
          userId === null ? null : userId.slice(0, 64),
          now,
        )
      return Number(inserted.changes) > 0
    } catch {
      // 诊断记录失败不影响消息主路径（按新事件继续处理）。
      return true
    }
  }

  /**
   * 更新事件最终结果。detail 只允许短码（如 command_denied/chat_ok/error code），
   * 禁止写入消息正文、文件路径或外部 ID 以外的内容。
   */
  markEvent(
    botId: string,
    eventId: string,
    update: { outcome: BotEventOutcome; detail?: string; target?: string; user?: string },
  ): void {
    try {
      this.db
        .prepare(
          `UPDATE bot_events SET outcome = ?, detail = ?,
             target_external_id = COALESCE(?, target_external_id),
             user_id = COALESCE(?, user_id), updated_at = ?
           WHERE bot_id = ? AND platform_event_id = ?`,
        )
        .run(
          update.outcome,
          update.detail === undefined ? null : update.detail.slice(0, 120),
          update.target === undefined ? null : update.target.slice(0, 128),
          update.user === undefined ? null : update.user.slice(0, 64),
          nowIso(),
          botId,
          eventId,
        )
    } catch {
      // 诊断更新失败不影响处理。
    }
  }

  recordInbound(bot: BotRow, result: Extract<InboundVerification, { kind: 'command' | 'chat' }>): void {
    try {
      this.db
        .prepare(
          `INSERT INTO bot_inbound_targets
           (bot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, target_external_id, user_id) DO UPDATE SET
             target_kind = excluded.target_kind,
             user_name = excluded.user_name,
             is_direct = excluded.is_direct,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          bot.id,
          result.targetExternalId,
          result.targetKind,
          result.userId,
          result.userName,
          result.isDirect ? 1 : 0,
          nowIso(),
        )
      const count = this.db
        .prepare('SELECT COUNT(*) AS c FROM bot_inbound_targets WHERE bot_id = ?')
        .get(bot.id) as { c: number }
      if (count.c > MAX_INBOUND_TARGETS_PER_BOT) {
        this.db
          .prepare(
            `DELETE FROM bot_inbound_targets WHERE rowid IN (
               SELECT rowid FROM bot_inbound_targets WHERE bot_id = ? ORDER BY last_seen_at ASC LIMIT ?
             )`,
          )
          .run(bot.id, count.c - MAX_INBOUND_TARGETS_PER_BOT)
      }
    } catch {
      // 发现记录失败不影响命令/会话主路径。
    }
  }

  /** 入站目标列表（管理端只读诊断，不含正文）。 */
  listInboundTargets(botId: string, limit = 200): BotInboundTargetRow[] {
    return this.db
      .prepare(
        `SELECT * FROM bot_inbound_targets WHERE bot_id = ? ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(botId, Math.max(1, Math.min(500, limit))) as unknown as BotInboundTargetRow[]
  }

  /**
   * 诊断事件列表：按 received_at DESC 分页；只含元数据（事件 ID/类型/结果/短码/目标/用户/时间）。
   * outcome 缺省返回全部，非法值直接 400。
   */
  listEvents(
    botId: string,
    options: { hours?: number; limit?: number; offset?: number; outcome?: string } = {},
  ): { items: BotEventItem[]; total: number } {
    const rawHours = Number(options.hours)
    const hours = Math.max(1, Math.min(720, Math.floor(Number.isFinite(rawHours) ? rawHours : 24)))
    const rawLimit = Number(options.limit)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 50)))
    const rawOffset = Number(options.offset)
    const offset = Math.max(0, Math.floor(Number.isFinite(rawOffset) ? rawOffset : 0))
    const outcome = typeof options.outcome === 'string' && options.outcome.trim() ? options.outcome.trim() : null
    if (outcome !== null && !(BOT_EVENT_OUTCOMES as readonly string[]).includes(outcome)) {
      throw badRequest('事件结果筛选值无效')
    }
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
    const where = outcome === null ? 'bot_id = ? AND received_at >= ?' : 'bot_id = ? AND received_at >= ? AND outcome = ?'
    const params: (string | number)[] = outcome === null ? [botId, cutoff] : [botId, cutoff, outcome]
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM bot_events WHERE ${where}`).get(...params) as { c: number }
    const rows = this.db
      .prepare(
        `SELECT platform_event_id, event_kind, outcome, detail, target_external_id, user_id, received_at, updated_at
         FROM bot_events WHERE ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as Array<{
      platform_event_id: string
      event_kind: string | null
      outcome: string | null
      detail: string | null
      target_external_id: string | null
      user_id: string | null
      received_at: string
      updated_at: string | null
    }>
    return {
      total: totalRow.c,
      items: rows.map((row) => ({
        eventId: row.platform_event_id,
        kind: row.event_kind,
        outcome: row.outcome,
        detail: row.detail,
        targetExternalId: row.target_external_id,
        userId: row.user_id,
        receivedAt: row.received_at,
        updatedAt: row.updated_at,
      })),
    }
  }

  /** 投递/发布/事件指标（近 N 小时）与最近错误/最近发送时间。 */
  metrics(botId: string, hours = 24): BotMetrics {
    const windowHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)))
    const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString()
    const deliveries = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
         FROM bot_deliveries WHERE bot_id = ? AND created_at >= ?`,
      )
      .get(botId, cutoff) as { total: number; sent: number | null; failed: number | null; dead: number | null }
    const publishes = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM bot_publish_jobs WHERE bot_id = ? AND created_at >= ?`,
      )
      .get(botId, cutoff) as { total: number; sent: number | null; failed: number | null }
    const events = this.db
      .prepare('SELECT COUNT(*) AS c FROM bot_events WHERE bot_id = ? AND received_at >= ?')
      .get(botId, cutoff) as { c: number }
    const lastError = this.db
      .prepare(
        `SELECT last_error FROM (
           SELECT last_error, updated_at FROM bot_deliveries WHERE bot_id = ? AND last_error IS NOT NULL
           UNION ALL
           SELECT last_error, updated_at FROM bot_publish_jobs WHERE bot_id = ? AND last_error IS NOT NULL
         ) ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(botId, botId) as { last_error: string } | undefined
    const lastSent = this.db
      .prepare(
        `SELECT sent_at FROM (
           SELECT sent_at FROM bot_deliveries WHERE bot_id = ? AND sent_at IS NOT NULL
           UNION ALL
           SELECT sent_at FROM bot_publish_jobs WHERE bot_id = ? AND sent_at IS NOT NULL
         ) ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(botId, botId) as { sent_at: string } | undefined
    const attempted = Number(deliveries.sent ?? 0) + Number(deliveries.failed ?? 0)
    return {
      hours: windowHours,
      deliveries: {
        total: deliveries.total,
        sent: Number(deliveries.sent ?? 0),
        failed: Number(deliveries.failed ?? 0),
        dead: Number(deliveries.dead ?? 0),
        successRate: attempted === 0 ? 0 : Math.round((Number(deliveries.sent ?? 0) / attempted) * 1000) / 10,
      },
      publishes: {
        total: publishes.total,
        sent: Number(publishes.sent ?? 0),
        failed: Number(publishes.failed ?? 0),
      },
      events: events.c,
      lastError: lastError?.last_error ?? null,
      lastErrorHint: describeBotError(lastError?.last_error ?? null),
      lastSentAt: lastSent?.sent_at ?? null,
    }
  }

  /**
   * 最近一次投递/发布失败（BOT-07）：`bots.last_error` 没有写入点，直接派生自队列，
   * 避免 `/api/bots/status` 与 Bot 列表的 lastError 永远是 null（与 metrics.lastError 语义一致）。
   */
  findLatestError(botId: string | null, fallback: string | null = null): string | null {
    const row =
      botId === null
        ? (this.db
            .prepare(
              `SELECT last_error FROM (
                 SELECT last_error, updated_at FROM bot_deliveries WHERE last_error IS NOT NULL
                 UNION ALL
                 SELECT last_error, updated_at FROM bot_publish_jobs WHERE last_error IS NOT NULL
               ) ORDER BY updated_at DESC LIMIT 1`,
            )
            .get() as { last_error: string } | undefined)
        : (this.db
            .prepare(
              `SELECT last_error FROM (
                 SELECT last_error, updated_at FROM bot_deliveries WHERE bot_id = ? AND last_error IS NOT NULL
                 UNION ALL
                 SELECT last_error, updated_at FROM bot_publish_jobs WHERE bot_id = ? AND last_error IS NOT NULL
               ) ORDER BY updated_at DESC LIMIT 1`,
            )
            .get(botId, botId) as { last_error: string } | undefined)
    return row?.last_error ?? fallback
  }
}
