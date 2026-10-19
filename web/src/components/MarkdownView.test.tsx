import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkdownView } from './MarkdownView'

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
})
