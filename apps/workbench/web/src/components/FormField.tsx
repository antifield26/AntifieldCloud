import { cloneElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../lib/classnames'

export interface FormFieldProps {
  label: string
  htmlFor: string
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
  children: ReactNode
}

/**
 * 表单字段容器：负责 label 关联、说明与错误提示。
 * required 通过 aria-required 传给控件；错误时标记 aria-invalid。
 */
export function FormField({ label, htmlFor, hint, error, required = false, className, children }: FormFieldProps) {
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-required': required || undefined,
        'aria-invalid': error ? true : undefined,
      })
    : children

  return (
    <div className={cx('field', error ? 'field-invalid' : null, className)}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="field-required" aria-hidden="true">*</span> : null}
      </label>
      {control}
      {error ? (
        <p className="field-error" role="alert">{error}</p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  )
}
