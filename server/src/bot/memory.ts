/**
 * Bot 长期记忆存储：DB 为权威摘要，DATA_DIR/bot-memory 下的 Markdown 为镜像文件。
 * 安全边界：文件路径只由服务端生成的 memory UUID 组成；目录 0700、文件 0600；
 * 记忆正文不经过任何 HTTP API/前端读取（管理接口只返回长度等元数据）；文件写入使用临时文件 + 原子 rename。
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import type { BotMemorySummary } from './types.ts'

const MEMORY_TITLE = '# AntifieldCloud Bot Memory'
const FILE_READ_LIMIT = 32 * 1024

export interface BotMemory {
  botId: string
  userId: string
  memoryId: string
  summary: string
  sessionId: string | null
  filePath: string
  updatedAt: string
}

interface MemoryRow {
  bot_id: string
  user_id: string
  memory_id: string
  summary: string
  summary_session_id: string | null
  created_at: string
  updated_at: string
}

interface MemoryListRow {
  user_id: string
  summary: string
  created_at: string
  updated_at: string
}

function safeSummary(value: string, maxChars: number): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, Math.max(0, maxChars))
}

export class BotMemoryStore {
  readonly dir: string
  private readonly db: DatabaseSync
  private readonly maxChars: number

  constructor(db: DatabaseSync, dataDir: string, maxChars: number) {
    this.db = db
    this.dir = join(dataDir, 'bot-memory')
    this.maxChars = Math.max(512, Math.min(16384, maxChars))
  }

  /** 读取或惰性创建用户记忆；优先 DB 摘要，DB 为空时尝试镜像文件。 */
  get(botId: string, userId: string): BotMemory {
    const now = nowIso()
    let row = this.db
      .prepare('SELECT * FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?')
      .get(botId, userId) as unknown as MemoryRow | undefined
    if (!row) {
      const memoryId = newId()
      this.db
        .prepare(
          `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
           VALUES (?, ?, ?, '', NULL, ?, ?)`,
        )
        .run(botId, userId, memoryId, now, now)
      row = {
        bot_id: botId,
        user_id: userId,
        memory_id: memoryId,
        summary: '',
        summary_session_id: null,
        created_at: now,
        updated_at: now,
      }
    }
    const memory: BotMemory = {
      botId,
      userId,
      memoryId: row.memory_id,
      summary: row.summary,
      sessionId: row.summary_session_id,
      filePath: this.pathFor(row.memory_id),
      updatedAt: row.updated_at,
    }
    if (!memory.summary && existsSync(memory.filePath)) {
      try {
        const text = readFileSync(memory.filePath, 'utf8').slice(0, FILE_READ_LIMIT)
        const summary = safeSummary(text.replace(/^#[^\n]*\n+/, ''), this.maxChars)
        if (summary) {
          memory.summary = summary
          this.save(botId, userId, row.memory_id, summary, row.summary_session_id)
        }
      } catch {
        // 文件不可读时保持 DB 空摘要，后续轮次继续尝试。
      }
    }
    if (!existsSync(memory.filePath)) this.writeMirror(memory)
    return memory
  }

  /** 保存摘要与摘要会话；DB 先写，镜像文件失败不丢摘要。 */
  save(botId: string, userId: string, memoryId: string, summary: string, sessionId: string | null): BotMemory {
    const text = safeSummary(summary, this.maxChars)
    const now = nowIso()
    this.db
      .prepare(
        `UPDATE bot_ai_memories
         SET summary = ?, summary_session_id = ?, updated_at = ?
         WHERE bot_id = ? AND user_id = ? AND memory_id = ?`,
      )
      .run(text, sessionId, now, botId, userId, memoryId)
    const memory: BotMemory = {
      botId,
      userId,
      memoryId,
      summary: text,
      sessionId,
      filePath: this.pathFor(memoryId),
      updatedAt: now,
    }
    try {
      this.writeMirror(memory)
    } catch {
      // 镜像失败不影响 DB 权威记忆。
    }
    return memory
  }

  /** 管理页元数据分页：只返回长度/时间，不返回摘要正文。 */
  list(botId: string, limit = 20, offset = 0): BotMemorySummary[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 20)))
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
    const rows = this.db
      .prepare(
        `SELECT user_id, summary, created_at, updated_at FROM bot_ai_memories
         WHERE bot_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(botId, safeLimit, safeOffset) as unknown as MemoryListRow[]
    return rows.map((row) => ({
      userId: row.user_id,
      userName: null,
      summaryLength: row.summary.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  count(botId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM bot_ai_memories WHERE bot_id = ?')
      .get(botId) as { c: number }
    return row.c
  }

  /** 删除指定用户记忆（DB 行 + 镜像文件）；不存在返回 false。 */
  remove(botId: string, userId: string): boolean {
    const row = this.db
      .prepare('SELECT memory_id FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?')
      .get(botId, userId) as { memory_id: string } | undefined
    if (!row) return false
    try {
      rmSync(this.pathFor(row.memory_id), { force: true })
    } catch {
      // 镜像文件已不存在或不可删时仍继续删 DB 行。
    }
    const result = this.db
      .prepare('DELETE FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?')
      .run(botId, userId)
    return Number(result.changes) > 0
  }

  /** 清理超过保留期的映射与文件；摘要不再可用时静默跳过。 */
  cleanup(retentionDays: number): number {
    const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000).toISOString()
    const rows = this.db
      .prepare('SELECT memory_id FROM bot_ai_memories WHERE updated_at < ?')
      .all(cutoff) as unknown as { memory_id: string }[]
    for (const row of rows) {
      try {
        rmSync(this.pathFor(row.memory_id), { force: true })
      } catch {
        // 文件已不存在或不可删时保持 DB 清理。
      }
    }
    const result = this.db.prepare('DELETE FROM bot_ai_memories WHERE updated_at < ?').run(cutoff)
    return Number(result.changes)
  }

  private pathFor(memoryId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(memoryId)) throw new Error('invalid memory id')
    return join(this.dir, `memory-${memoryId}.md`)
  }

  private writeMirror(memory: BotMemory): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const body = `${MEMORY_TITLE}\n\n> 更新时间：${memory.updatedAt}\n\n${memory.summary || '（尚无记忆）'}\n`
    const temp = `${memory.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, memory.filePath)
    chmodSync(memory.filePath, 0o600)
  }
}
