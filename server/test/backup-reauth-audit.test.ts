/** SEC-03：备份危险操作 TOTP 再认证失败必须写审计（防暴力尝试不可见）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { backupsFixture, createBackupApp } from './backups-fixtures.ts'

test('SEC-03：备份 prepare TOTP 失败写入 backup_reauth_failed 审计', async () => {
  const fx = backupsFixture()
  const app = await createBackupApp(fx)
  try {
    const rejected = await app.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: { ...app.authHeaders(), 'x-totp-code': '000000' },
      payload: { confirmText: 'PREPARE' },
    })
    assert.equal(rejected.statusCode, 401)
    const row = fx.db
      .prepare("SELECT actor, target, detail_json FROM audit_log WHERE action = 'backup_reauth_failed'")
      .get() as { actor: string; target: string; detail_json: string } | undefined
    assert.ok(row, '应写 backup_reauth_failed 审计')
    assert.equal(row.target, 'prepare')
    assert.match(row.detail_json, /route/)
    assert.doesNotMatch(row.detail_json, /000000/, '审计不得记录 TOTP 明文')
  } finally {
    await app.close()
    fx.close()
  }
})
