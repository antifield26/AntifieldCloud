import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { EllipsisVertical } from 'lucide-react'
import { Button } from './Button'
import { cx } from '../lib/classnames'

export interface DropdownItem {
  key: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

export interface DropdownProps {
  items: DropdownItem[]
  ariaLabel: string
  align?: 'left' | 'right'
  trigger?: ReactNode
  className?: string
}

/** 「更多操作」菜单：点击外部或 Esc 关闭，打开后焦点移到第一项。 */
export function Dropdown({ items, ariaLabel, align = 'right', trigger, className }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    const focusTimer = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    }, 0)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.clearTimeout(focusTimer)
    }
  }, [open])

  const handleSelect = (item: DropdownItem): void => {
    if (item.disabled) return
    setOpen(false)
    item.onSelect()
  }

  return (
    <div className={cx('dropdown', className)} ref={containerRef}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        icon={trigger ?? <EllipsisVertical size={18} aria-hidden="true" />}
      />
      {open ? (
        <div className={cx('dropdown-menu', `dropdown-menu-${align}`)} role="menu" ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={cx('dropdown-item', item.danger && 'dropdown-item-danger')}
              disabled={item.disabled}
              onClick={() => handleSelect(item)}
            >
              {item.icon ? <span className="dropdown-item-icon" aria-hidden="true">{item.icon}</span> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
