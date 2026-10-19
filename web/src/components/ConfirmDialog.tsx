import { useId } from 'react'
import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from './Button'
import { Modal } from './Modal'
import { cx } from '../lib/classnames'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  details?: ReactNode
  confirmText?: string
  cancelText?: string
  tone?: 'danger' | 'primary'
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
}

/** 二次确认对话框：危险操作默认红色确认按钮，提交期间不可关闭。 */
export function ConfirmDialog({
  open,
  title,
  message,
  details,
  confirmText = '确认',
  cancelText = '取消',
  tone = 'danger',
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const messageId = useId()
  return (
    <Modal
      open={open}
      size="sm"
      title={title}
      ariaDescribedBy={messageId}
      onClose={loading ? () => undefined : onClose}
      busy={loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className={cx('confirm-body', tone === 'danger' && 'confirm-danger')}>
        {tone === 'danger' ? (
          <span className="confirm-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
        ) : null}
        <div className="confirm-copy">
          <p className="confirm-message" id={messageId}>{message}</p>
          {details ? <div className="confirm-details">{details}</div> : null}
        </div>
      </div>
    </Modal>
  )
}
