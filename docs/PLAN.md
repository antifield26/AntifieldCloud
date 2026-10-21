# AntifieldCloud v0.5.x 实施计划（摘要）

本文件是 v0.5.x 的权威范围/决策摘要；v0.4.x 历史见下方补充；完整交付与验收见 `docs/ACCEPTANCE.md`，界面见 `docs/UI-SPEC.md`，契约见 `docs/API.md`。当前版本 **v0.5.1**（schema v8）；生产仍为 v0.5.0/schema v7，待部署。

## v0.5.1 补充（当前）

- **QQ 官方 Bot**：新增 `server/src/bot/adapters/qq.ts` 与 `bots.platform='qq'`；op=13 Ed25519 回调地址校验、op=0 事件验签、`{opcode:12}` 确认体；C2C/群@/频道文本命令与通知；仅文本、单条 ≤2000 字符，不支持媒体。
- **OpenCode AI `/ask`**：`server/src/bot/ai.ts` 通过本地 OpenCode API 提供 AI 对话；`BOT_AI_*` 默认关闭、按用户每小时限流、仅命令白名单用户、`bot_ai_sessions` 会话复用、新建会话 deny-all 工具权限；真实模型待部署后验证。
- **Bot 运维**：`GET /api/bots/:id/metrics?hours=24` 24 小时指标卡；目标静默时段 `quietStartMinute`/`quietEndMinute`（0–1439，成对设置、不能相同），通知延后到窗口结束；发布新增 `confirmText:'PUBLISH'` 二次确认，TOTP 仍必填。
- **数据**：schema v8（迁移 8 重建 `bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events` 以扩展 `bots.platform` CHECK 到 `qq`，`bot_targets` 增加静默分钟列，新增 `bot_ai_sessions`）；迁移 6/7 保留。
- **安全收口**：fail2ban dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后异步重启 fail2ban 恢复封禁 set；`smoke.ps1` 新增 `-AccessClientId/-AccessClientSecret` Access service token 头，未配置 Access 时仍可跑。
- **工具链评估**：typescript-eslint 8.x 仍不支持 TS7 API，v0.5.1 结论为暂不升级、保留双 alias。
- **状态**：版本 0.5.1；本地测试基线 `npm test` 265（服务端 249 + 运维脚本 16）、`npm run test:web` 139，`npm run check` 本地通过；生产部署、QQ 真实回调、AI 真实模型与 Cloudflare Access 待后续验收。

## v0.5.0 补充（历史）

- **Bot 平台**：Telegram/Discord/Slack 适配器；公开签名 Webhook；管理 API/页面；只读命令；告警通知；TXT + 云端单媒体发布、定时/取消/重试；TOTP 再认证；默认关闭。
- **数据**：schema v7（迁移 7 新增 `bots/bot_targets/bot_deliveries/bot_publish_jobs/bot_events`；迁移 6 孤儿 shares 修复保留）；Bot 凭据 AES-256-GCM（`BOT_SECRET_KEY`）。
- **安全**：Token 只写/加密；日志/响应/审计脱敏；签名 + 时间戳 + 去重；IP/命令/发布限流；通知/命令输出路径清洗；Bot 关闭时 Webhook 404。
- **运维**：v0.5.0 部署顺序（备份/校验 → `bootstrap-env` 生成 key → 迁移 v7 → 默认关闭 → 显式启用）；回滚（迁移前快照 + `APP_VERSION`）；SSH 仅公钥 24h 回滚 + `fail2ban` sshd jail；Cloudflare Access 策略与 bypass；PC 备份任务重装；世界拉取任务复核；数据清理清单。
- **审计**：第四轮（v0.4.2 基线 P0=0/P1=0/P2=3/P3=12；Bot WIP P1=2/P2=4），残余明确。

## v0.4.1 补充

- 维护版：OpenCode 服务端 v2.0.32 → v2.1.1 升级与兼容性复核（Basic/session/垫片/公开入口）；OpenCode Basic 密码轮换并同步 env/service.json。
- 处理 Dependabot PR（actions/checkout 4→7、actions/setup-node 4→7、gitleaks-action 2→3）；关闭不兼容的 TypeScript 7 major。
- 清理 Pi legacy 世界归档（约 9 GiB），旧 cron 保持停用；应用版本 0.4.1，schema 仍为 v6。

## v0.4.2 补充

- 维护版：TypeScript 7.0.2 迁移（官方并排方案：`@typescript/native` 提供 `tsc`，`typescript` 别名到 `@typescript/typescript6` 供 typescript-eslint）。
- 修复 Android 指标趋势周期选择器压缩文字标签；工作区/文档清理，CI 增加 check-version。
- 版本 0.4.2；schema v6 不变。

