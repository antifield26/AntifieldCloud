// 分享管理：列出已创建的文件分享，查看状态与下载次数并支持吊销。
// 列表接口不返回 token，因此完整分享链接只在创建时展示一次。

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, Share2, Trash2 } from 'lucide-react'
import { api, toErrorMessage } from '../api/client'
import type { Share } from '../api/types'
import { useAppMeta } from '../meta/MetaContext'
import { usePageTitle } from '../hooks/usePageTitle'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/Button'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { Badge } from '../components/Badge'
import type { BadgeTone } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { InlineError } from '../components/InlineError'
import { RelativeTime } from '../components/RelativeTime'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'

/** 分享列表分页大小（服务端 pageSize 上限 500，默认 100；页面按 50 分页显示）。 */
const PAGE_SIZE = 50

function shareStatus(share: Share): { label: string; tone: BadgeTone } {
  if (share.revokedAt) return { label: '已吊销', tone: 'muted' }
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return { label: '已过期', tone: 'warning' }
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return { label: '次数用尽', tone: 'danger' }
  return { label: '有效', tone: 'success' }
}

/** 多文件分享的展示名：文件名 + 条目数（旧服务端无 itemCount 时按 1 处理）。 */
function shareItemCount(share: Share): number {
  return share.itemCount && share.itemCount > 0 ? share.itemCount : 1
}

function shareLabel(share: Share): string {
  const count = shareItemCount(share)
  return count > 1 ? `${share.fileName} 等 ${count} 个文件` : share.fileName
}

/** 分享管理页：列表、状态与吊销。 */
export function Shares() {
  usePageTitle('分享管理')
  const { meta } = useAppMeta()
  const toast = useToast()
  const [items, setItems] = useState<Share[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<Share | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const load = useCallback(async (): Promise<void> => {
    if (!meta.sharesEnabled) {
      setLoading(false)
      setItems([])
      setTotal(0)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.shares.list(page, PAGE_SIZE)
      setItems(result.items)
      setTotal(typeof result.total === 'number' ? result.total : result.items.length)
    } catch (loadError) {
      setError(toErrorMessage(loadError, '加载分享列表失败'))
    } finally {
      setLoading(false)
    }
  }, [meta.sharesEnabled, page])

  useEffect(() => {
    void load()
  }, [load])

  // 数据收缩后回收越界页码。
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const confirmRevoke = async (): Promise<void> => {
    if (!revokeTarget) return
    setRevokeBusy(true)
    try {
      await api.shares.revoke(revokeTarget.id)
      toast.success(`已吊销「${shareLabel(revokeTarget)}」的分享链接`)
      setRevokeTarget(null)
      await load()
    } catch (revokeError) {
      toast.error(toErrorMessage(revokeError, '吊销分享失败，请重试'))
    } finally {
      setRevokeBusy(false)
    }
  }

  const columns: Column<Share>[] = [
    {
      key: 'file',
      header: '文件',
      primary: true,
      render: (share) => {
        const count = shareItemCount(share)
        return (
          <div className="share-file-cell">
            <span className="knowledge-card-title">{share.fileName}</span>
            {count > 1 ? <Badge tone="info">{count} 个文件</Badge> : null}
          </div>
        )
      },
    },
    {
      key: 'items',
      header: '文件数',
      align: 'right',
      className: 'cell-size',
      render: (share) => `${shareItemCount(share)} 个`,
    },
    {
      key: 'status',
      header: '状态',
      render: (share) => {
        const status = shareStatus(share)
        return <Badge tone={status.tone}>{status.label}</Badge>
      },
    },
    {
      key: 'downloads',
      header: '下载次数',
      align: 'right',
      className: 'cell-size',
      render: (share) => `${share.downloadCount} / ${share.maxDownloads ?? '不限'}`,
    },
    {
      key: 'expires',
      header: '过期时间',
      className: 'cell-time',
      render: (share) => (share.expiresAt ? <RelativeTime ts={share.expiresAt} /> : '永不过期'),
    },
    {
      key: 'password',
      header: '密码',
      render: (share) => <Badge tone={share.hasPassword ? 'accent' : 'muted'}>{share.hasPassword ? '有' : '无'}</Badge>,
    },
    {
      key: 'created',
      header: '创建时间',
      className: 'cell-time',
      render: (share) => <RelativeTime ts={share.createdAt} />,
    },
    {
      key: 'note',
      header: '备注',
      className: 'cell-detail',
      render: (share) => (share.note ? <span title={share.note}>{share.note}</span> : '—'),
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      className: 'cell-actions',
      render: (share) => (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          icon={<Trash2 size={15} aria-hidden="true" />}
          disabled={Boolean(share.revokedAt)}
          aria-label={`吊销分享 ${shareLabel(share)}`}
          onClick={() => setRevokeTarget(share)}
        >
          吊销
        </Button>
      ),
    },
  ]

  return (
    <div className="shares-page">
      <PageHeader
        title="分享管理"
        description={total > 0 ? `共 ${total} 条分享` : '公开下载链接的状态与吊销'}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Link className="btn btn-primary btn-md" to="/files">
              <Share2 size={16} aria-hidden="true" />
              <span className="btn-label">去创建分享</span>
            </Link>
          </>
        }
      />

      {!meta.sharesEnabled ? (
        <div className="notice notice-muted">服务端未启用文件分享功能（/api/version sharesEnabled=false）。</div>
      ) : (
        <div className="notice notice-info">
          分享链接创建于文件页，完整链接只在创建时展示一次；这里可以查看状态、下载次数并吊销。备注仅自己可见，不会出现在公开分享页。
        </div>
      )}

      {error ? <InlineError message={error} onRetry={() => void load()} className="page-inline-error" /> : null}

      <section className="surface-panel" aria-label="分享列表">
        <Table
          columns={columns}
          rows={items}
          rowKey={(share) => share.id}
          loading={loading}
          skeletonRows={5}
          caption="文件分享列表"
          empty={
            <EmptyState
              icon={<Share2 size={24} />}
              title="还没有分享链接"
              description="在文件页对任意文件选择“分享”，即可创建公开下载链接。"
              action={
                <Link className="btn btn-secondary btn-md" to="/files">
                  <Share2 size={16} aria-hidden="true" />
                  <span className="btn-label">去文件页</span>
                </Link>
              }
            />
          }
        />
      </section>

      {total > PAGE_SIZE ? (
        <div className="pager">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            上一页
          </Button>
          <span className="pager-info">
            第 {page} / {totalPages} 页 · 共 {total} 条
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
          >
            下一页
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        title="吊销分享"
        message={revokeTarget ? `确定吊销「${shareLabel(revokeTarget)}」的分享链接？` : ''}
        details="吊销后链接立即失效，访问者会看到 410 状态；此操作不可撤销。"
        confirmText="吊销链接"
        loading={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onClose={() => {
          if (!revokeBusy) setRevokeTarget(null)
        }}
      />
    </div>
  )
}
