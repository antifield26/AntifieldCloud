import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, setCsrfToken } from './client'

interface MockResponseInit {
  status?: number
  body?: unknown
}

function mockResponse({ status = 200, body = {} }: MockResponseInit = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body === null ? '' : JSON.stringify(body)),
  } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  setCsrfToken('csrf-test-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return { url: String(call?.[0]), init: (call?.[1] ?? {}) as RequestInit }
}

function lastBody(): unknown {
  const body = lastCall().init.body
  return typeof body === 'string' ? JSON.parse(body) : null
}

describe('v0.8.0 Lofii API 客户端', () => {
  it('status 使用只读端点并解析快照字段', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        body: {
          enabled: true,
          reachable: true,
          stale: false,
          controlEnabled: true,
          alertsEnabled: true,
          version: '0.6.0',
          contractVersion: 1,
          eventsSupported: true,
          lastPollAt: '2026-10-27T08:00:00.000Z',
          error: null,
          status: { task: { active: false, state: 'idle', queue: [] } },
          events: [{ id: 'boot-1', type: 'chat', ts: '2026-10-27T08:00:00.000Z', data: { text: 'hi' } }],
        },
      }),
    )
    const snapshot = await api.lofii.status()
    expect(lastCall().url).toBe('/api/lofii/status')
    expect(lastCall().init.method).toBe('GET')
    expect(snapshot.eventsSupported).toBe(true)
    expect(snapshot.contractVersion).toBe(1)
    expect(snapshot.events).toHaveLength(1)
  })

  it('history 编码 kind/from/to/limit 并解析 samples/alerts 动态键', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        body: {
          kind: 'samples',
          from: '2026-10-26T08:00:00.000Z',
          to: '2026-10-27T08:00:00.000Z',
          count: 1,
          samples: [{ ts: '2026-10-27T07:59:00.000Z', connected: true, state: 'connected', queueLen: 0 }],
        },
      }),
    )
    const history = await api.lofii.history({
      kind: 'samples',
      from: '2026-10-26T08:00:00.000Z',
      to: '2026-10-27T08:00:00.000Z',
      limit: 100,
    })
    const url = new URL(lastCall().url, 'http://localhost')
    expect(url.pathname).toBe('/api/lofii/history')
    expect(url.searchParams.get('kind')).toBe('samples')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('from')).toBe('2026-10-26T08:00:00.000Z')
    expect(history.samples?.[0]?.connected).toBe(true)
  })

  it('任务控制使用 POST 与 JSON body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: { ok: true } }))
    await api.lofii.startTask('patrol')
    expect(lastCall().url).toBe('/api/lofii/tasks')
    expect(lastCall().init.method).toBe('POST')
    expect(lastBody()).toEqual({ name: 'patrol' })

    await api.lofii.stopTask()
    expect(lastCall().url).toBe('/api/lofii/tasks/stop')
    expect(lastCall().init.method).toBe('POST')
    expect(lastBody()).toEqual({})

    await api.lofii.resumeTask('task-1')
    expect(lastCall().url).toBe('/api/lofii/tasks/resume')
    expect(lastBody()).toEqual({ taskId: 'task-1' })

    await api.lofii.resumeTask()
    expect(lastBody()).toEqual({})

    await api.lofii.move('follow', 'Antifield')
    expect(lastCall().url).toBe('/api/lofii/move')
    expect(lastBody()).toEqual({ action: 'follow', target: 'Antifield' })

    await api.lofii.move('home')
    expect(lastBody()).toEqual({ action: 'home' })

    await api.lofii.say('晚上好')
    expect(lastCall().url).toBe('/api/lofii/say')
    expect(lastBody()).toEqual({ message: '晚上好' })

    // 写操作附带 CSRF 头
    const headers = lastCall().init.headers as Record<string, string>
    expect(headers['X-CSRF-Token']).toBe('csrf-test-token')
  })

  it('lofii_* 错误解析为中文兜底文案并保留状态码', async () => {
    const cases: Array<{ code: string; status: number; contains: string }> = [
      { code: 'lofii_control_disabled', status: 503, contains: '控制未启用' },
      { code: 'lofii_unavailable', status: 503, contains: '不可达' },
      { code: 'lofii_auth_failed', status: 502, contains: 'Token 认证失败' },
      { code: 'lofii_resume_pending', status: 409, contains: '可恢复任务' },
      { code: 'lofii_resume_failed', status: 409, contains: '恢复失败' },
      { code: 'lofii_queue_full', status: 409, contains: '队列已满' },
      { code: 'lofii_task_disabled', status: 503, contains: '任务功能已关闭' },
      { code: 'lofii_not_connected', status: 409, contains: '尚未连接' },
      { code: 'lofii_rate_limited', status: 429, contains: '过于频繁' },
      { code: 'lofii_invalid_request', status: 400, contains: '参数不合法' },
      { code: 'lofii_disabled', status: 503, contains: '集成未启用' },
    ]
    for (const testCase of cases) {
      fetchMock.mockResolvedValue(
        mockResponse({ status: testCase.status, body: { error: { code: testCase.code } } }),
      )
      const error = await api.lofii.stopTask().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(testCase.status)
      expect((error as ApiError).code).toBe(testCase.code)
      expect((error as ApiError).message).toContain(testCase.contains)
    }
  })

  it('服务端返回的 message 优先于本地兜底文案', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 409,
        body: { error: { code: 'lofii_task_active', message: 'Lofii 正在巡逻，请先停止任务' } },
      }),
    )
    const error = await api.lofii.move('home').catch((caught: unknown) => caught)
    expect((error as ApiError).message).toBe('Lofii 正在巡逻，请先停止任务')
  })

  it('/api/version 透传 Lofii 功能开关（旧服务端缺失时保持 undefined）', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ body: { version: '0.8.0', lofiiEnabled: true, lofiiControlEnabled: false } }),
    )
    const version = await api.getVersion()
    expect(version.version).toBe('0.8.0')
    expect(version.lofiiEnabled).toBe(true)
    expect(version.lofiiControlEnabled).toBe(false)
  })
})
