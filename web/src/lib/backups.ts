// 备份归档展示、校验状态与恢复选择相关的纯函数。
// 契约（task-7）：ArchiveItem.mode 为 full|inc；verifiedAt 非空表示已校验通过。

import type { BackupArchive, BackupInboxItem, BackupListResult, BackupManifest } from '../api/types'

export const MAX_BACKUP_UPLOAD_BYTES = 100 * 1024 * 1024
export const BACKUP_FILE_PATTERN = /^snapshot-.+-(full|inc)\.tar\.gz$/i

export type BackupModeValue = 'full' | 'incremental'

export interface BackupOverview {
  total: number
  pending: number
  orphan: number
  latest: BackupArchive | null
  error: string | null
}

export interface RestoreSelectionState {
  paths: string[]
  /** 仅恢复文件；整库/密钥包恢复不在 Web 端开放 */
  includeFiles: boolean
  includeDatabase: boolean
  includeSecrets: boolean
}

export function normalizeBackupMode(mode: string): BackupModeValue {
  return mode.toLowerCase() === 'full' ? 'full' : 'incremental'
}

export function backupModeLabel(mode: string): string {
  return normalizeBackupMode(mode) === 'full' ? '全量' : '增量'
}

/** 状态来自服务端；保留旧值容错。 */
export function normalizedArchiveStatus(status: string): string {
  const value = status.toLowerCase()
  if (value === 'verified' || value === 'ok') return 'acked'
  if (value === 'error' || value === 'failed') return 'missing'
  if (value === 'orphan') return 'missing'
  return value
}

export function archiveStatusLabel(archive: BackupArchive): string {
  switch (normalizedArchiveStatus(archive.status)) {
    case 'pending':
      return '待确认'
    case 'acked':
      return '已确认'
    case 'imported':
      return '已导入'
    case 'missing':
      return '文件缺失'
    default:
      return archive.status || '未知'
  }
}

export type BackupTone = 'success' | 'warning' | 'danger' | 'muted' | 'accent' | 'info'

export function archiveStatusTone(archive: BackupArchive): BackupTone {
  switch (normalizedArchiveStatus(archive.status)) {
    case 'acked':
      return 'success'
    case 'pending':
      return 'warning'
    case 'imported':
      return 'accent'
    case 'missing':
      return 'danger'
    default:
      return 'muted'
  }
}

export function isArchiveVerified(archive: BackupArchive): boolean {
  return Boolean(archive.verifiedAt)
}

export function isArchiveRestorable(archive: BackupArchive): boolean {
  return isArchiveVerified(archive) && normalizedArchiveStatus(archive.status) !== 'missing'
}

export function backupOriginLabel(origin: string): string {
  const value = origin.toLowerCase()
  if (value === 'pi') return 'Pi'
  if (value === 'import') return '导入'
  if (value === 'legacy') return '历史'
  return origin || '未知'
}

export function shaPrefix(sha256: string | null | undefined): string {
  if (!sha256) return '—'
  return sha256.length > 12 ? `${sha256.slice(0, 12)}…` : sha256
}

/** 归档上传前的前端预检：文件名白名单 + 大小上限（服务端仍会复核）。 */
export function validateBackupFile(
  file: { name: string; size: number },
  maxBytes = MAX_BACKUP_UPLOAD_BYTES,
): string | null {
  if (!BACKUP_FILE_PATTERN.test(file.name)) {
    return '归档文件名需类似 snapshot-<名称>-(full|inc).tar.gz'
  }
  if (file.size <= 0) return '归档文件为空'
  if (file.size > maxBytes) return `归档文件不能超过 ${Math.round(maxBytes / (1024 * 1024))} MiB`
  return null
}

export function summarizeBackups(result: BackupListResult): BackupOverview {
  const items = result.items ?? []
  const latest =
    [...items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
  return {
    total: items.length,
    pending: result.state?.pendingCount ?? items.filter((item) => normalizedArchiveStatus(item.status) === 'pending').length,
    orphan: result.state?.orphanCount ?? result.orphans?.length ?? 0,
    latest,
    error: result.state?.lastError ?? null,
  }
}

/** 汇总归档内的清单（日期/文件数/大小）。 */
export function manifestSummary(manifest: BackupManifest | null | undefined): string {
  if (!manifest) return '无清单'
  const parts = [`${manifest.fileCount} 个文件`, `共 ${manifest.totalBytes} B`]
  if (manifest.since) parts.push(`自 ${manifest.since}`)
  return parts.join(' · ')
}

export function inboxItemLabel(item: BackupInboxItem): string {
  return item.imported ? '已入库' : '待导入'
}
