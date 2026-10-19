import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from './Button'
import type { ButtonSize, ButtonVariant } from './Button'
import { copyText } from '../lib/clipboard'
import { useToast } from './Toast'
import { cx } from '../lib/classnames'

export interface CopyButtonProps {
  value: string
  label?: string
  copiedLabel?: string
  size?: ButtonSize
  variant?: ButtonVariant
  iconOnly?: boolean
  ariaLabel?: string
  className?: string
  disabled?: boolean
}

/** 复制按钮：成功后 1.8s 内显示勾选与「已复制」反馈。 */
export function CopyButton({
  value,
  label = '复制',
  copiedLabel = '已复制',
  size = 'sm',
  variant = 'ghost',
  iconOnly = false,
  ariaLabel,
  className,
  disabled = false,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  const toast = useToast()

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const handleCopy = async (): Promise<void> => {
    const ok = await copyText(value)
    if (!ok) {
      toast.error('复制失败，请手动选择文本后进行复制')
      return
    }
    setCopied(true)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={cx('copy-button', className)}
      icon={copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      aria-label={ariaLabel ?? (copied ? copiedLabel : label)}
      title={copied ? copiedLabel : label}
      disabled={disabled}
      onClick={() => void handleCopy()}
    >
      {iconOnly ? null : copied ? copiedLabel : label}
    </Button>
  )
}
