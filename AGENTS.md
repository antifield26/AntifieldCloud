# AGENTS.md — AntifieldCloud 工程约定（后续所有 Agent 会话必读）

## 0. 项目一句话

在 Raspberry Pi 5（Debian 13，8 GB）上运行的自托管个人工作台：统一登录（密码 + TOTP）、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态/白名单、opencode 反代、Telegram/Discord/Slack/QQ 官方机器人（Chat/长期记忆/多附件/只读按钮/Discord Gateway/出站连通性自动恢复）、PWA、可观测性、主机告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。产品名 `AntifieldCloud · 个人工作台`。当前版本 v0.5.3，数据库 schema v9（迁移 5/6/7/8 保留，迁移 9 增加 `bot_targets.allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）；生产已部署 v0.5.3/schema v9（release `20261022T065126Z`，commit `df06383`）。OpenCode 服务端 v2.1.2。

权威文档：
- `docs/PLAN.md`：范围、决策、阶段与验收
- `docs/API.md`：HTTP 契约（服务端/前端共同遵守）
- `docs/UI-SPEC.md`：界面与交互
- `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`
- `docs/ROADMAP.md`：路线图与当前版本边界
- `docs/AUDIT.md`：第一至第四轮审计（v0.2.0 / v0.3.x / v0.4.0 / v0.4.2+v0.5.0）与残留
- `docs/ACCEPTANCE.md`：当前版本验收与历史记录

## 1. 语言与注释

- 代码注释、文档、提交信息、UI 文案一律中文（技术标识符除外）。
- 注释解释「当前行为/约束」，禁止写历史叙事（“之前……”“修复了……”）或轮次标记。
- 每个模块顶部用一段中文说明职责与安全边界。

## 2. 运行模型

- Node >= 26；服务端为原生 TypeScript，`node server/src/main.ts` 直接运行，**不要引入编译/打包服务端步骤**。
- 相对导入必须带 `.ts` 后缀；禁止 enum/namespace/参数属性等非可擦除语法（`erasableSyntaxOnly` 已开启）。
- 前端由 Vite 构建，产物 `web/dist`；服务端只托管静态产物，不参与前端编译。
- 依赖：服务端运行时依赖放 `dependencies`；React/Vite/ESLint 等仅构建期依赖放 `devDependencies`（Pi 上 `npm ci --omit=dev` 不安装）。
- 类型工具链（TS7 并排）：`npx tsc` 来自 `@typescript/native`（TypeScript 7.0.2）；`typescript` 包是 `@typescript/typescript6@6.0.2` 别名，仅供 typescript-eslint（8.x 尚不支持 TS7 API）。v0.5.1 评估结论（v0.5.2 未变）为暂不升级、保留双 alias；不要删除/合并这两个 alias，直到 typescript-eslint 支持 TS7.1 API。
- 不使用 Docker；Pi 上用 systemd 原生命令运行。

## 3. 命令

```bash
npm ci
npm run dev            # 本地服务端，默认 127.0.0.1:3000
npm run dev:web        # Vite :5173，/api 代理到 :3000
npm run build          # 前端构建
npm run typecheck      # server + web 两个 tsc 项目
npm run lint           # ESLint，--max-warnings=0
npm test               # node --test（收集 server/test/**/*.test.ts 与 scripts/test/**/*.test.mjs）
npm run test:coverage  # 服务端 + 运维脚本测试 + 覆盖率门禁（CI coverage job）
npm run test:web       # Vitest + jsdom（web/src/**/*.test.ts(x)）
npm run test:web:coverage # 前端测试 + 覆盖率门禁
npm run check          # typecheck + lint + server test + web test，提交前必须全绿
node scripts/check-version.mjs # 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS/env.example/DEPLOY 标题及 lock 根版本一致
```

当前基线：`npm test` **300** 项通过（服务端 + 运维脚本），`npm run test:web` **141** 项通过（28 个测试文件；本地实测 2026-10-22；`npm run check` 已通过）。测试禁止依赖真实 Minecraft、真实 opencode、真实 network；Bot 适配器（含 QQ 官方 Bot、Chat、多附件、按钮、Discord Gateway 与连通性探测）同样只使用进程内假平台/假 WebSocket/假 OpenCode（不访问真实平台或模型）；使用进程内假服务器/夹具。Windows 上无法测试的 systemd 相关用例用 `t.skip` 并在 Linux 上跑；`scripts/test/` 覆盖世界备份与恢复演练校验脚本（纯函数/夹具，不触碰真实 Pi）。

## 4. 目录与模块边界

```text
server/src/
  main.ts            进程入口：配置、DB、Fastify、信号退出、启动指标采样
  config.ts          环境变量解析与校验（失败即退出）
  logger.ts          Fastify/pino 日志与脱敏
  db.ts              SQLite 打开、迁移（当前 schema v9）、事务辅助
  auth/              scrypt、TOTP、会话、CSRF、限流、恢复码、审计（字段截断）、Bot 发布 TOTP 再认证
  files/             存储、上传、配额、搜索、预览、回收站、files.origin 可见性
  uploads/           分片上传会话/块索引、配额预留、拼接与过期清理
  mc/                SLP、RCON、白名单
  opencode/          ai.* Host 的认证反代 + HTML 模式（shim/attributes/passthrough）+ Origin 校验
  bot/               Telegram/Discord/Slack/QQ 适配器、Chat/`/ask` AI、长期记忆、Discord Gateway、出站连通性探测、只读按钮、AES-256-GCM 凭据、Webhook 验签/去重、命令、指标/静默、通知/发布队列与重试
  backups/           归档导入/校验、文件级恢复（skippedMissing）、世界/拉取/演练状态只读
  dashboard/         主机指标、服务状态、备份状态、Bot 开关、轻量存储用量（/api/storage）
  metrics/           60s 主机指标采样、按范围分桶聚合、30 天保留清理
  notes/             笔记/书签、标签、FTS5、附件（origin=note）、版本历史
  shares/            单文件/多文件分享、密码/过期/次数/公开逐项下载
  alerts/            告警条件/状态机/webhook（含世界备份/拉取/演练超期）与 Bot 通知入队
  http/              路由注册（含 bots.ts、bot-webhook.ts）、错误处理、静态资源、安全头、Cloudflare Access 前置说明
  util/              通用工具（时间、路径、响应、只读状态文件解析）
