/**
 * Bot AI 回答的平台化格式转换：把模型输出的 Markdown 转成各平台可安全展示的文本。
 * 安全边界：只做转义与受支持的标签/标记转换，不引入 HTML/链接注入；调用方必须先做
 * 内部路径/URL 清洗（sanitize），本模块不再放行任何未清洗的 URL。
 */
import type { BotPlatform } from './types.ts'

export interface FormattedReply {
  text: string
  /** Telegram 需要 parse_mode=HTML；其余平台按 plain 发送。 */
  textMode: 'plain' | 'html'
}

/** 外部链接只允许 http(s)；其余按纯文本处理，避免 javascript: 等注入。 */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim())
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Telegram HTML：先整体转义，再只放入受支持标签。 */
function toTelegramHtml(markdown: string): string {
  const escaped = escapeHtml(markdown.replace(/\r\n?/g, '\n'))
  const lines = escaped.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    const fence = /^```(.*)$/.exec(line)
    if (fence) {
      out.push(inFence ? '</pre>' : '<pre>')
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      out.push(`<b>${inlineTelegram(heading[1]!)}</b>`)
      continue
    }
    out.push(inlineTelegram(line))
  }
  if (inFence) out.push('</pre>')
  return out.join('\n')
}

/** Telegram 行内标记：code、粗体、斜体；顺序避免 ** 被单个 * 提前消费。 */
function inlineTelegram(text: string): string {
  let result = text
  result = result.replace(/`([^`\n]+)`/g, (_all, code: string) => `<code>${code}</code>`)
  result = result.replace(/\*\*([^*\n]+)\*\*/g, (_all, bold: string) => `<b>${bold}</b>`)
  result = result.replace(/__([^_\n]+)__/g, (_all, bold: string) => `<b>${bold}</b>`)
  result = result.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_all, lead: string, italic: string) => `${lead}<i>${italic}</i>`)
  result = result.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label: string, url: string) =>
    isSafeUrl(url) ? `<a href="${url}">${label}</a>` : all,
  )
  return result
}

/** Discord 原生支持大部分 Markdown；只把不被支持的标题转成粗体。 */
function toDiscordMarkdown(markdown: string): string {
  return markdown.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Slack 行内标记：`**粗**` → `*粗*`，`*斜*` → `_斜_`。 */
function inlineSlack(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_all, bold: string) => `*${bold}*`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_all, lead: string, italic: string) => `${lead}_${italic}_`)
    .replace(/`([^`\n]+)`/g, (_all, code: string) => `\`${code}\``)
}

/** Slack mrkdwn：`**粗**` → `*粗*`，`*斜*` → `_斜_`，标题转粗体。 */
function toSlackMrkdwn(markdown: string): string {
  const escaped = escapeSlack(markdown.replace(/\r\n?/g, '\n'))
  const lines = escaped.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    out.push(heading ? `*${inlineSlack(heading[1]!)}*` : inlineSlack(line))
  }
  return out.join('\n')
}

/** QQ 仅文本：去掉 Markdown 标记，保留可读正文。 */
function toQqPlain(markdown: string): string {
  return markdown
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) =>
      isSafeUrl(url) ? `${label}（${url}）` : label,
    )
}

/** 平台化 AI 回答；空文本返回空串（调用方跳过发送）。 */
export function formatAiReply(platform: BotPlatform, markdown: string): FormattedReply {
  const text = markdown.replace(/\r\n?/g, '\n').trim()
  if (!text) return { text: '', textMode: 'plain' }
  switch (platform) {
    case 'telegram':
      return { text: toTelegramHtml(text), textMode: 'html' }
    case 'slack':
      return { text: toSlackMrkdwn(text), textMode: 'plain' }
    case 'discord':
      return { text: toDiscordMarkdown(text), textMode: 'plain' }
    case 'qq':
      return { text: toQqPlain(text), textMode: 'plain' }
  }
}
