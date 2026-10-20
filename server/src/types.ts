/** 服务端共享的数据行类型（与 SQLite 列一一对应）。 */

export interface UserRow {
  id: string
  username: string
  password_hash: string
  password_salt: string
  totp_secret: string
  totp_last_step: number
  recovery_codes_json: string
  created_at: string
  updated_at: string
}

export interface ChallengeRow {
  id: string
  user_id: string
  token_hash: string
  expires_at: string
  used: number
  created_at: string
}

export interface SessionRow {
  id: string
  user_id: string
  token_hash: string
  csrf_hash: string
  created_at: string
  expires_at: string
  last_seen_at: string
  ip: string | null
  user_agent: string | null
}

export interface FileRow {
  id: string
  parent_id: string | null
  name: string
  kind: 'file' | 'dir'
  size: number
  mime: string | null
  sha256: string | null
  storage_key: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_parent_id: string | null
  /** 可见性来源：user=普通云盘；note=笔记附件；system=系统保留。 */
  origin: 'user' | 'note' | 'system'
}

export interface AuditRow {
  id: number
  ts: string
  actor: string
  action: string
  target: string | null
  detail_json: string | null
  ip: string | null
}

export interface LoginAttemptRow {
  id: number
  ip: string
  ts: string
  success: number
}

export interface BackupStateRow {
  id: number
  last_backup_at: string | null
  last_archive: string | null
  last_sha256: string | null
  last_size: number | null
}

export interface AuthUser {
  id: string
  username: string
}

export interface AuthContext {
  user: AuthUser
  session: SessionRow
}
