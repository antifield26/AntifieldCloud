/**
 * Bot 角色卡管理（管理员）：用户角色卡元数据/启停/删除与群聊目标角色卡。
 * 安全边界：列表只返回名字/长度/启停/时间，不返回角色设定正文；正文只落 DB。
 */
import type { DatabaseSync } from 'node:sqlite'
import { badRequest, notFound } from '../util/errors.ts'
import { nowIso } from '../util/time.ts'
import { normalizeRolePrompt, roleValidationMessage, validateRole } from './roles.ts'
import type { BotChatRoleStore } from './roles.ts'
import type { BotGroupRoleStore } from './group-roles.ts'
import type {
  BotGroupRoleDetail,
  BotGroupRoleSummary,
  BotRoleSummary,
  BotRow,
  BotServiceDeps,
  BotTargetRow,
} from './types.ts'

export interface BotRoleAdminDeps {
  db: DatabaseSync
  requireEnabled: () => void
  botRow: (id: string) => BotRow
  targetRowForBot: (botId: string, targetId: string) => BotTargetRow
  roles: BotChatRoleStore
  groupRoles: BotGroupRoleStore
  inboundUserNames: (botId: string) => Map<string, string | null>
  deleteRemoteSessions: (botId: string, filter: { userId: string }) => void
  audit: BotServiceDeps['audit']
}

export class BotRoleAdmin {
  private readonly deps: BotRoleAdminDeps

  constructor(deps: BotRoleAdminDeps) {
    this.deps = deps
  }

  /**
   * 角色卡管理列表：只返回元数据（名字/长度/启停/时间），不返回角色设定正文。
   * userName 取自最近入站目标记录（没有则为 null）。
   */
  listRoles(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotRoleSummary[]; total: number } {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    const names = this.deps.inboundUserNames(botId)
    const items = this.deps.roles.list(botId, limit, offset).map((item) => ({
      ...item,
      userName: names.get(item.userId) ?? null,
    }))
    return { items, total: this.deps.roles.count(botId) }
  }

  /** 启用/停用指定用户的角色卡；不存在时 404。 */
  setRoleEnabled(botId: string, userId: string, enabled: boolean): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const card = this.deps.roles.get(botId, userId)
    if (!card || !this.deps.roles.setEnabled(botId, userId, enabled)) throw notFound('角色卡不存在')
    this.deps.audit('bot.role.admin', `${botId}:${userId.slice(0, 64)}`, {
      action: enabled ? 'enable' : 'disable',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 删除角色卡，并清理该 Bot×用户的全部会话映射与远端会话（下次 Chat 重新创建会话）。 */
  deleteRole(botId: string, userId: string): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const card = this.deps.roles.get(botId, userId)
    if (!card || !this.deps.roles.remove(botId, userId)) throw notFound('角色卡不存在')
    this.deps.deleteRemoteSessions(botId, { userId })
    this.deps.db.prepare('DELETE FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?').run(botId, userId)
    this.deps.audit('bot.role.admin', `${botId}:${userId.slice(0, 64)}`, {
      action: 'delete',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 群聊角色卡列表：始终列出群聊目标，未配置时 role 元数据为空。 */
  listGroupRoles(botId: string): { items: BotGroupRoleSummary[] } {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    return { items: this.deps.groupRoles.list(botId) }
  }

  /** 群聊角色卡正文仅供管理员编辑；目标必须是群聊。 */
  getGroupRole(botId: string, targetId: string): BotGroupRoleDetail | null {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const target = this.deps.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.deps.groupRoles.getByTargetId(botId, targetId)
    if (!card) return null
    return {
      targetId: target.id,
      targetLabel: target.label,
      targetExternalId: target.external_id,
      name: card.name,
      prompt: card.prompt,
      enabled: card.enabled,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    }
  }

  /** 新建/覆盖群聊角色卡；正文只保存在 DB，不写入日志/审计。 */
  saveGroupRole(botId: string, targetId: string, name: string, prompt: string): BotGroupRoleDetail {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const target = this.deps.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const normalizedPrompt = normalizeRolePrompt(prompt)
    const trimmedName = name.trim()
    const error = validateRole(trimmedName, normalizedPrompt)
    if (error) throw badRequest(roleValidationMessage(error))
    const card = this.deps.groupRoles.save(target, trimmedName, normalizedPrompt)
    this.deps.audit('bot.group_role.admin', `${botId}:${targetId}`, {
      action: 'save',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
    return {
      targetId: target.id,
      targetLabel: target.label,
      targetExternalId: target.external_id,
      name: card.name,
      prompt: card.prompt,
      enabled: card.enabled,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    }
  }

  setGroupRoleEnabled(botId: string, targetId: string, enabled: boolean): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const target = this.deps.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.deps.groupRoles.getByTargetId(botId, targetId)
    if (!card || !this.deps.groupRoles.setEnabled(botId, targetId, enabled)) throw notFound('群聊角色卡不存在')
    this.deps.audit('bot.group_role.admin', `${botId}:${targetId}`, {
      action: enabled ? 'enable' : 'disable',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  deleteGroupRole(botId: string, targetId: string): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const target = this.deps.targetRowForBot(botId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.deps.groupRoles.getByTargetId(botId, targetId)
    if (!card || !this.deps.groupRoles.remove(botId, targetId)) throw notFound('群聊角色卡不存在')
    this.deps.audit('bot.group_role.admin', `${botId}:${targetId}`, {
      action: 'delete',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }
}
