import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  BotDelivery,
  BotPublishJob,
  BotStatus,
  BotSummary,
  BotTarget,
  BotConnectivitySnapshot,
} from '../api/types'
import { ToastProvider } from '../components/Toast'
import { Bots } from './Bots'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  connectivity: vi.fn(),
  checkConnectivity: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  check: vi.fn(),
  events: vi.fn(),
  rolesList: vi.fn(),
  roleSetEnabled: vi.fn(),
  roleRemove: vi.fn(),
  memoriesList: vi.fn(),
  memoryItems: vi.fn(),
  memoryRemoveItem: vi.fn(),
  memoryRemove: vi.fn(),
  targetList: vi.fn(),
  targetInbound: vi.fn(),
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
      connectivity: mocks.connectivity,
      checkConnectivity: mocks.checkConnectivity,
      list: mocks.list,
      get: mocks.get,
      create: mocks.create,
      update: mocks.update,
      remove: mocks.remove,
      test: mocks.test,
      check: mocks.check,
      events: mocks.events,
      roles: {
        list: mocks.rolesList,
        setEnabled: mocks.roleSetEnabled,
        remove: mocks.roleRemove,
      },
      memories: {
        list: mocks.memoriesList,
        items: mocks.memoryItems,
        removeItem: mocks.memoryRemoveItem,
        remove: mocks.memoryRemove,
      },
      metrics: mocks.metrics,
      targets: {
        list: mocks.targetList,
        listInbound: mocks.targetInbound,
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
    aiToolIsolation: null,
    ...overrides,
  }
}

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
  return {
    id: 'bot-1',
    platform: 'qq',
    name: '告警 Bot',
    enabled: true,
    config: { appId: '102123456' },
    webhookUrl: 'https://app.example.com/api/bot/webhook/bot-1',
    setupSteps: ['在 QQ 开放平台创建机器人。', '填写回调地址。'],
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
    externalId: 'group-openid-1',
    label: '测试群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: true,
    allowChat: false,
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
    scheduledAt: null,
    status: 'queued',
    attempts: 0,
    lastError: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    sentAt: null,
    ...overrides,
  }
}

