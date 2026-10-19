import type { ReactNode } from 'react'
import { SkeletonText } from './Skeleton'
import { InlineError } from './InlineError'
import { cx } from '../lib/classnames'

export interface CardProps {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
  loading?: boolean
  skeleton?: ReactNode
  error?: string | null
  onRetry?: () => void
  flush?: boolean
}

/** 基础面板：标题区 + 内容区，内置加载骨架与错误重试。 */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  loading = false,
  skeleton,
  error,
  onRetry,
  flush = false,
}: CardProps) {
  const hasHeader = Boolean(title || description || actions)
  return (
    <section className={cx('card', className)}>
      {hasHeader ? (
        <header className="card-header">
          <div className="card-heading">
            {title ? <h2 className="card-title">{title}</h2> : null}
            {description ? <p className="card-description">{description}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('card-body', flush && 'card-body-flush', bodyClassName)}>
        {loading ? (
          (skeleton ?? <SkeletonText lines={4} />)
        ) : error ? (
          <InlineError message={error} onRetry={onRetry} />
        ) : (
          children
        )}
      </div>
    </section>
  )
}
