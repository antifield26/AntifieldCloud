import { appendFile, chmod, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, basename, join } from 'node:path'
import type { Logger } from './logger.ts'

export interface AuditEntry {
  event: string
  source: 'http_control' | 'chat' | 'ai_intent' | 'task' | 'movement' | 'combat' | 'system' | 'autonomy'
  actor: string
  action: string
  result: 'accepted' | 'completed' | 'denied' | 'failed' | 'interrupted'
  requestId?: string | null
  details?: Record<string, unknown>
}

export interface AuditLoggerOptions {
  file: string
  maxBytes: number
  retentionDays: number
  logger: Logger
}

const ROTATED_KEEP = 5

export class AuditLogger {
  private readonly options: AuditLoggerOptions
  private readonly logger: Logger
  private queue: Promise<void> = Promise.resolve()
  private stopped = false

  constructor (options: AuditLoggerOptions) {
    this.options = options
    this.logger = options.logger
  }

  async init (): Promise<void> {
    await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 })
    try {
      await stat(this.options.file)
      await chmod(this.options.file, 0o600)
    } catch {
      await writeFile(this.options.file, '', { mode: 0o600 })
    }
    await this.cleanup()
  }

  append (entry: AuditEntry): void {
    if (this.stopped) return
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      details: entry.details ?? {}
    })}\n`
    this.queue = this.queue
      .then(() => this.writeLine(line))
      .catch(error => {
        this.logger.warn('audit write failed', { error: error instanceof Error ? error.message : String(error) })
      })
  }

  async close (): Promise<void> {
    this.stopped = true
    await this.queue.catch(() => {})
  }

  private async writeLine (line: string): Promise<void> {
    await this.rotateIfNeeded(Buffer.byteLength(line))
    await appendFile(this.options.file, line, { mode: 0o600 })
  }

  private async rotateIfNeeded (incomingBytes: number): Promise<void> {
    let size = 0
    try {
      size = (await stat(this.options.file)).size
    } catch {
      return
    }
    if (size + incomingBytes <= this.options.maxBytes) return
    const ext = extname(this.options.file)
    const base = this.options.file.slice(0, this.options.file.length - ext.length)
    const rotated = (index: number): string => `${base}.${index}${ext}`
    await unlink(rotated(ROTATED_KEEP)).catch(() => {})
    for (let index = ROTATED_KEEP - 1; index >= 1; index--) {
      await rename(rotated(index), rotated(index + 1)).catch(() => {})
    }
    await rename(this.options.file, rotated(1)).catch(() => {})
    await writeFile(this.options.file, '', { mode: 0o600 })
    this.logger.info('audit rotated')
    await this.cleanup()
  }

  private async cleanup (): Promise<void> {
    const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000
    const dir = dirname(this.options.file)
    const prefix = basename(this.options.file).replace(extname(this.options.file), '')
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (!entry.startsWith(`${prefix}.`) || entry === basename(this.options.file)) continue
        const path = join(dir, entry)
        try {
          const info = await stat(path)
          if (info.mtimeMs < cutoff) await unlink(path)
        } catch {
          // ignore individual files
        }
      }
    } catch {
      // directory may not exist yet
    }
  }
}
