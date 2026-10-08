import { createSignal, For, Show } from 'solid-js';
import { api } from '../api';
import { MarkdownView } from '../md';

interface Todo {
  id: string;
  title: string;
  done: number;
  due_at: string | null;
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
  tags: string[];
}
interface FileMeta {
  id: string;
  name: string;
  size: number;
  updated_at: string;
}

const overdue = (t: Todo): boolean => !t.done && !!t.due_at && t.due_at < new Date().toISOString().slice(0, 10);

export default function Efficiency() {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [notes, setNotes] = createSignal<Note[]>([]);
  const [marks, setMarks] = createSignal<Bookmark[]>([]);
  const [files, setFiles] = createSignal<FileMeta[]>([]);
  const [title, setTitle] = createSignal('');
  const [due, setDue] = createSignal('');
  const [noteTitle, setNoteTitle] = createSignal('');
  const [noteBody, setNoteBody] = createSignal('');
  const [previewNote, setPreviewNote] = createSignal<string | null>(null);
  const [tagFilter, setTagFilter] = createSignal('');
  const [preview, setPreview] = createSignal<{ name: string; text: string } | null>(null);
  const [err, setErr] = createSignal('');

  const load = async (): Promise<void> => {
    try {
      const q = tagFilter() ? `?tag=${encodeURIComponent(tagFilter())}` : '';
      const [t, n, b, f] = await Promise.all([
        api<Todo[]>('/api/todos'),
        api<Note[]>('/api/notes'),
        api<Bookmark[]>(`/api/bookmarks${q}`),
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
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: title(), due_at: due() || undefined }) });
    setTitle('');
    setDue('');
    await load();
  };
  const toggle = async (t: Todo): Promise<void> => {
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) });
    await load();
  };
  const addNote = async (): Promise<void> => {
    if (!noteTitle().trim()) return;
    await api('/api/notes', { method: 'POST', body: JSON.stringify({ title: noteTitle(), body: noteBody() }) });
    setNoteTitle('');
    setNoteBody('');
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
  const showPreview = async (id: string): Promise<void> => {
    try {
      const j = await api<{ name: string; text: string }>(`/api/files/${id}/preview`);
      setPreview({ name: j.name, text: j.text });
    } catch (e) {
      setErr(`预览失败：${String(e)}`);
    }
  };
  const doImport = async (f: File | undefined, mode: string): Promise<void> => {
    if (!f) return;
    try {
      const body = JSON.parse(await f.text()) as unknown;
      const r = await api<{ ok: boolean; counts: Record<string, number> }>(`/api/import?mode=${mode}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setErr(`导入完成：${JSON.stringify(r.counts)}`);
      await load();
    } catch (e) {
      setErr(`导入失败：${String(e)}`);
    }
  };

  return (
    <div class="p-4 space-y-4">
      {err() && <div class="text-red-700">{err()}</div>}
      <div class="flex gap-2 text-sm">
        <a class="bg-gray-700 text-white px-2 py-1 rounded" href="/api/export?format=json">导出 JSON</a>
        <a class="bg-gray-700 text-white px-2 py-1 rounded" href="/api/export?format=csv&kind=todos">导出待办 CSV</a>
        <label class="bg-gray-700 text-white px-2 py-1 rounded cursor-pointer">
          导入(JSON·合并)
          <input type="file" accept=".json" class="hidden" onChange={(e) => void doImport(e.currentTarget.files?.[0], 'merge')} />
        </label>
        <label class="bg-red-700 text-white px-2 py-1 rounded cursor-pointer">
          导入(JSON·替换)
          <input type="file" accept=".json" class="hidden" onChange={(e) => void doImport(e.currentTarget.files?.[0], 'replace')} />
        </label>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">待办</h2>
        <div class="flex gap-2 mb-2">
          <input class="flex-1 border rounded px-2 py-1" placeholder="标题" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addTodo(); }} />
          <input type="date" class="border rounded px-2 py-1" value={due()} onInput={(e) => setDue(e.currentTarget.value)} />
          <button class="bg-blue-500 text-white px-3 py-1 rounded" onClick={() => void addTodo()}>添加</button>
        </div>
        <ul class="space-y-1">
          <For each={todos()}>
            {(t) => (
              <li class="flex gap-2 items-center text-sm">
                <input type="checkbox" checked={!!t.done} onChange={() => void toggle(t)} />
                <span class={`${t.done ? 'line-through text-gray-400' : ''} flex-1`}>
                  {t.title}
                  {t.due_at && <span class={`ml-2 ${overdue(t) ? 'text-red-600 font-bold' : 'text-gray-400'}`}>⏰{t.due_at.slice(0, 10)}</span>}
                </span>
                <button class="text-red-500" onClick={() => void del('todos', t.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">笔记</h2>
        <div class="flex gap-2 mb-2">
          <input class="border rounded px-2 py-1" placeholder="标题" value={noteTitle()} onInput={(e) => setNoteTitle(e.currentTarget.value)} />
          <input class="flex-1 border rounded px-2 py-1" placeholder="内容（Markdown）" value={noteBody()} onInput={(e) => setNoteBody(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addNote(); }} />
          <button class="bg-blue-500 text-white px-3 py-1 rounded" onClick={() => void addNote()}>添加</button>
        </div>
        <ul class="text-sm space-y-1">
          <For each={notes()}>
            {(n) => (
              <li>
                📝 <button class="text-blue-600" onClick={() => setPreviewNote(previewNote() === n.id ? null : n.id)}>{n.title}</button>
                <button class="text-red-500 ml-2" onClick={() => void del('notes', n.id)}>删</button>
                <Show when={previewNote() === n.id}>
                  <div class="ml-4 mt-1 p-2 bg-gray-50 rounded prose-sm"><MarkdownView text={n.body} /></div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">书签</h2>
        <input class="border rounded px-2 py-1 text-sm mb-2" placeholder="按标签筛，如 work" value={tagFilter()} onInput={(e) => { setTagFilter(e.currentTarget.value); void load(); }} />
        <ul class="text-sm space-y-1">
          <For each={marks()}>
            {(b) => (
              <li>
                🔖 <a class="text-blue-600" href={b.url} target="_blank" rel="noreferrer">{b.title}</a>
                <span class="text-gray-400 ml-1">{(b.tags ?? []).map((t) => `#${t}`).join(' ')}</span>
                <button class="text-red-500 ml-2" onClick={() => void del('bookmarks', b.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="bg-white shadow rounded p-3">
        <h2 class="font-bold mb-2">文件</h2>
        <ul class="text-sm space-y-1">
          <For each={files()}>
            {(f) => (
              <li>
                📎 <a class="text-blue-600" href={`/api/files/${f.id}`}>{f.name}</a>
                <span class="text-gray-400"> ({Math.round(f.size / 1024)}K · {String(f.updated_at).slice(0, 16).replace('T', ' ')})</span>
                <button class="text-blue-600 ml-2" onClick={() => void showPreview(f.id)}>预览</button>
                <button class="text-red-500 ml-1" onClick={() => void del('files', f.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
        <Show when={preview()}>
          <pre class="mt-2 p-2 bg-gray-900 text-green-200 text-xs rounded overflow-auto max-h-64 whitespace-pre-wrap">{preview()?.text}</pre>
        </Show>
        <input type="file" class="mt-2 text-sm" onChange={(e) => void upload(e.currentTarget.files?.[0])} />
      </div>
    </div>
  );
}
