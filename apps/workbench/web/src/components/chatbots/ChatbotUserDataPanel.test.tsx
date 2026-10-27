// 角色与记忆面板测试：角色卡启停/删除、结构化记忆元数据、条目对话框与单条删除；不依赖真实服务端。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  ChatbotGroupRoleSummary,
  ChatbotMemoryGroupSummary,
  ChatbotMemoryItemSummary,
  ChatbotMemoryUserSummary,
  ChatbotRoleSummary,
  ChatbotSummary,
} from '../../api/types'
import { ToastProvider } from '../Toast'
import { ChatbotUserDataPanel } from './ChatbotUserDataPanel'

const mocks = vi.hoisted(() => ({
  rolesList: vi.fn(),
  roleSetEnabled: vi.fn(),
  roleRemove: vi.fn(),
  groupRolesList: vi.fn(),
  groupRoleGet: vi.fn(),
  groupRoleSave: vi.fn(),
  groupRoleSetEnabled: vi.fn(),
  groupRoleRemove: vi.fn(),
  memoriesList: vi.fn(),
  groupMemoriesList: vi.fn(),
  groupMemoryRemove: vi.fn(),
  memoryItems: vi.fn(),
  memoryRemoveItem: vi.fn(),
  memoryRemove: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    chatbots: {
      roles: {
        list: mocks.rolesList,
        setEnabled: mocks.roleSetEnabled,
        remove: mocks.roleRemove,
      },
      groupRoles: {
        list: mocks.groupRolesList,
        get: mocks.groupRoleGet,
        save: mocks.groupRoleSave,
        setEnabled: mocks.groupRoleSetEnabled,
        remove: mocks.groupRoleRemove,
      },
      memories: {
        list: mocks.memoriesList,
        items: mocks.memoryItems,
        removeItem: mocks.memoryRemoveItem,
        remove: mocks.memoryRemove,
      },
      groupMemories: {
        list: mocks.groupMemoriesList,
        remove: mocks.groupMemoryRemove,
      },
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

function roleSummary(overrides: Partial<ChatbotRoleSummary> = {}): ChatbotRoleSummary {
  return {
    userId: 'user-1',
    userName: '小明',
    name: '运维助手',
    enabled: true,
    promptLength: 120,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function groupRoleSummary(overrides: Partial<ChatbotGroupRoleSummary> = {}): ChatbotGroupRoleSummary {
  return {
    targetId: 'target-group-1',
    targetLabel: '测试群',
    targetExternalId: 'group-openid-1',
    name: '群聊助手',
    enabled: true,
    promptLength: 80,
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function memoryUserSummary(overrides: Partial<ChatbotMemoryUserSummary> = {}): ChatbotMemoryUserSummary {  return {
    userId: 'user-1',
    userName: '小明',
    itemCount: 3,
    kinds: { profile: 2, preference: 1 },
    memoryEnabled: true,
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function memoryItemSummary(overrides: Partial<ChatbotMemoryItemSummary> = {}): ChatbotMemoryItemSummary {
  return {
    id: 'mem-1',
    kind: 'preference',
    importance: 4,
    confidence: 0.92,
    updatedAt: '2026-10-21T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  }
}

function memoryGroupSummary(overrides: Partial<ChatbotMemoryGroupSummary> = {}): ChatbotMemoryGroupSummary {
  return {
    scope: 'group:group-openid-1',
    targetExternalId: 'group-openid-1',
    targetName: '测试群',
    itemCount: 2,
    kinds: { fact: 2 },
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function renderPanel(refreshToken = 0) {
  return render(
    <ToastProvider>
      <ChatbotUserDataPanel chatbot={chatbot()} refreshToken={refreshToken} />
    </ToastProvider>,
  )
}

function kindDistributionText(): string[] {
  return Array.from(document.querySelectorAll('.chatbot-memory-kind')).map(
    (element) => element.textContent ?? '',
  )
}

beforeEach(() => {
  mocks.rolesList.mockResolvedValue({ items: [roleSummary()], total: 1 })
  mocks.roleSetEnabled.mockResolvedValue(undefined)
  mocks.roleRemove.mockResolvedValue(undefined)
  mocks.groupRolesList.mockResolvedValue({ items: [groupRoleSummary()] })
  mocks.groupRoleGet.mockResolvedValue({ groupRole: null })
  mocks.groupRoleSave.mockResolvedValue({
    targetId: 'target-group-1',
    targetLabel: '测试群',
    targetExternalId: 'group-openid-1',
    name: '群聊助手',
    prompt: '群聊角色设定',
    enabled: true,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  })
  mocks.groupRoleSetEnabled.mockResolvedValue(undefined)
  mocks.groupRoleRemove.mockResolvedValue(undefined)
  mocks.memoriesList.mockResolvedValue({ items: [memoryUserSummary()], total: 1 })
  mocks.groupMemoriesList.mockResolvedValue({ items: [memoryGroupSummary()], total: 1 })
  mocks.groupMemoryRemove.mockResolvedValue(undefined)
  mocks.memoryItems.mockResolvedValue({
    items: [memoryItemSummary()],
    total: 1,
  })
  mocks.memoryRemoveItem.mockResolvedValue(undefined)
  mocks.memoryRemove.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChatbotUserDataPanel 角色与记忆', () => {
  it('只展示元数据，不渲染角色正文与记忆 key/value 正文', async () => {
    // 服务端契约不含正文；这里额外注入 prompt/key/value/summary 字段，确认页面不会渲染任何正文文本。
    mocks.rolesList.mockResolvedValue({
      items: [{ ...roleSummary(), prompt: '示例角色设定正文-绝密' }],
      total: 1,
    })
    mocks.memoriesList.mockResolvedValue({
      items: [{ ...memoryUserSummary(), key: '示例key', value: '示例长期记忆正文-绝密' }],
      total: 1,
    })
    mocks.memoryItems.mockResolvedValue({
      items: [{ ...memoryItemSummary(), key: '示例条目key', value: '示例条目正文-绝密' }],
      total: 1,
    })
    renderPanel()

    // Table 同时渲染桌面表格与移动端卡片，文本会出现多次。
    expect(await screen.findAllByText('小明')).not.toHaveLength(0)
    expect(screen.getAllByText('运维助手')).not.toHaveLength(0)
    expect(screen.getAllByText('记忆启用').length).toBeGreaterThan(0)
    expect(kindDistributionText()).toContain('资料2')
    expect(kindDistributionText()).toContain('偏好1')
    expect(screen.getByText(/私聊角色卡正文不通过 Web 暴露/)).toBeTruthy()

    // 打开条目对话框后同样不渲染 key/value。
    await userEvent.click(screen.getAllByRole('button', { name: '查看记忆条目 小明' })[0]!)
    expect(await screen.findByRole('heading', { name: /记忆条目 · 小明/ })).toBeTruthy()
    expect((await screen.findAllByText('偏好')).length).toBeGreaterThan(0)

    expect(screen.queryByText(/示例角色设定正文-绝密/)).toBeNull()
    expect(screen.queryByText(/示例长期记忆正文-绝密/)).toBeNull()
    expect(screen.queryByText(/示例条目正文-绝密/)).toBeNull()
    expect(document.body.textContent).not.toContain('示例角色设定正文')
    expect(document.body.textContent).not.toContain('示例长期记忆正文')
    expect(document.body.textContent).not.toContain('示例条目key')
    expect(document.body.textContent).not.toContain('示例条目正文')
  })

  it('群聊角色卡可打开编辑并保存名字与正文', async () => {
    mocks.groupRoleGet.mockResolvedValue({
      groupRole: {
        targetId: 'target-group-1',
        targetLabel: '测试群',
        targetExternalId: 'group-openid-1',
        name: '群聊助手',
        prompt: '群聊专用角色设定',
        enabled: true,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
      },
    })
    renderPanel()
    const editButtons = await screen.findAllByRole('button', { name: '编辑群聊角色卡 测试群' })
    await userEvent.click(editButtons[0]!)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    const name = (await screen.findByLabelText(/角色名字/)) as HTMLInputElement
    expect(name.value).toBe('群聊助手')
    const prompt = screen.getByLabelText(/角色设定/) as HTMLTextAreaElement
    expect(prompt.value).toBe('群聊专用角色设定')
    await userEvent.clear(name)
    await userEvent.type(name, '新群助手')
    await userEvent.clear(prompt)
    await userEvent.type(prompt, '新的群聊设定')
    await userEvent.click(screen.getByRole('button', { name: '保存角色卡' }))
    await waitFor(() =>
      expect(mocks.groupRoleSave).toHaveBeenCalledWith('chatbot-1', 'target-group-1', {
        name: '新群助手',
        prompt: '新的群聊设定',
      }),
    )
  })

  it('记忆列表展示条目数、类型分布与启用状态', async () => {
    mocks.memoriesList.mockResolvedValue({
      items: [
        memoryUserSummary(),
        memoryUserSummary({
          userId: 'user-2',
          userName: '小红',
          itemCount: 0,
          kinds: {},
          memoryEnabled: false,
          updatedAt: null,
        }),
      ],
      total: 2,
    })
    renderPanel()

    expect(await screen.findAllByText('3 条')).not.toHaveLength(0)
    expect((await screen.findAllByText('0 条')).length).toBeGreaterThan(0)
    expect(kindDistributionText()).toContain('资料2')
    expect(kindDistributionText()).toContain('偏好1')
    expect(screen.getAllByText('记忆启用').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已暂停').length).toBeGreaterThan(0)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('打开条目对话框按用户请求元数据并展示权重与时间', async () => {
    mocks.memoryItems.mockResolvedValue({
      items: [
        memoryItemSummary(),
        memoryItemSummary({
          id: 'mem-2',
          kind: 'fact',
          importance: 3,
          confidence: 0.8,
          expiresAt: '2026-12-31T00:00:00.000Z',
        }),
      ],
      total: 2,
    })
    renderPanel()

    await userEvent.click((await screen.findAllByRole('button', { name: '查看记忆条目 小明' }))[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: /记忆条目 · 小明/ })).toBeTruthy()
    expect(mocks.memoryItems).toHaveBeenCalledWith('chatbot-1', 'user-1', { limit: 20, offset: 0 })
    expect((await within(dialog).findAllByText('偏好')).length).toBeGreaterThan(0)
    expect((await within(dialog).findAllByText('事实')).length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('4').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('92%').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('永不过期').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText(/2026-12-31 08:00/).length).toBeGreaterThan(0)

    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('单条删除需确认，确认后调用 memories.removeItem 并刷新', async () => {
    renderPanel()
    await userEvent.click((await screen.findAllByRole('button', { name: '查看记忆条目 小明' }))[0]!)
    await screen.findByRole('dialog')

    const deleteButtons = await screen.findAllByRole('button', {
      name: '删除记忆条目 偏好 mem-1',
    })
    await userEvent.click(deleteButtons[0]!)
    expect(await screen.findByText('确定删除这条「偏好」记忆条目？')).toBeTruthy()
    expect(mocks.memoryRemoveItem).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '删除条目' }))
    await waitFor(() => expect(mocks.memoryRemoveItem).toHaveBeenCalledWith('chatbot-1', 'user-1', 'mem-1'))
    await waitFor(() => expect(screen.queryByText('确定删除这条「偏好」记忆条目？')).toBeNull())
    await waitFor(() => expect(mocks.memoryItems).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.memoriesList).toHaveBeenCalledTimes(2))
  })

  it('删除全部记忆需确认，确认后调用 memories.remove', async () => {
    renderPanel()
    const deleteAllButtons = await screen.findAllByRole('button', { name: '删除全部记忆 小明' })

    await userEvent.click(deleteAllButtons[0]!)
    expect(await screen.findByText('确定删除用户「小明」的全部记忆条目？')).toBeTruthy()
    expect(mocks.memoryRemove).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '删除全部记忆' }))
    await waitFor(() => expect(mocks.memoryRemove).toHaveBeenCalledWith('chatbot-1', 'user-1'))
    await waitFor(() => expect(screen.queryByText('确定删除用户「小明」的全部记忆条目？')).toBeNull())
  })

  it('记忆分页按 offset 请求', async () => {
    mocks.memoriesList.mockResolvedValue({ items: [memoryUserSummary()], total: 25 })
    renderPanel()

    expect(await screen.findByText('第 1 / 2 页 · 共 25 条')).toBeTruthy()
    expect(mocks.memoriesList).toHaveBeenLastCalledWith('chatbot-1', { limit: 20, offset: 0 })

    await userEvent.click(screen.getByRole('button', { name: '下一页记忆' }))
    await waitFor(() =>
      expect(mocks.memoriesList).toHaveBeenLastCalledWith('chatbot-1', { limit: 20, offset: 20 }),
    )
    expect(await screen.findByText('第 2 / 2 页 · 共 25 条')).toBeTruthy()
  })

  it('条目读取失败展示错误并支持重试', async () => {
    mocks.memoryItems.mockRejectedValue(new Error('读取记忆条目失败'))
    renderPanel()
    await userEvent.click((await screen.findAllByRole('button', { name: '查看记忆条目 小明' }))[0]!)

    expect(await screen.findByText('读取记忆条目失败')).toBeTruthy()
    mocks.memoryItems.mockResolvedValue({ items: [memoryItemSummary()], total: 1 })
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mocks.memoryItems).toHaveBeenCalledTimes(2))
    expect((await screen.findAllByText('偏好')).length).toBeGreaterThan(0)
  })

  it('角色卡可启用/停用并调用 setEnabled', async () => {
    mocks.rolesList.mockResolvedValue({ items: [roleSummary({ enabled: false })], total: 1 })
    renderPanel()

    const toggles = await screen.findAllByRole('button', { name: '启用角色卡 小明' })
    await userEvent.click(toggles[0]!)

    await waitFor(() => expect(mocks.roleSetEnabled).toHaveBeenCalledWith('chatbot-1', 'user-1', true))
    expect((await screen.findAllByRole('button', { name: '停用角色卡 小明' })).length).toBeGreaterThan(0)
    expect(screen.getAllByText('已启用').length).toBeGreaterThan(0)
  })

  it('删除角色卡需确认，确认后调用删除接口并关闭对话框', async () => {
    renderPanel()
    const deleteButtons = await screen.findAllByRole('button', { name: '删除角色卡 小明' })

    await userEvent.click(deleteButtons[0]!)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/确定删除用户「小明」的角色卡/)).toBeTruthy()
    expect(mocks.roleRemove).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '删除角色卡' }))
    await waitFor(() => expect(mocks.roleRemove).toHaveBeenCalledWith('chatbot-1', 'user-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('长期记忆左右两栏展示群聊记忆，可查看条目并清空群共享记忆', async () => {
    mocks.groupMemoriesList.mockResolvedValue({
      items: [memoryGroupSummary({ targetName: '记忆群' })],
      total: 1,
    })
    renderPanel()

    expect(await screen.findByText('用户记忆')).toBeTruthy()
    expect(screen.getByText('群聊记忆')).toBeTruthy()
    expect((await screen.findAllByText('记忆群')).length).toBeGreaterThan(0)

    await userEvent.click(screen.getAllByRole('button', { name: '查看群聊记忆条目 记忆群' })[0]!)
    expect(await screen.findByRole('heading', { name: /记忆条目 · 记忆群/ })).toBeTruthy()
    expect(mocks.memoryItems).toHaveBeenCalledWith('chatbot-1', 'group:group-openid-1', {
      limit: 20,
      offset: 0,
    })
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))

    await userEvent.click(screen.getAllByRole('button', { name: '删除群聊记忆 记忆群' })[0]!)
    expect(await screen.findByText('确定删除群聊「记忆群」的全部共享记忆条目？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '删除群聊记忆' }))
    await waitFor(() =>
      expect(mocks.groupMemoryRemove).toHaveBeenCalledWith('chatbot-1', 'group:group-openid-1'),
    )
  })

  it('空态提示暂无角色卡与长期记忆', async () => {
    mocks.rolesList.mockResolvedValue({ items: [], total: 0 })
    mocks.memoriesList.mockResolvedValue({ items: [], total: 0 })
    renderPanel()

    expect(await screen.findByText('暂无角色卡')).toBeTruthy()
    expect(screen.getByText('用户记忆')).toBeTruthy()
    expect(screen.getByText('群聊记忆')).toBeTruthy()
  })
})
