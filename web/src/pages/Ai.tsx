import { createSignal, For, onCleanup } from 'solid-js';
import { api } from '../api';

interface Session {
  id: string;
  title: string;
}

interface Ev {
  type?: string;
  data?: Record<string, unknown>;
}

const TERMINAL = new Set([
  'session.execution.finished',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.idle',
  'session.error',
]);

export default function Ai() {
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [sid, setSid] = createSignal('');
  const [log, setLog] = createSignal<string[]>([]);
  const [input, setInput] = createSignal('');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [started, setStarted] = createSignal(0);
  const [elapsed, setElapsed] = createSignal('');
  let es: EventSource | null = null;

  const loadSessions = async (): Promise<void> => {
    setSessions(await api<Session[]>('/api/ai/sessions'));
  };

  const closeStream = (): void => {
    es?.close();
    es = null;
  };

  const pick = (id: string): void => {
    closeStream();
    setBusy(false);
    setSid(id);
    setLog([]);
    if (!id) return;
    es = new EventSource(`/api/ai/sessions/${id}/events`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as Ev;
        const t = ev.type ?? '?';
        if (t === 'server.connected') return;
        setLog((l) => [...l.slice(-300), t]);
        if (TERMINAL.has(t)) {
          setBusy(false);
          closeStream();
        }
      } catch {
        // 忽略坏帧
      }
    };
    es.onerror = () => {
      // 断线 3s 后重连（会话上下文在服务端保持）
      closeStream();
      setTimeout(() => {
        if (sid() === id) pick(id);
      }, 3000);
    };
  };

  const create = async (): Promise<void> => {
    const s = await api<Session>('/api/ai/sessions', { method: 'POST', body: JSON.stringify({ title: 'web' }) });
    await loadSessions();
    pick(s.id);
  };

  const remove = async (id: string): Promise<void> => {
    if (!confirm(`删除会话 ${id.slice(0, 12)}？`)) return;
    await api(`/api/ai/sessions/${id}`, { method: 'DELETE' });
    if (sid() === id) pick('');
    await loadSessions();
  };

  const send = async (): Promise<void> => {
    if (!sid() || !input().trim() || busy()) return;
    setBusy(true);
    setStarted(Date.now());
    try {
      await api(`/api/ai/sessions/${sid()}/prompt`, { method: 'POST', body: JSON.stringify({ text: input() }) });
      setInput('');
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const abort = async (): Promise<void> => {
    if (!sid()) return;
    await api(`/api/ai/sessions/${sid()}/abort`, { method: 'POST' });
    setLog((l) => [...l, 'client: aborted']);
    setBusy(false);
  };

  void loadSessions();
  const t = setInterval(() => {
    if (busy()) setElapsed(`${Math.round((Date.now() - started()) / 1000)}s`);
  }, 500);
  onCleanup(() => {
    clearInterval(t);
    closeStream();
  });

  return (
    <div class="p-4 flex gap-4">
      <div class="w-64 shrink-0">
        <button class="bg-blue-500 text-white px-3 py-1 rounded mb-2" onClick={() => void create()}>新建会话</button>
        <ul class="space-y-1">
          <For each={sessions()}>
            {(s) => (
              <li class="flex gap-1 items-center">
                <button
                  class={`flex-1 text-left px-2 py-1 rounded text-sm ${sid() === s.id ? 'bg-blue-100' : 'hover:bg-gray-200'}`}
                  onClick={() => pick(s.id)}
                >
                  {s.title || s.id.slice(0, 12)}
                </button>
                <button class="text-red-500 text-sm" onClick={() => void remove(s.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
        {err() && <div class="text-red-700 text-sm mt-2">{err()}</div>}
      </div>
      <div class="flex-1 flex flex-col gap-2">
        <div class="bg-white shadow rounded p-3 h-96 overflow-y-auto space-y-1 text-sm font-mono">
          <For each={log()}>{(line) => <div>{line}</div>}</For>
          {busy() && <div class="text-blue-600">…运行中 {elapsed()}</div>}
        </div>
        <div class="flex gap-2">
          <input
            class="flex-1 border rounded px-2 py-1"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            placeholder={sid() ? '输入任务回车下发' : '先新建或选择会话'}
          />
          <button class="bg-blue-500 text-white px-3 py-1 rounded" disabled={busy()} onClick={() => void send()}>
            发送
          </button>
          {busy() && (
            <button class="bg-red-500 text-white px-3 py-1 rounded" onClick={() => void abort()}>
              中断
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
