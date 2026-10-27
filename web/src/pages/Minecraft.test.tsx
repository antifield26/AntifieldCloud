import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { MinecraftStatus, WhitelistResult } from '../api/types'
import { ToastProvider } from '../components/Toast'
import { Minecraft } from './Minecraft'

const mocks = vi.hoisted(() => ({
  mcStatus: vi.fn(),
  whitelist: vi.fn(),
}))

const metaMock = vi.hoisted(() => ({ lofiiEnabled: true }))

vi.mock('../api/client', () => ({
  api: {
    mc: {
      status: mocks.mcStatus,
      whitelist: mocks.whitelist,
      addWhitelist: vi.fn(),
      removeWhitelist: vi.fn(),
    },
  },
  ApiError: class ApiError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

vi.mock('../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: { lofiiEnabled: metaMock.lofiiEnabled },
    loading: false,
    refresh: async () => undefined,
  }),
}))

// 页面测试只关心标签切换，Lofii 面板本身由 LofiiPanel.test.tsx 覆盖。
vi.mock('../components/lofii/LofiiPanel', () => ({
  LofiiPanel: () => <div data-testid="lofii-panel-stub">Lofii 面板内容</div>,
}))

function mcStatus(): MinecraftStatus {
  return {
    online: true,
    version: '26.1',
    motd: 'Raspberry Pi 5 | Minecraft LAN',
    players: { online: 1, max: 6, names: ['Antifield'] },
    tps: { m1: 19.5, m5: 19.7, m15: 19.9 },
    whitelistCount: 2,
    serviceActive: 'active',
    publicAddress: 'mc.example.com',
    checkedAt: '2026-10-27T08:00:00.000Z',
    error: null,
  }
}

function whitelist(): WhitelistResult {
  return {
    names: ['Antifield', 'lofii'],
    checkedAt: '2026-10-27T08:00:00.000Z',
    error: null,
  }
}

function LocationProbe() {
  const location = useLocation()
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
      {location.hash}
    </span>
  )
}

function renderPage(entry = '/minecraft') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <Routes>
          <Route path="/minecraft" element={<Minecraft />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

beforeEach(() => {
  metaMock.lofiiEnabled = true
  mocks.mcStatus.mockResolvedValue(mcStatus())
  mocks.whitelist.mockResolvedValue(whitelist())
})

afterEach(cleanup)

describe('Minecraft 页标签', () => {
  it('启用 Lofii 时显示可访问标签，默认停留在服务器内容', async () => {
    renderPage()
    expect(await screen.findByRole('tablist', { name: 'Minecraft 页面分区' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '服务器' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Lofii' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('heading', { level: 1, name: 'Minecraft' })).toBeTruthy()
    expect(
      await screen.findByText('本页只提供状态查看与白名单增删，不提供服务器启停、控制台或任意 RCON 命令。'),
    ).toBeTruthy()
    expect(screen.queryByTestId('lofii-panel-stub')).toBeNull()
  })

  it('切换到 Lofii 写入 ?tab=lofii，切回服务器清除参数', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Lofii' }))
    expect(await screen.findByTestId('lofii-panel-stub')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Lofii' })).toBeTruthy()
    expect(locationText()).toBe('/minecraft?tab=lofii')

    await userEvent.click(screen.getByRole('tab', { name: '服务器' }))
    expect(locationText()).toBe('/minecraft')
    expect(screen.queryByTestId('lofii-panel-stub')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Minecraft' })).toBeTruthy()
  })

  it('支持 ?tab=lofii 深链初始化', async () => {
    renderPage('/minecraft?tab=lofii')
    expect(await screen.findByTestId('lofii-panel-stub')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Lofii' }).getAttribute('aria-selected')).toBe('true')
  })

  it('支持 #lofii 深链初始化，并在切回服务器时清理 hash', async () => {
    renderPage('/minecraft#lofii')
    expect(await screen.findByTestId('lofii-panel-stub')).toBeTruthy()
    await userEvent.click(screen.getByRole('tab', { name: '服务器' }))
    expect(screen.queryByTestId('lofii-panel-stub')).toBeNull()
    expect(locationText()).toBe('/minecraft')
  })

  it('切换标签时保留其他查询参数', async () => {
    renderPage('/minecraft?foo=1&bar=2')
    await userEvent.click(screen.getByRole('tab', { name: 'Lofii' }))
    expect(locationText()).toContain('foo=1')
    expect(locationText()).toContain('bar=2')
    expect(locationText()).toContain('tab=lofii')

    await userEvent.click(screen.getByRole('tab', { name: '服务器' }))
    expect(locationText()).toContain('foo=1')
    expect(locationText()).toContain('bar=2')
    expect(locationText()).not.toContain('tab=lofii')
  })

  it('键盘方向键可在两个标签间切换', async () => {
    renderPage()
    const serverTab = screen.getByRole('tab', { name: '服务器' })
    await userEvent.click(serverTab)
    serverTab.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(await screen.findByTestId('lofii-panel-stub')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Lofii' }).getAttribute('aria-selected')).toBe('true')
  })

  it('meta.lofiiEnabled=false 时隐藏 Lofii 标签并回退服务器内容', async () => {
    metaMock.lofiiEnabled = false
    renderPage('/minecraft?tab=lofii')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByTestId('lofii-panel-stub')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Minecraft' })).toBeTruthy()
    expect(
      await screen.findByText('本页只提供状态查看与白名单增删，不提供服务器启停、控制台或任意 RCON 命令。'),
    ).toBeTruthy()
  })
})
