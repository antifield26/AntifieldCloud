import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

// 预览内容一律视为不可信：禁止 style 标签/属性，外链统一新窗口打开。
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['style'],
}

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
        setHtml(DOMPurify.sanitize(parsed, SANITIZE_CONFIG))
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
