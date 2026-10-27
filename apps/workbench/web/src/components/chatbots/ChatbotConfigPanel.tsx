// 配置分区：创建/编辑 QQ 官方 Chatbot、AppID 与 AppSecret、启停、测试/检查连接、删除与接入步骤。
// 安全边界：AppSecret 只写不回显；编辑时留空表示保持服务端原值，密钥不会写入列表、URL 或浏览器存储。

import { useState } from 'react'
import type { FormEvent } from 'react'
import { CircleCheck, KeyRound, PlugZap, Plus, Save, ShieldCheck, Stethoscope, Trash2, TriangleAlert } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type {
  ChatbotCreateInput,
  ChatbotHealthCheck,
  ChatbotSummary,
  ChatbotUpdateInput,
} from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { CopyButton } from '../CopyButton'
import { FormField } from '../FormField'
import { InlineError } from '../InlineError'
import { useToast } from '../Toast'
import { CHATBOT_PLATFORMS, CHATBOT_PLATFORM_LABELS } from '../../lib/chatbots'
import { formatDate, formatDateTime } from '../../lib/format'

/** QQ 开放平台 AppID：5–32 位数字；AppSecret 至少 16 个字符。 */
const APP_ID_PATTERN = /^\d{5,32}$/
const TOKEN_MIN_LENGTH = 16

interface FieldErrors {
  name?: string
  token?: string
  appId?: string
}

interface ChatbotConfigPanelProps {
  chatbot: ChatbotSummary | null
  mode: 'create' | 'edit'
  onModeChange: (mode: 'create' | 'edit') => void
  onSaved: (chatbot: ChatbotSummary) => void
  onDeleted: (id: string) => void
}

function configString(chatbot: ChatbotSummary | null, key: string): string {
  if (!chatbot) return ''
  const value = chatbot.config[key]
  return typeof value === 'string' ? value : ''
}

