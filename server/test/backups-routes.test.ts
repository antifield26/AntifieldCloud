/** 备份路由测试：认证/CSRF/TOTP/限流、import/verify/restore-plan/execute 与错误码。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { BackupRunner } from '../src/backups/service.ts'
import {
  backupsFixture,
  buildArchive,
  createBackupApp,
  multipartFileBody,
  type BackupTestApp,
  type BackupsFixture,
} from './backups-fixtures.ts'

const T1 = '2026-06-01T00:00:00.000Z'
const T2 = '2026-06-02T00:00:00.000Z'
const FILE_A = 'aaaa1111-1111-4111-8111-111111111111'
const FILE_B = 'bbbb2222-2222-4222-8222-222222222222'
const CONTENT_A = Buffer.from('route content a')
const CONTENT_B = Buffer.from('route content b')

function happyRunner(): BackupRunner {
  return async () => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      mode: 'full',
      archiveName: 'snapshot-20260601T120000Z-full.tar.gz',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      fileCount: 0,
    }),
    stderr: '',
  })
}

async function seedArchives(fx: BackupsFixture): Promise<{ full: string; inc: string }> {
  const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
  const full = buildArchive({
    createdAt: T1,
    mode: 'full',
    workDir: fx.dir,
    snapshotRows: [{ id: FILE_A, name: 'a.txt', size: CONTENT_A.length, sha256: sha(CONTENT_A) }],
    contents: [{ id: FILE_A, data: CONTENT_A }],
  })
  const inc = buildArchive({
    createdAt: T2,
    mode: 'inc',
    since: T1,
    workDir: fx.dir,
    snapshotRows: [
      { id: FILE_A, name: 'a.txt', size: CONTENT_A.length, sha256: sha(CONTENT_A) },
      { id: FILE_B, name: 'b.txt', size: CONTENT_B.length, sha256: sha(CONTENT_B) },
    ],
    contents: [{ id: FILE_B, data: CONTENT_B }],
  })
  await fx.service.importArchive(fx.actor, { filename: full.name, stream: Readable.from(full.buffer) })
  await fx.service.importArchive(fx.actor, { filename: inc.name, stream: Readable.from(inc.buffer) })
  return { full: full.name, inc: inc.name }
}

async function closeAll(...apps: (BackupTestApp | null)[]): Promise<void> {
  for (const entry of apps) if (entry) await entry.close()
}

test('未登录 401；登录后清单字段完整', async () => {
  const fx = backupsFixture()
  const app = await createBackupApp(fx)
  try {
    const anonymous = await app.app.inject({ method: 'GET', url: '/api/backups' })
    assert.equal(anonymous.statusCode, 401)
    const list = await app.app.inject({ method: 'GET', url: '/api/backups', headers: app.authHeaders() })
    assert.equal(list.statusCode, 200)
    const body = list.json() as { items: unknown[]; inbox: unknown[]; orphans: unknown[]; state: Record<string, unknown> }
    assert.deepEqual(Object.keys(body).sort(), ['inbox', 'items', 'orphans', 'state'])
    assert.equal(body.state.importCount, 0)
    assert.ok(!JSON.stringify(list.json()).includes(fx.dir), '清单不得包含绝对路径')
  } finally {
    await closeAll(app)
    fx.close()
  }
})

test('prepare：TOTP/确认词/限流/脚本失败', async () => {
  const okFixture = backupsFixture({ runner: happyRunner() })
  const okApp = await createBackupApp(okFixture)
  try {
    const ok = await okApp.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: okApp.authHeaders(),
      payload: { totpCode: okApp.totp(), confirmText: 'PREPARE' },
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().ok, true)
    assert.equal(ok.json().mode, 'full')
    const audit = okFixture.db.prepare("SELECT action FROM audit_log WHERE action = 'backup_prepare'").get() as
      | { action: string }
      | undefined
    assert.ok(audit)
  } finally {
    await closeAll(okApp)
    okFixture.close()
  }

  const errorFixture = backupsFixture({ runner: happyRunner() })
  const errorApp = await createBackupApp(errorFixture)
  try {
    const noTotp = await errorApp.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: errorApp.authHeaders(),
      payload: { confirmText: 'PREPARE' },
    })
    assert.equal(noTotp.statusCode, 401)
    assert.equal(noTotp.json().error.code, 'invalid_totp')
    const badTotp = await errorApp.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: errorApp.authHeaders(),
      payload: { totpCode: '000000', confirmText: 'PREPARE' },
    })
    assert.equal(badTotp.statusCode, 401)
    const noConfirm = await errorApp.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: errorApp.authHeaders(),
      payload: { totpCode: errorApp.totp() },
    })
    assert.equal(noConfirm.statusCode, 400)
    assert.equal(noConfirm.json().error.code, 'confirmation_failed')
  } finally {
    await closeAll(errorApp)
    errorFixture.close()
  }

  const failing = backupsFixture({
    runner: async () => ({ code: 1, stdout: '', stderr: `备份失败 ${'x'}` }),
  })
  const failingApp = await createBackupApp(failing)
  try {
    const response = await failingApp.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: failingApp.authHeaders(),
      payload: { totpCode: failingApp.totp(), confirmText: 'PREPARE' },
    })
    assert.equal(response.statusCode, 502)
    assert.equal(response.json().error.code, 'backup_prepare_failed')
    assert.ok(!JSON.stringify(response.json()).includes(failing.dir))
  } finally {
    await closeAll(failingApp)
    failing.close()
  }

  const limited = backupsFixture({ runner: happyRunner() })
  const limitedApp = await createBackupApp(limited)
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await limitedApp.app.inject({
        method: 'POST',
        url: '/api/backups/prepare',
        headers: limitedApp.authHeaders(),
        payload: { totpCode: limitedApp.totp(), confirmText: 'PREPARE' },
      })
      assert.equal(response.statusCode, 200)
    }
    const fourth = await limitedApp.app.inject({
      method: 'POST',
      url: '/api/backups/prepare',
      headers: limitedApp.authHeaders(),
      payload: { totpCode: limitedApp.totp(), confirmText: 'PREPARE' },
    })
    assert.equal(fourth.statusCode, 429)
    assert.equal(fourth.json().error.code, 'rate_limited')
  } finally {
    await closeAll(limitedApp)
    limited.close()
  }
})

test('import：multipart、TOTP 请求头、CSRF 与文件名白名单', async () => {
  const fx = backupsFixture()
  const app = await createBackupApp(fx)
  try {
    const archive = buildArchive({
      createdAt: T1,
      mode: 'full',
      workDir: fx.dir,
      snapshotRows: [],
      contents: [],
    })
    const body = multipartFileBody(archive.name, archive.buffer)

    const noCsrf = await app.app.inject({
      method: 'POST',
      url: '/api/backups/import',
      headers: { cookie: `af_session=${'backup-test-session'}`, 'content-type': body.contentType, 'x-totp-code': app.totp() },
      payload: body.payload,
    })
    assert.equal(noCsrf.statusCode, 403)

    const noTotp = await app.app.inject({
      method: 'POST',
      url: '/api/backups/import',
      headers: { ...app.authHeaders(), 'content-type': body.contentType },
      payload: body.payload,
    })
    assert.equal(noTotp.statusCode, 401)
    assert.equal(noTotp.json().error.code, 'invalid_totp')

    const badNameBody = multipartFileBody('evil.tar.gz', archive.buffer)
    const badName = await app.app.inject({
      method: 'POST',
      url: '/api/backups/import',
      headers: { ...app.authHeaders(), 'content-type': badNameBody.contentType, 'x-totp-code': app.totp() },
      payload: badNameBody.payload,
    })
    assert.equal(badName.statusCode, 400)
    assert.equal(badName.json().error.code, 'invalid_archive_name')

    const imported = await app.app.inject({
      method: 'POST',
      url: '/api/backups/import',
      headers: { ...app.authHeaders(), 'content-type': body.contentType, 'x-totp-code': app.totp() },
      payload: body.payload,
    })
    assert.equal(imported.statusCode, 201)
    const importedBody = imported.json() as { archive: { name: string; origin: string }; verify: { ok: boolean } }
    assert.equal(importedBody.archive.name, archive.name)
    assert.equal(importedBody.archive.origin, 'import')
    assert.equal(importedBody.verify.ok, true)
  } finally {
    await closeAll(app)
    fx.close()
  }
})

test('verify/entries/restore-plan/execute 全流程与二次执行冲突', async () => {
  const fx = backupsFixture()
  const app = await createBackupApp(fx)
  try {
    const { full, inc } = await seedArchives(fx)
    const verify = await app.app.inject({
      method: 'POST',
      url: '/api/backups/verify',
      headers: app.authHeaders(),
      payload: { name: inc },
    })
    assert.equal(verify.statusCode, 200)
    assert.equal(verify.json().ok, true)
    assert.ok(verify.json().archive.verifiedAt)

    const entries = await app.app.inject({
      method: 'GET',
      url: `/api/backups/archives/${encodeURIComponent(inc)}/entries?path=/`,
      headers: app.authHeaders(),
    })
    assert.equal(entries.statusCode, 200)
    assert.deepEqual(
      (entries.json().items as { name: string }[]).map((item) => item.name).sort(),
      ['a.txt', 'b.txt'],
    )

    const noConfirm = await app.app.inject({
      method: 'POST',
      url: '/api/backups/restore-plan',
      headers: app.authHeaders(),
      payload: { archive: inc, paths: ['/'], totpCode: app.totp() },
    })
    assert.equal(noConfirm.statusCode, 400)
    assert.equal(noConfirm.json().error.code, 'confirmation_failed')

    const noTotp = await app.app.inject({
      method: 'POST',
      url: '/api/backups/restore-plan',
      headers: app.authHeaders(),
      payload: { archive: inc, paths: ['/'], confirmText: 'RESTORE' },
    })
    assert.equal(noTotp.statusCode, 401)

    const planned = await app.app.inject({
      method: 'POST',
      url: '/api/backups/restore-plan',
      headers: app.authHeaders(),
      payload: { archive: inc, paths: ['/'], totpCode: app.totp(), confirmText: 'RESTORE', targetName: '路由恢复' },
    })
    assert.equal(planned.statusCode, 200)
    const plan = planned.json().plan as { id: string; status: string; archives: string[]; fileCount: number }
    assert.equal(plan.status, 'planned')
    assert.deepEqual(plan.archives, [full, inc])
    assert.equal(plan.fileCount, 2)

    const fetched = await app.app.inject({ method: 'GET', url: `/api/restores/${plan.id}`, headers: app.authHeaders() })
    assert.equal(fetched.statusCode, 200)
    assert.equal(fetched.json().plan.id, plan.id)

    const wrongTotp = await app.app.inject({
      method: 'POST',
      url: `/api/restores/${plan.id}/execute`,
      headers: app.authHeaders(),
      payload: { totpCode: '000000', confirmText: 'RESTORE' },
    })
    assert.equal(wrongTotp.statusCode, 401)

    const executed = await app.app.inject({
      method: 'POST',
      url: `/api/restores/${plan.id}/execute`,
      headers: app.authHeaders(),
      payload: { totpCode: app.totp(), confirmText: 'RESTORE' },
    })
    assert.equal(executed.statusCode, 200)
    const executedBody = executed.json() as {
      plan: { status: string }
      result: { targetFolderId: string; filesRestored: number; bytesRestored: number }
    }
    assert.equal(executedBody.plan.status, 'completed')
    assert.equal(executedBody.result.filesRestored, 2)
    assert.equal(executedBody.result.bytesRestored, CONTENT_A.length + CONTENT_B.length)

    const again = await app.app.inject({
      method: 'POST',
      url: `/api/restores/${plan.id}/execute`,
      headers: app.authHeaders(),
      payload: { totpCode: app.totp(), confirmText: 'RESTORE' },
    })
    assert.equal(again.statusCode, 409)
    assert.equal(again.json().error.code, 'plan_completed')

    const missing = await app.app.inject({ method: 'GET', url: '/api/restores/nope', headers: app.authHeaders() })
    assert.equal(missing.statusCode, 404)

    const conflictPlan = await app.app.inject({
      method: 'POST',
      url: '/api/backups/restore-plan',
      headers: app.authHeaders(),
      payload: { archive: inc, paths: ['/'], totpCode: app.totp(), confirmText: 'RESTORE' },
    })
    assert.equal(conflictPlan.statusCode, 200)
    const bodies = [fetched.body, executed.body, entries.body].join('\n')
    assert.ok(!bodies.includes(fx.dir), '响应体不得包含服务器绝对路径')
  } finally {
    await closeAll(app)
    fx.close()
  }
})

test('恢复开关关闭时 plan/execute 403', async () => {
  const fx = backupsFixture({ config: { backupRestoreEnabled: false } })
  const app = await createBackupApp(fx)
  try {
    await seedArchives(fx)
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/backups/restore-plan',
      headers: app.authHeaders(),
      payload: { archive: 'snapshot-20260602T000000Z-inc.tar.gz', paths: ['/'], totpCode: app.totp(), confirmText: 'RESTORE' },
    })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'restore_disabled')
  } finally {
    await closeAll(app)
    fx.close()
  }
})
