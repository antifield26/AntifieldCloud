import { Check, CircleAlert, CircleSlash, LoaderCircle, Upload, X } from 'lucide-react'
import type { UploadTask } from '../../hooks/useUploadQueue'
import { ProgressBar } from '../ProgressBar'
import { Button } from '../Button'
import { FileIcon } from '../FileIcon'
import { cx } from '../../lib/classnames'

export interface UploadPanelProps {
  tasks: UploadTask[]
  busy: boolean
  onRetry: (id: number) => void
  onCancel: (id: number) => void
  /** 放弃并清理：DELETE 服务端分片会话 + 清除本地断点 */
  onDiscard?: (id: number) => void
  onClear: () => void
}

function statusIcon(status: UploadTask['status']) {
  if (status === 'uploading') return <LoaderCircle size={16} className="spin" aria-hidden="true" />
  if (status === 'success') return <Check size={16} className="upload-success-icon" aria-hidden="true" />
  if (status === 'error') return <CircleAlert size={16} className="upload-error-icon" aria-hidden="true" />
  if (status === 'cancelled') return <CircleSlash size={16} className="upload-wait-icon" aria-hidden="true" />
  return <Upload size={16} className="upload-wait-icon" aria-hidden="true" />
}

/** 上传队列浮层：逐文件展示进度、成功/失败、取消与重试。 */
export function UploadPanel({ tasks, busy, onRetry, onCancel, onDiscard, onClear }: UploadPanelProps) {
  if (tasks.length === 0) return null
  const succeeded = tasks.filter((task) => task.status === 'success').length
  const failed = tasks.filter((task) => task.status === 'error').length
  const cancelled = tasks.filter((task) => task.status === 'cancelled').length
  const total = tasks.length
  const active = tasks.filter((task) => task.status === 'waiting' || task.status === 'uploading').length

  return (
    <section className="upload-panel" aria-label="上传队列">
      <header className="upload-panel-header">
        <div>
          <h2 className="upload-panel-title">上传队列</h2>
          <p className="upload-panel-summary">
            {busy
              ? `正在上传 ${active} 项 · 成功 ${succeeded} · 失败 ${failed} · 取消 ${cancelled}`
              : `完成 ${total} 项 · 成功 ${succeeded} · 失败 ${failed} · 取消 ${cancelled}`}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClear}
          disabled={busy}
          aria-label="关闭上传面板"
          title={busy ? '上传进行中，暂不能关闭' : '关闭上传面板'}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <ul className="upload-list">
        {tasks.map((task) => {
          const cancellable = task.status === 'waiting' || task.status === 'uploading'
          return (
            <li key={task.id} className={cx('upload-item', `upload-item-${task.status}`)}>
              <span className="upload-item-icon" aria-hidden="true">
                <FileIcon name={task.file.name} mime={task.file.type} size={17} />
              </span>
              <div className="upload-item-main">
                <div className="upload-item-line">
                  <span className="upload-item-name" title={task.file.name}>{task.file.name}</span>
                  {statusIcon(task.status)}
                </div>
                {task.status === 'uploading' ? (
                  <ProgressBar
                    value={task.progress}
                    tone="accent"
                    size="sm"
                    ariaLabel={`${task.file.name} 上传进度 ${task.progress}%`}
                  />
                ) : null}
                {task.status === 'success' ? <span className="upload-item-note">上传完成</span> : null}
                {task.status === 'waiting' ? <span className="upload-item-note">等待上传</span> : null}
                {task.status === 'cancelled' ? (
                  <div className="upload-item-error">
                    <span>已取消上传</span>
                    <div className="upload-item-button-row">
                      {onDiscard ? (
                        <Button size="sm" variant="ghost" onClick={() => onDiscard(task.id)}>
                          放弃并清理
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => onRetry(task.id)}>重新上传</Button>
                    </div>
                  </div>
                ) : null}
                {task.status === 'error' ? (
                  <div className="upload-item-error">
                    <span>{task.error ?? '上传失败'}</span>
                    <div className="upload-item-button-row">
                      {onDiscard ? (
                        <Button size="sm" variant="ghost" onClick={() => onDiscard(task.id)}>
                          放弃并清理
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => onRetry(task.id)}>重试</Button>
                    </div>
                  </div>
                ) : null}
                {cancellable ? (
                  <div className="upload-item-actions">
                    <Button size="sm" variant="ghost" onClick={() => onCancel(task.id)}>取消</Button>
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