## 目标

在 v0.5.0 已交付的 Bot 平台（Telegram/Discord/Slack）基础上，完成 v0.5.1：**QQ 官方 Bot 与 OpenCode `/ask` AI 对话，补齐 Bot 指标、静默时段与发布双确认，并收口 fail2ban 封禁持久化、Cloudflare Access service token 与文档/验收**。

## 范围

### Bot 平台（v0.5.1 增量）

- QQ 官方 Bot：AppID 公开配置 + AppSecret（写入 Token 字段，只存密文）；`op=13` 回调地址校验（Ed25519 返回 `plain_token`/`signature`）；`op=0` 事件验签（`X-Signature-Ed25519` + 时间戳 ±300 秒）；`C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`/`AT_MESSAGE_CREATE`；被动回复带 `msg_id`/`msg_seq`，主动通知走 `v2/users|groups` 或 `channels`；仅文本。
- AI `/ask`：默认 `BOT_AI_ENABLED=false`；仅已登记目标 + user 白名单；`BOT_AI_RATE_PER_HOUR`（默认 10）按 `botId:userId` 每小时限流；提示词 ≤`BOT_AI_MAX_PROMPT_CHARS`（默认 2000）；`BOT_AI_TIMEOUT_SECONDS`（默认 60）；会话按 `(bot,target,user)` 复用，保留 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7）；新建会话 deny-all 工具；可选 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`（两者同时设置才指定模型）。
- 指标：`GET /api/bots/:id/metrics?hours=24`（1–720 小时），返回投递/发布/事件统计、成功率、最近错误与最近发送；`/bots` 投递与发布分区展示近 24 小时指标卡。
- 静默：`bot_targets.quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地分钟 0–1439，成对设置、不能相同）；静默窗口内告警通知延后到结束，跨午夜按 `start > end` 处理。
- 发布确认：`POST /api/bots/:id/publish` 必须同时带 `totpCode` 与 `confirmText:'PUBLISH'`；缺失确认文本返回 400 `publish_confirm_required`。
- 保留 v0.5.0 的 Telegram/Discord/Slack 适配器、只读命令、通知、单媒体发布、TOTP、默认关闭与凭据加密语义。

### 可观测性与备份可视化

- 主机指标 60s 采样、30 天保留；范围查询 1h/6h/24h/7d/30d，桶聚合最多 240 点。
- Dashboard 四张 SVG 趋势卡；Activity 关键词/时间范围筛选；AlertsCard 状态/事件筛选与分页；轻量 `/api/storage`。
- 备份健康卡：应用归档链（待拉取/已确认/孤儿）、密钥包、世界备份、PC 拉取、恢复演练；Dashboard 与 Settings 共用只读状态。

### 知识库

- 笔记附件：每请求 1–5 个、单文件 25 MiB、每笔记 100 个，计入配额并以 `origin='note'` 与普通云盘隔离。
- 版本历史：标题/正文/标签变化自动快照，保留 20 个；查看/恢复；删除笔记级联删除版本与附件。

### 文件分享

- 多文件分享：一次 1–50 个活动普通文件，逐文件下载（不生成 zip）；`itemCount/totalSizeBytes`；旧单文件入口保持兼容。
- 次数按分享会话计；任一文件删除/回收站吊销整个分享；公开页解锁后展示文件清单。

### Minecraft 世界备份与灾备

