import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
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

function menuItems(menu: HTMLDivElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
}

/** 「更多操作」菜单：点击外部/Esc/Tab 关闭，支持上下方向键与 Home/End。 */
export function Dropdown({ items, ariaLabel, align = 'right', trigger, className }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const focusTrigger = (): void => {
    containerRef.current?.querySelector<HTMLButtonElement>('.dropdown-trigger-wrap button')?.focus()
  }

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    const focusTimer = window.setTimeout(() => {
      menuItems(menuRef.current)[0]?.focus()
    }, 0)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.clearTimeout(focusTimer)
    }
  }, [open])

  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) focusTrigger()
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const entries = menuItems(menuRef.current)
    if (entries.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const index = active ? entries.indexOf(active) : -1
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      close(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      let nextIndex: number
      if (event.key === 'ArrowDown') nextIndex = index < 0 || index >= entries.length - 1 ? 0 : index + 1
      else if (event.key === 'ArrowUp') nextIndex = index <= 0 ? entries.length - 1 : index - 1
      else if (event.key === 'Home') nextIndex = 0
      else nextIndex = entries.length - 1
      entries[nextIndex]?.focus()
    }
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
    }
  }

  const handleSelect = (item: DropdownItem): void => {
    if (item.disabled) return
    setOpen(false)
    item.onSelect()
  }

  return (
    <div className={cx('dropdown', className)} ref={containerRef}>
      <span className="dropdown-trigger-wrap">
        <Button
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={handleTriggerKeyDown}
          icon={trigger ?? <EllipsisVertical size={18} aria-hidden="true" />}
        />
      </span>
      {open ? (
        <div
          className={cx('dropdown-menu', `dropdown-menu-${align}`)}
          role="menu"
          aria-label={ariaLabel}
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
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
