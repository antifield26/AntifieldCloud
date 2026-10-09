import { createSignal, For, Show, onCleanup } from 'solid-js';
import { api } from '../api';
import { useSid } from '../store';

interface Session {
  id: string;
  title: string;
}
interface Model {
  id: string;
  modelID: string;
  providerID: string;
  name?: string;
  variants?: Record<string, unknown>;
}
interface Agent {
  id: string;
  name?: string;
}
interface MsgItem {
  id: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}
interface Perm {
  id: string;
  title?: string;
}

const BUILTIN_AGENTS = ['build', 'plan'];

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
  const [models, setModels] = createSignal<Model[]>([]);
  const [agents, setAgents] = createSignal<string[]>([...BUILTIN_AGENTS]);
  const [providers, setProviders] = createSignal<Array<{ id: string; name?: string }>>([]);
  const [model, setModel] = createSignal('');
  const [variant, setVariant] = createSignal('');
  const [agent, setAgent] = createSignal('build');
  const [perms, setPerms] = createSignal<Perm[]>([]);
  const [showSettings, setShowSettings] = createSignal(false);
  const [input, setInput] = createSignal('');
  const [err, setErr] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [started, setStarted] = createSignal(0);
  const [elapsed, setElapsed] = createSignal('');
  let es: EventSource | null = null;
  let lastSid = '';

  const curModel = (): Model | undefined => models().find((m) => `${m.providerID}/${m.modelID}` === model());
  const variants = (): string[] => Object.keys(curModel()?.variants ?? {});

  const loadCatalog = async (): Promise<void> => {
    try {
      const [ms, ag, pr, dm] = await Promise.all([
        api<{ data: Model[] }>('/api/ai/models').catch(() => ({ data: [] })),
        api<{ data: Agent[] }>('/api/ai/agents').catch(() => ({ data: [] })),
        api<{ data: Array<{ id: string; name?: string }> }>('/api/ai/providers').catch(() => ({ data: [] })),
        api<{ data: { providerID: string; modelID: string } }>('/api/ai/models/default').catch(() => null),
      ]);
      setModels(ms.data ?? []);
      const names = (ag.data ?? []).map((a) => a.id);
      setAgents(names.length > 0 ? names : [...BUILTIN_AGENTS]);
      setProviders(pr.data ?? []);
      if (dm?.data && !model()) {
        setModel(`${dm.data.providerID}/${dm.data.modelID}`);
        if (!ms.data?.some((m) => `${m.providerID}/${m.modelID}` === model())) {
          setModels([{ id: dm.data.modelID, modelID: dm.data.modelID, providerID: dm.data.providerID }]);
        }
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const loadMsgs = async (): Promise<void> => {
    const id = useSid();
    if (!id) {
      setMsgs([]);
      return;
    }
    const j = (await api<{ data: MsgItem[] }>(`/api/ai/sessions/${id}/messages`)) as { data: MsgItem[] };
    setMsgs(j.data ?? []);
  };

  const loadPerms = async (): Promise<void> => {
    const id = useSid();
    if (!id) return;
    try {
      const j = (await api<{ data: Perm[] }>(`/api/ai/sessions/${id}/permissions`)) as { data: Perm[] };
      setPerms(j.data ?? []);
    } catch {
      setPerms([]);
    }
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
      const [prov, mid] = model().split('/');
      if (prov && mid) {
        await api(`/api/ai/sessions/${id}/model`, {
          method: 'POST',
          body: JSON.stringify({ providerID: prov, modelID: mid, ...(variant() ? { variant: variant() } : {}) }),
        }).catch(() => undefined);
      }
      if (agent()) {
        await api(`/api/ai/sessions/${id}/agent`, {
          method: 'POST',
          body: JSON.stringify({ agent: agent() }),
        }).catch(() => undefined);
      }
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

  const replyPerm = async (rid: string, response: 'allow' | 'deny'): Promise<void> => {
    const id = useSid();
    if (!id) return;
    await api(`/api/ai/sessions/${id}/permissions/${rid}/reply`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
    await loadPerms();
  };

  void loadCatalog();
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
    if (busy()) {
      setElapsed(`${Math.round((Date.now() - started()) / 1000)}s`);
      void loadPerms();
    }
  }, 1000);
  onCleanup(() => {
    clearInterval(t);
    es?.close();
  });

  return (
    <div class="flex flex-col gap-2">
      {err() && <div class="text-red-700 text-sm">{err()}</div>}
      <div class="toolbar">
        <select value={model()} onChange={(e) => { setModel(e.currentTarget.value); setVariant(''); }}>
          <option value="">模型（默认）</option>
          <For each={models()}>
            {(m) => <option value={`${m.providerID}/${m.modelID}`}>{m.name ?? m.modelID} · {m.providerID}</option>}
          </For>
        </select>
        <Show when={variants().length > 0}>
          <select value={variant()} onChange={(e) => setVariant(e.currentTarget.value)}>
            <option value="">变体（默认）</option>
            <For each={variants()}>{(v) => <option value={v}>{v}</option>}</For>
          </select>
        </Show>
        <select value={agent()} onChange={(e) => setAgent(e.currentTarget.value)}>
          <For each={agents()}>{(a) => <option value={a}>{a}</option>}</For>
        </select>
        <button class="mini-btn" onClick={() => setShowSettings(!showSettings())}>
          设置
        </button>
      </div>
      <Show when={showSettings()}>
        <div class="panel tight">
          <div class="panel-title">提供方状态</div>
          <ul class="kv mono">
            <For each={providers()} fallback={<li class="muted">无（模型走默认直连）</li>}>
              {(p) => <li>{p.id} — {p.name ?? ''}</li>}
            </For>
          </ul>
          <div class="muted text-sm">模型 Key 只存 Pi 本地 OpenCode 配置，不经本页传输。</div>
        </div>
      </Show>
      <Show when={perms().length > 0}>
        <div class="panel tight perm-dock">
          <div class="panel-title">权限请求（执行中）</div>
          <For each={perms()}>
            {(p) => (
              <div class="flex gap-2 items-center text-sm">
                <span class="grow">{p.title ?? p.id}</span>
                <button class="btn btn-primary btn-sm" onClick={() => void replyPerm(p.id, 'allow')}>
                  允许
                </button>
                <button class="btn btn-sm danger" onClick={() => void replyPerm(p.id, 'deny')}>
                  拒绝
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
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
