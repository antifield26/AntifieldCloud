import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupDir, tempDataDir } from './helpers.ts'

function runBackup(dir: string, full: boolean) {
  const result = spawnSync(process.execPath, [join('scripts', 'backup.mjs'), ...(full ? ['--full'] : [])], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dir,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_VERSION: '0.1.0-test',
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const line = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1)
  assert.ok(line, `备份没有输出 JSON：${result.stderr}`)
  return { status: result.status, json: JSON.parse(line) as Record<string, unknown>, stderr: result.stderr }
}

test('备份 CLI：首次全量、第二次增量、归档内容与校验和', () => {
  const dir = tempDataDir()
  try {
    const first = runBackup(dir, true)
    assert.equal(first.status, 0)
    assert.equal(first.json.ok, true)
    assert.equal(first.json.mode, 'full')
    const archive = String(first.json.archive)
    assert.equal(existsSync(archive), true)
    assert.match(String(first.json.sha256), /^[0-9a-f]{64}$/)

    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0)
    assert.match(listing.stdout, /manifest-.*\.json/)
    assert.match(listing.stdout, /db-.*\.sqlite/)

    const second = runBackup(dir, false)
    assert.equal(second.status, 0)
    assert.equal(second.json.mode, 'inc')
  } finally {
    cleanupDir(dir)
  }
})
