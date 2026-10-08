// 同源 API 封装：Key 不经前端，所有请求走 /api/*。
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Overview {
  ts: number;
  cpuPct: number | null;
  memUsedKb: number;
  memTotalKb: number;
  tempC: number | null;
  diskWrittenKb: number;
  journal: string;
}

export interface ServiceState {
  unit: string;
  actions: string[];
  state: string;
}

export interface Check {
  name: string;
  status: string;
  detail: string;
}
