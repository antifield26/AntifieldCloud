import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from './Modal'

afterEach(cleanup)

function Harness({ onCloseA, onCloseB }: { onCloseA: () => void; onCloseB: () => void }) {
  const [bOpen, setBOpen] = useState(false)
  return (
    <>
      <Modal open title="第一层" className="modal-a" onClose={onCloseA}>
        <button type="button" onClick={() => setBOpen(true)}>打开第二层</button>
        <button type="button">第一层第二个按钮</button>
      </Modal>
      <Modal open={bOpen} title="第二层" className="modal-b" onClose={onCloseB}>
        <button type="button" onClick={() => setBOpen(false)}>关闭第二层</button>
        <button type="button">第二层第二个按钮</button>
      </Modal>
    </>
  )
}

function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.modal-panel'))
}

describe('Modal 栈与焦点', () => {
  it('只有栈顶弹窗处理 Esc', async () => {
    const onCloseA = vi.fn()
    const onCloseB = vi.fn()
    render(<Harness onCloseA={onCloseA} onCloseB={onCloseB} />)

    await waitFor(() => expect(panels()).toHaveLength(1))
    await userEvent.keyboard('{Escape}')
    expect(onCloseA).toHaveBeenCalledTimes(1)
    expect(onCloseB).not.toHaveBeenCalled()
  })

  it('嵌套弹窗时下层 inert/aria-hidden，Esc 只关栈顶', async () => {
    const onCloseA = vi.fn()
    const onCloseB = vi.fn()
    render(<Harness onCloseA={onCloseA} onCloseB={onCloseB} />)

    await userEvent.click(screen.getByRole('button', { name: '打开第二层' }))
    await waitFor(() => expect(panels()).toHaveLength(2))

    const [lower, upper] = panels()
    expect(lower?.getAttribute('aria-hidden')).toBe('true')
    expect(lower?.hasAttribute('inert')).toBe(true)
    expect(upper?.hasAttribute('inert')).toBe(false)
    expect(upper?.getAttribute('aria-hidden')).toBeNull()

    await userEvent.keyboard('{Escape}')
    expect(onCloseB).toHaveBeenCalledTimes(1)
    expect(onCloseA).not.toHaveBeenCalled()
  })

  it('Tab 焦点陷阱只作用在栈顶弹窗', async () => {
    const onCloseA = vi.fn()
    const onCloseB = vi.fn()
    render(<Harness onCloseA={onCloseA} onCloseB={onCloseB} />)

    await userEvent.click(screen.getByRole('button', { name: '打开第二层' }))
    await waitFor(() => expect(panels()).toHaveLength(2))

    const upper = panels()[1]
    await waitFor(() => expect(upper?.contains(document.activeElement)).toBe(true))

    // 连续 Tab 始终停留在栈顶弹窗内
    for (let index = 0; index < 5; index += 1) {
      await userEvent.tab()
      expect(upper?.contains(document.activeElement)).toBe(true)
    }
    await userEvent.tab({ shift: true })
    expect(upper?.contains(document.activeElement)).toBe(true)
  })

  it('栈顶弹窗关闭后，下层弹窗恢复键盘处理', async () => {
    const onCloseA = vi.fn()
    const onCloseB = vi.fn()
    render(<Harness onCloseA={onCloseA} onCloseB={onCloseB} />)

    await userEvent.click(screen.getByRole('button', { name: '打开第二层' }))
    await waitFor(() => expect(panels()).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', { name: '关闭第二层' }))
    await waitFor(() => expect(panels()).toHaveLength(1))

    const [onlyPanel] = panels()
    expect(onlyPanel?.hasAttribute('inert')).toBe(false)
    await userEvent.keyboard('{Escape}')
    expect(onCloseA).toHaveBeenCalledTimes(1)
  })
})
