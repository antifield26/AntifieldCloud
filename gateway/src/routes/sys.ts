import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { Sampler, parseDiskWrittenKb } from '../sys/metrics.js';
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
    const rangeMs = req.query.range === '24h' ? 24 * 3600 * 1000 : 3600 * 1000;
    const rows = db
      .prepare('SELECT ts,cpu,mem_used AS memUsedKb,mem_total AS memTotalKb,temp_c AS tempC,disk_written_kb AS diskWrittenKb FROM metrics_ts WHERE ts > ? ORDER BY ts')
      .all(Date.now() - rangeMs) as Array<Record<string, unknown>>;
    return { range: req.query.range ?? '1h', points: rows };
  });

  app.get('/api/sys/disk', async () => {
    const [df, diskstats] = await Promise.all([
      sh('/usr/bin/df', ['-hT', '/', '/tmp', '/var/log'], 10000),
      readFile('/proc/diskstats', 'utf8').catch(() => ''),
    ]);
    return { df, diskWrittenKb: parseDiskWrittenKb(diskstats), journal: await journalUsage() };
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
