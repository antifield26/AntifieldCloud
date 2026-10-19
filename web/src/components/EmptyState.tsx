import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cx } from '../lib/classnames'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  className?: string
}

/** 空态：必须告诉用户下一步可以做什么。 */
export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cx('empty-state', compact && 'empty-state-compact', className)}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon ?? <Inbox size={24} />}
      </span>
      <h3 className="empty-state-title">{title}</h3>
      {description ? <p className="empty-state-description">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  )
}
