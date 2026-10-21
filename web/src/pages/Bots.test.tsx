import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  BotDelivery,
  BotPublishJob,
  BotStatus,
  BotSummary,
  BotTarget,
} from '../api/types'
import { ToastProvider } from '../components/Toast'
import { Bots } from './Bots'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  targetList: vi.fn(),
  targetCreate: vi.fn(),
  targetUpdate: vi.fn(),
  targetRemove: vi.fn(),
  deliveryList: vi.fn(),
  deliveryRetry: vi.fn(),
  metrics: vi.fn(),
  publishList: vi.fn(),
  publishCreate: vi.fn(),
  publishCancel: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: {
    bots: {
      status: mocks.status,
      list: mocks.list,
      get: mocks.get,
      create: mocks.create,
      update: mocks.update,
      remove: mocks.remove,
      test: mocks.test,
      metrics: mocks.metrics,
      targets: {
        list: mocks.targetList,
        create: mocks.targetCreate,
        update: mocks.targetUpdate,
        remove: mocks.targetRemove,
      },
      deliveries: {
        list: mocks.deliveryList,
        retry: mocks.deliveryRetry,
      },
      publish: {
        list: mocks.publishList,
        create: mocks.publishCreate,
        cancel: mocks.publishCancel,
      },
    },
  },
  // 测试用错误只需带 code，页面通过 isApiError 判断 503 功能开关。
  isApiError: (error: unknown, code?: string) => {
    const record = error as { code?: unknown } | null
    return Boolean(
      record &&
        typeof record.code === 'string' &&
        (code === undefined || record.code === code),
    )
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

function botStatus(overrides: Partial<BotStatus> = {}): BotStatus {
  return {
    enabled: true,
    keyConfigured: true,
    bots: 1,
    enabledBots: 1,
    targets: 1,
    queuedDeliveries: 0,
    queuedPublishes: 0,
    lastError: null,
    ...overrides,
  }
}

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
  return {
    id: 'bot-1',
    platform: 'telegram',
    name: '告警 Bot',
    enabled: true,
    config: {},
    webhookUrl: 'https://app.example.com/api/bot/webhook/bot-1',
    setupSteps: ['在 BotFather 创建 Bot。', '设置 Webhook。'],
    targetsCount: 1,
    lastError: null,
    lastCheckedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    keyVersion: 1,
    ...overrides,
  }
}

function target(overrides: Partial<BotTarget> = {}): BotTarget {
  return {
    id: 'target-1',
    botId: 'bot-1',
    externalId: '-1001234567890',
    label: '测试频道',
    kind: 'channel',
    allowCommands: false,
    allowNotifications: true,
    quietStartMinute: null,
    quietEndMinute: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  }
}

