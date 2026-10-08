import { createSignal, Show } from 'solid-js';
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
  };
  return (
    <Show when={authed() !== null} fallback={<div class="p-8">加载中…</div>}>
      <Show
        when={authed()}
        fallback={<Login onOk={() => void check().then(() => setAuthed(true))} />}
      >
        <div class="min-h-screen bg-gray-100">
          <header class="bg-gray-900 text-white px-4 py-2 flex gap-2 items-center">
            <span class="font-bold">AntifieldCloud</span>
            {tabs.map((t) => (
              <button
                class={`px-3 py-1 rounded ${tab() === t.id ? 'bg-gray-700' : 'hover:bg-gray-800'}`}
                onClick={() => pick(t.id)}
              >
                {t.title}
              </button>
            ))}
          </header>
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
