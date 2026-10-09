import { createSignal } from 'solid-js';
import { api } from './api';

export interface Session {
  id: string;
  title: string;
}

const [sid, setSid] = createSignal('');
const [sessions, setSessions] = createSignal<Session[]>([]);

export function useSid(): string {
  return sid();
}

export function setSessionId(id: string): void {
  setSid(id);
}

export function sessionList(): Session[] {
  return sessions();
}

export async function loadSessions(): Promise<void> {
  try {
    setSessions(await api<Session[]>('/api/ai/sessions'));
  } catch {
    setSessions([]);
  }
}

export async function createSession(): Promise<Session> {
  const s = await api<Session>('/api/ai/sessions', { method: 'POST', body: JSON.stringify({ title: 'web' }) });
  setSid(s.id);
  await loadSessions();
  return s;
}
