/**
 * v0.6.1：Bot 连续消息合并/串行与 SearXNG 联网搜索（全部进程内夹具，不访问真实 QQ/OpenCode/SearXNG）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BurstMerger } from '../src/bot/burst.ts'
import {
  formatSearchSources,
  needsWebSearch,
  SearxngSearchClient,
  type WebSearchResult,
} from '../src/bot/search.ts'
import { createQqServiceFixture, c2cWebhook, sendWebhook, lastMessageText } from './bot-qq-fixtures.ts'

const SEARCH_RESULTS: WebSearchResult[] = [
  {
    title: 'AI 新闻示例',
    url: 'https://example.com/news/ai',
    snippet: '今天发布的 AI 新闻摘要。',
    domain: 'example.com',
  },
  {
    title: '第二来源',
    url: 'https://news.example.org/item',
    snippet: '另一条结果。',
    domain: 'news.example.org',
  },
]

test('BurstMerger：同一 key 合并、不同 key 分开，处理期间严格串行', async () => {
  const calls: Array<{ key: string; values: number[] }> = []
  const firstGate: { release: () => void } = { release: () => undefined }
  const firstWait = new Promise<void>((resolve) => {
    firstGate.release = resolve
  })
  const merger = new BurstMerger<{ value: number }>({
    windowMs: 50,
    maxWaitMs: 200,
    maxItems: 10,
    onFlush: async (key, items) => {
      calls.push({ key, values: items.map((item) => item.value) })
      if (calls.length === 1) await firstWait
    },
  })
  merger.enqueue('a', { value: 1 })
  merger.enqueue('a', { value: 2 })
  merger.enqueue('b', { value: 3 })
  const first = merger.flushAll()
  merger.enqueue('a', { value: 4 })
  firstGate.release()
  await first
  await merger.drain()
  assert.deepEqual(calls.find((call) => call.key === 'a')?.values, [1, 2])
  assert.deepEqual(calls.find((call) => call.key === 'b')?.values, [3])
  // a 的第二批必须在第一批完成后才执行。
  assert.deepEqual(calls.filter((call) => call.key === 'a').map((call) => call.values), [[1, 2], [4]])
})

test('SearXNG 客户端：参数、结果过滤/截断、来源只输出标题与域名', async () => {
  let captured = ''
  const client = new SearxngSearchClient({
    baseUrl: 'http://127.0.0.1:8888',
    timeoutMs: 2,
    maxResults: 2,
    language: 'zh-CN',
    safeSearch: true,
    maxSnippetChars: 20,
    engines: 'bing',
    fetchImpl: async (input) => {
      captured = String(input)
      return new Response(
        JSON.stringify({
          results: [
            { title: '标题一', url: 'https://example.com/a', content: '很长的摘要'.repeat(10), engine: 'x' },
            { title: '重复', url: 'https://example.com/a', content: '重复' },
            { title: '<b>标题二</b>', url: 'ftp://example.com/file', content: '协议不允许' },
            { title: '标题三', url: 'https://example.org/b', content: '有效摘要' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const results = await client.search('测试 查询')
  assert.match(captured, /q=%E6%B5%8B%E8%AF%95\+%E6%9F%A5%E8%AF%A2/)
  assert.match(captured, /format=json/)
  assert.match(captured, /safesearch=1/)
  assert.match(captured, /engines=bing/)
  assert.equal(results.length, 2)
  assert.equal(results[0]?.domain, 'example.com')
  assert.ok((results[0]?.snippet.length ?? 0) <= 20)
  assert.equal(results[1]?.domain, 'example.org')
  const sources = formatSearchSources(results)
  assert.match(sources, /标题一（example\.com）/)
  assert.equal(sources.includes('https://'), false)
})

test('自动搜索判断保守：时效/问句触发，普通闲聊不触发', () => {
  assert.equal(needsWebSearch('最近有什么 AI 新闻？'), true)
  assert.equal(needsWebSearch('今天天气怎么样'), true)
  assert.equal(needsWebSearch('帮我搜索一下 v0.6.1'), true)
  assert.equal(needsWebSearch('你好呀'), false)
  assert.equal(needsWebSearch('帮我写一段自我介绍'), false)
})

test('连续消息：同一用户快速三条只调用一次 AI，合并文本并只回复一次', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: {
      botChatBurstWindowMs: 200,
      botChatBurstMaxWaitMs: 1000,
      botChatBurstMaxMessages: 6,
    },
  })
  try {
    for (const [id, content] of [
      ['burst-1', '第一句'],
      ['burst-2', '第二句'],
      ['burst-3', '第三句'],
    ] as const) {
      const webhook = c2cWebhook(fixture.appSecret, { id, content })
      await fixture.service.handleWebhook(fixture.botId, webhook.headers, webhook.body)
    }
    await fixture.service.waitForIdle()
    assert.equal(fixture.aiCalls.length, 1)
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /第一句\n第二句\n第三句/)
    assert.equal(lastMessageText(fixture), 'AI 回复')
    // 三条入站事件最终都标记为 ok。
    const events = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM bot_events WHERE bot_id = ? AND outcome = 'ok'")
      .get(fixture.botId) as { c: number }
    assert.equal(events.c, 3)
  } finally {
    fixture.cleanup()
  }
})

test('联网搜索：自动触发把结果注入提示词，回答末尾附来源且不暴露完整 URL', async () => {
  const queries: string[] = []
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: {
      botChatBurstWindowMs: 0,
      botSearchEnabled: true,
      botSearchAuto: true,
    },
    search: {
      search: async (query) => {
        queries.push(query)
        return SEARCH_RESULTS
      },
    },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'search-auto-1', content: '最近有什么 AI 新闻？' }))
    assert.deepEqual(queries, ['最近有什么 AI 新闻？'])
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /\[联网搜索结果/)
    assert.match(prompt, /AI 新闻示例/)
    const reply = lastMessageText(fixture)
    assert.match(reply, /参考来源/)
    assert.match(reply, /AI 新闻示例（example\.com）/)
    assert.equal(reply.includes('https://'), false)
  } finally {
    fixture.cleanup()
  }
})

test('联网搜索：/search 强制搜索且对普通用户开放；未启用时明确提示', async () => {
  const queries: string[] = []
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botChatBurstWindowMs: 0, botSearchEnabled: true, botSearchAuto: false },
    search: {
      search: async (query) => {
        queries.push(query)
        return SEARCH_RESULTS
      },
    },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'search-cmd-1', content: '/search 测试关键词' }))
    assert.deepEqual(queries, ['测试关键词'])
    assert.equal(fixture.aiCalls.length, 1)
    assert.match(fixture.aiCalls[0]?.prompt ?? '', /\[联网搜索结果/)
    assert.match(lastMessageText(fixture), /参考来源/)
  } finally {
    fixture.cleanup()
  }

  const disabled = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botChatBurstWindowMs: 0, botSearchEnabled: false },
  })
  try {
    await sendWebhook(disabled, c2cWebhook(disabled.appSecret, { id: 'search-disabled-1', content: '/search 测试' }))
    assert.equal(disabled.aiCalls.length, 0)
    assert.match(lastMessageText(disabled), /联网搜索未启用/)
  } finally {
    disabled.cleanup()
  }
})

test('联网搜索失败不阻断 Chat：不附来源、不抛错；审计只记录错误码', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botChatBurstWindowMs: 0, botSearchEnabled: true, botSearchAuto: true },
    search: {
      search: async () => {
        throw new Error('searx down')
      },
    },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'search-fail-1', content: '今天有什么新闻？' }))
    assert.equal(fixture.aiCalls.length, 1)
    assert.equal(lastMessageText(fixture), 'AI 回复')
    assert.equal(lastMessageText(fixture).includes('参考来源'), false)
    const audit = fixture.audits.find((item) => item.action === 'bot.search')
    assert.ok(audit)
    assert.equal(audit.detail?.error, 'error')
  } finally {
    fixture.cleanup()
  }
})
