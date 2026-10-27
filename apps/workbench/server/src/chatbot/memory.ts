/**
 * Chatbot 结构化长期记忆：条目存储、抽取操作合并、按相关性分层召回、旧滚动摘要迁移与清理。
 * 安全边界：管理接口只返回类型/重要度等元数据，不返回 key/value；写入前过滤密钥/URL/内部路径/提示结构标记
 * （key 与 value 均过滤），旧摘要注入前按行过滤；记忆内容只作为提示词背景资料，不是指令；/memory off 时既不抽取也不注入。
 */
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { transaction } from '../db.ts'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import { GROUP_CHAT_SESSION_USER_ID } from './session.ts'
import type {
  ChatbotMemoryItemPrompt,
  ChatbotMemoryItemSummary,
  ChatbotMemoryGroupSummary,
  ChatbotMemoryKind,
  ChatbotMemoryOperation,
  ChatbotMemoryState,
  ChatbotMemoryUserSummary,
} from './types.ts'
import { CHATBOT_MEMORY_KINDS } from './types.ts'
import { RESERVED_ROLE_MARKERS } from './roles.ts'

const VALUE_MAX_CHARS = 500
const KEY_MAX_CHARS = 64
const EXTRACT_ITEM_LIMIT = 120
const LEGACY_READ_LIMIT = 32 * 1024
const CORE_KINDS = new Set<ChatbotMemoryKind>(['profile', 'preference', 'task'])
/** 群聊共享记忆使用独立 scope；不会与任何真实用户 openid 混用。 */
export const GROUP_MEMORY_PREFIX = 'group:'

/** 无法映射到稳定 member_openid 的旧群记忆 key 前缀：保留内容但明确标注 legacy，不参与按成员删除。 */
export const LEGACY_GROUP_KEY_PREFIX = 'legacy:'

export function groupMemoryScope(targetExternalId: string): string {
  return `${GROUP_MEMORY_PREFIX}${targetExternalId}`
}

const KIND_LABEL: Record<ChatbotMemoryKind, string> = {
  profile: '资料',
  preference: '偏好',
  fact: '事实',
  project: '项目',
  task: '任务',
  relationship: '关系',
  episode: '事件',
}

/**
 * 敏感内容过滤：覆盖自然语言密钥句式、常见密钥前缀、带/不带 scheme 的 URL、IP、内部路径与 UNC。
 * 中文关键词必须带"是/为/：/="等判断词，避免把"对密码学感兴趣""Node.js"这类正常偏好误杀。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:密码|口令|令牌|密钥|私钥)\s*(?:是|为|[:=：])/,
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)\b\s*(?:[:=：]|是|为|is\b|are\b)/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{10,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{10,}\b/i,
  /\b(?:aws_secret_access_key|secret_access_key)\b\s*[:=]\s*\S{20,}/i,
  /\bAccountKey=[A-Za-z0-9+/=]{20,}/i,
  /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:/@]+:[^\s@]+@/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:ssh|https?|ftp|sftp|wss?|git):\/\/\S+/i,
  /\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|app|xyz|me|co|info|top|site|cloud|tech|link|vip|work|club|online|shop)\b(?:[:/]\S*)?/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /(?:[A-Za-z]:\\|\\\\[A-Za-z0-9._-]+\\|\/(?:home|var|etc|opt|run|proc|sys|tmp|root|mnt|srv|usr|bin|sbin|boot|data|media|lib)\/|~\/)/,
]

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'were', 'have', 'has', 'not', '但是', '然后',
  '就是', '可以', '什么', '怎么', '我们', '你们', '他们', '这个', '那个', '一下', '一个', '现在', '今天', '明天',
  '今天', '还是', '因为', '所以', '如果', '没有', '不是', '知道', '觉得', '喜欢', '哈哈', '好的', '谢谢',
])

export interface ChatbotMemoryOptions {
  maxItems: number
  promptMaxChars: number
  promptMaxItems: number
  factProjectTtlDays: number
  episodeTtlDays: number
  taskTtlDays: number
  legacyMaxChars: number
}

/** 从 Config 映射记忆存储参数（service/CLI 共用，避免两处默认值漂移）。 */
export function memoryOptionsFromConfig(config: {
  chatbotMemoryMaxItems: number
  chatbotMemoryPromptMaxChars: number
  chatbotMemoryPromptMaxItems: number
  chatbotAiMemoryRetentionDays: number
  chatbotMemoryTtlEpisodeDays: number
  chatbotMemoryTtlTaskDays: number
  chatbotAiMemoryMaxChars: number
}): ChatbotMemoryOptions {
  return {
    maxItems: config.chatbotMemoryMaxItems,
    promptMaxChars: config.chatbotMemoryPromptMaxChars,
    promptMaxItems: config.chatbotMemoryPromptMaxItems,
    factProjectTtlDays: config.chatbotAiMemoryRetentionDays,
    episodeTtlDays: config.chatbotMemoryTtlEpisodeDays,
    taskTtlDays: config.chatbotMemoryTtlTaskDays,
    legacyMaxChars: config.chatbotAiMemoryMaxChars,
  }
}

export interface ChatbotMemoryPromptContext {
  /** 已格式化、可直接注入提示词的记忆文本；空字符串表示无记忆/已关闭。 */
  text: string
  usedItemIds: string[]
  legacyFallback: boolean
}

export interface ChatbotMemoryApplyResult {
  upserts: number
  deletes: number
  skipped: number
  pruned: number
}

export interface ChatbotMemoryListPage<T> {
  items: T[]
  total: number
}

