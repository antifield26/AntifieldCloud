// 备份健康状态纯函数：把 dashboard/backups 的多来源只读状态整理为可渲染条目。
// 约束：状态文件缺失一律显示“未运行/未知”，不猜测、不当作正常；
// 阈值与告警默认值保持一致（世界备份 192 小时、演练 35 天），仅用于前端提示高亮。

import type {
  BackupArchive,
  BackupState,
  BackupStatus,
  DrillStatus,
  WorldBackupStatus,
  WorldPullStatus,
} from '../api/types'
import { archiveStatusLabel, backupModeLabel, normalizedArchiveStatus } from './backups'
import { formatBytes, formatDateTime } from './format'

export const WORLD_BACKUP_STALE_HOURS = 192
export const DRILL_STALE_DAYS = 35

export type BackupHealthTone = 'success' | 'warning' | 'danger' | 'muted'

export interface BackupStatusEntry {
  key: string
  label: string
  /** 主文案（数量/状态） */
  value: string
  tone: BackupHealthTone
  /** 相对时间展示用时间戳 */
  timestamp: string | null
  /** 补充说明（大小、数量、错误摘要） */
  detail: string | null
  /** 异常时在卡片上高亮 */
  alert: boolean
}

export interface BackupStatusInput {
  /** /api/dashboard 的 backup（含 secrets/world/drill 等扩展字段） */
  backup?: BackupStatus | null
  /** /api/backups 的 state */
  state?: BackupState | null
  world?: WorldBackupStatus | null
  worldPull?: WorldPullStatus | null
  drill?: DrillStatus | null
  archives?: BackupArchive[]
  now?: number
}

export interface WorldStatusView {
  /** 主文案 */
  value: string
  tone: BackupHealthTone
  timestamp: string | null
  detail: string | null
  alert: boolean
}

function ageHours(timestamp: string | null | undefined, now: number): number | null {
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return null
  return (now - parsed) / 3_600_000
}

/** 时间戳是否早于阈值；缺时间戳返回 null（未知而不是过期）。 */
export function isStaleByHours(
  timestamp: string | null | undefined,
  maxAgeHours: number,
  now = Date.now(),
): boolean | null {
  const hours = ageHours(timestamp, now)
  if (hours === null) return null
  return hours > maxAgeHours
}

export function isStaleByDays(
  timestamp: string | null | undefined,
  maxAgeDays: number,
  now = Date.now(),
): boolean | null {
  return isStaleByHours(timestamp, maxAgeDays * 24, now)
}

function latestArchive(archives: BackupArchive[]): BackupArchive | null {
  if (archives.length === 0) return null
  return [...archives].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
}

/** 世界备份状态：失败 > 过期 > 正常；缺失显示未运行。 */
export function worldBackupView(
  world: WorldBackupStatus | null | undefined,
  now = Date.now(),
): WorldStatusView {
  if (!world) {
    return { value: '未运行', tone: 'muted', timestamp: null, detail: '尚无世界备份状态文件', alert: false }
  }
  const stale = isStaleByHours(world.lastRunAt, WORLD_BACKUP_STALE_HOURS, now)
  if (world.ok === false) {
    return {
      value: '失败',
      tone: 'danger',
      timestamp: world.lastRunAt ?? null,
      detail: world.error || '上次世界备份失败，请检查备份脚本日志',
      alert: true,
    }
  }
  if (stale === true) {
    return {
      value: '已过期',
      tone: 'warning',
      timestamp: world.lastRunAt ?? null,
      detail: `超过 ${WORLD_BACKUP_STALE_HOURS} 小时未运行`,
      alert: true,
    }
  }
  const detailParts = [
    world.archiveName ? `归档 ${world.archiveName}` : null,
    world.sizeBytes !== null && world.sizeBytes !== undefined ? formatBytes(world.sizeBytes) : null,
    world.kept !== null && world.kept !== undefined ? `保留 ${world.kept} 份` : null,
  ].filter((part): part is string => Boolean(part))
  return {
    value: '正常',
    tone: 'success',
    timestamp: world.lastRunAt ?? null,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
    alert: false,
  }
}

