import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MetricsPoint, MetricsResult } from '../../api/types'
import { MetricsCharts } from './MetricsCharts'

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  return { getMetrics: vi.fn(), enabled: true, MockApiError }
})

vi.mock('../../api/client', () => ({
  api: { getMetrics: mocks.getMetrics },
  ApiError: mocks.MockApiError,
  isApiError: (error: unknown, code?: string) =>
    error instanceof mocks.MockApiError && (code === undefined || error.code === code),
  isAbortError: () => false,
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

vi.mock('../../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: {
      metricsEnabled: mocks.enabled,
      metricsSampleSeconds: 60,
      metricsRetentionDays: 30,
    },
    loading: false,
    refresh: async () => undefined,
  }),
}))

function point(overrides: Partial<MetricsPoint> = {}): MetricsPoint {
  return {
    ts: '2026-10-20T00:00:00.000Z',
    cpuPercent: 12.5,
    memUsedBytes: 1024,
    memTotalBytes: 4096,
    memUsedPct: 25,
    tempC: 48,
    diskFreeBytes: 2048,
    diskTotalBytes: 4096,
    diskFreePct: 50,
    load1: 0.4,
    ...overrides,
  }
}

function result(series: MetricsPoint[]): MetricsResult {
  return {
    range: '24h',
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-20T00:00:00.000Z',
    bucketSeconds: 360,
    sampleCount: series.length,
    series,
  }
}

beforeEach(() => {
  mocks.enabled = true
  mocks.getMetrics.mockReset()
})

afterEach(cleanup)

describe('MetricsCharts', () => {
  it('加载成功后渲染四张指标卡并支持范围切换', async () => {
    mocks.getMetrics.mockResolvedValue(result([point(), point({ cpuPercent: 20 })]))
    render(<MetricsCharts />)

    expect(await screen.findByText('CPU 使用率')).toBeTruthy()
    expect(screen.getByText('内存使用率')).toBeTruthy()
    expect(screen.getByText('CPU 温度')).toBeTruthy()
    expect(screen.getByText('磁盘剩余')).toBeTruthy()
    // 当前值与“最高”统计都会显示 20.0%
    expect(screen.getAllByText('20.0%').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: '1 小时' })).toBeTruthy()
    expect(mocks.getMetrics).toHaveBeenCalledWith('24h', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: '1 小时' }))
    await waitFor(() => expect(mocks.getMetrics).toHaveBeenCalledWith('1h', expect.anything()))
  })

  it('空数据显示空态', async () => {
    mocks.getMetrics.mockResolvedValue(result([]))
    render(<MetricsCharts />)
    expect(await screen.findByText('暂无历史指标')).toBeTruthy()
  })

  it('请求失败显示错误与重试', async () => {
    mocks.getMetrics
      .mockRejectedValueOnce(new mocks.MockApiError(500, 'internal_error', '服务器内部错误'))
      .mockResolvedValueOnce(result([point()]))
    render(<MetricsCharts />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('服务器内部错误')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('CPU 使用率')).toBeTruthy()
  })

  it('旧服务端 404 时降级为“未启用”而不是错误', async () => {
    mocks.getMetrics.mockRejectedValue(new mocks.MockApiError(404, 'not_found', '请求的资源不存在'))
    render(<MetricsCharts />)
    expect(await screen.findByText(/服务端尚未提供指标历史接口/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('meta.metricsEnabled=false 时不请求接口', () => {
    mocks.enabled = false
    render(<MetricsCharts />)
    expect(screen.getByText(/指标历史未启用/)).toBeTruthy()
    expect(mocks.getMetrics).not.toHaveBeenCalled()
  })

  it('父组件重渲染（时钟 tick）不会触发指标重算', async () => {
    mocks.getMetrics.mockResolvedValue(result([point()]))

    function Parent() {
      const [tick, setTick] = useState(0)
      return (
        <div>
          <span data-testid="tick">{tick}</span>
          <button type="button" onClick={() => setTick((value) => value + 1)}>父级 tick</button>
          <MetricsCharts />
        </div>
      )
    }

    render(<Parent />)
    expect(await screen.findByText('CPU 使用率')).toBeTruthy()
    const callsAfterLoad = mocks.getMetrics.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: '父级 tick' }))
    expect(screen.getByTestId('tick').textContent).toBe('1')
    // 等待一个事件循环后确认没有额外请求（memo 生效）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.getMetrics.mock.calls.length).toBe(callsAfterLoad)
  })
})
