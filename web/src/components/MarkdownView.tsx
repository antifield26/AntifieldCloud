import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

// 外链统一新窗口打开，避免预览跳转丢失当前页面。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export interface MarkdownViewProps {
  content: string
  className?: string
}

/**
 * Markdown 渲染：marked 解析后经 DOMPurify 净化，禁止脚本/事件属性。
 * 不使用 raw HTML 直出，预览内容始终视为不可信数据。
 */
export function MarkdownView({ content, className }: MarkdownViewProps) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    let active = true
    void Promise.resolve(marked.parse(content))
      .then((parsed) => {
        if (!active) return
        setHtml(DOMPurify.sanitize(parsed, { USE_PROFILES: { html: true } }))
      })
      .catch(() => {
        if (active) setHtml('')
      })
    return () => {
      active = false
    }
  }, [content])

  return <div className={className ? `markdown-body ${className}` : 'markdown-body'} dangerouslySetInnerHTML={{ __html: html }} />
}