/** PC 拉取状态：失败 > 正常；缺失显示未运行。 */
export function worldPullView(
  worldPull: WorldPullStatus | null | undefined,
  now = Date.now(),
): WorldStatusView {
  if (!worldPull) {
    return { value: '未运行', tone: 'muted', timestamp: null, detail: '尚无周度拉取状态文件', alert: false }
  }
  const timestamp = worldPull.lastPullAt ?? worldPull.lastRunAt ?? null
  const stale = isStaleByHours(timestamp, WORLD_BACKUP_STALE_HOURS, now)
  if (worldPull.ok === false) {
    return {
      value: '失败',
      tone: 'danger',
      timestamp,
      detail: worldPull.error || '上次拉取失败，远端归档不会被确认删除',
      alert: true,
    }
  }
  if (stale === true) {
    return {
      value: '已过期',
      tone: 'warning',
      timestamp,
      detail: `超过 ${WORLD_BACKUP_STALE_HOURS} 小时未拉取`,
      alert: true,
    }
  }
  const detailParts = [
    worldPull.archiveName ? `归档 ${worldPull.archiveName}` : null,
    worldPull.pulledCount !== null && worldPull.pulledCount !== undefined ? `拉取 ${worldPull.pulledCount} 个` : null,
    worldPull.kept !== null && worldPull.kept !== undefined ? `本地保留 ${worldPull.kept} 份` : null,
  ].filter((part): part is string => Boolean(part))
  return {
    value: '正常',
    tone: 'success',
    timestamp,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
    alert: false,
  }
}

/** 恢复演练状态：失败 > 过期 > 正常；缺失显示未运行。 */
export function drillView(drill: DrillStatus | null | undefined, now = Date.now()): WorldStatusView {
  if (!drill) {
    return { value: '未运行', tone: 'muted', timestamp: null, detail: '尚无恢复演练状态文件', alert: false }
  }
  const stale = isStaleByDays(drill.lastRunAt, DRILL_STALE_DAYS, now)
  if (drill.ok === false) {
    return {
      value: '失败',
      tone: 'danger',
      timestamp: drill.lastRunAt ?? null,
      detail: drill.error || '上次恢复演练失败，请检查演练报告',
      alert: true,
    }
  }
  if (stale === true) {
    return {
      value: '已过期',
      tone: 'warning',
      timestamp: drill.lastRunAt ?? null,
      detail: `超过 ${DRILL_STALE_DAYS} 天未演练`,
      alert: true,
    }
  }
  const detailParts = [
    drill.dbIntegrity ? `数据库完整性 ${drill.dbIntegrity}` : null,
    drill.reportPath ? `报告 ${drill.reportPath}` : null,
  ].filter((part): part is string => Boolean(part))
  return {
    value: '成功',
    tone: 'success',
    timestamp: drill.lastRunAt ?? null,
    detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
    alert: false,
  }
}

/**
 * 把 dashboard.backup、/api/backups state 与只读状态文件整理为固定顺序的状态条目。
 * 缺失数据一律降级为“未运行/未知”，不展示本地路径以外的敏感信息。
 */
