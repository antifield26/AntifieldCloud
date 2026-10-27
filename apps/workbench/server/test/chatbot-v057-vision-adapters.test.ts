/**
 * QQ 入站图片下载测试：loadImage 的域名后缀白名单、mime 白名单、大小上限与固定错误码。
 * 下载只在内存返回 Buffer（不落盘）；全部使用注入 fetch 与二进制夹具，不访问真实 QQ 网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { QqAdapter } from '../src/chatbot/adapters/qq.ts'
import { ChatbotPlatformError } from '../src/chatbot/adapters/http.ts'
import type { ChatbotInboundImage } from '../src/chatbot/types.ts'

interface Captured {
  url: string
  init?: RequestInit
}

type FetchHandler = (url: string, init?: RequestInit) => Response

function binaryResponse(data: string, contentLength = Buffer.byteLength(data)): Response {
  return new Response(Buffer.from(data), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(contentLength) },
  })
}

function makeFetch(handler: FetchHandler) {
  const captured: Captured[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl: fetchImpl as typeof fetch, captured }
}

const APP_SECRET = 'qq-image-download-app-secret-fixed-01'

function adapterFor(fetchImpl?: typeof fetch): QqAdapter {
  return new QqAdapter({ appId: '102345901' }, { token: APP_SECRET }, { fetch: fetchImpl })
}

function imageAt(url: string, overrides: Partial<ChatbotInboundImage> = {}): ChatbotInboundImage {
  return { ref: url, mime: 'image/png', ...overrides }
}

function assertPlatformError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ChatbotPlatformError)
  assert.equal((error as ChatbotPlatformError).code, code)
  // 错误信息只含固定码，不泄露 URL 或 AppSecret。
  const message = (error as ChatbotPlatformError).message
  assert.ok(!message.includes('http'))
  assert.ok(!message.includes(APP_SECRET))
  return true
}

test('QQ loadImage：允许 qpic.cn/qq.com/qq.com.cn/gtimg.cn 后缀并提供原始字节', async () => {
  const { fetchImpl, captured } = makeFetch(() => binaryResponse('PNGDATA'))
  const adapter = adapterFor(fetchImpl)

  const qpic = await adapter.loadImage(
    imageAt('https://gchat.qpic.cn/gchatpic_new/0/0-0-abc/0?term=2', { size: 7 }),
    { maxBytes: 1024 },
  )
  assert.equal(qpic.mime, 'image/png')
  assert.equal(qpic.data.toString('utf8'), 'PNGDATA')
  assert.equal(captured[0]?.url, 'https://gchat.qpic.cn/gchatpic_new/0/0-0-abc/0?term=2')
  assert.equal(captured[0]?.init?.method, 'GET')
  assert.equal(captured[0]?.init?.redirect, 'error')

  const qq = await adapter.loadImage(imageAt('https://img.a.qq.com/x.png'), { maxBytes: 1024 })
  assert.equal(qq.data.toString('utf8'), 'PNGDATA')

  // QQ 富媒体新图床：multimedia.nt.qq.com.cn 由 '.qq.com.cn' 后缀命中。
  const multimedia = await adapter.loadImage(
    imageAt('https://multimedia.nt.qq.com.cn/download?appid=1&fileid=abc', { mime: 'image/jpeg' }),
    { maxBytes: 1024 },
  )
  assert.equal(multimedia.mime, 'image/jpeg')
  assert.equal(
    captured.at(-1)?.url,
    'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=abc',
  )

  const gtimg = await adapter.loadImage(imageAt('https://img.gtimg.cn/x.jpg', { mime: 'image/jpeg' }), {
    maxBytes: 1024,
  })
  assert.equal(gtimg.mime, 'image/jpeg')

  // 不带 Token/Authorization：QQ CDN 图片是平台侧 URL。
  const headers = (captured[0]?.init?.headers ?? {}) as Record<string, string>
  assert.equal(headers.authorization, undefined)
})

test('QQ loadImage：非白名单主机与 http URL 一律 image_unsupported，且不发请求', async () => {
  const { fetchImpl, captured } = makeFetch(() => binaryResponse('X'))
  const adapter = adapterFor(fetchImpl)
  const rejected = [
    'https://evil.example.com/x.png',
    'https://qq.com.evil.example/x.png',
    'https://evilqq.com/x.png',
    'https://qq.com.cn.evil.example/x.png',
    'https://multimedia.nt.qq.example.com/x.png',
    'http://gchat.qpic.cn/x.png',
    'not-a-url',
  ]
  for (const ref of rejected) {
    await assert.rejects(
      () => adapter.loadImage(imageAt(ref), { maxBytes: 1024 }),
      (error) => assertPlatformError(error, 'image_unsupported'),
    )
  }
  assert.equal(captured.length, 0)
})

test('QQ loadImage：mime 白名单外直接拒绝且不发请求', async () => {
  const { fetchImpl, captured } = makeFetch(() => binaryResponse('X'))
  const adapter = adapterFor(fetchImpl)
  for (const mime of ['image/bmp', 'application/pdf', 'text/plain', '']) {
    await assert.rejects(
      () => adapter.loadImage(imageAt('https://gchat.qpic.cn/x.bmp', { mime }), { maxBytes: 1024 }),
      (error) => assertPlatformError(error, 'image_unsupported'),
    )
  }
  assert.equal(captured.length, 0)
})

test('QQ loadImage：声明大小、响应头与实际字节超限都返回 image_too_large', async () => {
  // 平台声明大小超限：不发请求。
  const declared = makeFetch(() => binaryResponse('X'))
  await assert.rejects(
    () =>
      adapterFor(declared.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png', { size: 4096 }), {
        maxBytes: 1024,
      }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )
  assert.equal(declared.captured.length, 0)

  // content-length 超限。
  const header = makeFetch(() => binaryResponse('X', 4096))
  await assert.rejects(
    () => adapterFor(header.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )

  // content-length 缺失但实际字节超限。
  const actual = makeFetch(() => new Response(Buffer.from('X'.repeat(4096)), { status: 200 }))
  await assert.rejects(
    () => adapterFor(actual.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )
})

test('QQ loadImage：网络失败/非 200/空响应/超时统一 image_download_failed', async () => {
  const offline = makeFetch(() => {
    throw new Error('connect ETIMEDOUT')
  })
  await assert.rejects(
    () => adapterFor(offline.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_download_failed'),
  )

  const notOk = makeFetch(() => new Response('forbidden', { status: 403 }))
  await assert.rejects(
    () => adapterFor(notOk.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_download_failed'),
  )

  const empty = makeFetch(() => binaryResponse(''))
  await assert.rejects(
    () => adapterFor(empty.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_download_failed'),
  )

  // 超时：AbortSignal 触发后按下载失败处理（固定错误码，不透出底层异常）。
  const timeout = makeFetch(() => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  })
  await assert.rejects(
    () =>
      adapterFor(timeout.fetchImpl).loadImage(imageAt('https://gchat.qpic.cn/x.png'), {
        maxBytes: 1024,
        timeoutMs: 1,
      }),
    (error) => assertPlatformError(error, 'image_download_failed'),
  )
})

test('QQ loadImage：返回的 Buffer 是独立副本，调用方修改不影响后续结果', async () => {
  const { fetchImpl } = makeFetch(() => binaryResponse('DATA'))
  const adapter = adapterFor(fetchImpl)
  const first = await adapter.loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 })
  first.data[0] = 0x00
  const second = await adapter.loadImage(imageAt('https://gchat.qpic.cn/x.png'), { maxBytes: 1024 })
  assert.equal(second.data.toString('utf8'), 'DATA')
})
