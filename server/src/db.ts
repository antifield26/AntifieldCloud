/**
 * SQLite 数据库：打开、PRAGMA、版本化迁移。
 *
 * 约束：
 * - 时间统一 ISO 8601 UTC 字符串。
 * - 迁移只追加，不修改历史 SQL；启动时按 meta.schema_version 顺序执行。
 * - 所有服务共享同一个 DatabaseSync 实例（单进程）。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    totp_secret TEXT NOT NULL,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    recovery_codes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_challenges_expires ON auth_challenges(expires_at);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT,
    sha256 TEXT,
    storage_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_parent_id TEXT
  );
  CREATE INDEX idx_files_parent ON files(parent_id, deleted_at);
  CREATE INDEX idx_files_name ON files(name COLLATE NOCASE);
  CREATE INDEX idx_files_updated ON files(updated_at);
  CREATE INDEX idx_files_deleted ON files(deleted_at);
  CREATE UNIQUE INDEX idx_files_unique_active_name
    ON files(COALESCE(parent_id, ''), name COLLATE NOCASE)
    WHERE deleted_at IS NULL;

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail_json TEXT,
    ip TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);
  CREATE INDEX idx_audit_action ON audit_log(action);

  CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    ts TEXT NOT NULL,
    success INTEGER NOT NULL
  );
  CREATE INDEX idx_login_ip_ts ON login_attempts(ip, ts);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE backup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_backup_at TEXT,
    last_archive TEXT,
    last_sha256 TEXT,
    last_size INTEGER
  );
  INSERT OR IGNORE INTO backup_state (id) VALUES (1);
  `,
  `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
  CREATE INDEX idx_notes_pinned ON notes(pinned, updated_at DESC);

  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_bookmarks_updated ON bookmarks(updated_at DESC);
  CREATE INDEX idx_bookmarks_pinned ON bookmarks(pinned, updated_at DESC);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
  );

  CREATE TABLE note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
  );
  CREATE INDEX idx_note_tags_tag ON note_tags(tag_id, note_id);

  CREATE TABLE bookmark_tags (
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bookmark_id, tag_id)
  );
  CREATE INDEX idx_bookmark_tags_tag ON bookmark_tags(tag_id, bookmark_id);

  CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    body_md,
    content='notes',
    content_rowid='rowid'
  );
  CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
  END;
  CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  END;
  CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
    INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
  END;

  CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
    title,
    url,
    description,
    content='bookmarks',
    content_rowid='rowid'
  );
  CREATE TRIGGER bookmarks_fts_ai AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(rowid, title, url, description) VALUES (new.rowid, new.title, new.url, new.description);
  END;
  CREATE TRIGGER bookmarks_fts_ad AFTER DELETE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, description) VALUES ('delete', old.rowid, old.title, old.url, old.description);
  END;
  CREATE TRIGGER bookmarks_fts_au AFTER UPDATE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, description) VALUES ('delete', old.rowid, old.title, old.url, old.description);
    INSERT INTO bookmarks_fts(rowid, title, url, description) VALUES (new.rowid, new.title, new.url, new.description);
  END;

  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    expires_at TEXT NOT NULL,
    max_downloads INTEGER NOT NULL DEFAULT 0 CHECK (max_downloads >= 0),
    download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    created_by TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX idx_shares_file ON shares(file_id, created_at DESC);
  CREATE INDEX idx_shares_expires ON shares(expires_at);

  CREATE TABLE share_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    downloaded INTEGER NOT NULL DEFAULT 0 CHECK (downloaded IN (0, 1))
  );
  CREATE INDEX idx_share_sessions_expires ON share_sessions(expires_at);
  CREATE INDEX idx_share_sessions_share ON share_sessions(share_id);

  CREATE TABLE alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    delivery_error TEXT
  );
  CREATE INDEX idx_alert_events_created ON alert_events(created_at DESC);
  CREATE INDEX idx_alert_events_event ON alert_events(event, created_at DESC);

  CREATE TABLE alert_state (
    event TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_fired_at TEXT,
    last_ok_at TEXT
  );

  CREATE TABLE backup_archives (
    name TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('full', 'inc')),
    created_at TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    pulled_at TEXT,
    acked_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX idx_backup_archives_pending ON backup_archives(acked_at, created_at);
  `,
  `
  -- v0.3.0：备份管理/文件级恢复。仅追加列与新表，旧库（schema v2）可直接升级。
  ALTER TABLE backup_archives ADD COLUMN verified_at TEXT;
  ALTER TABLE backup_archives ADD COLUMN origin TEXT NOT NULL DEFAULT 'pi';
  ALTER TABLE backup_archives ADD COLUMN manifest_json TEXT;
  ALTER TABLE backup_archives ADD COLUMN last_error TEXT;
  CREATE INDEX idx_backup_archives_origin ON backup_archives(origin);

  CREATE TABLE restore_plans (
    id TEXT PRIMARY KEY,
    archives_json TEXT NOT NULL,
    selection_json TEXT NOT NULL,
    target_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'executing', 'completed', 'failed', 'expired')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
  );
  CREATE INDEX idx_restore_plans_status ON restore_plans(status, expires_at);
  `,
  `
  -- v0.3.1：5 GB 分片上传会话与块索引。仅追加表，旧库（schema v3）可直接升级。
  CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    chunk_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('uploading', 'assembling', 'completed', 'aborted', 'expired')),
    expected_sha256 TEXT,
    file_id TEXT,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_upload_sessions_active ON upload_sessions(status, expires_at);
  CREATE INDEX idx_upload_sessions_actor ON upload_sessions(actor, status);

  CREATE TABLE upload_chunks (
    session_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, idx)
  );
  `,
  `
  -- v0.4.0：笔记附件/版本、多文件分享、指标历史。仅追加表/列；
  -- 重建 files 唯一索引以纳入 origin（历史行默认 user，行为不变）。
  ALTER TABLE files ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
    CHECK (origin IN ('user', 'note', 'system'));
  DROP INDEX idx_files_unique_active_name;
  CREATE UNIQUE INDEX idx_files_unique_active_name
    ON files(COALESCE(parent_id, ''), name COLLATE NOCASE, origin)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_files_origin ON files(origin);

  CREATE TABLE note_attachments (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, file_id)
  );
  CREATE INDEX idx_note_attachments_file ON note_attachments(file_id);

  CREATE TABLE note_versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_note_versions_note ON note_versions(note_id, created_at DESC);

  CREATE TABLE share_items (
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (share_id, file_id)
  );
  CREATE INDEX idx_share_items_file ON share_items(file_id);
  INSERT INTO share_items (share_id, file_id) SELECT id, file_id FROM shares;

  CREATE TABLE metrics_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ts_epoch INTEGER NOT NULL,
    cpu_percent REAL NOT NULL,
    mem_used INTEGER NOT NULL,
    mem_total INTEGER NOT NULL,
    temp_c REAL,
    disk_free INTEGER NOT NULL,
    disk_total INTEGER NOT NULL,
    load1 REAL NOT NULL,
    load5 REAL NOT NULL,
    load15 REAL NOT NULL
  );
  CREATE INDEX idx_metrics_samples_ts ON metrics_samples(ts_epoch);
  `,
  `
  -- v0.4.0 数据修复：v5 回填时若 shares 指向不存在的文件（旧库在 foreign_keys=OFF 时写入），
  -- 会产生孤儿 rows / 错误 backfill。本迁移只做数据修复，不改变表结构。
  DELETE FROM shares WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = shares.file_id);
  INSERT OR IGNORE INTO share_items (share_id, file_id)
    SELECT s.id, s.file_id FROM shares s JOIN files f ON f.id = s.file_id;
  `,
  `
  -- v0.5.0：Bot 平台核心。令牌只存 AES-256-GCM 密文；事件表用于回调去重。
  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('telegram', 'discord', 'slack')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    secret_ciphertext TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    secret_tag TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT,
    last_checked_at TEXT
  );

  CREATE TABLE bot_targets (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('channel', 'user', 'group')),
    allow_commands INTEGER NOT NULL DEFAULT 0 CHECK (allow_commands IN (0, 1)),
    allow_notifications INTEGER NOT NULL DEFAULT 1 CHECK (allow_notifications IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE (bot_id, external_id)
  );
  CREATE INDEX idx_bot_targets_bot ON bot_targets(bot_id);

  CREATE TABLE bot_deliveries (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    target_id TEXT REFERENCES bot_targets(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('notification', 'command_reply', 'publish', 'test')),
    dedupe_key TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX idx_bot_deliveries_queue ON bot_deliveries(status, next_attempt_at);
  CREATE INDEX idx_bot_deliveries_bot ON bot_deliveries(bot_id, created_at DESC);
  CREATE UNIQUE INDEX idx_bot_deliveries_dedupe ON bot_deliveries(bot_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TABLE bot_publish_jobs (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES bot_targets(id) ON DELETE CASCADE,
    content_json TEXT NOT NULL,
    media_file_ids_json TEXT NOT NULL DEFAULT '[]',
    scheduled_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'canceled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX idx_bot_publish_jobs_schedule ON bot_publish_jobs(status, scheduled_at);

  CREATE TABLE bot_events (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    platform_event_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, platform_event_id)
  );
  CREATE INDEX idx_bot_events_received ON bot_events(received_at);
  `,
  `
  -- v0.5.1：QQ 官方 Bot、目标静默时段、AI 会话映射。
  -- SQLite 不能修改 CHECK，重建全部 Bot 表以扩展 platform 枚举。
  CREATE TABLE bots_v8 (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('telegram', 'discord', 'slack', 'qq')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    secret_ciphertext TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    secret_tag TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT,
    last_checked_at TEXT
  );
  INSERT INTO bots_v8
    (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at, last_error, last_checked_at)
    SELECT id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at, last_error, last_checked_at FROM bots;

  CREATE TABLE bot_targets_v8 (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots_v8(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('channel', 'user', 'group')),
    allow_commands INTEGER NOT NULL DEFAULT 0 CHECK (allow_commands IN (0, 1)),
    allow_notifications INTEGER NOT NULL DEFAULT 1 CHECK (allow_notifications IN (0, 1)),
    quiet_start_minute INTEGER CHECK (quiet_start_minute BETWEEN 0 AND 1439),
    quiet_end_minute INTEGER CHECK (quiet_end_minute BETWEEN 0 AND 1439),
    created_at TEXT NOT NULL,
    UNIQUE (bot_id, external_id)
  );
  INSERT INTO bot_targets_v8
    (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, quiet_start_minute, quiet_end_minute, created_at)
    SELECT id, bot_id, external_id, label, kind, allow_commands, allow_notifications, NULL, NULL, created_at FROM bot_targets;

  CREATE TABLE bot_deliveries_v8 (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots_v8(id) ON DELETE CASCADE,
    target_id TEXT REFERENCES bot_targets_v8(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('notification', 'command_reply', 'publish', 'test')),
    dedupe_key TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  INSERT INTO bot_deliveries_v8
    (id, bot_id, target_id, kind, dedupe_key, payload_json, status, attempts, next_attempt_at, last_error, external_id, created_at, updated_at, sent_at)
    SELECT id, bot_id, target_id, kind, dedupe_key, payload_json, status, attempts, next_attempt_at, last_error, external_id, created_at, updated_at, sent_at FROM bot_deliveries;

  CREATE TABLE bot_publish_jobs_v8 (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots_v8(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES bot_targets_v8(id) ON DELETE CASCADE,
    content_json TEXT NOT NULL,
    media_file_ids_json TEXT NOT NULL DEFAULT '[]',
    scheduled_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'canceled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  INSERT INTO bot_publish_jobs_v8
    (id, bot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, last_error, created_at, updated_at, sent_at)
    SELECT id, bot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, last_error, created_at, updated_at, sent_at FROM bot_publish_jobs;

  CREATE TABLE bot_events_v8 (
    bot_id TEXT NOT NULL REFERENCES bots_v8(id) ON DELETE CASCADE,
    platform_event_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, platform_event_id)
  );
  INSERT INTO bot_events_v8 (bot_id, platform_event_id, received_at)
    SELECT bot_id, platform_event_id, received_at FROM bot_events;

  DROP TABLE bot_events;
  DROP TABLE bot_publish_jobs;
  DROP TABLE bot_deliveries;
  DROP TABLE bot_targets;
  DROP TABLE bots;
  ALTER TABLE bots_v8 RENAME TO bots;
  ALTER TABLE bot_targets_v8 RENAME TO bot_targets;
  ALTER TABLE bot_deliveries_v8 RENAME TO bot_deliveries;
  ALTER TABLE bot_publish_jobs_v8 RENAME TO bot_publish_jobs;
  ALTER TABLE bot_events_v8 RENAME TO bot_events;

  CREATE INDEX idx_bot_targets_bot ON bot_targets(bot_id);
  CREATE INDEX idx_bot_deliveries_queue ON bot_deliveries(status, next_attempt_at);
  CREATE INDEX idx_bot_deliveries_bot ON bot_deliveries(bot_id, created_at DESC);
  CREATE UNIQUE INDEX idx_bot_deliveries_dedupe ON bot_deliveries(bot_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX idx_bot_publish_jobs_schedule ON bot_publish_jobs(status, scheduled_at);
  CREATE INDEX idx_bot_events_received ON bot_events(received_at);

  CREATE TABLE bot_ai_sessions (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    target_external_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, target_external_id, user_id)
  );
  CREATE INDEX idx_bot_ai_sessions_updated ON bot_ai_sessions(updated_at);
  `,
  `
  -- v0.5.2：目标 Chat 权限、AI 长期记忆、入站身份发现。
  -- allow_chat 与 allow_commands 分离：群/频道成员可 Chat，但斜杠命令仍只认命令用户白名单。
  ALTER TABLE bot_targets ADD COLUMN allow_chat INTEGER NOT NULL DEFAULT 0 CHECK (allow_chat IN (0, 1));

  CREATE TABLE bot_ai_memories (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    memory_id TEXT NOT NULL UNIQUE,
    summary TEXT NOT NULL DEFAULT '',
    summary_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, user_id)
  );
  CREATE INDEX idx_bot_ai_memories_updated ON bot_ai_memories(updated_at);

  CREATE TABLE bot_inbound_targets (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    target_external_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('channel', 'user', 'group')),
    user_id TEXT NOT NULL,
    user_name TEXT,
    is_direct INTEGER NOT NULL DEFAULT 0 CHECK (is_direct IN (0, 1)),
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, target_external_id, user_id)
  );
  CREATE INDEX idx_bot_inbound_targets_seen ON bot_inbound_targets(bot_id, last_seen_at DESC);
  `,
  `
  -- v0.5.4：任务/对话 AI 会话分离；旧会话保持为 chat，/ask 新建 task 会话。
  CREATE TABLE bot_ai_sessions_v10 (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    target_external_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'task')),
    session_id TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, target_external_id, user_id, mode)
  );
  INSERT INTO bot_ai_sessions_v10
    (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
  SELECT bot_id, target_external_id, user_id, 'chat', session_id, model, created_at, updated_at
  FROM bot_ai_sessions;
  DROP TABLE bot_ai_sessions;
  ALTER TABLE bot_ai_sessions_v10 RENAME TO bot_ai_sessions;
  CREATE INDEX idx_bot_ai_sessions_updated ON bot_ai_sessions(updated_at);
  `,
  `
  -- v0.5.5：私聊 Chat 用户角色卡；每个 Bot×用户一张，可停用/覆盖。
  CREATE TABLE bot_chat_roles (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 1000),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, user_id)
  );
  CREATE INDEX idx_bot_chat_roles_updated ON bot_chat_roles(updated_at);
  `,
  `
  -- v0.5.7：目标群聊触发策略；入站事件结果用于诊断（只追加列/索引）。
  ALTER TABLE bot_targets ADD COLUMN chat_trigger TEXT NOT NULL DEFAULT 'mention' CHECK (chat_trigger IN ('mention', 'all'));
  ALTER TABLE bot_events ADD COLUMN event_kind TEXT;
  ALTER TABLE bot_events ADD COLUMN outcome TEXT;
  ALTER TABLE bot_events ADD COLUMN detail TEXT;
  ALTER TABLE bot_events ADD COLUMN target_external_id TEXT;
  ALTER TABLE bot_events ADD COLUMN user_id TEXT;
  ALTER TABLE bot_events ADD COLUMN updated_at TEXT;
  CREATE INDEX idx_bot_events_outcome ON bot_events(bot_id, outcome, received_at);
  `,
  `
  -- v0.5.8：Bot 平台收敛为 QQ 单平台；删除非 QQ Bot 配置及其级联数据（目标/队列/事件/会话/记忆/角色）。
  DELETE FROM bots WHERE platform <> 'qq';
  `,
  `
  -- v0.5.11：结构化长期记忆（条目 + 每用户状态）；旧滚动摘要表保留为迁移来源/备份。
  CREATE TABLE IF NOT EXISTS bot_memory_items (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('profile','preference','fact','project','task','relationship','episode')),
    mem_key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
    importance INTEGER NOT NULL DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
    source TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','legacy')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    UNIQUE (bot_id, user_id, kind, mem_key)
  );
  CREATE INDEX IF NOT EXISTS idx_bot_memory_items_user ON bot_memory_items(bot_id, user_id, kind, importance);
  CREATE INDEX IF NOT EXISTS idx_bot_memory_items_expiry ON bot_memory_items(expires_at);

  CREATE TABLE IF NOT EXISTS bot_memory_state (
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (memory_enabled IN (0, 1)),
    legacy_migrated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bot_id, user_id)
  );
  `,
]

export interface OpenOptions {
  /** 测试可传入 :memory:；生产为文件路径。 */
  path: string
  /** 是否输出迁移日志，默认 false。 */
  verbose?: boolean
}

