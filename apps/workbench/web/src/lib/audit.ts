// 审计动作的中文名称与分类映射。
// 动作名以服务端实际写入值为准（mkdir/rename/move/trash/restore/purge/recovery_regenerate 等）。
// 未知动作原样展示，避免服务端新增动作时前端丢失信息。

export type AuditCategory =
  | 'auth'
  | 'file'
  | 'share'
  | 'whitelist'
  | 'knowledge'
  | 'alert'
  | 'backup'
  | 'chatbot'
  | 'other'

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
  // 服务端文件删除/清理实际动作名（v0.4.0 起）
  file_delete: { label: '删除文件', category: 'file' },
  file_hard_deleted: { label: '彻底删除文件', category: 'file' },
  file_removed: { label: '清理文件', category: 'file' },
  file_unavailable: { label: '文件不可用', category: 'file' },
  whitelist_add: { label: '添加白名单', category: 'whitelist' },
  whitelist_remove: { label: '移除白名单', category: 'whitelist' },
  share_create: { label: '创建分享', category: 'share' },
  share_revoke: { label: '吊销分享', category: 'share' },
  share_download: { label: '分享下载', category: 'share' },
  note_create: { label: '新建笔记', category: 'knowledge' },
  note_update: { label: '编辑笔记', category: 'knowledge' },
  note_delete: { label: '删除笔记', category: 'knowledge' },
  note_attachment_add: { label: '添加笔记附件', category: 'knowledge' },
  note_attachment_delete: { label: '删除笔记附件', category: 'knowledge' },
  note_version_restore: { label: '恢复笔记版本', category: 'knowledge' },
  bookmark_create: { label: '新建书签', category: 'knowledge' },
  bookmark_update: { label: '编辑书签', category: 'knowledge' },
  bookmark_delete: { label: '删除书签', category: 'knowledge' },
  alert_test: { label: '测试告警', category: 'alert' },
  alert_fire: { label: '触发告警', category: 'alert' },
  alert_recover: { label: '告警恢复', category: 'alert' },
  // v0.4.0：备份/恢复审计使用服务端实际动作名（旧动作名仅用于历史记录展示）
  backup_prepare: { label: '准备备份', category: 'backup' },
  backup_prepare_failed: { label: '准备备份失败', category: 'backup' },
  backup_prepare_timeout: { label: '准备备份超时', category: 'backup' },
  backup_import: { label: '导入归档', category: 'backup' },
  backup_verify: { label: '校验归档', category: 'backup' },
  backup_ack: { label: '确认归档', category: 'backup' },
  backup_missing_files: { label: '备份缺失文件', category: 'backup' },
  backup_legacy: { label: '历史归档', category: 'backup' },
  backup_restore_plan: { label: '创建恢复计划', category: 'backup' },
  backup_restore_execute: { label: '执行恢复', category: 'backup' },
  backup_restore_failed: { label: '恢复失败', category: 'backup' },
  backup_restore: { label: '恢复备份', category: 'backup' },
  backup_orphan: { label: '孤儿归档', category: 'backup' },
  // 历史轮次可能写入的旧动作名，保留展示映射，避免旧记录显示原始英文
  restore_plan: { label: '创建恢复计划', category: 'backup' },
  restore_execute: { label: '执行恢复', category: 'backup' },
  restore_failed: { label: '恢复失败', category: 'backup' },
  restore_complete: { label: '恢复完成', category: 'backup' },
  // v0.5.x–v0.6.x：QQ Chatbot / AI / 记忆（诊断与管理动作；不记录正文）
  'chatbot.create': { label: '创建 Chatbot', category: 'chatbot' },
  'chatbot.update': { label: '更新 Chatbot', category: 'chatbot' },
  'chatbot.delete': { label: '删除 Chatbot', category: 'chatbot' },
  'chatbot.test': { label: '测试 Chatbot', category: 'chatbot' },
  'chatbot.check': { label: '检查 Chatbot 连接', category: 'chatbot' },
  'chatbot.reset': { label: '重置 Chatbot 会话', category: 'chatbot' },
  'chatbot.target.create': { label: '创建 Chatbot 目标', category: 'chatbot' },
  'chatbot.target.update': { label: '更新 Chatbot 目标', category: 'chatbot' },
  'chatbot.target.delete': { label: '删除 Chatbot 目标', category: 'chatbot' },
  'chatbot.delivery.retry': { label: '重试 Chatbot 投递', category: 'chatbot' },
  'chatbot.delivery.partial': { label: 'Chatbot 投递部分失败', category: 'chatbot' },
  'chatbot.publish.create': { label: '创建 Chatbot 发布', category: 'chatbot' },
  'chatbot.publish.sent': { label: 'Chatbot 发布已发送', category: 'chatbot' },
  'chatbot.publish.cancel': { label: '取消 Chatbot 发布', category: 'chatbot' },
  'chatbot.publish.partial': { label: 'Chatbot 发布部分失败', category: 'chatbot' },
  'chatbot.command': { label: 'Chatbot 命令', category: 'chatbot' },
  'chatbot.command.denied': { label: 'Chatbot 命令被拒', category: 'chatbot' },
  'chatbot.command.disabled': { label: 'Chatbot 命令禁用', category: 'chatbot' },
  'chatbot.chat': { label: 'Chatbot Chat', category: 'chatbot' },
  'chatbot.chat.denied': { label: 'Chatbot Chat 被拒', category: 'chatbot' },
  'chatbot.ai.chat': { label: 'Chatbot AI 对话', category: 'chatbot' },
  'chatbot.ai.context_failed': { label: 'Chatbot AI 上下文失败', category: 'chatbot' },
  'chatbot.ai.image': { label: 'Chatbot AI 图片', category: 'chatbot' },
  'chatbot.ai.send': { label: 'Chatbot AI 发送工具', category: 'chatbot' },
  'chatbot.ai.send_fallback': { label: 'Chatbot AI 发送降级', category: 'chatbot' },
  'chatbot.ai.tool_call_text': { label: 'Chatbot AI 工具调用文本兜底', category: 'chatbot' },
  'chatbot.ai.permissions_fallback': { label: 'Chatbot AI 工具隔离降级', category: 'chatbot' },
  'chatbot.ai.tool_mode_reset': { label: 'Chatbot AI 工具模式重置', category: 'chatbot' },
  'chatbot.ai.orphan_sessions_removed': { label: '清理 Chatbot 孤儿会话', category: 'chatbot' },
  'chatbot.search': { label: 'Chatbot 搜索', category: 'chatbot' },
  'chatbot.memory.extract': { label: 'Chatbot 记忆抽取', category: 'chatbot' },
  'chatbot.memory.toggle': { label: 'Chatbot 记忆开关', category: 'chatbot' },
  'chatbot.memory.delete_item': { label: '删除 Chatbot 记忆条目', category: 'chatbot' },
  'chatbot.memory.delete_user': { label: '删除 Chatbot 用户记忆', category: 'chatbot' },
  'chatbot.memory.forget': { label: 'Chatbot 忘记记忆', category: 'chatbot' },
  'chatbot.memory.admin': { label: 'Chatbot 记忆管理', category: 'chatbot' },
  'chatbot.role': { label: 'Chatbot 角色卡', category: 'chatbot' },
  'chatbot.role.admin': { label: 'Chatbot 角色卡管理', category: 'chatbot' },
  'chatbot.group_role.admin': { label: 'Chatbot 群角色卡管理', category: 'chatbot' },
  'chatbot.webhook.challenge': { label: 'Chatbot Webhook 校验', category: 'chatbot' },
  'chatbot.webhook.rejected': { label: 'Chatbot Webhook 拒绝', category: 'chatbot' },
  'chatbot.webhook.rate_limited': { label: 'Chatbot Webhook 限流', category: 'chatbot' },
  'chatbot.event.ignored': { label: 'Chatbot 事件忽略', category: 'chatbot' },
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
      { value: 'file_hard_deleted', label: '彻底删除文件' },
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
      { value: 'note_attachment_add', label: '添加笔记附件' },
      { value: 'note_attachment_delete', label: '删除笔记附件' },
      { value: 'note_version_restore', label: '恢复笔记版本' },
      { value: 'bookmark_create', label: '新建书签' },
      { value: 'bookmark_update', label: '编辑书签' },
      { value: 'bookmark_delete', label: '删除书签' },
    ],
  },
  {
    label: '备份与恢复',
    options: [
      { value: 'backup_prepare', label: '准备备份' },
      { value: 'backup_prepare_failed', label: '准备备份失败' },
      { value: 'backup_prepare_timeout', label: '准备备份超时' },
      { value: 'backup_import', label: '导入归档' },
      { value: 'backup_verify', label: '校验归档' },
      { value: 'backup_ack', label: '确认归档' },
      { value: 'backup_restore_plan', label: '创建恢复计划' },
      { value: 'backup_restore_execute', label: '执行恢复' },
      { value: 'backup_restore_failed', label: '恢复失败' },
    ],
  },
  {
    label: '机器人',
    options: [
      { value: 'chatbot.create', label: '创建 Chatbot' },
      { value: 'chatbot.update', label: '更新 Chatbot' },
      { value: 'chatbot.delete', label: '删除 Chatbot' },
      { value: 'chatbot.test', label: '测试 Chatbot' },
      { value: 'chatbot.check', label: '检查 Chatbot 连接' },
      { value: 'chatbot.reset', label: '重置 Chatbot 会话' },
      { value: 'chatbot.target.create', label: '创建 Chatbot 目标' },
      { value: 'chatbot.target.update', label: '更新 Chatbot 目标' },
      { value: 'chatbot.target.delete', label: '删除 Chatbot 目标' },
      { value: 'chatbot.delivery.retry', label: '重试 Chatbot 投递' },
      { value: 'chatbot.delivery.partial', label: 'Chatbot 投递部分失败' },
      { value: 'chatbot.publish.create', label: '创建 Chatbot 发布' },
      { value: 'chatbot.publish.sent', label: 'Chatbot 发布已发送' },
      { value: 'chatbot.publish.cancel', label: '取消 Chatbot 发布' },
      { value: 'chatbot.publish.partial', label: 'Chatbot 发布部分失败' },
      { value: 'chatbot.command', label: 'Chatbot 命令' },
      { value: 'chatbot.command.denied', label: 'Chatbot 命令被拒' },
      { value: 'chatbot.chat', label: 'Chatbot Chat' },
      { value: 'chatbot.ai.chat', label: 'Chatbot AI 对话' },
      { value: 'chatbot.ai.context_failed', label: 'Chatbot AI 上下文失败' },
      { value: 'chatbot.ai.image', label: 'Chatbot AI 图片' },
      { value: 'chatbot.ai.permissions_fallback', label: 'Chatbot AI 工具隔离降级' },
      { value: 'chatbot.memory.extract', label: 'Chatbot 记忆抽取' },
      { value: 'chatbot.memory.toggle', label: 'Chatbot 记忆开关' },
      { value: 'chatbot.memory.delete_item', label: '删除 Chatbot 记忆条目' },
      { value: 'chatbot.memory.delete_user', label: '删除 Chatbot 用户记忆' },
      { value: 'chatbot.role.admin', label: 'Chatbot 角色卡管理' },
      { value: 'chatbot.group_role.admin', label: 'Chatbot 群角色卡管理' },
      { value: 'chatbot.webhook.rejected', label: 'Chatbot Webhook 拒绝' },
      { value: 'chatbot.event.ignored', label: 'Chatbot 事件忽略' },
    ],
  },
]

