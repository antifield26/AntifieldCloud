// 审计动作的中文名称与分类映射。
// 未知动作原样展示，避免服务端新增动作时前端丢失信息。

export type AuditCategory = 'auth' | 'file' | 'whitelist' | 'other'

export interface AuditActionMeta {
  label: string
  category: AuditCategory
}

const ACTION_META: Record<string, AuditActionMeta> = {
  login: { label: '登录成功', category: 'auth' },
  login_failed: { label: '登录失败', category: 'auth' },
  logout: { label: '退出登录', category: 'auth' },
  logout_all: { label: '退出全部会话', category: 'auth' },
  password_change: { label: '修改密码', category: 'auth' },
  recovery_codes: { label: '重新生成恢复码', category: 'auth' },
  upload: { label: '上传文件', category: 'file' },
  folder_create: { label: '新建文件夹', category: 'file' },
  file_rename: { label: '重命名', category: 'file' },
  file_move: { label: '移动文件', category: 'file' },
  file_delete: { label: '删除文件', category: 'file' },
  file_restore: { label: '恢复文件', category: 'file' },
  file_download: { label: '下载文件', category: 'file' },
  trash_delete: { label: '彻底删除', category: 'file' },
  trash_clear: { label: '清空回收站', category: 'file' },
  whitelist_add: { label: '添加白名单', category: 'whitelist' },
  whitelist_remove: { label: '移除白名单', category: 'whitelist' },
}

export function auditActionMeta(action: string): AuditActionMeta {
  return ACTION_META[action] ?? { label: action, category: 'other' }
}

export function auditCategory(action: string): AuditCategory {
  return auditActionMeta(action).category
}
