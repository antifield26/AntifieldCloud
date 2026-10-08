// OpenCode 薄适配器（v2 专版）—— 本文件是调用 OpenCode 的唯一边界。
// 其他文件禁止直连 OpenCode HTTP 端口，违者视为 bug。
// 实测基线（2.0.24，见 docs/RESEARCH.md §9 / docs/opencode-openapi.json）：
//   健康 GET /api/info -> {version,...}；无 basic-auth 返回 401 JSON
//   事件 GET /api/event（SSE，首帧 server.connected， envelope {id,type,data{sessionID?}}）
//   会话 GET/POST /api/session（包络 {data}），DELETE/GET/PATCH /api/session/{id}
//   下发 POST /api/session/{id}/prompt {text}（required）-> {data:{...user msg}}
//   中断 POST /api/session/{id}/interrupt
//   终端事件：session.execution.finished / session.idle / session.error

export interface OpenCodeVersion {
  healthy: boolean;
  version: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  status?: string;
}

export interface SendParts {
  parts: Array<{ type: 'text'; text: string }>;
  model?: string;
  agent?: string;
}

export interface IOpenCodeAdapter {
  health(): Promise<OpenCodeVersion>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(title?: string, model?: string, agent?: string): Promise<SessionSummary>;
  /** 下发 prompt 不等待（回执即返），进度经 messages() 轮询。 */
  promptOnly(sessionId: string, text: string): Promise<unknown>;
  /** 下发 prompt + 订阅 /api/event，按 sessionID 过滤后回调；执行结束/出错时 resolve/reject。 */
  sendMessage(sessionId: string, input: SendParts, onEvent: (ev: unknown) => void): Promise<void>;
  messages(sessionId: string): Promise<unknown>;
  abortSession(sessionId: string): Promise<boolean>;
}

interface AdapterOpts {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

const TERMINAL_TYPES = new Set([
  'session.execution.finished',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.idle',
  'session.error',
]);

export function createAdapter(opts: AdapterOpts): IOpenCodeAdapter {
  const { baseUrl, username, password } = opts;
  const fetchFn = opts.fetchImpl ?? fetch;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const headers = { authorization: auth, 'content-type': 'application/json' };

  const req = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`opencode auth failed: ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`opencode ${method} ${path}: ${res.status}`);
    }
    return res;
  };

  const unwrapList = (json: unknown): SessionSummary[] => {
    const data = (json as { data: Array<Record<string, unknown>> }).data ?? [];
    return data.map((s) => ({
      id: String(s.id),
      title: String(s.title ?? ''),
      updatedAt: String((s.time as Record<string, unknown> | undefined)?.updated ?? ''),
    }));
  };

  return {
    async health(): Promise<OpenCodeVersion> {
      const res = await req('GET', '/api/info');
      const json = (await res.json()) as { version: string };
      return { healthy: true, version: json.version };
    },

    async listSessions(): Promise<SessionSummary[]> {
      const res = await req('GET', '/api/session');
      return unwrapList(await res.json());
    },

    async createSession(title?: string, model?: string, agent?: string): Promise<SessionSummary> {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (model !== undefined) body.model = model;
      if (agent !== undefined) body.agent = agent;
      const res = await req('POST', '/api/session', body);
      const json = (await res.json()) as { data: Record<string, unknown> };
      const s = json.data;
      return {
        id: String(s.id),
        title: String(s.title ?? ''),
        updatedAt: String((s.time as Record<string, unknown> | undefined)?.updated ?? ''),
      };
    },

    async promptOnly(sessionId: string, text: string): Promise<unknown> {
      const res = await req('POST', `/api/session/${sessionId}/prompt`, { text });
      return res.json();
    },

    async messages(sessionId: string): Promise<unknown> {
      const res = await req('GET', `/api/session/${sessionId}/message`);
      return res.json();
    },

    async sendMessage(sessionId: string, input: SendParts, onEvent: (ev: unknown) => void): Promise<void> {
      const streamRes = await fetchFn(`${baseUrl}/api/event`, {
        headers: { authorization: auth, accept: 'text/event-stream' },
      });
      if (streamRes.body === null || streamRes.status !== 200) {
        throw new Error(`opencode SSE connect failed: ${streamRes.status}`);
      }
      const text = input.parts.map((p) => p.text).join('\n');
      const promptRes = await req('POST', `/api/session/${sessionId}/prompt`, { text });
      await promptRes.arrayBuffer().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const reader = streamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const timer = setTimeout(() => {
          void reader.cancel().catch(() => undefined);
          reject(new Error('opencode sendMessage timeout (10m)'));
        }, 10 * 60 * 1000);
        const finish = (fn: () => void): void => {
          clearTimeout(timer);
          void reader.cancel().catch(() => undefined);
          fn();
        };
        const handleFrame = (frame: string): void => {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line === undefined || line.includes(': heartbeat')) return;
          let ev: { type?: string; data?: { sessionID?: string } };
          try {
            ev = JSON.parse(line.slice(5).trim()) as typeof ev;
          } catch {
            return;
          }
          if (ev.data?.sessionID !== undefined && ev.data.sessionID !== sessionId) return;
          onEvent(ev);
          if (ev.type !== undefined && TERMINAL_TYPES.has(ev.type)) {
            finish(() => (ev.type === 'session.error' ? reject(new Error('opencode session.error')) : resolve()));
          }
        };
        const pump = async (): Promise<void> => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let idx = buf.indexOf('\n\n');
              while (idx >= 0) {
                handleFrame(buf.slice(0, idx));
                buf = buf.slice(idx + 2);
                idx = buf.indexOf('\n\n');
              }
            }
            finish(() => resolve());
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
        };
        void pump();
      });
    },

    async abortSession(sessionId: string): Promise<boolean> {
      const res = await req('POST', `/api/session/${sessionId}/interrupt`);
      return res.ok;
    },
  };
}
