// 异地副本只读状态卡（v0.7.0）：状态由 PC 端 backup-offsite 脚本写入只读 JSON，应用只读展示。
// 不展示远端真实路径/URL/凭据；目标只显示别名，保留份数兼容 kept 数组 + keptCount。

import type { OffsiteStatus } from '../../api/types'
import { Badge } from '../Badge'
import { Card } from '../Card'
import { RelativeTime } from '../RelativeTime'
import { formatBytes } from '../../lib/format'
import { keptCountOf, offsiteView } from '../../lib/backup-status'

export interface BackupOffsiteCardProps {
  offsite?: OffsiteStatus | null
}

export function BackupOffsiteCard({ offsite = null }: BackupOffsiteCardProps) {
  const view = offsiteView(offsite)
  const kept = offsite?.keptRemote ?? keptCountOf(offsite ?? {})
  const tone = view.tone === 'success' ? 'success' : view.tone === 'danger' ? 'danger' : view.tone === 'warning' ? 'warning' : 'muted'
  return (
    <Card
      title="异地副本"
      description="PC 端 rclone 异地副本（默认关闭）；只上传 age 加密归档，状态文件由 PC 写入、Pi 只读。"
      actions={<Badge tone={tone}>{view.value}</Badge>}
    >
      <dl className="settings-list">
        <div className="settings-list-row">
          <dt>最近同步</dt>
          <dd>{offsite?.lastPushAt || offsite?.lastRunAt ? <RelativeTime ts={offsite.lastPushAt ?? offsite.lastRunAt ?? null} /> : '未运行'}</dd>
        </div>
        <div className="settings-list-row">
          <dt>目标</dt>
          <dd>{offsite?.remoteLabel || offsite?.targetAlias || '未配置（不展示远端真实路径/凭据）'}</dd>
        </div>
        <div className="settings-list-row">
          <dt>本次上传 / 跳过 / 失败</dt>
          <dd>
            {offsite?.uploaded ?? offsite?.transferredCount ?? '—'} / {offsite?.skipped ?? '—'} / {offsite?.failed ?? '—'} 个
            {offsite?.bytes !== null && offsite?.bytes !== undefined ? ` · ${formatBytes(offsite.bytes)}` : ''}
          </dd>
        </div>
        <div className="settings-list-row">
          <dt>远端保留</dt>
          <dd>{kept !== null ? `${kept} 份` : '未知'}</dd>
        </div>
        {offsite?.plaintextSkipped !== null && offsite?.plaintextSkipped !== undefined && offsite.plaintextSkipped > 0 ? (
          <div className="settings-list-row">
            <dt>拒绝明文</dt>
            <dd className="text-warning">{offsite.plaintextSkipped} 个（脚本只上传 .age）</dd>
          </div>
        ) : null}
        {offsite?.lastError || offsite?.error ? (
          <div className="settings-list-row">
            <dt>最近错误</dt>
            <dd className="text-danger">{offsite.lastError || offsite.error}</dd>
          </div>
        ) : null}
      </dl>
      <p className="field-hint">
        {view.detail ?? '状态文件缺失时不当作成功；超期或失败会在备份健康卡与告警中提示。'}
      </p>
    </Card>
  )
}