web/src/             React 页面与组件（只依赖 docs/API.md 的契约；/bots 管理页）
scripts/             provision/backup CLI、世界备份 backup-world.mjs、drill-verify.mjs、
                     world-pull.ps1、drill.ps1、部署/冒烟 PowerShell、bootstrap-env.sh、check-version.mjs
scripts/test/        运维脚本单元测试（node --test .test.mjs）
deploy/              systemd（应用/健康探针/世界备份 timer）、nftables、cloudflared ingress、env 模板
```

写作用域约定：服务端改动在 `server/`，前端在 `web/`，脚本在 `scripts/`，文档在 `docs/`；跨域改动先在本文件或任务中说明。

## 5. 安全红线（不可违反）

1. 应用 API 不提供任意 Minecraft RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
   `scripts/backup-world.mjs` 是唯一例外：以 root 由 `antifieldcloud-world.timer` 调用，只执行固定的
   `save-off` / `save-all flush` / `save-on`（`save-on` 放在 finally），应用 API 不可触达该能力。
2. 文件访问只经 DB id，不接受客户端路径；文件内容不可变；禁止覆盖上传。
3. 所有非 GET `/api` 校验 CSRF；Cookie `HttpOnly + Secure + SameSite=Lax`（仅 loopback HTTP 例外）。
4. 密码/TOTP/隧道凭据/opencode 密码不得进仓库、日志、错误响应、前端 bundle。
5. 预览仅白名单类型内联；SVG/HTML/XML 强制下载；文本预览上限 1 MiB。
6. 代理只允许固定上游 `http://127.0.0.1:4096`，客户端 `Authorization` 必须被覆盖；HTTP/WS 均校验 `Origin`。
7. 不修改现有 Minecraft/opencode/frpc/SSH 配置；不重启 Minecraft（除非用户明确授权并已备份）；nginx/certbot 旧入口已移除，不再作为监控项。
8. 部署、备份脚本必须幂等、可重试；失败要留下可诊断日志，不得静默吞错。
9. 世界备份/拉取/演练状态文件由 root/PC 脚本写入，应用只读；状态文件不得包含密钥或路径敏感信息。
10. Bot 凭据（平台 Token/Webhook Secret/Signing Secret）只写不读，数据库只存 AES-256-GCM 密文；
    Webhook 只以平台签名/时间戳鉴权，命令需目标 `allow_commands` + 显式 user 白名单；发布必须 TOTP 再认证；
    通知/命令输出不得包含内部路径、URL 或密钥；`BOT_ENABLED=false` 时 Webhook 返回 404。

