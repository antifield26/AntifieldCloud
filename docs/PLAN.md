# AntifieldCloud v0.7.2 实施计划（当前状态）

本文件记录当前版本的范围、决策、非目标与回滚方式。版本演进见 `docs/ROADMAP.md` 与仓库根 `CHANGELOG.md`；完整验收证据见 `docs/ACCEPTANCE.md`；契约见 `docs/API.md`；界面见 `docs/UI-SPEC.md`。

## 当前版本

- **版本**：v0.7.2；schema **v17**；OpenCode **v2.1.4**；Node.js **v26.12.1**。
- **生产**：release `20261025T132950Z`/commit `eb74382`；`/healthz` v0.7.2/schema17；部署内 smoke 24/0/1/2、完整 Access smoke **33/0/0/2**；drill `20261025T133743Z` schema17 通过。
- **发布**：Tag `v0.7.2` + GitHub Release。
- **测试基线**：`npm test` **497**、`npm run test:web` **222**（44 文件）；服务端覆盖率 **92.85/78.35/88.11**、前端 **52.31/47.32/45.02**；`npm run check`、`npm run build`、`check-version`（严格 `0.7.2`）通过。

## 范围

- **审计诊断**：`audit_write_failures` 单行表持久化失败计数/最近错误/时间；`/api/version.audit.persisted` 标识来源；DB 不可用时回退内存诊断，不阻断业务。
- **Bot 记忆**：严格 `memory-<uuid>.md` 镜像的孤儿清理（无 DB 引用且超过 24h）；删除 Bot 时清理对应镜像；启动/维护任务执行。
- **导入归档**：`BACKUP_IMPORT_RETENTION_DAYS=90`（0=永久）；维护任务清理超期 `origin='import'` 归档，跳过活动恢复计划引用，并清理无 DB 记录的超期导入文件。
- **告警重通知**：`ALERT_REPEAT_HOURS=24`（0=关闭）；持续 firing 按间隔重发 webhook，状态保持 firing；配置摘要返回 `repeatHours`。
- **备份锁**：`.backup.lock` 持有期间每 30s 刷新 mtime；超过 1h 才允许陈旧锁接管。
- **DR-1**：`--prepare` 输出与 manifest 增加 `clockSkew`（detected/futureFiles/watermarkRollback），只提示不自动修正水位。
- **BotService 拆分**：`targets.ts`（目标 CRUD/校验）、`roles-admin.ts`（用户/群角色卡）、`memory-admin.ts`（记忆管理）；`service.ts` 保留 facade 与依赖装配，公开 API 不变。
- **负路径测试**：AI 429、审计持久化、镜像孤儿、导入保留/活动计划保护、告警重通知、锁心跳、DR-1 断言。
- **运维**：Cloudflare `ai` Access（Owner allow + Smoke service token；Free 无自定义 WAF）；SSH 仅公钥且旧回滚备份归档；Windows 世界拉取周任务（周日 12:00）；rclone v1.75.2 已安装。备份整包加密/异地副本保持关闭，异地副本不配置 remote。

## 关键决策

