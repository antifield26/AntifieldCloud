// 导入备份归档：multipart 单文件（≤100 MiB）+ TOTP 请求头，带进度与取消。
// 归档不进入文件配额；导入后服务端自动尝试验证，结果由父组件刷新列表并提示。

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Upload } from 'lucide-react'
import { toErrorMessage, uploadBackupArchive } from '../../api/client'
import type { BackupImportResult } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import { validateBackupFile } from '../../lib/backups'
import { formatBytes } from '../../lib/format'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'
import { ProgressBar } from '../ProgressBar'

export interface ImportArchiveDialogProps {
  open: boolean
  onClose: () => void
  onImported: (result: BackupImportResult) => void
}

const TOTP_PATTERN = /^\d{6}$/

export function ImportArchiveDialog({ open, onClose, onImported }: ImportArchiveDialogProps) {
  const { meta } = useAppMeta()
  const maxImportBytes = meta.backupImportMaxBytes
  const [file, setFile] = useState<File | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const formId = useId()
  const fileId = useId()
  const totpId = useId()

  useEffect(() => {
    if (!open) return
    setFile(null)
    setTotpCode('')
    setProgress(0)
    setBusy(false)
    setError(null)
    abortRef.current?.abort()
    abortRef.current = null
  }, [open])

  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    return () => {
      if (busyRef.current) abortRef.current?.abort()
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (!file) {
      setError('请选择要导入的备份归档')
      return
    }
    const fileError = validateBackupFile(file, maxImportBytes)
    if (fileError) {
      setError(fileError)
      return
    }
    if (!TOTP_PATTERN.test(totpCode.trim())) {
      setError('请输入 6 位 TOTP 验证码')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    setProgress(0)
    try {
      const result = await uploadBackupArchive(file, totpCode.trim(), {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          setProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0)
        },
      })
      onImported(result)
    } catch (uploadError) {
      setError(toErrorMessage(uploadError, '导入归档失败，请重试'))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  const cancelUpload = (): void => {
    abortRef.current?.abort()
  }

  return (
    <Modal
      open={open}
      title="导入备份归档"
      description={`选择 snapshot-*-[full|inc].tar.gz，单文件不超过 ${formatBytes(maxImportBytes, 0)}；导入需要 TOTP。`}
      size="md"
      onClose={busy ? () => undefined : onClose}
      busy={busy}
      footer={
        busy ? (
          <Button variant="danger" onClick={cancelUpload}>取消上传</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" type="submit" form={formId} icon={<Upload size={16} aria-hidden="true" />}>
              上传并导入
            </Button>
          </>
        )
      }
    >
      <form id={formId} className="backup-import-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="notice notice-warning">
          归档将保存到服务端 imports 目录并自动校验 SHA-256 与 tar 内容，失败不影响已有备份；导入操作记录审计。
          <br />
          加密归档 <span className="mono">*.tar.gz.age</span> 不提供 Web 导入：Web 不持有私钥，无法校验/恢复；请在 PC 端解密后按 docs/BACKUP.md 处理。
        </div>
        <FormField
          label="归档文件"
          htmlFor={fileId}
          hint="文件名需符合 snapshot-<名称>-(full|inc).tar.gz；加密 .age 归档请走 PC 离线流程。重复文件名会被拒绝。"
          required
        >
          <input
            ref={inputRef}
            id={fileId}
            className="input backup-file-input"
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              setFile(selected)
              setError(null)
              if (selected) {
                const fileError = validateBackupFile(selected, maxImportBytes)
                if (fileError) setError(fileError)
              }
            }}
            disabled={busy}
          />
        </FormField>
        {file ? (
          <p className="field-hint">
            已选择 <span className="mono">{file.name}</span>（{formatBytes(file.size)}）
          </p>
        ) : null}
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
        {busy ? (
          <div className="backup-import-progress">
            <div className="settings-list-row">
              <dt>上传进度</dt>
              <dd>{progress}%</dd>
            </div>
            <ProgressBar value={progress} tone="accent" ariaLabel={`归档上传进度 ${progress}%`} />
          </div>
        ) : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
      </form>
    </Modal>
  )
}