/** 配置分区：左侧表单，右侧接入信息与安全说明。 */
export function ChatbotConfigPanel({ chatbot, mode, onModeChange, onSaved, onDeleted }: ChatbotConfigPanelProps) {
  const editing = mode === 'edit' && chatbot !== null
  const initialBot = editing ? chatbot : null
  const toast = useToast()
  const [name, setName] = useState(initialBot?.name ?? '')
  const [token, setToken] = useState('')
  const [appId, setAppId] = useState(() => configString(initialBot, 'appId'))
  const [enabled, setEnabled] = useState(initialBot?.enabled ?? false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [health, setHealth] = useState<ChatbotHealthCheck | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const existingAppId = configString(initialBot, 'appId')
  const resolvedAppId = appId.trim() || existingAppId

  const validate = (): boolean => {
    const next: FieldErrors = {}
    if (!name.trim()) next.name = '请输入 Chatbot 名称'
    if (!editing && !token.trim()) next.token = '请输入 AppSecret'
    if (token.trim() && token.trim().length < TOKEN_MIN_LENGTH) {
      next.token = `AppSecret 至少 ${TOKEN_MIN_LENGTH} 个字符`
    }
    if (!APP_ID_PATTERN.test(resolvedAppId)) next.appId = 'AppID 应为 5–32 位数字'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const buildCreateInput = (): ChatbotCreateInput => ({
    platform: 'qq',
    name: name.trim(),
    token: token.trim(),
    config: { appId: resolvedAppId },
  })

  const buildUpdateInput = (): ChatbotUpdateInput => {
    const input: ChatbotUpdateInput = {
      name: name.trim(),
      enabled,
      config: { appId: resolvedAppId },
    }
    if (token.trim()) input.token = token.trim()
    return input
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    if (!validate()) return
    setSaving(true)
    try {
      const saved = editing && chatbot
        ? await api.chatbots.update(chatbot.id, buildUpdateInput())
        : await api.chatbots.create(buildCreateInput())
      setToken('')
      toast.success(editing ? 'Chatbot 配置已保存' : 'Chatbot 已创建，请配置目标后启用')
      onSaved(saved)
    } catch (submitError) {
      setFormError(toErrorMessage(submitError, '保存 Chatbot 配置失败，请重试'))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    if (!chatbot || testing) return
    setTesting(true)
    try {
      await api.chatbots.test(chatbot.id)
      toast.success('测试消息已发送，请在目标中确认')
    } catch (testError) {
      toast.error(toErrorMessage(testError, '测试连接失败，请检查 AppSecret 与目标配置'))
    } finally {
      setTesting(false)
    }
  }

  /** 连接自检：只调用服务端脱敏检查接口，不读取或回显任何密钥。 */
  const handleCheck = async (): Promise<void> => {
    if (!chatbot || checking) return
    setChecking(true)
    setHealthError(null)
    try {
      const result = await api.chatbots.check(chatbot.id)
      setHealth(result)
      toast.success(result.ok ? '连接检查通过' : '连接检查完成，存在异常项')
    } catch (checkError) {
      const message = toErrorMessage(checkError, '连接检查失败，请稍后重试')
      setHealth(null)
      setHealthError(message)
      toast.error(message)
    } finally {
      setChecking(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!chatbot) return
    setDeleting(true)
    try {
      await api.chatbots.remove(chatbot.id)
      setConfirmDelete(false)
      toast.success(`已删除 Chatbot「${chatbot.name}」`)
      onDeleted(chatbot.id)
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除 Chatbot 失败，请重试'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="chatbot-config-grid">
      <Card
        title={editing && chatbot ? `编辑「${chatbot.name}」` : '创建 Chatbot'}
        description={editing ? 'AppSecret 留空表示保持原值；保存后不会再次显示。' : '创建后默认停用，确认接入信息无误再启用。'}
        actions={
          <Badge tone={editing ? 'accent' : 'muted'}>
            {editing ? CHATBOT_PLATFORM_LABELS.qq : '新建'}
          </Badge>
        }
      >
        <form className="chatbot-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <FormField
            label="平台"
            htmlFor="chatbot-platform"
            hint="当前仅支持 QQ 官方 Chatbot；平台创建后不可修改。"
          >
            <div className="select-field chatbot-field-select">
              <select id="chatbot-platform" className="select" value="qq" disabled>
                {CHATBOT_PLATFORMS.map((item) => (
                  <option key={item} value={item}>
                    {CHATBOT_PLATFORM_LABELS[item]}
                  </option>
                ))}
              </select>
            </div>
          </FormField>

          <FormField label="名称" htmlFor="chatbot-name" required error={errors.name} hint="用于区分不同 Chatbot，最长 80 个字符。">
            <input
              id="chatbot-name"
              className="input"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setErrors((previous) => ({ ...previous, name: undefined }))
              }}
              maxLength={80}
              autoComplete="off"
              placeholder="例如：告警通知"
              disabled={saving}
            />
          </FormField>

          <FormField
            label="AppID"
            htmlFor="chatbot-qq-app-id"
            required
            error={errors.appId}
            hint="QQ 开放平台机器人 AppID，5–32 位数字；属于公开配置。"
          >
            <input
              id="chatbot-qq-app-id"
              className="input"
              value={appId}
              onChange={(event) => {
                setAppId(event.target.value)
                setErrors((previous) => ({ ...previous, appId: undefined }))
              }}
              inputMode="numeric"
              autoComplete="off"
              placeholder="例如：102123456"
              maxLength={32}
              disabled={saving}
            />
          </FormField>

          <FormField
            label="AppSecret"
            htmlFor="chatbot-token"
            required={!editing}
            error={errors.token}
            hint={
              editing
                ? '留空表示不修改；仅在轮换平台凭据时填写。'
                : `QQ 开放平台机器人 AppSecret，至少 ${TOKEN_MIN_LENGTH} 个字符；只保存在服务端。`
            }
          >
            <input
              id="chatbot-token"
              className="input"
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setErrors((previous) => ({ ...previous, token: undefined }))
              }}
              autoComplete="new-password"
              placeholder={editing ? '留空表示不修改' : '粘贴 AppSecret'}
              maxLength={500}
              disabled={saving}
            />
          </FormField>

          {editing && chatbot ? (
            <>
              <label className="chatbot-switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  disabled={saving}
                />
                <span className="chatbot-switch-text">
                  <span>启用此 Chatbot</span>
                  <span className="field-hint">停用后不再处理投递与发布任务；保存后生效。</span>
                </span>
              </label>
              <div className="chatbot-config-meta">
                <span>密钥版本 v{chatbot.keyVersion}</span>
                <span>创建于 {formatDate(chatbot.createdAt)}</span>
              </div>
            </>
          ) : (
            <p className="field-hint">新建 Chatbot 默认停用；创建成功后可在本分区启用并测试连接。</p>
          )}

          {formError ? <p className="field-error" role="alert">{formError}</p> : null}

          <div className="form-actions chatbot-form-actions">
            {editing && chatbot ? (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 size={15} aria-hidden="true" />}
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving || deleting}
                >
                  删除
                </Button>
                <Button
                  variant="secondary"
                  icon={<Stethoscope size={15} aria-hidden="true" />}
                  loading={checking}
                  onClick={() => void handleCheck()}
                  disabled={saving || deleting}
                >
                  检查连接
                </Button>
                <Button
                  variant="secondary"
                  icon={<PlugZap size={15} aria-hidden="true" />}
                  loading={testing}
                  onClick={() => void handleTest()}
                  disabled={saving || chatbot.targetsCount === 0}
                  title={chatbot.targetsCount === 0 ? '请先在“目标”分区添加目标' : undefined}
                >
                  测试连接
                </Button>
              </>
            ) : null}
            {!editing && chatbot ? (
              <Button variant="ghost" onClick={() => onModeChange('edit')} disabled={saving}>
                取消
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              icon={editing ? <Save size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
            >
              {editing ? '保存修改' : '创建 Chatbot'}
            </Button>
          </div>
          {editing && chatbot && chatbot.targetsCount === 0 ? (
            <p className="field-hint">测试连接需要至少一个目标，请先到“目标”分区添加。</p>
          ) : null}
        </form>

        {editing && chatbot && (health || healthError || checking) ? (
          <section className="chatbot-health" aria-label="连接检查结果">
            <h3 className="subsection-title">连接检查结果</h3>
            {healthError ? (
              <InlineError message={healthError} onRetry={() => void handleCheck()} retryLabel="重新检查" />
            ) : null}
            {checking && !health ? <p className="field-hint">正在检查 AppID、AppSecret 与回调配置…</p> : null}
            {health ? (
              <>
                <div className="chatbot-health-summary">
                  <Badge tone={health.ok ? 'success' : 'warning'} dot>
                    {health.ok ? '全部通过' : '存在异常项'}
                  </Badge>
                  <span className="field-hint">
                    {health.checkedAt ? `检查于 ${formatDateTime(health.checkedAt)} · ` : ''}
                    共 {health.items.length} 项，不含任何密钥。
                  </span>
                </div>
                <ul className="chatbot-health-list">
                  {health.items.map((item) => (
                    <li
                      key={item.name}
                      className={item.ok ? 'chatbot-health-item' : 'chatbot-health-item chatbot-health-item-warning'}
                    >
                      {item.ok ? (
                        <CircleCheck size={16} className="text-success" aria-hidden="true" />
                      ) : (
                        <TriangleAlert size={16} className="text-warning" aria-hidden="true" />
                      )}
                      <span className="chatbot-health-name">{item.name}</span>
                      <Badge tone={item.ok ? 'success' : 'warning'}>{item.ok ? '通过' : '异常'}</Badge>
                      <span className="chatbot-health-detail">{item.detail}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}
      </Card>

      <div className="chatbot-config-side">
        {editing && chatbot ? (
          <Card title="接入信息" description="Webhook 地址与 QQ 开放平台后台配置步骤，不包含任何密钥。">
            <div className="chatbot-webhook-box">
              <span className="field-label">Webhook URL</span>
              <code className="chatbot-webhook-url">{chatbot.webhookUrl}</code>
              <CopyButton
                value={chatbot.webhookUrl}
                label="复制地址"
                ariaLabel={`复制 ${chatbot.name} 的 Webhook URL`}
                variant="secondary"
              />
            </div>
            <h3 className="subsection-title">配置步骤</h3>
            <ol className="chatbot-setup-steps">
              {chatbot.setupSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
              <li>私聊/群聊均可发送 /reset 重置当前对话；/forget confirm 清除该 Chatbot 的长期记忆。</li>
            </ol>
            <div className="notice notice-info">
              QQ 群/频道只有 @Chatbot 消息进入 Chatbot（平台限制），C2C 私聊直接进入 Chat；仅支持文本。
              图片理解默认开启，需要支持 image 输入的模型。
            </div>
          </Card>
        ) : (
          <Card title="接入信息" description="创建 Chatbot 后这里会显示 Webhook URL 与 QQ 开放平台配置步骤。">
            <div className="chatbot-placeholder-info">
              <KeyRound size={18} aria-hidden="true" />
              <div>
                <p>填写 QQ 开放平台的 AppID 与 AppSecret 后创建 Chatbot。</p>
                <p className="field-hint">
                  AppSecret 用于派生回调签名并换取 access_token；只提交到服务端，不会写入浏览器存储。
                </p>
              </div>
            </div>
          </Card>
        )}

        <Card
          title="密钥与安全"
          actions={<ShieldCheck size={18} className="text-accent" aria-hidden="true" />}
        >
          <ul className="chatbot-security-list">
            <li>AppSecret 以 AES-256-GCM 加密保存，接口与前端都不会回显。</li>
            <li>编辑时 AppSecret 输入留空表示保持原值；保存后无法再次查看，只能重新填写覆盖。</li>
            <li>QQ 回调由平台 Ed25519 签名校验，不依赖登录会话；伪造请求会被拒绝并写入审计。</li>
            <li>命令只读且仅对已开启“允许命令”的目标生效；本页不提供命令执行 UI。</li>
          </ul>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="删除 Chatbot"
        message={chatbot ? `确定删除 Chatbot「${chatbot.name}」？` : ''}
        details="删除后 Webhook 立即失效，其目标、投递记录与发布任务一并移除；此操作不可撤销。"
        confirmText="删除 Chatbot"
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          if (!deleting) setConfirmDelete(false)
        }}
      />
    </div>
  )
}
