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
  | 'bot'
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
  // v0.5.x–v0.6.x：QQ Bot / AI / 记忆（诊断与管理动作；不记录正文）
  'bot.create': { label: '创建 Bot', category: 'bot' },
  'bot.update': { label: '更新 Bot', category: 'bot' },
  'bot.delete': { label: '删除 Bot', category: 'bot' },
  'bot.test': { label: '测试 Bot', category: 'bot' },
  'bot.check': { label: '检查 Bot 连接', category: 'bot' },
  'bot.reset': { label: '重置 Bot 会话', category: 'bot' },
  'bot.target.create': { label: '创建 Bot 目标', category: 'bot' },
  'bot.target.update': { label: '更新 Bot 目标', category: 'bot' },
  'bot.target.delete': { label: '删除 Bot 目标', category: 'bot' },
  'bot.delivery.retry': { label: '重试 Bot 投递', category: 'bot' },
  'bot.delivery.partial': { label: 'Bot 投递部分失败', category: 'bot' },
  'bot.publish.create': { label: '创建 Bot 发布', category: 'bot' },
  'bot.publish.sent': { label: 'Bot 发布已发送', category: 'bot' },
  'bot.publish.cancel': { label: '取消 Bot 发布', category: 'bot' },
  'bot.publish.partial': { label: 'Bot 发布部分失败', category: 'bot' },
  'bot.command': { label: 'Bot 命令', category: 'bot' },
  'bot.command.denied': { label: 'Bot 命令被拒', category: 'bot' },
  'bot.command.disabled': { label: 'Bot 命令禁用', category: 'bot' },
  'bot.chat': { label: 'Bot Chat', category: 'bot' },
  'bot.chat.denied': { label: 'Bot Chat 被拒', category: 'bot' },
  'bot.ai.chat': { label: 'Bot AI 对话', category: 'bot' },
  'bot.ai.image': { label: 'Bot AI 图片', category: 'bot' },
  'bot.ai.send': { label: 'Bot AI 发送工具', category: 'bot' },
  'bot.ai.send_fallback': { label: 'Bot AI 发送降级', category: 'bot' },
  'bot.ai.tool_call_text': { label: 'Bot AI 工具调用文本兜底', category: 'bot' },
  'bot.ai.permissions_fallback': { label: 'Bot AI 工具隔离降级', category: 'bot' },
  'bot.ai.tool_mode_reset': { label: 'Bot AI 工具模式重置', category: 'bot' },
  'bot.ai.orphan_sessions_removed': { label: '清理 Bot 孤儿会话', category: 'bot' },
  'bot.search': { label: 'Bot 搜索', category: 'bot' },
  'bot.memory.extract': { label: 'Bot 记忆抽取', category: 'bot' },
  'bot.memory.toggle': { label: 'Bot 记忆开关', category: 'bot' },
  'bot.memory.delete_item': { label: '删除 Bot 记忆条目', category: 'bot' },
  'bot.memory.delete_user': { label: '删除 Bot 用户记忆', category: 'bot' },
  'bot.memory.forget': { label: 'Bot 忘记记忆', category: 'bot' },
  'bot.memory.admin': { label: 'Bot 记忆管理', category: 'bot' },
  'bot.role': { label: 'Bot 角色卡', category: 'bot' },
  'bot.role.admin': { label: 'Bot 角色卡管理', category: 'bot' },
  'bot.group_role.admin': { label: 'Bot 群角色卡管理', category: 'bot' },
  'bot.webhook.challenge': { label: 'Bot Webhook 校验', category: 'bot' },
  'bot.webhook.rejected': { label: 'Bot Webhook 拒绝', category: 'bot' },
  'bot.webhook.rate_limited': { label: 'Bot Webhook 限流', category: 'bot' },
  'bot.event.ignored': { label: 'Bot 事件忽略', category: 'bot' },
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
      { value: 'bot.create', label: '创建 Bot' },
      { value: 'bot.update', label: '更新 Bot' },
      { value: 'bot.delete', label: '删除 Bot' },
      { value: 'bot.test', label: '测试 Bot' },
      { value: 'bot.check', label: '检查 Bot 连接' },
      { value: 'bot.reset', label: '重置 Bot 会话' },
      { value: 'bot.target.create', label: '创建 Bot 目标' },
      { value: 'bot.target.update', label: '更新 Bot 目标' },
      { value: 'bot.target.delete', label: '删除 Bot 目标' },
      { value: 'bot.delivery.retry', label: '重试 Bot 投递' },
      { value: 'bot.delivery.partial', label: 'Bot 投递部分失败' },
      { value: 'bot.publish.create', label: '创建 Bot 发布' },
      { value: 'bot.publish.sent', label: 'Bot 发布已发送' },
      { value: 'bot.publish.cancel', label: '取消 Bot 发布' },
      { value: 'bot.publish.partial', label: 'Bot 发布部分失败' },
      { value: 'bot.command', label: 'Bot 命令' },
      { value: 'bot.command.denied', label: 'Bot 命令被拒' },
      { value: 'bot.chat', label: 'Bot Chat' },
      { value: 'bot.ai.chat', label: 'Bot AI 对话' },
      { value: 'bot.ai.image', label: 'Bot AI 图片' },
      { value: 'bot.ai.permissions_fallback', label: 'Bot AI 工具隔离降级' },
      { value: 'bot.memory.extract', label: 'Bot 记忆抽取' },
      { value: 'bot.memory.toggle', label: 'Bot 记忆开关' },
      { value: 'bot.memory.delete_item', label: '删除 Bot 记忆条目' },
      { value: 'bot.memory.delete_user', label: '删除 Bot 用户记忆' },
      { value: 'bot.role.admin', label: 'Bot 角色卡管理' },
      { value: 'bot.group_role.admin', label: 'Bot 群角色卡管理' },
      { value: 'bot.webhook.rejected', label: 'Bot Webhook 拒绝' },
      { value: 'bot.event.ignored', label: 'Bot 事件忽略' },
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
