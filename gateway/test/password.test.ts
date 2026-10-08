// 口令校验：长度不同/空/正确/错误 均应稳定拒绝或接受，且不因长度提前短路到错误路径。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

const { verifyPassword, isConfigured, authDelayMs, authFailed, authOk } = await import('../src/auth/password.js');

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
});
