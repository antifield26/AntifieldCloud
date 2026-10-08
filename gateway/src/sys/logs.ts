// journald 查询 + apt 提醒。全部走 spawn 传参（无 shell），输出脱敏。
import { execFile } from 'node:child_process';

const UNIT_RE = /^[A-Za-z0-9@:._-]{1,128}$/;

export function assertUnit(unit: string): void {
  if (!UNIT_RE.test(unit)) throw new Error('invalid unit');
}

/** 脱敏：password|token|key|secret 等赋值右侧截断 */
export function redact(text: string): string {
  return text.replace(
    /((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)([^\s"']+)/gi,
    '$1<redacted>',
  );
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err !== null ? 1 : 0, out: String(stdout ?? '') });
    });
  });
}

export interface LogEntry {
  ts: string;
  unit?: string;
  pri?: string;
  msg: string;
}

export async function queryLogs(unit: string | undefined, since: string, limit: number): Promise<LogEntry[]> {
  const args = ['-o', 'json', '--no-pager', '--since', since, '-n', String(Math.min(limit, 500))];
  if (unit !== undefined && unit !== '') {
    assertUnit(unit);
    args.push('-u', unit);
  }
  const { out } = await run('/usr/bin/journalctl', args, 15000);
  const entries: LogEntry[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      entries.push({
        ts: String(j.__REALTIME_TIMESTAMP ?? ''),
        unit: j._SYSTEMD_UNIT !== undefined ? String(j._SYSTEMD_UNIT) : undefined,
        pri: j.PRIORITY !== undefined ? String(j.PRIORITY) : undefined,
        msg: redact(String(j.MESSAGE ?? '')),
      });
    } catch {
      // 跳过非 JSON 行
    }
  }
  return entries;
}

export async function journalUsage(): Promise<string> {
  const { out } = await run('/usr/bin/journalctl', ['--disk-usage'], 10000);
  return out.trim();
}

let aptCache: { at: number; text: string } | null = null;

export async function aptUpgradable(): Promise<string[]> {
  if (aptCache !== null && Date.now() - aptCache.at < 6 * 3600 * 1000) return aptCache.text.split('\n').filter(Boolean);
  const { out } = await run('/usr/bin/apt', ['list', '--upgradable'], 60000);
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('/'));
  aptCache = { at: Date.now(), text: lines.join('\n') };
  return lines;
}
