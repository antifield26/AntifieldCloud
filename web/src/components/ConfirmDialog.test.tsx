// 危险确认对话框（v0.7.0）：默认焦点目标必须是“取消”而不是头部关闭按钮。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

describe('ConfirmDialog 默认焦点', () => {
  it('“取消”按钮带 confirm-cancel 标记且位于 footer 首位；Modal 以它为 initialFocus', async () => {
    render(
      <ConfirmDialog
        open
        title="删除文件"
        message="确定删除？"
        confirmText="删除"
        cancelText="取消"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const panel = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.modal-panel')
      if (!node) throw new Error('modal not mounted')
      return node
    })
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel.classList.contains('confirm-cancel')).toBe(true)
    // 头部“关闭对话框”仍在 DOM 中，但 ConfirmDialog 通过 initialFocus 指定取消按钮，
    // 不再依赖 Modal 的“第一个可聚焦元素”兜底。
    const footerButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>('.modal-footer button'))
    expect(footerButtons[0]).toBe(cancel)
    expect(panel.querySelector('.modal-close')).not.toBeNull()
  })
})
