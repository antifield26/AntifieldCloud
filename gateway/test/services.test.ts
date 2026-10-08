import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { isAllowed, audit } from '../src/sys/services.js';

const WL = {
  allowed: [
    { unit: 'opencode.service', actions: ['restart', 'status'] },
    { unit: 'nginx.service', actions: ['status'] },
  ],
};

void describe('services', () => {
  void it('isAllowed: 精确命中', () => {
    assert.equal(isAllowed(WL, 'opencode.service', 'restart'), true);
    assert.equal(isAllowed(WL, 'opencode.service', 'status'), true);
    assert.equal(isAllowed(WL, 'nginx.service', 'restart'), false);
    assert.equal(isAllowed(WL, 'minecraft.service', 'status'), false);
    assert.equal(isAllowed(WL, 'opencode.service ', 'restart'), false);
    assert.equal(isAllowed(WL, 'opencode.service;reboot', 'restart'), false);
  });

  void it('audit: 拒绝行落库', () => {
    const p = join(tmpdir(), `wb-audit-${Date.now()}.db`);
    const d = openDb(p);
    audit(d, { actor: 'local', unit: 'minecraft.service', action: 'stop', allowed: 0, reason: 'not in whitelist' });
    const row = d.prepare('SELECT unit,allowed FROM service_audit ORDER BY id DESC LIMIT 1').get() as {
      unit: string;
      allowed: number;
    };
    assert.equal(row.unit, 'minecraft.service');
    assert.equal(row.allowed, 0);
    d.close();
    for (const suf of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(p + suf);
      } catch {
        // 忽略
      }
    }
  });
});
