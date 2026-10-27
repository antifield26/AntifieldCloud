import type { ReactNode } from 'react'
import { cx } from '../lib/classnames'

export type BadgeTone = 'success' | 'warning' | 'danger' | 'muted' | 'accent' | 'info'

export interface BadgeProps {
  tone?: BadgeTone
  dot?: boolean
  children: ReactNode
  className?: string
  title?: string
}

/** 状态徽章：始终带文字，不依赖颜色单独传达状态。 */
export function Badge({ tone = 'muted', dot = false, children, className, title }: BadgeProps) {
  return (
    <span className={cx('badge', `badge-${tone}`, className)} title={title}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}
