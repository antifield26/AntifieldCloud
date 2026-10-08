import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { Sampler, parseDiskWrittenKb, parseDfLine, writeRatePerDay, daysLeft } from '../sys/metrics.js';
import { queryLogs, journalUsage, aptUpgradable } from '../sys/logs.js';
import { dbModes } from '../db.js';
import { runWatchdog } from '../sys/watchdog.js';

function sh(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err !== null ? '' : String(stdout));
    });
  });
}

/** 允许部分失败的执行（du 扫到无权目录也保留已输出部分） */
function shKeep(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (_err, stdout) => {
      resolve(String(stdout ?? ''));
    });
  });
}

/** du -sh 人性化尺寸转 bytes（排序用） */
export function parseSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)([KMGT]?)$/i);
  if (m === null) return 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 } as Record<string, number>;
  return Number(m[1]) * (mult[m[2].toUpperCase()] ?? 0);
}

let topCache: { at: number; body: Record<string, unknown> } = { at: 0, body: {} };

export function registerSysRoutes(app: FastifyInstance, db: DatabaseSync, sampler: Sampler): void {
  app.get('/api/sys/overview', async () => {
    const s = sampler.latest() ?? (await sampler.collect());
    const [diskstats, journal] = await Promise.all([
      readFile('/proc/diskstats', 'utf8').catch(() => ''),
      journalUsage(),
    ]);
    return {
      ts: s.ts,
      cpuPct: s.cpu,
      memUsedKb: s.memUsedKb,
      memTotalKb: s.memTotalKb,
      tempC: s.tempC,
      diskWrittenKb: parseDiskWrittenKb(diskstats),
      journal,
      db: dbModes(db),
    };
  });

  app.get<{ Querystring: { range?: string } }>('/api/sys/metrics', async (req) => {
    const rangeMs = req.query.range === '24h' ? 24 * 3600 * 1000 : req.query.range === '7d' ? 7 * 24 * 3600 * 1000 : 3600 * 1000;
    const range: string = req.query.range === '7d' ? '7d' : req.query.range === '24h' ? '24h' : '1h';
    const rows = db
      .prepare('SELECT ts,cpu,mem_used AS memUsedKb,mem_total AS memTotalKb,temp_c AS tempC,disk_written_kb AS diskWrittenKb FROM metrics_ts WHERE ts > ? ORDER BY ts')
      .all(Date.now() - rangeMs) as Array<Record<string, unknown>>;
    return { range, points: rows };
  });

  app.get<{ Querystring: { range?: string } }>(
    '/api/sys/metrics/export',
    async (req, reply) => {
      const rangeMs = req.query.range === '24h' ? 24 * 3600 * 1000 : req.query.range === '7d' ? 7 * 24 * 3600 * 1000 : 3600 * 1000;
      const rows = db
        .prepare('SELECT ts,cpu,mem_used,mem_total,temp_c,disk_written_kb FROM metrics_ts WHERE ts > ? ORDER BY ts')
        .all(Date.now() - rangeMs) as Array<Record<string, unknown>>;
      const head = 'ts_iso,cpu_pct,mem_used_kb,mem_total_kb,temp_c,disk_written_kb';
      const lines = rows.map((r) =>
        [new Date(Number(r.ts)).toISOString(), r.cpu ?? '', r.mem_used, r.mem_total, r.temp_c ?? '', r.disk_written_kb].join(','),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="metrics-${req.query.range ?? '1h'}.csv"`)
        .send([head, ...lines].join('\n'));
    },
  );

  app.get('/api/sys/disk', async () => {
    const [df, diskstats] = await Promise.all([
      sh('/usr/bin/df', ['-hT', '/', '/tmp', '/var/log'], 10000),
      readFile('/proc/diskstats', 'utf8').catch(() => ''),
    ]);
    return { df, diskWrittenKb: parseDiskWrittenKb(diskstats), journal: await journalUsage() };
  });

  // SD 健康代理：SD 无寿命 telemetry，用剩余/速率/天数/水位/TOP5 代测（du 结果缓存 10min）。
  app.get('/api/sys/disk-health', async () => {
    const nowMs = Date.now();
    if (topCache.at > 0 && nowMs - topCache.at < 10 * 60 * 1000) {
      return { ...topCache.body, cached: true };
    }
    const [dfB, dfH] = await Promise.all([
      sh('/usr/bin/df', ['-B1', '/', '/var/log', '/tmp'], 10000),
      sh('/usr/bin/df', ['-h', '/', '/var/log'], 10000),
    ]);
    const root = parseDfLine(dfB, '/');
    const logFs = parseDfLine(dfB, '/var/log');
    const rows = db
      .prepare('SELECT ts,disk_written_kb AS diskWrittenKb FROM metrics_ts WHERE ts > ? ORDER BY ts')
      .all(nowMs - 25 * 3600 * 1000) as Array<{ ts: number; diskWrittenKb: number }>;
    const perDayKb = writeRatePerDay(rows, nowMs);
    const freeKb = root !== null ? Math.round(root.availB / 1024) : null;
    const du = await shKeep('/usr/bin/du', ['-sh', '/home', '/usr', '/var', '/opt', '/srv', '/boot'], 60000);
    const top5 = du
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort((a, b) => parseSize(b.split('\t')[0] ?? '0') - parseSize(a.split('\t')[0] ?? '0'))
      .slice(0, 5);
    const body = {
      rootFreeKb: freeKb,
      rootTotalKb: root !== null ? Math.round(root.totalB / 1024) : null,
      writePerDayKb: perDayKb,
      daysLeft: freeKb !== null ? daysLeft(freeKb, perDayKb) : null,
      varLogUsePct: logFs !== null && logFs.totalB > 0 ? Math.round(((logFs.totalB - logFs.availB) / logFs.totalB) * 100) : null,
      journal: await journalUsage(),
      df: dfH,
      top5,
      cached: false,
    };
    topCache = { at: nowMs, body };
    return body;
  });

  app.get<{ Querystring: { unit?: string; since?: string; limit?: string } }>(
    '/api/sys/logs',
    async (req, reply) => {
      try {
        const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
        return {
          entries: await queryLogs(req.query.unit, req.query.since ?? '-1h', limit),
        };
      } catch (err) {
        return reply.code(400).send({ error: String(err) });
      }
    },
  );

  app.get('/api/sys/apt', async () => {
    const list = await aptUpgradable();
    return { count: list.length, packages: list.slice(0, 100) };
  });

  app.get('/api/sys/watchdog', async () => {
    return { checks: await runWatchdog(db, sampler.latest()) };
  });
}
