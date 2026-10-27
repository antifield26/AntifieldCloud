/**
 * Chatbot 会话归属的合成键。
 *
 * 群聊（QQ 群/频道等多用户目标）共享同一个 OpenCode Chat 会话，让模型看到群内不同成员的历史消息；
 * `chatbot_ai_sessions` 仍保持 `(chatbot_id, target_external_id, user_id, mode)` 主键，因此用一个不会与真实
 * member_openid 冲突的合成 user_id 表示“群会话”。真实用户仍用于限流、记忆归属、审计与发送工具令牌。
 */
export const GROUP_CHAT_SESSION_USER_ID = '__group__'

/** 严格判断群聊共享会话键（用于避免把合成键当成真实用户做记忆迁移/统计）。 */
export function isGroupChatSessionUserId(value: string): boolean {
  return value === GROUP_CHAT_SESSION_USER_ID
}
