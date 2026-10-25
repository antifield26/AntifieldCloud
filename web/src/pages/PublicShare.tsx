// 公开分享页 /s/:token：无需登录、独立布局、noindex。
// 仅通过公开 API 获取元数据与解锁，不读取任何登录态；下载走公开内容地址。
// v0.4.0：支持多文件分享——解锁后展示文件清单，逐文件走 items/:itemId/content 下载。

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { Download, FileCheck, Files, LockKeyhole, ShieldAlert } from 'lucide-react'
import { api, ApiError, isApiError, toErrorMessage } from '../api/client'
import type { PublicShareInfo, PublicShareItem, PublicShareState } from '../api/types'
import { useNoIndex } from '../hooks/useNoIndex'
import { usePageTitle } from '../hooks/usePageTitle'
import { Logo } from '../components/Logo'
import { Button } from '../components/Button'
import { FormField } from '../components/FormField'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { LoadingBlock } from '../components/Loading'
import { FileIcon } from '../components/FileIcon'
import { formatBytes, formatDateTime } from '../lib/format'

const STATE_LABELS: Record<PublicShareState, { title: string; description: string }> = {
  active: { title: '分享链接有效', description: '文件仍可下载。' },
  expired: { title: '分享链接已过期', description: '请联系分享者重新创建链接。' },
  exhausted: { title: '下载次数已用尽', description: '该分享已达到最大下载次数，请联系分享者。' },
  revoked: { title: '分享链接已被吊销', description: '分享者已主动撤销此链接。' },
}

function stateTone(state: PublicShareState): 'success' | 'warning' | 'danger' | 'muted' {
  if (state === 'active') return 'success'
  if (state === 'expired') return 'warning'
  if (state === 'exhausted') return 'warning'
  return 'danger'
}

function shareItemCount(info: PublicShareInfo | null): number {
  const count = info?.share.itemCount ?? info?.share.items?.length ?? 1
  return count > 0 ? count : 1
}

/** 多文件分享的总大小：优先服务端 totalSizeBytes，其次 items 求和，最后回退首个文件大小。 */
function shareTotalBytes(info: PublicShareInfo | null): number {
  const share = info?.share
  if (!share) return 0
  if (typeof share.totalSizeBytes === 'number' && share.totalSizeBytes > 0) return share.totalSizeBytes
  const items = share.items ?? []
  if (items.length > 0) return items.reduce((sum, item) => sum + item.size, 0)
  return share.size
}

