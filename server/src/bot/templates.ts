/**
 * Bot 回复模板：把只读 provider 的结构化数据格式化为平台纯文本。
 * 普通用户可见文案避免技术术语；安全边界：只输出白名单字段/截断后的值，不拼接原始 HTML 或密钥。
 */
import { DEFAULT_CHAT_ROLE, DEFAULT_CHAT_ROLE_SUMMARY } from './roles.ts'

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

export function helpText(platform: string): string {
  return clip(
    [
      `AntifieldCloud Bot（${platform}）只读命令：`,
      '/help 帮助',
      '/status 应用/服务/备份摘要',
      '/backup 备份状态',
      '/world 世界备份/拉取/演练状态',
      '/mc Minecraft 状态',
      '/files <关键词> 文件元数据（最多 10 条）',
      '/ask <问题> AI 对话（需管理员启用并限流）',
      '/role 给我换个样子（私聊里大家都能用）',
      '普通消息 Chat：目标开启允许 Chat 后，私聊直接对话；群/频道 @Bot 或回复 Bot 触发。',
      '除 /role 外，斜杠命令仅限已登记目标与管理员用户；不会返回文件内容或密钥。',
    ].join('\n'),
  )
}

/** 面向普通用户的角色用法；不出现内部术语、标记或实现细节。 */
export function roleUsage(): string {
  return [
    '我是 lofii，平时有点猫系，也会认真听你说话。',
    '你可以给我换个只属于你的样子（只影响我们私聊）：',
    '/role set 名字 你希望我是什么样',
    '/role show 看看现在的样子',
    '/role off 先收起你的专属样子',
    '/role on 再把专属样子放回来',
    '/role delete 删掉专属样子',
    '不设置也没关系，我会一直是默认的 lofii；群聊里大家看到的是默认的我。',
  ].join('\n')
}

export function roleDefaultText(): string {
  return `现在没有你的专属角色，我用的是默认的 ${DEFAULT_CHAT_ROLE.name}：${DEFAULT_CHAT_ROLE_SUMMARY}`
}

export function roleGroupHint(): string {
  return `群聊里大家看到的是默认的 ${DEFAULT_CHAT_ROLE.name}：${DEFAULT_CHAT_ROLE_SUMMARY}想给我换个只属于你的样子，可以私聊发 /role。`
}

export function commandDenied(): string {
  return '该目标未授权使用 Bot 命令。'
}

export function commandFailed(command: string): string {
  return `/${command} 查询失败，请稍后重试。`
}