export function buildBackupStatusEntries(input: BackupStatusInput): BackupStatusEntry[] {
  const now = input.now ?? Date.now()
  const { backup, state, archives = [] } = input
  const world = input.world ?? backup?.world ?? null
  const worldPull = input.worldPull ?? backup?.worldPull ?? null
  const drill = input.drill ?? backup?.drill ?? null
  const latest = latestArchive(archives)
  const pendingCount = backup?.pendingCount ?? state?.pendingCount ?? null
  const pendingBytes = backup?.pendingBytes ?? state?.pendingBytes ?? null
  const ackedBytes = backup?.ackedBytes ?? state?.ackedBytes ?? null
  const orphanCount = backup?.orphanCount ?? state?.orphanCount ?? null
  const ackedCount = state?.ackedCount ?? null

  const entries: BackupStatusEntry[] = []

  // 应用归档：取最新归档（Pi pending/acked/导入）
  entries.push({
    key: 'archive',
    label: '应用归档',
    value: latest ? `${backupModeLabel(latest.mode)}归档` : '暂无归档',
    tone: latest ? (normalizedArchiveStatus(latest.status) === 'missing' ? 'danger' : 'success') : 'muted',
    timestamp: latest?.createdAt ?? null,
    detail: latest
      ? `${archiveStatusLabel(latest)} · ${formatBytes(latest.sizeBytes)} · ${latest.name}`
      : '尚未收到 Pi 备份或导入归档',
    alert: latest ? normalizedArchiveStatus(latest.status) === 'missing' : false,
  })

  // 密钥包（secrets）：dashboard.backup 的扩展字段
  const secretsOk = backup?.secretsOk ?? null
  const secretsError = backup?.secretsLastError ?? null
  entries.push({
    key: 'secrets',
    label: '密钥包',
    value: secretsOk === true ? '正常' : secretsOk === false ? '异常' : '未知',
    tone: secretsOk === true ? 'success' : secretsOk === false ? 'danger' : 'muted',
    timestamp: backup?.lastSecretsAt ?? null,
    detail: secretsOk === false ? secretsError || '上次密钥包备份失败' : secretsOk === null ? '服务端未上报密钥包状态' : null,
    alert: secretsOk === false,
  })

  // 待确认 / 已确认 / 孤儿归档
  entries.push({
    key: 'pending',
    label: '待确认归档',
    value: pendingCount === null ? '未知' : `${pendingCount} 个`,
    tone: pendingCount === null ? 'muted' : pendingCount > 0 ? 'warning' : 'success',
    timestamp: null,
    detail:
      pendingCount === null
        ? '服务端未上报'
        : pendingCount > 0
          ? `等待 Windows 拉取并确认${pendingBytes !== null && pendingBytes !== undefined ? ` · ${formatBytes(pendingBytes)}` : ''}`
          : '没有待确认归档',
    alert: pendingCount !== null && pendingCount > 0,
  })
  entries.push({
    key: 'acked',
    label: '已确认归档',
    value: ackedBytes !== null && ackedBytes !== undefined ? formatBytes(ackedBytes) : '未知',
    tone: 'muted',
    timestamp: null,
    detail: ackedCount === null ? '服务端未上报数量' : `已确认 ${ackedCount} 个归档`,
    alert: false,
  })
  entries.push({
    key: 'orphan',
    label: '孤儿归档',
    value: orphanCount === null ? '未知' : `${orphanCount} 个`,
    tone: orphanCount === null ? 'muted' : orphanCount > 0 ? 'warning' : 'success',
    timestamp: null,
    detail:
      orphanCount !== null && orphanCount > 0
        ? 'imports 目录存在未登记文件，仅报告不自动删除'
        : orphanCount === null
          ? '服务端未上报'
          : '没有孤儿归档',
    alert: orphanCount !== null && orphanCount > 0,
  })

  const worldState = worldBackupView(world, now)
  entries.push({ key: 'world', label: '世界备份', ...worldState })
  const worldPullState = worldPullView(worldPull, now)
  entries.push({ key: 'worldPull', label: 'PC 拉取', ...worldPullState })
  const drillState = drillView(drill, now)
  entries.push({ key: 'drill', label: '最近演练', ...drillState })

  return entries
}

const TONE_RANK: Record<BackupHealthTone, number> = {
  danger: 3,
  warning: 2,
  success: 1,
  muted: 0,
}

/** 取全部条目中最严重的色调，用于卡片顶部汇总徽章。 */
export function worstBackupTone(entries: BackupStatusEntry[]): BackupHealthTone {
  let result: BackupHealthTone = 'muted'
  for (const entry of entries) {
    if (TONE_RANK[entry.tone] > TONE_RANK[result]) result = entry.tone
  }
  return result
}

/** 健康状态文案：有 danger 显示异常，有 warning 显示注意，否则正常。 */
export function backupHealthLabel(entries: BackupStatusEntry[]): string {
  const tone = worstBackupTone(entries)
  if (tone === 'danger') return '存在异常'
  if (tone === 'warning') return '需要关注'
  if (tone === 'success') return '状态正常'
  return '暂无数据'
}

/** 最近一次成功运行的绝对时间，缺失返回“未运行”。 */
export function lastRunText(timestamp: string | null | undefined): string {
  return timestamp ? formatDateTime(timestamp) : '未运行'
}
