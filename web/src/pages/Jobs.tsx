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
    <div class="cols">
      <div class="w-full md:w-80 shrink-0 space-y-2">
        <div class="panel space-y-2">
          <div class="panel-title">新建任务</div>
          <input placeholder="名称" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <input placeholder="cron（空=手动）" value={cron()} onInput={(e) => setCron(e.currentTarget.value)} />
          <select value={kind()} onChange={(e) => setKind(e.currentTarget.value)}>
            <option value="shell">shell</option>
            <option value="http">http</option>
            <option value="opencode">opencode</option>
          </select>
          <textarea class="mono" rows={3} value={payload()} onInput={(e) => setPayload(e.currentTarget.value)} />
          <button class="btn btn-primary btn-sm" onClick={() => void create()}>创建</button>
          {err() && <div class="form-err text-sm">{err()}</div>}
        </div>
        <For each={jobs()}>
          {(j) => (
            <div class="panel tight flex gap-1 items-center text-sm">
              <span class="grow"><b>{j.name}</b> <span class="muted">{j.kind} {j.cron} [{j.last_status ?? '-'}]</span></span>
              <button class="mini-btn ok" onClick={() => void run(j.id)}>跑</button>
              <button class="mini-btn" onClick={() => void show(j.id)}>志</button>
              <button class="mini-btn danger" onClick={() => void del(j.id)}>删</button>
            </div>
          )}
        </For>
      </div>
      <div class="flex-1 panel">
        <div class="panel-title">执行记录 {jid()}</div>
        <For each={runs()}>
          {(r) => (
            <div class="run-row">
              <div><b class={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : ''}>{r.status}</b> <span class="muted">{r.started_at}</span></div>
              <pre class="code-preview">{r.log.slice(0, 2000)}</pre>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
