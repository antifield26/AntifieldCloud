/**
 * Bot 回复模板：把只读 provider 的结构化数据格式化为 QQ 纯文本。
 * 普通用户可见文案避免技术术语；安全边界：只输出白名单字段/截断后的值，不拼接原始 HTML 或密钥。
 */
import { DEFAULT_CHAT_ROLE } from './roles.ts'

const MAX_REPLY = 3500

export function clip(value: string, max = MAX_REPLY): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function scalar(value: unknown, max = 120): string {
  if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ').slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return '—'
  return '—'
}

export function formatPairs(title: string, data: Record<string, unknown>): string {
  const lines: string[] = [`【${title}】`]
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') {
      const nested = Object.entries(value as Record<string, unknown>)
        .map(([nestedKey, nestedValue]) => `${nestedKey}=${scalar(nestedValue)}`)
        .join(' ')
      lines.push(`${key}: ${clip(nested, 300)}`)
    } else {
      lines.push(`${key}: ${scalar(value)}`)
    }
    if (lines.join('\n').length > MAX_REPLY - 80) {
      lines.push('…')
      break
    }
  }
  return clip(lines.join('\n'))
}

export function formatFileList(query: string, files: Record<string, unknown>[]): string {
  if (files.length === 0) return `没有匹配“${clip(query, 40)}”的文件`
  const lines = [`【文件】${clip(query, 40)}（最多 10 条）`]
  for (const file of files) {
    lines.push(`- ${scalar(file.name, 120)} (${scalar(file.sizeLabel ?? file.size, 20)})`)
  }
  return clip(lines.join('\n'))
}

/** 管理员完整命令帮助：只输出命令列表，不带标题、说明或用法注释；命令仅在 C2C 私聊可用。 */
export function helpText(): string {
  return clip(
    [
      '/help',
      '/status',
      '/backup',
      '/world',
      '/mc',
      '/files',
      '/role',
      '/reset',
      '/forget',
      '/memory',
      '/search',
    ].join('\n'),
  )
}

/** 面向非管理员的公开帮助：只输出命令列表，不带标题、说明或用法注释；命令仅在 C2C 私聊可用。 */
export function publicHelpText(): string {
  return clip(
    [
      '/help',
      '/role',
      '/reset',
      '/forget',
      '/memory',
      '/search',
    ].join('\n'),
  )
}

/** 面向普通用户的角色命令用法；只列当前角色与分支命令，不注入角色个性。 */
export function roleUsage(): string {
  return [
    '可用命令：',
    '/role set <名字> <设定> 设置专属角色',
    '/role show 查看当前角色',
    '/role off 暂停专属角色',
    '/role on 启用专属角色',
    '/role delete 删除专属角色',
    '专属角色只影响私聊；群聊由管理员在 Web 配置独立角色卡。',
  ].join('\n')
}

export function roleDefaultText(): string {
  return `当前角色：${DEFAULT_CHAT_ROLE.name}（默认）`
}

/** `/role show`：用户设置了角色卡时返回完整设定文本；默认角色卡只返回名称，不暴露内置设定。 */
export function roleShowText(card: { name: string; prompt: string; enabled: boolean } | null): string {
  if (!card) return roleDefaultText()
  return [
    `当前角色：${card.name}（专属，${card.enabled ? '使用中' : '已暂停'}）`,
    '角色卡详情：',
    card.prompt,
  ].join('\n')
}

export function roleGroupHint(): string {
  return '群聊角色由管理员在 Web“角色与记忆”中配置；群聊/频道不再接受斜杠命令。'
}

export function commandDenied(): string {
  return '该目标未授权使用 Bot 命令。'
}

export function commandFailed(command: string): string {
  return `/${command} 查询失败，请稍后重试。`
}
