import { createSignal, For } from 'solid-js';
import { api } from '../api';

interface Job {
  id: string;
  name: string;
  cron: string;
  kind: string;
  enabled: number;
  last_status: string | null;
}
interface Run {
  id: string;
  status: string;
  log: string;
  started_at: string;
}

export default function Jobs() {
  const [jobs, setJobs] = createSignal<Job[]>([]);
  const [runs, setRuns] = createSignal<Run[]>([]);
  const [jid, setJid] = createSignal('');
  const [name, setName] = createSignal('');
  const [cron, setCron] = createSignal('');
  const [kind, setKind] = createSignal('shell');
  const [payload, setPayload] = createSignal('{"argv":["/bin/echo","hi"]}');
  const [err, setErr] = createSignal('');

  const load = async (): Promise<void> => {
    setJobs(await api<Job[]>('/api/jobs'));
  };
  void load();

  const create = async (): Promise<void> => {
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ name: name(), cron: cron(), kind: kind(), payload: JSON.parse(payload()) }),
      });
      setName('');
      await load();
    } catch (e) {
      setErr(String(e));
    }
  };
  const run = async (id: string): Promise<void> => {
    if (!confirm(`执行任务 ${id}？shell 任务将在网关主机上运行`)) return;
    setJid(id);
    await api(`/api/jobs/${id}/run`, { method: 'POST' });
    await show(id);
  };
  const show = async (id: string): Promise<void> => {
    setJid(id);
    setRuns(await api<Run[]>(`/api/jobs/${id}/runs`));
  };
  const del = async (id: string): Promise<void> => {
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div class="p-4 flex gap-4">
      <div class="w-80 shrink-0 space-y-2">
        <div class="bg-white shadow rounded p-3 space-y-2">
          <h2 class="font-bold">新建任务</h2>
          <input class="w-full border rounded px-2 py-1 text-sm" placeholder="名称" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <input class="w-full border rounded px-2 py-1 text-sm" placeholder="cron（空=手动）" value={cron()} onInput={(e) => setCron(e.currentTarget.value)} />
          <select class="w-full border rounded px-2 py-1 text-sm" value={kind()} onChange={(e) => setKind(e.currentTarget.value)}>
            <option value="shell">shell</option>
            <option value="http">http</option>
            <option value="opencode">opencode</option>
          </select>
          <textarea class="w-full border rounded px-2 py-1 text-sm font-mono" rows={3} value={payload()} onInput={(e) => setPayload(e.currentTarget.value)} />
          <button class="bg-blue-500 text-white px-3 py-1 rounded" onClick={() => void create()}>创建</button>
          {err() && <div class="text-red-700 text-sm">{err()}</div>}
        </div>
        <For each={jobs()}>
          {(j) => (
            <div class="bg-white shadow rounded p-2 text-sm flex gap-1 items-center">
              <span class="flex-1"><b>{j.name}</b> <span class="text-gray-500">{j.kind} {j.cron} [{j.last_status ?? '-'}]</span></span>
              <button class="text-green-600" onClick={() => void run(j.id)}>跑</button>
              <button class="text-blue-600" onClick={() => void show(j.id)}>志</button>
              <button class="text-red-500" onClick={() => void del(j.id)}>删</button>
            </div>
          )}
        </For>
      </div>
      <div class="flex-1 bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">执行记录 {jid()}</h2>
        <For each={runs()}>
          {(r) => (
            <div class="border-b py-2 text-sm">
              <div><b>{r.status}</b> <span class="text-gray-500">{r.started_at}</span></div>
              <pre class="whitespace-pre-wrap text-xs bg-gray-50 p-1 rounded">{r.log.slice(0, 2000)}</pre>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
