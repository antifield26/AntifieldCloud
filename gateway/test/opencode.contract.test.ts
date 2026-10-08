// 适配器契约测试：mock OpenCode v2 HTTP（含 SSE），不断真实 serve。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAdapter } from '../src/opencode/adapter.js';

function startMock(): Promise<{ url: string; close: () => Promise<void>; seen: { auth: string[]; prompts: string[] } }> {
  const seen = { auth: [] as string[], prompts: [] as string[] };
  const server = createServer((req, res) => {
    seen.auth.push(req.headers.authorization ?? '');
    if (req.url === '/api/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '2.0.24', pid: 1, urls: [], paths: {}, capabilities: {} }));
      return;
    }
    if (req.url === '/api/session' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'ses_mock', title: 't', time: { updated: 1 } }] }));
      return;
    }
    if (req.url === '/api/session' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'ses_new', title: 'n', time: { updated: 2 } } }));
      return;
    }
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('data: {"id":"e0","type":"server.connected","data":{}}\n\n');
      const t = setTimeout(() => {
        res.write('data: {"id":"e1","type":"session.execution.finished","data":{"sessionID":"ses_new"}}\n\n');
      }, 50);
      req.on('close', () => clearTimeout(t));
      return;
    }
    if (req.url === '/api/session/ses_new/prompt' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.prompts.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'msg_1', sessionID: 'ses_new' } }));
      });
      return;
    }
    if (req.url === '/api/session/ses_new/interrupt' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { sessionID: 'ses_new' } }));
      return;
    }
    if (req.url === '/api/session/ses_new/message' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'msg_1', type: 'user' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), seen });
    });
  });
}

void describe('adapter contract (v2)', () => {
  void it('health/list/create carry basic auth, unwrap {data}', async () => {
    const mock = await startMock();
    try {
      const a = createAdapter({ baseUrl: mock.url, username: 'opencode', password: 'pw' });
      const h = await a.health();
      assert.equal(h.version, '2.0.24');
      assert.equal(h.healthy, true);
      const list = await a.listSessions();
      assert.equal(list[0].id, 'ses_mock');
      const created = await a.createSession('n');
      assert.equal(created.id, 'ses_new');
      assert.ok(mock.seen.auth.every((v) => v === 'Basic b3BlbmNvZGU6cHc='));
    } finally {
      await mock.close();
    }
  });

  void it('sendMessage: prompt {text} + SSE finished resolves', async () => {
    const mock = await startMock();
    try {
      const a = createAdapter({ baseUrl: mock.url, username: 'opencode', password: 'pw' });
      const got: unknown[] = [];
      await a.sendMessage('ses_new', { parts: [{ type: 'text', text: 'hi' }] }, (ev) => got.push(ev));
      assert.equal(mock.seen.prompts.length, 1);
      assert.deepEqual(JSON.parse(mock.seen.prompts[0]), { text: 'hi' });
      assert.ok(got.some((e) => (e as { type: string }).type === 'session.execution.finished'));
    } finally {
      await mock.close();
    }
  });

  void it('abortSession posts interrupt', async () => {
    const mock = await startMock();
    try {
      const a = createAdapter({ baseUrl: mock.url, username: 'opencode', password: 'pw' });
      assert.equal(await a.abortSession('ses_new'), true);
      const receipt = (await a.promptOnly('ses_new', 'hi')) as { data: { id: string } };
      assert.equal(receipt.data.id, 'msg_1');
      const msgs = (await a.messages('ses_new')) as { data: Array<{ id: string }> };
      assert.equal(msgs.data[0].id, 'msg_1');
    } finally {
      await mock.close();
    }
  });
});
