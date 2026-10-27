// 诊断面板测试：事件元数据/筛选/分页、最近错误与脱敏提示；不依赖真实服务端。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  ChatbotDelivery,
  ChatbotEventItem,
  ChatbotPublishJob,
  ChatbotSummary,
} from '../../api/types'
import { ToastProvider } from '../Toast'
import { ChatbotDiagnosticsPanel } from './ChatbotDiagnosticsPanel'

const mocks = vi.hoisted(() => ({
  events: vi.fn(),
  deliveriesList: vi.fn(),
  publishList: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    chatbots: {
      events: mocks.events,
      deliveries: { list: mocks.deliveriesList },
      publish: { list: mocks.publishList },
    },
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

function chatbot(overrides: Partial<ChatbotSummary> = {}): ChatbotSummary {
  return {
    id: 'chatbot-1',
    platform: 'qq',
    name: '告警 Chatbot',
    enabled: true,
    config: { appId: '102123456' },
    webhookUrl: 'https://app.example.com/api/chatbot/webhook/chatbot-1',
    setupSteps: [],
    targetsCount: 1,
    lastError: null,
    lastCheckedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    keyVersion: 1,
    ...overrides,
  }
}

function eventItem(overrides: Partial<ChatbotEventItem> = {}): ChatbotEventItem {
  return {
    eventId: 'evt-1',
    kind: 'command',
    outcome: 'rate_limited',
    detail: '每用户限流',
    targetExternalId: '68611590B477339A04302BB23B426244',
    userId: 'user-9',
    receivedAt: '2026-10-22T01:00:00.000Z',
    updatedAt: null,
    ...overrides,
  }
}

function delivery(overrides: Partial<ChatbotDelivery> = {}): ChatbotDelivery {
  return {
    id: 'delivery-1',
    chatbotId: 'chatbot-1',
    targetId: 'target-1',
    kind: 'notification',
    status: 'failed',
    attempts: 2,
    nextAttemptAt: null,
    lastError: 'QQ API 401 Unauthorized',
    lastErrorHint: 'AppSecret 可能已失效，请重新录入',
    externalId: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

function job(overrides: Partial<ChatbotPublishJob> = {}): ChatbotPublishJob {
  return {
    id: 'job-1',
    chatbotId: 'chatbot-1',
    targetId: 'target-1',
    text: '发布内容测试',
    scheduledAt: null,
    status: 'failed',
    attempts: 1,
    lastError: '发布内容为空',
    lastErrorHint: '请检查发布内容',
    createdAt: '2026-10-21T02:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

function renderPanel(refreshToken = 0) {
  return render(
    <ToastProvider>
      <ChatbotDiagnosticsPanel chatbot={chatbot()} refreshToken={refreshToken} />
    </ToastProvider>,
  )
}

beforeEach(() => {
  mocks.events.mockResolvedValue({ items: [eventItem()], total: 1 })
  mocks.deliveriesList.mockResolvedValue([])
  mocks.publishList.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChatbotDiagnosticsPanel 诊断', () => {
  it('渲染事件元数据与结果徽标，不展示消息正文', async () => {
    // 事件契约不含正文；额外注入 text 字段确认页面不会渲染任何正文文本。
    mocks.events.mockResolvedValue({
      items: [{ ...eventItem(), text: '消息正文-绝密' }],
      total: 1,
    })
    renderPanel()

    // Table 同时渲染桌面表格与移动端卡片，文本会出现两次。
    expect(await screen.findAllByText('command')).not.toHaveLength(0)
    expect(screen.getAllByText('限流').length).toBeGreaterThan(0)
    expect(screen.getAllByTitle('68611590B477339A04302BB23B426244').length).toBeGreaterThan(0)
    expect(screen.getAllByText('每用户限流').length).toBeGreaterThan(0)
    expect(screen.getByText(/不展示消息正文/)).toBeTruthy()
    expect(screen.queryByText(/消息正文-绝密/)).toBeNull()
    expect(document.body.textContent).not.toContain('消息正文-绝密')
    // 无失败记录时的空态
    expect(await screen.findByText('最近没有失败记录')).toBeTruthy()
  })

  it('筛选时间范围/结果回到第一页并携带参数，分页按 offset 请求', async () => {
    mocks.events.mockResolvedValue({ items: [eventItem()], total: 25 })
    renderPanel()

    expect(await screen.findByText('第 1 / 2 页 · 共 25 条')).toBeTruthy()
    expect(mocks.events).toHaveBeenLastCalledWith('chatbot-1', {
      hours: 24,
      outcome: undefined,
      limit: 20,
      offset: 0,
    })

    await userEvent.selectOptions(screen.getByLabelText('事件时间范围'), '168')
    await waitFor(() =>
      expect(mocks.events).toHaveBeenLastCalledWith(
        'chatbot-1',
        expect.objectContaining({ hours: 168, offset: 0 }),
      ),
    )

    await userEvent.selectOptions(screen.getByLabelText('事件结果筛选'), 'denied')
    await waitFor(() =>
      expect(mocks.events).toHaveBeenLastCalledWith(
        'chatbot-1',
        expect.objectContaining({ outcome: 'denied', hours: 168 }),
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: '下一页事件' }))
    await waitFor(() =>
      expect(mocks.events).toHaveBeenLastCalledWith(
        'chatbot-1',
        expect.objectContaining({ outcome: 'denied', hours: 168, offset: 20 }),
      ),
    )
    expect(await screen.findByText('第 2 / 2 页 · 共 25 条')).toBeTruthy()
  })

  it('最近错误展示原文与中文提示，且不包含已成功记录', async () => {
    mocks.deliveriesList.mockResolvedValue([
      delivery(),
      delivery({ id: 'delivery-2', status: 'sent', lastError: null, lastErrorHint: null }),
      delivery({ id: 'delivery-3', status: 'dead', lastError: '网络超时', lastErrorHint: null }),
    ])
    mocks.publishList.mockResolvedValue([
      job(),
      job({ id: 'job-2', status: 'sent', lastError: null, lastErrorHint: null }),
    ])
    renderPanel()

    expect(await screen.findByText('QQ API 401 Unauthorized')).toBeTruthy()
    expect(screen.getByText('AppSecret 可能已失效，请重新录入')).toBeTruthy()
    expect(screen.getByText('网络超时')).toBeTruthy()
    expect(screen.getByText('发布内容为空')).toBeTruthy()
    expect(screen.getByText('请检查发布内容')).toBeTruthy()
    expect(screen.getByText('3 条')).toBeTruthy()
    expect(mocks.deliveriesList).toHaveBeenCalledWith('chatbot-1', 200)
    expect(mocks.publishList).toHaveBeenCalledWith('chatbot-1', 200)
  })

  it('刷新按钮重新拉取事件与错误', async () => {
    renderPanel()
    await screen.findAllByText('command')
    await waitFor(() => expect(mocks.deliveriesList).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(mocks.events).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.deliveriesList).toHaveBeenCalledTimes(2))
  })

  it('事件读取失败展示错误并支持重试', async () => {
    mocks.events.mockRejectedValue(new Error('读取入站事件失败'))
    renderPanel()

    expect(await screen.findByText('读取入站事件失败')).toBeTruthy()
    const retry = screen.getByRole('button', { name: '重试' })
    mocks.events.mockResolvedValue({ items: [eventItem()], total: 1 })
    await userEvent.click(retry)
    await waitFor(() => expect(mocks.events).toHaveBeenCalledTimes(2))
    expect(await screen.findAllByText('command')).not.toHaveLength(0)
  })
})
