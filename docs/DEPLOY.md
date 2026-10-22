# 部署手册（Raspberry Pi 5 / Debian 13，v0.5.2）

> 所有 Agent 会话与人工操作都按本文件执行；涉及系统状态的操作要逐条确认。
> 目标运行位置：`/opt/antifieldcloud/current`，服务用户 `antifieldcloud`，监听 `127.0.0.1:3000`。
> 公开仓库中的域名/IP/路径均为示例值；**实际部署值只记录在 `.local/DEPLOYMENT.md`（gitignored）**。

## 0. 拓扑与前置

- Pi：`antifield@192.0.2.10`（直连网线，实际网段 `169.254.77.0/24`），WiFi 示例 `198.51.100.10`（校园网实际 `172.23.88.0/21`）。
- 域名：`app.example.com`（应用）、`ai.example.com`（opencode 反代），Cloudflare Tunnel 名称为 `pi`（UUID 见 `.local`）。
- 现有服务不改：Minecraft、SakuraFRP、opencode、RDP/桌面；nginx/certbot 旧入口已移除。
- 本仓库从 Windows PC 通过 SSH 部署；PC 需有 `C:\Users\<user>\.ssh\id_ed25519`。
- 非敏感部署值（域名/路径/公网 MC 地址）写入 Pi 的 `/etc/antifieldcloud/deploy.conf`（root 只读，不提交仓库），
  由 `bootstrap-env.sh` 读取；密钥只来自现有服务配置或离线保管。
- 当前 schema v9（迁移 5 结构、迁移 6 孤儿 shares 数据修复、迁移 7 新增 Bot 表、迁移 8 重建 Bot 表扩展 QQ/静默/AI 会话、
  迁移 9 增加 `bot_targets.allow_chat`/`bot_ai_memories`/`bot_inbound_targets`）；迁移前会执行 `PRAGMA foreign_key_check`，
  其它外键损坏会拒绝启动；数据库 schema 高于程序支持版本时拒绝启动。部署脚本切换前会自动做迁移前 DB 快照，回滚必须使用该快照。
- 生产现状：v0.5.2/schema v9（release `20261021T114908Z`，commit `abeabc7`，迁移前快照 `db-predeploy-20261021T114936153Z.sqlite`；带 Access token 的 smoke 24/24）。QQ 回调、AI 真实模型与 Cloudflare Access 已在 v0.5.1 配置并验收；生产 `BOT_DISCORD_GATEWAY_ENABLED=true` 且 Gateway 已连接，Discord DM、Discord #general @Bot、QQ C2C 普通消息 Chat 已实发确认，多附件/按钮真实联调待补充。
- Bot 默认关闭：`BOT_ENABLED=false` 且无 `BOT_SECRET_KEY` 时应用正常运行，只是 `/api/bot/webhook/*` 返回 404、`/api/bots*` 写接口 503；
  启用顺序见 §3.1，Cloudflare Access bypass 见 §5.2。

## 1. 首次系统初始化（重装时执行）

```bash
sudo apt-get update
sudo apt-get install -y nftables age

# 服务账号（无登录 shell、无 sudo）
sudo addgroup --system antifieldcloud
sudo adduser --system --ingroup antifieldcloud --home /var/lib/antifieldcloud \
  --shell /usr/sbin/nologin --no-create-home antifieldcloud

# 数据目录
sudo install -d -o antifieldcloud -g antifield -m 0750 /var/lib/antifieldcloud
sudo install -d -o antifieldcloud -g antifieldcloud -m 0700 /var/lib/antifieldcloud/files /var/lib/antifieldcloud/tmp
sudo install -d -o antifieldcloud -g antifield -m 2770 /var/lib/antifieldcloud/backups
sudo install -d -o root -g root -m 0755 /opt/antifieldcloud/releases /etc/antifieldcloud

# 防火墙（仓库 deploy/nftables.conf；实际网段按 .local 修改后再安装）
# ！先确认当前 SSH 来源在允许网段内，否则加载后会锁死 SSH。
sudo cp -a /etc/nftables.conf /etc/nftables.conf.bak 2>/dev/null || true
sudo nft -c -f deploy/nftables.conf
sudo install -m 0644 deploy/nftables.conf /etc/nftables.conf
sudo nft -f /etc/nftables.conf
sudo systemctl enable --now nftables

# systemd 单元（应用 + 健康探针；世界备份 unit 见 §9.2）
sudo install -m 0644 deploy/antifieldcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
```

