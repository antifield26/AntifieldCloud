import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken, uploadFiles } from './client'

class FakeXhr {
  static latest: FakeXhr | null = null

  upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
  timeout = 0
  status = 0
  responseText = ''
  withCredentials = false
  responseType = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}

  constructor() {
    FakeXhr.latest = this
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  send(): void {
    // 测试内手动触发 ontimeout/onabort
  }

  abort(): void {
    this.onabort?.()
  }

  getResponseHeader(): string | null {
    return null
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
  FakeXhr.latest = null
})

describe('uploadFiles XHR 控制', () => {
  it('设置超时并在 ontimeout 时拒绝为 timeout', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    setCsrfToken('csrf-test')
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })
    const promise = uploadFiles([file], null, { timeoutMs: 1234 })
    const xhr = FakeXhr.latest
    expect(xhr).not.toBeNull()
    expect(xhr?.timeout).toBe(1234)
    expect(xhr?.headers['X-CSRF-Token']).toBe('csrf-test')
    xhr?.ontimeout?.()
    await expect(promise).rejects.toMatchObject({ code: 'timeout' })
  })

  it('AbortSignal 触发时中止请求并返回 aborted', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const controller = new AbortController()
    const file = new File(['x'], 'a.txt')
    const promise = uploadFiles([file], null, { signal: controller.signal })
    expect(FakeXhr.latest).not.toBeNull()
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
  })

  it('已 aborted 的 signal 不会发出请求', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const controller = new AbortController()
    controller.abort()
    const promise = uploadFiles([new File(['x'], 'a.txt')], null, { signal: controller.signal })
    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
    expect(FakeXhr.latest).toBeNull()
  })
})
