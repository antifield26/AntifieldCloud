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
    <div class="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
      <For each={svcs()}>
        {(s) => (
          <a href={s.href} class="bg-white shadow rounded p-4 hover:shadow-lg block">
            <div class="font-bold">{s.title}</div>
            <div class="text-sm text-blue-600">{s.href}</div>
            <div class="text-sm text-gray-500">{s.note}</div>
          </a>
        )}
      </For>
    </div>
  );
}
