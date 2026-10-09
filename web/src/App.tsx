import { createSignal, For, Show, onCleanup } from 'solid-js';
import Console from './pages/Console';
import Ai from './pages/Ai';
import Efficiency from './pages/Efficiency';
import Jobs from './pages/Jobs';
import Portal from './pages/Portal';
import Login from './pages/Login';
import { api } from './api';
import { useSid, setSessionId, sessionList, loadSessions, createSession } from './store';

const tabs = [
  { id: 'console', title: '控制台', icon: '◈' },
  { id: 'ai', title: 'AI 会话', icon: '✦' },
  { id: 'eff', title: '效率', icon: '☰' },
  { id: 'jobs', title: '流水线', icon: '▶' },
  { id: 'portal', title: '门户', icon: '▦' },
] as const;

interface Toast {
  id: number;
  text: string;
  err: boolean;
}

let toastId = 0;

export default function App() {
  const [tab, setTab] = createSignal<string>(location.hash.replace('#', '') || 'console');
  const [authed, setAuthed] = createSignal<boolean | null>(null);
  const [q, setQ] = createSignal('');
  const [hits, setHits] = createSignal<Array<{ kind: string; id: string; title: string; snippet: string; jump: string }>>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [showPw, setShowPw] = createSignal(false);
  const [oldPw, setOldPw] = createSignal('');
  const [newPw, setNewPw] = createSignal('');
  const [pwMsg, setPwMsg] = createSignal('');
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [cmdkOpen, setCmdkOpen] = createSignal(false);
  const [cmdkQ, setCmdkQ] = createSignal('');
  const [confirm, setConfirm] = createSignal<{ title: string; msg: string; action: () => void } | null>(null);
  const [status, setStatus] = createSignal({ temp: '?', mem: '?', sd: '?', health: '?' });

  const toast = (text: string, err = false): void => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };

  const check = async (): Promise<void> => {
    try {
      const s = await api<{ authenticated: boolean }>('/api/auth/status');
      setAuthed(s.authenticated);
      if (s.authenticated) void loadSessions();
    } catch {
      setAuthed(false);
    }
  };
  void check();

  const pick = (id: string): void => {
    setTab(id);
    location.hash = id;
    setMenuOpen(false);
  };

  const pollStatus = async (): Promise<void> => {
    try {
      const o = await api<{ tempC: number | null; memUsedKb: number; memTotalKb: number; diskWrittenKb: number }>('/api/sys/overview');
      setStatus({
        temp: o.tempC === null ? '?' : `${o.tempC}°C`,
        mem: `${Math.round(o.memUsedKb / 1048576)}/${Math.round(o.memTotalKb / 1048576)}G`,
        sd: `${Math.round(o.diskWrittenKb / 1048576)}G`,
        health: 'ok',
      });
    } catch {
      setStatus({ temp: '?', mem: '?', sd: '?', health: 'down' });
    }
  };
  void pollStatus();
  const st = setInterval(() => void pollStatus(), 15000);
  onCleanup(() => clearInterval(st));

  const changePw = async (): Promise<void> => {
    setPwMsg('');
    try {
      await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ old: oldPw(), next: newPw() }) });
      setOldPw('');
      setNewPw('');
      setShowPw(false);
      await api('/api/auth/logout', { method: 'POST' });
      setAuthed(false);
    } catch {
      setPwMsg('改密失败：旧口令错或新口令不足 8 位');
    }
  };

  const confirmDo = (title: string, msg: string, action: () => void): void => {
    setConfirm({ title, msg, action });
  };

  const commands = (): Array<{ label: string; run: () => void }> => [
    ...tabs.map((t) => ({ label: `前往${t.title}`, run: () => pick(t.id) })),
    {
      label: '新建 AI 会话',
      run: () => void createSession().then(() => pick('ai')),
    },
    {
      label: '重启 cloudflared（需确认）',
      run: () => confirmDo('重启服务', '确定重启 cloudflared.service？', () => void restartUnit('cloudflared.service')),
    },
    {
      label: '退出登录',
      run: () => void api('/api/auth/logout', { method: 'POST' }).finally(() => setAuthed(false)),
    },
  ];

  const restartUnit = async (unit: string): Promise<void> => {
    try {
      await api(`/api/sys/services/${unit}/restart`, { method: 'POST' });
      toast('已下发重启');
    } catch (e) {
      toast(String(e), true);
    }
  };

  const cmdkItems = (): Array<{ label: string; run: () => void }> => {
    const qv = cmdkQ().trim();
    return commands().filter((c) => c.label.includes(qv));
  };

  let searchTimer = 0;
  const search = (v: string): void => {
    setQ(v);
    window.clearTimeout(searchTimer);
    if (v.trim().length < 1) {
      setHits([]);
      return;
    }
    searchTimer = window.setTimeout(() => {
      void api<{ hits: Array<{ kind: string; id: string; title: string; snippet: string; jump: string }> }>(
        `/api/search?q=${encodeURIComponent(v.trim())}`,
      )
        .then((j) => setHits(j.hits))
        .catch(() => setHits([]));
    }, 300);
  };

  const onKey = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setCmdkQ('');
      setCmdkOpen(true);
    }
    if (e.key === 'Escape') {
      setCmdkOpen(false);
      setConfirm(null);
    }
    const ae = document.activeElement as HTMLElement | null;
    if (!ae || !/INPUT|TEXTAREA/.test(ae.tagName)) {
      const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
      if (idx >= 0) pick(tabs[idx].id);
    }
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  return (
    <Show when={authed() !== null} fallback={<div class="p-8">加载中…</div>}>
      <Show when={authed()} fallback={<Login onOk={() => void check().then(() => setAuthed(true))} />}>
        <div class="dock">
          <nav class="rail" aria-label="视图">
            <span class="rail-mark">π</span>
            <For each={tabs}>
              {(t) => (
                <button
                  class={`rail-item ${tab() === t.id ? 'active' : ''}`}
                  title={`${t.title}`}
                  onClick={() => pick(t.id)}
                >
                  {t.icon}
                </button>
              )}
            </For>
            <span class="rail-sp" />
            <button class="rail-item" title="命令 (⌘K)" onClick={() => { setCmdkQ(''); setCmdkOpen(true); }}>
              ⌘
            </button>
          </nav>

          <aside class="sessions">
            <div class="sessions-head">
              <span>会话</span>
              <button class="mini-btn" title="新建" onClick={() => void createSession().then(() => pick('ai'))}>
                ＋
              </button>
            </div>
            <ul class="session-list">
              <For each={sessionList()}>
                {(s) => (
                  <li
                    class={useSid() === s.id ? 'active' : ''}
                    onClick={() => {
                      setSessionId(s.id);
                      pick('ai');
                    }}
                  >
                    {s.title || s.id.slice(0, 12)}
                  </li>
                )}
              </For>
            </ul>
            <div class="sessions-foot">一点即切</div>
          </aside>

          <div class="main">
            <header class="topbar">
              <button class="md:hidden px-3 py-1 rounded bg-gray-700" onClick={() => setMenuOpen(!menuOpen())}>
                {menuOpen() ? '收起' : '菜单'}
              </button>
              <div class={`relative ${menuOpen() ? 'block' : 'hidden'} md:block`}>
                <input
                  class="bg-gray-800 rounded px-2 py-1 text-sm w-48"
                  placeholder="搜索…"
                  value={q()}
                  onInput={(e) => search(e.currentTarget.value)}
                />
                <Show when={hits().length > 0}>
                  <ul class="absolute right-0 mt-1 w-72 bg-white text-black shadow-lg rounded text-sm max-h-80 overflow-y-auto">
                    <For each={hits()}>
                      {(h) => (
                        <li>
                          <button
                            class="w-full text-left px-2 py-1 hover:bg-gray-100"
                            onClick={() => {
                              setHits([]);
                              setQ('');
                              pick(h.jump.replace('#', ''));
                            }}
                          >
                            <span class="text-gray-400">[{h.kind}]</span> {h.title}
                            <div class="text-gray-500 truncate">{h.snippet}</div>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <div class="top-actions ml-auto">
                <button class="px-2 py-1 text-sm" onClick={() => setShowPw(!showPw())}>
                  改密
                </button>
                <button
                  class="px-2 py-1 text-sm"
                  onClick={() => void api('/api/auth/logout', { method: 'POST' }).finally(() => setAuthed(false))}
                >
                  退出
                </button>
              </div>
            </header>
            <Show when={showPw()}>
              <div class="bg-yellow-50 border-b px-4 py-2 flex gap-2 items-center flex-wrap text-sm text-black">
                <span>旧口令</span>
                <input type="password" class="border rounded px-2 py-1" value={oldPw()} onInput={(e) => setOldPw(e.currentTarget.value)} />
                <span>新口令（≥8 位）</span>
                <input type="password" class="border rounded px-2 py-1" value={newPw()} onInput={(e) => setNewPw(e.currentTarget.value)} />
                <button class="bg-blue-600 text-white px-3 py-1 rounded" onClick={() => void changePw()}>
                  确认修改
                </button>
                {pwMsg() && <span class="text-red-700">{pwMsg()}</span>}
              </div>
            </Show>
            <main class="content">
              {tab() === 'console' && <Console />}
              {tab() === 'ai' && <Ai />}
              {tab() === 'eff' && <Efficiency />}
              {tab() === 'jobs' && <Jobs />}
              {tab() === 'portal' && <Portal />}
            </main>
            <footer class="statusbar">
              <span class="st">◈ {status().temp}</span>
              <span class="st">▦ {status().mem}</span>
              <span class="st">▼ {status().sd}</span>
              <span class="st-sp" />
              <span class="st">{status().health === 'ok' ? 'tunnel ok' : 'down'}</span>
            </footer>
          </div>
        </div>

        <Show when={cmdkOpen()}>
          <div class="cmdk-backdrop" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('cmdk-backdrop')) setCmdkOpen(false); }}>
            <div class="cmdk">
              <input
                placeholder="输入命令 / 跳转…"
                value={cmdkQ()}
                onInput={(e) => setCmdkQ(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const first = cmdkItems()[0];
                    if (first) {
                      setCmdkOpen(false);
                      first.run();
                    }
                  }
                }}
                ref={(el) => el.focus()}
              />
              <ul class="cmdk-list">
                <For each={cmdkItems()}>
                  {(c) => (
                    <li
                      onClick={() => {
                        setCmdkOpen(false);
                        c.run();
                      }}
                    >
                      {c.label}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </div>
        </Show>

        <Show when={confirm() !== null}>
          <div class="modal-backdrop">
            <div class="modal text-black">
              <h2>{confirm()!.title}</h2>
              <p>{confirm()!.msg}</p>
              <div class="modal-actions">
                <button class="btn" onClick={() => setConfirm(null)}>
                  取消
                </button>
                <button
                  class="btn btn-danger"
                  onClick={() => {
                    const a = confirm()!.action;
                    setConfirm(null);
                    a();
                  }}
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        </Show>

        <div class="toast-root">
          <For each={toasts()}>
            {(t) => <div class={t.err ? 'toast err' : 'toast'}>{t.text}</div>}
          </For>
        </div>
      </Show>
    </Show>
  );
}