function delivery(overrides: Partial<BotDelivery> = {}): BotDelivery {
  return {
    id: 'delivery-1',
    botId: 'bot-1',
    targetId: 'target-1',
    kind: 'notification',
    status: 'failed',
    attempts: 2,
    nextAttemptAt: null,
    lastError: '网络超时',
    externalId: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

function job(overrides: Partial<BotPublishJob> = {}): BotPublishJob {
  return {
    id: 'job-1',
    botId: 'bot-1',
    targetId: 'target-1',
    text: '发布内容测试',
    mediaFileIds: ['file-1'],
    scheduledAt: null,
    status: 'queued',
    attempts: 0,
    lastError: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

function renderPage() {
  return render(
    <ToastProvider>
      <Bots />
    </ToastProvider>,
  )
}

beforeEach(() => {
  mocks.status.mockResolvedValue(botStatus())
  mocks.list.mockResolvedValue([bot()])
  mocks.get.mockResolvedValue(bot())
  mocks.create.mockResolvedValue(bot({ id: 'bot-2', name: '新 Bot', targetsCount: 0 }))
  mocks.update.mockResolvedValue(bot())
  mocks.remove.mockResolvedValue({ ok: true })
  mocks.test.mockResolvedValue({ ok: true })
  mocks.targetList.mockResolvedValue([target()])
  mocks.targetCreate.mockResolvedValue(target({ id: 'target-2', label: '新目标' }))
  mocks.targetUpdate.mockResolvedValue(target({ allowCommands: true }))
  mocks.targetRemove.mockResolvedValue({ ok: true })
  mocks.deliveryList.mockResolvedValue([])
  mocks.metrics.mockResolvedValue({
    hours: 24,
    deliveries: { total: 0, sent: 0, failed: 0, dead: 0, successRate: 0 },
    publishes: { total: 0, sent: 0, failed: 0 },
    events: 0,
    lastError: null,
    lastSentAt: null,
  })
  mocks.deliveryRetry.mockResolvedValue({ ok: true })
  mocks.publishList.mockResolvedValue([])
  mocks.publishCreate.mockResolvedValue(job())
  mocks.publishCancel.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openConfigTab(): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name: '配置' }))
  await screen.findByRole('heading', { name: /编辑「告警 Bot」/ })
}

describe('Bots 机器人管理', () => {
  it('功能未启用时显示配置指引，不请求 Bot 列表', async () => {
    mocks.status.mockResolvedValue(botStatus({ enabled: false, keyConfigured: false }))
    renderPage()
    expect(await screen.findByRole('heading', { name: '缺少 BOT_SECRET_KEY' })).toBeTruthy()
    expect(screen.getByText(/BOT_ENABLED=true/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('列表接口返回 503 bot_disabled 时降级为配置指引', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('Bot 功能未启用'), { code: 'bot_disabled' }))
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Bot 功能未启用' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('没有 Bot 时展示空态并引导创建', async () => {
    mocks.list.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('还没有配置 Bot')).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建第一个 Bot' })).toBeTruthy()
  })

  it('创建表单校验必填项，填写后可提交公开配置', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await openConfigTab()
    await userEvent.click(screen.getByRole('button', { name: '新建 Bot' }))
    expect(await screen.findByRole('heading', { name: '创建 Bot' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }))
    expect(await screen.findByText('请输入 Bot 名称')).toBeTruthy()
    expect(screen.getByText('请输入 Bot Token')).toBeTruthy()
    expect(screen.getByText('请输入 Telegram Webhook Secret')).toBeTruthy()
    expect(mocks.create).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText(/名称/), '新 Bot')
    await userEvent.type(screen.getByLabelText(/Bot Token/), 't'.repeat(24))
    await userEvent.type(screen.getByLabelText(/Webhook Secret/), 's'.repeat(18))
    await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        platform: 'telegram',
        name: '新 Bot',
        token: 't'.repeat(24),
        webhookSecret: 's'.repeat(18),
      }),
    )
    expect(await screen.findByRole('heading', { name: /编辑「新 Bot」/ })).toBeTruthy()
  })

  it('编辑时密钥输入不回显，留空表示不修改', async () => {
    const summary = {
      ...bot({ config: { applicationId: '123456789012345678', publicKey: 'a'.repeat(64) } }),
      token: 'super-secret-token',
    } as BotSummary
    mocks.list.mockResolvedValue([summary])
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await openConfigTab()

    const tokenInput = screen.getByLabelText(/Bot Token/) as HTMLInputElement
    expect(tokenInput.value).toBe('')
    expect(tokenInput.placeholder).toBe('留空表示不修改')
    const secretInput = screen.getByLabelText(/Webhook Secret/) as HTMLInputElement
    expect(secretInput.value).toBe('')
    expect(screen.queryByDisplayValue('super-secret-token')).toBeNull()
    expect(screen.queryByText('super-secret-token')).toBeNull()
  })

  it('目标分区切换允许命令会调用 PATCH 并更新状态', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '目标' }))
    const checkbox = await screen.findByRole('checkbox', { name: '测试频道 允许命令' })
    expect(checkbox).not.toBeChecked()

    await userEvent.click(checkbox)
    await waitFor(() =>
      expect(mocks.targetUpdate).toHaveBeenCalledWith('bot-1', 'target-1', { allowCommands: true }),
    )
    await waitFor(() => expect(checkbox).toBeChecked())
  })

  it('发布表单提交目标、文本、单媒体与无排期', async () => {
    mocks.publishCreate.mockResolvedValue(job())
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '投递与发布' }))

    const select = (await screen.findByLabelText(/发布目标/)) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('target-1'))
    await userEvent.type(screen.getByLabelText(/发布内容/), '发布内容测试')
    await userEvent.type(screen.getByLabelText(/媒体文件/), 'file-1')
    await userEvent.type(screen.getByLabelText(/TOTP 验证码/), '123456')
    await userEvent.type(screen.getByLabelText(/二次确认/), 'PUBLISH')
    await userEvent.click(screen.getByRole('button', { name: '创建发布任务' }))

    await waitFor(() =>
      expect(mocks.publishCreate).toHaveBeenCalledWith('bot-1', {
        targetId: 'target-1',
        text: '发布内容测试',
        mediaFileIds: ['file-1'],
        scheduledAt: null,
        totpCode: '123456',
        confirmText: 'PUBLISH',
      }),
    )
  })

  it('投递失败可重试', async () => {
    mocks.deliveryList.mockResolvedValue([delivery()])
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '投递与发布' }))
    expect(await screen.findByText('待重试')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mocks.deliveryRetry).toHaveBeenCalledWith('bot-1', 'delivery-1'))
  })
})
