/**
 * Bot 凭据加解密：AES-256-GCM，密钥来自 BOT_SECRET_KEY（32 字节 base64）。
 * 只存密文/IV/tag 与 key_version；错误信息不包含明文或密钥。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { BotSecret } from './types.ts'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
export const BOT_KEY_VERSION = 1

export class BotSecretError extends Error {
  constructor(message = 'Bot 凭据不可用') {
    super(message)
    this.name = 'BotSecretError'
  }
}

export interface EncryptedBotSecret {
  ciphertext: string
  iv: string
  tag: string
  keyVersion: number
}

/** 从配置字符串解析密钥；空值返回 null，格式错误抛错。 */
export function decodeBotKey(value: string): Buffer | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let key: Buffer
  try {
    key = Buffer.from(trimmed, 'base64')
  } catch {
    throw new BotSecretError('BOT_SECRET_KEY 格式无效')
  }
  if (key.length !== 32) throw new BotSecretError('BOT_SECRET_KEY 必须是 32 字节 base64')
  return key
}

export function encryptBotSecret(key: Buffer, secret: BotSecret, keyVersion = BOT_KEY_VERSION): EncryptedBotSecret {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(secret), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  }
}

export function decryptBotSecret(key: Buffer, encrypted: EncryptedBotSecret): BotSecret {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ])
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as BotSecret).token !== 'string') {
      throw new BotSecretError('Bot 凭据内容无效')
    }
    return parsed as BotSecret
  } catch (error) {
    if (error instanceof BotSecretError) throw error
    throw new BotSecretError('Bot 凭据解密失败')
  }
}
