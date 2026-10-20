// 媒体预览：浏览器原生 video/audio + Range 播放；失败时映射为可读提示并回退下载。
// 不引入外部播放器、不转码、不缓存内容；服务端负责 inline/Range/ETag。

import { useEffect, useState } from 'react'
import type { SyntheticEvent } from 'react'
import { Download, FileWarning } from 'lucide-react'
import type { FileItem } from '../../api/types'
import { mediaErrorMessage, mediaKindOf, mediaInlineAllowed, mediaMimeHint } from '../../lib/media'
import { EmptyState } from '../EmptyState'

export interface MediaPreviewProps {
  file: FileItem
  inlineUrl: string
  downloadUrl: string
}

export function MediaPreview({ file, inlineUrl, downloadUrl }: MediaPreviewProps) {
  const kind = mediaKindOf(file.previewKind) ?? 'video'
  const [errorCode, setErrorCode] = useState<number | null>(null)
  const [httpStatus, setHttpStatus] = useState<number | null>(null)
  const inlineAllowed = mediaInlineAllowed(file.inlineAllowed)

  useEffect(() => {
    setErrorCode(null)
    setHttpStatus(null)
  }, [file.id])

  const downloadLink = (
    <a className="btn btn-secondary btn-md" href={downloadUrl}>
      <Download size={16} aria-hidden="true" />
      <span className="btn-label">下载文件</span>
    </a>
  )

  const handleError = (event: SyntheticEvent<HTMLMediaElement>): void => {
    const mediaError = event.currentTarget.error
    setErrorCode(mediaError ? mediaError.code : null)
    // 原生元素只给 MediaError；再 HEAD 一次以区分 415/416/401/404 等服务端状态
    void fetch(inlineUrl, { method: 'HEAD', credentials: 'include' })
      .then((response) => setHttpStatus(response.status))
      .catch(() => setHttpStatus(null))
  }

  if (!inlineAllowed) {
    return (
      <EmptyState
        icon={<FileWarning size={26} />}
        title="该媒体不允许内联播放"
        description="服务端未允许内联返回该文件，请下载后播放。"
        action={downloadLink}
      />
    )
  }

  const errorInfo = errorCode === null && httpStatus === null ? null : mediaErrorMessage(errorCode, httpStatus)

  return (
    <div className="media-preview">
      {errorInfo ? (
        <EmptyState
          icon={<FileWarning size={26} />}
          title={errorInfo.title}
          description={errorInfo.description}
          action={downloadLink}
        />
      ) : (
        <div className={kind === 'video' ? 'media-stage media-stage-video' : 'media-stage media-stage-audio'}>
          {kind === 'video' ? (
            <video
              className="media-video"
              src={inlineUrl}
              controls
              playsInline
              preload="metadata"
              onError={handleError}
              aria-label={`视频预览：${file.name}`}
            >
              当前浏览器不支持内联视频播放，请下载文件。
            </video>
          ) : (
            <audio
              className="media-audio"
              src={inlineUrl}
              controls
              preload="metadata"
              onError={handleError}
              aria-label={`音频预览：${file.name}`}
            >
              当前浏览器不支持内联音频播放，请下载文件。
            </audio>
          )}
        </div>
      )}
      <p className="media-hint">{mediaMimeHint(file.mime)}</p>
      <div className="media-actions">{downloadLink}</div>
    </div>
  )
}