interface MemoryItemRow {
  id: string
  chatbot_id: string
  user_id: string
  kind: ChatbotMemoryKind
  mem_key: string
  value: string
  confidence: number
  importance: number
  source: string
  created_at: string
  updated_at: string
  last_used_at: string | null
  expires_at: string | null
}

interface MemoryStateRow {
  chatbot_id: string
  user_id: string
  memory_enabled: number
  legacy_migrated_at: string | null
  created_at: string
  updated_at: string
}

interface LegacyRow {
  chatbot_id: string
  user_id: string
  memory_id: string
  summary: string
  created_at: string
  updated_at: string
}

function safeText(value: string, maxChars: number): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, Math.max(0, maxChars))
}

function stripControl(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    out += code < 32 || code === 127 ? ' ' : char
  }
  return out
}

function normalizeKey(value: string): string {
  return stripControl(value)
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .toLowerCase()
    .slice(0, KEY_MAX_CHARS)
}

function normalizeValue(value: string): string {
  return stripControl(value).replace(/\s+/g, ' ').trim().slice(0, VALUE_MAX_CHARS)
}

function isSensitive(value: string): boolean {
  if (RESERVED_ROLE_MARKERS.some((marker) => value.includes(marker))) return true
  return SECRET_PATTERNS.some((pattern) => pattern.test(value))
}

/** 旧摘要按行过滤敏感内容：命中密钥/URL/路径/提示结构标记的行整行丢弃，其余保留。 */
function filterLegacyLines(value: string): string {
  return value
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed.length === 0 || !isSensitive(trimmed)
    })
    .join('\n')
    .trim()
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) {
    const token = match[0]
    if (!STOP_WORDS.has(token)) tokens.add(token)
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) continue
    for (let i = 0; i < run.length - 1; i += 1) {
      const token = run.slice(i, i + 2)
      if (!STOP_WORDS.has(token)) tokens.add(token)
    }
  }
  return tokens
}

const LEGACY_MEMORY_DIR = 'bot-memory'

/**
 * v1.0.0 更名数据迁移：旧 `bot-memory` 镜像目录 → `chatbot-memory`。
 * 目标不存在时原子重命名；目标已存在时逐文件补齐且不覆盖，随后删除空旧目录。
 * 迁移失败不阻断启动（旧目录保留，下次启动重试）。
 */
function migrateLegacyMemoryMirror(dataDir: string, targetDir: string): void {
  const legacyDir = join(dataDir, LEGACY_MEMORY_DIR)
  if (!existsSync(legacyDir)) return
  try {
    if (!existsSync(targetDir)) {
      renameSync(legacyDir, targetDir)
      return
    }
    mkdirSync(targetDir, { recursive: true })
    for (const name of readdirSync(legacyDir)) {
      const source = join(legacyDir, name)
      const target = join(targetDir, name)
      if (!existsSync(target)) renameSync(source, target)
    }
    rmSync(legacyDir, { recursive: true, force: true })
  } catch {
    // 旧目录保留待下次重试；新目录缺失时镜像写入仍会按需创建。
  }
}

export class ChatbotMemoryStore {
  readonly dir: string
  private readonly db: DatabaseSync
  private readonly options: ChatbotMemoryOptions

  constructor(db: DatabaseSync, dataDir: string, options: ChatbotMemoryOptions) {
    this.db = db
    this.dir = join(dataDir, 'chatbot-memory')
    migrateLegacyMemoryMirror(dataDir, this.dir)
    this.options = {
      maxItems: Math.max(20, Math.min(1000, Math.floor(options.maxItems))),
      promptMaxChars: Math.max(500, Math.min(8000, Math.floor(options.promptMaxChars))),
      promptMaxItems: Math.max(1, Math.min(50, Math.floor(options.promptMaxItems))),
      factProjectTtlDays: Math.max(1, Math.floor(options.factProjectTtlDays)),
      episodeTtlDays: Math.max(1, Math.min(365, Math.floor(options.episodeTtlDays))),
      taskTtlDays: Math.max(1, Math.min(180, Math.floor(options.taskTtlDays))),
      legacyMaxChars: Math.max(512, Math.min(16384, Math.floor(options.legacyMaxChars))),
    }
  }

  /** 读取（不存在时创建默认）每用户记忆状态。 */
  getState(chatbotId: string, userId: string): ChatbotMemoryState {
    const row = this.ensureState(chatbotId, userId)
    return { memoryEnabled: row.memory_enabled === 1, legacyMigratedAt: row.legacy_migrated_at }
  }

  setMemoryEnabled(chatbotId: string, userId: string, enabled: boolean): void {
    const now = nowIso()
    this.ensureState(chatbotId, userId)
    this.db
      .prepare('UPDATE chatbot_memory_state SET memory_enabled = ?, updated_at = ? WHERE chatbot_id = ? AND user_id = ?')
      .run(enabled ? 1 : 0, now, chatbotId, userId)
  }

  markLegacyMigrated(chatbotId: string, userId: string): void {
    const now = nowIso()
    this.ensureState(chatbotId, userId)
    this.db
      .prepare('UPDATE chatbot_memory_state SET legacy_migrated_at = ?, updated_at = ? WHERE chatbot_id = ? AND user_id = ?')
      .run(now, now, chatbotId, userId)
  }

