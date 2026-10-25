/** ARCH-05：审计写入失败不阻断业务，但必须可观测（计数 + 最近错误）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { audit, getAuditDiagnostics, resetAuditDiagnostics } from '../src/auth/audit.ts'
import { openDatabase } from '../src/db.ts'
import { cleanupDir, tempDataDir, testDb } from './helpers.ts'

test('审计成功不累计失败；DB 关闭后审计失败不抛错且诊断可见', () => {
  resetAuditDiagnostics()
  const dir = tempDataDir()
  const db = testDb(dir)
  try {
    audit(db, 'admin', 'test.action', 'target', { ok: true }, '127.0.0.1')
    const diagnostics = getAuditDiagnostics()
    assert.equal(diagnostics.failureCount, 0)
    assert.equal(diagnostics.lastError, null)
    assert.equal(diagnostics.lastFailureAt, null)

    // 关闭 DB 模拟磁盘/DB 故障：审计写入失败不得让已完成的业务操作抛错。
    db.close()
    assert.doesNotThrow(() => audit(db, 'admin', 'test.action', 'target', { ok: true }, '127.0.0.1'))
    const failed = getAuditDiagnostics()
    assert.equal(failed.failureCount, 1)
    assert.ok(failed.lastError)
    assert.ok(failed.lastFailureAt)

    // 再次失败累计计数。
    audit(db, 'admin', 'test.action', 'target', null, null)
    assert.equal(getAuditDiagnostics().failureCount, 2)
  } finally {
    resetAuditDiagnostics()
    try {
      db.close()
    } catch {
      // 已关闭。
    }
    cleanupDir(dir)
  }
})

test('审计失败计数持久化：重启后仍可见，DB 不可用时回退内存诊断', () => {
  const dir = tempDataDir()
  const path = `${dir}/db.sqlite`
  const db = openDatabase({ path })
  try {
    resetAuditDiagnostics(db)
    // 删除审计表制造写入失败，但保留持久化诊断表可用。
    db.exec('DROP TABLE audit_log')
    audit(db, 'admin', 'test.action', 'target', { ok: true }, '127.0.0.1')
    const diagnostics = getAuditDiagnostics(db)
    assert.equal(diagnostics.failureCount, 1)
    assert.equal(diagnostics.persisted, true)
    assert.ok(diagnostics.lastError)
    assert.ok(diagnostics.lastFailureAt)
  } finally {
    db.close()
  }
  // 重新打开数据库：持久化计数应保留。
  const reopened = openDatabase({ path })
  try {
    const diagnostics = getAuditDiagnostics(reopened)
    assert.equal(diagnostics.failureCount, 1)
    assert.equal(diagnostics.persisted, true)
    assert.ok(diagnostics.lastError)
    resetAuditDiagnostics(reopened)
    assert.equal(getAuditDiagnostics(reopened).failureCount, 0)
  } finally {
    reopened.close()
    resetAuditDiagnostics()
    cleanupDir(dir)
  }
})
