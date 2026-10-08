import { createSignal, For } from 'solid-js';
import { api } from '../api';

interface Todo {
  id: string;
  title: string;
  done: number;
}
interface Note {
  id: string;
  title: string;
  body: string;
}
interface Bookmark {
  id: string;
  title: string;
  url: string;
}
interface FileMeta {
  id: string;
  name: string;
  size: number;
}

export default function Efficiency() {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [notes, setNotes] = createSignal<Note[]>([]);
  const [marks, setMarks] = createSignal<Bookmark[]>([]);
  const [files, setFiles] = createSignal<FileMeta[]>([]);
  const [title, setTitle] = createSignal('');
  const [err, setErr] = createSignal('');

  const load = async (): Promise<void> => {
    try {
      const [t, n, b, f] = await Promise.all([
        api<Todo[]>('/api/todos'),
        api<Note[]>('/api/notes'),
        api<Bookmark[]>('/api/bookmarks'),
        api<FileMeta[]>('/api/files'),
      ]);
      setTodos(t);
      setNotes(n);
      setMarks(b);
      setFiles(f);
    } catch (e) {
      setErr(String(e));
    }
  };
  void load();

  const addTodo = async (): Promise<void> => {
    if (!title().trim()) return;
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: title() }) });
    setTitle('');
    await load();
  };
  const toggle = async (t: Todo): Promise<void> => {
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) });
    await load();
  };
  const del = async (kind: string, id: string): Promise<void> => {
    await api(`/api/${kind}/${id}`, { method: 'DELETE' });
    await load();
  };
  const upload = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    await fetch(`/api/files?name=${encodeURIComponent(f.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: f,
    });
    await load();
  };

  return (
    <div class="p-4 space-y-4">
      {err() && <div class="text-red-700">{err()}</div>}
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">待办</h2>
        <div class="flex gap-2 mb-2">
          <input class="flex-1 border rounded px-2 py-1" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addTodo(); }} />
          <button class="bg-blue-500 text-white px-3 py-1 rounded" onClick={() => void addTodo()}>添加</button>
        </div>
        <ul class="space-y-1">
          <For each={todos()}>
            {(t) => (
              <li class="flex gap-2 items-center text-sm">
                <input type="checkbox" checked={!!t.done} onChange={() => void toggle(t)} />
                <span class={t.done ? 'line-through text-gray-400 flex-1' : 'flex-1'}>{t.title}</span>
                <button class="text-red-500" onClick={() => void del('todos', t.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">笔记（{notes().length}）/ 书签（{marks().length}）/ 文件（{files().length}）</h2>
        <ul class="text-sm space-y-1">
          <For each={notes()}>{(n) => <li>📝 {n.title} <button class="text-red-500" onClick={() => void del('notes', n.id)}>删</button></li>}</For>
          <For each={marks()}>{(b) => <li>🔖 <a class="text-blue-600" href={b.url} target="_blank">{b.title}</a> <button class="text-red-500" onClick={() => void del('bookmarks', b.id)}>删</button></li>}</For>
          <For each={files()}>
            {(f) => (
              <li>📎 <a class="text-blue-600" href={`/api/files/${f.id}`}>{f.name}</a> ({Math.round(f.size / 1024)}K) <button class="text-red-500" onClick={() => void del('files', f.id)}>删</button></li>
            )}
          </For>
        </ul>
        <input type="file" class="mt-2 text-sm" onChange={(e) => void upload(e.currentTarget.files?.[0])} />
      </div>
    </div>
  );
}
