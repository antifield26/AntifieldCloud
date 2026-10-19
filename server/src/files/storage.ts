/** 文件物理存储：路径由 DB id 派生，绝不接受客户端路径。 */
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReadStream } from 'node:fs'
import { newId } from '../util/ids.ts'

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
/** 启动时清理超过该时长的上传临时文件（崩溃/断电遗留）。 */
export const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export class FileStorage {
  readonly filesDir: string
  readonly tmpDir: string

  constructor(dataDir: string) {
    this.filesDir = join(dataDir, 'files')
    this.tmpDir = join(dataDir, 'tmp')
    mkdirSync(this.filesDir, { recursive: true })
    mkdirSync(this.tmpDir, { recursive: true })
  }

  assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error('非法文件 id')
  }

  finalPath(id: string): string {
    this.assertId(id)
    return join(this.filesDir, id.slice(0, 2), id)
  }

  tempPath(): string {
    return join(this.tmpDir, `${newId()}.part`)
  }

  ensureParent(id: string): void {
    mkdirSync(join(this.filesDir, id.slice(0, 2)), { recursive: true })
  }

  async moveIntoPlace(tempPath: string, id: string): Promise<void> {
    this.ensureParent(id)
    await rename(tempPath, this.finalPath(id))
  }

  /** 删除物理文件；返回失败原因（ENOENT 视为成功），由调用方决定是否记录日志。 */
  remove(id: string): Error | null {
    try {
      unlinkSync(this.finalPath(id))
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  removeTemp(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      // 忽略清理失败。
    }
  }

  /** 清理 tmp 目录中超过 maxAgeMs 的残留文件（仅普通文件），返回删除数量。 */
  cleanupTempFiles(maxAgeMs: number = TEMP_FILE_MAX_AGE_MS): number {
    let removed = 0
    let entries
    try {
      entries = readdirSync(this.tmpDir, { withFileTypes: true })
    } catch {
      return 0
    }
    const cutoff = Date.now() - Math.max(0, maxAgeMs)
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = join(this.tmpDir, entry.name)
      try {
        const stats = statSync(fullPath)
        if (stats.mtimeMs < cutoff) {
          unlinkSync(fullPath)
          removed += 1
        }
      } catch {
        // 单个文件清理失败不影响其它文件。
      }
    }
    return removed
  }

  stat(id: string): { size: number } {
    const value = statSync(this.finalPath(id))
    return { size: value.size }
  }

  createReadStream(id: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(this.finalPath(id), range)
  }
}
