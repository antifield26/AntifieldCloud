/**
 * 备份 CLI（在 Pi 上以 antifieldcloud 运行）：
 * - 一致性 SQLite 快照（node:sqlite backup）
 * - 全量：所有文件；增量：created_at > 上次成功备份时间的新增文件（内容不可变）
 * - 归档 snapshot-<UTC>-<full|inc>.tar.gz，记录 SHA-256 与大小
 * - 保留最近 2 个待拉取归档；空间不足时拒绝并返回 JSON 错误
 *
 * stdout 只输出一行 JSON 供 Windows 拉取脚本解析。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  statfsSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { promisify } from 'node:util'
import { ensureRuntimeDirs, loadConfig } from '../config.ts'
import { openDatabase } from '../db.ts'
import { audit } from '../auth/audit.ts'

const execFileAsync = promisify(execFile)
const GIB = 1024 * 1024 * 1024
const MAX_ARCHIVES = 2

interface BackupState {
  last_backup_at: string | null
  last_archive: string | null
}

interface FileEntry {
  id: string
  size: number
  created_at: string
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function freeBytes(path: string): number {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return 0
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function acquireLock(path: string): number {
  try {
    const fd = openSync(path, 'wx')
    writeFileSync(fd, String(process.pid))
    return fd
  } catch (error) {
    try {
      const stats = statSync(path)
      if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
        unlinkSync(path)
        return acquireLock(path)
      }
    } catch {
      // 锁文件不可读时继续抛原始错误。
    }
    throw new Error(
      `另一个备份正在进行（锁文件 ${path}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  ensureRuntimeDirs(config)
  const backupsDir = join(config.dataDir, 'backups')
  mkdirSync(backupsDir, { recursive: true })
  const lockPath = join(backupsDir, '.backup.lock')
  const lockFd = acquireLock(lockPath)
  const db = openDatabase({ path: join(config.dataDir, 'db.sqlite') })
  const created = new Date()
  const stamp = compactTimestamp(created)
  const createdAt = created.toISOString()
  const full = process.argv.includes('--full')
  let dbSnapshot: string | null = null
  let snapshotDb: DatabaseSync | null = null
  let manifestPath: string | null = null
  let listPath: string | null = null

  try {
    dbSnapshot = join(backupsDir, `db-${stamp}.sqlite`)
    await backup(db, dbSnapshot)
    const dbBytes = statSync(dbSnapshot).size
    snapshotDb = new DatabaseSync(dbSnapshot)
    const state = snapshotDb
      .prepare('SELECT last_backup_at, last_archive FROM backup_state WHERE id = 1')
      .get() as BackupState | undefined
    const previous = state?.last_backup_at ?? null
    const mode: 'full' | 'inc' = full || !previous ? 'full' : 'inc'

    const files = (
      mode === 'full'
        ? snapshotDb.prepare("SELECT id, size, created_at FROM files WHERE kind = 'file'").all()
        : snapshotDb
            .prepare("SELECT id, size, created_at FROM files WHERE kind = 'file' AND created_at > ?")
            .all(previous)
    ) as unknown as FileEntry[]

    const totalBytes = files.reduce((sum, file) => sum + Number(file.size), 0)
    const estimate = totalBytes + dbBytes
    const available = freeBytes(config.dataDir)
    if (available < estimate + 2 * GIB) {
      throw new Error(`磁盘空间不足：需要约 ${Math.ceil((estimate + 2 * GIB) / GIB)} GiB，可用 ${Math.ceil(available / GIB)} GiB`)
    }

    const manifest = {
      schema: 1,
      createdAt,
      mode,
      since: previous,
      database: `backups/db-${stamp}.sqlite`,
      files: files.map((file) => ({ id: file.id, size: Number(file.size), createdAt: file.created_at })),
      fileCount: files.length,
      totalBytes,
    }
    manifestPath = join(backupsDir, `manifest-${stamp}.json`)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const archiveName = `snapshot-${stamp}-${mode}.tar.gz`
    const archivePath = join(backupsDir, archiveName)
    listPath = join(backupsDir, `.files-${stamp}.txt`)
    const entries = [
      `backups/db-${stamp}.sqlite`,
      `backups/manifest-${stamp}.json`,
      ...files.map((file) => `files/${file.id.slice(0, 2)}/${file.id}`),
    ]
    writeFileSync(listPath, `${entries.join('\n')}\n`)
    await execFileAsync('tar', ['-czf', archivePath, '-C', config.dataDir, '--files-from', listPath], {
      maxBuffer: 16 * 1024 * 1024,
    })

    const sizeBytes = statSync(archivePath).size
    const sha256 = await sha256File(archivePath)
    db.prepare(
      'UPDATE backup_state SET last_backup_at = ?, last_archive = ?, last_sha256 = ?, last_size = ? WHERE id = 1',
    ).run(createdAt, archiveName, sha256, sizeBytes)
    audit(db, 'cli', 'backup_create', archiveName, { mode, files: files.length, sizeBytes }, null)

    const archives = readdirSync(backupsDir)
      .filter((name) => /^snapshot-.*\.tar\.gz$/.test(name) && name !== archiveName)
      .sort()
    for (const stale of archives.slice(0, Math.max(0, archives.length - (MAX_ARCHIVES - 1)))) {
      try {
        unlinkSync(join(backupsDir, stale))
      } catch {
        // 清理失败不阻塞本次备份。
      }
    }

    console.log(
      JSON.stringify({
        ok: true,
        mode,
        archive: resolve(archivePath),
        archiveName,
        sizeBytes,
        sha256,
        fileCount: files.length,
        totalBytes,
        createdAt,
      }),
    )
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        createdAt,
      }),
    )
    process.exitCode = 1
  } finally {
    try {
      db.close()
    } catch {
      // 忽略。
    }
    try {
      snapshotDb?.close()
    } catch {
      // 忽略。
    }
    for (const path of [dbSnapshot, manifestPath, listPath]) {
      if (path && existsSync(path)) {
        try {
          rmSync(path, { force: true })
        } catch {
          // 忽略清理失败。
        }
      }
    }
    try {
      closeSync(lockFd)
      unlinkSync(lockPath)
    } catch {
      // 忽略。
    }
  }
}

main().catch((error: unknown) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
