/**
 * 分享密码哈希：直接复用 auth/password.ts 的 hashSecret/verifySecret
 * （scrypt N=2^15, r=8, p=1，长度 1–256，不受用户密码 ≥12 字符策略限制）。
 * 分享密码只在 shares 模块内使用，不参与账号登录。
 */
export {
  hashSecret as hashSharePassword,
  verifySecret as verifySharePassword,
} from '../auth/password.ts'