nftables 默认策略与网段（详见 §9）：默认 drop 入站；22 仅 `169.254.77.0/24` + `172.23.88.0/21` 且新建连接限速 20/min；
25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`；80 不再放行。

## 2. 非敏感部署值与环境文件

```bash
# 只写非敏感值，不写任何密钥；实际域名/路径按 .local/DEPLOYMENT.md 填写
sudo install -o root -g root -m 0640 /dev/stdin /etc/antifieldcloud/deploy.conf <<'EOF'
APP_ORIGIN=https://app.example.com
AI_ORIGIN=https://ai.example.com
COOKIE_DOMAIN=.example.com
MC_PUBLIC_ADDRESS=mc.example.com:11798
DATA_DIR=/var/lib/antifieldcloud
WEB_DIST_DIR=/opt/antifieldcloud/current/web/dist
ADMIN_USERNAME=antifield
EOF
```

先部署一次代码（第 3 节，服务可先不启动），再生成环境文件：

```bash
cd /opt/antifieldcloud/current
sudo bash scripts/bootstrap-env.sh                  # 首次
sudo bash scripts/bootstrap-env.sh --dry-run        # 查看解析结果（不写文件、不显示密码）
sudo bash scripts/bootstrap-env.sh --force          # 轮换/重建（非敏感配置优先沿用旧 env/deploy.conf）
sudo ls -l /etc/antifieldcloud/env                  # 应为 -rw-r----- root antifieldcloud
```

- `bootstrap-env.sh` 从 `~/minecraft-server/server.properties` 读 RCON 密码、从 `/etc/opencode/opencode.env`
  读 `OPENCODE_PASSWORD`，写入 `/etc/antifieldcloud/env`，不回显密钥。
- 解析顺序：命令行参数 > 现有 env > `/etc/antifieldcloud/deploy.conf` > 示例默认值；`--force` **不会**把真实域名重置为
  `example.com`。若仍使用占位域名，脚本会打印警告。
- 可选参数：`--app-origin= --ai-origin= --cookie-domain= --mc-public-address= --data-dir= --web-dist-dir= --admin-username=`。
- `APP_VERSION` 由 `bootstrap-env.sh` 从当前 release 的 `package.json` 读取（读不到直接失败，不再回退历史版本号）；
  `deploy.ps1` 切换前也会注入并校验 `/healthz.version`。
- v0.3 可选 env（写入 `/etc/antifieldcloud/env`，按需）：
  - `BACKUP_RESTORE_ENABLED=true`：启用 Web 备份列表/导入/文件级恢复；默认 false 时恢复计划/执行返回 403。
  - `BACKUP_IMPORT_MAX_BYTES=104857600`：Web 归档导入上限，实际还受 `MAX_UPLOAD_BYTES` 限制。
  - `OPENCODE_HTML_MODE=shim|attributes|passthrough`：默认 `shim`；Cloudflare 关闭注入并验证后可切 `passthrough`。
  - `CHUNKED_UPLOAD_ENABLED=true`：启用 5 GiB 分片上传（默认 true）。
  - `CHUNK_SIZE_BYTES=8388608`：块大小，1–100 MiB；Cloudflare 代理下建议 8 MiB。
  - `CHUNK_MAX_FILE_BYTES=5368709120`：单文件上限，默认 5 GiB，不得超过配额。
  - `CHUNK_SESSION_TTL_HOURS=24`、`CHUNK_MAX_CONCURRENT_SESSIONS=3`：会话过期与每用户并发上限。
- v0.4.0 新增 env（默认值见 `deploy/env.example`；升级后可用 `sudo bash scripts/bootstrap-env.sh --dry-run` 预览，
  再运行 `--force` 追加缺失键，非敏感值会沿用现有 env/deploy.conf，不会重置真实域名）：
  - `BACKUP_PREPARE_TIMEOUT_SEC=3300`：Web/CLI 生成归档超时，与 PC 侧 55 分钟对齐。
  - `WORLD_BACKUP_STATUS_FILE`、`WORLD_PULL_STATUS_FILE`、`DRILL_STATUS_FILE`：默认
    `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`，应用只读。
  - `ALERT_WORLD_BACKUP_MAX_AGE_HOURS=192`、`ALERT_DRILL_MAX_AGE_DAYS=35`：世界备份/拉取与演练超期阈值。
  - `NOTE_ATTACHMENT_MAX_BYTES=26214400`、`NOTE_MAX_ATTACHMENTS=100`、`NOTE_VERSIONS_KEEP=20`：笔记附件与版本限制。
  - `SHARE_MAX_ITEMS=50`：单个分享最多文件数。
  - `METRICS_ENABLED=true`、`METRICS_SAMPLE_SECONDS=60`、`METRICS_RETENTION_DAYS=30`：指标采样与保留。
- v0.5.0 新增 Bot env（默认值见 `deploy/env.example`；`bootstrap-env.sh` 会在缺失时生成 `BOT_SECRET_KEY`）：
  - `BOT_ENABLED=false`：总开关；**默认关闭**，完成平台联调后再显式改为 true 并重启。
  - `BOT_SECRET_KEY`：32 字节 base64（`openssl rand -base64 32` 等价），AES-256-GCM 加密平台 Token；必须与 DB 一起备份，
    丢失后已存 Token 只能重新录入。`bootstrap-env.sh --force` 复用旧值，**不要手工替换**。
  - `BOT_WEBHOOK_MAX_BODY_BYTES=262144`：Webhook 原始 body 上限（16 KiB–1 MiB）。
  - `BOT_DELIVERY_INTERVAL_SECONDS=30`（5–300）、`BOT_DELIVERY_MAX_ATTEMPTS=5`（1–20）：队列扫描与最大尝试次数。
  - `BOT_EVENT_RETENTION_DAYS=7`（1–90）：事件去重记录保留；已发送投递/发布固定 30 天清理。
  - `BOT_COMMAND_RATE_PER_MINUTE=20`（1–600）：每 Bot × 用户命令限流。
  - `BOT_PUBLISH_MAX_MEDIA_BYTES=10485760`（1–50 MiB）：单个发布媒体上限；单次数量/总量见 v0.5.2 的 `BOT_PUBLISH_MAX_MEDIA_FILES`/`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES`。
  - `BOT_PUBLISH_MAX_SCHEDULED_DAYS=30`（1–365）、`BOT_MAX_BOTS=10`（1–50）。
- v0.5.1 新增 Bot AI env（`bootstrap-env.sh` 已纳管，`--force` 不会重置已有非空值；默认关闭）：
  - `BOT_AI_ENABLED=false`：`/ask` 总开关；关闭时命令只返回“AI 对话未启用”。
  - `BOT_AI_PROVIDER=`、`BOT_AI_MODEL=`：可选 OpenCode provider/model，二者同时设置才指定模型；为空用 OpenCode 默认模型。
  - `BOT_AI_TIMEOUT_SECONDS=60`（10–180）：单次 AI 请求/等待超时。
  - `BOT_AI_MAX_PROMPT_CHARS=2000`（100–8000）：提示词截断。
  - `BOT_AI_RATE_PER_HOUR=10`（1–120）：每 Bot×用户每小时调用上限（v0.5.2 起 Chat 与 `/ask` 共用）。
  - `BOT_AI_SESSION_RETENTION_DAYS=7`（1–90）：`bot_ai_sessions` 映射保留，不删除 OpenCode 远端会话。
- v0.5.2 新增 Bot Chat/记忆/多附件/Gateway env（`bootstrap-env.sh` 已纳管，`--force` 不会重置已有非空值）：
  - `BOT_CHAT_RATE_PER_MINUTE=6`（1–60）：普通消息 Chat 每 Bot×用户每分钟上限；与 `/ask` 共用 `BOT_AI_RATE_PER_HOUR`。
  - `BOT_AI_MEMORY_MAX_CHARS=4096`（512–16384）：每 Bot×用户长期记忆摘要上限。
  - `BOT_AI_SYSTEM_PROMPT=`（空）：覆盖内置系统提示，最长 2000；空则使用内置文本。
  - `BOT_DISCORD_GATEWAY_ENABLED=false`：Discord Gateway 长连接开关；默认关闭，启用前先在 Developer Portal 开启 Message Content Intent。
  - `BOT_PUBLISH_MAX_MEDIA_FILES=5`：单次发布媒体文件数量上限（默认 5；UI 与 Telegram/Discord 适配器按 5 控制）。
  - `BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`（1–200 MiB）：单次发布媒体总大小上限。

## 3. 从 PC 部署（带迁移前 DB 快照与自动回滚）

```powershell
cd "$env:USERPROFILE\projects\AntifieldCloud"
npm run check
.\scripts\deploy.ps1 -PiHost 192.0.2.10   # 替换为 Pi 实际直连地址
```

`deploy.ps1` 流程：运行检查 → Vite 构建 → 打包（含 LICENSE/CHANGELOG/docs）→ 远程预检（Node≥26、npm、磁盘 ≥2 GiB + 包体、
systemd 已启用）→ 上传并校验 tar SHA-256 → 解包到 `/opt/antifieldcloud/releases/<UTC>` → 校验远端 `package.json` 版本
→ `npm ci --omit=dev --ignore-scripts` → **迁移前 `backup.mjs --snapshot-db`**（失败则中止，不切换）
→ 注入 `APP_VERSION` 到 `/etc/antifieldcloud/env` → 切换 `current` → `systemctl restart` → 健康检查断言 `/healthz.version`。

- v0.5.0 起脚本默认拒绝脏工作树（`git status --porcelain` 非空即中止），确需临时发布时显式加 `-AllowDirty` 并在验收记录中标注。
- 健康检查失败时脚本先 `systemctl stop`、还原迁移前 DB 快照、**把 `APP_VERSION` 改回上一 release 的版本**、`ln -sfn` 回上一 release、
  `systemctl start` 并复检；读不到上一 release 版本或没有迁移前快照时**拒绝自动回滚**并打印手工步骤（schema 只向上、无 down）。
  回滚成功才清理坏 release，失败则保留现场并输出 journalctl 日志与 DB 快照路径。首次部署无回滚目标时保留新 release 便于排查。
- 部署成功后脚本自动运行只读 smoke 子集：`smoke.ps1 -SkipPublic -SkipLocalBackup -ExpectedVersion <版本>`；
  **v0.5.0 起 smoke 失败默认让部署脚本失败**（发布门禁），确需只告警时用 `-AllowSmokeFailure`；两种情况都不会自动回滚已完成的部署。
- **首次部署**（`/etc/antifieldcloud/env` 尚不存在）：脚本只上传/安装并切换 current，跳过 DB 快照、重启与健康检查；
  按第 2 节生成 env 后再 `sudo systemctl enable --now antifieldcloud`。
- 失败清理：切换前失败会删除不完整 release 与 `/tmp` 临时包；本地 tar 总在 finally 清理。
- release 保留 3 个，且清理时永不删除 `current` 与本次 `previous`。
- 手工等价步骤（仅在脚本不可用时）：解包 → `npm ci --omit=dev --ignore-scripts` → 先跑
  `node scripts/backup.mjs --snapshot-db` → 写入/校验 `APP_VERSION` → `ln -sfn` → `systemctl restart antifieldcloud` → `curl /healthz`。

### 3.1 v0.5.2 应用部署步骤（版本升级时执行）

顺序固定为：**先备份/校验 → 环境预检 → 部署（自动迁移前快照 + 迁移 v9）→ 生成/校验 `BOT_SECRET_KEY` 与 `BOT_*` → Bot 保持默认关闭 → 显式启用（先 Bot，后 AI/Chat/Gateway）**。
迁移 9 为加列/建表（`bot_targets.allow_chat`、`bot_ai_memories`、`bot_inbound_targets`），不重建既有 Bot 表，但仍必须先确认迁移前 DB 快照成功；
在这些步骤完成前不要打开 `BOT_ENABLED`/`BOT_AI_ENABLED`/`BOT_DISCORD_GATEWAY_ENABLED`，也不要配置平台 Webhook。

1. **本地与发布前校验**（PC）：
   - `npm run check`、`npm run build`；确认 `package.json` 版本 `0.5.2`，`node scripts/check-version.mjs` 通过（含 env.example/DEPLOY 标题/lock 根版本）。
   - 本地已知基线：`npm test` 293（服务端 277 + 脚本 16）、`npm run test:web` 140（28 文件）；`npm run check` 已通过（2026-10-21）。
   - 确认工作树干净；`git rev-parse --short HEAD` 记入发布记录（脏发布只允许 `-AllowDirty`，并在 `docs/ACCEPTANCE.md` 标注）。
   - 记录当前 `APP_VERSION` 与 `/healthz.version`（生产应为 0.5.1/schema 8），便于回滚对照。
2. **备份与校验**（Pi，只读优先）：
   - `sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs --pending`：确认无异常 pending/孤儿；
     如 pending 未拉取，先在 PC 跑一次 `backup-pull.ps1` 完成 ack。
   - 确认 PC 最新应用归档 `.sha256` 可校验、密钥包 `secretsOk=true`（含 `/etc/antifieldcloud/env`）、世界备份/拉取状态新鲜；
     必要时手跑 `.\scripts\drill.ps1 -ExpectedSchemaVersion 8`（升级前基线）并保存报告。
   - 记录磁盘余量：`df -hT /`；迁移 9 为加列/建表，建议 ≥2 GiB；迁移前确认 `db.sqlite` 与快照可读。
3. **部署（自动快照 + 迁移 v9）**：
   - `.\scripts\deploy.ps1 -PiHost <直连 IP>`；脚本完成迁移前 DB 快照（`db-predeploy-*.sqlite`）、APP_VERSION 注入、切换与健康检查。
   - 健康检查通过后应用启动时执行迁移 9：`bot_targets` 增加 `allow_chat`（默认 0）、创建 `bot_ai_memories` 与 `bot_inbound_targets`；
     迁移 5–8 保留，既有 Bot 数据不重建。
   - Bot 因 `BOT_ENABLED=false` 不启动队列，Webhook 返回 404；`/ask`/Chat 因 `BOT_AI_ENABLED=false` 不可用；Gateway 因 `BOT_DISCORD_GATEWAY_ENABLED=false` 不建连。
4. **生成/校验 Bot env**：
   ```bash
   sudo bash /opt/antifieldcloud/current/scripts/bootstrap-env.sh --dry-run   # 预览，不回显密钥
   sudo bash /opt/antifieldcloud/current/scripts/bootstrap-env.sh --force     # 缺失时生成；已有则复用
   sudo grep -c '^BOT_SECRET_KEY=' /etc/antifieldcloud/env                    # 1
   sudo grep -c '^BOT_ENABLED=false' /etc/antifieldcloud/env                  # 1（保持关闭）
   sudo grep -c '^BOT_AI_ENABLED=false' /etc/antifieldcloud/env               # 1（保持关闭）
   sudo grep -c '^BOT_AI_RATE_PER_HOUR=' /etc/antifieldcloud/env              # 1
   sudo grep -c '^BOT_CHAT_RATE_PER_MINUTE=' /etc/antifieldcloud/env          # 1
   sudo grep -c '^BOT_AI_MEMORY_MAX_CHARS=' /etc/antifieldcloud/env           # 1
   sudo grep -c '^BOT_DISCORD_GATEWAY_ENABLED=false' /etc/antifieldcloud/env  # 1（保持关闭）
   sudo grep -c '^BOT_PUBLISH_MAX_MEDIA_FILES=' /etc/antifieldcloud/env       # 1
   sudo grep -c '^BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=' /etc/antifieldcloud/env # 1
   sudo systemctl restart antifieldcloud
   ```
   - 校验 `stat -c '%a %U %G' /etc/antifieldcloud/env` 为 `640 root antifieldcloud`；不要把密钥值打印到终端/日志。
   - 立即把 env 纳入下一次密钥包（`scripts/backup-secrets.sh`）并确认 PC 拉取成功；`BOT_SECRET_KEY` 丢失 = 所有已存 Token/AppSecret 需重录。
5. **验证迁移与关闭态**：
   ```bash
   curl -fsS http://127.0.0.1:3000/healthz                       # {"ok":true,"version":"0.5.2","schemaVersion":9,...}
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/bot/webhook/x   # 404
   sudo -u antifieldcloud /usr/local/bin/node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/antifieldcloud/db.sqlite');console.log(db.prepare(\"select value from meta where key='schema_version'\").get(),db.prepare(\"select name from sqlite_master where type='table' and name like 'bot%'\").all(),db.prepare('PRAGMA table_info(bot_targets)').all().map(c=>c.name).filter(n=>n.startsWith('allow_')||n.startsWith('quiet_')))"
   ```
   期望 `schemaVersion=9`、8 张 `bot*` 表（含 `bot_ai_memories`/`bot_inbound_targets`）、`bot_targets` 含 `allow_chat` 与两个 `quiet_*` 列；
   `/api/bots` 未登录 401；登录后 `/api/version` 的 `botsEnabled=false`、`botPlatforms` 含 `qq`。
6. **显式启用 Bot（平台联调后）**：
   - 先在 Cloudflare 配置 Access 与 bypass（§5.2），再在平台后台登记 Webhook/命令（§9.8）；QQ 需先完成 op=13 回调校验。
   - 在 `/bots` 新建 Bot（默认 `enabled=false`）、录入 Token/AppSecret/签名密钥、加目标（可设静默时段）并勾选 `allow_commands`/`allow_notifications`；
     仅给可信 user 目标勾选 `allow_commands`。
   - 将 `/etc/antifieldcloud/env` 的 `BOT_ENABLED=false` 改为 `true`（或在 `deploy.conf` 覆盖后 `bootstrap-env.sh --force`），
     `sudo systemctl restart antifieldcloud`；验证 `/api/bots/status` 的 `enabled/keyConfigured=true`、Webhook 返回 200/401（不再 404）。
7. **启用 AI、Chat 与 Gateway（可选，Bot 稳定后）**：
   - 确认 OpenCode `127.0.0.1:4096` 可达、应用 env 的 `OPENCODE_PASSWORD` 与 `/etc/opencode/opencode.env` 一致。
   - 设 `BOT_AI_ENABLED=true`；如需固定模型再设 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`（两者同时设置），重启应用。
   - 由管理员在白名单私聊发 `/ask 今天状态如何`，确认有文本回复、限流与审计 `bot.ai.ask`；真实模型质量与超时按实际记录，
     若 OpenCode 拒绝 `permissions`，日志会出现“未隔离”警告，需在验收中注明。
   - Chat：给目标勾选 `allow_chat`；Telegram 群关闭 privacy mode 或让用户回复 Bot；QQ 群/频道先 @Bot 后从“最近入站目标”登记；
     私聊/群 @Bot 发普通消息确认 AI 回复、`bot.chat`/`bot.ai.chat` 审计与限流。
   - 记忆：多轮对话后检查 `bot_ai_memories.summary` 与 `DATA_DIR/bot-memory/memory-<uuid>.md` 存在（不打印内容），确认目录 0700/文件 0600；
     摘要失败时旧摘要保留。
   - Discord Gateway：Developer Portal 开启 **Message Content Intent**，设 `BOT_DISCORD_GATEWAY_ENABLED=true` 并重启；
     确认 `/api/bots/:id` 的 `gateway.state` 从 `connecting` 变为 `connected`，私聊/@/回复进入 Chat，普通频道消息不消费。
