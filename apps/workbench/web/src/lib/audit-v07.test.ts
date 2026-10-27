// v0.7.0 审计动作映射：Bot/备份/附件等新动作必须有中文与分组，未知动作保持原样。
import { describe, expect, it } from 'vitest'
import { AUDIT_ACTION_GROUPS, auditActionMeta, auditCategory } from './audit'

describe('审计动作映射 v0.7.0', () => {
  it('Bot 动作映射到机器人分类且不再显示原始英文', () => {
    expect(auditActionMeta('bot.create')).toMatchObject({ label: '创建 Bot', category: 'bot' })
    expect(auditActionMeta('bot.memory.extract').category).toBe('bot')
    expect(auditActionMeta('bot.webhook.rejected').category).toBe('bot')
    expect(auditCategory('bot.ai.permissions_fallback')).toBe('bot')
  })

  it('备份/附件/文件动作有中文映射', () => {
    expect(auditActionMeta('backup_prepare_failed').label).toBe('准备备份失败')
    expect(auditActionMeta('backup_ack').label).toBe('确认归档')
    expect(auditActionMeta('note_attachment_add').label).toBe('添加笔记附件')
    expect(auditActionMeta('note_version_restore').label).toBe('恢复笔记版本')
    expect(auditActionMeta('file_hard_deleted').label).toBe('彻底删除文件')
  })

  it('筛选分组含机器人分组且覆盖所有已映射动作', () => {
    const groups = new Map(AUDIT_ACTION_GROUPS.map((group) => [group.label, group.options.map((option) => option.value)]))
    expect(groups.has('机器人')).toBe(true)
    expect(groups.get('机器人')).toContain('bot.memory.toggle')
    expect(groups.get('备份与恢复')).toContain('backup_ack')
    expect(groups.get('知识库')).toContain('note_attachment_delete')
  })

  it('未知动作原样展示（不丢信息）', () => {
    expect(auditActionMeta('future.action')).toEqual({ label: 'future.action', category: 'other' })
  })
})