- `scripts/backup-world.mjs` + `antifieldcloud-world.service/.timer`：周日 12:00 一致性 gzip 归档，保留 4 份，gzip/SHA 校验，状态 JSON，`save-on` 放 finally。
- `scripts/world-pull.ps1`：Windows 周度两阶段拉取（`.part` → SHA → 原子改名 → 远端 ack），失败保留远端不 ack，本地保留 4 份。
- `scripts/drill.ps1` + `drill-verify.mjs`：full+inc 链、sidecar SHA、tar 安全、DB integrity/FK/schema、manifest 校验，报告保留 180 天，可选世界解包验证。
- 状态文件 `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读），新增三类超期告警。
- 备份链路完善：pending 只算 `origin='pi'`、`skippedMissing/warnings`、prepare 超时对齐、`--ack` 事务、恢复 origin 过滤、快照行数/staging 上限、entries 限流、密钥包 tmpfs 与 `KEEP=2`。

### 系统与网络安全

- `antifieldcloud.service` capability/设备/时钟/主机名/内核日志/特殊权限收紧；世界备份 unit 独立加固。
- nftables 收窄：22 与 25565 仅实际直连/校园网段（22 新建连接限速 20/min），25575 仅 loopback，DHCP 绑物理网卡；80 不再放行。
- 登录/TOTP 全局限流调整（loopback 免占全局桶）；审计字段截断；opencode HTTP/WS Origin 校验。
- 部署脚本：APP_VERSION 注入与 `/healthz` 版本断言、磁盘/tar SHA/npm 预检、回滚先还原迁移前 DB 快照、部署后只读 smoke。
- v0.5.1：fail2ban dbfile 持久化 + nftables 启动后异步恢复封禁 set；smoke 的 Access service token 头（仅边缘身份层，不替代应用认证）。

### 文档与审计收口

- 同步 README/CHANGELOG/AGENTS/ARCHITECTURE/SECURITY/DEPLOY/ROADMAP/PLAN/UI-SPEC/ACCEPTANCE/BOT，修正过期版本、schema、测试数字、平台数量与待部署状态。
- `scripts/check-version.mjs` 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS/env.example/DEPLOY 标题及 lock 根版本一致。

## 阶段

1. 基线确认：v0.5.0 部署/审计待办分拣；确认 QQ 后台回调、AI 模型与 Cloudflare Access 的前置条件。
2. 服务端：schema v8（迁移 8 重建 Bot 表 + 静默列 + AI 会话）、QQ 适配器、`/ask` AI、metrics、静默通知、发布确认；保持 v0.5.0 安全语义。
3. 前端：`/bots` 配置增加 QQ、目标静默时段、投递/发布指标卡、发布 `PUBLISH` 确认；移动端布局不退化。
4. 运维：`bootstrap-env` 纳管 `BOT_AI_*`；fail2ban dbfile + nftables drop-in；smoke Access token；部署前快照/回滚与迁移 v8 流程。
5. 文档与版本一致性：全量文档同步、`node scripts/check-version.mjs`、CHANGELOG v0.5.1。
6. 本地验证：`npm run check`、`npm test`、`npm run test:web`、`npm run build`（按实际执行记录；本地已通过 check）。
7. 部署与验收：PC 部署、迁移前快照、v8 迁移、`BOT_AI_*` 写入、冒烟、QQ 真实回调、AI 真实模型、公网/手机/PWA、世界备份/拉取/恢复演练（schema 8）、Cloudflare Access 与 service token（待执行）。

## 验收摘要

1. `npm run check` 全绿（本地：服务端/脚本 265 = 249 + 16，前端 139；2026-10-21 已通过）；`npm run build`、覆盖率/audit/secret-scan 按部署前/CI 证据补。
2. 版本一致：`/healthz`、`/api/version`、`package.json`、README、CHANGELOG、AGENTS、`deploy/env.example`、DEPLOY 标题均为 0.5.1；schema v8（生产待部署仍为 v7）。
3. QQ：`/api/version.botPlatforms` 含 `qq`；op=13 校验返回签名；C2C/群@/频道文本命令与通知可达；媒体被明确拒绝；真实回调待用户在 QQ 后台配置。
4. AI：`BOT_AI_ENABLED=false` 时 `/ask` 返回未启用提示；开启后仅白名单用户可调用、按小时限流、会话复用、deny-all 工具；真实模型回复待部署后验证。
5. Bot 回归：T/D/S 签名/时间戳/去重、双白名单、通知、TOTP 发布不退化；发布新增 `confirmText` 校验。
6. 指标/静默：`GET /api/bots/:id/metrics` 需会话且统计正确；静默时段成对校验、通知延后、跨午夜正确。
7. 安全：fail2ban dbfile 持久化，nftables restart 后 drop-in 异步恢复封禁 set；手工 reload 仍需手动 restart fail2ban；smoke Access token 不泄漏。
8. 关闭态：`BOT_ENABLED=false` 时 Webhook 404、写接口 503、队列不启动；`/api/bots/status` 可读。
9. 备份：应用归档两阶段/密钥包（含 `BOT_AI_*` 与 `BOT_SECRET_KEY`）/导入恢复；世界备份保留 4 份；PC 拉取失败不 ack；演练 `-ExpectedSchemaVersion 8` 通过。
10. 用户完成公网/手机/PWA、QQ 回调、AI 真实模型、Cloudflare Access 与正式演练，并记录到 `docs/ACCEPTANCE.md`；未完成前不得声明通过。

## 关键决策

| 项 | 决策 |
|---|---|
| schema | v8：迁移 8 重建 Bot 表扩展 `platform` 到 `qq`、增加静默分钟列、新增 `bot_ai_sessions`；迁移 6/7 保留；只向上、无 down |
| QQ 平台 | AppSecret 写入 Token 字段并加密；Ed25519 op=13/op=0；仅文本、≤2000 字符、不支持媒体；目标用 openid/channel_id |
| AI | OpenCode 本地 API；默认关闭；仅白名单用户；每小时限流；会话复用；deny-all 工具（明确 400 时才降级并标注未隔离） |
| Bot 开关 | `BOT_ENABLED` 默认 false；`BOT_SECRET_KEY` 由 bootstrap 生成/复用；关闭时 Webhook 404/写接口 503 |
| Bot 凭据 | AES-256-GCM（32 字节 base64 key，12 字节 IV，key_version=1）；API/日志只写不读 |
| Bot 命令 | 固定只读命令 + `/ask`；目标 `allow_commands` + 显式 user 白名单；输出清洗路径/URL，≤10 条文件元数据 |
| Bot 发布 | 仅频道/群组；TXT + 最多 1 个普通文件媒体（≤10 MiB；QQ 无媒体）；必须 TOTP + `PUBLISH`；定时 ≤30 天；指数退避/死信重投 |
| 静默时段 | `quiet_start_minute`/`quiet_end_minute` 本地分钟 0–1439，成对设置、不能相同；通知延后不丢弃 |
| 指标 | `GET /api/bots/:id/metrics?hours=24`（1–720）；成功率 = sent/(sent+failed)；最近错误/发送跨投递与发布 |
| 通知 | 告警事件按目标 `allow_notifications` 入队；`dedupe_key` 去重；失败不影响告警 |
| 单文件上限 | 普通上传 100 MiB（Cloudflare Free/Pro 限制）；分片 5 GiB/8 MiB 块 |
| 配额 | 10 GiB（含回收站与笔记附件）；`fileCount` 只统计 `origin='user'` |
| 笔记附件 | 单文件 25 MiB、每笔记 100、每请求 1–5；`origin='note'` 隔离 |
| 版本历史 | 标题/正文/标签变化时快照，保留 20 |
| 分享 | 单文件兼容 + 多文件 1–50；密码新建 ≥8；默认 7 天/最长 30 天；0=不限次数；不生成 zip |
| 世界备份 | root 脚本固定 RCON 命令；周日 12:00；保留 4 份；PC 校验后 ack |
| 演练 | 自动化脚本季度/升级前执行；报告 180 天；schema 8；世界解包需显式 `-IncludeWorld` |
| 系统 | 允许一次 Pi 重启；nftables 网段按实际直连/校园网段填写；SSH 仅公钥（24h 回滚）；sudo 未改（用户选择） |
| 兼容 | 旧单文件分享、旧归档（无 origin 列按 user/pi 处理）、旧 legacy 世界归档、旧 `/healthz` 版本断言保持可解析；T/D/S Bot 行为保持 |

## 非目标（v0.5.x 不做）

企业微信/钉钉/飞书、Bot 多管理员审批/多附件、QQ 媒体、平台主动拉取/长连接、任意命令执行；目录打包分享、笔记公开分享、整包加密归档、异地副本/对象存储、WebDAV/rclone、Minecraft 启停/控制台、多用户与权限分离、SSD/LUKS 迁移、`antifield` sudo 收紧（用户确认后另做）。Cloudflare Access 只做 `app` 策略与 Bot/health/公开分享 bypass，不覆盖 `ai`（OpenCode 自身认证 + 应用会话已足够，后续再评估）。

## 回滚

- 代码：`scripts/deploy.ps1` 停止服务并还原迁移前 DB 快照、还原上一 release 的 `APP_VERSION` 后切回 previous；无快照/读不到版本时拒绝自动回滚并打印手工步骤；部署后 smoke 失败默认让部署失败（`-AllowSmokeFailure` 仅告警）。
- DB：schema v8 只向上；回滚旧 release 前必须恢复 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`；v8 重建过 Bot 表，不能只回退代码。
- Bot：`BOT_ENABLED` 保持 false；`BOT_SECRET_KEY` 不轮换（轮换=全部 Token 重录）；`bots/bot_ai_sessions` 数据随 DB 快照回滚；`/ask` 保持关闭。
- 系统：nftables 恢复 `/etc/nftables.conf.bak` 后 `systemctl restart nftables`；fail2ban drop-in 回滚删除 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` 后 `daemon-reload`；SSH 删除 `00-` drop-in 后 `sshd -t && systemctl reload ssh`（24h 窗口内）。
- 世界备份：`systemctl disable --now antifieldcloud-world.timer` 并移除 unit；旧 cron 未恢复前不重新启用。
- Windows：`Unregister-ScheduledTask` 世界拉取/演练任务；每日应用备份任务可用 `install-backup-task.ps1` 重装。
