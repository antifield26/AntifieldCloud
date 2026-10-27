/**
 * Chatbot AI 回答的 QQ 纯文本格式化：QQ 官方 Chatbot 只支持文本，去掉 Markdown 标记后发送。
 * 安全边界：只做标记剥离，不引入 HTML/链接注入；调用方必须先做内部路径/URL 清洗。
 */

/** 外部链接只允许 http(s) 前缀才保留为文字；其余按纯文本处理。 */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim())
}

/** QQ 仅文本：去掉 Markdown 标记，保留可读正文。 */
export function formatAiReply(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
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
    .trim()
}
