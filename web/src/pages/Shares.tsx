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

function shareStatus(share: Share): { label: string; tone: BadgeTone } {
  if (share.revokedAt) return { label: '已吊销', tone: 'muted' }
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return { label: '已过期', tone: 'warning' }
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return { label: '次数用尽', tone: 'danger' }
  return { label: '有效', tone: 'success' }
}

/** 分享管理页：列表、状态与吊销。 */
export function Shares() {
  usePageTitle('分享管理')
  const { meta } = useAppMeta()
  const toast = useToast()
  const [items, setItems] = useState<Share[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<Share | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!meta.sharesEnabled) {
      setLoading(false)
      setItems([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.shares.list()
      setItems(result.items)
    } catch (loadError) {
      setError(toErrorMessage(loadError, '加载分享列表失败'))
    } finally {
      setLoading(false)
    }
  }, [meta.sharesEnabled])

  useEffect(() => {
    void load()
  }, [load])

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
      toast.success(`已吊销「${revokeTarget.fileName}」的分享链接`)
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
      render: (share) => <span className="knowledge-card-title">{share.fileName}</span>,
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
          aria-label={`吊销分享 ${share.fileName}`}
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
        description={items.length > 0 ? `共 ${items.length} 条分享` : '公开下载链接的状态与吊销'}
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

      <ConfirmDialog
        open={revokeTarget !== null}
        title="吊销分享"
        message={revokeTarget ? `确定吊销「${revokeTarget.fileName}」的分享链接？` : ''}
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
