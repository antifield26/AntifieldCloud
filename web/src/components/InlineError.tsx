import { CircleAlert } from 'lucide-react'
import { Button } from './Button'
import { cx } from '../lib/classnames'

export interface InlineErrorProps {
  message: string
  onRetry?: () => void
  retryLabel?: string
  className?: string
}

/** 卡片/区块内的错误提示，附带重试入口。 */
export function InlineError({ message, onRetry, retryLabel = '重试', className }: InlineErrorProps) {
  return (
    <div className={cx('inline-error', className)} role="alert">
      <CircleAlert size={18} className="inline-error-icon" aria-hidden="true" />
      <span className="inline-error-message">{message}</span>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}
