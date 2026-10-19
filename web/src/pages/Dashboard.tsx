import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ChevronRight,
  Cloud,
  CloudUpload,
  Cpu,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  HardDrive,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { api, toErrorMessage } from '../api/client'
import type { DashboardData, ServiceState, ServicesStatus } from '../api/types'
import { usePolling } from '../hooks/usePolling'
import { useNow } from '../hooks/useNow'
import { PageHeader } from '../components/PageHeader'
import { Stat } from '../components/Stat'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import type { BadgeTone } from '../components/Badge'
import { Button } from '../components/Button'
import { ProgressBar } from '../components/ProgressBar'
import { EmptyState } from '../components/EmptyState'
import { CopyButton } from '../components/CopyButton'
import { Avatar } from '../components/Avatar'
import { RelativeTime } from '../components/RelativeTime'
import { AuditEntry } from '../components/AuditEntry'
import { SkeletonText } from '../components/Skeleton'
import { formatBytes, formatClock, formatDateTime, formatPercent, formatRelative, formatUptime, percentOf } from '../lib/format'
import { cx } from '../lib/classnames'

const SERVICE_LABELS: Record<keyof ServicesStatus, string> = {
  minecraft: 'Minecraft',
  cloudflared: 'Cloudflare Tunnel',
  nginx: 'Nginx',
  opencode: 'opencode',
}

const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  active: '运行中',
  inactive: '已停止',
  unknown: '未知',
}

const SERVICE_BADGE_TONES: Record<ServiceState, BadgeTone> = {
  active: 'success',
  inactive: 'danger',
  unknown: 'muted',
}

