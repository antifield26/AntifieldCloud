import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cx } from '../lib/classnames'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
  )
}

/* ---------- 模态栈：只允许栈顶处理 Esc/Tab，非栈顶置为 inert ---------- */

let modalStack: string[] = []
const stackListeners = new Set<() => void>()

function notifyModalStack(): void {
  for (const listener of stackListeners) listener()
}

function pushModal(id: string): void {
  modalStack = [...modalStack.filter((item) => item !== id), id]
  notifyModalStack()
}

function removeModal(id: string): void {
  const next = modalStack.filter((item) => item !== id)
  if (next.length === modalStack.length) return
  modalStack = next
  notifyModalStack()
}

function isTopModal(id: string): boolean {
  return modalStack[modalStack.length - 1] === id
}

function subscribeModalStack(listener: () => void): () => void {
  stackListeners.add(listener)
  return () => {
    stackListeners.delete(listener)
  }
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

export interface ModalProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  size?: ModalSize
  busy?: boolean
  closeOnOverlay?: boolean
  hideClose?: boolean
  className?: string
  /** 外部提供的描述元素 id（如 ConfirmDialog 的提示文本） */
  ariaDescribedBy?: string
  /** 打开后优先聚焦的选择器（危险操作可默认聚焦取消按钮） */
  initialFocus?: string
}

/**
 * 模态对话框：Portal 渲染、焦点陷阱、Esc 关闭、遮罩点击关闭、恢复焦点与页面滚动。
 * busy 为 true 时禁止关闭，避免提交中丢失操作。
 * 支持嵌套（如分享一次性链接确认、恢复码未保存确认）：只有栈顶弹窗处理 Esc/Tab 并接收焦点，
 * 下层弹窗设置 inert/aria-hidden，避免两层 document 监听互相抢键盘事件。
 */
export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  size = 'md',
  busy = false,
  closeOnOverlay = true,
  hideClose = false,
  className,
  ariaDescribedBy,
  initialFocus,
}: ModalProps) {
  const titleId = useId()
  const descriptionId = useId()
  const modalId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  const isTopRef = useRef(true)
  const [isTop, setIsTop] = useState(true)
  onCloseRef.current = onClose
  busyRef.current = busy
  isTopRef.current = isTop

  // 入栈/出栈：open 期间注册为当前弹窗，栈变化时更新 isTop
  useEffect(() => {
    if (!open) return
    pushModal(modalId)
    setIsTop(isTopModal(modalId))
    const unsubscribe = subscribeModalStack(() => setIsTop(isTopModal(modalId)))
    return () => {
      unsubscribe()
      removeModal(modalId)
    }
  }, [open, modalId])

  // 页面滚动锁定与焦点恢复（每个弹窗独立保存，按 LIFO 恢复）
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [open])

  // 只有栈顶弹窗接收焦点、处理 Esc 与 Tab 焦点陷阱
  useEffect(() => {
    if (!open || !isTop) return
    const panel = panelRef.current
    if (!panel) return
    const focusTimer = window.setTimeout(() => {
      const preferred = initialFocus ? panel.querySelector<HTMLElement>(initialFocus) : null
      const autofocus = panel.querySelector<HTMLElement>('[data-autofocus]')
      const focusable = getFocusable(panel)
      const target = preferred ?? autofocus ?? focusable[0] ?? panel
      target.focus()
    }, 20)

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isTopRef.current) return
      if (event.key === 'Escape') {
        if (!busyRef.current) {
          event.preventDefault()
          event.stopPropagation()
          onCloseRef.current()
        }
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusable(panel)
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open, isTop, initialFocus])

  if (!open) return null

  return createPortal(
    <div
      className={cx('modal-overlay', !isTop && 'modal-overlay-inactive')}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (!isTop) return
        if (closeOnOverlay && !busy) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={cx('modal-panel', `modal-${size}`, className)}
        role="dialog"
        aria-modal={isTop ? 'true' : undefined}
        aria-hidden={isTop ? undefined : true}
        aria-labelledby={titleId}
        aria-describedby={ariaDescribedBy ?? (description ? descriptionId : undefined)}
        tabIndex={-1}
        inert={!isTop}
      >
        <header className="modal-header">
          <div className="modal-heading">
            <h2 className="modal-title" id={titleId}>{title}</h2>
            {description ? <p className="modal-description" id={descriptionId}>{description}</p> : null}
          </div>
          {hideClose ? null : (
            <button
              type="button"
              className="icon-btn modal-close"
              onClick={onClose}
              aria-label="关闭对话框"
              disabled={busy}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}
