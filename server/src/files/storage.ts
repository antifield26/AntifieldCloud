/** 文件物理存储：路径由 DB id 派生，绝不接受客户端路径。 */
import { createReadStream, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReadStream } from 'node:fs'
import { newId } from '../util/ids.ts'

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

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

  remove(id: string): void {
    try {
      unlinkSync(this.finalPath(id))
    } catch {
      // 文件可能已被删除；调用方以 DB 为准。
    }
  }

  removeTemp(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      // 忽略清理失败。
    }
  }

  stat(id: string): { size: number } {
    const value = statSync(this.finalPath(id))
    return { size: value.size }
  }

  createReadStream(id: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(this.finalPath(id), range)
  }
}
