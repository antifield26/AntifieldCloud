# 路线图

## v0.5.2（已实现，待部署/待验收）

- **Bot Chat**：普通消息（非斜杠）在目标 `allow_chat=1` 时进入 AI Chat；群/频道仅 @Bot 或回复 Bot，私聊全部；Telegram/Slack/QQ Webhook 与 Discord Gateway 支持；非管理员只能 Chat，管理员斜杠命令仍由 `allow_commands` 目标 + user 白名单双校验；Chat 只读，不占写操作。
- **长期记忆**：每 Bot×用户一份，DB `bot_ai_memories` 摘要为权威（`summary_session_id`）+ `DATA_DIR/bot-memory/memory-<uuid>.md` 镜像（0700/0600）；每轮滚动摘要；摘要失败保留旧摘要；不通过 API/UI 暴露；系统提示内置，`BOT_AI_SYSTEM_PROMPT` 覆盖；不额外占对话轮次或 AI 每小时配额。
- **多附件发布**：最多 5 个、单 10 MiB、总 50 MiB；Telegram 全图片 media group/混合逐文件、Discord 单次 multipart、Slack 逐文件；QQ 仅文本；`partial_media_sent` 不自动重试。
- **只读按钮**：Telegram/Discord `/status`、`/help` 刷新/帮助按钮；需目标 `allow_commands` + user 白名单；无写操作；Slack/QQ 不做。
- **Discord Gateway**：Node 内置 WebSocket；`intents=37377`（含 `MESSAGE_CONTENT`）；需 Developer Portal 开启 intent；HELLO/IDENTIFY/RESUME、心跳、RECONNECT/INVALID_SESSION、指数退避与致命关闭码；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；状态显示。
- **数据/管理面**：schema v9（迁移 9：`allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）；目标 `allowChat`、最近入站目标 `GET /api/bots/:id/inbound-targets` 与 `/bots` 登记、发布媒体多选、Gateway 状态。
- **env**：`BOT_CHAT_RATE_PER_MINUTE=6`、`BOT_AI_MEMORY_MAX_CHARS=4096`、`BOT_AI_SYSTEM_PROMPT=`、`BOT_DISCORD_GATEWAY_ENABLED=false`、`BOT_PUBLISH_MAX_MEDIA_FILES=5`、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`；已有 `BOT_AI_RATE_PER_HOUR=10`。
- **状态**：本地 `npm test` 293（服务端 277 + 脚本 16）、`npm run test:web` 140（28 文件）、`npm run check` 通过；生产仍为 v0.5.1/schema v8，v0.5.2 部署、迁移 v9、Discord Gateway 真实长连接与各平台 Chat/多附件/按钮**待验收**。

### v0.5.2 部署后待办

1. PC 部署前生成迁移前 DB 快照，迁移 v8→v9；`/healthz` 断言 `version=0.5.2`、`schemaVersion=9`；smoke 用 `-ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9`。
2. Discord Developer Portal 开启 **Message Content Intent**；按需设 `BOT_DISCORD_GATEWAY_ENABLED=true`，确认 `BotSummary.gateway.state=connected`，验证私聊/@/回复进入 Chat、普通频道消息不消费。
3. Telegram 群关闭 privacy mode（或只回复 Bot）；Slack/QQ 真实 Chat 联调；在 `/bots` 给目标勾选 `allow_chat` 并从“最近入站目标”登记。
4. 多附件真实平台外发（5 个/10 MiB/50 MiB）与失败/partial 场景；确认不自动重试导致重复外发。
5. 记忆文件权限/位置与摘要失败保留旧摘要；验证 `DATA_DIR/bot-memory` 不通过 Web 暴露、重启后仍能读取；真实模型多轮对话。
6. 按 `docs/ACCEPTANCE.md` v0.5.2 填写证据后再标记通过；生产部署前不得宣称已验收。

## v0.5.3（规划：企业平台）

- **企业微信/钉钉/飞书**：新增平台适配器、回调验签/加解密、目标与消息发送；仍需各平台后台注册与真实联调。
- 多管理员/审批流、QQ 媒体、Slack 按钮不在 v0.5.3 承诺范围（单管理员/企业平台优先）。

## v0.5.1（已交付）