8. **部署后**：
   - `.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9`；配置 Cloudflare Access 后可加
     `-AccessClientId/-AccessClientSecret`（service token，不写入仓库/日志）。公网/手机/PWA 与 Bot 平台联调按 `docs/ACCEPTANCE.md` 记录。
   - PC 重装每日任务：`.\scripts\install-backup-task.ps1 -PiHost <直连 IP> -BackupRoot <目录>`，确认 `backup-task.json` 脚本 SHA 更新；
     手跑一次确认 `secrets=ok`（含 `BOT_*`）。
   - 世界拉取/演练：任务参数不变；演练改用 `-ExpectedSchemaVersion 9`。
   - 按 `docs/ACCEPTANCE.md` v0.5.2 填写部署/测试证据（不要提前声明通过）。

**回滚**：`deploy.ps1` 自动回滚会 stop → 还原迁移前 DB 快照 → 把 `APP_VERSION` 改回上一 release 版本 → 切回 previous → start → 健康检查；
手工顺序见 §11。**不要用未还原 `APP_VERSION` 的旧 release 通过 `/healthz` 判断成功**。v9 高于旧代码支持版本，不能只回退代码；回滚前保留
`db-predeploy-*.sqlite` 与当前 `bots`/`bot_ai_sessions`/`bot_ai_memories`/`bot_inbound_targets` 数据；`BOT_SECRET_KEY` 不要轮换（轮换等于重录全部 Token/AppSecret）。
回滚窗口内 `BOT_ENABLED`/`BOT_AI_ENABLED`/`BOT_DISCORD_GATEWAY_ENABLED` 保持 false。fail2ban 的 nftables drop-in 与业务版本无关，回滚应用时无需删除；如需回滚该安全项见 §9.7。

### 3.2 OpenCode v2.1.1 升级与兼容性复核（本机执行）

当前生产 OpenCode 为 v2.1.1（2026-10-20 由 v2.0.32 升级）。升级/回滚步骤：

```bash
# 1) 备份（root）：二进制、数据、env、unit
TS=$(date -u +%Y%m%dT%H%M%SZ); BK=/var/backups/opencode
sudo install -d -o root -g root -m 0700 "$BK"
sudo tar -C /var/lib/opencode -czf "$BK/opencode-bin-$TS.tar.gz" .opencode/bin/opencode
sudo tar -C /var/lib/opencode --exclude='.opencode/bin' -czf "$BK/opencode-data-$TS.tar.gz" .
sudo cp -a /etc/opencode/opencode.env "$BK/opencode.env.$TS"
sudo cp -a /etc/systemd/system/opencode.service "$BK/opencode.service.$TS"

# 2) 升级（opencode 用户；curl 安装器）
sudo -u opencode env HOME=/var/lib/opencode \
  /var/lib/opencode/.opencode/bin/opencode upgrade --method curl

# 3) 重启并验证
sudo systemctl restart opencode
sudo -u opencode /var/lib/opencode/.opencode/bin/opencode --version
# Basic API / 代理兼容（密码从 env 读取，不打印）
PASS=$(sudo grep '^OPENCODE_PASSWORD=' /etc/opencode/opencode.env | cut -d= -f2-)
curl -sS -o /dev/null -w '%{http_code}\n' -u "opencode:$PASS" http://127.0.0.1:4096/api/session
curl -sS -o /dev/null -w '%{http_code}\n' -u "opencode:$PASS" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4096/api/session      # 垫片新建会话路径；会创建测试 session，可 DELETE /api/session/<id> 清理
curl -sS -o /dev/null -w '%{http_code}\n' https://app.<域名>/healthz
```

兼容性判据：`/api/session` 200 且 `data` 为数组；`POST /api/session` 返回 `data.id`；upstream HTML 可被
`injectOpenCodeShim` 注入（`__af/oc-help.js` + `data-cfasync`）；前端 bundle 仍含“新建会话/New session”标记；
公开 `ai.<域名>` 未登录 401/302；应用 healthz 200。任一不满足先保持 `OPENCODE_HTML_MODE=shim` 并回滚 OpenCode。

回滚：`sudo systemctl stop opencode` → 用备份的 `.opencode/bin/opencode` 覆盖 → 恢复 data tar（如需）→
`sudo systemctl start opencode` → 按上面判据复验；应用侧无需回滚。OpenCode 原生按钮/WS 实时事件仍建议用户浏览器复测。

### 3.3 Node.js 运行时安全更新（v26.12.1）

生产应用使用 `/usr/local/bin/node`（systemd `ExecStart`）；npm/npx 仍指向 nvm（仅构建/部署工具）。
2026-10-22 按 Node.js 安全补丁把运行时从 v26.11.1 更新到 **v26.12.1**（linux-arm64），未改动应用版本/schema。

```bash
# 1) 下载并校验官方 arm64 包（在 PC 或 Pi 执行）
curl -fsSLO https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-arm64.tar.xz
curl -fsSLO https://nodejs.org/dist/v26.12.1/SHASUMS256.txt
sha256sum -c <(grep ' node-v26.12.1-linux-arm64.tar.xz$' SHASUMS256.txt)
# 期望 sha256=42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb

# 2) 安装到版本化目录，保留旧二进制用于回滚
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf node-v26.12.1-linux-arm64.tar.xz -C /usr/local/lib/nodejs
sudo cp -p /usr/local/bin/node /usr/local/bin/node.v26.11.1
sudo install -m 0755 /usr/local/lib/nodejs/node-v26.12.1-linux-arm64/bin/node /usr/local/bin/node
/usr/local/bin/node -v   # v26.12.1

# 3) 重启并验证；npm 仍为 nvm 的 12.2.0，不改其 symlink
sudo systemctl restart antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
# 带 Access token 的完整 smoke：-ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9
```

验证记录（2026-10-22）：`node -v=v26.12.1`、`/healthz` 0.5.2/schema 9、smoke **24/24**、Discord Gateway 在代理恢复后重新 `connected`。
回滚：`sudo install -m 0755 /usr/local/bin/node.v26.11.1 /usr/local/bin/node && sudo systemctl restart antifieldcloud`，
再跑本机 healthz + smoke；旧二进制保留至下一轮确认稳定后删除。Node 更新不触碰 DB，无需 schema 回滚；若同时更新 npm/npx 才需同步 nvm 目录。

## 4. 初始化管理员与 TOTP（必须由本人交互执行）

在**交互式 SSH** 中运行（不要把密码/二维码发到聊天）：

```bash
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs
```

流程：设置用户名 → 输入两次密码（≥12 位）→ 扫描终端二维码/手动保存密钥 →
输入 6 位验证码 → 保存 10 个恢复码（只显示一次）。

重置：

```bash
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs --reset-password
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs --reset-totp
```

## 5. Cloudflare Tunnel 与 DNS

备份并编辑 Pi 上的 `/etc/cloudflared/config.yml`，保留原有 `tunnel`/`credentials-file`/`protocol`，只替换
`ingress` 为仓库 `deploy/cloudflared-ingress.yml` 的内容（示例）：

```yaml
ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:3000
  - hostname: ai.example.com
    service: http://127.0.0.1:3000
  - hostname: mc.example.com
    service: tcp://localhost:25565
  - service: http_status:404
```

```bash
sudo cp -a /etc/cloudflared/config.yml /var/backups/antifieldcloud/cloudflared-config.yml.$(date +%s)
sudo systemctl restart cloudflared
sudo journalctl -u cloudflared -n 30 --no-pager
sudo cloudflared tunnel info <TUNNEL_UUID>    # 检查 connector 与版本升级提示
```

**DNS 由用户在 Cloudflare 后台手动添加**（现有 `cert.pem` 是隧道 token，不是账号证书，CLI 无 DNS 权限）：

| 类型 | 名称 | 内容 | 代理 |
|---|---|---|---|
| CNAME | `app` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied（橙色云） |
| CNAME | `ai` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied（橙色云） |

- 不要修改 `mc.example.com`（指向 SakuraFRP，与工作台无关）。
- Cloudflare 代理有 **100MB（Free/Pro）/200MB（Business）请求体上限** 与默认 100s 代理读超时；应用
  `MAX_UPLOAD_BYTES` 默认按 100 MiB 配置，超过上限的上传由边缘直接 413（见 FAQ）。
- cloudflared 以 root 运行；当前已通过 `20-hardening.conf` drop-in 加固（见 §9.6），定期用
  `cloudflared tunnel info` 的版本提示升级（`--no-autoupdate` 不会自动升级）。

### 5.1 Rocket Loader / 自动注入（OpenCode 无垫片前置）

目标：只为 `ai` 主机关闭 Cloudflare 对模块脚本的改写/自动注入，不影响 `app`。

1. Cloudflare Dashboard → Rules → **Configuration Rules** → Create rule：
   - 表达式：`http.host eq "ai.example.com"`；
   - 设置：**Rocket Loader: Off**；
   - 保存并部署。官方已将 Rocket Loader 从 Page Rules 迁移到 Configuration Rules。
2. Speed → Optimization：如仍启用 Rocket Loader，保持全局设置不动，以 host 规则为准。
3. Web Analytics → Manage Site：自动注入设为 **Disable**（严格 CSP 下 beacon 被拦截）。
4. 如启用 Bot Fight Mode，其 JavaScript Detections 不能单独关闭；可整体关闭或接受控制台 CSP 报错。
5. 验收：
   - `curl -fsS https://ai.example.com/` 的 HTML 中 `type="module"` 未被改写；无 `data-cfasync` 依赖；
   - 认证浏览器桌面/Android/390/915 宽屏测试原生“新建会话”、模型/智能体选择器、SSE/WS；
   - 代理设置 `OPENCODE_HTML_MODE=passthrough`（或 `attributes` 过渡）后再观察 24h；失败切回 `shim`。
