// 看门狗测试：evaluate 矩阵 + record 落 job_runs。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { evaluate, recordAlerts, type WatchOpts } from '../src/sys/watchdog.js';
import type { Sample } from '../src/sys/metrics.js';

const OPTS: WatchOpts = { tempAlertC: 75, memMinMb: 1024, backupMaxH: 26 };
const UNITS = { cloudflared: true, opencode: true, serve: true };
const S: Sample = { ts: 1, cpu: 1, memUsedKb: 7 * 1024 * 1024, memTotalKb: 8 * 1024 * 1024, tempC: 50, diskWrittenKb: 1 };
const NOW = Date.parse('2026-10-08T06:00:00Z');
const FRESH = { ts: '2026-10-08T05:00:00Z', status: 'ok' };

void describe('watchdog', () => {
  void it('全绿', () => {
    const cs = evaluate(S, FRESH, NOW, OPTS, UNITS);
    assert.ok(cs.every((c) => c.status === 'ok'));
  });

  void it('超温/低内存/断线/备份过期各告警', () => {
    const hot = evaluate({ ...S, tempC: 80 }, FRESH, NOW, OPTS, UNITS);
    assert.equal(hot.find((c) => c.name === 'temp')?.status, 'alert');
    const oom = evaluate({ ...S, memUsedKb: 8 * 1024 * 1024 - 100 * 1024 }, FRESH, NOW, OPTS, UNITS);
    assert.equal(oom.find((c) => c.name === 'mem')?.status, 'alert');
    const down = evaluate(S, FRESH, NOW, OPTS, { ...UNITS, cloudflared: false });
    assert.equal(down.find((c) => c.name === 'tunnel')?.status, 'alert');
    const stale = evaluate(S, { ts: '2026-10-06T00:00:00Z', status: 'ok' }, NOW, OPTS, UNITS);
    assert.equal(stale.find((c) => c.name === 'backup')?.status, 'alert');
    const failed = evaluate(S, { ts: '2026-10-08T05:00:00Z', status: 'failed' }, NOW, OPTS, UNITS);
    assert.equal(failed.find((c) => c.name === 'backup')?.status, 'alert');
    const none = evaluate(S, undefined, NOW, OPTS, UNITS);
    assert.equal(none.find((c) => c.name === 'backup')?.status, 'alert');
  });

  void it('record 落 job_runs，绿不记', () => {
    const p = join(tmpdir(), `wb-wd-${Date.now()}.db`);
    const d = openDb(p);
    assert.equal(recordAlerts(d, evaluate(S, FRESH, NOW, OPTS, UNITS)), 0);
    const n = recordAlerts(d, evaluate({ ...S, tempC: 99 }, FRESH, NOW, OPTS, UNITS));
    assert.equal(n, 1);
    const row = d.prepare("SELECT job_id,status,log FROM job_runs WHERE job_id='watchdog'").get() as {
      job_id: string; status: string; log: string;
    };
    assert.equal(row.status, 'alert');
    assert.ok(row.log.includes('temp'));
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