- **QQ 官方 Bot**：`server/src/bot/adapters/qq.ts`；AppID + AppSecret（密文）；op=13 Ed25519 回调地址校验、op=0 事件验签、`{opcode:12}` 确认；C2C/群@/频道文本命令与通知；仅文本（≤2000 字符），不支持媒体。生产回调已配置，C2C `/help` 回复已实测。
- **OpenCode AI `/ask`**：`server/src/bot/ai.ts`；`BOT_AI_*` 默认关闭；仅命令白名单用户；按用户每小时限流；会话复用（`bot_ai_sessions`）；新建会话 deny-all 工具权限（OpenCode 明确 400 拒绝时才降级并标注“未隔离”）；生产已启用 `opencode-go/deepseek-v4.1-flash` 并验证真实回复。
- **Bot 运维**：`GET /api/bots/:id/metrics?hours=24` 指标卡；目标静默时段（0–1439，成对设置，通知延后）；发布 `confirmText:'PUBLISH'` 二次确认（TOTP 仍必填）。
- **数据**：schema v8（迁移 8 重建 Bot 表扩展 `qq`、增加静默列、新增 `bot_ai_sessions`；迁移 6/7 保留）。
- **安全收口**：fail2ban dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后异步重启 fail2ban 恢复封禁 set；`smoke.ps1` 支持 `-AccessClientId/-AccessClientSecret`。
- **工具链**：typescript-eslint 8.x 仍不支持 TS7 API，本轮结论为暂不升级、保留双 alias。
- **状态**：本地 `npm test` 265（服务端 249 + 脚本 16）、`npm run test:web` 139、`npm run check` 通过；生产已部署 v0.5.1/schema v8（release `20261021T091001Z`），smoke 23/23；Discord + QQ 命令、AI 真实模型、fail2ban 持久化已验证。

## v0.5.0（已交付）

- **Bot 平台**：Telegram/Discord/Slack 适配器；签名 Webhook `/api/bot/webhook/:botId`（Telegram secret token、Discord Ed25519 + 时间戳、Slack HMAC + 时间戳、事件去重）；管理 API `/api/bots*` 与 `/bots` 页面。
- **只读命令**：`/help`、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`；目标 `allow_commands` + 显式 user 白名单双校验；输出清洗路径/URL。
- **通知与发布**：告警事件按目标 `allow_notifications` 通知；TXT + 单个云端媒体发布（≤10 MiB、频道/群组）、TOTP 再认证、定时/取消/重试/死信重投。
- **安全与数据**：Bot 凭据 AES-256-GCM（`BOT_SECRET_KEY`，只写不读）；Webhook/命令/发布限流；默认 `BOT_ENABLED=false`；schema v7（迁移 7 新增 5 张 Bot 表，迁移 6 保留）。
- **运维**：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY`；部署脚本干净工作树门禁、回滚还原 `APP_VERSION`、smoke 失败门禁；`check-version` 覆盖 env.example/DEPLOY 标题/lock；SSH 仅公钥（`00-` drop-in，24h 回滚窗口）；Cloudflare Access 策略与 bypass 文档。
- **文档**：README/AGENTS/CHANGELOG/PLAN/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ACCEPTANCE/AUDIT 全量同步；第四轮审计记录。

## v0.4.2（已交付）

- TypeScript 6.0.3 → **7.0.2**（官方并排方案：`@typescript/native` 提供 `tsc`；`typescript` 别名到 `@typescript/typescript6@6.0.2` 供 typescript-eslint）；typecheck/lint/test/build/npm ci 全绿。
- 修复 Android 窄屏指标趋势周期选择器压缩文字：按钮不收缩、标签不换行、范围选择器横向滚动。
- 工作区清理（生成物/缓存）与文档/版本/测试基线对齐；CI 增加 `check-version`。

## v0.4.1（已交付）

