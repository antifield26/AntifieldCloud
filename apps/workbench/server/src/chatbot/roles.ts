/**
 * 私聊 Chat 角色卡存储：每个 Chatbot×用户一张卡，DB 为唯一权威来源。
 * 安全边界：角色卡正文不通过 HTTP API/UI 暴露，只由 /role show 返回给本人；
 * 管理接口只返回名字/长度/启停/时间等元数据；正文只允许改变人设/语气，不能移除提示词中的固定安全边界。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChatbotRoleSummary } from './types.ts'

export const ROLE_NAME_MAX = 32
export const ROLE_PROMPT_MAX = 1000

/**
 * 内置默认角色：没有个人角色卡时用于私聊，群聊/频道固定使用它。
 * 只保留名字与回复风格，避免详细人设/背景影响普通用户通过对话调整出的个性；
 * 需要更具体人设时由用户用 `/role set` 建个人卡。
 */
export const DEFAULT_CHAT_ROLE = {
  name: 'mcbot',
  prompt:
    '对话风格：简短、自然、轻松，短句为主；可使用轻量语气词，不连续卖萌、不刷屏；遇到认真、难过或风险话题时收起玩闹；不假装真人、不虚构共同经历、不索要隐私。',
} as const

/** 角色设定中禁止出现的提示词结构标记，避免用户正文伪造系统区段。 */
export const RESERVED_ROLE_MARKERS = [
  '[系统提示]',
  '[安全边界]',
  '[长期记忆',
  '[上下文文档]',
  '[角色卡：',
  '[用户消息]',
  '[模式：',
] as const

export interface ChatbotChatRole {
  chatbotId: string
  userId: string
  name: string
  prompt: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface RoleRow {
  chatbot_id: string
  user_id: string
  name: string
  prompt: string
  enabled: number
  created_at: string
  updated_at: string
}

interface RoleListRow {
  user_id: string
  name: string
  enabled: number
  prompt_length: number
  created_at: string
  updated_at: string
}

export type RoleValidationError =
  | 'role_name_empty'
  | 'role_name_too_long'
  | 'role_name_has_whitespace'
  | 'role_name_invalid_chars'
  | 'role_prompt_empty'
  | 'role_prompt_too_long'
  | 'role_prompt_reserved_marker'

/** 统一换行；去掉除换行/制表符外的控制字符，保留用户自然语言。 */
export function normalizeRolePrompt(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  let result = ''
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) result += char
  }
  return result.trim()
}

export function validateRole(name: string, prompt: string): RoleValidationError | null {
  if (!name) return 'role_name_empty'
  if (name.length > ROLE_NAME_MAX) return 'role_name_too_long'
  if (/\s/u.test(name)) return 'role_name_has_whitespace'
  if (name.includes('[') || name.includes(']') || /[\r\n\t]/u.test(name)) return 'role_name_invalid_chars'
  if (!prompt) return 'role_prompt_empty'
  if (prompt.length > ROLE_PROMPT_MAX) return 'role_prompt_too_long'
  if (RESERVED_ROLE_MARKERS.some((marker) => prompt.includes(marker))) return 'role_prompt_reserved_marker'
  return null
}

/** 角色卡校验错误的中文提示（命令回复与管理 API 共用）。 */
export function roleValidationMessage(error: RoleValidationError): string {
  switch (error) {
    case 'role_name_empty':
      return '请提供名字。用法：/role set <名字> <设定>'
    case 'role_name_too_long':
      return '名字过长，请控制在 32 字以内。'
    case 'role_name_has_whitespace':
      return '名字不能包含空格。'
    case 'role_name_invalid_chars':
      return '名字不能包含方括号等符号。'
    case 'role_prompt_empty':
      return '请提供设定内容。'
    case 'role_prompt_too_long':
      return '设定过长，请控制在 1000 字以内。'
    case 'role_prompt_reserved_marker':
      return '设定包含不支持的格式，请换一种写法。'
    default:
      return '设定格式无法识别。'
  }
}

function mapRow(row: RoleRow): ChatbotChatRole {
  return {
    chatbotId: row.chatbot_id,
    userId: row.user_id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ChatbotChatRoleStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  get(chatbotId: string, userId: string): ChatbotChatRole | null {
    const row = this.db
      .prepare('SELECT * FROM chatbot_chat_roles WHERE chatbot_id = ? AND user_id = ?')
      .get(chatbotId, userId) as unknown as RoleRow | undefined
    return row ? mapRow(row) : null
  }

  /** 新建或覆盖角色卡，并始终启用；创建时间在覆盖时保留。 */
  save(chatbotId: string, userId: string, name: string, prompt: string): ChatbotChatRole {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO chatbot_chat_roles (chatbot_id, user_id, name, prompt, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(chatbot_id, user_id) DO UPDATE SET
           name = excluded.name,
           prompt = excluded.prompt,
           enabled = 1,
           updated_at = excluded.updated_at`,
      )
      .run(chatbotId, userId, name, prompt, now, now)
    const saved = this.get(chatbotId, userId)
    if (!saved) throw new Error('role_save_failed')
    return saved
  }

  setEnabled(chatbotId: string, userId: string, enabled: boolean): boolean {
    const result = this.db
      .prepare('UPDATE chatbot_chat_roles SET enabled = ?, updated_at = ? WHERE chatbot_id = ? AND user_id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), chatbotId, userId)
    return Number(result.changes) > 0
  }

  remove(chatbotId: string, userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM chatbot_chat_roles WHERE chatbot_id = ? AND user_id = ?')
      .run(chatbotId, userId)
    return Number(result.changes) > 0
  }

  /** 管理页元数据分页：只返回名字/长度/启停/时间，不返回角色设定正文。 */
  list(chatbotId: string, limit = 20, offset = 0): ChatbotRoleSummary[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 20)))
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
    const rows = this.db
      .prepare(
        `SELECT user_id, name, enabled, length(prompt) AS prompt_length, created_at, updated_at
         FROM chatbot_chat_roles WHERE chatbot_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(chatbotId, safeLimit, safeOffset) as unknown as RoleListRow[]
    return rows.map((row) => ({
      userId: row.user_id,
      userName: null,
      name: row.name,
      enabled: row.enabled === 1,
      promptLength: row.prompt_length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  count(chatbotId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM chatbot_chat_roles WHERE chatbot_id = ?')
      .get(chatbotId) as { c: number }
    return row.c
  }
}
