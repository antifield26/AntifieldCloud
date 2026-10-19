// 审计动作的中文名称与分类映射。
// 动作名以服务端实际写入值为准（mkdir/rename/move/trash/restore/purge/recovery_regenerate 等）。
// 未知动作原样展示，避免服务端新增动作时前端丢失信息。

export type AuditCategory = 'auth' | 'file' | 'share' | 'whitelist' | 'knowledge' | 'alert' | 'other'

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
  password_change_failed: { label: '修改密码失败', category: 'auth' },
  recovery_regenerate: { label: '重新生成恢复码', category: 'auth' },
  recovery_regenerate_failed: { label: '重新生成恢复码失败', category: 'auth' },
  upload: { label: '上传文件', category: 'file' },
  mkdir: { label: '新建文件夹', category: 'file' },
  rename: { label: '重命名', category: 'file' },
  move: { label: '移动文件', category: 'file' },
  trash: { label: '删除文件', category: 'file' },
  restore: { label: '恢复文件', category: 'file' },
  purge: { label: '彻底删除', category: 'file' },
  download: { label: '下载文件', category: 'file' },
  whitelist_add: { label: '添加白名单', category: 'whitelist' },
  whitelist_remove: { label: '移除白名单', category: 'whitelist' },
  share_create: { label: '创建分享', category: 'share' },
  share_revoke: { label: '吊销分享', category: 'share' },
  share_download: { label: '分享下载', category: 'share' },
  note_create: { label: '新建笔记', category: 'knowledge' },
  note_update: { label: '编辑笔记', category: 'knowledge' },
  note_delete: { label: '删除笔记', category: 'knowledge' },
  bookmark_create: { label: '新建书签', category: 'knowledge' },
  bookmark_update: { label: '编辑书签', category: 'knowledge' },
  bookmark_delete: { label: '删除书签', category: 'knowledge' },
  alert_test: { label: '测试告警', category: 'alert' },
  alert_fire: { label: '触发告警', category: 'alert' },
  alert_recover: { label: '告警恢复', category: 'alert' },
}

export function auditActionMeta(action: string): AuditActionMeta {
  return ACTION_META[action] ?? { label: action, category: 'other' }
}

export function auditCategory(action: string): AuditCategory {
  return auditActionMeta(action).category
}

export interface AuditActionOption {
  value: string
  label: string
}

export interface AuditActionGroup {
  label: string
  options: AuditActionOption[]
}

/** Activity 类型筛选：服务端动作精确匹配，按业务分组展示。 */
export const AUDIT_ACTION_GROUPS: AuditActionGroup[] = [
  {
    label: '登录与账号',
    options: [
      { value: 'login', label: '登录成功' },
      { value: 'login_failed', label: '登录失败' },
      { value: 'logout', label: '退出登录' },
      { value: 'logout_all', label: '退出全部会话' },
      { value: 'password_change', label: '修改密码' },
      { value: 'password_change_failed', label: '修改密码失败' },
      { value: 'recovery_regenerate', label: '重新生成恢复码' },
      { value: 'recovery_regenerate_failed', label: '重新生成恢复码失败' },
    ],
  },
  {
    label: '文件',
    options: [
      { value: 'upload', label: '上传文件' },
      { value: 'mkdir', label: '新建文件夹' },
      { value: 'rename', label: '重命名' },
      { value: 'move', label: '移动文件' },
      { value: 'trash', label: '删除文件' },
      { value: 'restore', label: '恢复文件' },
      { value: 'purge', label: '彻底删除' },
      { value: 'download', label: '下载文件' },
    ],
  },
  {
    label: '分享',
    options: [
      { value: 'share_create', label: '创建分享' },
      { value: 'share_revoke', label: '吊销分享' },
      { value: 'share_download', label: '分享下载' },
    ],
  },
  {
    label: '白名单',
    options: [
      { value: 'whitelist_add', label: '添加白名单' },
      { value: 'whitelist_remove', label: '移除白名单' },
    ],
  },
  {
    label: '知识库',
    options: [
      { value: 'note_create', label: '新建笔记' },
      { value: 'note_update', label: '编辑笔记' },
      { value: 'note_delete', label: '删除笔记' },
      { value: 'bookmark_create', label: '新建书签' },
      { value: 'bookmark_update', label: '编辑书签' },
      { value: 'bookmark_delete', label: '删除书签' },
    ],
  },
]
