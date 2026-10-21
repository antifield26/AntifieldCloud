/**
 * Bot 回复模板：把只读 provider 的结构化数据格式化为平台纯文本。
 * 安全边界：只输出白名单字段/截断后的值，不拼接原始 HTML 或密钥。
 */
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
      '命令仅限已登记目标；不会返回文件内容或密钥。',
    ].join('\n'),
  )
}

export function commandDenied(): string {
  return '该目标未授权使用 Bot 命令。'
}

export function commandFailed(command: string): string {
  return `/${command} 查询失败，请稍后重试。`
}
