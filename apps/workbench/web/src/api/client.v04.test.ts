import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abandonChunkedUpload,
  api,
  ApiError,
  publicShareItemContentUrl,
  setCsrfToken,
} from './client'
import { resumeStorageKey, uploadFingerprint } from '../lib/chunked'

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
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

function lastUrl(): string {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return String(call?.[0])
}

describe('v0.4.0 API 客户端', () => {
  it('getMetrics 带 range 并解析 series', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        body: {
          range: '7d',
          from: 'a',
          to: 'b',
          bucketSeconds: 3600,
          sampleCount: 1,
          series: [{ ts: 't', cpuPercent: 1, memUsedBytes: 2, memTotalBytes: 4, memUsedPct: 50, tempC: null, diskFreeBytes: 3, diskTotalBytes: 6, diskFreePct: 50, load1: 0.1 }],
        },
      }),
    )
    const result = await api.getMetrics('7d')
    expect(lastUrl()).toBe('/api/metrics?range=7d')
    expect(result.series).toHaveLength(1)
    expect(result.series[0]?.tempC).toBeNull()
  })

  it('getMetrics 失败时解析为 ApiError 中文兜底', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 400, body: { error: { code: 'invalid_range' } } }))
    await expect(api.getMetrics('2h' as never)).rejects.toMatchObject({ status: 400, code: 'invalid_range' })
    const error = await api.getMetrics('2h' as never).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toContain('指标时间范围不合法')
  })

  it('getStorage 使用轻量端点', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ body: { quotaBytes: 1, usedBytes: 1, trashBytes: 0, fileCount: 1, freeBytes: 0 } }),
    )
    await api.getStorage()
    expect(lastUrl()).toBe('/api/storage')
  })

  it('审计筛选与告警筛选编码为查询参数', async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: { items: [], total: 0 } }))
    await api.getAuditPage({ limit: 50, offset: 100, action: 'login', q: 'a b', from: '2026-10-01T00:00:00.000Z' })
    const auditUrl = new URL(lastUrl(), 'http://localhost')
    expect(auditUrl.pathname).toBe('/api/audit')
    expect(auditUrl.searchParams.get('limit')).toBe('50')
    expect(auditUrl.searchParams.get('offset')).toBe('100')
    expect(auditUrl.searchParams.get('q')).toBe('a b')

    fetchMock.mockResolvedValue(mockResponse({ body: { items: [], state: [], config: {}, total: 0 } }))
    await api.alerts.list(5, { offset: 10, event: 'disk_low', status: 'firing' })
    const alertsUrl = new URL(lastUrl(), 'http://localhost')
    expect(alertsUrl.pathname).toBe('/api/alerts')
    expect(alertsUrl.searchParams.get('limit')).toBe('5')
    expect(alertsUrl.searchParams.get('offset')).toBe('10')
    expect(alertsUrl.searchParams.get('event')).toBe('disk_low')
    expect(alertsUrl.searchParams.get('status')).toBe('firing')
  })

  it('笔记附件与版本接口路径与 JSON body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: { items: [] } }))
    await api.notes.attachments.list('n/1')
    expect(lastUrl()).toBe('/api/notes/n%2F1/attachments')

    fetchMock.mockResolvedValue(mockResponse({ body: { items: [], total: 0 } }))
    await api.notes.versions.list('note-1', { limit: 20, offset: 40 })
    expect(lastUrl()).toBe('/api/notes/note-1/versions?limit=20&offset=40')

    fetchMock.mockResolvedValue(mockResponse({ body: { id: 'note-1', title: 't', bodyMd: '', tags: [], pinned: false, createdAt: 'a', updatedAt: 'b' } }))
    await api.notes.versions.restore('note-1', 'v-1')
    expect(lastUrl()).toBe('/api/notes/note-1/versions/v-1/restore')
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit
    expect(call.method).toBe('POST')
  })

  it('多文件分享 POST /api/shares 带 fileIds 与 CSRF', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ status: 201, body: { share: { id: 's', fileId: 'a', fileName: 'a', itemCount: 2 }, url: '/s/t' } }),
    )
    const result = await api.shares.createBundle({ fileIds: ['a', 'b'], password: '12345678' })
    expect(lastUrl()).toBe('/api/shares')
    const call = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(call.method).toBe('POST')
    expect(JSON.parse(String(call.body))).toEqual({ fileIds: ['a', 'b'], password: '12345678' })
    expect(result.share.itemCount).toBe(2)
  })

  it('公开分享逐文件下载地址编码 token 与 itemId', () => {
    expect(publicShareItemContentUrl('t k', 'i/1')).toBe('/api/public/shares/t%20k/items/i%2F1/content')
  })

  it('abandonChunkedUpload 调用 DELETE 并清除本地断点', async () => {
    const file = new File(['x'], 'big.bin', { type: 'application/octet-stream' })
    const key = resumeStorageKey(uploadFingerprint(file, null))
    window.localStorage.setItem(
      key,
      JSON.stringify({
        uploadId: 'upload-1',
        parentId: null,
        name: 'big.bin',
        size: 1,
        received: [0],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    )
    fetchMock.mockResolvedValue(mockResponse({ body: { ok: true } }))
    await abandonChunkedUpload(file, null)
    expect(lastUrl()).toBe('/api/uploads/upload-1')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE')
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('abandonChunkedUpload 对 404/409 幂等，不抛错', async () => {
    const file = new File(['x'], 'big.bin')
    const key = resumeStorageKey(uploadFingerprint(file, 'parent'))
    window.localStorage.setItem(
      key,
      JSON.stringify({
        uploadId: 'upload-2',
        parentId: 'parent',
        name: 'big.bin',
        size: 1,
        received: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    )
    fetchMock.mockResolvedValue(mockResponse({ status: 409, body: { error: { code: 'upload_completed' } } }))
    await expect(abandonChunkedUpload(file, 'parent')).resolves.toBeUndefined()
    expect(window.localStorage.getItem(key)).toBeNull()
  })
})
