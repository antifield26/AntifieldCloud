/**
 * Bot 目标管理：目标 CRUD、入站目标发现与输入校验。
 * 安全边界：只操作 bot_targets/bot_inbound_targets；静默时段/群消息模式在此收敛，
 * 删除/改类型后的群共享记忆清理由 BotService 注入回调。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError, badRequest } from '../util/errors.ts'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import { cleanText, normalizeGroupReplyMode } from './inbound.ts'
import type { BotGroupRoleStore } from './group-roles.ts'
import type {
  BotInboundTarget,
  BotInboundTargetRow,
  BotRow,
  BotServiceDeps,
  BotTarget,
  BotTargetRow,
  GroupReplyMode,
} from './types.ts'

export interface CreateTargetInput {
  externalId: string
  label: string
  kind: 'channel' | 'user' | 'group'
  allowCommands: boolean
  allowNotifications: boolean
  allowChat?: boolean
  /** 仅群聊目标：mention=仅 @/名字提及；all=全部消息（实验性）。 */
  groupReplyMode?: GroupReplyMode
  quietStartMinute?: number | null
  quietEndMinute?: number | null
}

export interface UpdateTargetInput {
  label?: string
  kind?: 'channel' | 'user' | 'group'
  allowCommands?: boolean
  allowNotifications?: boolean
  allowChat?: boolean
  groupReplyMode?: GroupReplyMode
  quietStartMinute?: number | null
  quietEndMinute?: number | null
}

const TARGET_MAX = 128
const NAME_MAX = 64
const MAX_TARGETS_PER_BOT = 50

export function normalizeQuiet(
  start: number | null | undefined,
  end: number | null | undefined,
): { start: number | null; end: number | null } {
  const clean = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) return null
    if (!Number.isInteger(value) || value < 0 || value > 1439) throw badRequest('静默时段必须是 0-1439 分钟')
    return value
  }
  const cleanStart = clean(start)
  const cleanEnd = clean(end)
  if ((cleanStart === null) !== (cleanEnd === null)) throw badRequest('静默时段起止必须同时设置或同时留空')
  if (cleanStart !== null && cleanStart === cleanEnd) throw badRequest('静默时段起止不能相同')
  return { start: cleanStart, end: cleanEnd }
}

export function toTarget(row: BotTargetRow): BotTarget {
  return {
    id: row.id,
    botId: row.bot_id,
    externalId: row.external_id,
    label: row.label,
    kind: row.kind,
    allowCommands: row.allow_commands === 1,
    allowNotifications: row.allow_notifications === 1,
    allowChat: row.allow_chat === 1,
    groupReplyMode: row.chat_trigger,
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    createdAt: row.created_at,
  }
}

export interface BotTargetAdminDeps {
  db: DatabaseSync
  requireEnabled: () => void
  botRow: (id: string) => BotRow
  targetRow: (id: string) => BotTargetRow
  targetRowForBot: (botId: string, targetId: string) => BotTargetRow
  audit: BotServiceDeps['audit']
  groupRoles: BotGroupRoleStore
  dropGroupTargetMemory: (botId: string, targetExternalId: string) => void
  /** 目标删除/类型变更：清理该目标全部会话映射、远端会话与上下文文档。 */
  resetTargetSessions: (botId: string, targetExternalId: string) => void
}

export class BotTargetAdmin {
  private readonly deps: BotTargetAdminDeps

  constructor(deps: BotTargetAdminDeps) {
    this.deps = deps
  }

  listTargets(botId: string): BotTarget[] {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const rows = this.deps.db
      .prepare('SELECT * FROM bot_targets WHERE bot_id = ? ORDER BY created_at ASC')
      .all(botId) as unknown as BotTargetRow[]
    return rows.map(toTarget)
  }

  /** 最近入站目标发现：只含平台 ID/类型/用户名/时间，不含消息正文。 */
  listInboundTargets(botId: string, limit = 50): BotInboundTarget[] {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const rows = this.deps.db
      .prepare('SELECT * FROM bot_inbound_targets WHERE bot_id = ? ORDER BY last_seen_at DESC LIMIT ?')
      .all(botId, Math.max(1, Math.min(200, limit))) as unknown as BotInboundTargetRow[]
    return rows.map((row) => ({
      botId: row.bot_id,
      targetExternalId: row.target_external_id,
      targetKind: row.target_kind,
      userId: row.user_id,
      userName: row.user_name,
      isDirect: row.is_direct === 1,
      lastSeenAt: row.last_seen_at,
    }))
  }