/* ---------- 活动时间范围筛选（v0.4.0） ---------- */

export type AuditTimeRange = 'all' | '1h' | '24h' | '7d' | '30d'

export interface AuditTimeRangeOption {
  value: AuditTimeRange
  label: string
  /** 距今天数；all 为 null */
  hours: number | null
}

export const AUDIT_TIME_RANGES: AuditTimeRangeOption[] = [
  { value: 'all', label: '全部时间', hours: null },
  { value: '1h', label: '最近 1 小时', hours: 1 },
  { value: '24h', label: '最近 24 小时', hours: 24 },
  { value: '7d', label: '最近 7 天', hours: 24 * 7 },
  { value: '30d', label: '最近 30 天', hours: 24 * 30 },
]

/** 把时间范围选项换算为服务端 from 参数（ISO 8601 UTC）；全部时间返回 null。 */
export function auditTimeRangeFrom(range: AuditTimeRange, now = Date.now()): string | null {
  const option = AUDIT_TIME_RANGES.find((item) => item.value === range)
  if (!option || option.hours === null) return null
  return new Date(now - option.hours * 3_600_000).toISOString()
}

export function auditTimeRangeLabel(range: AuditTimeRange): string {
  return AUDIT_TIME_RANGES.find((item) => item.value === range)?.label ?? range
}