## 6. 数据库与数据

- schema 迁移集中在 `server/src/db.ts` 的 `MIGRATIONS`，启动时按 `meta.schema_version` 顺序执行；迁移只追加，
  当前 schema v9（迁移 5：`files.origin`、唯一索引含 origin、`note_attachments`/`note_versions`/`share_items`/`metrics_samples`；
  迁移 6：删除孤儿 shares 并回填 `share_items`，不改表结构；迁移 7：新增 `bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events`；
  迁移 8：重建 Bot 表把 `bots.platform` CHECK 扩到 `qq`，`bot_targets` 增加 `quiet_start_minute`/`quiet_end_minute`，新增 `bot_ai_sessions`；
  迁移 9：`bot_targets.allow_chat`（默认 0）、`bot_ai_memories`（DB 摘要权威 + `summary_session_id`）、`bot_inbound_targets`（最近入站目标），
  Bot 凭据只存密文）。数据库 schema 高于程序支持版本时拒绝启动。
- 时间统一存 ISO 8601 UTC 字符串；展示用 `Asia/Shanghai`。
- 文件物理路径 `DATA_DIR/files/<id 前两位>/<id>`；上传先写 `DATA_DIR/tmp/` 再原子 rename。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站与笔记附件），上限 10 GiB；`fileCount` 只统计 `origin='user'`。
- `files.origin`：`user`（普通云盘）/`note`（笔记附件，不出现在列表/搜索/回收站）/`system`（保留）。
- `bots`：平台/名称/启用/公开配置 + `secret_ciphertext/secret_iv/secret_tag/key_version`；`bot_targets` 唯一 `(bot_id, external_id)`，
  `allow_commands`/`allow_notifications` 默认关闭/开启、`allow_chat` 默认关闭（与命令权限独立），静默时段 `quiet_start_minute`/`quiet_end_minute`（0–1439，成对设置）；`bot_deliveries` 队列（`dedupe_key` 唯一）、`bot_publish_jobs` 定时发布、
  `bot_events` 按 `(bot_id, platform_event_id)` 去重、`bot_ai_sessions` 按 `(bot_id,target_external_id,user_id)` 复用 AI 会话、
  `bot_ai_memories` 按 `(bot_id,user_id)` 保存滚动摘要与 `summary_session_id`（镜像 `DATA_DIR/bot-memory/memory-<uuid>.md`）、
  `bot_inbound_targets` 按 `(bot_id,target_external_id,user_id)` 记录最近入站目标/用户名/类型/时间（不存正文）。Bot Token/AppSecret 不落在日志/API 响应。
- 审计只记录元数据，不记录文件内容、密码、TOTP、Cookie、Authorization；单条 actor≤64、target≤256、detail≤4 KiB。

## 7. 完成定义（DoD）

- `npm run check` 全绿；新增逻辑有对应测试（成功 + 失败路径）。
- CI 的 coverage（`npm run test:coverage` / `npm run test:web:coverage`）、audit、secret-scan、依赖边界检查全绿。
- API 变更同步更新 `docs/API.md`；界面变更同步 `docs/UI-SPEC.md`。
- 无密钥/个人数据进入仓库；`.env` 与 `data/` 被忽略。
- 部署相关改动同步 `docs/DEPLOY.md`，并说明回滚。
- 提交信息使用 Conventional Commits（`feat:`/`fix:`/`docs:`/`test:`/`chore:`/`deploy:`）。
- 每个阶段结束给出「产出摘要 + 未决问题 + 验证证据」。

## 8. 已知环境事实（不要重复踩坑）