  /** 旧滚动摘要（仅用于迁移输入/未迁移 fallback）；DB 为空时尝试读取镜像文件。 */
  legacySummary(chatbotId: string, userId: string): { memoryId: string; summary: string } | null {
    const row = this.db
      .prepare('SELECT * FROM chatbot_ai_memories WHERE chatbot_id = ? AND user_id = ?')
      .get(chatbotId, userId) as unknown as LegacyRow | undefined
    if (!row) return null
    let summary = row.summary
    if (!summary) {
      const path = this.pathFor(row.memory_id)
      if (existsSync(path)) {
        try {
          summary = readFileSync(path, 'utf8')
            .replace(/^#[^\n]*\n+/, '')
            .slice(0, LEGACY_READ_LIMIT)
        } catch {
          summary = ''
        }
      }
    }
    // 旧摘要同样可能是敏感内容来源（历史模型输出）：注入/迁移前按行过滤泄露项与提示结构标记。
    const text = safeText(filterLegacyLines(summary), this.options.legacyMaxChars)
    return text ? { memoryId: row.memory_id, summary: text } : null
  }

  /** 提供给抽取模型的现有条目（非过期，最多 120 条）；历史遗留的敏感条目不再回灌模型。 */
  itemsForExtraction(chatbotId: string, userId: string): ChatbotMemoryItemPrompt[] {
    const rows = this.db
      .prepare(
        `SELECT kind, mem_key, value, importance, updated_at FROM chatbot_memory_items
         WHERE chatbot_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(chatbotId, userId, nowIso(), EXTRACT_ITEM_LIMIT) as unknown as MemoryItemRow[]
    return rows
      .filter((row) => !isSensitive(row.mem_key) && !isSensitive(row.value))
      .map((row) => ({
        kind: row.kind,
        key: row.mem_key,
        value: row.value,
        importance: row.importance,
        updatedAt: row.updated_at,
      }))
  }

  /**
   * 构建注入提示词的记忆文本：核心类型优先，其余按关键词/重要度/时效召回；
   * 未迁移时追加旧摘要 fallback。关闭记忆时返回空文本。
   */
  buildPromptContext(chatbotId: string, userId: string, userText: string, groupMemory = false): ChatbotMemoryPromptContext {
    const state = this.getState(chatbotId, userId)
    if (!state.memoryEnabled) return { text: '', usedItemIds: [], legacyFallback: false }
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM chatbot_memory_items
           WHERE chatbot_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY importance DESC, updated_at DESC`,
        )
        .all(chatbotId, userId, nowIso()) as unknown as MemoryItemRow[]
      // 历史遗留的敏感条目（旧版本写入）不再进入任何提示词。
    ).filter((row) => !isSensitive(row.mem_key) && !isSensitive(row.value))
    const tokens = tokenize(userText)
    const core = rows.filter((row) => CORE_KINDS.has(row.kind))
    const relevant = rows
      .filter((row) => !CORE_KINDS.has(row.kind))
      .map((row) => ({ row, score: this.relevance(row, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.row.importance - a.row.importance || b.row.updated_at.localeCompare(a.row.updated_at))
    const selected: MemoryItemRow[] = []
    for (const row of [...core, ...relevant.map((entry) => entry.row)]) {
      if (selected.length >= this.options.promptMaxItems) break
      selected.push(row)
    }
    const lines: string[] = []
    let chars = 0
    for (const row of selected) {
      const line = groupMemory
        ? `- ${row.value}`
        : `- ${KIND_LABEL[row.kind]}｜重要度${row.importance}｜${row.mem_key}：${row.value}`
      if (chars + line.length + 1 > this.options.promptMaxChars) break
      lines.push(line)
      chars += line.length + 1
    }
    let legacyFallback = false
    if (!groupMemory && !state.legacyMigratedAt) {
      const legacy = this.legacySummary(chatbotId, userId)
      if (legacy) {
        const remaining = Math.max(0, this.options.promptMaxChars - chars - 20)
        if (remaining > 0) {
          const block = `[旧记忆（待迁移）]\n${legacy.summary.slice(0, remaining)}`
          lines.push('', block)
          legacyFallback = true
        }
      }
    }
    if (selected.length > 0) {
      const now = nowIso()
      const placeholders = selected.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE chatbot_memory_items SET last_used_at = ? WHERE id IN (${placeholders})`)
        .run(now, ...selected.map((row) => row.id))
    }
    return { text: lines.join('\n').trim(), usedItemIds: selected.map((row) => row.id), legacyFallback }
  }

  /** 校验并合并抽取操作；返回 upsert/delete/skipped/pruned 计数。 */
  applyOperations(chatbotId: string, userId: string, ops: readonly ChatbotMemoryOperation[], source: 'chat' | 'legacy' = 'chat'): ChatbotMemoryApplyResult {
    const valid = this.validateOperations(ops)
    const now = nowIso()
    let pruned = 0
    transaction(this.db, () => {
      this.ensureState(chatbotId, userId)
      for (const op of valid.upserts) {
        const expiresAt = this.expiresAtFor(op.kind, now)
        this.db
          .prepare(
            `INSERT INTO chatbot_memory_items
               (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(chatbot_id, user_id, kind, mem_key) DO UPDATE SET
               value = excluded.value,
               confidence = excluded.confidence,
               importance = excluded.importance,
               source = excluded.source,
               updated_at = excluded.updated_at,
               expires_at = excluded.expires_at`,
          )
          .run(
            newId(),
            chatbotId,
            userId,
            op.kind,
            op.key,
            op.value ?? '',
            op.confidence ?? 0.8,
            op.importance ?? 3,
            source,
            now,
            now,
            expiresAt,
          )
      }
      for (const key of valid.deletes) {
        const [kind, memKey] = key.split('\u0000') as [ChatbotMemoryKind, string]
        this.db
          .prepare('DELETE FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? AND kind = ? AND mem_key = ?')
          .run(chatbotId, userId, kind, memKey)
      }
      pruned = this.prune(chatbotId, userId, now)
      this.db
        .prepare('UPDATE chatbot_memory_state SET updated_at = ? WHERE chatbot_id = ? AND user_id = ?')
        .run(now, chatbotId, userId)
    })
    return {
      upserts: valid.upserts.length,
      deletes: valid.deletes.size,
      skipped: valid.skipped,
      pruned,
    }
  }

  /** 管理端用户级分页：只有条目计数/类型分布/状态，不含正文。 */
  listUsers(chatbotId: string, limit = 20, offset = 0): ChatbotMemoryListPage<ChatbotMemoryUserSummary> {    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 20)))
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
    const now = nowIso()
    const itemRows = this.db
      .prepare(
        `SELECT user_id, kind, COUNT(*) AS c, MAX(updated_at) AS upd FROM chatbot_memory_items
         WHERE chatbot_id = ? AND (expires_at IS NULL OR expires_at > ?) AND user_id NOT LIKE 'group:%'
         GROUP BY user_id, kind`,
      )
      .all(chatbotId, now) as unknown as { user_id: string; kind: ChatbotMemoryKind; c: number; upd: string }[]
    const legacyRows = this.db
      .prepare("SELECT user_id, updated_at FROM chatbot_ai_memories WHERE chatbot_id = ? AND summary <> '' AND user_id NOT LIKE 'group:%'")
      .all(chatbotId) as unknown as { user_id: string; updated_at: string }[]
    const stateRows = this.db
      .prepare("SELECT user_id, memory_enabled, updated_at FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id NOT LIKE 'group:%'")
      .all(chatbotId) as unknown as { user_id: string; memory_enabled: number; updated_at: string }[]
    const nameRows = this.db
      .prepare('SELECT user_id, user_name FROM chatbot_inbound_targets WHERE chatbot_id = ? AND user_name IS NOT NULL ORDER BY last_seen_at DESC')
      .all(chatbotId) as unknown as { user_id: string; user_name: string }[]
    const names = new Map<string, string>()
    for (const row of nameRows) if (!names.has(row.user_id)) names.set(row.user_id, row.user_name)
    const states = new Map(stateRows.map((row) => [row.user_id, row]))
    const map = new Map<string, ChatbotMemoryUserSummary>()
    for (const row of itemRows) {
      const current = map.get(row.user_id) ?? {
        userId: row.user_id,
        userName: names.get(row.user_id) ?? null,
        itemCount: 0,
        kinds: {},
        memoryEnabled: true,
        updatedAt: null,
      }
      current.itemCount += row.c
      current.kinds[row.kind] = (current.kinds[row.kind] ?? 0) + row.c
      if (!current.updatedAt || row.upd > current.updatedAt) current.updatedAt = row.upd
      map.set(row.user_id, current)
    }
    for (const row of legacyRows) {
      const current = map.get(row.user_id) ?? {
        userId: row.user_id,
        userName: names.get(row.user_id) ?? null,
        itemCount: 0,
        kinds: {},
        memoryEnabled: true,
        updatedAt: null,
      }
      if (!current.updatedAt || row.updated_at > current.updatedAt) current.updatedAt = row.updated_at
      map.set(row.user_id, current)
    }
    for (const row of stateRows) {
      if (!map.has(row.user_id)) {
        map.set(row.user_id, {
          userId: row.user_id,
          userName: names.get(row.user_id) ?? null,
          itemCount: 0,
          kinds: {},
          memoryEnabled: row.memory_enabled === 1,
          updatedAt: row.updated_at,
        })
      }
    }
    const list = [...map.values()]
      .map((entry) => ({ ...entry, memoryEnabled: (states.get(entry.userId)?.memory_enabled ?? 1) === 1 }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return { items: list.slice(safeOffset, safeOffset + safeLimit), total: list.length }
  }

  /** 管理端群聊共享记忆分页：按群目标聚合，只有条目计数/类型分布/时间，不含正文。 */
  listGroups(chatbotId: string, limit = 20, offset = 0): ChatbotMemoryListPage<ChatbotMemoryGroupSummary> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 20)))
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
    const rows = this.db
      .prepare(
        `SELECT user_id, kind, COUNT(*) AS c, MAX(updated_at) AS upd FROM chatbot_memory_items
         WHERE chatbot_id = ? AND user_id LIKE ? AND (expires_at IS NULL OR expires_at > ?)
         GROUP BY user_id, kind`,
      )
      .all(chatbotId, `${GROUP_MEMORY_PREFIX}%`, nowIso()) as unknown as {
      user_id: string
      kind: ChatbotMemoryKind
      c: number
      upd: string
    }[]
    const targets = new Map(
      (
        this.db
          .prepare("SELECT external_id, label FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'group'")
          .all(chatbotId) as unknown as { external_id: string; label: string }[]
      ).map((row) => [row.external_id, row.label]),
    )
    const map = new Map<string, ChatbotMemoryGroupSummary>()
    for (const row of rows) {
      const externalId = row.user_id.slice(GROUP_MEMORY_PREFIX.length)
      const current = map.get(row.user_id) ?? {
        scope: row.user_id,
        targetExternalId: externalId,
        targetName: targets.get(externalId)?.trim() || externalId.slice(0, 14),
        itemCount: 0,
        kinds: {},
        updatedAt: null,
      }
      current.itemCount += row.c
      current.kinds[row.kind] = (current.kinds[row.kind] ?? 0) + row.c
      if (!current.updatedAt || row.upd > current.updatedAt) current.updatedAt = row.upd
      map.set(row.user_id, current)
    }
    const list = [...map.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return { items: list.slice(safeOffset, safeOffset + safeLimit), total: list.length }
  }

  /**
   * 把群聊参与者的用户级记忆复制/迁移到对应群共享记忆：
   * - 只处理有群入站/群会话记录的用户；
   * - 用户同时有私聊记录或已登记 user 目标时只复制，保留用户级记忆；
   * - 仅参与一个群且无私聊记录的用户，复制后删除其用户级条目，完成迁移；
   * - 群内条目格式为 `<用户名>：<记忆>`，key 带 `<用户名>:` 前缀。
   */
  migrateGroupParticipantMemories(): { copied: number; moved: number; groups: number } {
    return transaction(this.db, () => {
      let copied = 0
      let moved = 0
      const touchedGroups = new Set<string>()
      const groups = this.db
        .prepare("SELECT chatbot_id, external_id, label FROM chatbot_targets WHERE kind = 'group'")
        .all() as unknown as { chatbot_id: string; external_id: string; label: string }[]
      for (const group of groups) {
        const participants = this.db
          .prepare(
            `SELECT DISTINCT user_id FROM chatbot_inbound_targets
             WHERE chatbot_id = ? AND target_external_id = ? AND is_direct = 0
             UNION
             SELECT DISTINCT user_id FROM chatbot_ai_sessions
             WHERE chatbot_id = ? AND target_external_id = ? AND user_id <> ?`,
          )
          .all(group.chatbot_id, group.external_id, group.chatbot_id, group.external_id, GROUP_CHAT_SESSION_USER_ID) as unknown as {
          user_id: string
        }[]
        for (const participant of participants) {
          const nameRow = this.db
            .prepare(
              `SELECT user_name FROM chatbot_inbound_targets
               WHERE chatbot_id = ? AND user_id = ? AND user_name IS NOT NULL
               ORDER BY last_seen_at DESC LIMIT 1`,
            )
            .get(group.chatbot_id, participant.user_id) as { user_name: string | null } | undefined
          const rawName = String(nameRow?.user_name ?? '').trim().slice(0, 20)
          const userName = rawName || `用户${participant.user_id.slice(-6)}`
          const items = this.db
            .prepare(
              `SELECT * FROM chatbot_memory_items
               WHERE chatbot_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
            )
            .all(group.chatbot_id, participant.user_id, nowIso()) as unknown as MemoryItemRow[]
          if (items.length === 0) continue
          const groupScope = groupMemoryScope(group.external_id)
          const direct = this.db
            .prepare('SELECT 1 AS x FROM chatbot_inbound_targets WHERE chatbot_id = ? AND user_id = ? AND is_direct = 1 LIMIT 1')
            .get(group.chatbot_id, participant.user_id)
          const registered = this.db
            .prepare("SELECT 1 AS x FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'user' AND external_id = ? LIMIT 1")
            .get(group.chatbot_id, participant.user_id)
          const groupCount = (
            this.db
              .prepare(
                `SELECT COUNT(DISTINCT target_external_id) AS c FROM chatbot_inbound_targets
                 WHERE chatbot_id = ? AND user_id = ? AND is_direct = 0`,
              )
              .get(group.chatbot_id, participant.user_id) as { c: number }
          ).c
          const move = !direct && !registered && groupCount <= 1
          const migratedIds: string[] = []
          for (const item of items) {
            let value = item.value.trim()
            if (value.startsWith(`${userName}：`)) value = value.slice(userName.length + 1)
            else if (value.startsWith(`${userName}:`)) value = value.slice(userName.length + 1).trimStart()
            // 稳定归属：key 前缀用 member_openid，显示名只写入 value（D-13）。
            const keyPrefix = `${userName}:`
            const rawKey = item.mem_key.startsWith(keyPrefix) ? item.mem_key.slice(keyPrefix.length) : item.mem_key
            const key = `${participant.user_id}:${rawKey}`.slice(0, KEY_MAX_CHARS)
            const result = this.db
              .prepare(
                `INSERT OR IGNORE INTO chatbot_memory_items
                   (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                newId(),
                group.chatbot_id,
                groupScope,
                item.kind,
                key,
                `${userName}：${value}`,
                item.confidence,
                item.importance,
                item.source,
                item.created_at,
                item.updated_at,
                item.last_used_at,
                item.expires_at,
              )
            if (result.changes > 0) {
              copied += 1
              touchedGroups.add(`${group.chatbot_id}:${group.external_id}`)
              migratedIds.push(item.id)
            }
          }
          if (move && migratedIds.length === items.length) {
            const placeholders = migratedIds.map(() => '?').join(',')
            const deleted = this.db
              .prepare(`DELETE FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? AND id IN (${placeholders})`)
              .run(group.chatbot_id, participant.user_id, ...migratedIds)
            moved += Number(deleted.changes)
          }
        }
      }
      return { copied, moved, groups: touchedGroups.size }
    })
  }

  /**
   * D-13 一次性归属迁移：把旧版按显示名前缀存储的群共享条目改为稳定 `member_openid:` 前缀。
   * - 通过 chatbot_inbound_targets 的「群目标 + 显示名 + 用户」建立唯一映射；同名多用户视为不可映射；
   * - 已是 member_openid 前缀的条目跳过；无法映射的加 `legacy:` 前缀保留（不参与按成员删除）；
   * - 目标键已存在（冲突）时跳过并在返回计数中体现，不覆盖现有条目。
   * 由 ChatbotService 用 meta 标记保证只执行一次。
   */
  renameGroupItemOwners(): { migrated: number; legacy: number; groups: number; skippedConflicts: number } {
    return transaction(this.db, () => {
      let migrated = 0
      let legacy = 0
      let skippedConflicts = 0
      const touchedGroups = new Set<string>()
      const chatbots = this.db.prepare('SELECT id FROM chatbots').all() as unknown as { id: string }[]
      for (const chatbot of chatbots) {
        const groups = this.db
          .prepare("SELECT external_id FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'group'")
          .all(chatbot.id) as unknown as { external_id: string }[]
        for (const group of groups) {
          const scope = groupMemoryScope(group.external_id)
          const rows = this.db
            .prepare('SELECT * FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
            .all(chatbot.id, scope) as unknown as MemoryItemRow[]
          if (rows.length === 0) continue
          const nameRows = this.db
            .prepare(
              `SELECT user_name, user_id FROM chatbot_inbound_targets
               WHERE chatbot_id = ? AND target_external_id = ? AND user_name IS NOT NULL
               ORDER BY last_seen_at DESC`,
            )
            .all(chatbot.id, group.external_id) as unknown as { user_name: string; user_id: string }[]
          const nameCandidates = new Map<string, Set<string>>()
          for (const row of nameRows) {
            const name = row.user_name.trim()
            if (!name) continue
            const set = nameCandidates.get(name) ?? new Set<string>()
            set.add(row.user_id)
            nameCandidates.set(name, set)
          }
          const nameToMember = new Map<string, string>()
          const memberIds = new Set<string>()
          for (const [name, ids] of nameCandidates) {
            for (const id of ids) memberIds.add(id)
            if (ids.size === 1) nameToMember.set(name, [...ids][0]!)
          }
          for (const row of rows) {
            const currentKey = row.mem_key
            if (currentKey.startsWith(LEGACY_GROUP_KEY_PREFIX)) continue
            const colon = currentKey.indexOf(':')
            const prefix = colon > 0 ? currentKey.slice(0, colon) : ''
            // 已经是稳定 member_openid 前缀：无需迁移。
            if (prefix && memberIds.has(prefix)) continue
            const memberId = prefix ? nameToMember.get(prefix) : undefined
            const rest = colon > 0 ? currentKey.slice(colon + 1) : currentKey
            const nextKey = memberId
              ? `${memberId}:${rest}`.slice(0, KEY_MAX_CHARS)
              : `${LEGACY_GROUP_KEY_PREFIX}${currentKey}`.slice(0, KEY_MAX_CHARS)
            if (!nextKey || nextKey === currentKey) {
              if (!memberId) legacy += 1
              continue
            }
            // 显示名只保留在 value：旧 value 未带名字前缀时补上，便于群提示词按「名字：记忆」展示。
            const nextValue =
              memberId && prefix && !row.value.trimStart().startsWith(`${prefix}：`)
                ? `${prefix}：${row.value.trim()}`
                : row.value
            const conflict = this.db
              .prepare(
                'SELECT 1 AS x FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? AND kind = ? AND mem_key = ?',
              )
              .get(chatbot.id, scope, row.kind, nextKey)
            if (conflict) {
              skippedConflicts += 1
              continue
            }
            const updated = this.db
              .prepare('UPDATE chatbot_memory_items SET mem_key = ?, value = ? WHERE id = ?')
              .run(nextKey, nextValue, row.id)
            if (Number(updated.changes) > 0) {
              if (memberId) migrated += 1
              else legacy += 1
              touchedGroups.add(`${chatbot.id}:${group.external_id}`)
            }
          }
        }
      }
      return { migrated, legacy, groups: touchedGroups.size, skippedConflicts }
    })
  }

  /**
   * 删除某成员在所有群共享 scope 下的条目（`/forget confirm` 用）：按稳定 member_openid 前缀精确匹配。
   * 返回删除数量与涉及群数；legacy 条目（无法映射归属）不删除，避免误删他人内容。
   */
  deleteMemberGroupItems(chatbotId: string, memberUserId: string): { items: number; groups: number } {
    const prefix = `${memberUserId}:`
    const groups = this.db
      .prepare("SELECT external_id FROM chatbot_targets WHERE chatbot_id = ? AND kind = 'group'")
      .all(chatbotId) as unknown as { external_id: string }[]
    let items = 0
    let touchedGroups = 0
    transaction(this.db, () => {
      for (const group of groups) {
        const scope = groupMemoryScope(group.external_id)
        const rows = this.db
          .prepare('SELECT id, mem_key FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
          .all(chatbotId, scope) as unknown as { id: string; mem_key: string }[]
        const ids = rows.filter((row) => row.mem_key.startsWith(prefix)).map((row) => row.id)
        if (ids.length === 0) continue
        const placeholders = ids.map(() => '?').join(',')
        const deleted = this.db.prepare(`DELETE FROM chatbot_memory_items WHERE id IN (${placeholders})`).run(...ids)
        items += Number(deleted.changes)
        touchedGroups += 1
      }
    })
    return { items, groups: touchedGroups }
  }

  /** 删除整个群 scope 的记忆（目标删除/改类型时清理孤儿群记忆）。 */
  deleteGroupScope(chatbotId: string, scope: string): number {
    if (!scope.startsWith(GROUP_MEMORY_PREFIX)) return 0
    return this.deleteUser(chatbotId, scope).deletedItems
  }

  /** 管理端条目元数据：只有 id/类型/重要度/置信度/时间，不含 key/value。 */
  listItems(chatbotId: string, userId: string, limit = 20, offset = 0): ChatbotMemoryListPage<ChatbotMemoryItemSummary> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 20)))
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
        .get(chatbotId, userId) as { c: number }
    ).c
    const rows = this.db
      .prepare(
        `SELECT id, kind, importance, confidence, updated_at, expires_at FROM chatbot_memory_items
         WHERE chatbot_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(chatbotId, userId, safeLimit, safeOffset) as unknown as MemoryItemRow[]
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        importance: row.importance,
        confidence: row.confidence,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
      })),
    }
  }

  /** 删除单条记忆（管理端）；返回是否删除。 */
  deleteItem(chatbotId: string, userId: string, itemId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM chatbot_memory_items WHERE id = ? AND chatbot_id = ? AND user_id = ?')
      .run(itemId, chatbotId, userId)
    return Number(result.changes) > 0
  }

  /** 删除用户全部结构化记忆、状态与旧摘要（/forget 或管理端整用户删除）。 */
  deleteUser(chatbotId: string, userId: string): { deletedItems: number; deletedLegacy: boolean; deletedState: boolean } {
    const legacy = this.db
      .prepare('SELECT memory_id FROM chatbot_ai_memories WHERE chatbot_id = ? AND user_id = ?')
      .get(chatbotId, userId) as { memory_id: string } | undefined
    const result = transaction(this.db, () => {
      const items = this.db.prepare('DELETE FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?').run(chatbotId, userId)
      const state = this.db.prepare('DELETE FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?').run(chatbotId, userId)
      const summary = this.db.prepare('DELETE FROM chatbot_ai_memories WHERE chatbot_id = ? AND user_id = ?').run(chatbotId, userId)
      return { deletedItems: Number(items.changes), deletedState: Number(state.changes) > 0, deletedLegacy: Number(summary.changes) > 0 }
    })
    if (legacy) this.removeMirror(legacy.memory_id)
    return result
  }

  /** 清理过期条目（tick 周期调用）。 */
  cleanup(): number {
    const result = this.db
      .prepare('DELETE FROM chatbot_memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(nowIso())
    return Number(result.changes)
  }

  /** 收集某 Chatbot 的 legacy 摘要 memory_id（删除 Chatbot 前调用，避免删行后无法定位镜像）。 */
  listBotMemoryIds(chatbotId: string): string[] {
    const rows = this.db
      .prepare('SELECT memory_id FROM chatbot_ai_memories WHERE chatbot_id = ?')
      .all(chatbotId) as unknown as { memory_id: string }[]
    return rows.map((row) => row.memory_id)
  }

  /** 删除指定镜像文件；只接受合法 memory_id，返回实际尝试删除的数量。 */
  removeMirrorFiles(memoryIds: readonly string[]): number {
    let removed = 0
    for (const memoryId of memoryIds) {
      try {
        this.removeMirror(memoryId)
        removed += 1
      } catch {
        // 非法 id/不可删时跳过，不影响 DB 删除结果。
      }
    }
    return removed
  }

  /**
   * 清理没有 DB 引用的镜像孤儿：只处理严格 `memory-<uuid>.md` 文件名，
   * 且 mtime 超过 maxAgeMs（默认 24h），避免与正在写入的摘要竞争。
   */
  cleanupOrphanMirrors(maxAgeMs = 24 * 3600_000): number {
    if (!existsSync(this.dir)) return 0
    let referenced: Set<string>
    try {
      const rows = this.db.prepare('SELECT memory_id FROM chatbot_ai_memories').all() as unknown as {
        memory_id: string
      }[]
      referenced = new Set(rows.map((row) => row.memory_id))
    } catch {
      // DB 不可用时不做破坏性清理。
      return 0
    }
    const now = Date.now()
    let removed = 0
    try {
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const match = /^memory-([0-9a-f-]{36})\.md$/i.exec(entry.name)
        if (!match) continue
        if (referenced.has(match[1]!)) continue
        const full = join(this.dir, entry.name)
        try {
          if (now - statSync(full).mtimeMs < maxAgeMs) continue
          rmSync(full, { force: true })
          removed += 1
        } catch {
          // 单个文件失败不影响其余清理。
        }
      }
    } catch {
      // 目录读取失败时保持现状。
    }
    return removed
  }

  /** 已迁移用户列表（legacy 清理 CLI 使用，只返回内部 id，不含正文）。 */
  listLegacyCleanupCandidates(): { chatbotId: string; userId: string; memoryId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT m.chatbot_id, m.user_id, m.memory_id FROM chatbot_ai_memories m
         JOIN chatbot_memory_state s ON s.chatbot_id = m.chatbot_id AND s.user_id = m.user_id
         WHERE s.legacy_migrated_at IS NOT NULL`,
      )
      .all() as unknown as { chatbot_id: string; user_id: string; memory_id: string }[]
    return rows.map((row) => ({ chatbotId: row.chatbot_id, userId: row.user_id, memoryId: row.memory_id }))
  }

  /** 删除已迁移用户的旧摘要行与镜像；dryRun 只统计数据。 */
  cleanupLegacyMigrated(dryRun: boolean): { users: number; files: number } {
    const candidates = this.listLegacyCleanupCandidates()
    if (dryRun) return { users: candidates.length, files: candidates.length }
    let files = 0
    for (const candidate of candidates) {
      const result = this.db
        .prepare('DELETE FROM chatbot_ai_memories WHERE chatbot_id = ? AND user_id = ? AND memory_id = ?')
        .run(candidate.chatbotId, candidate.userId, candidate.memoryId)
      if (Number(result.changes) > 0) {
        this.removeMirror(candidate.memoryId)
        files += 1
      }
    }
    return { users: candidates.length, files }
  }

  private ensureState(chatbotId: string, userId: string): MemoryStateRow {
    const existing = this.db
      .prepare('SELECT * FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?')
      .get(chatbotId, userId) as unknown as MemoryStateRow | undefined
    if (existing) return existing
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO chatbot_memory_state (chatbot_id, user_id, memory_enabled, legacy_migrated_at, created_at, updated_at)
         VALUES (?, ?, 1, NULL, ?, ?)`,
      )
      .run(chatbotId, userId, now, now)
    return {
      chatbot_id: chatbotId,
      user_id: userId,
      memory_enabled: 1,
      legacy_migrated_at: null,
      created_at: now,
      updated_at: now,
    }
  }

  private expiresAtFor(kind: ChatbotMemoryKind, nowIsoValue: string): string | null {
    if (kind === 'profile' || kind === 'preference') return null
    const days =
      kind === 'task'
        ? this.options.taskTtlDays
        : kind === 'episode'
          ? this.options.episodeTtlDays
          : this.options.factProjectTtlDays
    return new Date(new Date(nowIsoValue).getTime() + days * 86_400_000).toISOString()
  }

  private relevance(row: MemoryItemRow, tokens: Set<string>): number {
    if (tokens.size === 0) return 0
    const keyText = row.mem_key.toLowerCase()
    const valueText = row.value.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (keyText.includes(token)) score += 3
      if (valueText.includes(token)) score += 2
    }
    if (score === 0) return 0
    score += row.importance * 0.4
    const ageDays = Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 86_400_000)
    score += Math.max(0, 2 - ageDays / 30)
    return score
  }

  private validateOperations(ops: readonly ChatbotMemoryOperation[]): {
    upserts: ChatbotMemoryOperation[]
    deletes: Set<string>
    skipped: number
  } {
    const deletes = new Set<string>()
    const upsertMap = new Map<string, ChatbotMemoryOperation>()
    let skipped = 0
    for (const raw of ops.slice(0, 20)) {
      if (!raw || !CHATBOT_MEMORY_KINDS.includes(raw.kind) || (raw.op !== 'upsert' && raw.op !== 'delete')) {
        skipped += 1
        continue
      }
      const key = normalizeKey(String(raw.key ?? ''))
      if (!key) {
        skipped += 1
        continue
      }
      const id = `${raw.kind}\u0000${key}`
      if (raw.op === 'delete') {
        deletes.add(id)
        continue
      }
      const value = normalizeValue(String(raw.value ?? ''))
      // key 与 value 都做敏感/提示结构过滤；历史遗留的敏感条目在读取侧也会被排除。
      if (!value || isSensitive(value) || isSensitive(key)) {
        skipped += 1
        continue
      }
      upsertMap.set(id, {
        op: 'upsert',
        kind: raw.kind,
        key,
        value,
        confidence: clamp(Number(raw.confidence), 0, 1, 0.8),
        importance: Math.round(clamp(Number(raw.importance), 1, 5, 3)),
      })
    }
    for (const id of deletes) upsertMap.delete(id)
    return { upserts: [...upsertMap.values()], deletes, skipped }
  }

  private prune(chatbotId: string, userId: string, now: string): number {
    this.db
      .prepare('DELETE FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? AND expires_at IS NOT NULL AND expires_at <= ?')
      .run(chatbotId, userId, now)
    let pruned = 0
    let count = this.countItems(chatbotId, userId)
    while (count > this.options.maxItems) {
      const rows = this.db
        .prepare(
          `SELECT id FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?
           AND kind NOT IN ('profile','preference')
           ORDER BY importance ASC, updated_at ASC LIMIT ?`,
        )
        .all(chatbotId, userId, count - this.options.maxItems) as unknown as { id: string }[]
      if (rows.length === 0) break
      const ids = rows.map((row) => row.id)
      const placeholders = ids.map(() => '?').join(',')
      const result = this.db.prepare(`DELETE FROM chatbot_memory_items WHERE id IN (${placeholders})`).run(...ids)
      pruned += Number(result.changes)
      count = this.countItems(chatbotId, userId)
    }
    while (count > this.options.maxItems) {
      const rows = this.db
        .prepare(
          `SELECT id FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?
           ORDER BY importance ASC, updated_at ASC LIMIT ?`,
        )
        .all(chatbotId, userId, count - this.options.maxItems) as unknown as { id: string }[]
      if (rows.length === 0) break
      const ids = rows.map((row) => row.id)
      const placeholders = ids.map(() => '?').join(',')
      const result = this.db.prepare(`DELETE FROM chatbot_memory_items WHERE id IN (${placeholders})`).run(...ids)
      pruned += Number(result.changes)
      count = this.countItems(chatbotId, userId)
    }
    return pruned
  }

  private countItems(chatbotId: string, userId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
        .get(chatbotId, userId) as { c: number }
    ).c
  }

  private pathFor(memoryId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(memoryId)) throw new Error('invalid memory id')
    return join(this.dir, `memory-${memoryId}.md`)
  }

  private removeMirror(memoryId: string): void {
    try {
      rmSync(this.pathFor(memoryId), { force: true })
    } catch {
      // 镜像不存在或不可删时保持 DB 清理结果。
    }
  }
}
