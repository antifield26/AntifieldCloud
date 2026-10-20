// 备份管理：归档列表、校验、导入（multipart + TOTP）与恢复入口。
// 后端契约：GET /api/backups 返回 items/inbox/orphans/state；恢复仅在 meta.backupRestoreEnabled 时开放。

import { useState } from 'react'
import { Archive, RefreshCw, ShieldCheck, Upload } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BackupArchive, BackupImportResult } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import { useBackups } from '../../hooks/useBackups'
import {
  archiveStatusLabel,
  archiveStatusTone,
  backupModeLabel,
  backupOriginLabel,
  isArchiveRestorable,
  shaPrefix,
} from '../../lib/backups'
import { formatBytes, formatDateTime } from '../../lib/format'
import { Button } from '../Button'
import { Badge } from '../Badge'
import { Table } from '../Table'
import type { Column } from '../Table'
import { EmptyState } from '../EmptyState'
import { InlineError } from '../InlineError'
import { RelativeTime } from '../RelativeTime'
import { useToast } from '../Toast'
import { ImportArchiveDialog } from './ImportArchiveDialog'
import { PrepareBackupDialog } from './PrepareBackupDialog'
import { RestoreWizard } from './RestoreWizard'

export function BackupManager() {
  const { meta } = useAppMeta()
  const toast = useToast()
  const { data, loading, error, errorStatus, refresh } = useBackups()
  const [importOpen, setImportOpen] = useState(false)
  const [prepareOpen, setPrepareOpen] = useState(false)
  const [restoreArchive, setRestoreArchive] = useState<BackupArchive | null>(null)
  const [verifyingName, setVerifyingName] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const items = data?.items ?? []
  const state = data?.state ?? null

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }

  const handleImported = (result: BackupImportResult): void => {
    setImportOpen(false)
    if (result.verify && !result.verify.ok) {
      toast.error(`归档已导入，但自动校验失败：${result.verify.error ?? '未知原因'}`)
    } else if (result.verify?.ok) {
      toast.success(`归档「${result.archive.name}」已导入并校验通过`)
    } else {
      toast.success(`归档「${result.archive.name}」已导入`)
    }
    void refresh()
  }

  const handleVerify = async (archive: BackupArchive): Promise<void> => {
    if (verifyingName) return
    setVerifyingName(archive.name)
    try {
      const result = await api.backups.verify(archive.name)
      toast.success(`归档「${result.archive.name}」校验通过`)
      await refresh()
    } catch (verifyError) {
      toast.error(toErrorMessage(verifyError, '校验归档失败，请重试'))
    } finally {
      setVerifyingName(null)
    }
  }

  const columns: Column<BackupArchive>[] = [
    {
      key: 'name',
      header: '归档',
      primary: true,
      render: (archive) => (
        <div className="backup-name-cell">
          <Archive size={16} className="backup-name-icon" aria-hidden="true" />
          <div>
            <span className="mono backup-name" title={archive.name}>{archive.name}</span>
            <span className="backup-sha">SHA-256 {shaPrefix(archive.sha256)}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'mode',
      header: '模式',
      render: (archive) => <Badge tone={archive.mode === 'full' ? 'accent' : 'muted'}>{backupModeLabel(archive.mode)}</Badge>,
    },
    {
      key: 'created',
      header: '时间',
      className: 'cell-time',
      render: (archive) => <RelativeTime ts={archive.createdAt} />,
    },
    {
      key: 'size',
      header: '大小',
      align: 'right',
      className: 'cell-size',
      render: (archive) => formatBytes(archive.sizeBytes),
    },
    {
      key: 'status',
      header: '状态',
      render: (archive) => (
        <div className="backup-status-cell">
          <Badge tone={archiveStatusTone(archive)}>{archiveStatusLabel(archive)}</Badge>
          {archive.verifiedAt ? (
            <span className="backup-verified" title={`校验于 ${formatDateTime(archive.verifiedAt)}`}>
              <ShieldCheck size={13} aria-hidden="true" />
              已校验
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'origin',
      header: '来源',
      render: (archive) => <span className="muted">{backupOriginLabel(archive.origin)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      className: 'cell-actions',
      render: (archive) => (
        <div className="row-actions">
          {archive.verifiedAt ? null : (
            <Button
              size="sm"
              variant="secondary"
              loading={verifyingName === archive.name}
              onClick={() => void handleVerify(archive)}
              disabled={verifyingName !== null}
            >
              校验
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            disabled={!meta.backupRestoreEnabled || !isArchiveRestorable(archive)}
            title={
              !meta.backupRestoreEnabled
                ? '恢复向导未启用'
                : !isArchiveRestorable(archive)
                  ? '请先校验归档'
                  : '从此归档恢复'
            }
            onClick={() => setRestoreArchive(archive)}
          >
            恢复
          </Button>
        </div>
      ),
    },
  ]

  const notReady = !data && errorStatus === 404

  return (
    <div className="backup-manager">
      <div className="backup-toolbar">
        <div className="backup-summary">
          <span>归档 {state ? items.length : '—'}</span>
          <span>待确认 {state?.pendingCount ?? '—'}</span>
          <span>已确认 {state?.ackedCount ?? '—'}</span>
          <span>导入 {state?.importCount ?? '—'}</span>
          <span>孤儿 {state?.orphanCount ?? '—'}</span>
          {state ? <span>数据盘剩余 {formatBytes(state.dataDirFreeBytes)}</span> : null}
        </div>
        <div className="backup-toolbar-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={15} aria-hidden="true" />}
            loading={refreshing}
            onClick={() => void handleRefresh()}
          >
            刷新
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Archive size={15} aria-hidden="true" />}
            onClick={() => setPrepareOpen(true)}
          >
            准备备份
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Upload size={15} aria-hidden="true" />}
            onClick={() => setImportOpen(true)}
          >
            导入归档
          </Button>
        </div>
      </div>

      {notReady ? (
        <div className="notice notice-muted">
          备份管理接口尚未启用（后端未就绪）；导入/恢复功能将在服务端上线后自动可用。
        </div>
      ) : error && !data ? (
        <InlineError message={error} onRetry={() => void refresh()} />
      ) : null}

      {state?.lastError ? (
        <div className="notice notice-warning" role="alert">
          最近备份任务异常：{state.lastError}
        </div>
      ) : null}
      {state && state.orphanCount > 0 ? (
        <div className="notice notice-warning">
          检测到 {state.orphanCount} 个未登记归档（imports 目录孤儿文件），仅报告不会自动删除；请人工确认后处理。
        </div>
      ) : null}
      {data && data.inbox.length > 0 ? (
        <div className="notice notice-info">
          imports 目录有 {data.inbox.length} 个文件待处理；导入记录后可在此校验并恢复。
        </div>
      ) : null}
      {!meta.backupRestoreEnabled ? (
        <div className="notice notice-warning">
          服务端尚未启用恢复向导（/api/version backupRestoreEnabled=false）；当前可查看归档、导入与校验。
        </div>
      ) : null}

      <div className="backup-section-heading">
        <h3 className="subsection-title">归档列表</h3>
        {state?.lastPullAt ? (
          <span className="field-hint">
            最近拉取：<RelativeTime ts={state.lastPullAt} />
          </span>
        ) : null}
      </div>

      <Table
        columns={columns}
        rows={items}
        rowKey={(archive) => archive.id || archive.name}
        loading={loading && !data}
        skeletonRows={4}
        caption="备份归档列表"
        empty={
          <EmptyState
            icon={<Archive size={24} />}
            title="还没有备份归档"
            description="Pi 端备份会在计划任务运行后出现在这里；也可以导入已有的 snapshot 归档。"
            action={
              <Button variant="secondary" icon={<Upload size={16} aria-hidden="true" />} onClick={() => setImportOpen(true)}>
                导入归档
              </Button>
            }
          />
        }
      />

      <ImportArchiveDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />

      <PrepareBackupDialog
        open={prepareOpen}
        onClose={() => setPrepareOpen(false)}
        onPrepared={() => {
          toast.success('已生成 pending 备份，等待 Windows 任务拉取')
          void refresh()
        }}
      />

      <RestoreWizard
        open={restoreArchive !== null}
        archive={restoreArchive}
        onClose={() => setRestoreArchive(null)}
        onCompleted={() => {
          void refresh()
        }}
      />
    </div>
  )
}
