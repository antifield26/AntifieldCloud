// 看门狗测试：evaluate 矩阵 + record 落 job_runs。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { evaluate, recordAlerts, todoCheck, sendAlert, redactUrl, type WatchOpts } from '../src/sys/watchdog.js';
import type { Sample } from '../src/sys/metrics.js';

const OPTS: WatchOpts = { tempAlertC: 75, memMinMb: 1024, backupMaxH: 26, drillMaxD: 14, diskMinGb: 5, logMaxPct: 80 };
const UNITS = { cloudflared: true, opencode: true, serve: true };
const S: Sample = { ts: 1, cpu: 1, memUsedKb: 7 * 1024 * 1024, memTotalKb: 8 * 1024 * 1024, tempC: 50, diskWrittenKb: 1 };
const NOW = Date.parse('2026-10-08T06:00:00Z');
const FRESH = { ts: '2026-10-08T05:00:00Z', status: 'ok' };

void describe('watchdog', () => {
  void it('全绿', () => {
    const cs = evaluate(S, FRESH, NOW, OPTS, UNITS, { started_at: '2026-10-07T05:00:00Z', status: 'ok' }, { freeGb: 24, logPct: 3 });
    assert.ok(cs.every((c) => c.status === 'ok'));
  });

  void it('演练过期/失败/缺失告警', () => {
    const stale = evaluate(S, FRESH, NOW, OPTS, UNITS, { started_at: '2026-09-01T00:00:00Z', status: 'ok' });
    assert.equal(stale.find((c) => c.name === 'drill')?.status, 'alert');
    const failed = evaluate(S, FRESH, NOW, OPTS, UNITS, { started_at: '2026-10-08T00:00:00Z', status: 'failed' });
    assert.equal(failed.find((c) => c.name === 'drill')?.status, 'alert');
    const none = evaluate(S, FRESH, NOW, OPTS, UNITS, undefined);
    assert.equal(none.find((c) => c.name === 'drill')?.status, 'alert');
  });

  void it('待办到期进告警', () => {
    assert.equal(todoCheck([]).status, 'ok');
    const a = todoCheck(['买牛奶', '交电费']);
    assert.equal(a.status, 'alert');
    assert.ok(a.detail.includes('买牛奶'));
  });

  void it('redactUrl 只留 host', () => {
    assert.equal(redactUrl('https://ntfy.sh/mytopic'), 'ntfy.sh');
    assert.equal(redactUrl('not a url'), '(bad-url)');
  });

  void it('sendAlert：空 URL 跳过、成功 1 次、失败 3 次记行且不泄 URL', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    assert.equal(await sendAlert([{ name: 't', status: 'alert', detail: 'x' }], 'x'), false);
    const { createServer } = await import('node:http');
    let hits = 0;
    const srv = createServer((req, res) => {
      hits++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body) as { source: string };
        if (j.source !== 'workbench-watchdog') {
          res.writeHead(400);
          res.end();
          return;
        }
        res.writeHead(hits < 3 ? 500 : 200);
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook?token=secret123`;
    assert.equal(await sendAlert([{ name: 't', status: 'alert', detail: 'x' }], 'x'), true);
    assert.equal(hits, 3);
    delete process.env.ALERT_WEBHOOK_URL;
    await new Promise<void>((r) => srv.close(() => r()));
  });

  void it('磁盘水位矩阵', () => {
    const fresh = { started_at: '2026-10-07T05:00:00Z', status: 'ok' };
    const ok = evaluate(S, FRESH, NOW, OPTS, UNITS, fresh, { freeGb: 24, logPct: 3 });
    assert.equal(ok.find((c) => c.name === 'disk')?.status, 'ok');
    const full = evaluate(S, FRESH, NOW, OPTS, UNITS, fresh, { freeGb: 2, logPct: 3 });
    assert.equal(full.find((c) => c.name === 'disk')?.status, 'alert');
    const logs = evaluate(S, FRESH, NOW, OPTS, UNITS, fresh, { freeGb: 24, logPct: 95 });
    assert.equal(logs.find((c) => c.name === 'disk')?.status, 'alert');
    const nodata = evaluate(S, FRESH, NOW, OPTS, UNITS, fresh, { freeGb: null as unknown as number, logPct: null });
    assert.equal(nodata.find((c) => c.name === 'disk')?.status, 'unknown');
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
    const fresh = { started_at: '2026-10-07T05:00:00Z', status: 'ok' };
    const diskOk = { freeGb: 24, logPct: 3 };
    assert.equal(recordAlerts(d, evaluate(S, FRESH, NOW, OPTS, UNITS, fresh, diskOk)), 0);
    const n = recordAlerts(d, evaluate({ ...S, tempC: 99 }, FRESH, NOW, OPTS, UNITS, fresh, diskOk));
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
