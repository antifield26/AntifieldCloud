// Bot 配置表单：创建/编辑、平台密钥、启停、测试连接、删除与接入步骤。
// 安全边界：密钥输入只写不回显；编辑时留空表示保持服务端原值，任何密钥都不会写入列表或 URL。

import { useState } from 'react'
import type { FormEvent } from 'react'
import { CircleCheck, KeyRound, PlugZap, Plus, Save, ShieldCheck, Stethoscope, Trash2, TriangleAlert } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type {
  BotCreateInput,
  BotHealthCheck,
  BotPlatform,
  BotSummary,
  BotUpdateInput,
} from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { CopyButton } from '../CopyButton'
import { FormField } from '../FormField'
import { InlineError } from '../InlineError'
import { useToast } from '../Toast'
import { BOT_PLATFORMS, BOT_PLATFORM_LABELS, botPlatformLabel } from '../../lib/bots'
import { formatDate, formatDateTime } from '../../lib/format'

const SECRET_MIN_PATTERN = /.{16,}/
const DISCORD_APPLICATION_ID_PATTERN = /^\d{5,32}$/
const DISCORD_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/i
const TOKEN_MIN_LENGTH = 20

interface FieldErrors {
  name?: string
  token?: string
  webhookSecret?: string
  applicationId?: string
  publicKey?: string
  signingSecret?: string
}

interface BotConfigPanelProps {
  bot: BotSummary | null
  mode: 'create' | 'edit'
  onModeChange: (mode: 'create' | 'edit') => void
  onSaved: (bot: BotSummary) => void
  onDeleted: (id: string) => void
}

function configString(bot: BotSummary | null, key: string): string {
  if (!bot) return ''
  const value = bot.config[key]
  return typeof value === 'string' ? value : ''
}

