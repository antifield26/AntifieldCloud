import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

// 预览内容一律视为不可信：禁止 style 标签/属性，外链统一新窗口打开。
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['style'],
}

/**
 * Markdown 图片只允许本站文件内容地址：/api/files/<id>/content（允许相对路径与 ?inline=1）。
 * 外链、协议相对、data:/blob:、路径穿越与非文件内容路径一律视为不可信并移除 src，
 * 避免预览内容把浏览器指向第三方或绕过鉴权读取任意路径。
 */
export function isAllowedMarkdownImageSrc(raw: string | null | undefined): boolean {
  if (!raw) return false
  const value = raw.trim()
  if (!value) return false
  // 协议相对地址（//evil.example）没有本站来源，直接拒绝
  if (value.startsWith('//')) return false
  const baseOrigin =
    typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? window.location.origin
      : null
  const fallbackOrigin = 'https://app.local.invalid'
  let resolved: URL
  try {
    // 显式带协议的地址必须与当前站点同源；相对路径按当前 origin（或占位 origin）解析
    resolved = new URL(value, baseOrigin ?? fallbackOrigin)
  } catch {
    return false
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return false
  if (resolved.origin !== (baseOrigin ?? fallbackOrigin)) return false
  // 不允许带凭据的 URL，避免伪装成同源
  if (resolved.username || resolved.password) return false
  if (!/^\/api\/files\/[^/]+\/content$/.test(resolved.pathname)) return false
  for (const key of resolved.searchParams.keys()) {
    if (key !== 'inline' && key !== 'download') return false
  }
  return true
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
    return
  }
  if (node.tagName !== 'IMG') return
  if (isAllowedMarkdownImageSrc(node.getAttribute('src'))) return
  // 阻止加载：移除地址，保留可读占位与说明
  const alt = node.getAttribute('alt')?.trim()
  node.removeAttribute('src')
  node.removeAttribute('srcset')
  node.setAttribute('data-blocked-image', '1')
  node.setAttribute('class', 'markdown-image-blocked')
  node.setAttribute('alt', alt ? `${alt}（外链图片已阻止）` : '外链图片已阻止')
})

export interface MarkdownViewProps {
  content: string
  className?: string
}

/**
 * Markdown 渲染：marked 解析后经 DOMPurify 净化，禁止脚本/事件属性。
 * 不使用 raw HTML 直出，预览内容始终视为不可信数据；图片只允许同源 /api/files/... 地址。
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
