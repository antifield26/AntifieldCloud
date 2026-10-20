import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BackupStatusCard } from './BackupStatusCard'

afterEach(cleanup)

describe('BackupStatusCard 降级态', () => {
  it('没有数据时显示空态与“未运行/未知”，不渲染错误', () => {
    render(<BackupStatusCard />)
    expect(screen.getByLabelText('备份健康状态')).toBeTruthy()
    expect(screen.getByText(/尚无备份状态记录/)).toBeTruthy()
    expect(screen.getByText('暂无数据')).toBeTruthy()
    // 8 个状态条目全部渲染，且世界备份/演练显示未运行
    expect(screen.getByText('应用归档')).toBeTruthy()
    expect(screen.getByText('密钥包')).toBeTruthy()
    expect(screen.getByText('世界备份')).toBeTruthy()
    expect(screen.getByText('最近演练')).toBeTruthy()
    expect(screen.getAllByText('未运行').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('接口失败时显示错误与重试入口', async () => {
    const onRetry = vi.fn()
    render(<BackupStatusCard error="加载备份状态失败" onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toContain('加载备份状态失败')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('异常状态高亮并显示原因，不展示路径', () => {
    render(
      <BackupStatusCard
        backup={{
          lastPullAt: '2026-10-19T00:00:00.000Z',
          ageHours: 24,
          sizeBytes: 1024,
          ok: true,
          overdue: false,
          secretsOk: false,
          secretsLastError: 'age 加密失败',
          pendingCount: 2,
          pendingBytes: 4096,
          orphanCount: 0,
          ackedBytes: 2048,
          world: {
            ok: false,
            lastRunAt: '2026-10-20T00:00:00.000Z',
            archiveName: 'world-20261020T000000Z.tar.gz',
            sizeBytes: 3_200_000_000,
            sha256: 'deadbeef',
            error: 'tar 打包失败',
          },
          drill: { ok: true, lastRunAt: '2026-10-20T00:00:00.000Z', reportPath: 'drills/20261020T000000Z/report.json', dbIntegrity: 'ok' },
        }}
      />,
    )
    expect(screen.getByText('存在异常')).toBeTruthy()
    expect(screen.getAllByText('异常').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/age 加密失败/)).toBeTruthy()
    expect(screen.getByText(/tar 打包失败/)).toBeTruthy()
    expect(screen.getAllByText('待确认归档').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('2 个')).toBeTruthy()
    // 世界备份归档名作为说明展示，但不展示本机绝对路径
    expect(screen.queryByText(/\/var\/lib\//)).toBeNull()
  })

  it('加载中显示骨架屏', () => {
    const { container } = render(<BackupStatusCard loading />)
    expect(container.querySelector('.skeleton')).not.toBeNull()
    expect(screen.queryByText('备份健康')).toBeNull()
  })
})
