// 创建文件分享链接：密码、过期时间、最大下载次数与备注。
// 链接只在创建响应中返回一次，弹窗内提示先复制再关闭。

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { ExternalLink } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { CreateShareResult, FileItem } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'
import { CopyButton } from '../CopyButton'
import { ConfirmDialog } from '../ConfirmDialog'
import { formatDateTime } from '../../lib/format'
import { absoluteShareUrl, shouldProtectShareLinkClose } from '../../lib/share-link'

export interface ShareDialogProps {
  file: FileItem | null
  onClose: () => void
}

// 不传 expiresInHours 时后端按默认 168 小时（7 天）处理；当前不提供“永不过期”。
const EXPIRES_OPTIONS = [
  { value: '', label: '默认（7 天）' },
  { value: '24', label: '1 天' },
  { value: '72', label: '3 天' },
  { value: '168', label: '7 天' },
  { value: '720', label: '30 天' },
  { value: '1', label: '1 小时' },
]

export function ShareDialog({ file, onClose }: ShareDialogProps) {
  const { meta } = useAppMeta()
  const [password, setPassword] = useState('')
  const [expires, setExpires] = useState('')
  const [maxDownloads, setMaxDownloads] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CreateShareResult | null>(null)
  const [linkSaved, setLinkSaved] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const formId = useId()

  const open = file !== null
  const shareUrl = result ? absoluteShareUrl(result.url, meta.appOrigin) : ''

  useEffect(() => {
    if (!open) return
    setPassword('')
    setExpires('')
    setMaxDownloads('')
    setNote('')
    setBusy(false)
    setError(null)
    setResult(null)
    setLinkSaved(false)
    setConfirmClose(false)
  }, [open, file?.id])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!file) return
    setError(null)
    if (password && password.length < 8) {
      setError('分享密码至少需要 8 个字符')
      return
    }
    let max: number | undefined
    if (maxDownloads.trim()) {
      const parsed = Number(maxDownloads)
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError('最大下载次数需要是大于 0 的整数')
        return
      }
      max = parsed
    }
    setBusy(true)
    try {
      const input: Record<string, string | number> = {}
      if (password) input.password = password
      if (expires) input.expiresInHours = Number(expires)
      if (max !== undefined) input.maxDownloads = max
      if (note.trim()) input.note = note.trim()
      const created = await api.files.createShare(file.id, input)
      setResult(created)
    } catch (createError) {
      setError(toErrorMessage(createError, '创建分享失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (busy) return
    onClose()
  }

  // 一次性链接未复制/打开时，关闭（含 Esc/遮罩/完成）需要二次确认
  const requestClose = (): void => {
    if (busy) return
    if (shouldProtectShareLinkClose(Boolean(result), linkSaved)) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  return (
    <>
      <Modal
        open={open}
        title={result ? '分享链接已创建' : '分享文件'}
        description={file ? `为「${file.name}」创建公开下载链接` : undefined}
        size="md"
        onClose={requestClose}
        busy={busy}
        footer={
          result ? (
            <>
              <CopyButton
                value={shareUrl}
                label="复制链接"
                size="md"
                variant="secondary"
                onCopied={() => setLinkSaved(true)}
              />
              <a
                className="btn btn-secondary btn-md"
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setLinkSaved(true)}
              >
                <ExternalLink size={16} aria-hidden="true" />
                <span className="btn-label">打开链接</span>
              </a>
              <Button variant="primary" onClick={requestClose}>完成</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>取消</Button>
              <Button variant="primary" type="submit" form={formId} loading={busy}>创建链接</Button>
            </>
          )
        }
      >
      {result ? (
        <div className="share-result">
          <div className="notice notice-warning">
            分享链接只显示这一次，请立即复制保存；关闭后可在“分享管理”中查看状态，但不会再次显示完整链接。
          </div>
          <p className="share-result-url mono">{shareUrl}</p>
          <dl className="settings-list">
            <div className="settings-list-row">
              <dt>文件</dt>
              <dd>{result.share.fileName}</dd>
            </div>
            <div className="settings-list-row">
              <dt>过期时间</dt>
              <dd>{result.share.expiresAt ? formatDateTime(result.share.expiresAt) : '永不过期'}</dd>
            </div>
            <div className="settings-list-row">
              <dt>最大下载次数</dt>
              <dd>{result.share.maxDownloads ?? '不限'}</dd>
            </div>
            <div className="settings-list-row">
              <dt>密码保护</dt>
              <dd>{result.share.hasPassword ? '已设置' : '无'}</dd>
            </div>
            {result.share.note ? (
              <div className="settings-list-row">
                <dt>备注</dt>
                <dd>{result.share.note}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : (
        <form id={formId} className="share-form" onSubmit={(event) => void handleSubmit(event)}>
          <FormField label="分享密码" htmlFor="share-password" hint="可选；至少 8 个字符，访问者需输入密码才能下载。">
            <input
              id="share-password"
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={busy}
            />
          </FormField>
          <FormField label="有效期" htmlFor="share-expires" hint="默认 7 天；最长 30 天。">
            <select
              id="share-expires"
              className="select share-select"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
              disabled={busy}
            >
              {EXPIRES_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </FormField>
          <FormField label="最大下载次数" htmlFor="share-max-downloads" hint="留空表示不限次数。">
            <input
              id="share-max-downloads"
              className="input"
              type="number"
              min={1}
              step={1}
              value={maxDownloads}
              onChange={(event) => setMaxDownloads(event.target.value)}
              placeholder="不限"
              disabled={busy}
            />
          </FormField>
          <FormField label="备注" htmlFor="share-note" hint="仅自己可见，便于识别链接用途。">
            <input
              id="share-note"
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </FormField>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
        </form>
      )}
      </Modal>

      <ConfirmDialog
        open={confirmClose}
        title="关闭分享链接窗口"
        message="分享链接只显示一次，关闭后将无法再次查看完整链接。"
        details="请先复制或打开链接；关闭后可在“分享管理”查看状态，但无法恢复完整 URL。"
        confirmText="仍然关闭"
        cancelText="返回保存"
        onConfirm={() => {
          setConfirmClose(false)
          onClose()
        }}
        onClose={() => setConfirmClose(false)}
      />
    </>
  )
}
