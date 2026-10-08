import { createSignal, For, onCleanup } from 'solid-js';
import { api } from '../api';

interface Session {
  id: string;
  title: string;
}

interface MsgItem {
  id: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}

const msgText = (m: MsgItem): string => {
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.content)) return m.content.map((c) => c.text ?? `[${c.type}]`).join('\n');
  return `[${m.type}]`;
};

export default function Ai() {
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [sid, setSid] = createSignal('');
  const [msgs, setMsgs] = createSignal<MsgItem[]>([]);
  const [input, setInput] = createSignal('');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const loadSessions = async (): Promise<void> => {
    setSessions(await api<Session[]>('/api/ai/sessions'));
  };
  const loadMsgs = async (): Promise<void> => {
    if (!sid()) return;
    const j = (await api<{ data: MsgItem[] }>(`/api/ai/sessions/${sid()}/messages`)) as { data: MsgItem[] };
    setMsgs(j.data ?? []);
  };
  const create = async (): Promise<void> => {
    const s = await api<Session>('/api/ai/sessions', { method: 'POST', body: JSON.stringify({ title: 'web' }) });
    setSid(s.id);
    await Promise.all([loadSessions(), loadMsgs()]);
  };
  const send = async (): Promise<void> => {
    if (!sid() || !input().trim() || busy()) return;
    setBusy(true);
    try {
      await api(`/api/ai/sessions/${sid()}/prompt`, { method: 'POST', body: JSON.stringify({ text: input() }) });
      setInput('');
      for (let i = 0; i < 40 && busy(); i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await loadMsgs();
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  void loadSessions();
  const t = setInterval(() => {
    if (busy()) void loadMsgs();
  }, 5000);
  onCleanup(() => clearInterval(t));

  return (
    <div class="p-4 flex gap-4">
      <div class="w-64 shrink-0">
        <button class="bg-blue-500 text-white px-3 py-1 rounded mb-2" onClick={() => void create()}>新建会话</button>
        <ul class="space-y-1">
          <For each={sessions()}>
            {(s) => (
              <li>
                <button
                  class={`w-full text-left px-2 py-1 rounded text-sm ${sid() === s.id ? 'bg-blue-100' : 'hover:bg-gray-200'}`}
                  onClick={() => {
                    setSid(s.id);
                    void loadMsgs();
                  }}
                >
                  {s.title || s.id.slice(0, 12)}
                </button>
              </li>
            )}
          </For>
        </ul>
        {err() && <div class="text-red-700 text-sm mt-2">{err()}</div>}
      </div>
      <div class="flex-1 flex flex-col gap-2">
        <div class="bg-white shadow rounded p-3 h-96 overflow-y-auto space-y-2">
          <For each={msgs()}>
            {(m) => (
              <div class={`p-2 rounded text-sm whitespace-pre-wrap ${m.type === 'user' ? 'bg-gray-100' : 'bg-green-50'}`}>
                <b>{m.type}</b>: {msgText(m)}
              </div>
            )}
          </For>
        </div>
        <div class="flex gap-2">
          <input
            class="flex-1 border rounded px-2 py-1"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            placeholder={sid() ? '输入消息回车发送' : '先新建或选择会话'}
          />
          <button class="bg-blue-500 text-white px-3 py-1 rounded" disabled={busy()} onClick={() => void send()}>
            {busy() ? '…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
