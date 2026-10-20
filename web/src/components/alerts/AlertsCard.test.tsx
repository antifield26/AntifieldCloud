import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AlertsCard } from './AlertsCard'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('../../api/client', () => ({
  api: { alerts: { list: mocks.list } },
  isAbortError: () => false,
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

vi.mock('../../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: { alertsEnabled: true },
    loading: false,
    refresh: async () => undefined,
  }),
}))

function alertItem(id: number) {
  return {
    id,
    event: 'disk_low',
    severity: 'warning',
    status: 'firing',
    title: `告警 ${id}`,
    message: '磁盘剩余不足',
    createdAt: '2026-10-20T00:00:00.000Z',
    deliveredAt: null,
    deliveryError: null,
  }
}

function result(items = [alertItem(1)], total = 1) {
  return {
    items,
    state: [],
    config: {
      enabled: true,
      webhookConfigured: false,
      diskFreePct: 15,
      tempC: 80,
      backupMaxAgeHours: 48,
      cooldownMinutes: 360,
      checkIntervalSeconds: 300,
    },
    total,
  }
}

function renderCard() {
  return render(
    <MemoryRouter>
      <AlertsCard />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.list.mockReset()
})

afterEach(cleanup)

describe('AlertsCard 筛选与分页', () => {
  it('默认视图与旧版一致：请求最近 5 条、无筛选', async () => {
    mocks.list.mockResolvedValue(result())
    renderCard()
    expect(await screen.findByText('告警 1')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledWith(5, { offset: 0, event: undefined, status: undefined }, expect.anything())
    // 只有 1 条时不分页
    expect(screen.queryByRole('button', { name: '下一页告警历史' })).toBeNull()
  })

  it('状态/事件筛选回到第一页并带服务端参数', async () => {
    mocks.list.mockResolvedValue(result())
    renderCard()
    await screen.findByText('告警 1')

    await userEvent.selectOptions(screen.getByLabelText('按状态筛选告警历史'), 'firing')
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        5,
        { offset: 0, event: undefined, status: 'firing' },
        expect.anything(),
      ),
    )

    await userEvent.selectOptions(screen.getByLabelText('按事件筛选告警历史'), 'disk_low')
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        5,
        { offset: 0, event: 'disk_low', status: 'firing' },
        expect.anything(),
      ),
    )
  })

  it('总数超过一页时可翻页并按 offset 请求', async () => {
    mocks.list.mockResolvedValue(result([alertItem(1), alertItem(2), alertItem(3), alertItem(4), alertItem(5)], 12))
    renderCard()
    await screen.findByText('告警 1')
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '下一页告警历史' }))
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(5, { offset: 5, event: undefined, status: undefined }, expect.anything()),
    )
    expect(await screen.findByText('第 2 / 3 页')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '上一页告警历史' }))
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(5, { offset: 0, event: undefined, status: undefined }, expect.anything()),
    )
  })
})
