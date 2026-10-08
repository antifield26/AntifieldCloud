// 流水线：cron 调度 + 三种任务（shell/http/opencode），执行记 job_runs。
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { IOpenCodeAdapter } from '../opencode/adapter.js';

/** cron 五段匹配：支持 *、*\/n、a,b、a-b、a-b/n */
export function matchField(expr: string, value: number, min: number, max: number): boolean {
  const check = (e: string): boolean => {
    let step = 1;
    let range = e;
    const slash = e.indexOf('/');
    if (slash >= 0) {
      range = e.slice(0, slash);
      step = Number(e.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return false;
    }
    const vals = new Set<number>();
    if (range === '*') {
      for (let i = min; i <= max; i++) vals.add(i);
    } else {
      for (const part of range.split(',')) {
        const dash = part.indexOf('-');
        if (dash >= 0) {
          const a = Number(part.slice(0, dash));
          const b = Number(part.slice(dash + 1));
          if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
          for (let i = Math.max(a, min); i <= Math.min(b, max); i++) vals.add(i);
        } else {
          const n = Number(part);
          if (!Number.isInteger(n)) return false;
          vals.add(n);
        }
      }
    }
    const sorted = [...vals].sort((a, b) => a - b);
    return inStep(sorted, value, step);
  };
  return check(expr);
}

function inStep(sorted: number[], value: number, step: number): boolean {
  if (step === 1) return sorted.includes(value);
  const base = sorted[0];
  return sorted.includes(value) && (value - base) % step === 0;
}

export function matchCron(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [mi, hh, dom, mon, dow] = f;
  return (
    matchField(mi, d.getMinutes(), 0, 59) &&
    matchField(hh, d.getHours(), 0, 23) &&
    matchField(dom, d.getDate(), 1, 31) &&
    matchField(mon, d.getMonth() + 1, 1, 12) &&
    matchField(dow, d.getDay(), 0, 6)
  );
}

export interface JobRow {
  id: string;
  name: string;
  cron: string;
  kind: string;
  payload: string;
  enabled: number;
}

export function validateJob(kind: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (kind === 'shell') {
    if (!Array.isArray(p.argv) || p.argv.length === 0 || !p.argv.every((a) => typeof a === 'string')) {
      throw Object.assign(new Error('shell needs argv[]'), { statusCode: 400 });
    }
  } else if (kind === 'http') {
    if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) {
      throw Object.assign(new Error('http needs url'), { statusCode: 400 });
    }
  } else if (kind === 'opencode') {
    if (typeof p.text !== 'string' || p.text.trim() === '') {
      throw Object.assign(new Error('opencode needs text'), { statusCode: 400 });
    }
  } else {
    throw Object.assign(new Error('unknown kind'), { statusCode: 400 });
  }
  return JSON.stringify(payload ?? {});
}

const now = (): string => new Date().toISOString();
const LOG_CAP = 20 * 1024;

function finish(db: DatabaseSync, runId: string, jobId: string, status: string, log: string): void {
  db.prepare('UPDATE job_runs SET finished_at=?,status=?,log=? WHERE id=?').run(now(), status, log.slice(-LOG_CAP), runId);
  db.prepare('UPDATE jobs SET last_run=?,last_status=? WHERE id=?').run(now(), status, jobId);
}

/** 异步执行一次任务，落 job_runs 行。调用方不等待。 */
export function triggerRun(
  db: DatabaseSync,
  adapter: () => IOpenCodeAdapter,
  job: JobRow,
): string {
  const runId = randomUUID();
  db.prepare('INSERT INTO job_runs(id,job_id,started_at,finished_at,status,log) VALUES (?,?,?,?,?,?)').run(
    runId, job.id, now(), null, 'running', '',
  );
  void (async (): Promise<void> => {
    const p = JSON.parse(job.payload) as Record<string, unknown>;
    try {
      if (job.kind === 'shell') {
        const argv = (p.argv as string[]).slice(0, 20);
        const out = await new Promise<string>((resolve, reject) => {
          execFile(argv[0], argv.slice(1), { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            const text = `exit=${(err as { code?: unknown } | null)?.code ?? 0}\n${String(stdout ?? '')}${String(stderr ?? '')}`;
            if (err !== null && (err as { killed?: boolean }).killed !== false && (err as { code?: unknown }).code !== 0 && String(stdout ?? '') === '' && String(stderr ?? '') === '') {
              reject(new Error(text));
            } else {
              resolve(text);
            }
          });
        });
        finish(db, runId, job.id, 'done', out);
      } else if (job.kind === 'http') {
        const res = await fetch(String(p.url), { signal: AbortSignal.timeout(60000) });
        const body = (await res.text()).slice(0, 4000);
        finish(db, runId, job.id, res.ok ? 'done' : 'failed', `HTTP ${res.status}\n${body}`);
      } else if (job.kind === 'opencode') {
        const session = await adapter().createSession(`job:${job.name}`);
        const lines: string[] = [`session=${session.id}`];
        await adapter().sendMessage(
          session.id,
          {
            parts: [{ type: 'text', text: String(p.text) }],
            model: typeof p.model === 'string' ? p.model : undefined,
            agent: typeof p.agent === 'string' ? p.agent : undefined,
          },
          (ev) => {
            const e = ev as { type?: string };
            lines.push(String(e.type ?? 'event'));
          },
        );
        finish(db, runId, job.id, 'done', lines.join('\n'));
      } else {
        finish(db, runId, job.id, 'failed', 'unknown kind');
      }
    } catch (err) {
      finish(db, runId, job.id, 'failed', String(err).slice(0, 4000));
    }
  })();
  return runId;
}

/** 调度循环：每 20s 检查，到分钟即触发（同分钟不重复）。 */
export function startScheduler(db: DatabaseSync, adapter: () => IOpenCodeAdapter): NodeJS.Timeout {
  const tick = (): void => {
    try {
      const nowD = new Date();
      const minuteKey = `${nowD.getFullYear()}-${nowD.getMonth()}-${nowD.getDate()} ${nowD.getHours()}:${nowD.getMinutes()}`;
      const rows = db.prepare("SELECT * FROM jobs WHERE enabled=1 AND cron<>''").all() as Array<Record<string, unknown>>;
      const jobs: JobRow[] = rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        cron: String(r.cron),
        kind: String(r.kind),
        payload: String(r.payload),
        enabled: Number(r.enabled),
      }));
      for (const j of jobs) {
        if (!matchCron(j.cron, nowD)) continue;
        const last = db.prepare('SELECT started_at FROM job_runs WHERE job_id=? ORDER BY started_at DESC LIMIT 1').get(j.id) as
          | { started_at: string }
          | undefined;
        if (last !== undefined) {
          const ld = new Date(last.started_at);
          const lk = `${ld.getFullYear()}-${ld.getMonth()}-${ld.getDate()} ${ld.getHours()}:${ld.getMinutes()}`;
          if (lk === minuteKey) continue;
        }
        triggerRun(db, adapter, j);
      }
    } catch {
      // 调度永不抛
    }
  };
  const t = setInterval(tick, 20000);
  if (t.unref !== undefined) t.unref();
  return t;
}
