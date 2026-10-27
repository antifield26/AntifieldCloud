// 手动准备备份：只生成 Pi 端 pending 归档，不拉取、不 ack；需要 TOTP 再认证。
// v0.7.0：prepare 是服务端长任务（上限 BACKUP_PREPARE_TIMEOUT_SEC 默认 3300s）：
// - 成功时展示 warnings/skippedMissing（物理文件缺失被跳过，不能当作“完整备份”）；
// - 客户端超时/网络中断时提示“服务端可能仍在执行”，禁止直接重复提交（会 409 backup_busy）。
import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Archive, ShieldAlert } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BackupPrepareResult } from '../../api/types'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'

export interface PrepareBackupDialogProps {
  open: boolean
  onClose: () => void
  /** 结果已生成（可能不完整）；null 表示请求中断、服务端可能仍在执行，需要刷新列表确认。 */
  onPrepared: (result: BackupPrepareResult | null) => void
}

const TOTP_PATTERN = /^\d{6}$/

const INTERRUPTED_MESSAGE =
  '请求超时或网络中断，但服务端可能仍在生成备份；请勿重复提交（会返回“已有备份任务”）。稍后刷新备份列表查看 pending 归档即可。'

export function PrepareBackupDialog({ open, onClose, onPrepared }: PrepareBackupDialogProps) {
  const [totpCode, setTotpCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BackupPrepareResult | null>(null)
  const [interrupted, setInterrupted] = useState(false)
  const formId = useId()
  const totpId = useId()

  useEffect(() => {
    if (!open) return
    setTotpCode('')
    setBusy(false)
    setError(null)
    setResult(null)
    setInterrupted(false)
  }, [open])

  const finish = (): void => {
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (!TOTP_PATTERN.test(totpCode.trim())) {
      setError('请输入 6 位 TOTP 验证码')
      return
    }
    setBusy(true)
    setError(null)
    setInterrupted(false)
    try {
      const prepared = await api.backups.prepare(totpCode.trim())
      const name = prepared.archiveName ?? prepared.pending?.[0]?.name
      if (!name) {
        setError('服务端未返回归档名，请刷新后确认 pending 状态')
        return
      }
      setResult(prepared)
      onPrepared(prepared)
      const incomplete =
        (prepared.skippedMissing?.length ?? 0) > 0 || (prepared.warnings?.length ?? 0) > 0
      if (!incomplete) finish()
    } catch (prepareError) {
      const code =
        prepareError && typeof prepareError === 'object'
          ? ((prepareError as { code?: unknown }).code as string | undefined)
          : undefined
      if (code === 'timeout' || code === 'network_error') {
        setInterrupted(true)
        onPrepared(null)
      } else {
        setError(toErrorMessage(prepareError, '准备备份失败，请重试'))
      }
    } finally {
      setBusy(false)
    }
  }

  const skippedCount = result?.skippedMissing?.length ?? 0
  const warnings = result?.warnings ?? []
  const showResult = result !== null || interrupted

  return (
    <Modal
      open={open}
      title="准备一次备份"
      description="只生成 pending 归档，Windows 任务之后拉取并确认；不会推进备份游标。"
      size="md"
      onClose={busy ? () => undefined : onClose}
      busy={busy}
      footer={
        showResult ? (
          <Button variant="primary" onClick={interrupted ? onClose : finish}>
            关闭
          </Button>
        ) : (
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
        )
      }
    >
      <form id={formId} className="backup-import-form" onSubmit={(event) => void handleSubmit(event)}>
        {!showResult ? (
          <div className="notice notice-info">
            生成后需等待 Windows 计划任务拉取并校验；Pi 不会自动删除 pending 归档。
          </div>
        ) : null}

        {showResult ? (
          <>
            {result ? (
              <div className="notice notice-success" role="status">
                <Archive size={16} aria-hidden="true" />
                <div>
                  <strong>已生成 pending 备份</strong>
                  <p className="field-hint">
                    {result.archiveName ?? '（未返回归档名）'}
                    {result.encrypted ? '（加密归档，PC 需 age 私钥解密校验）' : ''}
                  </p>
                </div>
              </div>
            ) : (
              <div className="notice notice-warning" role="alert">
                <ShieldAlert size={16} aria-hidden="true" />
                <div>
                  <strong>备份请求中断</strong>
                  <p>{INTERRUPTED_MESSAGE}</p>
                </div>
              </div>
            )}
            {skippedCount > 0 ? (
              <div className="notice notice-warning" role="alert">
                <ShieldAlert size={16} aria-hidden="true" />
                <div>
                  <strong>备份未包含全部文件</strong>
                  <p>
                    {skippedCount} 个物理文件缺失已被跳过；游标不会越过缺失项，下次 prepare 会自动补入。请先恢复缺失文件再重跑备份。
                  </p>
                </div>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div className="notice notice-warning" role="alert">
                <div>
                  <strong>服务端警告</strong>
                  <ul>
                    {warnings.slice(0, 8).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {!showResult ? (
          <>
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
          </>
        ) : null}
      </form>
    </Modal>
  )
}
