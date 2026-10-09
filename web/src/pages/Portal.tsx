import { createSignal, For, onMount } from 'solid-js';
import { api } from '../api';

interface Svc {
  id: string;
  title: string;
  href: string;
  note: string;
}

export default function Portal() {
  const [svcs, setSvcs] = createSignal<Svc[]>([]);
  onMount(() => {
    void api<{ services: Svc[] }>('/api/portal/services').then((j) => setSvcs(j.services));
  });
  return (
    <div class="portal-grid">
      <For each={svcs()}>
        {(s) => (
          <a href={s.href} class="card portal-card">
            <div class="card-title">{s.title}</div>
            <div class="mono muted">{s.href}</div>
            <div class="muted text-sm">{s.note}</div>
          </a>
        )}
      </For>
    </div>
  );
}
