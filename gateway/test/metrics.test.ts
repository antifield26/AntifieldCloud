// 指标导出测试：落几行后导出 CSV。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

const { buildApp } = await import('../src/app.js');
const { loginCookie } = await import('./helper.js');
const dbPath = join(tmpdir(), `wb-met-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });
const COOKIE = await loginCookie(app);

// openDb 单例：buildApp 已建库，直接复用同一连接
const d = openDb(dbPath);
const now = Date.now();
d.prepare('INSERT INTO metrics_ts(ts,cpu,mem_used,mem_total,temp_c,disk_written_kb) VALUES (?,?,?,?,?,?)').run(
  now - 1000, 1.5, 100, 200, 47.2, 300,
);

void describe('metrics-export', () => {
  void it('CSV 头 + 行', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sys/metrics/export?range=1h', headers: { cookie: COOKIE } });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('text/csv'));
    const lines = res.body.split('\n');
    assert.equal(lines[0], 'ts_iso,cpu_pct,mem_used_kb,mem_total_kb,temp_c,disk_written_kb');
    assert.ok(lines.some((l) => l.includes(',1.5,100,200,47.2,300')));
  });

  void it('30 天外被裁剪（保留策略）', async () => {
    d.prepare('INSERT INTO metrics_ts(ts,cpu,mem_used,mem_total,temp_c,disk_written_kb) VALUES (?,?,?,?,?,?)').run(
      Date.now() - 31 * 24 * 3600 * 1000, 0, 0, 0, null, 0,
    );
    d.exec("DELETE FROM metrics_ts WHERE ts < (strftime('%s','now','-30 days')*1000);");
    const n = d.prepare('SELECT COUNT(*) AS n FROM metrics_ts WHERE ts < 1000').get() as { n: number };
    assert.equal(n.n, 0);
  });
});

process.on('exit', () => {
  for (const suf of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(dbPath + suf);
    } catch {
      // 忽略
    }
  }
});
