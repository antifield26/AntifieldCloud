// 系统指标采集：/proc + vcgencmd（回退 thermal_zone）+ diskstats。
// 内存聚合：60s 采样进环形缓冲，按 WB_METRICS_FLUSH_MS（默认 5min）批量落盘。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

export interface Sample {
  ts: number;
  cpu: number | null;
  memUsedKb: number;
  memTotalKb: number;
  tempC: number | null;
  diskWrittenKb: number;
}

export function parseCpuLine(line: string): number[] {
  return line.trim().split(/\s+/).slice(1).map(Number);
}

export function cpuPct(prev: number[], cur: number[]): number {
  const prevIdle = (prev[3] ?? 0) + (prev[4] ?? 0);
  const curIdle = (cur[3] ?? 0) + (cur[4] ?? 0);
  const prevTotal = prev.reduce((a, b) => a + b, 0);
  const curTotal = cur.reduce((a, b) => a + b, 0);
  const dt = curTotal - prevTotal;
  if (dt <= 0) return 0;
  return Math.round(((dt - (curIdle - prevIdle)) / dt) * 1000) / 10;
}

export function parseMeminfo(text: string): { totalKb: number; availKb: number } {
  const get = (k: string): number => {
    const m = text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m !== null ? Number(m[1]) : 0;
  };
  return { totalKb: get('MemTotal'), availKb: get('MemAvailable') };
}

/** mmcblk0 写扇区累计（/proc/diskstats 第 10 列为写扇区数，512B/扇区） */
export function parseDiskWrittenKb(text: string): number {
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[2] === 'mmcblk0') return Math.round(Number(f[9] ?? 0) / 2);
  }
  return 0;
}

export function parseTemp(text: string): number | null {
  const m = text.match(/temp=([\d.]+)/);
  return m !== null ? Number(m[1]) : null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err !== null ? '' : String(stdout));
    });
  });
}

export async function readTempC(): Promise<number | null> {
  const out = await run('/usr/bin/vcgencmd', ['measure_temp'], 4000);
  const t = parseTemp(out);
  if (t !== null) return t;
  try {
    const raw = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    const v = Number(raw.trim());
    return Number.isFinite(v) ? Math.round(v / 100) / 10 : null;
  } catch {
    return null;
  }
}

export class Sampler {
  private prevCpu: number[] | null = null;
  private buf: Sample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DatabaseSync,
    private sampleMs = 60_000,
    private flushMs = Number(process.env.WB_METRICS_FLUSH_MS ?? 300_000),
  ) {}

  latest(): Sample | null {
    return this.buf.length > 0 ? this.buf[this.buf.length - 1] : null;
  }

  async collect(): Promise<Sample> {
    const [stat, mem, disk, temp] = await Promise.all([
      readFile('/proc/stat', 'utf8').catch(() => ''),
      readFile('/proc/meminfo', 'utf8').catch(() => ''),
      readFile('/proc/diskstats', 'utf8').catch(() => ''),
      readTempC(),
    ]);
    const cur = parseCpuLine(stat.split('\n')[0] ?? '');
    let cpu: number | null = null;
    if (this.prevCpu !== null && cur.length >= 5) cpu = cpuPct(this.prevCpu, cur);
    if (cur.length >= 5) this.prevCpu = cur;
    const memInfo = parseMeminfo(mem);
    const s: Sample = {
      ts: Date.now(),
      cpu,
      memUsedKb: memInfo.totalKb - memInfo.availKb,
      memTotalKb: memInfo.totalKb,
      tempC: temp,
      diskWrittenKb: parseDiskWrittenKb(disk),
    };
    this.buf.push(s);
    if (this.buf.length > 600) this.buf.splice(0, this.buf.length - 600);
    return s;
  }

  flush(): number {
    if (this.buf.length === 0) return 0;
    const stmt = this.db.prepare(
      'INSERT INTO metrics_ts(ts,cpu,mem_used,mem_total,temp_c,disk_written_kb) VALUES (?,?,?,?,?,?)',
    );
    let n = 0;
    for (const s of this.buf) {
      stmt.run(s.ts, s.cpu, s.memUsedKb, s.memTotalKb, s.tempC, s.diskWrittenKb);
      n++;
    }
    this.buf = [];
    this.db.exec("DELETE FROM metrics_ts WHERE ts < (strftime('%s','now','-30 days')*1000);");
    return n;
  }

  start(): void {
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.sampleMs);
    this.flushTimer = setInterval(() => this.flush(), this.flushMs);
    if (this.timer.unref !== undefined) {
      this.timer.unref();
      this.flushTimer?.unref?.();
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
  }
}
