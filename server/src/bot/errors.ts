/**
 * Bot 平台/队列错误的中文提示映射：仅面向管理页展示，不包含凭据、URL 或响应正文。
 * 输入来自队列 last_error / 诊断事件 detail；未知错误返回 null，由前端展示原文。
 */

const EXACT_HINTS: Record<string, string> = {
  bot_ai_timeout: 'AI 响应超时：可稍后重试，或检查 OpenCode 服务状态',
  bot_ai_unavailable: 'AI 服务不可达：检查 OpenCode 是否运行、OPENCODE_URL 与本地端口',
  bot_ai_empty_response: 'AI 未返回文本：可重试；连续失败时检查模型配置',
  bot_ai_invalid_response: 'AI 返回格式异常：检查 OpenCode 版本与模型能力',
  bot_ai_http_error: 'AI 服务返回错误：检查 OpenCode 日志与模型/provider 配置',
  bot_disabled: 'Bot 已在服务端停用（BOT_ENABLED=false）',
  bot_key_missing: '缺少 BOT_SECRET_KEY，无法解密平台凭据',
  qq_access_token_failed: 'QQ access_token 获取失败：检查出站网络/代理与 AppSecret',
  qq_access_token_invalid: 'QQ access_token 响应无效：检查 AppID/AppSecret 与平台状态',
  qq_credentials_missing: 'QQ AppID 或 AppSecret 未配置',
  qq_media_unsupported: 'QQ 官方 Bot 不支持媒体，请只发文本',
  media_too_large: '媒体文件超过平台大小限制',
  media_total_too_large: '媒体总大小超过限制',
  media_missing: '媒体文件不存在或已移入回收站',
  too_many_media: '媒体数量超过平台上限',
  partial_media_sent: '部分附件已外发，需人工确认后重建任务，避免重复发送',
  partial_text_sent: '长消息部分段落已发送，需人工确认后处理，避免重复外发',
  target_missing: '目标不存在或已被删除',
  empty_payload: '投递内容为空',
  rate_limited: '触发限流：稍后重试',
  invalid_signature: '平台签名校验失败：检查 Secret/Public Key 与平台回调配置',
  stale_signature: '平台回调时间戳过期：检查服务器时间与时钟同步',
}

const PATTERN_HINTS: Array<[RegExp, string]> = [
  [/partial_text_sent/i, '长消息部分段落已发送，需人工确认后处理，避免重复外发'],
  [/partial_media_sent/i, '部分附件已外发，需人工确认后重建任务，避免重复发送'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network/i, '出站网络不可用：检查 Pi 出站代理/隧道与 BOT_PROXY_URL'],
  [/telegram.*401|Unauthorized/i, 'Telegram 凭据无效：检查 Bot Token 与 Webhook Secret'],
  [/discord.*401|401.*discord/i, 'Discord 凭据无效：检查 Bot Token / Application ID / Public Key'],
  [/invalid_auth|not_authed|slack.*401/i, 'Slack 凭据无效：检查 Bot Token 与 Signing Secret'],
  [/timeout|超时/i, '平台请求超时：稍后重试并检查出站网络'],
  [/403|forbidden|missing.*permission|权限/i, '平台权限不足：检查 Bot 在频道/群/工作区的发送权限'],
  [/429|too many requests|frequency/i, '平台限流：稍后重试'],
  [/401|unauthorized/i, '平台凭据无效或已过期：检查 Token/Secret'],
]

/** 返回中文提示；未知错误返回 null。 */
export function describeBotError(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  const first = text.split(/[:：\n]/)[0]?.trim() ?? ''
  if (EXACT_HINTS[first]) return EXACT_HINTS[first]
  const direct = EXACT_HINTS[text]
  if (direct) return direct
  // 适配器错误消息形如“平台请求失败（0:qq_access_token_failed）”，错误码嵌在消息内部；
  // 取消息中包含的最长已知错误码，避免短码误命中（如 rate_limited 与更长的组合码）。
  let matchedKey: string | null = null
  for (const key of Object.keys(EXACT_HINTS)) {
    if (!text.includes(key)) continue
    if (matchedKey === null || key.length > matchedKey.length) matchedKey = key
  }
  const matchedHint = matchedKey === null ? undefined : EXACT_HINTS[matchedKey]
  if (matchedHint) return matchedHint
  for (const [pattern, hint] of PATTERN_HINTS) {
    if (pattern.test(text)) return hint
  }
  return null
}