function connectivity(overrides: Partial<BotConnectivitySnapshot> = {}): BotConnectivitySnapshot {
  return {
    checkedAt: '2026-10-22T00:00:00.000Z',
    checking: false,
    internet: { reachable: true, latencyMs: 120, status: 200, error: null },
    platforms: {
      qq: { reachable: true, latencyMs: 180, status: 404, error: null },
    },
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
  mocks.connectivity.mockResolvedValue(connectivity())
  mocks.checkConnectivity.mockResolvedValue(connectivity())
  mocks.list.mockResolvedValue([bot()])
  mocks.get.mockResolvedValue(bot())
  mocks.create.mockResolvedValue(bot({ id: 'bot-2', name: '新 Bot', targetsCount: 0 }))
  mocks.update.mockResolvedValue(bot())
  mocks.remove.mockResolvedValue({ ok: true })
  mocks.test.mockResolvedValue({ ok: true })
  mocks.check.mockResolvedValue({
    ok: true,
    checkedAt: '2026-10-22T00:00:00.000Z',
    items: [
      { name: 'AppID 有效', ok: true, detail: 'AppID 格式正确' },
      { name: 'access_token 获取成功', ok: true, detail: '令牌有效期 7200 秒' },
    ],
  })
  mocks.events.mockResolvedValue({ items: [], total: 0 })
  mocks.rolesList.mockResolvedValue({ items: [], total: 0 })
  mocks.roleSetEnabled.mockResolvedValue(undefined)
  mocks.roleRemove.mockResolvedValue(undefined)
  mocks.memoriesList.mockResolvedValue({ items: [], total: 0 })
  mocks.memoryItems.mockResolvedValue({ items: [], total: 0 })
  mocks.memoryRemoveItem.mockResolvedValue(undefined)
  mocks.memoryRemove.mockResolvedValue(undefined)
  mocks.targetList.mockResolvedValue([target()])
  mocks.targetInbound.mockResolvedValue([])
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

  it('概览展示出站连通性并支持手动复检', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: '出站网络' })).toBeTruthy()
    expect(await screen.findByText('可直连')).toBeTruthy()
    expect((await screen.findAllByText('QQ 官方')).length).toBeGreaterThan(0)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '检测' }))
    await waitFor(() => expect(mocks.checkConnectivity).toHaveBeenCalledTimes(1))
  })

  it('AI 工具隔离降级时概览显示 warning', async () => {
    mocks.status.mockResolvedValue(
      botStatus({
        aiToolIsolation: { supported: false, fallbackCount: 2, fallbackAt: '2026-10-23T04:00:00.000Z' },
      }),
    )
    renderPage()
    expect(await screen.findByText(/AI 工具隔离已降级/)).toBeTruthy()
    expect(await screen.findByText(/降级 2 次/)).toBeTruthy()
  })

  it('创建表单校验 QQ 必填项，填写后提交 AppID 与配置', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await openConfigTab()
    await userEvent.click(screen.getByRole('button', { name: '新建 Bot' }))
    expect(await screen.findByRole('heading', { name: '创建 Bot' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }))
    expect(await screen.findByText('请输入 Bot 名称')).toBeTruthy()
    expect(screen.getByText('请输入 AppSecret')).toBeTruthy()
    expect(screen.getByText('AppID 应为 5–32 位数字')).toBeTruthy()
    expect(mocks.create).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText(/名称/), '新 Bot')
    await userEvent.type(screen.getByLabelText(/AppID/), '102123456')
    await userEvent.type(screen.getByLabelText(/AppSecret/), 's'.repeat(20))
    await userEvent.click(screen.getByRole('button', { name: '创建 Bot' }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        platform: 'qq',
        name: '新 Bot',
        token: 's'.repeat(20),
        config: { appId: '102123456' },
      }),
    )
    expect(await screen.findByRole('heading', { name: /编辑「新 Bot」/ })).toBeTruthy()
  })

  it('编辑时 AppSecret 输入不回显，留空表示不修改', async () => {
    const summary = {
      ...bot({ config: { appId: '102123456' } }),
      token: 'super-secret-app-secret',
    } as BotSummary
    mocks.list.mockResolvedValue([summary])
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await openConfigTab()

    expect((screen.getByLabelText(/AppID/) as HTMLInputElement).value).toBe('102123456')
    const tokenInput = screen.getByLabelText(/AppSecret/) as HTMLInputElement
    expect(tokenInput.value).toBe('')
    expect(tokenInput.placeholder).toBe('留空表示不修改')
    expect(screen.queryByDisplayValue('super-secret-app-secret')).toBeNull()
    expect(screen.queryByText('super-secret-app-secret')).toBeNull()
    // 其他平台密钥字段已收敛，不再展示。
    expect(screen.queryByLabelText(/Webhook Secret/)).toBeNull()
    expect(screen.queryByLabelText(/Public Key/)).toBeNull()
    expect(screen.queryByLabelText(/Signing Secret/)).toBeNull()
  })

  it('目标分区切换允许命令会调用 PATCH 并更新状态', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '目标' }))
    const checkbox = await screen.findByRole('checkbox', { name: '测试群 允许命令' })
    expect(checkbox).not.toBeChecked()

    await userEvent.click(checkbox)
    await waitFor(() =>
      expect(mocks.targetUpdate).toHaveBeenCalledWith('bot-1', 'target-1', { allowCommands: true }),
    )
    await waitFor(() => expect(checkbox).toBeChecked())
  })

  it('目标分区可创建允许 Chat 的目标，并展示最近入站目标', async () => {
    mocks.targetInbound.mockResolvedValue([
      {
        botId: 'bot-1',
        targetExternalId: 'new-group',
        targetKind: 'group',
        userId: 'user-9',
        userName: '测试成员',
        isDirect: false,
        lastSeenAt: '2026-10-21T00:00:00.000Z',
      },
    ])
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '目标' }))
    expect(await screen.findByText('测试成员')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '登记' }))
    expect((screen.getByLabelText(/平台目标 ID/) as HTMLInputElement).value).toBe('new-group')

    await userEvent.type(screen.getByLabelText(/^名称/), '聊天目标')
    await userEvent.click(screen.getByRole('checkbox', { name: '允许 Chat' }))
    await userEvent.click(screen.getByRole('button', { name: '添加目标' }))
    await waitFor(() =>
      expect(mocks.targetCreate).toHaveBeenCalledWith(
        'bot-1',
        expect.objectContaining({ externalId: 'new-group', allowChat: true }),
      ),
    )
  })

  it('发布表单仅提交纯文本与 TOTP 双确认', async () => {
    mocks.publishCreate.mockResolvedValue(job())
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '投递与发布' }))

    const select = (await screen.findByLabelText(/发布目标/)) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('target-1'))
    await userEvent.type(screen.getByLabelText(/发布内容/), '发布内容测试')
    // 媒体选择器已随 QQ 纯文本收敛移除。
    expect(screen.queryByRole('button', { name: '选择文件' })).toBeNull()
    await userEvent.type(screen.getByLabelText(/TOTP 验证码/), '123456')
    await userEvent.type(screen.getByLabelText(/二次确认/), 'PUBLISH')
    await userEvent.click(screen.getByRole('button', { name: '创建发布任务' }))

    await waitFor(() =>
      expect(mocks.publishCreate).toHaveBeenCalledWith('bot-1', {
        targetId: 'target-1',
        text: '发布内容测试',
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

  it('标签扩展为六个分区，角色与记忆分区展示元数据', async () => {
    mocks.rolesList.mockResolvedValue({
      items: [
        {
          userId: 'user-1',
          userName: '小明',
          name: '运维助手',
          enabled: true,
          promptLength: 120,
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-21T00:00:00.000Z',
        },
      ],
      total: 1,
    })
    mocks.memoriesList.mockResolvedValue({
      items: [
        {
          userId: 'user-1',
          userName: '小明',
          itemCount: 3,
          kinds: { profile: 2, preference: 1 },
          memoryEnabled: true,
          updatedAt: '2026-10-21T00:00:00.000Z',
        },
      ],
      total: 1,
    })
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })

    const labels = ['概览', '配置', '目标', '投递与发布', '角色与记忆', '诊断']
    for (const label of labels) expect(screen.getByRole('tab', { name: label })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(6)

    await userEvent.click(screen.getByRole('tab', { name: '角色与记忆' }))
    expect(await screen.findByRole('heading', { name: '角色卡' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: '长期记忆' })).toBeTruthy()
    expect((await screen.findAllByText('小明')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('3 条')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('记忆启用').length).toBeGreaterThan(0)
    expect(Array.from(document.querySelectorAll('.bot-memory-kind')).map((el) => el.textContent)).toContain('资料2')
    expect(screen.getByText(/仅显示元数据，正文不通过 Web 暴露/)).toBeTruthy()
    expect(mocks.rolesList).toHaveBeenCalledWith('bot-1', { limit: 20, offset: 0 })
    expect(mocks.memoriesList).toHaveBeenCalledWith('bot-1', { limit: 20, offset: 0 })
  })

  it('角色与记忆分区可打开记忆条目对话框并展示元数据', async () => {
    mocks.memoriesList.mockResolvedValue({
      items: [
        {
          userId: 'user-1',
          userName: '小明',
          itemCount: 1,
          kinds: { fact: 1 },
          memoryEnabled: true,
          updatedAt: '2026-10-21T00:00:00.000Z',
        },
      ],
      total: 1,
    })
    mocks.memoryItems.mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          kind: 'fact',
          importance: 5,
          confidence: 0.9,
          updatedAt: '2026-10-21T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      total: 1,
    })
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '角色与记忆' }))

    await userEvent.click((await screen.findAllByRole('button', { name: '查看记忆条目 小明' }))[0]!)
    await screen.findByRole('dialog')
    expect(await screen.findByRole('heading', { name: /记忆条目 · 小明/ })).toBeTruthy()
    expect(mocks.memoryItems).toHaveBeenCalledWith('bot-1', 'user-1', { limit: 20, offset: 0 })
    expect((await screen.findAllByText('事实')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('永不过期').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('诊断分区展示事件元数据并支持筛选', async () => {
    mocks.events.mockResolvedValue({
      items: [
        {
          eventId: 'evt-1',
          kind: 'command',
          outcome: 'rate_limited',
          detail: '每用户限流',
          targetExternalId: '-1001234567890',
          userId: 'user-9',
          receivedAt: '2026-10-22T01:00:00.000Z',
          updatedAt: null,
        },
      ],
      total: 1,
    })
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '诊断' }))

    expect((await screen.findAllByText('限流')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('command').length).toBeGreaterThan(0)
    expect(mocks.events).toHaveBeenCalledWith('bot-1', {
      hours: 24,
      outcome: undefined,
      limit: 20,
      offset: 0,
    })

    await userEvent.selectOptions(screen.getByLabelText('事件结果筛选'), 'denied')
    await waitFor(() =>
      expect(mocks.events).toHaveBeenLastCalledWith('bot-1', expect.objectContaining({ outcome: 'denied' })),
    )
    await userEvent.selectOptions(screen.getByLabelText('事件时间范围'), '168')
    await waitFor(() =>
      expect(mocks.events).toHaveBeenLastCalledWith('bot-1', expect.objectContaining({ hours: 168 })),
    )
  })

  it('配置分区可检查连接并展示脱敏结果与 /reset 文案', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await openConfigTab()

    await userEvent.click(screen.getByRole('button', { name: '检查连接' }))
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith('bot-1'))
    expect(await screen.findByText('AppID 有效')).toBeTruthy()
    expect(screen.getByText('全部通过')).toBeTruthy()
    expect(screen.getByText(/\/reset 重置当前对话/)).toBeTruthy()
  })

  it('目标表单提交 QQ 目标且不再包含触发方式', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    await userEvent.click(screen.getByRole('tab', { name: '目标' }))

    expect(screen.queryByLabelText('触发方式')).toBeNull()
    await userEvent.type(await screen.findByLabelText(/平台目标 ID/), 'group-openid-2')
    await userEvent.type(screen.getByLabelText(/^名称/), '新目标')
    await userEvent.click(screen.getByRole('button', { name: '添加目标' }))

    await waitFor(() => expect(mocks.targetCreate).toHaveBeenCalledTimes(1))
    const payload = mocks.targetCreate.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload).toMatchObject({ externalId: 'group-openid-2', label: '新目标' })
    expect(Object.keys(payload)).not.toContain('chatTrigger')
  })

  it('页面不展示多平台与 Gateway 文案', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 3, name: '告警 Bot' })
    expect(screen.queryByText(/Gateway/)).toBeNull()
    expect(screen.queryByText(/Discord/)).toBeNull()
    expect(screen.queryByText(/Telegram/)).toBeNull()
    expect(screen.queryByText(/Slack/)).toBeNull()
  })
})
