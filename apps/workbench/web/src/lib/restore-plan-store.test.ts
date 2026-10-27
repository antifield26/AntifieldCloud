// 恢复计划本地持久化（v0.7.0 WEB-04）：planId 可跨刷新恢复，终态保留、清除可用。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStoredRestorePlan,
  isFinishedRestoreStatus,
  loadStoredRestorePlan,
  saveStoredRestorePlan,
} from './restore-plan-store'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('restore-plan-store', () => {
  it('保存后可读回 planId 与展示元数据', () => {
    saveStoredRestorePlan({
      planId: 'plan-123',
      archive: 'snapshot-20261024T000000Z-full.tar.gz',
      status: 'executing',
      savedAt: '2026-10-24T14:00:00.000Z',
      targetName: '恢复-20261024T140000Z',
      steps: 12,
      bytes: 2048,
    })
    const loaded = loadStoredRestorePlan()
    expect(loaded?.planId).toBe('plan-123')
    expect(loaded?.status).toBe('executing')
    expect(loaded?.steps).toBe(12)
    expect(loaded?.bytes).toBe(2048)
  })

  it('非法/缺失内容安全回退为 null', () => {
    window.sessionStorage.setItem('af_restore_plan', 'not-json')
    expect(loadStoredRestorePlan()).toBeNull()
    window.sessionStorage.setItem('af_restore_plan', JSON.stringify({ archive: 'x' }))
    expect(loadStoredRestorePlan()).toBeNull()
  })

  it('clear 删除记录；终态判断覆盖 completed/failed/expired', () => {
    saveStoredRestorePlan({ planId: 'p', archive: 'a', status: 'completed', savedAt: 'now' })
    expect(isFinishedRestoreStatus('completed')).toBe(true)
    expect(isFinishedRestoreStatus('failed')).toBe(true)
    expect(isFinishedRestoreStatus('expired')).toBe(true)
    expect(isFinishedRestoreStatus('executing')).toBe(false)
    clearStoredRestorePlan()
    expect(loadStoredRestorePlan()).toBeNull()
  })
})
