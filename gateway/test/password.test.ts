// 口令校验：长度不同/空/正确/错误 均应稳定拒绝或接受，且不因长度提前短路到错误路径。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

const { verifyPassword, isConfigured, authDelayMs, authFailed, authOk, validSession, touchSession, newSession } = await import('../src/auth/password.js');
const { openDb } = await import('../src/db.js');

void describe('password', () => {
  void it('isConfigured 要求 ≥8 位', () => {
    assert.equal(isConfigured(), true);
  });

  void it('verifyPassword 接受正确口令', () => {
    assert.equal(verifyPassword('test-pass-123'), true);
  });

  void it('verifyPassword 拒绝错误/短/长/非字符串', () => {
    assert.equal(verifyPassword('test-pass-12'), false);
    assert.equal(verifyPassword('test-pass-1234'), false);
    assert.equal(verifyPassword('wrong-password'), false);
    assert.equal(verifyPassword(''), false);
    assert.equal(verifyPassword(123), false);
    assert.equal(verifyPassword(undefined), false);
  });

  void it('失败退避与锁定', () => {
    authOk();
    assert.equal(authDelayMs(), 0);
    authFailed();
    assert.ok(authDelayMs() >= 0);
    for (let i = 0; i < 12; i++) authFailed();
    assert.equal(authDelayMs(), -1);
    authOk();
    assert.equal(authDelayMs(), 0);
  });

  void it('会话 7d 绝对上限 + 滑动续期', async () => {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { rmSync } = await import('node:fs');
    const { openDb } = await import('../src/db.js');
    const p = join(tmpdir(), 'wb-ses-' + String(Date.now()) + '.db');
    const d = openDb(p);
    const s = newSession(d);
    assert.equal(validSession(d, s.id), true);
    d.prepare('UPDATE sessions SET created_at=?,expires_at=? WHERE id=?').run(
      Date.now() - 8 * 24 * 3600 * 1000, Date.now() + 3600000, s.id,
    );
    assert.equal(validSession(d, s.id), false);
    d.prepare('UPDATE sessions SET created_at=NULL,expires_at=? WHERE id=?').run(Date.now() + 3600000, s.id);
    assert.equal(validSession(d, s.id), false);
    const s2 = newSession(d);
    d.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() + 3600000, s2.id);
    const before = (d.prepare('SELECT expires_at AS e FROM sessions WHERE id=?').get(s2.id) as { e: number }).e;
    touchSession(d, s2.id);
    const after = (d.prepare('SELECT expires_at AS e FROM sessions WHERE id=?').get(s2.id) as { e: number }).e;
    assert.ok(after > before);
    process.env.WB_SESSION_SLIDING = '0';
    d.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() + 3600000, s2.id);
    touchSession(d, s2.id);
    const still = (d.prepare('SELECT expires_at AS e FROM sessions WHERE id=?').get(s2.id) as { e: number }).e;
    assert.ok(still < Date.now() + 3600000 + 60000);
    delete process.env.WB_SESSION_SLIDING;
    d.close();
    for (const suf of ['', '-wal', '-shm', '-journal']) {
      try { rmSync(p + suf); } catch { /* ignore */ }
    }
  });
});
