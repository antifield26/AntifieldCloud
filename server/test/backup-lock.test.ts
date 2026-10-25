/** DR-23：备份锁心跳与陈旧锁接管。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, releaseLock } from '../src/cli/backup-lock.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'antifieldcloud-lock-'))
}

test('备份锁持有期间刷新 mtime，释放后删除且可再次获取', async () => {
  const dir = tempDir()
  const path = join(dir, '.backup.lock')
  try {
    const lock = acquireLock(path, 20)
    const first = statSync(path).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 80))
    const second = statSync(path).mtimeMs
    assert.ok(second > first, '心跳应推进锁 mtime')
    assert.throws(() => acquireLock(path, 20), /另一个备份操作正在进行/)
    releaseLock(lock)
    assert.equal(existsSync(path), false)
    const again = acquireLock(path, 20)
    releaseLock(again)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超过 1 小时的陈旧锁可接管', () => {
  const dir = tempDir()
  const path = join(dir, '.backup.lock')
  try {
    writeFileSync(path, '99999')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(path, old, old)
    const lock = acquireLock(path, 20)
    releaseLock(lock)
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
