// API 请求审计：只记元数据（ts/actor/method/path/status/ms），永不记 body/query。
// path 脱敏：UUID/长 hex/数字段收敛为 :id；query 直接丢弃。
// 批量落盘（60s）防写放大 + 30 天滚动裁剪。
import type { DatabaseSync } from 'node:sqlite';

export interface AuditRow {
  ts: number;
  actor: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

const SEG_RE = /^[0-9a-fA-F-]{8,}$|^\d+$/;

export function normalizePath(url: string): string {
  const path = url.split('?')[0];
  return path
    .split('/')
    .map((seg) => (SEG_RE.test(seg) ? ':id' : seg))
    .join('/');
}

export class AuditBuffer {
  private buf: AuditRow[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DatabaseSync,
    private flushMs = 60000,
  ) {}

  push(row: AuditRow): void {
    this.buf.push(row);
    if (this.buf.length > 2000) this.buf.splice(0, this.buf.length - 2000);
  }

  flush(): number {
    if (this.buf.length === 0) return 0;
    const stmt = this.db.prepare('INSERT INTO api_audit(ts,actor,method,path,status,ms) VALUES (?,?,?,?,?,?)');
    let n = 0;
    for (const r of this.buf) {
      stmt.run(r.ts, r.actor, r.method, r.path, r.status, r.ms);
      n++;
    }
    this.buf = [];
    this.db.exec("DELETE FROM api_audit WHERE ts < (strftime('%s','now','-30 days')*1000);");
    return n;
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), this.flushMs);
    if (this.timer.unref !== undefined) this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }
}
