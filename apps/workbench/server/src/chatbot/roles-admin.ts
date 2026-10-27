/**
 * Chatbot 角色卡管理（管理员）：用户角色卡元数据/启停/删除与群聊目标角色卡。
 * 安全边界：列表只返回名字/长度/启停/时间，不返回角色设定正文；正文只落 DB。
 */
import type { DatabaseSync } from 'node:sqlite'
import { badRequest, notFound } from '../util/errors.ts'
import { nowIso } from '../util/time.ts'
import { normalizeRolePrompt, roleValidationMessage, validateRole } from './roles.ts'
import type { ChatbotChatRoleStore } from './roles.ts'
import type { ChatbotGroupRoleStore } from './group-roles.ts'
import type {
  ChatbotGroupRoleDetail,
  ChatbotGroupRoleSummary,
  ChatbotRoleSummary,
  ChatbotRow,
  ChatbotServiceDeps,
  ChatbotTargetRow,
} from './types.ts'

export interface ChatbotRoleAdminDeps {
  db: DatabaseSync
  requireEnabled: () => void
  chatbotRow: (id: string) => ChatbotRow
  targetRowForBot: (chatbotId: string, targetId: string) => ChatbotTargetRow
  roles: ChatbotChatRoleStore
  groupRoles: ChatbotGroupRoleStore
  inboundUserNames: (chatbotId: string) => Map<string, string | null>
  /** 私聊角色变更：清理该用户全部会话映射/远端会话/上下文文档。 */
  resetUserSessions: (chatbotId: string, userId: string) => void
  /** 群聊角色变更：清理该群共享会话与群作用域文档。 */
  resetGroupSessions: (chatbotId: string, targetExternalId: string) => void
  audit: ChatbotServiceDeps['audit']
}

export class ChatbotRoleAdmin {
  private readonly deps: ChatbotRoleAdminDeps

  constructor(deps: ChatbotRoleAdminDeps) {
    this.deps = deps
  }

  /**
   * 角色卡管理列表：只返回元数据（名字/长度/启停/时间），不返回角色设定正文。
   * userName 取自最近入站目标记录（没有则为 null）。
   */
  listRoles(
    chatbotId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: ChatbotRoleSummary[]; total: number } {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    const names = this.deps.inboundUserNames(chatbotId)
    const items = this.deps.roles.list(chatbotId, limit, offset).map((item) => ({
      ...item,
      userName: names.get(item.userId) ?? null,
    }))
    return { items, total: this.deps.roles.count(chatbotId) }
  }

  /** 启用/停用指定用户的角色卡；不存在时 404。角色卡在会话创建时发送，变化后必须重建会话。 */
  setRoleEnabled(chatbotId: string, userId: string, enabled: boolean): void {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const card = this.deps.roles.get(chatbotId, userId)
    if (!card || !this.deps.roles.setEnabled(chatbotId, userId, enabled)) throw notFound('角色卡不存在')
    this.deps.resetUserSessions(chatbotId, userId)
    this.deps.audit('chatbot.role.admin', `${chatbotId}:${userId.slice(0, 64)}`, {
      action: enabled ? 'enable' : 'disable',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 删除角色卡，并清理该 Chatbot×用户的全部会话映射、远端会话与上下文文档（下次 Chat 重新创建会话）。 */
  deleteRole(chatbotId: string, userId: string): void {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const card = this.deps.roles.get(chatbotId, userId)
    if (!card || !this.deps.roles.remove(chatbotId, userId)) throw notFound('角色卡不存在')
    this.deps.resetUserSessions(chatbotId, userId)
    this.deps.audit('chatbot.role.admin', `${chatbotId}:${userId.slice(0, 64)}`, {
      action: 'delete',
      user: userId.slice(0, 64),
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  /** 群聊角色卡列表：始终列出群聊目标，未配置时 role 元数据为空。 */
  listGroupRoles(chatbotId: string): { items: ChatbotGroupRoleSummary[] } {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    return { items: this.deps.groupRoles.list(chatbotId) }
  }

  /** 群聊角色卡正文仅供管理员编辑；目标必须是群聊。 */
  getGroupRole(chatbotId: string, targetId: string): ChatbotGroupRoleDetail | null {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const target = this.deps.targetRowForBot(chatbotId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.deps.groupRoles.getByTargetId(chatbotId, targetId)
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
  saveGroupRole(chatbotId: string, targetId: string, name: string, prompt: string): ChatbotGroupRoleDetail {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const target = this.deps.targetRowForBot(chatbotId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const normalizedPrompt = normalizeRolePrompt(prompt)
    const trimmedName = name.trim()
    const error = validateRole(trimmedName, normalizedPrompt)
    if (error) throw badRequest(roleValidationMessage(error))
    const card = this.deps.groupRoles.save(target, trimmedName, normalizedPrompt)
    // 群角色卡只在会话创建时发送，变更后重建该群共享会话，避免旧会话继续用旧角色。
    this.deps.resetGroupSessions(chatbotId, target.external_id)
    this.deps.audit('chatbot.group_role.admin', `${chatbotId}:${targetId}`, {
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

  setGroupRoleEnabled(chatbotId: string, targetId: string, enabled: boolean): void {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const target = this.deps.targetRowForBot(chatbotId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.deps.groupRoles.getByTargetId(chatbotId, targetId)
    if (!card || !this.deps.groupRoles.setEnabled(chatbotId, targetId, enabled)) throw notFound('群聊角色卡不存在')
    this.deps.resetGroupSessions(chatbotId, target.external_id)
    this.deps.audit('chatbot.group_role.admin', `${chatbotId}:${targetId}`, {
      action: enabled ? 'enable' : 'disable',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }

  deleteGroupRole(chatbotId: string, targetId: string): void {
    this.deps.requireEnabled()
    this.deps.chatbotRow(chatbotId)
    const target = this.deps.targetRowForBot(chatbotId, targetId)
    if (target.kind !== 'group') throw badRequest('仅群聊目标支持独立角色卡')
    const card = this.deps.groupRoles.getByTargetId(chatbotId, targetId)
    if (!card || !this.deps.groupRoles.remove(chatbotId, targetId)) throw notFound('群聊角色卡不存在')
    this.deps.resetGroupSessions(chatbotId, target.external_id)
    this.deps.audit('chatbot.group_role.admin', `${chatbotId}:${targetId}`, {
      action: 'delete',
      nameLength: card.name.length,
      promptLength: card.prompt.length,
      at: nowIso(),
    })
  }
}
