import { createSignal, onCleanup, For, Show } from 'solid-js';
import { api, type Overview, type ServiceState, type Check } from '../api';
import { LineChart } from '../chart';

const fmtMb = (kb: number): string => `${Math.round(kb / 1024)}M`;
const fmtGb = (kb: number): string => `${(kb / 1024 / 1024).toFixed(1)}G`;

interface MPoint {
  ts: number;
  cpu: number | null;
  memUsedKb: number;
  memTotalKb: number;
  tempC: number | null;
  diskWrittenKb: number;
}

interface DiskHealth {
  rootFreeKb: number | null;
  rootTotalKb: number | null;
  writePerDayKb: number | null;
  daysLeft: number | null;
  varLogUsePct: number | null;
  top5: string[];
  cached: boolean;
}

export default function Console() {
  const [ov, setOv] = createSignal<Overview | null>(null);
  const [svcs, setSvcs] = createSignal<ServiceState[]>([]);
  const [checks, setChecks] = createSignal<Check[]>([]);
  const [err, setErr] = createSignal('');
  const [range, setRange] = createSignal<'24h' | '7d'>('24h');
  const [pts, setPts] = createSignal<MPoint[]>([]);
  const [disk, setDisk] = createSignal<DiskHealth | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [o, s, w, m, dh] = await Promise.all([
        api<Overview>('/api/sys/overview'),
        api<{ units: ServiceState[] }>('/api/sys/services'),
        api<{ checks: Check[] }>('/api/sys/watchdog'),
        api<{ points: MPoint[] }>(`/api/sys/metrics?range=${range()}`),
        api<DiskHealth>('/api/sys/disk-health'),
      ]);
      setOv(o);
      setSvcs(s.units);
      setChecks(w.checks);
      setPts(m.points);
      setDisk(dh);
      setErr('');
    } catch (e) {
      setErr(String(e));
    }
  };

  void load();
  const t = setInterval(() => void load(), 5000);
  onCleanup(() => clearInterval(t));

  const restart = async (unit: string): Promise<void> => {
    if (!confirm(`重启 ${unit}？`)) return;
    try {
      await api(`/api/sys/services/${unit}/restart`, { method: 'POST' });
      await load();
    } catch (e) {
      setErr(String(e));
    }
  };

  const [logUnit, setLogUnit] = createSignal('opencode.service');
  const [logSince, setLogSince] = createSignal('-1h');
  const [logLimit, setLogLimit] = createSignal(100);
  const [logEntries, setLogEntries] = createSignal<Array<{ ts: string; unit?: string; pri?: string; msg: string }>>([]);
  const [copied, setCopied] = createSignal(false);

  const loadLogs = async (): Promise<void> => {
    try {
      const j = await api<{ entries: Array<{ ts: string; unit?: string; pri?: string; msg: string }> }>(
        `/api/sys/logs?unit=${encodeURIComponent(logUnit())}&since=${encodeURIComponent(logSince())}&limit=${logLimit()}`,
      );
      setLogEntries(j.entries);
      setErr('');
    } catch (e) {
      setErr(String(e));
    }
  };

  const priColor = (p?: string): string =>
    p === '0' || p === '1' || p === '2' || p === '3'
      ? 'pri crit'
      : p === '4'
        ? 'pri warn'
        : 'pri info';

  const hlRedacted = (msg: string): string =>
    msg
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/&lt;redacted&gt;/g, '<mark>&lt;redacted&gt;</mark>');

  const copyAll = async (): Promise<void> => {
    const text = logEntries()
      .map((e) => `${e.ts} [${e.unit ?? '?'}] p${e.pri ?? '?'} ${e.msg}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr('复制失败（浏览器未授权剪贴板）');
    }
  };

  return (
    <div class="page">
      <Show when={err()}>
        <div class="form-err">{err()}</div>
      </Show>
      <div class="stat-grid">
        <article class="stat-card"><div class="stat-label">温度</div><div class="stat-value">{ov()?.tempC ?? '?'}<span class="unit">°C</span></div></article>
        <article class="stat-card"><div class="stat-label">CPU</div><div class="stat-value">{ov()?.cpuPct ?? '?'}<span class="unit">%</span></div></article>
        <article class="stat-card"><div class="stat-label">内存</div><div class="stat-value">{ov() ? fmtGb(ov()!.memUsedKb) : '?'}<span class="unit">/ {ov() ? fmtGb(ov()!.memTotalKb) : '?'}</span></div></article>
        <article class="stat-card"><div class="stat-label">SD 已写</div><div class="stat-value">{ov() ? fmtMb(ov()!.diskWrittenKb) : '?'}<span class="unit">B</span></div></article>
      </div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">曲线</span>
          <div class="seg">
            {(['24h', '7d'] as const).map((r) => (
              <button
                class={`seg-btn ${range() === r ? 'active' : ''}`}
                onClick={() => {
                  setRange(r);
                  void load();
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <div class="chart-grid">
          <div><div class="chart-label">温度 °C</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.tempC }))} color="#e11d48" unit="°C" /></div>
          <div><div class="chart-label">CPU %</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.cpu }))} color="#2563eb" unit="%" /></div>
          <div><div class="chart-label">内存已用 GB</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.memUsedKb / 1048576 }))} color="#16a34a" unit="G" /></div>
          <div><div class="chart-label">SD 累计写 GB</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.diskWrittenKb / 1048576 }))} color="#9333ea" unit="G" /></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">磁盘健康（SD 无寿命读数，代理指标）</div>
        <Show when={disk()} fallback={<div class="muted">加载中…</div>}>
          <ul class="kv">
            <li>根分区剩余：{disk()!.rootFreeKb === null || disk()!.rootTotalKb === null ? '?' : `${fmtGb(disk()!.rootFreeKb as number)} / ${fmtGb(disk()!.rootTotalKb as number)}`}</li>
            <li>近 24h 写入速率：{disk()!.writePerDayKb === null ? '数据不足' : `${fmtMb(disk()!.writePerDayKb as number)}/天`}</li>
            <li>粗估可用天数：{disk()!.daysLeft ?? '—'}</li>
            <li>/var/log 水位：{disk()!.varLogUsePct ?? '?'}%</li>
            <li>
              大目录 TOP5{disk()!.cached ? '（缓存）' : ''}：
              <ul class="mono-list">
                <For each={disk()!.top5}>{(t) => <li>{t}</li>}</For>
              </ul>
            </li>
          </ul>
        </Show>
      </div>
      <div class="panel">
        <div class="panel-title">告警</div>
        <ul class="kv">
          <For each={checks()}>
            {(c) => (
              <li class={c.status === 'alert' ? 'bad' : 'ok'}>
                {c.name}: {c.status} — {c.detail}
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="panel">
        <div class="toolbar">
          <span class="panel-title">日志</span>
          <select value={logUnit()} onChange={(e) => setLogUnit(e.currentTarget.value)}>
            <For each={['opencode.service', 'workbench-gateway.service', 'cloudflared.service', 'ssh.service', 'nginx.service']}>
              {(u) => <option value={u}>{u}</option>}
            </For>
          </select>
          <select value={logSince()} onChange={(e) => setLogSince(e.currentTarget.value)}>
            <option value="-10min">近10分钟</option>
            <option value="-1h">近1小时</option>
            <option value="-24h">近24小时</option>
          </select>
          <select value={logLimit()} onChange={(e) => setLogLimit(Number(e.currentTarget.value))}>
            {[50, 100, 300, 500].map((n) => (
              <option value={n}>{n} 条</option>
            ))}
          </select>
          <button class="btn btn-primary btn-sm" onClick={() => void loadLogs()}>查询</button>
          <button class="btn btn-sm" onClick={() => void copyAll()}>
            {copied() ? '已复制' : '一键复制'}
          </button>
        </div>
        <ul class="log-list scroll">
          <For each={logEntries()}>
            {(e) => (
              <li>
                <span class={`pri ${priColor(e.pri)}`}>p{e.pri ?? '?'}</span>
                <span class="ts">{e.ts.slice(0, 19)}</span>
                <span innerHTML={hlRedacted(e.msg)} class="msg" />
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-title">服务（白名单）</div>
        <ul class="svc-list">
          <For each={svcs()}>
            {(s) => (
              <li>
                <span class="mono grow">{s.unit} <span class="muted">{s.state.split(' ').find((x) => x.startsWith('ActiveState='))}</span></span>
                {s.actions.includes('restart') && (
                  <button class="btn btn-primary btn-sm" onClick={() => void restart(s.unit)}>
                    重启
                  </button>
                )}
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="panel muted">journal：{ov()?.journal}</div>
      <div class="panel">
        <div class="panel-title">可选服务（只读，不在启停白名单）</div>
        <ul class="kv mono">
          <For each={ov()?.extra ?? []}>
            {(s) => (
              <li>
                {s.unit}: <span class={s.active === 'active' ? 'ok' : 'bad'}>{s.active}</span>
                {s.rssKb !== null && <span class="muted"> RSS {fmtMb(s.rssKb)}</span>}
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}
