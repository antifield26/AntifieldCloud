// 角色与记忆面板测试：只展示元数据、启停、删除确认与分页；不依赖真实服务端。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BotMemorySummary, BotRoleSummary, BotSummary } from '../../api/types'
import { ToastProvider } from '../Toast'
import { BotUserDataPanel } from './BotUserDataPanel'

const mocks = vi.hoisted(() => ({
  rolesList: vi.fn(),
  roleSetEnabled: vi.fn(),
  roleRemove: vi.fn(),
  memoriesList: vi.fn(),
  memoryRemove: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    bots: {
      roles: {
        list: mocks.rolesList,
        setEnabled: mocks.roleSetEnabled,
        remove: mocks.roleRemove,
      },
      memories: {
        list: mocks.memoriesList,
        remove: mocks.memoryRemove,
      },
    },
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

function bot(overrides: Partial<BotSummary> = {}): BotSummary {
  return {
    id: 'bot-1',
    platform: 'telegram',
    name: '告警 Bot',
    enabled: true,
    config: {},
    webhookUrl: 'https://app.example.com/api/bot/webhook/bot-1',
    setupSteps: [],
    targetsCount: 1,
    lastError: null,
    lastCheckedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    keyVersion: 1,
    gateway: { state: 'disabled', lastError: null },
    ...overrides,
  }
}

function roleSummary(overrides: Partial<BotRoleSummary> = {}): BotRoleSummary {
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

function memorySummary(overrides: Partial<BotMemorySummary> = {}): BotMemorySummary {
  return {
    userId: 'user-1',
    userName: '小明',
    summaryLength: 128,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function renderPanel(refreshToken = 0) {
  return render(
    <ToastProvider>
      <BotUserDataPanel bot={bot()} refreshToken={refreshToken} />
    </ToastProvider>,
  )
}

beforeEach(() => {
  mocks.rolesList.mockResolvedValue({ items: [roleSummary()], total: 1 })
  mocks.roleSetEnabled.mockResolvedValue(undefined)
  mocks.roleRemove.mockResolvedValue(undefined)
  mocks.memoriesList.mockResolvedValue({ items: [memorySummary()], total: 1 })
  mocks.memoryRemove.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BotUserDataPanel 角色与记忆', () => {
  it('只展示元数据，不渲染角色正文与记忆摘要正文', async () => {
    // 服务端契约不含正文；这里额外注入 prompt/summary 字段，确认页面不会渲染任何正文文本。
    mocks.rolesList.mockResolvedValue({
      items: [{ ...roleSummary(), prompt: '示例角色设定正文-绝密' }],
      total: 1,
    })
    mocks.memoriesList.mockResolvedValue({
      items: [{ ...memorySummary(), summary: '示例长期记忆摘要正文' }],
      total: 1,
    })
    renderPanel()

    // Table 同时渲染桌面表格与移动端卡片，文本会出现两次。
    expect(await screen.findAllByText('小明')).not.toHaveLength(0)
    expect(screen.getAllByText('运维助手')).not.toHaveLength(0)
    expect(screen.getAllByText('摘要 128 字')).not.toHaveLength(0)
    expect(screen.getByText(/仅显示元数据，正文不通过 Web 暴露/)).toBeTruthy()
    expect(screen.queryByText(/示例角色设定正文-绝密/)).toBeNull()
    expect(screen.queryByText(/示例长期记忆摘要正文/)).toBeNull()
    expect(document.body.textContent).not.toContain('示例角色设定正文')
    expect(document.body.textContent).not.toContain('示例长期记忆摘要正文')
  })

  it('角色卡可启用/停用并调用 setEnabled', async () => {
    mocks.rolesList.mockResolvedValue({ items: [roleSummary({ enabled: false })], total: 1 })
    renderPanel()

    const toggles = await screen.findAllByRole('button', { name: '启用角色卡 小明' })
    await userEvent.click(toggles[0]!)

    await waitFor(() => expect(mocks.roleSetEnabled).toHaveBeenCalledWith('bot-1', 'user-1', true))
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
    await waitFor(() => expect(mocks.roleRemove).toHaveBeenCalledWith('bot-1', 'user-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('删除长期记忆需确认，确认后调用 memories.remove', async () => {
    renderPanel()
    const deleteButtons = await screen.findAllByRole('button', { name: '删除长期记忆 小明' })

    await userEvent.click(deleteButtons[0]!)
    expect(await screen.findByText(/确定删除用户「小明」的长期记忆摘要/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '清除记忆' }))

    await waitFor(() => expect(mocks.memoryRemove).toHaveBeenCalledWith('bot-1', 'user-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('角色卡超过一页时按 offset 翻页', async () => {
    mocks.rolesList.mockResolvedValue({ items: [roleSummary()], total: 25 })
    renderPanel()

    expect(await screen.findByText('第 1 / 2 页 · 共 25 条')).toBeTruthy()
    expect(mocks.rolesList).toHaveBeenLastCalledWith('bot-1', { limit: 20, offset: 0 })

    await userEvent.click(screen.getByRole('button', { name: '下一页角色卡' }))
    await waitFor(() =>
      expect(mocks.rolesList).toHaveBeenLastCalledWith('bot-1', { limit: 20, offset: 20 }),
    )
    expect(await screen.findByText('第 2 / 2 页 · 共 25 条')).toBeTruthy()
  })

  it('空态提示暂无角色卡与长期记忆', async () => {
    mocks.rolesList.mockResolvedValue({ items: [], total: 0 })
    mocks.memoriesList.mockResolvedValue({ items: [], total: 0 })
    renderPanel()

    expect(await screen.findByText('暂无角色卡')).toBeTruthy()
    expect(screen.getByText('暂无长期记忆')).toBeTruthy()
  })
})
