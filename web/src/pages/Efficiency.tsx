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
    <div class="page">
      <Show when={err()}><div class="form-err">{err()}</div></Show>
      <div class="toolbar">
        <a class="btn btn-sm" href="/api/export?format=json">导出 JSON</a>
        <a class="btn btn-sm" href="/api/export?format=csv&kind=todos">导出待办 CSV</a>
        <label class="btn btn-sm">导入·合并<input type="file" accept=".json" hidden onChange={(e) => void doImport(e.currentTarget.files?.[0], 'merge')} /></label>
        <label class="btn btn-sm danger">导入·替换<input type="file" accept=".json" hidden onChange={(e) => void doImport(e.currentTarget.files?.[0], 'replace')} /></label>
      </div>
      <div class="panel">
        <div class="panel-title">待办</div>
        <div class="toolbar">
          <input placeholder="标题" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addTodo(); }} />
          <input type="date" value={due()} onInput={(e) => setDue(e.currentTarget.value)} />
          <button class="btn btn-primary btn-sm" onClick={() => void addTodo()}>添加</button>
        </div>
        <ul class="kv">
          <For each={todos()}>
            {(t) => (
              <li>
                <input type="checkbox" checked={!!t.done} onChange={() => void toggle(t)} />
                {' '}<span class={t.done ? 'muted strike' : ''}>{t.title}</span>
                {t.due_at && <span class={overdue(t) ? 'bad' : 'muted'}> ⏰{t.due_at.slice(0, 10)}</span>}
                {' '}<button class="mini-btn danger" onClick={() => void del('todos', t.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-title">笔记</div>
        <div class="toolbar">
          <input placeholder="标题" value={noteTitle()} onInput={(e) => setNoteTitle(e.currentTarget.value)} />
          <input placeholder="内容（Markdown）" value={noteBody()} onInput={(e) => setNoteBody(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addNote(); }} />
          <button class="btn btn-primary btn-sm" onClick={() => void addNote()}>添加</button>
        </div>
        <ul class="kv">
          <For each={notes()}>
            {(n) => (
              <li>
                📝 <button class="mini-btn" onClick={() => setPreviewNote(previewNote() === n.id ? null : n.id)}>{n.title}</button>
                {' '}<button class="mini-btn danger" onClick={() => void del('notes', n.id)}>删</button>
                <Show when={previewNote() === n.id}>
                  <div class="md-preview"><MarkdownView text={n.body} /></div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-title">书签</div>
        <div class="toolbar">
          <input placeholder="按标签筛，如 work" value={tagFilter()} onInput={(e) => { setTagFilter(e.currentTarget.value); void load(); }} />
        </div>
        <ul class="kv">
          <For each={marks()}>
            {(b) => (
              <li>
                🔖 <a href={b.url} target="_blank" rel="noreferrer">{b.title}</a>
                <span class="muted"> {(b.tags ?? []).map((t) => `#${t}`).join(' ')}</span>
                {' '}<button class="mini-btn danger" onClick={() => void del('bookmarks', b.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-title">文件</div>
        <ul class="kv mono">
          <For each={files()}>
            {(f) => (
              <li>
                📎 <a href={`/api/files/${f.id}`}>{f.name}</a>
                <span class="muted"> ({Math.round(f.size / 1024)}K · {String(f.updated_at).slice(0, 16).replace('T', ' ')})</span>
                {' '}<button class="mini-btn" onClick={() => void showPreview(f.id)}>预览</button>
                {' '}<button class="mini-btn danger" onClick={() => void del('files', f.id)}>删</button>
              </li>
            )}
          </For>
        </ul>
        <Show when={preview()}>
          <pre class="code-preview">{preview()?.text}</pre>
        </Show>
        <input type="file" class="mt" onChange={(e) => void upload(e.currentTarget.files?.[0])} />
      </div>
    </div>
  );
}
