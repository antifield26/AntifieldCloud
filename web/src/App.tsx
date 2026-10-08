import { createSignal, For, Show } from 'solid-js';
import Console from './pages/Console';
import Ai from './pages/Ai';
import Efficiency from './pages/Efficiency';
import Jobs from './pages/Jobs';
import Portal from './pages/Portal';
import Login from './pages/Login';
import { api } from './api';

const tabs = [
  { id: 'console', title: '控制台' },
  { id: 'ai', title: 'AI 会话' },
  { id: 'eff', title: '效率' },
  { id: 'jobs', title: '流水线' },
  { id: 'portal', title: '门户' },
] as const;

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
  const changePw = async (): Promise<void> => {
    setPwMsg('');
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ old: oldPw(), next: newPw() }),
      });
      setOldPw('');
      setNewPw('');
      setShowPw(false);
      await api('/api/auth/logout', { method: 'POST' });
      setAuthed(false);
    } catch {
      setPwMsg('改密失败：旧口令错或新口令不足 8 位');
    }
  };
  const check = async (): Promise<void> => {
    try {
      const s = await api<{ authenticated: boolean }>('/api/auth/status');
      setAuthed(s.authenticated);
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
  let timer = 0;
  const search = (v: string): void => {
    setQ(v);
    window.clearTimeout(timer);
    if (v.trim().length < 1) {
      setHits([]);
      return;
    }
    timer = window.setTimeout(() => {
      void api<{ hits: Array<{ kind: string; id: string; title: string; snippet: string; jump: string }> }>(
        `/api/search?q=${encodeURIComponent(v.trim())}`,
      )
        .then((j) => setHits(j.hits))
        .catch(() => setHits([]));
    }, 300);
  };
  return (
    <Show when={authed() !== null} fallback={<div class="p-8">加载中…</div>}>
      <Show
        when={authed()}
        fallback={<Login onOk={() => void check().then(() => setAuthed(true))} />}
      >
        <div class="min-h-screen bg-gray-100">
          <header class="bg-gray-900 text-white px-4 py-2 flex gap-2 items-center flex-wrap">
            <span class="font-bold">AntifieldCloud</span>
            <button class="md:hidden px-3 py-1 rounded bg-gray-700" onClick={() => setMenuOpen(!menuOpen())}>
              {menuOpen() ? '收起' : '菜单'}
            </button>
            <nav class={`${menuOpen() ? 'flex' : 'hidden'} md:flex gap-2 items-center flex-wrap basis-full md:basis-auto`}>
              {tabs.map((t) => (
                <button
                  class={`px-3 py-1 rounded text-left ${tab() === t.id ? 'bg-gray-700' : 'hover:bg-gray-800'}`}
                  onClick={() => pick(t.id)}
                >
                  {t.title}
                </button>
              ))}
            </nav>
            <div class="relative ml-auto flex gap-2 items-center">
              <button
                class="px-3 py-1 rounded bg-gray-700 text-sm"
                onClick={() => {
                  setShowPw(!showPw());
                  setPwMsg('');
                }}
              >
                改密
              </button>
              <button
                class="px-3 py-1 rounded bg-gray-700 text-sm"
                onClick={() => void api('/api/auth/logout', { method: 'POST' }).finally(() => setAuthed(false))}
              >
                退出
              </button>
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
          </header>
          <Show when={showPw()}>
            <div class="bg-yellow-50 border-b px-4 py-2 flex gap-2 items-center flex-wrap text-sm">
              <span>旧口令</span>
              <input type="password" class="border rounded px-2 py-1" value={oldPw()} onInput={(e) => setOldPw(e.currentTarget.value)} />
              <span>新口令（≥8 位）</span>
              <input type="password" class="border rounded px-2 py-1" value={newPw()} onInput={(e) => setNewPw(e.currentTarget.value)} />
              <button class="bg-blue-600 text-white px-3 py-1 rounded" onClick={() => void changePw()}>确认修改</button>
              {pwMsg() && <span class="text-red-700">{pwMsg()}</span>}
            </div>
          </Show>
          <main>
            {tab() === 'console' && <Console />}
            {tab() === 'ai' && <Ai />}
            {tab() === 'eff' && <Efficiency />}
            {tab() === 'jobs' && <Jobs />}
            {tab() === 'portal' && <Portal />}
          </main>
        </div>
      </Show>
    </Show>
  );
}