6. 回滚：删除该 Configuration Rule → 恢复 `OPENCODE_HTML_MODE=shim` → 重启应用。

注意：opencode 上游原生新建按钮在部分版本/空项目状态有缺陷；若关闭注入后仍无响应，按验收记录保留最小隐藏 click/pointerup 接管（无可见按钮），不重新引入 v0.2.1 的浮动按钮。

### 5.2 Cloudflare Access 策略与 bypass（v0.5.1 引入，仍有效）

目标：在 Cloudflare 边缘给 `app.antifield.work` 增加第二层身份校验（应用 TOTP 仍是最终认证），同时保证 Bot 回调、健康检查与公开分享不被 Access 拦截。
**Access 配置不在仓库内；未配置/漏配时表现为 Webhook 404/302、`/healthz` 302、公开分享被重定向。**

生产当前配置（2026-10-21，API 创建）：
- 主应用 `AntifieldCloud`：`app.antifield.work`，One-time PIN IdP，策略 `Owner allow`（指定邮箱）+ `Smoke service token`（`non_identity`，指定 service token）。
- 4 个独立 **Bypass** 应用（各自 `Bypass Everyone`）：`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`。
- service token 名称 `smoke-readonly`，有效期 1 年；Client ID/Secret 只保存在 PC `.local/cf-access.env`（gitignored），不写仓库。
- 已实测：未登录 `/` 302 到 `*.cloudflareaccess.com`；4 个 bypass 路径返回应用状态码而非 302；带 token 访问 `/api/bots/status` 为 401；smoke 24/24。

手工重建/迁移时按以下步骤：

1. Zero Trust → Access → Applications → Add an application → Self-hosted：
   - Application name：`AntifieldCloud`；Session duration：建议 8–24h。
   - Public hostname：`app.antifield.work`（路径留空）。
   - Policy：`Allow`，Include 选择本人邮箱（One-time PIN）或已配置的身份提供商；不要添加 `Everyone`/`Bypass` 到整站。
2. **先创建 4 个独立的 path 应用**（路径应用的优先级高于整站主应用）：
   - 每个应用 Domain 填 `app.antifield.work/healthz`（或对应路径），Policy 选 **Bypass + Everyone**；
   - 路径分别为：`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`。
   - `/api/bot/webhook` 覆盖 Telegram/Discord/Slack/QQ 回调；`/s` 与 `/api/public/shares` 覆盖公开分享；`/healthz` 供 smoke/健康检查。
   - 如 PWA 冷启动/离线壳在 Access 登录前就需要加载，可再按需 bypass `/assets`、`/manifest.webmanifest`、`/sw.js`、`/offline.html`、`/icons`；
     不要把 `/api` 整体 bypass。
3. 验证（未登录浏览器/命令行）：
   ```bash
   # Webhook：应为应用的 404（BOT_ENABLED=false）或 401（验签失败），不能是 Cloudflare Access 302
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.antifield.work/api/bot/webhook/x
   # 健康检查：200 JSON
   curl -sS https://app.antifield.work/healthz
   # 公开分享：未知 token 应为应用 404，而不是 Access 登录页
   curl -s -o /dev/null -w '%{http_code}\n' https://app.antifield.work/s/not-a-token
   # 主应用：未登录应 302 到 <team>.cloudflareaccess.com（或 Access 登录页）
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://app.antifield.work/
   ```
   带 service token 访问受保护 API 应返回应用 401（不是 302），并据此跑完整 smoke。
4. 回滚：删除 path Bypass 应用或整个主 Access Application；清理浏览器 Access Cookie 后重试。回滚后 Webhook/health/分享恢复无边缘身份层，
   应用侧签名/限流仍生效。
5. 注意：Access 的 `Bypass` 只影响边缘身份校验，不改变应用会话/CSRF/签名；不要把 Access 当作应用认证替代品。
   Cloudflare 账号本身必须开启 2FA（Access 配置权限等同于入口控制权）。
6. **service token（供 smoke/CI）**：Zero Trust → Access → Service Auth → Create Service Token，绑定到主应用 `Service Auth` 策略；
   把 Client ID/Secret 通过命令行传给 smoke：
   ```powershell
   .\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9 `
     -AccessClientId "<id>" -AccessClientSecret "<secret>"
   ```
   两者必须同时提供，否则脚本直接报错；凭据只用于请求头，不打印/不写仓库。建议专用、最小范围、定期轮换；
   `-SkipPublic` 时不发起公网请求，无需 token。未配置 Access 时不要传这两个参数（传了也被边缘忽略，但无意义）。

## 6. 验证

本机（Pi 上）：

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -H 'Host: app.example.com' -fsS http://127.0.0.1:3000/healthz
```

公网（DNS 生效后）：

```powershell
.\scripts\smoke.ps1 -PiHost 192.0.2.10 -AppUrl https://app.example.com -AiUrl https://ai.example.com `
  -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9
```

配置 Cloudflare Access 后，可在同一命令追加 `-AccessClientId/-AccessClientSecret`：脚本会给公网请求附加
`CF-Access-Client-Id`/`CF-Access-Client-Secret` 头，并额外检查“带 token 到达应用但未登录 → 401”；两者必须同时提供，凭据不打印。

`smoke.ps1` 覆盖：公网健康/302/401、CSP/nosniff/referrer/HSTS、PWA（manifest/sw/offline）、公开分享页 404/410、
指标/告警/分享等 API 401、Pi 服务与 `/healthz` 版本（`-ExpectedVersion`）、内存 cgroup、nftables 规则/25575 阻断/25565 可达、
备份 pending 与 48h 状态、密钥包状态、世界备份/世界拉取/演练状态文件、已安装脚本 SHA-256 与仓库一致、
本地世界/应用归档 `.sha256` 旁文件；所有 SSH 检查带重试与硬超时。`-SkipPublic`/`-SkipLocalBackup`/`-SkipScriptHash`
用于部署后只读子集。

Windows 备份计划任务（**管理员 PowerShell**；安装脚本会收紧 ACL 并做 Pi 可达性预检）：

```powershell
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 只预览不注册：
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -DryRun
```

手工检查：`https://app.example.com` 登录、上传/预览、Dashboard MC 状态、白名单增删、文件分享与告警卡片；
`https://ai.example.com` 登录后进入 opencode。若 opencode 仍要求输入自身密码，属于其 UI 行为，
从 Pi `sudo grep OPENCODE_PASSWORD /etc/opencode/opencode.env` 获取后输入一次（不写入前端）。

### 6.1 v0.5.2 备份/灾备/迁移

- 迁移：v0.5.2 为 schema v9（迁移 9 增加 `bot_targets.allow_chat`、`bot_ai_memories`、`bot_inbound_targets`；迁移 5–8 保留）。部署脚本切换前自动 `--snapshot-db`；
  回滚必须先恢复该快照，并同时还原 `APP_VERSION`（deploy.ps1 已自动化）。v9 高于旧代码支持版本，不能只回退代码。