| 项 | 当前决策 |
|---|---|
| schema | v17；迁移只向上、无 down；启动时 `PRAGMA foreign_key_check`，schema 高于程序支持版本拒绝启动 |
| 认证 | 单管理员；密码 scrypt + TOTP；会话 7 天；CSRF + Origin；登录/TOTP/再认证独立限流 |
| 文件 | 普通上传 100 MiB；分片 5 GiB/8 MiB 块；配额 10 GiB（含回收站与笔记附件）；`files.origin` 隔离可见性 |
| 笔记 | 附件单文件 25 MiB、每笔记 100、每请求 1–5；版本历史保留 20 |
| 分享 | 单文件兼容 + 多文件 1–50；密码新建 ≥8；默认 7 天/最长 30 天；不生成 zip；token 只存 SHA-256 |
| Minecraft | 应用 API 仅只读状态 + 白名单增删；世界备份 root 脚本固定 `save-off/save-all flush/save-on`；周日 12:00、保留 4 份 |
| OpenCode | 固定 loopback 上游；`ai` 仅经会话校验反代；HTTP/WS 校验 Origin；客户端 Authorization/Cookie 覆写 |
| Bot 平台 | 仅 QQ 官方 Bot；AppSecret 派生 Ed25519；Webhook 验签/去重；仅文本、≤2000 字符 |
| Bot Chat | 仅普通消息 Chat；`allow_chat` 与 `allow_commands` 分离；群聊共享唯一 OpenCode 会话并按目标串行；群/频道仅 @Bot 或显式全量消息 |
| Bot 命令 | 仅 C2C 私聊；自助命令 + 只读命令；目标 `allow_commands` + 显式 user 白名单；群聊/频道不执行斜杠命令 |
| Bot 发布 | 仅纯文本；目标频道/群组；TOTP + `PUBLISH` 双确认；定时 ≤30 天；失败退避重投 |
| Bot 记忆 | `bot_memory_items` 7 类；群共享 scope 使用稳定 `member_openid`；TTL/容量/预算按 env；key/value 不进入 API/UI |
| 凭据 | QQ AppSecret AES-256-GCM；`BOT_SECRET_KEY` 32 字节 base64；API/日志只写不读 |
| 静默时段 | `quiet_start_minute`/`quiet_end_minute` 本地分钟 0–1439，成对设置、不能相同；通知延后不丢弃 |
| 指标 | 60s 采样、30 天保留；`/api/metrics` 按桶聚合；Bot 指标 1–720h |
| 告警 | 通用 JSON webhook（10s×3、可选 HMAC）+ Bot 通知；去重/冷却/恢复通知；90 天事件；持续 firing 按 `ALERT_REPEAT_HOURS` 重通知 |
| 备份 | 两阶段 pending/ack；加密默认关闭、失败关闭；Web 不持私钥、加密归档 409；导入归档 90 天；锁 30s 心跳 |
| 世界/演练 | PC 周度 world-pull 校验后 ack；drill 校验 full+inc 链、SHA、tar 安全、DB integrity/FK/schema；报告 180 天 |
| 系统 | systemd 沙箱 + nftables 默认拒绝入站；SSH 仅公钥；`antifield` NOPASSWD sudo 保留（用户选择） |

## 非目标（当前不做）

单进程/HA、内存限流改造、同步维护任务异步化、SQLite `synchronous=NORMAL`、单 SD 卡迁移 LUKS、`antifield` sudo 收紧、RCON bind 限制、Cloudflare 明文改造、真实 QQ/OpenCode/Cloudflare 负路径的线上自动化、WebDAV、Minecraft 启停/控制台、多用户/权限分离、Bot 多管理员审批、QQ 媒体发布、企业微信/钉钉/飞书、目录打包分享、公开笔记分享、异地副本（当前关闭）、备份整包加密（当前关闭）。

## 回滚

- **应用**：`scripts/deploy.ps1` 停止服务、还原迁移前 DB 快照、还原上一 release 的 `APP_VERSION` 后切回 previous；无快照/读不到版本时拒绝自动回滚并打印手工步骤；部署后 smoke 失败默认让部署失败（`-AllowSmokeFailure` 仅告警）。
- **DB**：schema 只向上；回滚旧 release 前必须恢复 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`；当前 v17 包含 `audit_write_failures`，旧代码不能直接读 v17。
- **Bot**：`BOT_ENABLED` 默认 false；`BOT_SECRET_KEY` 不轮换（轮换=全部 Token 重录）；`bots`/`bot_targets`/`bot_events`/`bot_ai_sessions`/`bot_ai_memories`/`bot_inbound_targets`/`bot_group_roles` 随 DB 快照回滚；`DATA_DIR/bot-memory` 镜像按需人工清理。
- **备份/加密/异地**：关闭加密开关恢复明文；已生成 `.age` 保留但仅 PC 私钥可解密；异地副本关闭时删除/停用计划任务，Pi 状态文件保留只读。
