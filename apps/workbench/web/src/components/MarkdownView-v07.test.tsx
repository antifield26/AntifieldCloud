// Markdown 净化加固（v0.7.0）：class/id 与 style 一并移除，防止笔记预览仿冒应用 UI。
import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MarkdownView } from './MarkdownView'

describe('MarkdownView v0.7.0 净化', () => {
  it('移除 class/id/style 属性，保留文本与安全链接', async () => {
    const { container } = render(
      <MarkdownView
        content={'<div class="btn btn-primary" id="fake-login" style="color:red">仿冒按钮</div>\n\n[链接](https://example.com)'}
      />,
    )
    await waitFor(() => {
      const body = container.querySelector('.markdown-body')
      expect(body?.querySelector('div')).not.toBeNull()
    })
    const body = container.querySelector('.markdown-body') as HTMLElement
    expect(body.querySelector('div')?.getAttribute('class')).toBeNull()
    expect(body.querySelector('div')?.getAttribute('id')).toBeNull()
    expect(body.querySelector('div')?.getAttribute('style')).toBeNull()
    const link = body.querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(body.textContent).toContain('仿冒按钮')
  })
})
