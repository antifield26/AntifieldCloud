// 看门狗：tunnel/温度/内存/备份/opencode 五项检查，异常记 job_runs（job_id=watchdog）。
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Sample } from './metrics.js';

export interface Check {
  name: string;
  status: 'ok' | 'alert' | 'unknown';
  detail: string;
}

export interface WatchOpts {
  tempAlertC: number;
  memMinMb: number;
  backupMaxH: number;
}

export const optsFromEnv = (): WatchOpts => ({
  tempAlertC: Number(process.env.WB_TEMP_ALERT_C ?? 75),
  memMinMb: Number(process.env.WB_MEM_MIN_MB ?? 1024),
  backupMaxH: Number(process.env.WB_BACKUP_MAX_H ?? 26),
});

function sh(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err !== null ? '' : String(stdout).trim());
    });
  });
}

export async function isActive(unit: string): Promise<boolean> {
  return (await sh('/bin/systemctl', ['is-active', unit], 8000)) === 'active';
}

export async function serveHealthy(): Promise<boolean> {
  const user = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
  const pw = process.env.OPENCODE_SERVER_PASSWORD ?? '';
  const auth = `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
  try {
    const res = await fetch('http://127.0.0.1:4096/api/info', {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 纯检查（可单测）：sample 为空则温度/内存记 unknown。 */
export function evaluate(
  sample: Sample | null,
  lastBackup: { ts: string; status: string } | undefined,
  nowMs: number,
  opts: WatchOpts,
  units: { cloudflared: boolean; opencode: boolean; serve: boolean },
): Check[] {
  const out: Check[] = [];
  out.push(
    units.cloudflared
      ? { name: 'tunnel', status: 'ok', detail: 'cloudflared active' }
      : { name: 'tunnel', status: 'alert', detail: 'cloudflared not active' },
  );
  if (sample?.tempC === null || sample?.tempC === undefined) {
    out.push({ name: 'temp', status: 'unknown', detail: 'no sample' });
  } else {
    out.push(
      sample.tempC >= opts.tempAlertC
        ? { name: 'temp', status: 'alert', detail: `${sample.tempC}C >= ${opts.tempAlertC}C` }
        : { name: 'temp', status: 'ok', detail: `${sample.tempC}C` },
    );
  }
  if (sample === null) {
    out.push({ name: 'mem', status: 'unknown', detail: 'no sample' });
  } else {
    const availMb = Math.round((sample.memTotalKb - sample.memUsedKb) / 1024);
    out.push(
      availMb < opts.memMinMb
        ? { name: 'mem', status: 'alert', detail: `avail ${availMb}MB < ${opts.memMinMb}MB` }
        : { name: 'mem', status: 'ok', detail: `avail ${availMb}MB` },
    );
  }
  if (lastBackup === undefined) {
    out.push({ name: 'backup', status: 'alert', detail: 'no backup row' });
  } else {
    const ageH = (nowMs - Date.parse(lastBackup.ts)) / 3600000;
    out.push(
      lastBackup.status !== 'ok' || ageH > opts.backupMaxH
        ? { name: 'backup', status: 'alert', detail: `${lastBackup.status} ${ageH.toFixed(1)}h ago` }
        : { name: 'backup', status: 'ok', detail: `${ageH.toFixed(1)}h ago` },
    );
  }
  out.push(
    units.opencode && units.serve
      ? { name: 'opencode', status: 'ok', detail: 'service active + api ok' }
      : { name: 'opencode', status: 'alert', detail: `service=${units.opencode} api=${units.serve}` },
  );
  return out;
}

export function ensureWatchdogJob(db: DatabaseSync): void {
  db.prepare(
    "INSERT OR IGNORE INTO jobs(id,name,cron,kind,payload,enabled,last_run,last_status) VALUES ('watchdog','watchdog','','monitor','{}',0,null,null)",
  ).run();
}

export function recordAlerts(db: DatabaseSync, checks: Check[]): number {
  ensureWatchdogJob(db);
  const alerts = checks.filter((c) => c.status === 'alert');
  if (alerts.length === 0) return 0;
  const log = alerts.map((a) => `${a.name}: ${a.detail}`).join('\n');
  const t = new Date().toISOString();
  db.prepare('INSERT INTO job_runs(id,job_id,started_at,finished_at,status,log) VALUES (?,?,?,?,?,?)').run(
    randomUUID(), 'watchdog', t, t, 'alert', log,
  );
  db.prepare('UPDATE jobs SET last_run=?,last_status=? WHERE id=?').run(t, 'alert', 'watchdog');
  return alerts.length;
}

export async function runWatchdog(db: DatabaseSync, sample: Sample | null): Promise<Check[]> {
  const opts = optsFromEnv();
  const lastBackup = db
    .prepare('SELECT ts,status FROM backups ORDER BY ts DESC LIMIT 1')
    .get() as { ts: string; status: string } | undefined;
  const [cf, oc, sv] = await Promise.all([isActive('cloudflared.service'), isActive('opencode.service'), serveHealthy()]);
  const checks = evaluate(sample, lastBackup, Date.now(), opts, { cloudflared: cf, opencode: oc, serve: sv });
  recordAlerts(db, checks);
  return checks;
}

export function startWatchdog(db: DatabaseSync, latest: () => Sample | null): NodeJS.Timeout {
  const t = setInterval(() => void runWatchdog(db, latest()), 60000);
  if (t.unref !== undefined) t.unref();
  return t;
}