- Pi：`antifield@192.0.2.10` 直连；WiFi 198.51.100.10 与 PC 不通（AP 隔离）；直连 SSH 偶发超时，脚本需重试。
- Pi 上 Node 为 `/usr/local/bin/node`（v26.12.1，世界可执行；v0.5.2 安全更新，旧二进制保留 `/usr/local/bin/node.v26.11.1`）；npm 指向 `/home/antifield/.nvm`（12.2.0），部署时以 root 使用。
- opencode：`127.0.0.1:4096`，服务端 **v2.1.2**（2026-10-22 由 v2.1.1 升级；升级/回滚见 `docs/DEPLOY.md`），Basic 用户名 `opencode`，密码来自 `/etc/opencode/opencode.env` 的 `OPENCODE_PASSWORD`（应用 env 同名键必须同步；轮换后重启 opencode 与 antifieldcloud）。
- Minecraft：Paper 26.1.2，RCON `127.0.0.1:25575`，密码在 `server.properties`（v0.2.0 已轮换为 32 位随机），
  服务器语言中文，输出含 `§` 颜色码需剥离；RCON 仍监听所有接口，nftables 仅放行 loopback。
- Pi 已启用 memory cgroup（`cgroup.controllers` 含 `memory`）；`antifieldcloud-health.timer` 每 60s 写
  `/run/antifieldcloud/pi-health.json`；`age` 与 `unattended-upgrades` 已安装。
- 备份：应用归档为两阶段 pending/ack（未确认不删）；Windows 任务参数为实际 `-PiHost/-BackupRoot`，ACL 收紧；
  密钥包 Pi 端 `KEEP=2` 滚动保留，PC 不再立即删除远端密钥包。
- 世界备份：`antifieldcloud-world.timer` 每周日 12:00（显式 Asia/Shanghai，`Persistent=true`）以 root 执行 `scripts/backup-world.mjs`，
  归档到 `/var/lib/antifieldcloud/world-backups`、保留 4 份；Minecraft 世界约 4.1 GiB，周备份耗时与磁盘余量需按 1.5× 世界体积预留。
  旧的 `minecraft-backups` cron 已停用；旧约 9 GiB legacy 归档已于 v0.4.1 清理（`/home/antifield/minecraft-backups` 已删除），新归档由 PC 侧 `world` 目录保留。
- 定时策略（2026-10-21 用户确认）：仅项目世界备份 timer 统一到周日 12:00；健康探针保持 60s；系统维护 timer（apt/logrotate/fstrim 等）保持发行版默认，不再做“全部定时任务统一”调整。
- 备份/灾备状态文件由脚本写入、应用只读：`/var/lib/antifieldcloud/world-backup-status.json`、
  `world-pull-status.json`、`drill-status.json`（0644）；Dashboard/Settings 与告警读取。
- systemd 加固：`antifieldcloud.service` 已加 `CapabilityBoundingSet=`（空）、`RestrictAddressFamilies`、
  `PrivateDevices`、`ProtectClock/Hostname/KernelLogs`、`RestrictSUIDSGID/Realtime` 等；`antifieldcloud-world.service`
  同样加固并有 `flock`、4h 超时。
- nftables：默认拒绝入站；22 仅 `169.254.77.0/24` + `172.23.88.0/21` 且新建连接限速 20/min；
  25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`。**改 22 网段前先确认当前 SSH 来源在允许集合内**。
- SSH 仅公钥：`/etc/ssh/sshd_config.d/00-` drop-in 先于其它配置生效（禁用密码/键盘交互，保留公钥）；旧配置备份保留 **24h 回滚窗口**，
  回滚见 `docs/DEPLOY.md` §9.7；`fail2ban` 已安装并启用 `sshd` jail（nftables 后端，24h ban），dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；
  `deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后以 `systemd-run --collect --on-active=3` 异步重启 fail2ban 恢复封禁 set。
  **手工 `systemctl reload nftables` 不触发该 drop-in，仍需 `systemctl restart fail2ban`**。