/** 公开分享页：密码解锁 + 单文件/多文件下载；不依赖登录态，不提供应用导航。 */
export function PublicShare() {
  const { token = '' } = useParams<{ token: string }>()
  usePageTitle('文件分享')
  useNoIndex()

  const [info, setInfo] = useState<PublicShareInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [downloadStarted, setDownloadStarted] = useState(false)
  const [downloadedIds, setDownloadedIds] = useState<string[]>([])

  const loadInfo = useCallback(async (): Promise<void> => {
    if (!token) {
      setLoading(false)
      setErrorCode('not_found')
      setErrorMessage('分享链接不完整')
      return
    }
    setLoading(true)
    setErrorCode(null)
    setErrorMessage(null)
    try {
      const result = await api.publicShares.info(token)
      setInfo(result)
      setUnlocked(!result.requiresPassword)
    } catch (loadError) {
      if (loadError instanceof ApiError && (loadError.status === 404 || loadError.code === 'not_found')) {
        setErrorCode('not_found')
        setErrorMessage('分享链接不存在或已被删除')
      } else if (loadError instanceof ApiError && loadError.status === 410) {
        // 过期/吊销/次数用尽：服务端返回 410，直接展示失效原因
        setErrorCode('gone')
        setErrorMessage(loadError.message || '分享链接已失效')
      } else {
        setErrorCode(loadError instanceof ApiError ? loadError.code : 'error')
        setErrorMessage(toErrorMessage(loadError, '无法读取分享信息，请稍后重试'))
      }
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])

  const handleUnlock = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (unlocking) return
    setUnlockError(null)
    if (!password) {
      setUnlockError('请输入分享密码')
      return
    }
    setUnlocking(true)
    try {
      const result = await api.publicShares.unlock(token, password)
      if (result.share) {
        setInfo((previous) =>
          previous
            ? { ...previous, share: result.share ?? previous.share, requiresPassword: false }
            : previous,
        )
      }
      setUnlocked(true)
      setPassword('')
      // 解锁响应可能省略 items：多文件分享再拉一次元数据以展示清单
      if (!result.share?.items && shareItemCount(info) > 1) {
        try {
          const refreshed = await api.publicShares.info(token)
          setInfo(refreshed)
        } catch {
          // 列表读取失败不影响已解锁状态；页面提供重试
        }
      }
    } catch (unlockFailure) {
      if (isApiError(unlockFailure) && unlockFailure.code === 'invalid_password') {
        setUnlockError('密码错误，请重试')
      } else {
        setUnlockError(toErrorMessage(unlockFailure, '解锁失败，请稍后重试'))
      }
    } finally {
      setUnlocking(false)
    }
  }

  const share = info?.share ?? null
  const state = info?.state ?? 'active'
  const stateMeta = STATE_LABELS[state]
  const contentUrl = api.publicShares.contentUrl(token)
  const itemCount = shareItemCount(info)
  const isBundle = itemCount > 1
  const items: PublicShareItem[] = share?.items ?? []
  const totalBytes = shareTotalBytes(info)

  const markDownloaded = (itemId: string | null): void => {
    setDownloadStarted(true)
    if (!itemId) return
    setDownloadedIds((previous) => (previous.includes(itemId) ? previous : [...previous, itemId]))
  }

  return (
    <main className="public-share-page">
      <div className="public-share-card">
        <header className="public-share-brand">
          <Logo size={38} withText />
          <Badge tone="accent">公开分享</Badge>
        </header>

        {loading ? (
          <LoadingBlock text="正在读取分享信息…" />
        ) : errorCode ? (
          <EmptyState
            icon={<ShieldAlert size={26} />}
            title={
              errorCode === 'not_found'
                ? '分享不存在'
                : errorCode === 'gone'
                  ? '分享已失效'
                  : '无法打开分享'
            }
            description={errorMessage ?? '链接可能已失效。'}
            action={
              errorCode !== 'not_found' && errorCode !== 'gone' ? (
                <Button variant="secondary" onClick={() => void loadInfo()}>重试</Button>
              ) : undefined
            }
          />
        ) : share ? (
          <>
            <div className="public-share-heading">
              <span className="public-share-icon" aria-hidden="true">
                {isBundle ? <Files size={22} /> : <FileCheck size={22} />}
              </span>
              <div className="public-share-heading-text">
                <h1 className="public-share-title" title={isBundle ? share.fileName : share.fileName}>
                  {isBundle ? `${itemCount} 个文件` : share.fileName}
                </h1>
                <p className="public-share-subtitle">
                  {formatBytes(totalBytes)}
                  {isBundle ? ` · ${itemCount} 个文件` : share.mime ? ` · ${share.mime}` : ''}
                </p>
              </div>
              <Badge tone={stateTone(state)}>{stateMeta.title}</Badge>
            </div>

            {state !== 'active' ? (
              <div className="notice notice-warning">{stateMeta.description}</div>
            ) : (
              <>
                <dl className="public-share-meta">
                  <div className="public-share-meta-row">
                    <dt>下载次数</dt>
                    <dd>{share.downloadCount} / {share.maxDownloads ?? '不限'}</dd>
                  </div>
                  <div className="public-share-meta-row">
                    <dt>过期时间</dt>
                    <dd>{share.expiresAt ? formatDateTime(share.expiresAt) : '永不过期'}</dd>
                  </div>
                  {isBundle ? (
                    <div className="public-share-meta-row">
                      <dt>文件数 / 总大小</dt>
                      <dd>{itemCount} 个 · {formatBytes(totalBytes)}</dd>
                    </div>
                  ) : null}
                </dl>

                {share.hasPassword && !unlocked ? (
                  <form className="public-share-unlock" onSubmit={(event) => void handleUnlock(event)}>
                    <p className="public-share-hint">
                      <LockKeyhole size={15} aria-hidden="true" />
                      该分享受密码保护，请输入分享者提供的密码。
                    </p>
                    <FormField label="分享密码" htmlFor="public-share-password" required>
                      <input
                        id="public-share-password"
                        className="input"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                        autoFocus
                        disabled={unlocking}
                      />
                    </FormField>
                    {unlockError ? <p className="field-error" role="alert">{unlockError}</p> : null}
                    <Button type="submit" variant="primary" size="md" loading={unlocking} className="public-share-download">
                      {isBundle ? '解锁并查看文件' : '解锁并下载'}
                    </Button>
                  </form>
                ) : isBundle ? (
                  <>
                    <p className="field-hint">每个文件单独下载；同一分享会话首次成功下载计 1 次，会话内再次下载不增加次数。</p>
                    {items.length > 0 ? (
                      <ul className="public-share-items" aria-label="分享文件列表">
                        {items.map((item) => (
                          <li key={item.id} className="public-share-item">
                            <span className="public-share-item-icon" aria-hidden="true">
                              <FileIcon name={item.name} mime={item.mime} size={18} />
                            </span>
                            <span className="public-share-item-name" title={item.name}>{item.name}</span>
                            <span className="public-share-item-size">{formatBytes(item.size)}</span>
                            <a
                              className="btn btn-secondary btn-sm public-share-item-download"
                              href={api.publicShares.itemContentUrl(token, item.id)}
                              download={item.name}
                              onClick={() => markDownloaded(item.id)}
                              aria-label={`下载 ${item.name}`}
                            >
                              <Download size={14} aria-hidden="true" />
                              <span className="btn-label">
                                {downloadedIds.includes(item.id) ? '已开始' : '下载'}
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="notice notice-muted">
                        文件清单暂不可用，请刷新页面后重试。
                        <Button size="sm" variant="secondary" onClick={() => void loadInfo()}>刷新</Button>
                      </div>
                    )}
                    {downloadStarted ? (
                      <p className="field-hint">已开始下载；同一分享会话首次成功下载计 1 次，会话内再次下载不增加次数。</p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <a
                      className="btn btn-primary btn-md public-share-download"
                      href={contentUrl}
                      download={share.fileName}
                      onClick={() => markDownloaded(null)}
                    >
                      <Download size={16} aria-hidden="true" />
                      <span className="btn-label">下载文件</span>
                    </a>
                    {downloadStarted ? (
                      <p className="field-hint">已开始下载；同一分享会话首次成功下载计 1 次，会话内再次下载不增加次数。</p>
                    ) : null}
                  </>
                )}
              </>
            )}
          </>
        ) : null}

        <footer className="public-share-footer">
          由 AntifieldCloud 提供 · 分享链接仅限持有人使用，请勿公开传播
        </footer>
      </div>
    </main>
  )
}
