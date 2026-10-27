import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { toErrorMessage } from '../../api/client'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'

export interface NameDialogProps {
  open: boolean
  title: string
  label: string
  initialValue?: string
  submitText: string
  placeholder?: string
  hint?: string
  onClose: () => void
  onSubmit: (value: string) => Promise<void>
}

/** 新建文件夹 / 重命名共用的单输入对话框。 */
export function NameDialog({
  open,
  title,
  label,
  initialValue = '',
  submitText,
  placeholder,
  hint,
  onClose,
  onSubmit,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const formId = useId()

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setError(null)
    setBusy(false)
  }, [open, initialValue])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      setError('名称不能为空')
      return
    }
    if (trimmed.length > 255) {
      setError('名称不能超过 255 个字符')
      return
    }
    if (/[\\/]/.test(trimmed)) {
      setError('名称不能包含斜杠')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
    } catch (submitError) {
      setError(toErrorMessage(submitError, '操作失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={busy ? () => undefined : onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>{submitText}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <FormField
          label={label}
          htmlFor={inputId}
          hint={hint}
          error={error}
          required
        >
          <input
            id={inputId}
            className="input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            maxLength={255}
            data-autofocus
            disabled={busy}
          />
        </FormField>
      </form>
    </Modal>
  )
}
