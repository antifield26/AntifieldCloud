// 控制台纯函数 + 库落盘测试（fixture 取自 Pi 实测输出）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, dbModes } from '../src/db.js';
import {
  parseCpuLine,
  cpuPct,
  parseMeminfo,
  parseDiskWrittenKb,
  parseTemp,
  Sampler,
} from '../src/sys/metrics.js';
import { redact, assertUnit } from '../src/sys/logs.js';

void describe('sys', () => {
  void it('cpuPct: 空载约 0-1%', () => {
    const a = parseCpuLine('cpu  16492 13 3574 3304463 5748 0 19 0 0 0');
    const b = parseCpuLine('cpu  16500 13 3580 3305000 5748 0 19 0 0 0');
    const p = cpuPct(a, b);
    assert.ok(p >= 0 && p < 10, `pct=${p}`);
  });

  void it('parseMeminfo: 8G 卡', () => {
    const m = parseMeminfo('MemTotal:        8251712 kB\nMemFree: 1 kB\nMemAvailable:    4971024 kB\n');
    assert.equal(m.totalKb, 8251712);
    assert.equal(m.availKb, 4971024);
  });

  void it('parseDiskWrittenKb: mmcblk0 扇区/2', () => {
    const kb = parseDiskWrittenKb(' 179       0 mmcblk0 21470 16922 2596324 100287 10449 21286 531225 80768 0 39160 182660 0 0 0 0 7375 1604\n');
    assert.equal(kb, Math.round(531225 / 2));
  });

  void it('parseTemp: vcgencmd', () => {
    assert.equal(parseTemp("temp=47.2'C\n"), 47.2);
    assert.equal(parseTemp('nope'), null);
  });

  void it('redact: 凭据截断', () => {
    assert.equal(redact('OPENCODE_SERVER_PASSWORD=abc123'), 'OPENCODE_SERVER_PASSWORD=<redacted>');
    assert.equal(redact('token: xyz ok'), 'token: <redacted> ok');
    assert.equal(redact('plain log line'), 'plain log line');
  });

  void it('assertUnit: 拒绝注入', () => {
    assertUnit('ssh.service');
    assert.throws(() => assertUnit('a;b'), /invalid unit/);
    assert.throws(() => assertUnit('$(reboot)'), /invalid unit/);
  });

  void it('db: WAL+NORMAL, metrics 批量落盘可读', () => {
    const p = join(tmpdir(), `wb-test-${Date.now()}.db`);
    const d = openDb(p);
    const modes = dbModes(d);
    assert.equal(modes.journal_mode, 'wal');
    const s = new Sampler(d, 60_000, 60_000);
    const now = Date.now();
    (s as unknown as { buf: unknown[] }).buf.push(
      { ts: now - 1000, cpu: 0.5, memUsedKb: 100, memTotalKb: 200, tempC: 47.2, diskWrittenKb: 300 },
      { ts: now, cpu: null, memUsedKb: 101, memTotalKb: 200, tempC: null, diskWrittenKb: 301 },
    );
    assert.equal(s.flush(), 2);
    const rows = d.prepare('SELECT COUNT(*) AS n FROM metrics_ts').get() as { n: number };
    assert.equal(rows.n, 2);
    d.close();
    for (const suf of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(p + suf);
      } catch {
        // 忽略清理失败
      }
    }
  });
});