- Bot 环境变量：`BOT_ENABLED`（默认 **false**）、`BOT_SECRET_KEY`（32 字节 base64，`bootstrap-env.sh` 仅在缺失时生成，`--force` 复用旧值）；
  `BOT_WEBHOOK_MAX_BODY_BYTES=262144`、`BOT_DELIVERY_INTERVAL_SECONDS=30`、`BOT_DELIVERY_MAX_ATTEMPTS=5`、`BOT_EVENT_RETENTION_DAYS=7`、
  `BOT_COMMAND_RATE_PER_MINUTE=20`、`BOT_PUBLISH_MAX_MEDIA_BYTES=10485760`（单文件）、`BOT_PUBLISH_MAX_SCHEDULED_DAYS=30`、`BOT_MAX_BOTS=10`。
  v0.5.1 新增 AI（OpenCode 本地 API，默认关闭）：`BOT_AI_ENABLED=false`、`BOT_AI_PROVIDER=`、`BOT_AI_MODEL=`、`BOT_AI_TIMEOUT_SECONDS=60`、
  `BOT_AI_MAX_PROMPT_CHARS=2000`、`BOT_AI_RATE_PER_HOUR=10`、`BOT_AI_SESSION_RETENTION_DAYS=7`；`bootstrap-env.sh` 已纳管这 7 项。
  v0.5.2 新增：`BOT_CHAT_RATE_PER_MINUTE=6`（Chat 每 Bot×用户每分钟）、`BOT_AI_MEMORY_MAX_CHARS=4096`（记忆摘要上限 512–16384）、
  `BOT_AI_SYSTEM_PROMPT=`（空则使用内置提示，最长 2000）、`BOT_DISCORD_GATEWAY_ENABLED=false`（Discord Gateway 默认关闭）、
  `BOT_PUBLISH_MAX_MEDIA_FILES=5`（默认 5；UI 与 Telegram/Discord 适配器按 5 控制）、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`（总媒体上限）；`bootstrap-env.sh` 已纳管这 6 项。
  v0.5.3 新增：`BOT_CONNECTIVITY_ENABLED=true`、`BOT_CONNECTIVITY_INTERVAL_SECONDS=60`、`BOT_CONNECTIVITY_TIMEOUT_SECONDS=8`、
  `BOT_PROXY_URL=`（空则复用 `HTTPS_PROXY`/`HTTP_PROXY`）；`bootstrap-env.sh` 已纳管这 4 项。
  `BOT_SECRET_KEY` 与 DB 必须一起备份；丢失后已存 Token/AppSecret 只能重新录入。
- Bot 公开入口：`POST /api/bot/webhook/:botId`（无 session/CSRF，按平台签名鉴权）；Cloudflare Access 必须对
  `/api/bot/webhook/*`、`/healthz`、`/s/*`、`/api/public/shares/*` 做 bypass，否则平台回调/健康检查/公开分享会被边缘拦截。
  `BOT_ENABLED=false` 时该路径返回 404。
- Bot 平台注册（BotFather/Developer Portal/Slack App、QQ 开放平台、Webhook URL、斜杠命令）与 Cloudflare Access 策略均由用户在各自后台完成，Agent 不代替；
  v0.5.1 生产已配置 Discord + QQ 官方 Bot、OpenCode `/ask` 真实模型（`opencode-go/deepseek-v4.1-flash`）并已验证命令回复；Cloudflare Access 主应用 + 4 个 bypass + service token 已配置并通过带 token 的 smoke。
  v0.5.2 已部署 v0.5.2/schema v9；生产已开启 `BOT_DISCORD_GATEWAY_ENABLED=true` 并记录 Gateway `connected`，QQ C2C、Discord #general 与 Discord DM 普通消息 Chat 已由用户实发确认收到 AI 回复；其他目标默认关闭。Discord 需 Developer Portal 开启 Message Content Intent，Telegram 群需关闭 privacy mode 或回复 Bot，QQ 群/频道需先 @Bot 触发后从“最近入站目标”登记。
- 测试证据边界：Bot 适配器（含 QQ）、Chat/记忆、AI 对话、多附件、按钮、Discord Gateway（假 WebSocket）、备份 tar、告警投递等以进程内 mock/夹具为主（mock-only），
  未做真实平台/真实模型/真实网络的负路径验收；发布前按 `docs/DEPLOY.md` §3.1/§9.8 做手工平台联调。
- Windows 世界拉取（`scripts/world-pull.ps1`，周度）与恢复演练（`scripts/drill.ps1`）计划任务由用户手动安装；
  `install-backup-task.ps1` 只安装每日应用归档拉取任务。
- Cloudflare：zone `example.com`；tunnel 名称 `pi`；`mc.example.com` CNAME 到 SakuraFRP，**不要改**；
  `app/ai` 的 DNS 由用户手动添加；Access 主应用 + 4 个 bypass + service token 已在生产配置（见 `docs/DEPLOY.md` §5.2），
  service token 只保存在 gitignored 的 `.local/cf-access.env`；严格 CSP 会拦截 Web Analytics/Challenge 注入，需后台关闭自动注入或接受报错。
- 旧项目 PiForge 的残留（sudoers 注释、禁用的计划任务）保持原样，不继承、不清理。
- 公开仓库中的域名/IP/备份路径均为示例值；本机实际部署信息见 `.local/DEPLOYMENT.md`（gitignored，不提交）。

## 9. 用户手动步骤（Agent 不得代替）

1. Cloudflare 后台添加 `app`/`ai` CNAME（已由用户完成）。
2. 交互式运行 provisioning，设置密码、扫描 TOTP、保存恢复码。
3. 安装/重装 Windows 每日应用归档计划任务（`install-backup-task.ps1`，需管理员 PowerShell）；
   v0.5.2 更新仓库后必须重装一次，刷新复制的 `backup-pull.ps1`、脚本 SHA 与安装标记。
4. 离线保存 age 私钥；把 `ALERT_WEBHOOK_URL` 写入 env 后重启应用。
5. 手动安装 Windows 周度世界拉取任务（调用 `scripts/world-pull.ps1`，`-PiHost/-BackupRoot`）与恢复演练任务/手跑
   （`scripts/drill.ps1 -ExpectedSchemaVersion 9`，建议季度或升级前）；确认直连网线可通。
6. 应用新 nftables 规则前，确认当前 SSH 来源在 `169.254.77.0/24` 或 `172.23.88.0/21` 内（否则会锁死）；
   保留物理键鼠/已建立 SSH 作为回滚通道。
7. 旧 `minecraft-backups` cron 已停用、legacy 归档已清理；如后续手工重建 cron 或旧目录，按 `docs/DEPLOY.md` 处理并再次确认迁移。
8. 最终公网/手机/PWA 验收；完成正式恢复演练并记录到 `docs/BACKUP.md` §7 与 `docs/ACCEPTANCE.md`。
9. Cloudflare Access：已通过 API 配置主应用（One-time PIN + Owner allow + Service Auth）与 4 个 bypass（`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`）；service token 存放在 PC `.local/cf-access.env`（gitignored）。后续轮换 service token 后同步该文件，并用 `smoke.ps1 -AccessClientId/-AccessClientSecret` 重跑；配置用高权限 API Token 完成后应 Revoke。
10. Bot 平台后台注册：BotFather 设置 Telegram Webhook（含 `secret_token`）、Discord Interactions Endpoint、
    Slack Event Subscriptions/Slash Commands、QQ 开放平台回调地址与事件订阅；然后在 `/bots` 录入 Token/签名密钥/AppSecret、
    登记目标、开启 `BOT_ENABLED=true` 并重启。QQ 回调需先让应用可达并处理 `op=13` 校验；`/ask` 另需在部署后配置
    `BOT_AI_ENABLED=true`（可选 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`）并验证真实模型回复。
    v0.5.2 若要启用普通消息 Chat：Discord 需在 Developer Portal 开启 **Message Content Intent** 并设 `BOT_DISCORD_GATEWAY_ENABLED=true`；
    Telegram 群需关闭 BotFather privacy mode 或让用户回复 Bot；QQ 群/频道需先把 Bot 拉入群并 @Bot 发一条消息，再到 `/bots` 目标分区
    从“最近入站目标”登记；最后给目标勾选 `allow_chat`。Chat 不授予斜杠命令权限，多附件发布仍受 5 个/10 MiB/50 MiB 限制。
11. 安装 Windows Bot 代理隧道任务（`.\scripts\install-tunnel-task.ps1`，当前用户权限）：登录启动、异常重启，先探测 PC 代理 10090；日志 `%LOCALAPPDATA%\AntifieldCloud\discord-tunnel.log`。移除用 `-Remove`。
12. SSH 仅公钥切换后保留 **24h 回滚窗口**：期间保留旧 drop-in 备份与一个已建立的 SSH 会话；确认新会话/自动化脚本
    （smoke、备份、世界拉取）均能公钥登录后，再按 `docs/DEPLOY.md` §9.7 结束回滚窗口。
