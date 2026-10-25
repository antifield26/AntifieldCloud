/**
 * 备份锁：单文件 wx 创建 + 持有期间 mtime 心跳续租。
 * 安全边界：锁只用于备份 CLI 互斥；进程被杀后超过 1 小时允许接管，不存放敏感内容。
 */
import { closeSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'

export interface BackupLockHandle {
  fd: number
  path: string
  timer: NodeJS.Timeout
}

export function acquireLock(path: string, heartbeatMs = 30_000): BackupLockHandle {
  try {
    const fd = openSync(path, 'wx')
    writeFileSync(fd, String(process.pid))
    const timer = setInterval(() => {
      try {
        const now = new Date()
        utimesSync(path, now, now)
      } catch {
        // 锁已被删除/不可写时停止心跳；释放阶段仍会清理。
      }
    }, Math.max(10, heartbeatMs))
    timer.unref()
    return { fd, path, timer }
  } catch (error) {
    try {
      const stats = statSync(path)
      // 进程被杀后遗留的锁：超过 1 小时视为陈旧，允许接管。
      if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
        unlinkSync(path)
        return acquireLock(path, heartbeatMs)
      }
    } catch {
      // 锁文件不可读时继续抛原始错误。
    }
    throw new Error(
      `另一个备份操作正在进行（锁文件 ${path}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export function releaseLock(lock: BackupLockHandle): void {
  clearInterval(lock.timer)
  try {
    closeSync(lock.fd)
  } catch {
    // 忽略关闭失败。
  }
  try {
    unlinkSync(lock.path)
  } catch {
    // 忽略清理失败。
  }
}