/** 当前程序支持的最新 schema 版本（等于迁移数量）。 */
export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS.length

function migrate(db: DatabaseSync, verbose: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  let current = row ? Number(row.value) : 0
  if (!Number.isInteger(current) || current < 0) current = 0
  // 旧 release 跑过更新 schema 的库：静默跳过会让缺失列/新表语义错乱（例如附件泄露到普通树），
  // 因此明确拒绝启动，要求升级应用或从备份恢复。
  if (current > MIGRATIONS.length) {
    throw new Error(
      `数据库 schema 版本 v${current} 高于当前程序支持的 v${MIGRATIONS.length}：请升级应用或从备份恢复，禁止降级运行`,
    )
  }
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current]!
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('schema_version', String(current + 1))
      db.exec('COMMIT')
      current += 1
      if (verbose) console.log(`[db] migrated to schema v${current}`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export function openDatabase(options: OpenOptions): DatabaseSync {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (options.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  // 迁移前修复历史孤儿：旧库可能关闭 foreign_keys 写入过 shares.file_id 指向已消失文件的行，
  // 直接迁移会因 share_items 外键失败。只删除这类不可达分享行（无任何可恢复内容）。
  repairOrphanShares(db, options.verbose ?? false)
  // 迁移前外键一致性检查：其它损坏数据先暴露，避免迁移中才失败或写入更混乱的数据。
  try {
    const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown as { table?: string }[]
    if (violations.length > 0) {
      const sample = violations[0] as Record<string, unknown>
      throw new Error(`数据库外键一致性检查失败（${violations.length} 条），请从备份恢复：${JSON.stringify(sample)}`)
    }
    migrate(db, options.verbose ?? false)
  } catch (error) {
    // 打开/迁移失败时关闭句柄，避免 Windows 上临时库文件被占用导致清理失败。
    try {
      db.close()
    } catch {
      // 句柄可能已不可用，忽略并抛出原始错误。
    }
    throw error
  }
  return db
}

/** 迁移前清理不可达的 shares 行（file_id 指向不存在文件）；表不存在时跳过。 */
function repairOrphanShares(db: DatabaseSync, verbose: boolean): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('shares', 'files')")
    .all() as unknown as { name: string }[]
  if (tables.length < 2) return
  const result = db.prepare('DELETE FROM shares WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = shares.file_id)').run()
  if (Number(result.changes) > 0 && verbose) {
    console.warn(`[db] 已清理 ${Number(result.changes)} 条指向不存在文件的孤儿分享`)
  }
}

/** 简单事务封装；fn 抛错自动回滚。 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}