- Bot 密钥：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY` 并纳管 `BOT_AI_*` 与 v0.5.2 的 Chat/记忆/多附件/Gateway 键；env 由密钥包覆盖。
  **`BOT_SECRET_KEY` 必须与 DB 一起恢复**，否则 `bots` 行不可解密、Token/AppSecret 需重录。首次部署后立即跑一次 `backup-secrets.sh` 并确认 PC 拉取成功。
- 启用 Bot 后：`/api/version` 返回 `botsEnabled:true` 与 `botPlatforms`（含 `qq`）；`/api/bots/status` 的 `keyConfigured/enabled` 均为 true；
  `smoke.ps1 -ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9` 通过（公网 Webhook 路径不应被 Access 302）。
- Chat/记忆：目标 `allow_chat` 与 `allow_commands` 独立；Chat 6/min 且与 `/ask` 共用 10/h；`bot_ai_memories` 为 DB 权威，
  `DATA_DIR/bot-memory` 为镜像（0700/0600，不通过 Web 暴露）；摘要失败保留旧摘要；记忆不进入任何 API 响应。
- 多附件/Gateway：发布最多 5 个、单 10 MiB、总 50 MiB；QQ 无媒体；部分成功 `partial_media_sent` 不自动重试。
  Discord Gateway 需 Developer Portal 开启 Message Content Intent，`BOT_DISCORD_GATEWAY_ENABLED=true` 后确认 `gateway.state=connected`。
- 指标/静默/确认：`GET /api/bots/:id/metrics?hours=24` 可读；`GET /api/bots/:id/inbound-targets` 需登录；目标静默起止成对校验；
  发布请求必须带 `confirmText:'PUBLISH'`。
- Windows 应用备份脚本：更新仓库后**重新运行 `install-backup-task.ps1`**（管理员），刷新复制的 `backup-pull.ps1`、脚本 SHA 与安装标记；
  手跑一次核对 `backup.log` 出现 `secrets=ok`，Pi `backup-pull.json` 含 `secretsOk=true`（env 内含 `BOT_SECRET_KEY`/`BOT_*`，不打印值）。
- 世界备份/拉取：`antifieldcloud-world.timer` 时刻不变（周日 12:00）；`world-pull.ps1` 参数不变，更新仓库后手跑一次确认仍能校验/ack；
  `backup-world.mjs` 信号时优先 `save-on`，失败仍写 `world-backup-status.json`。
- 恢复演练：`drill.ps1 -ExpectedSchemaVersion 9`（v0.5.1 为 8，v0.5.0 为 7，v0.4.2 及以前为 6）；旧报告保留，不改写。
- Web 恢复：只允许导入/校验/文件级恢复到新目录（`skippedMissing` 会剔除并在结果报告）；整库恢复仍按 `docs/BACKUP.md` §8 离线执行。
- 媒体：mp4/webm/mp3/m4a/ogg/flac/wav 可内联播放；mkv/avi 等回退下载。
- Bot 媒体：发布只接受 `origin='user'` 的活动普通文件，最多 5 个、单 ≤10 MiB、总 ≤50 MiB；笔记附件/回收站文件不可发布；QQ 无媒体。
- 验收：`npm run check`（本地 293/140）、`npm run build`、`npm run test:coverage`、`npm run test:web:coverage`、
  `smoke.ps1 -ExpectedVersion 0.5.2`、Bot 四平台联调（§9.8；v0.5.1 QQ 真实回调已验证，v0.5.2 Chat/多附件/Gateway 待联调）、备份导入/校验/恢复（临时 DATA_DIR）、
  世界备份/PC 拉取、`drill.ps1 -ExpectedSchemaVersion 9` 演练通过；OpenCode 升级后按 §3.2 复验 Basic/session/垫片注入/公开入口。
  `/ask` 真实模型回复在 v0.5.1 已验证；v0.5.2 已部署/迁移 v9/smoke 24/24，Chat/记忆真实模型与 Discord Gateway 长连接待开启生产目标与 Intent 后验证。

## 7. 主机健康探针（vcgencmd → /run JSON）

`deploy/antifieldcloud-health.service` + `.timer` 每 60s 以 root 采集欠压/降频/温度/风扇并写
`/run/antifieldcloud/pi-health.json`（0644），供应用告警模块读取。

```bash
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 deploy/health-probe.sh /usr/local/libexec/antifieldcloud-health.sh
sudo install -m 0644 deploy/antifieldcloud-health.service deploy/antifieldcloud-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antifieldcloud-health.timer
sudo systemctl start antifieldcloud-health.service
cat /run/antifieldcloud/pi-health.json
```

- `deploy/antifieldcloud.service` 已设置 `Environment=PI_HEALTH_FILE=/run/antifieldcloud/pi-health.json`；
  更新 unit 后执行 `sudo systemctl daemon-reload && sudo systemctl restart antifieldcloud` 使其生效。
- 告警阈值（磁盘/温度/备份超期/欠压等）由 env 的 `ALERT_*` 控制；webhook 配置只读展示，不在前端存储明文密钥。

## 8. 内存限制检查（重要）

应用 unit 的 `MemoryMax=512M` 依赖内核 memory cgroup；若 Pi 内核命令行包含 `cgroup_disable=memory`，限制不会生效：

```bash
cat /proc/cmdline | tr ' ' '\n' | grep -i cgroup
cat /sys/fs/cgroup/cgroup.controllers        # 必须包含 memory
sudo systemctl show antifieldcloud -p MemoryCurrent -p MemoryMax
```

- 若 controllers 缺少 `memory`：从内核命令行移除 `cgroup_disable=memory`（检查 `/boot/firmware/cmdline.txt` 与固件/镜像
  默认 cmdline 的实际来源），重启，再确认 `memory` 出现在 controllers 且 `MemoryCurrent` 有数值。
- 该项是发布验收的硬性检查（`smoke.ps1` 会失败），不能用“应用内存占用低”代替。

## 9. 防火墙、系统加固、SSH、世界/演练与 Bot 接入

### 9.1 nftables 新规则（v0.4.0）

当前 `deploy/nftables.conf`：默认 `policy drop`；loopback/established/ICMP 放行；DHCP 仅 `eth0`/`wlan0`；
**22 仅 `169.254.77.0/24` + `172.23.88.0/21`，且 `ct state new` 限速 `20/minute burst 40 packets`**；
**25565 仅同网段**（IPv6 仅 `fe80::/10`）；**25575 显式 drop**；80 不再放行；出站不限制。

```bash
# 备份 → 语法校验 → 加载 → 验证（root）
sudo cp -a /etc/nftables.conf /etc/nftables.conf.bak.$(date +%s)
sudo nft -c -f deploy/nftables.conf
sudo install -m 0644 deploy/nftables.conf /etc/nftables.conf
sudo nft -f /etc/nftables.conf
sudo systemctl enable --now nftables
sudo nft list ruleset
ss -tlnp | grep -E ':25565|:25575'
```

- **前置确认（否则会锁死 SSH）**：先确认自己当前的 SSH 来源地址在 `169.254.77.0/24` 或 `172.23.88.0/21` 内；
  不确定时先在 Pi 本机/物理键鼠旁操作，并保持一个已建立的 SSH 会话不要断开。
  实际网段按 `.local/DEPLOYMENT.md` 修改；网段宁窄勿宽。
- 期望：外部 `<Pi IP>:25575` 失败、`127.0.0.1:25575` 正常；22/25565 在允许网段内正常、其它来源不可达；
  22 频繁新建连接会被限速（暴力破解防护）。
- 回滚：`sudo cp /etc/nftables.conf.bak.<ts> /etc/nftables.conf && sudo systemctl restart nftables`；
  紧急解绑（需物理键鼠/已建立 SSH）：`sudo systemctl disable --now nftables && sudo nft flush ruleset`。
  **不要**在只有一条 SSH 连接且来源网段未确认时清空规则。

### 9.2 systemd 加固（v0.4.0）

`deploy/antifieldcloud.service` 已启用：`CapabilityBoundingSet=`（空）、`AmbientCapabilities=`、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、
`PrivateDevices`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome=true`、`ReadWritePaths=/var/lib/antifieldcloud`、
`ProtectKernelTunables/Logs`、`ProtectControlGroups`、`ProtectClock/Hostname`、`RestrictNamespaces/SUIDSGID/Realtime`、
`LockPersonality`、`SystemCallArchitectures=native`、`StartLimitIntervalSec=60/StartLimitBurst=5`、`MemoryMax=512M`。

```bash
sudo cp -a /etc/systemd/system/antifieldcloud.service /var/backups/antifieldcloud/antifieldcloud.service.$(date +%s)
sudo install -m 0644 deploy/antifieldcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
journalctl -u antifieldcloud -n 50 --no-pager
```

- 回滚：恢复备份的 unit → `daemon-reload` → `restart`。若出现 `status=226/NAMESPACE` 或权限错误，先确认
  `ReadWritePaths` 覆盖所有实际写入目录（当前仅 `/var/lib/antifieldcloud`），再检查 `/run` 目录归属。
- 健康探针 `deploy/antifieldcloud-health.service/.timer` 与 `PI_HEALTH_FILE` 不变（§7）。
- 世界备份 unit `antifieldcloud-world.service` 也使用同类加固（整机只读、仅数据目录可写、Minecraft 目录只读、空 cap 之外仅保留必要 chown/chmod）。

### 9.3 世界备份 timer 安装与回滚

```bash
# 安装/更新（root）
sudo install -m 0644 deploy/antifieldcloud-world.service deploy/antifieldcloud-world.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antifieldcloud-world.timer
systemctl list-timers antifieldcloud-world.timer
# 手动触发一次并检查
sudo systemctl start antifieldcloud-world.service
journalctl -u antifieldcloud-world -n 80 --no-pager
cat /var/lib/antifieldcloud/world-backup-status.json
ls -lh /var/lib/antifieldcloud/world-backups/
```

- `OnCalendar=Sun 12:00 Asia/Shanghai`（显式时区）、`Persistent=true`、`AccuracySec=1min`；`flock -w 600` 串行、
  `TimeoutStartSec=4h`；unit 只读整机、仅 `/var/lib/antifieldcloud` 可写、`/home/antifield/minecraft-server` 只读。
- 归档保留最新 4 份（含本次），旧 legacy 文件不动；状态文件 0644，`error/message` 为 ASCII 错误码 + 英文说明，
  便于 PowerShell/前端解析。
- 回滚/停用：`sudo systemctl disable --now antifieldcloud-world.timer`；需要时删除 `/etc/systemd/system/antifieldcloud-world.{service,timer}` 后
  `daemon-reload`。不要删除既有归档；确需清理按 `docs/BACKUP.md` §6.4。
- 旧世界 cron 已在验收后停用；不要同时保留 cron 与 timer，避免重复打包（见 §14）。
- 定时策略（用户 2026-10-21 确认）：仅项目世界备份 timer 统一到周日 12:00；`antifieldcloud-health.timer` 保持每 60s；
  apt-daily/logrotate/fstrim 等系统维护 timer 保持发行版默认，不纳入统一调整。

### 9.4 世界拉取（Windows 周任务，用户手动安装）

```powershell
# 先手动跑一次（直连网线可达；脚本在仓库 scripts/ 下，也可自行复制到固定路径）
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\world-pull.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 创建周任务：每周日 12:00（路径/参数按实际替换）
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\<user>\projects\AntifieldCloud\scripts\world-pull.ps1" -PiHost 192.0.2.10 -BackupRoot "%USERPROFILE%\AntifieldCloudBackups"'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 12:00
Register-ScheduledTask -TaskName "AntifieldCloud-World-Pull" -Action $action -Trigger $trigger -Description "AntifieldCloud 世界备份周度拉取"
```

- 两阶段：scp `.part` → 远端 `.sha256` 比对 → 原子改名 → 删除远端归档/旁文件（ack）；**失败不 ack、不动远端**，退出码 1。
- 本地保留最新 4 份；日志 `%LOCALAPPDATA%\AntifieldCloud\world-pull.log`；远端状态写 `world-pull-status.json`。
- 回滚/停用：`Unregister-ScheduledTask -TaskName "AntifieldCloud-World-Pull" -Confirm:$false`；已拉取归档保留。
- `install-backup-task.ps1` **只安装每日应用归档任务**，不会创建世界拉取/演练任务。

### 9.5 恢复演练（drill.ps1，季度/升级前）

```powershell
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 9
# 需要验证世界解包时（先确认临时盘 ≥3× 世界归档体积）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 9 -IncludeWorld
# 回写 Pi 状态（可选）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -PiHost 192.0.2.10
```

- 只读校验 PC 上最新 full + 其后全部 inc：sidecar SHA、tar 条目安全、manifest、最新 DB `integrity_check/foreign_key_check/schema_version`；
  输出 `%BackupRoot%\drills\<UTC>\report.json|report.md`（保留 180 天，`-KeepDays` 可调）。
- 可选回写 `/var/lib/antifieldcloud/drill-status.json`（0644），Dashboard 与 `drill_stale` 告警读取；未运行状态 unknown。
- 回滚：不安装计划任务即无需回滚；删除旧报告目录即可释放空间；不要删除归档本身。
- 演练记录仍按 `docs/BACKUP.md` §7 表格补充（报告路径 + 结果 + 世界是否解包）。

### 9.6 主机加固现状（环境事实）

- **journald persistent**：`/etc/systemd/journald.conf.d/60-workbench-persistent.conf` 设
  `Storage=persistent`、`SystemMaxUse=64M`、`RuntimeMaxUse=32M`；Pi 的 `/var/log` 由 log2ram 承载，关机前同步。
- **cloudflared**：`2026.10.1`；`/etc/systemd/system/cloudflared.service.d/20-hardening.conf` 启用
  `NoNewPrivileges/PrivateTmp/ProtectSystem=full/ProtectHome` 等；回滚二进制在 `/var/backups/antifieldcloud/cloudflared-2026.8.1`。
- **rpcbind** 已禁用（111 关闭）；**fake-hwclock** load/save 已启用（无 RTC 电池时近似关机时间），NTP 仍负责校时。
- **RCON**：Paper 无 bind 配置，25575 仍监听所有接口；仅由 nftables 丢弃非 loopback 入站。
- **SSH 已改仅公钥**（v0.5.0，`/etc/ssh/sshd_config.d/00-` drop-in，24h 回滚窗口见 §9.7）；**`fail2ban` 已安装并启用 `sshd` jail**
  （nftables 后端，24h ban，dbfile 持久化）；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后异步恢复封禁 set；
  `antifield` 用户的 `NOPASSWD ALL` sudo 仍属既有残留，风险见 `docs/SECURITY.md` §4。

### 9.7 SSH 仅公钥（00- drop-in）与 24h 回滚

