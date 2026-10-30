/**
 * 在线模式持久化：auto / always / off。
 *
 * 安全边界：只保存模式与更新元数据，不写 Token、服务器地址或玩家信息；
 * 文件原子替换（同目录临时文件 + rename），权限 0640，目录自动创建。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PresenceMode } from '../config.ts'

export interface PresenceModeState {
  mode: PresenceMode
  updatedAt: string
  updatedBy: string
}

function isMode (value: unknown): value is PresenceMode {
  return value === 'auto' || value === 'always' || value === 'off'
}

export class PresenceStore {
  private readonly file: string

  constructor (file: string) {
    this.file = file
  }

  /** 读取文件；不存在/损坏返回 null，由调用方回退到环境变量默认值。 */
  load (): PresenceModeState | null {
    try {
      if (!existsSync(this.file)) return null
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const record = raw as Record<string, unknown>
      if (!isMode(record.mode)) return null
      return {
        mode: record.mode,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy.slice(0, 64) : 'unknown'
      }
    } catch {
      return null
    }
  }

  save (state: PresenceModeState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...state })}\n`, { encoding: 'utf8', mode: 0o640 })
    renameSync(temp, this.file)
  }
}
