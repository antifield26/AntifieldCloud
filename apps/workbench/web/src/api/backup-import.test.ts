import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken, uploadBackupArchive } from './client'

class FakeXhr {
  static latest: FakeXhr | null = null

  upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
  timeout = 0
  status = 0
  responseText = ''
  withCredentials = false
  responseType = ''
  body: FormData | null = null
  headers: Record<string, string> = {}
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null

  constructor() {
    FakeXhr.latest = this
  }

  open(): void {
    // 测试不关心 method/url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  send(form: FormData): void {
    this.body = form
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

describe('uploadBackupArchive', () => {
  it('使用 multipart file 字段并携带 CSRF 与 X-TOTP-Code 头', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    setCsrfToken('csrf-test')
    const file = new File(['x'], 'snapshot-a-full.tar.gz', { type: 'application/gzip' })
    const promise = uploadBackupArchive(file, '123456', { timeoutMs: 5000 })
    const xhr = FakeXhr.latest
    expect(xhr).not.toBeNull()
    expect(xhr?.timeout).toBe(5000)
    expect(xhr?.headers['X-CSRF-Token']).toBe('csrf-test')
    expect(xhr?.headers['X-TOTP-Code']).toBe('123456')
    expect((xhr?.body?.get('file') as File | null)?.name).toBe('snapshot-a-full.tar.gz')

    xhr!.status = 201
    xhr!.responseText = JSON.stringify({
      archive: { id: 'snapshot-a-full.tar.gz', name: 'snapshot-a-full.tar.gz', mode: 'full' },
      verify: { ok: true },
    })
    xhr!.onload?.()
    await expect(promise).resolves.toMatchObject({
      archive: { name: 'snapshot-a-full.tar.gz' },
      verify: { ok: true },
    })
  })

  it('413/409 错误解析为 ApiError', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const file = new File(['x'], 'snapshot-a-full.tar.gz')
    const promise = uploadBackupArchive(file, '123456')
    const xhr = FakeXhr.latest!
    xhr.status = 413
    xhr.responseText = JSON.stringify({ error: { code: 'file_too_large', message: '归档超过限制' } })
    xhr.onload?.()
    await expect(promise).rejects.toMatchObject({ status: 413, code: 'file_too_large' })
  })

  it('signal 取消与超时映射', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const controller = new AbortController()
    const promise = uploadBackupArchive(new File(['x'], 'snapshot-a.tar.gz'), '123456', {
      signal: controller.signal,
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'aborted' })

    const timeoutPromise = uploadBackupArchive(new File(['x'], 'snapshot-a.tar.gz'), '123456')
    FakeXhr.latest?.ontimeout?.()
    await expect(timeoutPromise).rejects.toMatchObject({ code: 'timeout' })
  })
})
