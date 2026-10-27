// 分片上传断点恢复（v0.7.0 修复回归）：completed 会话直接结束、assembling 轮询、过期断点清理。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFileChunked } from './client'
import { resumeStorageKey, uploadFingerprint } from '../lib/chunked'

const CHUNK_SIZE = 8

type Call = { method: string; url: string }

class FakeXhr {
  static calls: Call[] = []
  status = 200
  responseText = '{"index":0,"received":1}'
  withCredentials = false
  responseType = ''
  timeout = 0
  upload = { onprogress: null as null | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) }
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  onabort: null | (() => void) = null
  ontimeout: null | (() => void) = null
  private method = 'GET'
  private url = ''

  open(method: string, url: string): void {
    this.method = method
    this.url = url
    FakeXhr.calls.push({ method, url })
  }
  setRequestHeader(): void {}
  send(): void {
    setTimeout(() => this.onload?.(), 0)
  }
  abort(): void {
    this.onabort?.()
  }
  getResponseHeader(): string | null {
    return null
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fileItem(id: string, name: string, size: number) {
  return {
    id,
    parentId: null,
    name,
    kind: 'file' as const,
    size,
    mime: 'application/octet-stream',
    sha256: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previewKind: 'none' as const,
    inlineAllowed: false,
  }
}

function storeResume(file: File, uploadId: string, expiresAt = new Date(Date.now() + 3_600_000).toISOString()): string {
  const key = resumeStorageKey(uploadFingerprint(file, null))
  window.localStorage.setItem(
    key,
    JSON.stringify({ uploadId, parentId: null, name: file.name, size: file.size, received: [], expiresAt }),
  )
  return key
}

describe('uploadFileChunked 断点恢复', () => {
  const file = new File([new Uint8Array(20)], 'big.bin')

  beforeEach(() => {
    window.localStorage.clear()
    FakeXhr.calls = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('status=completed 时用 fileId 直接结束，不重新 init/重传', async () => {
    const key = storeResume(file, 'old-upload')
    const fetchCalls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        fetchCalls.push({ method, url })
        if (method === 'GET' && url.includes('/api/uploads/old-upload')) {
          return jsonResponse({
            uploadId: 'old-upload',
            fileName: file.name,
            size: file.size,
            chunkSize: CHUNK_SIZE,
            totalChunks: 3,
            received: [0, 1, 2],
            missing: [],
            status: 'completed',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            fileId: 'FILE-DONE',
          })
        }
        if (method === 'GET' && url === '/api/files/FILE-DONE') {
          return jsonResponse({ item: fileItem('FILE-DONE', file.name, file.size), path: '/' })
        }
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )

    const result = await uploadFileChunked(file, null, { chunkSize: CHUNK_SIZE })

    expect(result.items[0]?.id).toBe('FILE-DONE')
    expect(fetchCalls.some((call) => call.method === 'POST' && call.url.endsWith('/api/uploads'))).toBe(false)
    expect(FakeXhr.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('status=assembling 时短暂轮询并最终用 fileId 结束', async () => {
    storeResume(file, 'assembling-upload')
    let statusCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/api/uploads/assembling-upload')) {
          statusCalls += 1
          const completed = statusCalls >= 2
          return jsonResponse({
            uploadId: 'assembling-upload',
            fileName: file.name,
            size: file.size,
            chunkSize: CHUNK_SIZE,
            totalChunks: 3,
            received: [0, 1, 2],
            missing: [],
            status: completed ? 'completed' : 'assembling',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            ...(completed ? { fileId: 'FILE-ASSEMBLED' } : {}),
          })
        }
        if (method === 'GET' && url === '/api/files/FILE-ASSEMBLED') {
          return jsonResponse({ item: fileItem('FILE-ASSEMBLED', file.name, file.size), path: '/' })
        }
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )

    const result = await uploadFileChunked(file, null, { chunkSize: CHUNK_SIZE })
    expect(result.items[0]?.id).toBe('FILE-ASSEMBLED')
    expect(statusCalls).toBeGreaterThanOrEqual(2)
  })

  it('过期断点直接丢弃并重新 init（不发恢复 status 请求）', async () => {
    const key = storeResume(file, 'expired-upload', new Date(Date.now() - 60_000).toISOString())
    const fetchCalls: Call[] = []
    FakeXhr.calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        fetchCalls.push({ method, url })
        if (method === 'POST' && url.endsWith('/api/uploads')) {
          return jsonResponse(
            {
              uploadId: 'new-upload',
              chunkSize: CHUNK_SIZE,
              totalChunks: 3,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              received: [],
            },
            201,
          )
        }
        if (method === 'POST' && url.endsWith('/complete')) {
          return jsonResponse({ ok: true, file: fileItem('FILE-NEW', file.name, file.size) })
        }
        throw new Error(`unexpected ${method} ${url}`)
      }),
    )

    const result = await uploadFileChunked(file, null, { chunkSize: CHUNK_SIZE })
    expect(result.items[0]?.id).toBe('FILE-NEW')
    expect(fetchCalls.some((call) => call.url.includes('expired-upload'))).toBe(false)
    expect(window.localStorage.getItem(key)).toBeNull()
  })
})
