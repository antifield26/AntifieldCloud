/**
 * Bot 记忆管理（管理员视图）：用户/群记忆元数据分页、条目删除与整用户删除。
 * 安全边界：只返回元数据（条目数/类型/时间），不返回 key/value 正文；
 * 删除前通过注入回调取消在途抽取，避免旧批次写回。
 */
import type { BotMemoryStore } from './memory.ts'
import { badRequest, notFound } from '../util/errors.ts'
import { GROUP_MEMORY_PREFIX } from './memory.ts'
import type {
  BotMemoryGroupSummary,
  BotMemoryItemSummary,
  BotMemoryUserSummary,
  BotRow,
  BotServiceDeps,
} from './types.ts'

export interface BotMemoryAdminDeps {
  requireEnabled: () => void
  botRow: (id: string) => BotRow
  memory: BotMemoryStore
  audit: BotServiceDeps['audit']
  cancelUserMemory: (botId: string, userId: string) => void
  cancelGroupMemoryScope: (botId: string, scope: string) => void
}

export class BotMemoryAdmin {
  private readonly deps: BotMemoryAdminDeps

  constructor(deps: BotMemoryAdminDeps) {
    this.deps = deps
  }

  /** 结构化记忆管理：用户级元数据分页（条目数/类型分布/启停/更新时间），不含 key/value。 */
  listMemories(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemoryUserSummary[]; total: number } {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    return this.deps.memory.listUsers(botId, limit, offset)
  }

  /** 群聊共享记忆管理：按群目标聚合的元数据分页，不含 key/value。 */
  listGroupMemories(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemoryGroupSummary[]; total: number } {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    return this.deps.memory.listGroups(botId, options.limit ?? 20, options.offset ?? 0)
  }

  /** 清空某个群目标的共享记忆；scope 必须是内部群 scope，避免误删用户记忆。 */
  deleteGroupMemory(botId: string, scope: string): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    if (!scope.startsWith(GROUP_MEMORY_PREFIX)) throw badRequest('群聊记忆标识无效')
    // 先取消该 scope 下所有成员的在途抽取/待处理批次，避免清空后旧批次写回（BOT-06）。
    this.deps.cancelGroupMemoryScope(botId, scope)
    this.deleteMemory(botId, scope)
  }

  /** 管理端条目元数据分页：只有 id/类型/重要度/置信度/时间，不含 key/value。 */
  listMemoryItems(
    botId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: BotMemoryItemSummary[]; total: number } {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(options.limit) ? (options.limit as number) : 20)))
    const offset = Math.max(0, Math.floor(Number.isFinite(options.offset) ? (options.offset as number) : 0))
    return this.deps.memory.listItems(botId, userId, limit, offset)
  }

  /** 删除单条结构化记忆（管理端）；不存在时 404。审计不含 key/value。 */
  deleteMemoryItem(botId: string, userId: string, itemId: string): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    const id = itemId.trim().slice(0, 64)
    if (!id) throw badRequest('记忆条目 ID 不能为空')
    if (!this.deps.memory.deleteItem(botId, userId, id)) throw notFound('记忆条目不存在')
    this.deps.audit('bot.memory.delete_item', `${botId}:${userId.slice(0, 64)}`, {
      bot: botId,
      user: userId.slice(0, 64),
      item: id,
    })
  }

  /** 整用户删除结构化记忆（条目+状态+旧摘要+镜像）；不存在时 404。审计不含正文。 */
  deleteMemory(botId: string, userId: string): void {
    this.deps.requireEnabled()
    this.deps.botRow(botId)
    // 先取消待处理批次并递增 generation，防止删除后在途抽取回写。
    this.deps.cancelUserMemory(botId, userId)
    const result = this.deps.memory.deleteUser(botId, userId)
    if (result.deletedItems === 0 && !result.deletedState && !result.deletedLegacy) throw notFound('长期记忆不存在')
    this.deps.audit('bot.memory.delete_user', `${botId}:${userId.slice(0, 64)}`, {
      bot: botId,
      user: userId.slice(0, 64),
      items: result.deletedItems,
      legacy: result.deletedLegacy ? 1 : 0,
    })
  }
}
