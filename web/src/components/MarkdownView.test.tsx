import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkdownView, isAllowedMarkdownImageSrc } from './MarkdownView'

afterEach(cleanup)

describe('MarkdownView 净化', () => {
  it('禁用脚本、style 标签与 style 属性，外链安全打开', async () => {
    const content = [
      '# 安全标题',
      '',
      '<script>window.__xss = true</script>',
      '',
      '<style>body { display: none }</style>',
      '',
      '<p style="color:red" onclick="alert(1)">带样式的段落</p>',
      '',
      '[链接](https://example.com)',
    ].join('\n')

    const { container } = render(<MarkdownView content={content} />)
    await waitFor(() => {
      expect(container.querySelector('.markdown-body')?.textContent).toContain('安全标题')
    })

    const body = container.querySelector('.markdown-body')
    expect(body).not.toBeNull()
    expect(body?.querySelector('script')).toBeNull()
    expect(body?.querySelector('style')).toBeNull()
    expect(body?.querySelector('[style]')).toBeNull()
    expect(body?.querySelector('[onclick]')).toBeNull()

    const link = body?.querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noopener')
  })

  it('允许同源文件内容图片，阻止外链与路径穿越', async () => {
    const content = [
      '![本站附件](/api/files/abc-123/content?inline=1)',
      '',
      '![相对路径](./api/files/def-456/content)',
      '',
      '![外链](https://evil.example/track.png)',
      '',
      '![协议相对](//evil.example/track.png)',
      '',
      '![穿越](/api/files/../../etc/passwd/content)',
      '',
      '![数据](data:image/png;base64,AAAA)',
    ].join('\n')

    const { container } = render(<MarkdownView content={content} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.markdown-body img').length).toBe(6)
    })

    const images = Array.from(container.querySelectorAll('.markdown-body img'))
    const allowed = images.filter((image) => image.getAttribute('data-blocked-image') !== '1')
    const blocked = images.filter((image) => image.getAttribute('data-blocked-image') === '1')

    expect(allowed).toHaveLength(2)
    expect(allowed[0]?.getAttribute('src')).toBe('/api/files/abc-123/content?inline=1')
    expect(allowed[1]?.getAttribute('src')).toBe('./api/files/def-456/content')
    expect(blocked).toHaveLength(4)
    for (const image of blocked) {
      expect(image.getAttribute('src')).toBeNull()
      expect(image.getAttribute('alt')).toContain('外链图片已阻止')
    }
  })
})

describe('isAllowedMarkdownImageSrc', () => {
  const origin = window.location.origin

  it('只允许本站 /api/files/<id>/content', () => {
    expect(isAllowedMarkdownImageSrc('/api/files/abc/content?inline=1')).toBe(true)
    expect(isAllowedMarkdownImageSrc('./api/files/abc/content')).toBe(true)
    expect(isAllowedMarkdownImageSrc('/api/files/abc/content?download=1')).toBe(true)
    expect(isAllowedMarkdownImageSrc(`${origin}/api/files/abc/content`)).toBe(true)
    expect(isAllowedMarkdownImageSrc('/api/files/abc/content?foo=1')).toBe(false)
    expect(isAllowedMarkdownImageSrc('/api/files/abc/preview')).toBe(false)
    expect(isAllowedMarkdownImageSrc('/api/notes/abc/content')).toBe(false)
    expect(isAllowedMarkdownImageSrc('/api/files//content')).toBe(false)
    expect(isAllowedMarkdownImageSrc('https://app.local.invalid/api/files/abc/content')).toBe(false)
  })

  it('拒绝空值、外链、协议相对与非 http(s) 协议', () => {
    expect(isAllowedMarkdownImageSrc(null)).toBe(false)
    expect(isAllowedMarkdownImageSrc('   ')).toBe(false)
    expect(isAllowedMarkdownImageSrc('https://evil.example/a.png')).toBe(false)
    expect(isAllowedMarkdownImageSrc('//evil.example/a.png')).toBe(false)
    expect(isAllowedMarkdownImageSrc('data:image/png;base64,AAAA')).toBe(false)
    expect(isAllowedMarkdownImageSrc('javascript:alert(1)')).toBe(false)
    expect(isAllowedMarkdownImageSrc('blob:https://app.local.invalid/uuid')).toBe(false)
  })
})
