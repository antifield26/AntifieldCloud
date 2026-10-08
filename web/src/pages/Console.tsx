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

export default function Console() {
  const [ov, setOv] = createSignal<Overview | null>(null);
  const [svcs, setSvcs] = createSignal<ServiceState[]>([]);
  const [checks, setChecks] = createSignal<Check[]>([]);
  const [err, setErr] = createSignal('');
  const [range, setRange] = createSignal<'24h' | '7d'>('24h');
  const [pts, setPts] = createSignal<MPoint[]>([]);

  const load = async (): Promise<void> => {
    try {
      const [o, s, w, m] = await Promise.all([
        api<Overview>('/api/sys/overview'),
        api<{ units: ServiceState[] }>('/api/sys/services'),
        api<{ checks: Check[] }>('/api/sys/watchdog'),
        api<{ points: MPoint[] }>(`/api/sys/metrics?range=${range()}`),
      ]);
      setOv(o);
      setSvcs(s.units);
      setChecks(w.checks);
      setPts(m.points);
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
    </div>
  );
}
