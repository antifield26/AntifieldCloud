import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../logger.ts'

export type MemoryRole = 'user' | 'assistant'

export interface MemoryTurn {
  role: MemoryRole
  text: string
  at: string
}

interface MemoryFile {
  version: 1
  player: string
  uuid: string
  updatedAt: string
  turns: MemoryTurn[]
}

export interface MemoryStats {
  players: number
  turns: number
}

export interface MemoryStoreOptions {
  dir: string
  maxTurns: number
  retentionDays: number
  logger: Logger
}

function isMemoryRole (value: unknown): value is MemoryRole {
  return value === 'user' || value === 'assistant'
}

function parseMemoryFile (raw: string): MemoryFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return null
  if (typeof record.player !== 'string' || typeof record.uuid !== 'string') return null
  if (typeof record.updatedAt !== 'string' || !Array.isArray(record.turns)) return null
  const turns: MemoryTurn[] = []
  for (const item of record.turns) {
    if (!item || typeof item !== 'object') continue
    const turn = item as Record<string, unknown>
    if (!isMemoryRole(turn.role) || typeof turn.text !== 'string' || typeof turn.at !== 'string') continue
    turns.push({ role: turn.role, text: turn.text, at: turn.at })
  }
  return {
    version: 1,
    player: record.player,
    uuid: record.uuid,
    updatedAt: record.updatedAt,
    turns
  }
}

function safeKey (player: string, uuid: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    return uuid.toLowerCase()
  }
  return createHash('sha256').update(`${player}:${uuid}`).digest('hex').slice(0, 32)
}

export class MemoryStore {
  private readonly options: MemoryStoreOptions
  private readonly cache = new Map<string, MemoryFile>()
  private readonly pending = new Map<string, Promise<void>>()
  private cleanupTimer: NodeJS.Timeout | null = null
  private initialized = false

  constructor (options: MemoryStoreOptions) {
    this.options = options
  }

  async init (): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
    let names: string[] = []
    try {
      names = await readdir(this.options.dir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(this.options.dir, name)
      try {
        const raw = await readFile(file, 'utf8')
        const parsed = parseMemoryFile(raw)
        if (!parsed) {
          await this.quarantine(file, 'invalid-json')
          continue
        }
        const key = safeKey(parsed.player, parsed.uuid)
        this.cache.set(key, this.prune(parsed))
      } catch (error) {
        this.options.logger.warn('memory file unreadable', { file: name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(error => {
        this.options.logger.warn('memory cleanup failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }, 24 * 60 * 60 * 1000)
    this.cleanupTimer.unref?.()
  }

  private prune (file: MemoryFile): MemoryFile {
    const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000
    const filtered = file.turns.filter(turn => {
      const timestamp = Date.parse(turn.at)
      return Number.isNaN(timestamp) || timestamp >= cutoff
    })
    const turns = filtered.slice(-this.options.maxTurns * 2)
    return { ...file, turns, updatedAt: new Date().toISOString() }
  }

  private fileFor (key: string): string {
    return path.join(this.options.dir, `${key}.json`)
  }

  private async quarantine (file: string, reason: string): Promise<void> {
    const target = `${file}.corrupt-${Date.now()}`
    try {
      await rename(file, target)
      this.options.logger.warn('memory file quarantined', { file: path.basename(file), target: path.basename(target), reason })
    } catch (error) {
      this.options.logger.warn('memory file quarantine failed', { file: path.basename(file), error: error instanceof Error ? error.message : String(error) })
    }
  }

  load (player: string, uuid: string): MemoryTurn[] {
    const key = safeKey(player, uuid)
    return this.cache.get(key)?.turns.slice(-this.options.maxTurns * 2) ?? []
  }

  async append (player: string, uuid: string, userText: string, assistantText: string): Promise<void> {
    const key = safeKey(player, uuid)
    const previous = this.pending.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      const existing = this.cache.get(key) ?? {
        version: 1 as const,
        player,
        uuid,
        updatedAt: new Date().toISOString(),
        turns: []
      }
      const now = new Date().toISOString()
      const turns = [
        ...existing.turns,
        { role: 'user' as const, text: userText, at: now },
        { role: 'assistant' as const, text: assistantText, at: now }
      ].slice(-this.options.maxTurns * 2)
      const file: MemoryFile = { version: 1, player, uuid, updatedAt: now, turns }
      this.cache.set(key, file)
      await this.writeAtomic(key, file)
    })
    const guarded = run.then(() => {}, () => {})
    this.pending.set(key, guarded)
    try {
      await run
    } finally {
      if (this.pending.get(key) === guarded) this.pending.delete(key)
    }
  }

  private async writeAtomic (key: string, file: MemoryFile): Promise<void> {
    const target = this.fileFor(key)
    const temp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    await writeFile(temp, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, target)
  }

  stats (): MemoryStats {
    let turns = 0
    for (const file of this.cache.values()) turns += file.turns.length
    return { players: this.cache.size, turns }
  }

  async cleanupExpired (): Promise<void> {
    for (const [key, file] of this.cache) {
      const pruned = this.prune(file)
      if (pruned.turns.length === 0) {
        this.cache.delete(key)
        try {
          await unlink(this.fileFor(key))
        } catch {
          // ignore
        }
        continue
      }
      if (pruned.turns.length !== file.turns.length) {
        this.cache.set(key, pruned)
        await this.writeAtomic(key, pruned)
      }
    }
  }

  async stop (): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    await Promise.allSettled([...this.pending.values()])
  }
}
