// 长耗时备份端点超时与 v0.7.0 契约（WEB-01 / CD-06 / WEB-04）回归。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, BACKUP_LONG_OPERATION_TIMEOUTS } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const plan = {
  id: 'plan-1',
  status: 'planned',
  targetName: '恢复-1',
  archive: 'snapshot-20261024T000000Z-full.tar.gz',
  archives: ['snapshot-20261024T000000Z-full.tar.gz'],
  fileCount: 1,
  totalBytes: 1024,
  createdAt: '2026-10-24T12:00:00.000Z',
  expiresAt: '2026-10-24T12:30:00.000Z',
  completedAt: null,
  error: null,
  skippedMissing: [],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BACKUP_LONG_OPERATION_TIMEOUTS', () => {
  it('长任务端点使用显式超时，而非默认 20s', () => {
    expect(BACKUP_LONG_OPERATION_TIMEOUTS.prepare).toBeGreaterThan(3_000_000)
    expect(BACKUP_LONG_OPERATION_TIMEOUTS.verify).toBeGreaterThanOrEqual(600_000)
    expect(BACKUP_LONG_OPERATION_TIMEOUTS.restorePlan).toBeGreaterThanOrEqual(600_000)
    expect(BACKUP_LONG_OPERATION_TIMEOUTS.executeRestore).toBeGreaterThanOrEqual(3_600_000)
    expect(BACKUP_LONG_OPERATION_TIMEOUTS.getRestore).toBeLessThanOrEqual(60_000)
  })
})

describe('备份 API 请求超时接线', () => {
  it('prepare/verify/executeRestore 把长超时传给 AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetched: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        fetched.push(url)
        if (url.endsWith('/api/backups/prepare')) {
          return jsonResponse({ ok: true, archiveName: 'snapshot-20261024T000000Z-inc.tar.gz', encrypted: true })
        }
        if (url.endsWith('/api/backups/verify')) {
          return jsonResponse({ ok: true, archive: { name: 'a' } })
        }
        if (url.endsWith('/api/restores/plan-1/execute')) {
          return jsonResponse({ plan: { ...plan, status: 'completed' }, result: { targetFolderId: 'dir-1', targetName: '恢复-1', filesRestored: 1, bytesRestored: 1, durationMs: 1, skippedMissing: [] } })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    await api.backups.prepare('123456')
    expect(timeoutSpy).toHaveBeenCalledWith(BACKUP_LONG_OPERATION_TIMEOUTS.prepare)

    await api.backups.verify('snapshot-20261024T000000Z-inc.tar.gz')
    expect(timeoutSpy).toHaveBeenCalledWith(BACKUP_LONG_OPERATION_TIMEOUTS.verify)

    await api.backups.executeRestore('plan-1', '123456')
    expect(timeoutSpy).toHaveBeenCalledWith(BACKUP_LONG_OPERATION_TIMEOUTS.executeRestore)
    expect(fetched.length).toBe(3)
  })
})

describe('v0.7.0 备份契约', () => {
  it('files.get 返回 FileItem（分片 completed 恢复依赖）', async () => {
    const item = { id: 'file-1', name: 'a.bin', kind: 'file', size: 1, parentId: null }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ item, path: '/' })))
    await expect(api.files.get('file-1')).resolves.toMatchObject({ id: 'file-1', name: 'a.bin' })
  })

  it('files.get 响应缺 item 时抛 invalid_response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ path: '/' })))
    await expect(api.files.get('file-1')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('getRestore 规范化 {plan} 并返回 plan（WEB-04 轮询）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ plan })))
    const result = await api.backups.getRestore('plan-1')
    expect(result.plan.id).toBe('plan-1')
    expect(result.plan.status).toBe('planned')
  })

  it('prepare 结果透传 encrypted / skippedMissing / warnings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          archiveName: 'snapshot-20261024T000000Z-inc.tar.gz.age',
          encrypted: true,
          archiveFormat: 'tar.gz.age',
          metaName: 'snapshot-20261024T000000Z-inc.tar.gz.age.meta.json',
          plainSha256: 'b'.repeat(64),
          plainSize: 2048,
          warnings: ['w'],
          skippedMissing: ['f1'],
        }),
      ),
    )
    const result = await api.backups.prepare('123456')
    expect(result.encrypted).toBe(true)
    expect(result.archiveFormat).toBe('tar.gz.age')
    expect(result.warnings).toEqual(['w'])
    expect(result.skippedMissing).toEqual(['f1'])
  })
})
