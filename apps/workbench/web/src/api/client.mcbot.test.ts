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

describe('v0.8.0 mcbot API 客户端', () => {
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
    const snapshot = await api.mcbot.status()
    expect(lastCall().url).toBe('/api/mcbot/status')
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
    const history = await api.mcbot.history({
      kind: 'samples',
      from: '2026-10-26T08:00:00.000Z',
      to: '2026-10-27T08:00:00.000Z',
      limit: 100,
    })
    const url = new URL(lastCall().url, 'http://localhost')
    expect(url.pathname).toBe('/api/mcbot/history')
    expect(url.searchParams.get('kind')).toBe('samples')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('from')).toBe('2026-10-26T08:00:00.000Z')
    expect(history.samples?.[0]?.connected).toBe(true)
  })

  it('任务控制使用 POST 与 JSON body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: { ok: true } }))
    await api.mcbot.startTask('patrol')
    expect(lastCall().url).toBe('/api/mcbot/tasks')
    expect(lastCall().init.method).toBe('POST')
    expect(lastBody()).toEqual({ name: 'patrol' })

    await api.mcbot.stopTask()
    expect(lastCall().url).toBe('/api/mcbot/tasks/stop')
    expect(lastCall().init.method).toBe('POST')
    expect(lastBody()).toEqual({})

    await api.mcbot.resumeTask('task-1')
    expect(lastCall().url).toBe('/api/mcbot/tasks/resume')
    expect(lastBody()).toEqual({ taskId: 'task-1' })

    await api.mcbot.resumeTask()
    expect(lastBody()).toEqual({})

    await api.mcbot.move('follow', 'Antifield')
    expect(lastCall().url).toBe('/api/mcbot/move')
    expect(lastBody()).toEqual({ action: 'follow', target: 'Antifield' })

    await api.mcbot.move('home')
    expect(lastBody()).toEqual({ action: 'home' })

    await api.mcbot.say('晚上好')
    expect(lastCall().url).toBe('/api/mcbot/say')
    expect(lastBody()).toEqual({ message: '晚上好' })

    // 写操作附带 CSRF 头
    const headers = lastCall().init.headers as Record<string, string>
    expect(headers['X-CSRF-Token']).toBe('csrf-test-token')
  })

  it('mcbot_* 错误解析为中文兜底文案并保留状态码', async () => {
    const cases: Array<{ code: string; status: number; contains: string }> = [
      { code: 'mcbot_control_disabled', status: 503, contains: '控制未启用' },
      { code: 'mcbot_unavailable', status: 503, contains: '不可达' },
      { code: 'mcbot_auth_failed', status: 502, contains: 'Token 认证失败' },
      { code: 'mcbot_resume_pending', status: 409, contains: '可恢复任务' },
      { code: 'mcbot_resume_failed', status: 409, contains: '恢复失败' },
      { code: 'mcbot_queue_full', status: 409, contains: '队列已满' },
      { code: 'mcbot_task_disabled', status: 503, contains: '任务功能已关闭' },
      { code: 'mcbot_not_connected', status: 409, contains: '尚未连接' },
      { code: 'mcbot_rate_limited', status: 429, contains: '过于频繁' },
      { code: 'mcbot_invalid_request', status: 400, contains: '参数不合法' },
      { code: 'mcbot_disabled', status: 503, contains: '集成未启用' },
    ]
    for (const testCase of cases) {
      fetchMock.mockResolvedValue(
        mockResponse({ status: testCase.status, body: { error: { code: testCase.code } } }),
      )
      const error = await api.mcbot.stopTask().catch((caught: unknown) => caught)
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
        body: { error: { code: 'mcbot_task_active', message: 'mcbot 正在巡逻，请先停止任务' } },
      }),
    )
    const error = await api.mcbot.move('home').catch((caught: unknown) => caught)
    expect((error as ApiError).message).toBe('mcbot 正在巡逻，请先停止任务')
  })

  it('自主模式：GET 解包 autonomy、start/stop POST 目标与原因、错误码中文兜底', async () => {
    const snapshot = {
      enabled: true,
      active: true,
      state: 'running',
      goal: '收集小麦',
      startedAt: '2026-10-28T00:00:00.000Z',
      elapsedSec: 42,
      remainingSec: 600,
      toolCalls: 3,
      maxToolCalls: 12,
      lastAction: 'gather_wheat',
      lastReason: '需要食物',
      lastError: null,
      lastDecisionAt: '2026-10-28T00:00:00.000Z',
    }
    fetchMock.mockResolvedValue(mockResponse({ body: { autonomy: snapshot } }))
    const autonomy = await api.mcbot.autonomy()
    expect(lastCall().url).toBe('/api/mcbot/autonomy')
    expect(lastCall().init.method).toBe('GET')
    expect(autonomy?.state).toBe('running')
    expect(autonomy?.toolCalls).toBe(3)

    fetchMock.mockResolvedValue(mockResponse({ body: { ok: true, autonomy: snapshot } }))
    const started = await api.mcbot.startAutonomy('收集木材')
    expect(lastCall().url).toBe('/api/mcbot/autonomy/start')
    expect(lastCall().init.method).toBe('POST')
    expect(lastBody()).toEqual({ goal: '收集木材' })
    expect((lastCall().init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-test-token')
    expect(started.autonomy?.state).toBe('running')

    await api.mcbot.startAutonomy()
    expect(lastBody()).toEqual({})

    const stopped = await api.mcbot.stopAutonomy('用户急停')
    expect(lastCall().url).toBe('/api/mcbot/autonomy/stop')
    expect(lastBody()).toEqual({ reason: '用户急停' })
    expect(stopped.ok).toBe(true)

    await api.mcbot.stopAutonomy()
    expect(lastBody()).toEqual({})
  })

  it('自主模式错误码使用中文兜底文案并保留状态码', async () => {
    const cases: Array<{ code: string; status: number; contains: string }> = [
      { code: 'mcbot_autonomy_disabled', status: 503, contains: '自主模式未启用' },
      { code: 'mcbot_autonomy_busy', status: 409, contains: '正在运行' },
      { code: 'mcbot_autonomy_unavailable', status: 503, contains: '自主模式不可用' },
    ]
    for (const testCase of cases) {
      fetchMock.mockResolvedValue(
        mockResponse({ status: testCase.status, body: { error: { code: testCase.code } } }),
      )
      const error = await api.mcbot.startAutonomy().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(testCase.status)
      expect((error as ApiError).code).toBe(testCase.code)
      expect((error as ApiError).message).toContain(testCase.contains)
    }
  })

  it('/api/version 透传 mcbot 功能开关（旧服务端缺失时保持 undefined）', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ body: { version: '0.8.0', mcbotEnabled: true, mcbotControlEnabled: false } }),
    )
    const version = await api.getVersion()
    expect(version.version).toBe('0.8.0')
    expect(version.mcbotEnabled).toBe(true)
    expect(version.mcbotControlEnabled).toBe(false)
  })
})
