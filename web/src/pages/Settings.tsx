import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Download, KeyRound, LockKeyhole, LogOut, ShieldCheck, Webhook } from 'lucide-react'
import { api, toErrorMessage } from '../api/client'
import type { AlertsConfig, BackupStatus } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { useAppMeta } from '../meta/MetaContext'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Button } from '../components/Button'
import { Badge } from '../components/Badge'
import { FormField } from '../components/FormField'
import { CopyButton } from '../components/CopyButton'
import { Modal } from '../components/Modal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { InlineError } from '../components/InlineError'
import { BackupManager } from '../components/backups/BackupManager'
import { useToast } from '../components/Toast'
import { formatBytes, formatDate, formatDateTime, formatDateTimeWithSeconds, truncateText } from '../lib/format'
import { downloadTextFile } from '../lib/download'

const MIN_PASSWORD_LENGTH = 12
const TOTP_PATTERN = /^\d{6}$/

/** 设置：改密（12+ 与 TOTP）、恢复码、会话、告警配置状态、安全说明与部署信息。 */
export function Settings() {
  const { user, session, logoutAll } = useAuth()
  const { meta } = useAppMeta()
  const navigate = useNavigate()
  const toast = useToast()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordTotp, setPasswordTotp] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordBusy, setPasswordBusy] = useState(false)

  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [recoveryTotp, setRecoveryTotp] = useState('')
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [codesOpen, setCodesOpen] = useState(false)
  const [codesSaved, setCodesSaved] = useState(false)
  const [confirmCloseCodes, setConfirmCloseCodes] = useState(false)

  const [logoutAllOpen, setLogoutAllOpen] = useState(false)
  const [logoutAllBusy, setLogoutAllBusy] = useState(false)

  const [alertsConfig, setAlertsConfig] = useState<AlertsConfig | null>(null)
  const [alertsLoading, setAlertsLoading] = useState(false)
  const [alertsError, setAlertsError] = useState<string | null>(null)
  const [alertTesting, setAlertTesting] = useState(false)
  const [alertsReloadKey, setAlertsReloadKey] = useState(0)
  // 备份健康卡需要 dashboard.backup 的密钥包/世界备份/演练字段；设置页只取一次，不轮询
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)

  useEffect(() => {
    let active = true
    api
      .getDashboard()
      .then((dashboard) => {
        if (active) setBackupStatus(dashboard.backup)
      })
      .catch(() => {
        // 备份卡缺数据时按“未知”降级展示，不影响设置页其它内容
      })
    return () => {
      active = false
    }
  }, [])

  // 告警配置只读展示（阈值/Webhook 状态），不提供前端修改
  useEffect(() => {
    if (!meta.alertsEnabled) {
      setAlertsConfig(null)
      setAlertsLoading(false)
      return
    }
    let active = true
    setAlertsLoading(true)
    setAlertsError(null)
    api.alerts
      .list(1)
      .then((result) => {
        if (active) setAlertsConfig(result.config)
      })
      .catch((loadError) => {
        if (active) setAlertsError(toErrorMessage(loadError, '读取告警配置失败'))
      })
      .finally(() => {
        if (active) setAlertsLoading(false)
      })
    return () => {
      active = false
    }
  }, [meta.alertsEnabled, alertsReloadKey])

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setPasswordError(null)
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('请填写全部密码字段')
      return
    }
    if (!TOTP_PATTERN.test(passwordTotp.trim())) {
      setPasswordError('请输入 6 位 TOTP 验证码')
      return
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`)
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致')
      return
    }
    setPasswordBusy(true)
    try {
      await api.account.changePassword(currentPassword, newPassword, passwordTotp.trim())
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordTotp('')
      toast.success('密码已修改，其它会话已失效')
    } catch (changeError) {
      setPasswordError(toErrorMessage(changeError, '修改密码失败，请重试'))
    } finally {
      setPasswordBusy(false)
    }
  }

  const handleGenerateCodes = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!recoveryPassword) {
      setRecoveryError('请输入当前密码')
      return
    }
    if (!TOTP_PATTERN.test(recoveryTotp.trim())) {
      setRecoveryError('请输入 6 位 TOTP 验证码')
      return
    }
    setRecoveryBusy(true)
    setRecoveryError(null)
    try {
      const result = await api.account.generateRecoveryCodes(recoveryPassword, recoveryTotp.trim())
      setCodes(result.codes)
      setCodesSaved(false)
      setCodesOpen(true)
      setRecoveryPassword('')
      setRecoveryTotp('')
      toast.success('已生成新的恢复码，旧恢复码已失效')
    } catch (generateError) {
      setRecoveryError(toErrorMessage(generateError, '生成恢复码失败，请重试'))
    } finally {
      setRecoveryBusy(false)
    }
  }

  const closeCodes = (): void => {
    setCodesOpen(false)
    setConfirmCloseCodes(false)
    setCodes(null)
    setCodesSaved(false)
  }

  // 恢复码只展示一次：未复制/下载时二次确认，避免误关丢失
  const requestCloseCodes = (): void => {
    if (codes && !codesSaved) {
      setConfirmCloseCodes(true)
      return
    }
    closeCodes()
  }

  const handleDownloadCodes = (): void => {
    if (!codes) return
    const content = [
      'AntifieldCloud 恢复码',
      `生成时间：${formatDateTimeWithSeconds(new Date().toISOString())}（Asia/Shanghai）`,
      '',
      '每个恢复码只能使用一次，请离线妥善保存。',
      '重新生成恢复码会使本文件中的全部恢复码立即失效。',
      '',
      ...codes,
      '',
    ].join('\n')
    downloadTextFile(`antifieldcloud-recovery-codes-${formatDate(new Date().toISOString())}.txt`, content)
    setCodesSaved(true)
  }

  const handleTestAlert = async (): Promise<void> => {
    if (alertTesting) return
    setAlertTesting(true)
    try {
      const result = await api.alerts.test()
      if (result.delivered) toast.success(result.message || '测试告警已发送')
      else toast.error(result.message || 'Webhook 未送达，请检查服务端告警配置')
    } catch (testError) {
      toast.error(toErrorMessage(testError, '发送测试告警失败'))
    } finally {
      setAlertTesting(false)
    }
  }

  const handleLogoutAll = async (): Promise<void> => {
    setLogoutAllBusy(true)
    try {
      await logoutAll()
      toast.success('已退出全部会话')
      navigate('/login', { replace: true })
    } catch (logoutError) {
      toast.error(toErrorMessage(logoutError, '退出全部会话失败，请重试'))
      setLogoutAllBusy(false)
    }
  }

  const appOrigin = meta.appOrigin || '未配置'
  const aiOrigin = meta.aiOrigin || '未配置'

  return (
    <div className="settings-page">
      <PageHeader title="设置" description="账号安全、会话、告警与部署信息" />

      <div className="settings-grid">
        <Card
          title="修改密码"
          description="修改成功后，除当前会话外的其它会话会立即失效。"
          className="settings-card"
        >
          <form className="settings-form" onSubmit={(event) => void handleChangePassword(event)}>
            <FormField label="当前密码" htmlFor="settings-current-password" required>
              <input
                id="settings-current-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={passwordBusy}
              />
            </FormField>
            <FormField
              label="新密码"
              htmlFor="settings-new-password"
              hint={`至少 ${MIN_PASSWORD_LENGTH} 个字符；建议混合大小写、数字与符号。`}
              required
            >
              <input
                id="settings-new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={passwordBusy}
              />
            </FormField>
            <FormField label="确认新密码" htmlFor="settings-confirm-password" required>
              <input
                id="settings-confirm-password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={passwordBusy}
              />
            </FormField>
            <FormField label="TOTP 验证码" htmlFor="settings-password-totp" hint="输入身份验证器当前的 6 位验证码。" required>
              <input
                id="settings-password-totp"
                className="input settings-totp-input"
                value={passwordTotp}
                onChange={(event) => setPasswordTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                disabled={passwordBusy}
              />
            </FormField>
            {passwordError ? <p className="field-error" role="alert">{passwordError}</p> : null}
            <div className="form-actions">
              <Button type="submit" variant="primary" icon={<LockKeyhole size={16} aria-hidden="true" />} loading={passwordBusy}>
                修改密码
              </Button>
            </div>
          </form>
        </Card>

        <Card
          title="恢复码"
          description="验证器丢失时可用恢复码登录；每个恢复码只能使用一次。"
          className="settings-card"
        >
          <div className="notice notice-warning">
            重新生成后旧恢复码立即失效，新恢复码只展示一次。请下载或抄写后离线保存。
          </div>
          <form className="settings-form" onSubmit={(event) => void handleGenerateCodes(event)}>
            <FormField label="当前密码" htmlFor="settings-recovery-password" hint="用于确认身份。" required>
              <input
                id="settings-recovery-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={recoveryPassword}
                onChange={(event) => setRecoveryPassword(event.target.value)}
                disabled={recoveryBusy}
              />
            </FormField>
            <FormField label="TOTP 验证码" htmlFor="settings-recovery-totp" hint="输入身份验证器当前的 6 位验证码。" required>
              <input
                id="settings-recovery-totp"
                className="input settings-totp-input"
                value={recoveryTotp}
                onChange={(event) => setRecoveryTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                disabled={recoveryBusy}
              />
            </FormField>
            {recoveryError ? <p className="field-error" role="alert">{recoveryError}</p> : null}
            <div className="form-actions">
              <Button type="submit" variant="secondary" icon={<KeyRound size={16} aria-hidden="true" />} loading={recoveryBusy}>
                重新生成恢复码
              </Button>
            </div>
          </form>
        </Card>

        <Card
          title="当前会话"
          description={`已登录为 ${user?.username ?? '—'}`}
          actions={<Badge tone="success" dot>已登录</Badge>}
          className="settings-card"
        >
          <dl className="settings-list">
            <div className="settings-list-row">
              <dt>用户名</dt>
              <dd>{user?.username ?? '—'}</dd>
            </div>
            <div className="settings-list-row">
              <dt>创建时间</dt>
              <dd>{formatDateTime(session?.createdAt)}</dd>
            </div>
            <div className="settings-list-row">
              <dt>过期时间</dt>
              <dd>{formatDateTime(session?.expiresAt)}</dd>
            </div>
            <div className="settings-list-row">
              <dt>IP 地址</dt>
              <dd className="mono">{session?.ip ?? '—'}</dd>
            </div>
            <div className="settings-list-row">
              <dt>客户端</dt>
              <dd title={session?.userAgent ?? ''}>{session?.userAgent ? truncateText(session.userAgent, 56) : '—'}</dd>
            </div>
          </dl>
          <div className="form-actions">
            <Button
              variant="danger"
              icon={<LogOut size={16} aria-hidden="true" />}
              onClick={() => setLogoutAllOpen(true)}
            >
              退出全部会话
            </Button>
          </div>
        </Card>

        <Card
          title="告警配置"
          description="只读展示服务端阈值与 Webhook 状态；修改需调整服务端环境变量。"
          actions={<Badge tone={alertsConfig?.enabled ? 'accent' : 'muted'}>{alertsConfig?.enabled ? '已启用' : meta.alertsEnabled ? '状态未知' : '未启用'}</Badge>}
          className="settings-card"
        >
          <div id="alerts" className="settings-anchor" aria-hidden="true" />
          {!meta.alertsEnabled ? (
            <div className="notice notice-muted">服务端未启用告警功能（/api/version alertsEnabled=false）。</div>
          ) : alertsError && !alertsConfig ? (
            <InlineError message={alertsError} onRetry={() => setAlertsReloadKey((value) => value + 1)} />
          ) : alertsLoading && !alertsConfig ? (
            <p className="muted">正在读取告警配置…</p>
          ) : alertsConfig ? (
            <>
              <div className="settings-alert-status">
                <Webhook size={16} aria-hidden="true" />
                <span>Webhook</span>
                <Badge tone={alertsConfig.webhookConfigured ? 'success' : 'warning'}>
                  {alertsConfig.webhookConfigured ? '已配置' : '未配置'}
                </Badge>
              </div>
              <dl className="settings-list">
                <div className="settings-list-row">
                  <dt>磁盘剩余阈值</dt>
                  <dd>{alertsConfig.diskFreePct === null ? '—' : `${alertsConfig.diskFreePct}%`}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>温度阈值</dt>
                  <dd>{alertsConfig.tempC === null ? '—' : `${alertsConfig.tempC} ℃`}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>备份超期阈值</dt>
                  <dd>{alertsConfig.backupMaxAgeHours === null ? '—' : `${alertsConfig.backupMaxAgeHours} 小时`}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>冷却时间</dt>
                  <dd>{alertsConfig.cooldownMinutes === null ? '—' : `${alertsConfig.cooldownMinutes} 分钟`}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>检查间隔</dt>
                  <dd>{alertsConfig.checkIntervalSeconds === null ? '—' : `${alertsConfig.checkIntervalSeconds} 秒`}</dd>
                </div>
              </dl>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  icon={<Bell size={16} aria-hidden="true" />}
                  loading={alertTesting}
                  onClick={() => void handleTestAlert()}
                  disabled={!alertsConfig.enabled}
                >
                  测试 Webhook
                </Button>
              </div>
            </>
          ) : null}
        </Card>

        <Card
          title="备份与恢复"
          description="归档列表、导入校验与文件级恢复；恢复需要 TOTP 与确认文本。"
          actions={
            <Badge tone={meta.backupRestoreEnabled ? 'accent' : 'muted'}>
              {meta.backupRestoreEnabled ? '恢复向导已启用' : '恢复向导未启用'}
            </Badge>
          }
          className="settings-card-wide"
        >
          <div id="backup" className="settings-anchor" aria-hidden="true" />
          <BackupManager backupStatus={backupStatus} />
        </Card>

        <Card title="关于" description="AntifieldCloud · 个人工作台" className="settings-card">
          <dl className="settings-list">
            <div className="settings-list-row">
              <dt>版本</dt>
              <dd>{meta.version ?? '—'}</dd>
            </div>
            <div className="settings-list-row">
              <dt>部署环境</dt>
              <dd>Raspberry Pi 5 · Debian 13 · Node 26</dd>
            </div>
            <div className="settings-list-row">
              <dt>服务入口</dt>
              <dd className="mono">{appOrigin}</dd>
            </div>
            <div className="settings-list-row">
              <dt>AI 工作区</dt>
              <dd className="mono">{aiOrigin}</dd>
            </div>
            <div className="settings-list-row">
              <dt>回收站保留</dt>
              <dd>{meta.trashRetentionDays} 天</dd>
            </div>
            <div className="settings-list-row">
              <dt>单文件上限</dt>
              <dd>{formatBytes(meta.maxUploadBytes)}</dd>
            </div>
            <div className="settings-list-row">
              <dt>功能开关</dt>
              <dd>
                <Badge tone={meta.sharesEnabled ? 'success' : 'muted'}>文件分享</Badge>{' '}
                <Badge tone={meta.alertsEnabled ? 'success' : 'muted'}>告警</Badge>
              </dd>
            </div>
            <div className="settings-list-row">
              <dt>文档</dt>
              <dd className="mono settings-doc-paths">docs/PLAN.md · docs/API.md · docs/UI-SPEC.md · docs/SECURITY.md</dd>
            </div>
          </dl>
        </Card>

        <Card
          title="安全说明"
          description="这些约束由服务端强制执行，前端仅做提示。"
          actions={<ShieldCheck size={18} className="text-accent" aria-hidden="true" />}
          className="settings-card settings-card-wide"
        >
          <ul className="security-notes">
            <li>登录需要密码 + TOTP 两步验证；恢复码一次性使用，建议离线保存。</li>
            <li>修改密码与重新生成恢复码都需要当前密码 + TOTP，防止会话被劫持后直接改密。</li>
            <li>所有写操作校验 CSRF；会话 Cookie 为 HttpOnly + Secure + SameSite=Lax。</li>
            <li>文件内容不可变，上传不允许覆盖；SVG/HTML/XML 只能下载，不会被内联渲染。</li>
            <li>公开分享链接可被任何持有者访问，请按需设置密码、过期时间与下载次数。</li>
            <li>PWA Service Worker 只缓存静态壳资源，绝不缓存 API 响应与文件内容。</li>
            <li>备份归档包含配置与文件元数据等敏感信息，请妥善保管 Windows 备份目录。</li>
            <li>Cloudflare Tunnel 终止 TLS，Cloudflare 可见明文流量；请勿通过公网传输高度敏感的数据。</li>
            <li>审计日志只记录元数据，不记录文件内容、密码、TOTP、Cookie 或 Authorization。</li>
            <li>opencode 通过 {aiOrigin} 统一登录，无需在浏览器中保存额外密码。</li>
          </ul>
        </Card>
      </div>

      <Modal
        open={codesOpen}
        title="新的恢复码"
        description="每个恢复码只能使用一次，请立即离线保存。"
        size="md"
        onClose={requestCloseCodes}
        footer={
          <>
            <CopyButton
              value={(codes ?? []).join('\n')}
              label="复制全部"
              size="md"
              variant="secondary"
              disabled={!codes}
              onCopied={() => setCodesSaved(true)}
            />
            <Button
              variant="secondary"
              icon={<Download size={16} aria-hidden="true" />}
              onClick={handleDownloadCodes}
              disabled={!codes}
            >
              下载 TXT
            </Button>
            <Button variant="primary" onClick={requestCloseCodes}>关闭</Button>
          </>
        }
      >
        <div className="notice notice-warning">
          恢复码只展示这一次，关闭后无法再次查看；重新生成会使旧恢复码立即失效。
        </div>
        {codes ? (
          <ul className="recovery-codes">
            {codes.map((code) => (
              <li key={code} className="mono">{code}</li>
            ))}
          </ul>
        ) : null}
        {codesSaved ? (
          <p className="field-hint">已复制或下载，可安全关闭此窗口。</p>
        ) : (
          <p className="field-hint">关闭前请先复制或下载恢复码。</p>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmCloseCodes}
        title="关闭恢复码窗口"
        message="恢复码尚未复制或下载，关闭后将无法再次查看。"
        details="确认关闭后，如未保存只能重新生成恢复码（会使旧码立即失效）。"
        confirmText="仍然关闭"
        cancelText="返回保存"
        loading={false}
        onConfirm={closeCodes}
        onClose={() => setConfirmCloseCodes(false)}
      />

      <ConfirmDialog
        open={logoutAllOpen}
        title="退出全部会话"
        message="确定退出所有已登录的会话？"
        details="包括当前浏览器在内的全部会话将立即失效，需要用密码 + TOTP 重新登录。"
        confirmText="退出全部会话"
        loading={logoutAllBusy}
        onConfirm={() => void handleLogoutAll()}
        onClose={() => {
          if (!logoutAllBusy) setLogoutAllOpen(false)
        }}
      />
    </div>
  )
}
