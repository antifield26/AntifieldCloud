import type { ReactNode } from 'react'
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

/** 表单字段容器：负责 label 关联、说明与错误提示。 */
export function FormField({ label, htmlFor, hint, error, required = false, className, children }: FormFieldProps) {
  return (
    <div className={cx('field', error ? 'field-invalid' : null, className)}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="field-required" aria-hidden="true">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">{error}</p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  )
}