目标：禁用密码/键盘交互登录，只允许公钥；用 `00-` 前缀确保在 `sshd_config.d` 中优先于云镜像/发行版其它 drop-in 生效。
操作前必须保留一个已建立的 SSH 会话/物理键鼠，并确认当前公钥可登录（`ssh -o PreferredAuthentications=publickey ...`）。
以下以 `00-antifield-hardening.conf` 为例；实际安装的 `00-*.conf` 文件名以本机为准（`ls /etc/ssh/sshd_config.d/`）。

```bash
# 0) 备份（root）
TS=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o root -g root -m 0700 /var/backups/antifieldcloud
sudo cp -a /etc/ssh/sshd_config /var/backups/antifieldcloud/sshd_config.$TS
sudo ls -l /etc/ssh/sshd_config.d/ | tee /var/backups/antifieldcloud/sshd_config.d.list.$TS

# 1) 写入 00- drop-in（值按实际确认；不要动 Port/AllowUsers 等既有配置）
sudo tee /etc/ssh/sshd_config.d/00-antifield-hardening.conf >/dev/null <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo chmod 0644 /etc/ssh/sshd_config.d/00-antifield-hardening.conf

# 2) 语法校验后平滑重载；保持现有会话不要退出
sudo sshd -t
sudo systemctl reload ssh

# 3) 新开一个终端验证（不要关闭旧会话）
ssh -o PreferredAuthentications=publickey antifield@<直连 IP> 'echo pubkey-ok'
sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin) '
```

- 期望：`passwordauthentication no`、`kbdinteractiveauthentication no`、`pubkeyauthentication yes`；密码登录被拒。
- **24h 回滚窗口**：保留 `/var/backups/antifieldcloud/sshd_config.$TS` 与 drop-in 的副本，记录切换时间；24h 内确认 smoke、备份、
  世界拉取、部署脚本（全部依赖公钥）均正常后，再删除备份中的旧配置副本（至少保留一份到下次演练）。
  回滚：`sudo rm /etc/ssh/sshd_config.d/00-antifield-hardening.conf`（或恢复备份）→ `sudo sshd -t` → `sudo systemctl reload ssh`，
  用密码/公钥重新验证；不要在只剩一条 SSH 连接时回滚。
- `fail2ban` 已启用：`sshd` jail 使用 nftables 后端、`bantime=24h`，只对公网/直连网段内的失败公钥/密码尝试封禁。
  ```bash
  sudo systemctl status fail2ban --no-pager
  sudo fail2ban-client status sshd                 # 当前封禁数/列表/日志文件
  sudo fail2ban-client get sshd bantime            # 期望 86400
  sudo nft list set inet f2b-table addr-set-sshd 2>/dev/null | head   # 封禁 set（名称以实际配置为准）
  ```
  **手工 `systemctl reload nftables` 不会触发** `ExecStartPost`，已有封禁 set 仍会丢失；此时必须手动
  `sudo systemctl restart fail2ban`。v0.5.1 的 drop-in 只在 `systemctl start/restart nftables` 时生效。
  改动 nftables 的部署脚本/手工流程要把这一步写进检查表。回滚：`sudo systemctl disable --now fail2ban`
  并移除本地 jail 配置（不恢复密码登录）；如 fail2ban 自身异常，先 `fail2ban-client -t` 校验配置，再看 `journalctl -u fail2ban`。
  日志后端为 log2ram/journald，重启后需确认 `/var/log/auth.log`/journal 仍可读；不要把 `ignoreip` 放得过宽。
- **fail2ban 封禁持久化（v0.5.1）**：
  - 确认 dbfile：`ls -l /var/lib/fail2ban/fail2ban.sqlite3`；jail 配置中 `dbfile` 指向该 SQLite（重启后从数据库恢复封禁）。
  - 安装 drop-in（仓库 `deploy/systemd/nftables.service.d/10-fail2ban-restore.conf`）：
    ```bash
    sudo install -d -m 0755 /etc/systemd/system/nftables.service.d
    sudo install -m 0644 deploy/systemd/nftables.service.d/10-fail2ban-restore.conf \
      /etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf
    sudo systemctl daemon-reload
    sudo systemctl cat nftables.service | tail -n 8   # 确认 ExecStartPost 与 systemd-run 行
    ```
  - 验证（先制造一个可恢复的测试封禁或记录当前 `fail2ban-client status sshd`）：
    ```bash
    sudo systemctl restart nftables       # 触发 ExecStartPost，3 秒后异步重启 fail2ban
    sleep 5
    sudo fail2ban-client status sshd      # 封禁列表/统计应恢复
    sudo nft list set inet f2b-table addr-set-sshd 2>/dev/null | head
    ```
    不能同步 restart fail2ban：systemd job 会等待 nftables 自身启动作业，形成 ordering 死锁。
  - 手工 `systemctl reload nftables` 不执行 `ExecStartPost`；重载后仍需 `sudo systemctl restart fail2ban` 并复核封禁列表。
  - 回滚 drop-in：删除 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` → `sudo systemctl daemon-reload`；
    不影响 nftables 规则与 fail2ban 现有封禁。生产已安装并实测 nftables restart 后封禁恢复；Cloudflare Access 也已配置并通过带 token 的 smoke。
- 回滚窗口结束后的验收：`sshd -T` 仍为仅公钥、`smoke.ps1`/备份/部署均通过、旧密码登录失败（可用被测主机/临时用户验证，不要锁死主账号）。

### 9.8 Bot 平台接入（用户后台 + 应用配置）

1. **Telegram**：BotFather 建 Bot → `/bots` 新建 Telegram（Token + ≥16 位 Webhook Secret）→ 用页面 `setupSteps` 的 `setWebhook`
   命令设置 `url=https://app.example.com/api/bot/webhook/<id>`、`secret_token=<secret>`、`allowed_updates=["message","callback_query"]` →
   私聊/群组发 `/help`；目标填 chat id，命令用户需另建 `kind=user` 目标并勾选允许命令。Chat 需目标勾选 `allow_chat`；
   群/频道还需关闭 BotFather privacy mode，或让用户回复 Bot 消息。
2. **Discord**：Developer Portal 建 Application/Bot → 填 Interactions Endpoint URL（页面生成）→ 保存时 Discord 发 PING，
   应用返回 `{"type":1}` → 邀请 Bot 到测试服务器（发送消息/附件权限）→ 登记频道 ID；如需斜杠命令，在 Portal/API 注册
   `/help` `/status` `/backup` `/world` `/mc` `/files` `/ask`。Public Key 必须是 64 位 hex。
   普通消息 Chat 还需开启 **Message Content Intent**，并设 `BOT_DISCORD_GATEWAY_ENABLED=true`；Gateway 使用
   `intents=37377`（含 `MESSAGE_CONTENT`），确认 `BotSummary.gateway.state=connected`。
3. **Slack**：api.slack.com/apps 建 App → 取 Bot Token（`xoxb-`）与 Signing Secret → Event Subscriptions 填同一 URL，
   订阅 `message.channels`/`message.im`/`app_mention`（按需）→ Slash Commands 的 Request URL 填同一 URL 并创建同名命令 → 安装到 workspace、
   邀请 Bot 进测试频道 → 登记频道 ID。Chat：DM 直接进入；频道用 `app_mention` 或显式 `<@BOTID>`；Slack 本轮无按钮。
4. **QQ 官方 Bot**：QQ 开放平台（q.qq.com）创建机器人 → 取 AppID/AppSecret → `/bots` 新建 QQ（AppID 填公开配置，
   AppSecret 填 Token/AppSecret 字段）→ “开发设置 → 回调地址”填 `https://app.example.com/api/bot/webhook/<id>`，
   平台发 `op=13` 时应用返回 `plain_token` 签名 → 订阅 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`/`AT_MESSAGE_CREATE` →
   目标填 `user_openid`/`group_openid`/`channel_id`，命令用户另建 `kind=user` 且允许命令的目标 → 发 `/help` 验证。
   QQ 仅文本（≤2000 字符）、无媒体；Chat 先 @Bot 发一条消息，再从“最近入站目标”登记并勾选 `allow_chat`。
   真实回调必须在 QQ 后台完成，未配置前不能验收。
5. **应用侧**：`/bots` 中 Bot 默认 `enabled=false`；先保存配置与目标（可设静默时段），再开启 `BOT_ENABLED=true` 并重启，
   最后逐个 `PATCH enabled=true`。用“测试连接”发一条测试消息（20 次/小时）；发布用 `/bots` → 投递与发布 →
   填文本/可选最多 5 个媒体（单 ≤10 MiB、总 ≤50 MiB；QQ 无媒体）+ TOTP + `PUBLISH` 二次确认。
6. **AI（可选）**：Bot 稳定后设 `BOT_AI_ENABLED=true`（可同时设 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`）并重启；由白名单用户在私聊发
   `/ask <问题>`，确认有文本回复且审计 `bot.ai.ask`；真实模型/工具行为按 `docs/SECURITY.md` §4 第 21 条记录。
   再给目标勾选 `allow_chat`，用私聊/@Bot/回复 Bot 发普通消息验证 Chat、`bot.chat`/`bot.ai.chat` 审计与 6/min/10h 限流；
   多轮后检查 `bot_ai_memories` 与 `DATA_DIR/bot-memory`（不打印内容）。
7. **验收证据**：Telegram/Discord/Slack 至少各一条命令回复 + 一条 Chat 回复 + 一条测试通知 + 一条发布（含多附件）+ 一次定时/取消 + 一次失败重试；
   QQ 至少一条 C2C/群@/频道文本命令、一条 Chat 与一条通知（无媒体）；AI 至少一条真实 `/ask` 回复；
   Discord Gateway 至少一次 `connected` 与一次断线重连/关闭。记录 `bot_deliveries` 状态与平台消息 id
   （不记录 Token/Secret/AppSecret/记忆正文）。未完成联调前保持 `BOT_ENABLED=false`/`BOT_AI_ENABLED=false`/`BOT_DISCORD_GATEWAY_ENABLED=false`；
   QQ/AI/Chat/Gateway 未配置时在 `docs/ACCEPTANCE.md` 标“待配置/待验证”。

### 9.9 Bot 队列/发布故障排查