/** 配置分区：左侧表单，右侧接入信息与安全说明。 */
export function BotConfigPanel({ bot, mode, onModeChange, onSaved, onDeleted }: BotConfigPanelProps) {
  const editing = mode === 'edit' && bot !== null
  const initialBot = editing ? bot : null
  const toast = useToast()
  const [platformChoice, setPlatformChoice] = useState<BotPlatform>(initialBot?.platform ?? 'telegram')
  const [name, setName] = useState(initialBot?.name ?? '')
  const [token, setToken] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [applicationId, setApplicationId] = useState(() => configString(initialBot, 'applicationId'))
  const [publicKey, setPublicKey] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [enabled, setEnabled] = useState(initialBot?.enabled ?? false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [health, setHealth] = useState<BotHealthCheck | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const platform: BotPlatform = editing && bot ? bot.platform : platformChoice
  const existingApplicationId = configString(initialBot, 'applicationId')
  const existingPublicKey = configString(initialBot, 'publicKey')
  const resolvedApplicationId = applicationId.trim() || existingApplicationId
  const resolvedPublicKey = publicKey.trim() || existingPublicKey

  const validate = (): boolean => {
    const next: FieldErrors = {}
    if (!name.trim()) next.name = '请输入 Bot 名称'
    if (!editing && !token.trim()) next.token = '请输入 Bot Token'
    if (token.trim() && token.trim().length < TOKEN_MIN_LENGTH) {
      next.token = `Bot Token 至少 ${TOKEN_MIN_LENGTH} 个字符`
    }
    if (platform === 'telegram') {
      if (!editing && !webhookSecret.trim()) {
        next.webhookSecret = '请输入 Telegram Webhook Secret'
      } else if (webhookSecret.trim() && !SECRET_MIN_PATTERN.test(webhookSecret.trim())) {
        next.webhookSecret = 'Webhook Secret 至少 16 个字符'
      }
    }
    if (platform === 'discord') {
      if (!DISCORD_APPLICATION_ID_PATTERN.test(resolvedApplicationId)) {
        next.applicationId = 'Application ID 应为 5–32 位数字'
      }
      if (!resolvedPublicKey) {
        next.publicKey = '请输入 Discord Public Key'
      } else if (!DISCORD_PUBLIC_KEY_PATTERN.test(resolvedPublicKey)) {
        next.publicKey = 'Public Key 应为 64 位十六进制字符串'
      }
    }
    if (platform === 'qq' && !DISCORD_APPLICATION_ID_PATTERN.test(resolvedApplicationId)) {
      next.applicationId = 'QQ AppID 应为 5–32 位数字'
    }
    if (platform === 'slack') {
      if (!editing && !signingSecret.trim()) {
        next.signingSecret = '请输入 Slack Signing Secret'
      } else if (signingSecret.trim() && !SECRET_MIN_PATTERN.test(signingSecret.trim())) {
        next.signingSecret = 'Signing Secret 至少 16 个字符'
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const buildCreateInput = (): BotCreateInput => {
    const input: BotCreateInput = {
      platform,
      name: name.trim(),
      token: token.trim(),
    }
    if (platform === 'telegram') input.webhookSecret = webhookSecret.trim()
    if (platform === 'discord') {
      input.config = {
        applicationId: resolvedApplicationId,
        publicKey: resolvedPublicKey,
      }
      input.publicKey = resolvedPublicKey
    }
    if (platform === 'slack') input.signingSecret = signingSecret.trim()
    if (platform === 'qq') input.config = { appId: resolvedApplicationId }
    return input
  }

  const buildUpdateInput = (): BotUpdateInput => {
    const input: BotUpdateInput = {
      name: name.trim(),
      enabled,
    }
    if (token.trim()) input.token = token.trim()
    if (platform === 'telegram' && webhookSecret.trim()) input.webhookSecret = webhookSecret.trim()
    if (platform === 'slack' && signingSecret.trim()) input.signingSecret = signingSecret.trim()
    if (platform === 'discord') {
      input.config = {
        applicationId: resolvedApplicationId,
        publicKey: resolvedPublicKey,
      }
      if (publicKey.trim()) input.publicKey = publicKey.trim()
    }
    if (platform === 'qq') input.config = { appId: resolvedApplicationId }
    return input
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    if (!validate()) return
    setSaving(true)
    try {
      const saved = editing && bot
        ? await api.bots.update(bot.id, buildUpdateInput())
        : await api.bots.create(buildCreateInput())
      setToken('')
      setWebhookSecret('')
      setSigningSecret('')
      setPublicKey('')
      toast.success(editing ? 'Bot 配置已保存' : 'Bot 已创建，请配置目标后启用')
      onSaved(saved)
    } catch (submitError) {
      setFormError(toErrorMessage(submitError, '保存 Bot 配置失败，请重试'))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    if (!bot || testing) return
    setTesting(true)
    try {
      await api.bots.test(bot.id)
      toast.success('测试消息已发送，请在目标中确认')
    } catch (testError) {
      toast.error(toErrorMessage(testError, '测试连接失败，请检查 Token 与目标配置'))
    } finally {
      setTesting(false)
    }
  }

  /** 连接自检：只调用服务端脱敏检查接口，不读取或回显任何密钥。 */
  const handleCheck = async (): Promise<void> => {
    if (!bot || checking) return
    setChecking(true)
    setHealthError(null)
    try {
      const result = await api.bots.check(bot.id)
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
    if (!bot) return
    setDeleting(true)
    try {
      await api.bots.remove(bot.id)
      setConfirmDelete(false)
      toast.success(`已删除 Bot「${bot.name}」`)
      onDeleted(bot.id)
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除 Bot 失败，请重试'))
    } finally {
      setDeleting(false)
    }
  }

  const platformHint =
    platform === 'telegram'
      ? '从 BotFather 获取 Token，并生成至少 16 位的 Webhook Secret。'
      : platform === 'discord'
        ? '从 Discord Developer Portal 获取 Bot Token、Application ID 与 Public Key。'
        : platform === 'qq'
          ? '从 QQ 开放平台（q.qq.com）获取 AppID 与 AppSecret；回调地址会校验 op=13 签名。'
          : '从 Slack App 管理页获取 Bot Token 与 Signing Secret。'

  return (
    <div className="bot-config-grid">
      <Card
        title={editing && bot ? `编辑「${bot.name}」` : '创建 Bot'}
        description={editing ? '密钥字段留空表示保持原值；保存后不会再次显示。' : '创建后默认停用，确认接入信息无误再启用。'}
        actions={
          <Badge tone={editing ? 'accent' : 'muted'}>
            {editing ? botPlatformLabel(platform) : '新建'}
          </Badge>
        }
      >
        <form className="bot-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <FormField
            label="平台"
            htmlFor="bot-platform"
            hint={editing ? '平台创建后不可修改；如需更换平台请新建 Bot。' : platformHint}
          >
            <div className="select-field bot-field-select">
              <select
                id="bot-platform"
                className="select"
                value={platform}
                onChange={(event) => {
                  setPlatformChoice(event.target.value as BotPlatform)
                  setErrors({})
                }}
                disabled={editing || saving}
              >
                {BOT_PLATFORMS.map((item) => (
                  <option key={item} value={item}>
                    {BOT_PLATFORM_LABELS[item]}
                  </option>
                ))}
              </select>
            </div>
          </FormField>

          <FormField label="名称" htmlFor="bot-name" required error={errors.name} hint="用于区分不同 Bot，最长 80 个字符。">
            <input
              id="bot-name"
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
            label={platform === 'qq' ? 'AppSecret' : 'Bot Token'}
            htmlFor="bot-token"
            required={!editing}
            error={errors.token}
            hint={
              editing
                ? '留空表示不修改；仅在轮换平台凭据时填写。'
                : platform === 'qq'
                  ? 'QQ 开放平台机器人 AppSecret（写在服务端，只用于换 token 与验签）。'
                  : `平台后台生成的 Token，至少 ${TOKEN_MIN_LENGTH} 个字符；只保存在服务端。`
            }
          >
            <input
              id="bot-token"
              className="input"
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setErrors((previous) => ({ ...previous, token: undefined }))
              }}
              autoComplete="new-password"
              placeholder={editing ? '留空表示不修改' : '粘贴 Bot Token'}
              maxLength={500}
              disabled={saving}
            />
          </FormField>

          {platform === 'telegram' ? (
            <FormField
              label="Webhook Secret"
              htmlFor="bot-telegram-webhook-secret"
              required={!editing}
              error={errors.webhookSecret}
              hint={
                editing
                  ? '留空表示不修改；Telegram 通过该值校验 Webhook 请求头。'
                  : '至少 16 个字符；Telegram 通过该值校验 Webhook 请求头。'
              }
            >
              <input
                id="bot-telegram-webhook-secret"
                className="input"
                type="password"
                value={webhookSecret}
                onChange={(event) => {
                  setWebhookSecret(event.target.value)
                  setErrors((previous) => ({ ...previous, webhookSecret: undefined }))
                }}
                autoComplete="new-password"
                placeholder={editing ? '留空表示不修改' : '至少 16 个字符'}
                maxLength={500}
                disabled={saving}
              />
            </FormField>
          ) : null}

          {platform === 'discord' ? (
            <>
              <FormField
                label="Application ID"
                htmlFor="bot-discord-application-id"
                required
                error={errors.applicationId}
                hint="Discord Application 的 Snowflake ID，5–32 位数字。"
              >
                <input
                  id="bot-discord-application-id"
                  className="input"
                  value={applicationId}
                  onChange={(event) => {
                    setApplicationId(event.target.value)
                    setErrors((previous) => ({ ...previous, applicationId: undefined }))
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="例如：123456789012345678"
                  maxLength={32}
                  disabled={saving}
                />
              </FormField>
              <FormField
                label="Public Key"
                htmlFor="bot-discord-public-key"
                required={!existingPublicKey}
                error={errors.publicKey}
                hint={
                  existingPublicKey
                    ? '已配置；留空表示不修改。填写时需为 64 位十六进制字符串。'
                    : '64 位十六进制字符串，用于验证 Discord 交互签名。'
                }
              >
                <input
                  id="bot-discord-public-key"
                  className="input"
                  value={publicKey}
                  onChange={(event) => {
                    setPublicKey(event.target.value)
                    setErrors((previous) => ({ ...previous, publicKey: undefined }))
                  }}
                  autoComplete="off"
                  placeholder={existingPublicKey ? '留空表示不修改' : '64 位十六进制 Public Key'}
                  maxLength={64}
                  disabled={saving}
                />
              </FormField>
            </>
          ) : null}

          {platform === 'qq' ? (
            <FormField
              label="AppID"
              htmlFor="bot-qq-app-id"
              required
              error={errors.applicationId}
              hint="QQ 开放平台机器人 AppID，5–32 位数字；AppSecret 填在上面的凭据字段。"
            >
              <input
                id="bot-qq-app-id"
                className="input"
                value={applicationId}
                onChange={(event) => {
                  setApplicationId(event.target.value)
                  setErrors((previous) => ({ ...previous, applicationId: undefined }))
                }}
                inputMode="numeric"
                autoComplete="off"
                placeholder="例如：102123456"
                maxLength={32}
                disabled={saving}
              />
            </FormField>
          ) : null}

          {platform === 'slack' ? (
            <FormField
              label="Signing Secret"
              htmlFor="bot-slack-signing-secret"
              required={!editing}
              error={errors.signingSecret}
              hint={
                editing
                  ? '留空表示不修改；Slack 使用该值计算请求签名。'
                  : '至少 16 个字符；Slack 使用该值计算请求签名。'
              }
            >
              <input
                id="bot-slack-signing-secret"
                className="input"
                type="password"
                value={signingSecret}
                onChange={(event) => {
                  setSigningSecret(event.target.value)
                  setErrors((previous) => ({ ...previous, signingSecret: undefined }))
                }}
                autoComplete="new-password"
                placeholder={editing ? '留空表示不修改' : '至少 16 个字符'}
                maxLength={500}
                disabled={saving}
              />
            </FormField>
          ) : null}

          {editing && bot ? (
            <>
              <label className="bot-switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  disabled={saving}
                />
                <span className="bot-switch-text">
                  <span>启用此 Bot</span>
                  <span className="field-hint">停用后不再处理投递与发布任务；保存后生效。</span>
                </span>
              </label>
              <div className="bot-config-meta">
                <span>密钥版本 v{bot.keyVersion}</span>
                <span>创建于 {formatDate(bot.createdAt)}</span>
              </div>
            </>
          ) : (
            <p className="field-hint">新建 Bot 默认停用；创建成功后可在本分区启用并测试连接。</p>
          )}

          {formError ? <p className="field-error" role="alert">{formError}</p> : null}

          <div className="form-actions bot-form-actions">
            {editing && bot ? (
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
                  disabled={saving || bot.targetsCount === 0}
                  title={bot.targetsCount === 0 ? '请先在“目标”分区添加目标' : undefined}
                >
                  测试连接
                </Button>
              </>
            ) : null}
            {!editing && bot ? (
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
              {editing ? '保存修改' : '创建 Bot'}
            </Button>
          </div>
          {editing && bot && bot.targetsCount === 0 ? (
            <p className="field-hint">测试连接需要至少一个目标，请先到“目标”分区添加。</p>
          ) : null}
        </form>

        {editing && bot && (health || healthError || checking) ? (
          <section className="bot-health" aria-label="连接检查结果">
            <h3 className="subsection-title">连接检查结果</h3>
            {healthError ? (
              <InlineError message={healthError} onRetry={() => void handleCheck()} retryLabel="重新检查" />
            ) : null}
            {checking && !health ? <p className="field-hint">正在检查 Token、Webhook 与公开配置…</p> : null}
            {health ? (
              <>
                <div className="bot-health-summary">
                  <Badge tone={health.ok ? 'success' : 'warning'} dot>
                    {health.ok ? '全部通过' : '存在异常项'}
                  </Badge>
                  <span className="field-hint">
                    {health.checkedAt ? `检查于 ${formatDateTime(health.checkedAt)} · ` : ''}
                    共 {health.items.length} 项，不含任何密钥。
                  </span>
                </div>
                <ul className="bot-health-list">
                  {health.items.map((item) => (
                    <li
                      key={item.name}
                      className={item.ok ? 'bot-health-item' : 'bot-health-item bot-health-item-warning'}
                    >
                      {item.ok ? (
                        <CircleCheck size={16} className="text-success" aria-hidden="true" />
                      ) : (
                        <TriangleAlert size={16} className="text-warning" aria-hidden="true" />
                      )}
                      <span className="bot-health-name">{item.name}</span>
                      <Badge tone={item.ok ? 'success' : 'warning'}>{item.ok ? '通过' : '异常'}</Badge>
                      <span className="bot-health-detail">{item.detail}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}
      </Card>

      <div className="bot-config-side">
        {editing && bot ? (
          <Card title="接入信息" description="Webhook 地址与平台后台配置步骤，不包含任何密钥。">
            <div className="bot-webhook-box">
              <span className="field-label">Webhook URL</span>
              <code className="bot-webhook-url">{bot.webhookUrl}</code>
              <CopyButton
                value={bot.webhookUrl}
                label="复制地址"
                ariaLabel={`复制 ${bot.name} 的 Webhook URL`}
                variant="secondary"
              />
            </div>
            <h3 className="subsection-title">配置步骤</h3>
            <ol className="bot-setup-steps">
              {bot.setupSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
              <li>私聊/群聊均可发送 /reset 重置当前对话；/forget confirm 清除该 Bot 的长期记忆。</li>
            </ol>
            {bot.platform === 'discord' ? (
              <div className="notice notice-info">
                普通消息 Chat 需要 Discord Gateway：在 Developer Portal 开启 <strong>Message Content Intent</strong>，
                并在服务端设置 <code>BOT_DISCORD_GATEWAY_ENABLED=true</code>。当前 Gateway 状态：
                {bot.gateway.state === 'connected' ? '已连接' : bot.gateway.state === 'error' ? `错误（${bot.gateway.lastError ?? '未知'}）` : '未连接'}。
              </div>
            ) : null}
            {bot.platform === 'telegram' ? (
              <div className="notice notice-info">
                群/频道 Chat 需在 BotFather 关闭 privacy mode（或回复 Bot 消息）；私聊普通消息直接进入 Chat。
              </div>
            ) : null}
            {bot.platform === 'qq' ? (
              <div className="notice notice-info">
                QQ 群/频道需先把 Bot 加入群并 @Bot 发送一条消息，再到目标分区从“最近入站目标”一键登记；QQ 仅文本。
              </div>
            ) : null}
          </Card>
        ) : (
          <Card title="接入信息" description="创建 Bot 后这里会显示 Webhook URL 与平台后台配置步骤。">
            <div className="bot-placeholder-info">
              <KeyRound size={18} aria-hidden="true" />
              <div>
                <p>选择平台并填写 Token 与平台密钥后创建 Bot。</p>
                <p className="field-hint">
                  平台密钥用于校验入站 Webhook；Bot Token 用于发送消息。密钥只提交到服务端，不会写入浏览器存储。
                </p>
              </div>
            </div>
          </Card>
        )}

        <Card
          title="密钥与安全"
          actions={<ShieldCheck size={18} className="text-accent" aria-hidden="true" />}
        >
          <ul className="bot-security-list">
            <li>Bot Token、Webhook Secret、Signing Secret 以 AES-256-GCM 加密保存，接口与前端都不会回显。</li>
            <li>编辑时密钥输入留空表示保持原值；保存后无法再次查看，只能重新填写覆盖。</li>
            <li>Webhook 由平台签名/密钥头校验，不依赖登录会话；伪造请求会被拒绝并写入审计。</li>
            <li>命令只读且仅对已开启“允许命令”的目标生效；本页不提供命令执行 UI。</li>
          </ul>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="删除 Bot"
        message={bot ? `确定删除 Bot「${bot.name}」？` : ''}
        details="删除后 Webhook 立即失效，其目标、投递记录与发布任务一并移除；此操作不可撤销。"
        confirmText="删除 Bot"
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          if (!deleting) setConfirmDelete(false)
        }}
      />
    </div>
  )
}
