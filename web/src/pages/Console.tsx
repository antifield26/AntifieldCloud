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
      ? 'bg-red-600 text-white'
      : p === '4'
        ? 'bg-orange-400 text-white'
        : p === '5' || p === '6'
          ? 'bg-gray-500 text-white'
          : 'bg-gray-200';

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
    <div class="p-4 space-y-4">
      <Show when={err()}>
        <div class="bg-red-100 text-red-800 p-2 rounded">{err()}</div>
      </Show>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="bg-white shadow rounded p-3"><div class="text-gray-500 text-sm">温度</div><div class="text-2xl">{ov()?.tempC ?? '?'}°C</div></div>
        <div class="bg-white shadow rounded p-3"><div class="text-gray-500 text-sm">CPU</div><div class="text-2xl">{ov()?.cpuPct ?? '?'}%</div></div>
        <div class="bg-white shadow rounded p-3"><div class="text-gray-500 text-sm">内存</div><div class="text-2xl">{ov() ? `${fmtGb(ov()!.memUsedKb)} / ${fmtGb(ov()!.memTotalKb)}` : '?'}</div></div>
        <div class="bg-white shadow rounded p-3"><div class="text-gray-500 text-sm">SD 已写</div><div class="text-2xl">{ov() ? fmtMb(ov()!.diskWrittenKb) : '?'}</div></div>
      </div>
      <div class="bg-white shadow rounded p-3">
        <div class="flex gap-2 items-center mb-2">
          <h2 class="font-bold">曲线</h2>
          {(['24h', '7d'] as const).map((r) => (
            <button
              class={`px-2 py-1 rounded text-sm ${range() === r ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
              onClick={() => {
                setRange(r);
                void load();
              }}
            >
              {r}
            </button>
          ))}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><div class="text-sm text-gray-500">温度 °C</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.tempC }))} color="#e11d48" unit="°C" /></div>
          <div><div class="text-sm text-gray-500">CPU %</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.cpu }))} color="#2563eb" unit="%" /></div>
          <div><div class="text-sm text-gray-500">内存已用 GB</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.memUsedKb / 1048576 }))} color="#16a34a" unit="G" /></div>
          <div><div class="text-sm text-gray-500">SD 累计写 GB</div><LineChart data={pts().map((p) => ({ ts: p.ts, v: p.diskWrittenKb / 1048576 }))} color="#9333ea" unit="G" /></div>
        </div>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">磁盘健康（SD 无寿命读数，代理指标）</h2>
        <Show when={disk()} fallback={<div class="text-gray-400 text-sm">加载中…</div>}>
          <ul class="text-sm space-y-1">
            <li>根分区剩余：{disk()!.rootFreeKb === null || disk()!.rootTotalKb === null ? '?' : `${fmtGb(disk()!.rootFreeKb as number)} / ${fmtGb(disk()!.rootTotalKb as number)}`}</li>
            <li>近 24h 写入速率：{disk()!.writePerDayKb === null ? '数据不足' : `${fmtMb(disk()!.writePerDayKb as number)}/天`}</li>
            <li>粗估可用天数：{disk()!.daysLeft ?? '—'}</li>
            <li>/var/log 水位：{disk()!.varLogUsePct ?? '?'}%</li>
            <li>
              大目录 TOP5{disk()!.cached ? '（缓存）' : ''}：
              <ul class="ml-4 list-disc">
                <For each={disk()!.top5}>{(t) => <li class="font-mono text-xs">{t}</li>}</For>
              </ul>
            </li>
          </ul>
        </Show>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">告警</h2>
        <ul>
          <For each={checks()}>
            {(c) => (
              <li class={c.status === 'alert' ? 'text-red-700' : 'text-green-700'}>
                {c.name}: {c.status} — {c.detail}
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3">
        <div class="flex gap-2 items-center mb-2 flex-wrap">
          <h2 class="font-bold">日志</h2>
          <select class="border rounded px-2 py-1 text-sm" value={logUnit()} onChange={(e) => setLogUnit(e.currentTarget.value)}>
            <For each={['opencode.service', 'workbench-gateway.service', 'cloudflared.service', 'ssh.service', 'nginx.service']}>
              {(u) => <option value={u}>{u}</option>}
            </For>
          </select>
          <select class="border rounded px-2 py-1 text-sm" value={logSince()} onChange={(e) => setLogSince(e.currentTarget.value)}>
            <option value="-10min">近10分钟</option>
            <option value="-1h">近1小时</option>
            <option value="-24h">近24小时</option>
          </select>
          <select class="border rounded px-2 py-1 text-sm" value={logLimit()} onChange={(e) => setLogLimit(Number(e.currentTarget.value))}>
            {[50, 100, 300, 500].map((n) => (
              <option value={n}>{n} 条</option>
            ))}
          </select>
          <button class="bg-blue-500 text-white px-3 py-1 rounded text-sm" onClick={() => void loadLogs()}>查询</button>
          <button class="bg-gray-600 text-white px-3 py-1 rounded text-sm" onClick={() => void copyAll()}>
            {copied() ? '已复制' : '一键复制'}
          </button>
        </div>
        <ul class="space-y-1 text-xs font-mono max-h-96 overflow-y-auto">
          <For each={logEntries()}>
            {(e) => (
              <li class="flex gap-2 items-start border-b py-0.5">
                <span class={`px-1 rounded shrink-0 ${priColor(e.pri)}`}>p{e.pri ?? '?'}</span>
                <span class="text-gray-400 shrink-0">{e.ts.slice(0, 19)}</span>
                <span innerHTML={hlRedacted(e.msg)} class="break-all" />
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">服务（白名单）</h2>
        <ul class="space-y-1">
          <For each={svcs()}>
            {(s) => (
              <li class="flex items-center gap-2">
                <span class="font-mono text-sm flex-1">{s.unit} <span class="text-gray-500">{s.state.split(' ').find((x) => x.startsWith('ActiveState='))}</span></span>
                {s.actions.includes('restart') && (
                  <button class="bg-blue-500 text-white px-2 py-1 rounded text-sm" onClick={() => void restart(s.unit)}>
                    重启
                  </button>
                )}
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3 text-sm text-gray-600">
        <div>journal：{ov()?.journal}</div>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">可选服务（只读，不在启停白名单）</h2>
        <ul class="text-sm space-y-1">
          <For each={ov()?.extra ?? []}>
            {(s) => (
              <li class="font-mono">
                {s.unit}: <span class={s.active === 'active' ? 'text-green-700' : 'text-red-700'}>{s.active}</span>
                {s.rssKb !== null && <span class="text-gray-500"> RSS {fmtMb(s.rssKb)}</span>}
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}
