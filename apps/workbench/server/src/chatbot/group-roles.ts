/**
 * 群聊角色卡存储：每个 Chatbot×群聊目标一张共享角色卡，管理员可编辑正文。
 * 安全边界：正文只用于该群聊 Chat 提示词；不暴露给普通用户，也不能移除固定安全边界。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChatbotGroupRoleSummary, ChatbotTargetRow } from './types.ts'

export interface ChatbotGroupRole {
  targetId: string
  chatbotId: string
  targetExternalId: string
  name: string
  prompt: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface GroupRoleRow {
  target_id: string
  chatbot_id: string
  target_external_id: string
  name: string
  prompt: string
  enabled: number
  created_at: string
  updated_at: string
}

interface GroupRoleListRow {
  target_id: string
  target_external_id: string
  target_label: string
  name: string | null
  enabled: number | null
  prompt_length: number | null
  updated_at: string | null
}

function mapRow(row: GroupRoleRow): ChatbotGroupRole {
  return {
    targetId: row.target_id,
    chatbotId: row.chatbot_id,
    targetExternalId: row.target_external_id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ChatbotGroupRoleStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  getByTargetId(chatbotId: string, targetId: string): ChatbotGroupRole | null {
    const row = this.db
      .prepare('SELECT * FROM chatbot_group_roles WHERE chatbot_id = ? AND target_id = ?')
      .get(chatbotId, targetId) as unknown as GroupRoleRow | undefined
    return row ? mapRow(row) : null
  }

  /** 新建或覆盖角色卡；创建时间在覆盖时保留。 */
  save(target: ChatbotTargetRow, name: string, prompt: string): ChatbotGroupRole {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO chatbot_group_roles
           (target_id, chatbot_id, target_external_id, name, prompt, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET
           target_external_id = excluded.target_external_id,
           name = excluded.name,
           prompt = excluded.prompt,
           enabled = 1,
           updated_at = excluded.updated_at`,
      )
      .run(target.id, target.chatbot_id, target.external_id, name, prompt, now, now)
    const saved = this.getByTargetId(target.chatbot_id, target.id)
    if (!saved) throw new Error('group_role_save_failed')
    return saved
  }

  setEnabled(chatbotId: string, targetId: string, enabled: boolean): boolean {
    const result = this.db
      .prepare('UPDATE chatbot_group_roles SET enabled = ?, updated_at = ? WHERE chatbot_id = ? AND target_id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), chatbotId, targetId)
    return Number(result.changes) > 0
  }

  remove(chatbotId: string, targetId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM chatbot_group_roles WHERE chatbot_id = ? AND target_id = ?')
      .run(chatbotId, targetId)
    return Number(result.changes) > 0
  }

  /** 列表：列出全部群聊目标，未配置角色卡的 role 字段为空。 */
  list(chatbotId: string): ChatbotGroupRoleSummary[] {
    const rows = this.db
      .prepare(
        `SELECT t.id AS target_id, t.external_id AS target_external_id, t.label AS target_label,
                r.name, r.enabled, length(r.prompt) AS prompt_length, r.updated_at
         FROM chatbot_targets t
         LEFT JOIN chatbot_group_roles r
           ON r.target_id = t.id AND r.chatbot_id = t.chatbot_id
         WHERE t.chatbot_id = ? AND t.kind = 'group'
         ORDER BY t.created_at ASC`,
      )
      .all(chatbotId) as unknown as GroupRoleListRow[]
    return rows.map((row) => ({
      targetId: row.target_id,
      targetLabel: row.target_label,
      targetExternalId: row.target_external_id,
      name: row.name,
      enabled: row.enabled === 1,
      promptLength: row.prompt_length ?? 0,
      updatedAt: row.updated_at,
    }))
  }
}