/** 工作台：10s 轮询，页面隐藏时暂停；刷新失败保留旧数据并提示。 */
export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const dataRef = useRef<DashboardData | null>(null)
  const now = useNow(1000)

  const load = useCallback(async (mode: 'initial' | 'refresh'): Promise<void> => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    try {
      const result = await api.getDashboard()
      dataRef.current = result
      setData(result)
      setError(null)
      setRefreshError(null)
    } catch (loadError) {
      const message = toErrorMessage(loadError, '加载工作台数据失败')
      if (dataRef.current) setRefreshError(message)
      else setError(message)
    } finally {
      if (mode === 'initial') setLoading(false)
      else setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load('initial')
  }, [load])

  usePolling(() => load('refresh'), 10_000)

  if (loading && !data) {
    return (
      <div className="dashboard-page">
        <PageHeader title="工作台" description="正在加载主机与存储状态…" />
        <div className="stats-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <Stat key={index} label="加载中" value="" loading />
          ))}
        </div>
        <div className="dashboard-row dashboard-row-details">
          <Card loading skeleton={<SkeletonText lines={6} />} />
          <Card loading skeleton={<SkeletonText lines={5} />} />
          <Card loading skeleton={<SkeletonText lines={4} />} />
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="dashboard-page">
        <PageHeader title="工作台" description="主机、存储、Minecraft 与备份状态一览" />
        <Card title="工作台数据加载失败" error={error} onRetry={() => void load('initial')} />
      </div>
    )
  }

  if (!data) return null

  const { host, storage, minecraft, backup, opencode, services, activity } = data
  const storagePercent = percentOf(storage.usedBytes, storage.quotaBytes)
  const memPercent = percentOf(host.mem.usedBytes, host.mem.totalBytes)
  const rootPercent = percentOf(host.root.usedBytes, host.root.totalBytes)
  const backupStale = backup
    ? Boolean(backup.overdue) || backup.ok === false || (backup.ageHours !== null && backup.ageHours > 48)
    : false
  const mcDegraded = minecraft.tps === null || minecraft.whitelistCount === null
  const tempClass =
    host.tempC === null ? 'text-dim' : host.tempC >= 85 ? 'text-danger' : host.tempC >= 75 ? 'text-warning' : undefined
  const aiUrl = opencode.url || 'https://ai.example.com'

  return (
    <div className="dashboard-page">
      <PageHeader
        title="工作台"
        description={data ? `主机 ${host.hostname} · 数据生成于 ${formatDateTime(data.generatedAt)}` : undefined}
        actions={
          <div className="dashboard-actions">
            <span className="dashboard-clock" title="Asia/Shanghai">{formatClock(new Date(now))}</span>
            <Button
              variant="secondary"
              size="md"
              icon={<RefreshCw size={16} aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void load('refresh')}
            >
              刷新
            </Button>
          </div>
        }
      />

      {refreshError ? (
        <div className="notice notice-warning" role="alert">
          <span>数据刷新失败：{refreshError}，当前显示的是上次成功的数据。</span>
          <Button size="sm" variant="secondary" onClick={() => void load('refresh')}>重试</Button>
        </div>
      ) : null}

      <div className="stats-grid">
        <Stat
          label="主机"
          icon={<Cpu size={16} />}
          value={formatPercent(host.cpuPercent, 0)}
          unit="CPU"
          hint={
            <>
              负载 {host.load.map((value) => value.toFixed(2)).join(' / ')}
              {' · '}
              <span className={tempClass}>温度 {host.tempC === null ? '—' : `${host.tempC.toFixed(1)} ℃`}</span>
              {' · '}
              运行 {formatUptime(host.uptimeSec)}
            </>
          }
          footer={
            <>
              <ProgressBar value={memPercent} tone="auto" ariaLabel="内存使用率" />
              <div className="stat-meta">
                <span>内存 {formatBytes(host.mem.usedBytes)} / {formatBytes(host.mem.totalBytes)}</span>
                <span>{formatPercent(memPercent)}</span>
              </div>
            </>
          }
        />

        <Stat
          label="存储"
          icon={<HardDrive size={16} />}
          value={formatBytes(storage.usedBytes)}
          unit={`/ ${formatBytes(storage.quotaBytes)}`}
          tone={storagePercent >= 90 ? 'warning' : 'default'}
          badge={storagePercent >= 90 ? <Badge tone="warning">空间紧张</Badge> : undefined}
          hint={`文件 ${storage.fileCount} 个 · 回收站 ${formatBytes(storage.trashBytes)}`}
          footer={
            <>
              <ProgressBar value={storagePercent} tone="auto" ariaLabel="存储配额使用率" />
              <div className="stat-meta">
                <span>已用 {formatPercent(storagePercent, 1)}</span>
                <span>剩余 {formatBytes(storage.freeBytes)}</span>
              </div>
            </>
          }
        />

        <Stat
          label="Minecraft"
          icon={<Gamepad2 size={16} />}
          value={minecraft.online ? `${minecraft.players.online}/${minecraft.players.max}` : '离线'}
          unit={minecraft.online ? '在线玩家' : undefined}
          tone={minecraft.online ? 'success' : 'danger'}
          badge={<Badge tone={minecraft.online ? 'success' : 'danger'} dot>{minecraft.online ? '在线' : '离线'}</Badge>}
          hint={
            minecraft.online ? (
              <>
                {minecraft.version || '版本未知'}
                {' · '}
                TPS {minecraft.tps ? minecraft.tps.m1.toFixed(2) : '—'}
                {' · '}
                白名单 {minecraft.whitelistCount ?? '—'}
              </>
            ) : (
              <span className="text-warning">{minecraft.error ?? '服务器未响应'}</span>
            )
          }
        />

        <Stat
          label="备份"
          icon={<CloudUpload size={16} />}
          value={backup?.lastPullAt ? formatRelative(backup.lastPullAt, now) : '无记录'}
          tone={backupStale ? 'danger' : 'default'}
          badge={
            backup === null ? (
              <Badge tone="muted">无数据</Badge>
            ) : backupStale ? (
              <Badge tone="danger" dot>备份已过期</Badge>
            ) : (
              <Badge tone="success" dot>正常</Badge>
            )
          }
          hint={
            backup
              ? `${formatBytes(backup.sizeBytes)} · 最近拉取 ${formatDateTime(backup.lastPullAt)}`
              : '尚未收到 Windows 备份任务的上报'
          }
          footer={
            backupStale ? (
              <span className="stat-note text-danger">最近拉取已超过 48 小时，请检查 Windows 备份计划任务。</span>
            ) : null
          }
        />
      </div>

      <div className="dashboard-row dashboard-row-details">
        <Card
          title="Minecraft 详情"
          actions={<Link className="text-link" to="/minecraft">管理白名单<ChevronRight size={14} aria-hidden="true" /></Link>}
          className="mc-detail-card"
        >
          <div className="mc-detail-head">
            <div className="mc-detail-status">
              <Badge tone={minecraft.online ? 'success' : 'danger'} dot>
                {minecraft.online ? '在线' : '离线'}
              </Badge>
              {minecraft.version ? <span className="mc-version">{minecraft.version}</span> : null}
            </div>
            {minecraft.publicAddress ? (
              <div className="mc-address">
                <span className="mono">{minecraft.publicAddress}</span>
                <CopyButton value={minecraft.publicAddress} label="复制地址" ariaLabel="复制 Minecraft 公共地址" />
              </div>
            ) : null}
          </div>

          {minecraft.motd ? <p className="mc-motd">{minecraft.motd}</p> : null}
          {minecraft.error ? <div className="notice notice-warning">{minecraft.error}</div> : null}
          {mcDegraded && !minecraft.error ? (
            <div className="notice notice-warning">RCON 不可用，TPS 与白名单数据暂时无法读取。</div>
          ) : null}

          <div className="mc-facts">
            <div className="mc-fact">
              <span className="mc-fact-label">在线玩家</span>
              <span className="mc-fact-value">{minecraft.players.online} / {minecraft.players.max}</span>
            </div>
            <div className="mc-fact">
              <span className="mc-fact-label">TPS（1m / 5m / 15m）</span>
              <span className="mc-fact-value">
                {minecraft.tps
                  ? `${minecraft.tps.m1.toFixed(1)} / ${minecraft.tps.m5.toFixed(1)} / ${minecraft.tps.m15.toFixed(1)}`
                  : '—'}
              </span>
            </div>
            <div className="mc-fact">
              <span className="mc-fact-label">白名单</span>
              <span className="mc-fact-value">{minecraft.whitelistCount ?? '—'}</span>
            </div>
            <div className="mc-fact">
              <span className="mc-fact-label">服务状态</span>
              <span className="mc-fact-value">{SERVICE_STATE_LABELS[minecraft.serviceActive]}</span>
            </div>
          </div>

          <div className="subsection">
            <h3 className="subsection-title">在线玩家</h3>
            {minecraft.players.names.length > 0 ? (
              <ul className="player-chips">
                {minecraft.players.names.map((name) => (
                  <li key={name} className="player-chip">
                    <Avatar name={name} size={22} />
                    <span>{name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">暂无玩家在线</p>
            )}
          </div>

          <p className="card-footnote">
            状态更新于 <RelativeTime ts={minecraft.checkedAt} />
          </p>
        </Card>

        <Card title="快捷入口">
          <ul className="quick-links">
            <li>
              <a className="quick-link" href={aiUrl} target="_blank" rel="noopener noreferrer">
                <span className="quick-icon" aria-hidden="true"><Sparkles size={18} /></span>
                <span className="quick-text">
                  <strong>AI 工作区</strong>
                  <span>opencode · 统一登录</span>
                </span>
                <ExternalLink size={15} aria-hidden="true" />
              </a>
            </li>
            <li>
              <a className="quick-link" href="https://connect.raspberrypi.com" target="_blank" rel="noopener noreferrer">
                <span className="quick-icon" aria-hidden="true"><Cloud size={18} /></span>
                <span className="quick-text">
                  <strong>RPi Connect</strong>
                  <span>远程连接树莓派</span>
                </span>
                <ExternalLink size={15} aria-hidden="true" />
              </a>
            </li>
            <li>
              <div className="quick-link">
                <span className="quick-icon" aria-hidden="true"><Gamepad2 size={18} /></span>
                <span className="quick-text">
                  <strong>Minecraft 地址</strong>
                  <span className="mono">{minecraft.publicAddress || '暂不可用'}</span>
                </span>
                <CopyButton
                  value={minecraft.publicAddress ?? ''}
                  label="复制"
                  iconOnly
                  ariaLabel="复制 Minecraft 服务器地址"
                  disabled={!minecraft.publicAddress}
                />
              </div>
            </li>
            <li>
              <Link className="quick-link" to="/files">
                <span className="quick-icon" aria-hidden="true"><FolderOpen size={18} /></span>
                <span className="quick-text">
                  <strong>云盘</strong>
                  <span>上传、预览与管理文件</span>
                </span>
                <ChevronRight size={15} aria-hidden="true" />
              </Link>
            </li>
          </ul>
        </Card>

        <Card title="服务状态">
          <ul className="service-list">
            {(Object.entries(services) as [string, ServiceState][]).map(([key, state]) => (
              <li key={key} className="service-item">
                <span className={cx('service-dot', `service-dot-${state}`)} aria-hidden="true" />
                <span className="service-name">{SERVICE_LABELS[key as keyof ServicesStatus] ?? key}</span>
                <Badge tone={SERVICE_BADGE_TONES[state]}>{SERVICE_STATE_LABELS[state]}</Badge>
              </li>
            ))}
          </ul>
          <div className="service-extra">
            <div className="service-extra-row">
              <span>opencode 会话</span>
              <span>{opencode.sessions ?? '—'}</span>
            </div>
            <div className="service-extra-row">
              <span>根分区使用</span>
              <span>{formatPercent(rootPercent, 1)}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="最近活动"
        actions={<Link className="text-link" to="/activity">查看全部<ChevronRight size={14} aria-hidden="true" /></Link>}
        flush
      >
        {activity.length > 0 ? (
          <ul className="audit-list">
            {activity.slice(0, 8).map((item) => (
              <AuditEntry key={item.id} item={item} />
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<Activity size={22} />}
            title="暂无活动记录"
            description="登录、文件操作与白名单变更会记录在这里。"
          />
        )}
      </Card>
    </div>
  )
}
