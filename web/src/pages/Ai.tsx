import { createSignal, For, onCleanup } from 'solid-js';
import { api } from '../api';
import { useSid } from '../store';

interface MsgItem {
  id: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}

const TERMINAL = new Set([
  'session.execution.finished',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.idle',
  'session.error',
]);

const msgText = (m: MsgItem): string => {
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.content)) return m.content.map((c) => c.text ?? `[${c.type}]`).join('\n');
  return `[${m.type}]`;
};

export default function Ai() {
  const [msgs, setMsgs] = createSignal<MsgItem[]>([]);
  const [input, setInput] = createSignal('');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [started, setStarted] = createSignal(0);
  const [elapsed, setElapsed] = createSignal('');
  let es: EventSource | null = null;
  let lastSid = '';

  const loadMsgs = async (): Promise<void> => {
    const id = useSid();
    if (!id) {
      setMsgs([]);
      return;
    }
    const j = (await api<{ data: MsgItem[] }>(`/api/ai/sessions/${id}/messages`)) as { data: MsgItem[] };
    setMsgs(j.data ?? []);
  };

  const stream = (id: string): void => {
    if (es) {
      es.close();
      es = null;
    }
    if (!id) return;
    es = new EventSource(`/api/ai/sessions/${id}/events`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as { type?: string };
        const t = ev.type ?? '?';
        if (t === 'server.connected') return;
        if (TERMINAL.has(t)) {
          setBusy(false);
          void loadMsgs();
          es?.close();
          es = null;
        }
      } catch {
        // 忽略坏帧
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      setTimeout(() => {
        if (useSid() === id) stream(id);
      }, 3000);
    };
  };

  const send = async (): Promise<void> => {
    const id = useSid();
    if (!id || !input().trim() || busy()) return;
    setBusy(true);
    setStarted(Date.now());
    try {
      await api(`/api/ai/sessions/${id}/prompt`, { method: 'POST', body: JSON.stringify({ text: input() }) });
      setInput('');
      stream(id);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const abort = async (): Promise<void> => {
    const id = useSid();
    if (!id) return;
    await api(`/api/ai/sessions/${id}/abort`, { method: 'POST' });
    setBusy(false);
  };

  const t = setInterval(() => {
    if (useSid() !== lastSid) {
      lastSid = useSid();
      setBusy(false);
      if (es) {
        es.close();
        es = null;
      }
      if (lastSid) {
        void loadMsgs();
        stream(lastSid);
      } else {
        setMsgs([]);
      }
    }
    if (busy()) setElapsed(`${Math.round((Date.now() - started()) / 1000)}s`);
  }, 500);
  onCleanup(() => {
    clearInterval(t);
    es?.close();
  });

  return (
    <div class="flex flex-col gap-2">
      {err() && <div class="text-red-700 text-sm">{err()}</div>}
      <div class="chat">
        <For each={msgs()}>
          {(m) => (
            <div class={`chat-msg ${m.type === 'user' ? 'user' : ''}`}>
              <div class="who">{m.type}</div>
              {msgText(m)}
            </div>
          )}
        </For>
      </div>
      <div class="composer">
        <div class="composer-row">
          <input
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            placeholder={useSid() ? '输入任务回车下发' : '先在左侧新建或选择会话'}
          />
          <button class="btn btn-primary" disabled={busy()} onClick={() => void send()}>
            发送
          </button>
          {busy() && (
            <button class="btn btn-danger" onClick={() => void abort()}>
              中断 {elapsed()}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