  createTarget(botId: string, input: CreateTargetInput): BotTarget {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const externalId = cleanText(input.externalId, TARGET_MAX)
    const label = cleanText(input.label, NAME_MAX)
    if (!externalId || !label) throw badRequest('目标 ID 与名称不能为空')
    const count = this.deps.db.prepare('SELECT COUNT(*) AS c FROM bot_targets WHERE bot_id = ?').get(botId) as {
      c: number
    }
    if (count.c >= MAX_TARGETS_PER_BOT) throw badRequest('目标数量过多')
    const quiet = normalizeQuiet(input.quietStartMinute, input.quietEndMinute)
    const groupReplyMode = normalizeGroupReplyMode(input.groupReplyMode, input.kind)
    const id = newId()
    try {
      this.deps.db
        .prepare(
          `INSERT INTO bot_targets
           (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, allow_chat, chat_trigger, quiet_start_minute, quiet_end_minute, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          botId,
          externalId,
          label,
          input.kind,
          input.allowCommands ? 1 : 0,
          input.allowNotifications ? 1 : 0,
          input.allowChat ? 1 : 0,
          groupReplyMode,
          quiet.start,
          quiet.end,
          nowIso(),
        )
    } catch {
      throw new AppError(409, 'conflict', '该目标已存在')
    }
    this.deps.audit('bot.target.create', `${botId}:${id}`, { kind: input.kind })
    return toTarget(this.deps.targetRow(id))
  }

  updateTarget(botId: string, targetId: string, input: UpdateTargetInput): BotTarget {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const row = this.deps.targetRowForBot(botId, targetId)
    const label = input.label !== undefined ? cleanText(input.label, NAME_MAX) : row.label
    if (!label) throw badRequest('目标名称不能为空')
    const kind = input.kind ?? row.kind
    const groupReplyMode = normalizeGroupReplyMode(
      input.groupReplyMode === undefined
        ? kind === row.kind
          ? row.chat_trigger
          : undefined
        : input.groupReplyMode,
      kind,
    )
    const quiet = normalizeQuiet(
      input.quietStartMinute === undefined ? row.quiet_start_minute : input.quietStartMinute,
      input.quietEndMinute === undefined ? row.quiet_end_minute : input.quietEndMinute,
    )
    this.deps.db
      .prepare(
        `UPDATE bot_targets
         SET label = ?, kind = ?, allow_commands = ?, allow_notifications = ?, allow_chat = ?, chat_trigger = ?,
             quiet_start_minute = ?, quiet_end_minute = ?
         WHERE id = ?`,
      )
      .run(
        label,
        kind,
        input.allowCommands === undefined ? row.allow_commands : input.allowCommands ? 1 : 0,
        input.allowNotifications === undefined ? row.allow_notifications : input.allowNotifications ? 1 : 0,
        input.allowChat === undefined ? row.allow_chat : input.allowChat ? 1 : 0,
        groupReplyMode,
        quiet.start,
        quiet.end,
        targetId,
      )
    if (kind !== 'group') this.deps.groupRoles.remove(botId, targetId)
    if (kind !== row.kind) {
      // 类型变化会改变会话/记忆语义：清理该目标全部会话与上下文文档，避免旧作用域继续可读。
      this.deps.resetTargetSessions(botId, row.external_id)
    }
    // 目标从群聊改为其它类型后，原群共享记忆 scope 会变成不可管理的孤儿，直接清理。
    if (row.kind === 'group' && kind !== 'group') this.deps.dropGroupTargetMemory(botId, row.external_id)
    this.deps.audit('bot.target.update', `${botId}:${targetId}`)
    return toTarget(this.deps.targetRowForBot(botId, targetId))
  }

  deleteTarget(botId: string, targetId: string): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const row = this.deps.targetRowForBot(botId, targetId)
    this.deps.resetTargetSessions(botId, row.external_id)
    this.deps.db.prepare('DELETE FROM bot_targets WHERE id = ?').run(targetId)
    if (row.kind === 'group') this.deps.dropGroupTargetMemory(botId, row.external_id)
    this.deps.audit('bot.target.delete', `${botId}:${targetId}`)
  }
}
