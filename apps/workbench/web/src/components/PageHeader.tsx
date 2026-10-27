import type { ReactNode } from 'react'
import { cx } from '../lib/classnames'

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}

/** 页面页头：标题 + 说明 + 右侧操作区。 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cx('page-header', className)}>
      <div className="page-heading">
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}
