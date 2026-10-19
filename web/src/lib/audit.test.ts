import { describe, expect, it } from 'vitest'
import { AUDIT_ACTION_GROUPS, auditActionMeta, auditCategory } from './audit'

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
  })
})
