// 手动准备备份：只生成 Pi 端 pending 归档，不拉取、不 ack；需要 TOTP 再认证。
import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Archive } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'

export interface PrepareBackupDialogProps {
  open: boolean
  onClose: () => void
  onPrepared: () => void
}

const TOTP_PATTERN = /^\d{6}$/

export function PrepareBackupDialog({ open, onClose, onPrepared }: PrepareBackupDialogProps) {
  const [totpCode, setTotpCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const totpId = useId()

  useEffect(() => {
    if (!open) return
    setTotpCode('')
    setBusy(false)
    setError(null)
  }, [open])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (!TOTP_PATTERN.test(totpCode.trim())) {
      setError('请输入 6 位 TOTP 验证码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.backups.prepare(totpCode.trim())
      const name = result.archiveName ?? result.pending?.[0]?.name
      onPrepared()
      if (name) {
        onClose()
      } else {
        setError('服务端未返回归档名，请刷新后确认 pending 状态')
      }
    } catch (prepareError) {
      setError(toErrorMessage(prepareError, '准备备份失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="准备一次备份"
      description="只生成 pending 归档，Windows 任务之后拉取并确认；不会推进备份游标。"
      size="md"
      onClose={busy ? () => undefined : onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={busy}
            icon={<Archive size={16} aria-hidden="true" />}
          >
            准备备份
          </Button>
        </>
      }
    >
      <form id={formId} className="backup-import-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="notice notice-info">
          生成后需等待 Windows 计划任务拉取并校验；Pi 不会自动删除 pending 归档。
        </div>
        <FormField label="TOTP 验证码" htmlFor={totpId} hint="危险操作需要二次验证；验证码不会保存。" required>
          <input
            id={totpId}
            className="input settings-totp-input"
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            disabled={busy}
          />
        </FormField>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
      </form>
    </Modal>
  )
}
