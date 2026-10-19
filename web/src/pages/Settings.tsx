import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, KeyRound, LockKeyhole, LogOut, ShieldCheck } from 'lucide-react'
import { api, toErrorMessage } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Button } from '../components/Button'
import { Badge } from '../components/Badge'
import { FormField } from '../components/FormField'
import { CopyButton } from '../components/CopyButton'
import { Modal } from '../components/Modal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'
import { formatDate, formatDateTime, formatDateTimeWithSeconds, truncateText } from '../lib/format'
import { downloadTextFile } from '../lib/download'

/** 设置：修改密码、重新生成恢复码、退出全部会话与安全说明。 */
export function Settings() {
  const { user, session, logoutAll } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  // 不写死部署域名：默认按 app.<domain> 推导 ai.<domain>，也允许本地回环。
  const appHost = typeof window !== 'undefined' ? window.location.hostname : 'app.example.com'
  const aiHost = appHost.startsWith('app.') ? `ai.${appHost.slice(4)}` : 'ai.example.com'

  const [version, setVersion] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordBusy, setPasswordBusy] = useState(false)

  const [recoveryPassword, setRecoveryPassword] = useState('')
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [codesOpen, setCodesOpen] = useState(false)

  const [logoutAllOpen, setLogoutAllOpen] = useState(false)
  const [logoutAllBusy, setLogoutAllBusy] = useState(false)

  useEffect(() => {
    let active = true
    api
      .getVersion()
      .then((result) => {
        if (active) setVersion(result.version)
      })
      .catch(() => {
        // 版本接口可选，失败时显示未知
      })
    return () => {
      active = false
    }
  }, [])

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setPasswordError(null)
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('请填写全部密码字段')
      return
    }
    if (newPassword.length < 8) {
      setPasswordError('新密码至少需要 8 个字符')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致')
      return
    }
    setPasswordBusy(true)
    try {
      await api.account.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
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
    setRecoveryBusy(true)
    setRecoveryError(null)
    try {
      const result = await api.account.generateRecoveryCodes(recoveryPassword)
      setCodes(result.codes)
      setCodesOpen(true)
      setRecoveryPassword('')
      toast.success('已生成新的恢复码，旧恢复码已失效')
    } catch (generateError) {
      setRecoveryError(toErrorMessage(generateError, '生成恢复码失败，请重试'))
    } finally {
      setRecoveryBusy(false)
    }
  }

  const closeCodes = (): void => {
    setCodesOpen(false)
    setCodes(null)
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

  return (
    <div className="settings-page">
      <PageHeader title="设置" description="账号安全、会话与部署信息" />

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
            <FormField label="新密码" htmlFor="settings-new-password" hint="至少 8 个字符；建议混合大小写、数字与符号。" required>
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

        <Card title="关于" description="AntifieldCloud · 个人工作台" className="settings-card">
          <dl className="settings-list">
            <div className="settings-list-row">
              <dt>版本</dt>
              <dd>{version ?? '—'}</dd>
            </div>
            <div className="settings-list-row">
              <dt>部署环境</dt>
              <dd>Raspberry Pi 5 · Debian 13 · Node 26</dd>
            </div>
            <div className="settings-list-row">
              <dt>服务入口</dt>
              <dd className="mono">{appHost}</dd>
            </div>
            <div className="settings-list-row">
              <dt>AI 工作区</dt>
              <dd className="mono">{aiHost}</dd>
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
            <li>所有写操作校验 CSRF；会话 Cookie 为 HttpOnly + Secure + SameSite=Lax。</li>
            <li>文件内容不可变，上传不允许覆盖；SVG/HTML/XML 只能下载，不会被内联渲染。</li>
            <li>备份归档包含配置与文件元数据等敏感信息，请妥善保管 Windows 备份目录。</li>
            <li>Cloudflare Tunnel 终止 TLS，Cloudflare 可见明文流量；请勿通过公网传输高度敏感的数据。</li>
            <li>审计日志只记录元数据，不记录文件内容、密码、TOTP、Cookie 或 Authorization。</li>
            <li>opencode 通过 {aiHost} 统一登录，无需在浏览器中保存额外密码。</li>
          </ul>
        </Card>
      </div>

      <Modal
        open={codesOpen}
        title="新的恢复码"
        description="每个恢复码只能使用一次，请立即离线保存。"
        size="md"
        onClose={closeCodes}
        footer={
          <>
            <Button variant="ghost" onClick={closeCodes}>关闭</Button>
            <Button
              variant="primary"
              icon={<Download size={16} aria-hidden="true" />}
              onClick={handleDownloadCodes}
              disabled={!codes}
            >
              下载 TXT
            </Button>
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
        <div className="recovery-actions">
          <CopyButton value={(codes ?? []).join('\n')} label="复制全部" size="md" variant="secondary" disabled={!codes} />
        </div>
      </Modal>

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
