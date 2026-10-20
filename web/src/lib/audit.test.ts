import { describe, expect, it } from 'vitest'
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_TIME_RANGES,
  auditActionMeta,
  auditCategory,
  auditTimeRangeFrom,
  auditTimeRangeLabel,
} from './audit'

describe('audit 动作映射', () => {
  it('映射服务端真实动作名', () => {
    expect(auditActionMeta('mkdir')).toEqual({ label: '新建文件夹', category: 'file' })
    expect(auditActionMeta('rename')).toEqual({ label: '重命名', category: 'file' })
    expect(auditActionMeta('move')).toEqual({ label: '移动文件', category: 'file' })
    expect(auditActionMeta('trash')).toEqual({ label: '删除文件', category: 'file' })
    expect(auditActionMeta('restore')).toEqual({ label: '恢复文件', category: 'file' })
    expect(auditActionMeta('purge')).toEqual({ label: '彻底删除', category: 'file' })
    expect(auditActionMeta('recovery_regenerate')).toEqual({ label: '重新生成恢复码', category: 'auth' })
    expect(auditActionMeta('password_change_failed')).toEqual({ label: '修改密码失败', category: 'auth' })
  })

  it('未知动作原样展示，不丢信息', () => {
    expect(auditActionMeta('custom_event')).toEqual({ label: 'custom_event', category: 'other' })
    expect(auditCategory('custom_event')).toBe('other')
  })

  it('筛选分组包含服务端动作且无重复', () => {
    const values = AUDIT_ACTION_GROUPS.flatMap((group) => group.options.map((option) => option.value))
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain('mkdir')
    expect(values).toContain('recovery_regenerate')
    expect(values).toContain('whitelist_remove')
    // v0.4.0：备份/恢复筛选使用服务端实际写入的动作名
    expect(values).toContain('backup_restore_plan')
    expect(values).toContain('backup_restore_execute')
    expect(values).toContain('backup_restore_failed')
    expect(values).not.toContain('restore_plan')
    // 服务端没有 download 审计，筛选里不再提供，避免永远空结果
    expect(values).not.toContain('download')
  })

  it('旧动作名仍保留展示映射', () => {
    expect(auditActionMeta('restore_execute')).toEqual({ label: '执行恢复', category: 'backup' })
    expect(auditActionMeta('backup_restore_failed')).toEqual({ label: '恢复失败', category: 'backup' })
  })
})

describe('audit 时间范围筛选', () => {
  it('全部时间不传 from，近期范围换算为 ISO UTC', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z')
    expect(auditTimeRangeFrom('all', now)).toBeNull()
    expect(auditTimeRangeFrom('1h', now)).toBe('2026-10-20T11:00:00.000Z')
    expect(auditTimeRangeFrom('24h', now)).toBe('2026-10-19T12:00:00.000Z')
    expect(auditTimeRangeFrom('7d', now)).toBe('2026-10-13T12:00:00.000Z')
    expect(auditTimeRangeFrom('30d', now)).toBe('2026-09-20T12:00:00.000Z')
  })

  it('范围选项与标签一一对应', () => {
    expect(AUDIT_TIME_RANGES.map((item) => item.value)).toEqual(['all', '1h', '24h', '7d', '30d'])
    expect(auditTimeRangeLabel('7d')).toBe('最近 7 天')
    expect(auditTimeRangeLabel('all')).toBe('全部时间')
  })
})