| 现象 | 处理 |
|---|---|
| Webhook 302 到 cloudflareaccess.com | Access 未对 `/api/bot/webhook/*` bypass（§5.2） |
| Webhook 404 | `BOT_ENABLED=false`/无 `BOT_SECRET_KEY`/Bot `enabled=false`/botId 错；看 `/api/bots/status` 与审计 `bot.webhook.rejected` |
| Webhook 401 | Telegram secret 不匹配、Discord 签名/时间戳（±300s）或 Public Key 错、Slack Signing Secret 错、QQ Ed25519/AppSecret/时间戳错；核对平台后台 |
| 命令无回复 | 目标未勾选 `allow_commands`、用户未登记为 `kind=user` 且允许命令、命令限流、平台 API 失败；看 `bot.command.denied`、`bot_deliveries.last_error` |
| `/ask` 提示未启用/频繁 | `BOT_AI_ENABLED=false`、用户不在白名单、超过 `BOT_AI_RATE_PER_HOUR`；看 `bot.ai.ask` 审计与 `BOT_AI_*` env |
| `/ask` 超时/502/504 | OpenCode 不可达、Basic 密码不一致、模型未配置或超时；`curl -u` 探测 4096，检查 `OPENCODE_PASSWORD` 与 `BOT_AI_TIMEOUT_SECONDS`；不要打印密码 |
| 发布 400/401 | 缺 `totpCode` 或 `confirmText:'PUBLISH'`、TOTP 过期/重放、目标是 user、文本超平台上限、媒体 >5 个/单 >10 MiB/总 >50 MiB（`too_many_media`/`media_too_large`/`media_total_too_large`）、QQ 带媒体、定时超 30 天 |
| 发布 `partial_media_sent` | 部分附件已外发后失败；任务标记 `failed` 且不自动重试，避免重复外发。核对平台消息后人工重建任务 |
| Chat 无回复 | 目标未勾选 `allow_chat`、`BOT_AI_ENABLED=false`、群/频道未 @Bot 或回复 Bot、普通频道消息被忽略、限流（6/min 或 10/h）；看 `bot.chat.denied`/`bot.chat`/`bot.ai.chat` 审计 |
| 记忆未更新 | 摘要失败只记日志并保留旧摘要；看 `Bot 记忆摘要失败` 日志、OpenCode 是否可达、`BOT_AI_MEMORY_MAX_CHARS`；不要打印记忆正文 |
| Discord Gateway 未连接 | `BOT_DISCORD_GATEWAY_ENABLED=false`、Developer Portal 未开 Message Content Intent（close 4014）、Token 错（4004）、Pi 到 `gateway.discord.gg` 出站/代理不可达；看 `BotSummary.gateway.state/lastError` 与 journald（不含 Token） |
| Discord 普通消息不触发 | Gateway `connected` 但消息未 @/回复 Bot；普通频道消息设计上不消费；确认目标 `allow_chat` 与 platform 目标 ID（channel_id） |
| 按钮无响应 | 目标未 `allow_commands`、用户未登记 `kind=user` 且允许命令、Slack/QQ 不支持按钮、平台回调地址未含 `callback_query`（Telegram） |
| 通知被延后 | 目标配置了静默时段且在窗口内；属预期，`next_attempt_at` 为窗口结束；如非预期检查 `quietStartMinute/quietEndMinute` |
| 指标卡为空/0 | 窗口内无投递或 Bot 关闭；直接查 `GET /api/bots/:id/metrics?hours=24`、`bot_deliveries`/`bot_publish_jobs`；成功率只统计已尝试投递 |
| 投递 `dead` | 平台 Token 失效/权限不足/被限流；修复后 `POST /deliveries/:id/retry`；必要时轮换 Token；QQ 检查 `access_token` 换取失败/AppID |
| 队列不跑 | `BOT_ENABLED`/密钥、`BOT_DELIVERY_INTERVAL_SECONDS`、Bot 未启用；重启后看 `startBots` 日志 |
| `BOT_SECRET_KEY` 无效 | 必须是 base64 32 字节；`bootstrap-env.sh` 会拒绝写入并退出，恢复旧 key 或接受 Token/AppSecret 重录 |
| smoke 公网 302 到 Access | 未配置 bypass 时属预期；配置后仍 302 检查 service token 是否同时传 `-AccessClientId/-AccessClientSecret` 且未过期 |
| nftables restart 后封禁未恢复 | 确认 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` 已安装、`daemon-reload`、dbfile 存在；`journalctl -u nftables` 看 `systemd-run` 是否执行；手工 reload 不触发，需 `systemctl restart fail2ban` |

## 10. cloudflared 加固与升级（建议）

当前 cloudflared 已通过 drop-in 加固；如需重建/复核，可按实际版本使用以下限制（验证可写路径）：

```bash
sudo systemctl edit cloudflared
# [Service]
# NoNewPrivileges=yes
# ProtectSystem=strict
# ProtectHome=yes
# PrivateTmp=yes
# ProtectKernelTunables=yes
# ProtectControlGroups=yes
# CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# ReadWritePaths=/etc/cloudflared
sudo systemctl daemon-reload && sudo systemctl restart cloudflared
```

升级：`cloudflared --version` 与 `sudo cloudflared tunnel info <UUID>` 的提示会显示目标版本；apt 源可能滞后，按 Cloudflare
官方 .deb/仓库升级后 `systemctl restart cloudflared`，并在 smoke 中确认隧道 4 连接已注册。

## 11. 应用回滚与数据库

```bash
ls -1dt /opt/antifieldcloud/releases/*
# 优先使用 deploy.ps1 的自动回滚；手工回滚按以下顺序（schema v9 只向上）
sudo systemctl stop antifieldcloud
sudo cp -a /var/lib/antifieldcloud/backups/db-predeploy-<最新>.sqlite /var/lib/antifieldcloud/db.sqlite
sudo rm -f /var/lib/antifieldcloud/db.sqlite-wal /var/lib/antifieldcloud/db.sqlite-shm
# 关键：同步还原 APP_VERSION（否则旧 release 会以新版本号通过 /healthz）
PREV=/opt/antifieldcloud/releases/<上一个>
PREV_VERSION=$(sudo /usr/local/bin/node -p "require('$PREV/package.json').version")
sudo sed -i "s/^APP_VERSION=.*/APP_VERSION=$PREV_VERSION/" /etc/antifieldcloud/env
sudo ln -sfn /opt/antifieldcloud/releases/<上一个> /opt/antifieldcloud/current
sudo systemctl start antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

- 每次部署在切换前生成 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`（0600，保留最新 10 个）。
- **schema v9**（迁移 5 结构、迁移 6 孤儿 shares 修复、迁移 7 Bot 表、迁移 8 重建 Bot 表/静默列/AI 会话、
  迁移 9 `allow_chat`/`bot_ai_memories`/`bot_inbound_targets`）：迁移前会清理不可达孤儿 shares 并做 `PRAGMA foreign_key_check`，
  其它外键不一致会拒绝启动；旧代码遇到更高 schema 会拒绝启动。回滚旧 release 前必须恢复对应迁移前快照
  （`stop → 复制快照为 db.sqlite → 删除 -wal/-shm → 还原 APP_VERSION → 切 release → start`）。
- Bot 数据回滚：`bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events`/`bot_ai_sessions`/`bot_ai_memories`/`bot_inbound_targets` 随 DB 快照恢复；
  `BOT_SECRET_KEY` 不在 DB 中，必须保持与快照生成时一致的 env（否则 Token/AppSecret 不可解密）。`DATA_DIR/bot-memory` 镜像文件不由快照恢复，
  如需与 DB 摘要一致，可保留现有镜像或按保留期/人工清理；不通过 API 暴露。
  回滚窗口内保持 `BOT_ENABLED=false`/`BOT_AI_ENABLED=false`/`BOT_DISCORD_GATEWAY_ENABLED=false`，确认稳定后再重新启用。
- fail2ban drop-in 回滚：删除 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` → `sudo systemctl daemon-reload`；
  不影响应用数据；回滚后 nftables restart 需手工 `systemctl restart fail2ban`。
- 部署后 smoke 失败的门禁：`deploy.ps1` 默认失败；若已用 `-AllowSmokeFailure` 保留部署，必须在 `docs/ACCEPTANCE.md` 记录未通过项。
- 数据恢复与全量/增量链解析、世界/密钥包恢复见 `docs/BACKUP.md` §8。
- cloudflared 回滚：`sudo cp /var/backups/antifieldcloud/cloudflared-config.yml.<ts> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared`。

## 12. CI 检查

