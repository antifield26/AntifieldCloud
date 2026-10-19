import { useEffect, useState } from 'react'
import { Download, FileX } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { FileItem, TextPreviewResult } from '../../api/types'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { CopyButton } from '../CopyButton'
import { InlineError } from '../InlineError'
import { LoadingBlock } from '../Loading'
import { EmptyState } from '../EmptyState'
import { MarkdownView } from '../MarkdownView'
import { formatBytes } from '../../lib/format'

export interface PreviewModalProps {
  file: FileItem | null
  onClose: () => void
}

/**
 * 文件预览：图片 / PDF / 文本 / Markdown，其余类型展示信息与下载。
 * Markdown 使用 marked + DOMPurify；文本接口超过 1 MiB 会截断并提示。
 */
export function PreviewModal({ file, onClose }: PreviewModalProps) {
  const [text, setText] = useState<TextPreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [imageError, setImageError] = useState(false)

  const fileId = file?.id ?? null
  const previewKind = file?.previewKind ?? 'none'
  const isText = previewKind === 'text' || previewKind === 'markdown'

  useEffect(() => {
    setText(null)
    setError(null)
    setImageError(false)
    if (!fileId || !isText) return
    let active = true
    setLoading(true)
    api.files
      .getText(fileId)
      .then((result) => {
        if (active) setText(result)
      })
      .catch((loadError) => {
        if (active) setError(toErrorMessage(loadError, '读取文件内容失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [fileId, isText, reloadKey])

  if (!file) return null

  const downloadUrl = api.files.contentUrl(file.id, { download: true })
  const inlineUrl = api.files.contentUrl(file.id, { inline: true })
  const description = `${file.kind === 'dir' ? '文件夹' : formatBytes(file.size)}${file.mime ? ` · ${file.mime}` : ''}`

  const downloadLink = (
    <a className="btn btn-secondary btn-md" href={downloadUrl}>
      <Download size={16} aria-hidden="true" />
      <span className="btn-label">下载</span>
    </a>
  )

  return (
    <Modal
      open
      title={file.name}
      description={description}
      size={previewKind === 'pdf' ? 'xl' : 'lg'}
      onClose={onClose}
      footer={
        <div className="preview-footer">
          {isText && text ? <CopyButton value={text.content} label="复制内容" size="md" variant="secondary" /> : null}
          {file.kind === 'file' ? downloadLink : null}
          <Button variant="primary" onClick={onClose}>关闭</Button>
        </div>
      }
    >
      {previewKind === 'image' ? (
        imageError ? (
          <EmptyState
            icon={<FileX size={26} />}
            title="图片预览失败"
            description="文件可能已损坏或已被移动，可直接下载后查看。"
            action={downloadLink}
          />
        ) : (
          <div className="preview-image-wrap">
            <img
              className="preview-image"
              src={inlineUrl}
              alt={file.name}
              onError={() => setImageError(true)}
            />
          </div>
        )
      ) : null}

      {previewKind === 'pdf' ? (
        <iframe className="preview-pdf" title={`PDF 预览：${file.name}`} src={inlineUrl} />
      ) : null}

      {isText ? (
        loading ? (
          <LoadingBlock text="正在读取文件内容…" />
        ) : error ? (
          <InlineError message={error} onRetry={() => setReloadKey((value) => value + 1)} />
        ) : text ? (
          <div className="preview-text-wrap">
            {text.truncated ? (
              <div className="notice notice-warning">文件超过 1 MiB，仅显示前 1 MiB 内容。</div>
            ) : null}
            {previewKind === 'markdown' ? (
              <MarkdownView content={text.content} className="preview-markdown" />
            ) : (
              <pre className="preview-pre">{text.content}</pre>
            )}
          </div>
        ) : null
      ) : null}

      {previewKind === 'none' ? (
        <EmptyState
          icon={<FileX size={26} />}
          title="该类型不支持预览"
          description="为避免安全问题，此类文件只能下载到本地后打开。"
          action={downloadLink}
        />
      ) : null}
    </Modal>
  )
}
