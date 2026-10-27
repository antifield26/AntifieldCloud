// 备份整包加密只读状态卡（v0.7.0）：默认关闭；Web 不持私钥，加密归档只能 PC 侧解密校验/恢复。
// 只展示服务端下发的公开状态（公钥指纹、最近加密时间、错误摘要），绝不接收/展示私钥。

import type { BackupEncryptionStatus } from '../../api/types'
import { Badge } from '../Badge'
import { Card } from '../Card'
import { encryptionView } from '../../lib/backup-status'

export interface BackupEncryptionCardProps {
  encryption?: BackupEncryptionStatus | null
}

export function BackupEncryptionCard({ encryption = null }: BackupEncryptionCardProps) {
  const view = encryptionView(encryption)
  const enabled = encryption?.enabled === true
  return (
    <Card
      title="备份加密"
      description="age 整包加密（默认关闭）；Web 不持有私钥，加密归档只能在 PC 上解密校验/恢复。"
      actions={<Badge tone={view.tone === 'success' ? 'success' : view.tone === 'danger' ? 'danger' : 'muted'}>{view.value}</Badge>}
    >
      <dl className="settings-list">
        <div className="settings-list-row">
          <dt>状态</dt>
          <dd>{view.detail ?? (enabled ? '已启用' : '未启用')}</dd>
        </div>
        <div className="settings-list-row">
          <dt>age 公钥</dt>
          <dd>{encryption?.keyConfigured === true ? '已配置' : encryption?.enabled ? '缺失（prepare 会失败关闭）' : '未启用'}</dd>
        </div>
      </dl>
      <p className="field-hint">
        加密归档文件名为 <span className="mono">*.tar.gz.age</span>；Web 禁用校验/恢复与导入，PC 端使用离线 age 私钥（见 docs/BACKUP.md）。
      </p>
    </Card>
  )
}
