// 白名单 systemd 控制 + 操作审计。
// 规则：unit 必须精确命中白名单，action 必须在该 unit 允许列表内，否则 403 并记 allowed=0。
// 执行走 spawn 传参（无 shell）；特权动作经 `sudo -n systemctl`（sudoers 限定到白名单条目）。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

export interface Whitelist {
  allowed: Array<{ unit: string; actions: string[] }>;
}

const PRIVILEGED = new Set(['restart']);

export async function loadWhitelist(path: string): Promise<Whitelist> {
  const raw = await readFile(path, 'utf8');
  const json = JSON.parse(raw) as Whitelist;
  if (!Array.isArray(json.allowed)) throw new Error('bad whitelist');
  return json;
}

export function isAllowed(wl: Whitelist, unit: string, action: string): boolean {
  const entry = wl.allowed.find((e) => e.unit === unit);
  return entry !== undefined && entry.actions.includes(action);
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err !== null ? 1 : 0, out: String(stdout ?? '') });
    });
  });
}

export async function serviceState(unit: string): Promise<string> {
  const { out } = await run('/bin/systemctl', ['show', unit, '-p', 'ActiveState,SubState,LoadState'], 10000);
  return out.trim().replace(/\n/g, ' ');
}

export async function controlService(unit: string, action: 'restart'): Promise<{ code: number; out: string }> {
  if (!PRIVILEGED.has(action)) throw new Error('not privileged action');
  return run('/usr/bin/sudo', ['-n', '/bin/systemctl', action, unit], 30000);
}

export function audit(
  db: DatabaseSync,
  entry: { actor: string; unit: string; action: string; allowed: number; reason: string },
): void {
  db.prepare('INSERT INTO service_audit(ts,actor,unit,action,allowed,reason) VALUES (?,?,?,?,?,?)').run(
    new Date().toISOString(),
    entry.actor,
    entry.unit,
    entry.action,
    entry.allowed,
    entry.reason,
  );
}