- OpenCode v2.0.32 → **v2.1.1** 升级；兼容性复核：Basic `/api/session`、`POST /api/session`（垫片新建会话）、垫片注入、`/api/*` 探测、公开 `ai.*` 入口。
- OpenCode Basic 密码轮换，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env` 与 service.json。
- Dependabot：actions/checkout 4→7、actions/setup-node 4→7、gitleaks-action 2→3；TypeScript 7 major 暂缓。
- 清理 Pi legacy 世界归档约 9 GiB；旧 cron 保持停用；应用 0.4.1（schema v6 不变）。

## v0.4.0（已交付）

- **可观测性**：主机指标 60s 采样/30 天保留、1h/6h/24h/7d/30d 范围查询、Dashboard 四张 SVG 趋势卡、Activity 关键词/时间范围、Alerts 筛选分页、`/api/storage`。
- **笔记增强**：附件（1–5/请求、25 MiB、每笔记 100、计入配额、`origin=note` 隔离）与版本历史（保留 20、查看/恢复）。
- **多文件分享**：1–50 个文件、`itemCount/totalSizeBytes`、公开逐项下载、按分享会话计数、删除即吊销；仍不生成服务端 zip。
- **世界备份与灾备**：`antifieldcloud-world.timer` 周度一致性备份（保留 4 份）、Windows `world-pull` 两阶段拉取（失败不 ack）、`drill` 自动恢复演练（报告 180 天）、三类状态文件与超期告警、密钥包 `KEEP=2`/tmpfs。
- **备份链路完善**：`skippedMissing/warnings`、prepare 超时对齐、ack 事务、恢复 origin 过滤、快照/staging 上限、归档浏览限流。
- **加固**：systemd capability/设备/内核面收紧、nftables 收窄 22/25565/25575、opencode Origin 校验、审计截断、CI coverage/audit/secret-scan/dependabot。
- **文档**：全量同步并收敛审计 OP-19/WE-24 漂移；新增 `check-version.mjs`。

## 下一批候选（按价值排序）

1. **更多 Bot 平台**：企业微信/钉钉/飞书（v0.5.3；需各自回调签名/加解密与媒体模型）；QQ 媒体能力待平台开放后再评估。
2. **Bot 多人审批/发布复核**：在单管理员 TOTP + `PUBLISH` 之外增加第二人复核或延时窗口；需先定义多管理员模型。
3. **Slack 按钮**：Slack interactivity 与 `response_url`/`trigger_id` 语义，补齐与 Telegram/Discord 一致的只读按钮。
4. **整包加密 + 异地副本**：普通归档仍含 TOTP/会话明文；优先评估 age/restic 整包加密、VPS/对象存储异地副本与生命周期。
5. **目录/打包分享**：目录选择、流式 zip（不落盘）、分享内相对路径；需处理配额、次数与 tar 安全。
6. **笔记公开分享**：只读 token + 密码/过期，沿用分享限流与 noindex；需先定义 Markdown/附件外链的泄漏边界。
7. **WebDAV / rclone（只读优先）**：读写需处理锁/并发/配额；复用现有 DB id 与不可变语义。
8. **可观测性扩展**：更多告警通道（企业微信/钉钉/邮件）、日志聚合/检索、外部 uptime 监控；指标长期降采样。
9. **Minecraft 启停/日志**：窄权限 helper、固定命令白名单、二次确认与审计；需系统级改动与用户授权。
10. **SSD 迁移 + LUKS**：USB/NVMe HAT，迁移数据/备份临时目录并做全盘加密。
11. **SSH/sudo 加固收尾**：SSH 已仅公钥 + `fail2ban` sshd jail（24h ban，已持久化）；后续收紧 `antifield` 的 `NOPASSWD ALL`，需用户确认后执行。

## 明确不做（至少近期）

- 多租户/SaaS 化、公开注册。
- 端到端加密同步客户端（Syncthing 式）——与 Web 云盘定位冲突。
- Minecraft 任意 RCON 控制台/插件管理。
- 服务端媒体转码/大模型推理。
- 替换现有 Minecraft/SakuraFRP/opencode 服务。
- 为分享生成服务端 zip 包（多文件逐项下载已够用）。
- Slack/QQ 按钮（v0.5.2 明确不做）。
- QQ 媒体与多管理员审批（v0.5.2 明确不做）。

## 已知限制

- v0.5.2 的 Chat/记忆/多附件/按钮/Gateway 仅有进程内 mock/假 WebSocket 测试；生产未部署 v0.5.2，Discord Gateway 真实长连接与各平台 Chat/多附件需部署后联调；Discord 需 Developer Portal 开启 Message Content Intent。
- v0.5.2 多附件部分成功不自动重试（标记 `partial_media_sent`），需人工确认并重建；单次最多 5 个、单 10 MiB、总 50 MiB。
- 记忆只保留摘要，不保存逐条对话；不提供导出/删除页面；删除 Bot 时 DB 记忆行级联删除，`DATA_DIR/bot-memory` 镜像文件不由删除路径清理，需按保留期/人工清理。
- 企业微信/钉钉/飞书未实现（v0.5.3）；多管理员审批未实现；QQ 媒体未实现；Slack/QQ 按钮未实现。
- QQ 官方 Bot 仅文本、不支持媒体；真实回调需用户后台配置；群/频道目标仍需真实场景补充。
- `/ask` 与 Chat 依赖 OpenCode 本地 API 与已配置模型；默认关闭，v0.5.1 生产已验证 `/ask`；v0.5.2 Chat/记忆真实模型行为待验收；deny-all 工具在 OpenCode 明确拒绝 `permissions` 时会降级并在日志标注未隔离。
- Cloudflare Access 策略/bypass 与 service token 需用户后台配置，应用无法自证；smoke 的 Access token 仅用于测试，不替代应用认证。
- `fail2ban` 封禁已由 dbfile 持久化，nftables 启动后由 drop-in 异步重启恢复；手工 `systemctl reload nftables` 不触发，需手动 `systemctl restart fail2ban`。
- SSH 已仅公钥（`00-` drop-in，24h 回滚窗口），`fail2ban` sshd jail（nftables 后端、24h ban）；Pi 登录用户 `antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择），待收紧。
- RCON 仍监听所有接口，仅由 nftables 限制为 loopback；Cloudflare 终止 TLS，可见明文；Cloudflare 约 100 MiB/100s 请求限制约束单请求上传（大文件走分片）。
- 限流为内存态，重启清零；`http-proxy` 在 Node 26 有弃用警告；scrypt 仍为 N=2^15；`typescript-eslint` 尚不支持 TS7 API，保留双 alias。
- 分享下载次数为会话级近似限制；无目录打包/公开笔记分享；多文件分享逐项下载。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练任务需用户手动安装；无异地世界副本。
- 备份无整包加密与异地副本；普通归档含 TOTP/会话明文与 Bot 密文，PC ACL 与离线介质是最后防线。
- Bot：命令严格只读、无平台主动拉取（Discord Gateway 除外）；适配器/AI 测试为进程内 mock，上线前需平台沙箱/真实模型联调。
- 旧世界 cron 已停用、旧 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