`.github/workflows/ci.yml` 在 push/PR 运行（`concurrency` 取消旧任务、各 job 有超时）：
Node 26 `npm run check` + `npm run build`；服务端覆盖率（`npm run test:coverage`）与前端覆盖率（`npm run test:web:coverage`）；
生产依赖边界（`npm ci --omit=dev` + `scripts/check-prod-deps.mjs`）；`npm audit --omit=dev --audit-level=high`；
gitleaks secret-scan；`shellcheck`（scripts/*.sh、deploy/*.sh）；`nft -c -f deploy/nftables.conf`；
Windows PowerShell job 覆盖**全部** `scripts/*.ps1` 的 PS 5.1 解析 + UTF-8 BOM 检查；Dependabot 月度更新 npm 与 GitHub Actions 依赖。
部署/备份脚本改动必须让 CI 全绿。

版本一致性：`node scripts/check-version.mjs` 比对 `package.json` 与 README/CHANGELOG/ACCEPTANCE/AGENTS、`deploy/env.example` 的
`APP_VERSION`、`docs/DEPLOY.md` 标题与 `package-lock.json` 根版本（已接入 CI check job）。发布前必须通过。

## 13. 常见问题

| 现象 | 处理 |
|---|---|
| `deploy.ps1` SSH 超时 | 直连网线偶发丢包；脚本自带重试；检查 PC 网卡节能、网线、Pi `eth0` |
| `npm ci` 失败 | 确认 Pi 可访问 npm registry；使用 `/usr/local/bin/npm`；查看 `journalctl -u antifieldcloud` |
| 部署健康检查失败 | 脚本已自动回滚；看输出的 journalctl 与迁移前 DB 快照路径；修复后重新部署 |
| 公网 502 | `systemctl status cloudflared`；确认 app 在 3000 监听；DNS 是否 Proxied |
| 上传 >100MB 返回 413 | Cloudflare 套餐请求体上限；调小 `MAX_UPLOAD_BYTES` 或升级套餐，前端会提示大小限制 |
| 登录 429 | 15 分钟内失败次数过多；等待或重启应用清空内存限流 |
| 白名单 502 | RCON 不可用：`ss -tlnp | grep 25575`，`sudo journalctl -u minecraft` |
| `ai` 二次密码 | opencode 自身 Basic UI；按第 6 节输入一次，后续浏览器记住 |
| 内存 cgroup 缺失 | 按第 8 节移除 `cgroup_disable=memory` 后重启；`smoke.ps1` 会检查 |
| 备份 pending 堆积 | 先修直连/计划任务；pending 不会因空间清理被删；查 `backup.log` 与 `--pending` |
| 备份面板红色 | 计划任务失败/超过 48h：查任务 LastTaskResult、`%LOCALAPPDATA%\AntifieldCloud\backup.log` |
| 密钥包未生成 | 按 `docs/BACKUP.md` §5 安装 age 并写入公钥；不影响普通归档 |
| 磁盘占用 | `df -h /`、`du -sh /var/lib/antifieldcloud/*`；配额 10 GiB；release/备份保留策略见文档 |
| 公网页面空白 / 入口脚本未执行 | app 入口脚本已加 `data-cfasync="false"`；ai 代理按 `OPENCODE_HTML_MODE` 处理；若仍异常，在 Cloudflare Speed → Optimization/Configuration Rules 关闭 `ai` 的 Rocket Loader |
| 备份密钥包状态红/unknown | 看 `backup-pull.json` 的 `secretsOk/secretsLastError`；检查 age 公钥权限与 `backup-secrets.sh`；文件归档成功不等于密钥包成功 |
| 备份恢复 403 restore_disabled | env 未设 `BACKUP_RESTORE_ENABLED=true` 或未重启应用 |
| 大文件上传 413 | 普通单请求上限 100 MiB；>100 MiB 应自动走分片（`CHUNKED_UPLOAD_ENABLED=true`、5 GiB 上限）。检查 `/api/version` 的 `chunkedUploadEnabled/chunkSizeBytes/chunkMaxFileBytes`，以及块请求是否被 Cloudflare 单请求限制拦截 |
| 校园网暂时无法解析 | 递归 DNS 负缓存（约 30 分钟）；等待或用手机流量验证。不要修改 `mc.example.com` |
| 指标趋势卡空白 | 新部署尚无样本（等待 60s×N）或 `METRICS_ENABLED=false`；看 `/api/metrics?range=1h` 的 `sampleCount` 与 `journalctl` 采样告警 |
| 笔记附件 413/409 | 单文件 ≤`NOTE_ATTACHMENT_MAX_BYTES`（25 MiB）、每请求 1–5、每笔记 ≤100；配额不足 409、磁盘不足 507 |
| 多文件分享 409 share_bundle | 旧单文件 `/content` 不支持多文件；公开页/客户端改用 `items/:itemId/content` |
| 世界备份 unit 失败 | `journalctl -u antifieldcloud-world`；看 `world-backup-status.json` 的 `error/message`；常见 RCON 不可达、磁盘余量不足、save-all 超时；修复后 `systemctl start antifieldcloud-world.service` |
| 世界备份未按时运行 | `systemctl list-timers antifieldcloud-world.timer`；确认 `Persistent=true` 后关机错过的运行会在下次启动补做；检查 unit 是否被 `StartLimit` 限制 |
| 世界拉取失败/不 ack | 看 PC `%LOCALAPPDATA%\AntifieldCloud\world-pull.log` 与 Pi `world-pull-status.json`；失败保留远端归档，重跑即可 |
| 世界/演练状态 unknown | 任务未安装或从未运行；面板按 unknown 展示、告警可能触发；按 §9.4/§9.5 安装并跑一次 |
| 应用了新 nftables 后 SSH 断开 | 来源网段不在 `169.254.77.0/24`/`172.23.88.0/21`；用物理键鼠或已建立连接恢复 `.bak` 并 `systemctl restart nftables` |
| 旧世界 cron 与新 timer 重复备份 | `crontab -u antifield -l` 确认无 `minecraft-backups` 行；旧归档按 §14/`docs/BACKUP.md` §6.4 手动清理 |
| 部署脚本报“工作树不干净” | 先提交；确需脏发布用 `-AllowDirty` 并在验收记录标注 commit/改动 |
| 部署后 smoke 失败但服务正常 | v0.5.0 起默认门禁失败；看 FAIL 项修复后重跑 `smoke.ps1`；临时放行用 `-AllowSmokeFailure` 并记录未通过项 |
| `/healthz` 版本仍是旧版 | 检查 `/etc/antifieldcloud/env` 的 `APP_VERSION` 与 `package.json`；回滚后尤其要确认已还原上一 release 版本 |
| Bot Webhook 404 | `BOT_ENABLED=false`、缺 `BOT_SECRET_KEY`、Bot `enabled=false` 或 botId 错；先看 `/api/bots/status` 与 §9.9 |
| Bot Webhook 302 | Cloudflare Access 未 bypass `/api/bot/webhook/*`（§5.2） |
| Bot Webhook 401 | 平台签名/时间戳/Public Key/Signing Secret 不匹配；QQ 检查 AppSecret、Ed25519 头与时间戳是否在 ±300 秒 |
| QQ 回调地址校验失败 | AppSecret 错、AppID 与 Secret 不配对、请求未带 `op=13` 的 `plain_token/event_ts`；看 `bot.webhook.rejected` 与 journald（不打印 AppSecret） |
| QQ 发布/媒体 400 | QQ 仅文本、单条 ≤2000 字符；请求带 `mediaFileIds` 会被拒绝（`qq_media_unsupported`） |
| `/ask` 不可用 | `BOT_AI_ENABLED=false`、用户未命中命令白名单、超过 `BOT_AI_RATE_PER_HOUR`，或 OpenCode 不可达/超时；看审计 `bot.ai.ask` 与 `journalctl -u opencode` |
| 通知被静默延后 | 目标设置了 `quietStartMinute/quietEndMinute` 且当前在窗口内；通知的 `next_attempt_at` 为窗口结束，属预期 |
| 发布提示 publish_confirm_required | 请求体缺少 `confirmText:'PUBLISH'`；TOTP 不能替代该二次确认 |
| smoke Access token 无效 | 同时提供 `-AccessClientId/-AccessClientSecret`、确认 token 未过期且策略绑定 `app`；不要使用全局/宽范围 token |
| nftables restart 后封禁丢失 | drop-in 未安装/未 `daemon-reload`/dbfile 不可写；手工 reload 不触发，需 `systemctl restart fail2ban`（§9.7） |
| Bot 管理页提示缺少密钥 | `BOT_SECRET_KEY` 未写入或不是 base64 32 字节；用 `bootstrap-env.sh --force` 生成/复用后重启（不要手工替换旧 key） |
| Bot 发布 400/401 | 缺 `totpCode`、TOTP 过期/重放、目标是 user、文本超平台上限、媒体 >5 个/单 >10 MiB/总 >50 MiB、QQ 带媒体、定时超 30 天；见 API §14 |
| Bot Chat 无回复 | `BOT_AI_ENABLED=false`、目标未 `allow_chat`、群/频道未 @/回复、普通频道消息被忽略、6/min 或 10/h 限流；看 `bot.chat.denied` 与审计 |
| Discord Gateway 报错/未连接 | 检查 `BOT_DISCORD_GATEWAY_ENABLED`、Developer Portal 的 Message Content Intent、Bot Token、`gateway.discord.gg` 出站/代理；`gateway.lastError` 不含 Token |
| Bot 投递 dead/不重试 | 平台 Token 失效/权限不足/被限流；修 Token 后 `POST /api/bots/:id/deliveries/:id/retry`；`bot_deliveries.last_error` 有短错误码 |
| SSH 仅公钥后无法登录 | 24h 回滚窗口内删除 `/etc/ssh/sshd_config.d/00-antifield-hardening.conf` → `sshd -t` → `systemctl reload ssh`；用已建立会话/物理键鼠操作（§9.7） |
| fail2ban 未封禁/启动失败 | `fail2ban-client -t` 校验配置；`journalctl -u fail2ban -n 50`；确认 nftables 后端与 `sshd` jail 已启用、`bantime=86400`；日志后端（log2ram/journald）可读 |
| nftables 重载后封禁列表清空 | fail2ban 的封禁 set 随 nftables 重建丢失：`systemctl restart fail2ban` 后 `fail2ban-client status sshd` 复核；把该步骤写进 nftables 变更清单 |

## 14. 磁盘清理与保留策略

> v0.5.2 清理只允许 **孤儿归档 / 保留期到期 / 旧 release / 过期备份** 四类；任何操作先只读确认 + 二次确认，**不删除用户文件**。
> `DATA_DIR/bot-memory` 不属于上述四类，仅在确认无对应 Bot 记忆或 `bot_ai_memories` 时按保留期/人工清理，不得借“清理”删除活跃记忆。
> 不执行 `rm -rf /var/lib/antifieldcloud`、`/home/antifield/minecraft-server`、`/var/lib/opencode` 或 `data/` 下用户内容。

### 14.1 只读盘点（先做）

```bash
df -hT /; df -i /; du -xhd1 /var/lib/antifieldcloud /opt/antifieldcloud /home/antifield 2>/dev/null
journalctl --disk-usage
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs --pending   # 只看 pending/孤儿/partials
ls -1dt /opt/antifieldcloud/releases/* | head -n 5
ls -lh /var/lib/antifieldcloud/world-backups/ /var/lib/antifieldcloud/backups/secrets/ 2>/dev/null
```

### 14.2 可清理清单（仅四类，逐项确认）

| 类别 | 条件 | 命令示例 | 确认点 |
|---|---|---|---|
| 孤儿应用归档 | DB 无记录（`--pending.orphans`）且不是 pending/已确认 | `sudo rm -f /var/lib/antifieldcloud/backups/<name>.tar.gz{,.part,.sha256}` | 先列文件 + 记录 SHA/大小；确认与 `--pending` 输出一致 |
| 保留期到期备份 | PC `daily` >30 天、`weekly` >56 天、`secrets` >90 天；`db-predeploy-*.sqlite` 超过最新 10 个 | 在 PC 按目录/日期删除；Pi 只删最旧的 `db-predeploy-*` | 至少保留一份可解包副本；不删最新 full 链；不删最近迁移快照 |
| 旧 release | 不是 `current`/`previous`，且早于两代 | `sudo rm -rf /opt/antifieldcloud/releases/<old>` | `readlink -f current/previous` 后确认 |
| 过期备份残片 | 已删除归档遗留的 `.part`/`.sha256`（无对应归档）或超 6h 的世界 `.part` | `sudo rm -f <对应残片>` | 先确认无同名正式归档；世界 `.part` 由脚本清理，手工仅限确认无人运行时 |

- 以上四类之外（apt 包缓存、journald、开发缓存、cloudflared 回滚二进制、Bot 事件/指标/审计自动保留）**不属本清理清单**，
  按系统维护/各自保留策略另行评估，不得借“清理”删除应用数据或用户文件。
- 世界归档/世界拉取归档由脚本滚动保留 4 份，**不手工删除**；PC `world\` 同理。

### 14.3 明确不清理

- 除 §14.2 明确允许的孤儿/过期项外，`/var/lib/antifieldcloud` 的 DB、`files/`、`backups/`（pending/acked/imports/secrets）、`world-backups/`、`*-status.json` 一律不清理。
- `/var/lib/opencode`、`/etc/opencode`、`/etc/antifieldcloud/env`、`/etc/cloudflared/*`、`/home/antifield/minecraft-server/world`。
- 当前与 previous release、`/var/swap`、`preflight/age-key`、离线 age 私钥。
- 旧 `minecraft-backups` 已于 v0.4.1 清理；如再次出现，仅在确认 PC 副本可解包后按 `docs/BACKUP.md` §6.4 处理。
- 用户文件（`files/` 与笔记附件）永不因“磁盘清理”删除；需要释放空间时用应用的回收站/配额流程。

### 14.4 二次确认与记录

1. 对每个待删文件先 `ls -l` + `sha256sum`（归档）并记录到运维日志/`docs/ACCEPTANCE.md`；
2. 删除前再次 `df -hT /` 记录释放前余量；
3. 删除后运行 `smoke.ps1` 与 `backup.mjs --pending`，确认无新增 pending/失败；
4. 任何“孤儿”判断以 DB/CLI 输出为准，不凭文件名猜测；不确定时保留并上报。
5. `world-backups` 由脚本保留最新 4 份；PC `world\` 同样保留 4 份；不要手动删 `world-<UTC>.tar.gz` 或 `.sha256`。
6. `metrics_samples` 30 天、`audit_log`/`alert_events` 90 天由应用自动清理；`db-predeploy-*.sqlite` 保留最新 10 个；不要手工删表。
