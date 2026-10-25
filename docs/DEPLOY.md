# 部署手册（Raspberry Pi 5 / Debian 13，v0.7.1）

> 所有 Agent 会话与人工操作都按本文件执行；涉及系统状态的操作要逐条确认。
> 目标运行位置：`/opt/antifieldcloud/current`，服务用户 `antifieldcloud`，监听 `127.0.0.1:3000`。
> 公开仓库中的域名/IP/网段/路径均为**占位/示例值**（`app.<domain>`/`ai.<domain>`/`mc.<domain>`、TEST-NET 网段）；
> **安装前按 `.local/DEPLOYMENT.md`（gitignored）替换为实际值**。

## 0. 拓扑与前置

- Pi：`antifield@192.0.2.10`（直连网线；TEST-NET-1 占位，实际网段见 `.local/DEPLOYMENT.md`），WiFi 示例 `198.51.100.10`（TEST-NET-2 占位；实际校园网段见 `.local`）。
- 域名：`app.<domain>`（应用）、`ai.<domain>`（opencode 反代）、`mc.<domain>`（Minecraft，现状保留），Cloudflare Tunnel 名称为 `pi`（UUID 见 `.local`）。
- 现有服务不改：Minecraft、SakuraFRP、opencode、RDP/桌面；nginx/certbot 旧入口已移除。
- 本仓库从 Windows PC 通过 SSH 部署；PC 需有 `C:\Users\<user>\.ssh\id_ed25519`。
- 非敏感部署值（域名/路径/公网 MC 地址）写入 Pi 的 `/etc/antifieldcloud/deploy.conf`（root 只读，不提交仓库），
  由 `bootstrap-env.sh` 读取；密钥只来自现有服务配置或离线保管。
- 当前 schema **v16**（本版 v0.7.1 **无新迁移**；迁移 16 新增 `bot_group_roles` 群聊角色卡表，群消息模式复用 `bot_targets.chat_trigger`；迁移 15 保留 `bot_targets.qq_number` 兼容列；迁移 14 新增 `bot_memory_items`/`bot_memory_state`，迁移 5 结构、迁移 6 孤儿 shares 数据修复、迁移 7 新增 Bot 表、迁移 8 重建 Bot 表扩展 QQ/静默/AI 会话、
  迁移 9 增加 `bot_targets.allow_chat`/`bot_ai_memories`/`bot_inbound_targets`、迁移 10 把 `bot_ai_sessions` 主键加入 mode、迁移 11 新增 `bot_chat_roles` 私聊角色卡、
  迁移 12 增加 `bot_targets.chat_trigger` 与 `bot_events` 诊断列/索引、迁移 13 删除非 QQ Bot 及其级联数据）；迁移前会执行 `PRAGMA foreign_key_check`，
  其它外键损坏会拒绝启动；数据库 schema 高于程序支持版本时拒绝启动。部署脚本切换前会自动做迁移前 DB 快照，回滚必须使用该快照。
- **v0.7.1（已发布：Tag `v0.7.1` + GitHub Release；本版无 schema 迁移，保持 v16）**：群聊共享唯一 OpenCode Chat 会话（合成键 `__group__`，群内按目标串行；私聊仍每用户独立会话）；真实用户仍用于限流/记忆/审计/发送工具令牌。生产 release `20261025T031856Z`/commit `d8bdfc5`，`/healthz` v0.7.1/schema16；迁移前快照 `db-predeploy-20261025T031929034Z.sqlite`（sha256 `c61e1e32…47cc`）；部署内 smoke 23/23、完整 Access smoke **33/0/0/2**（env 已清理；Windows 任务标记 0.7.1/脚本 SHA 一致，手动运行 result=0）；启动时清理旧版分用户群映射（生产已清零）；真实 Bot Test 群两个成员进入同一共享会话。首次群聊会自动清理旧映射并尽力删除远端旧会话。
- **v0.7.0（已发布：Tag `v0.7.0` + GitHub Release；本版无 schema 迁移，保持 v16）**：第六轮审计修复 + 备份整包加密 + 异地副本（默认关闭）；OpenCode **v2.1.4**。
  部署步骤：按 §3.0 走 `deploy.ps1`（自动迁移前快照/回滚/`release.json`/`deploy-history.log`），smoke 使用
  `-ExpectedVersion 0.7.0 -ExpectedSchemaVersion 16 -ExpectedOpenCodeVersion 2.1.4`；OpenCode 升级按 §3.2 矩阵；
  备份加密/异地副本默认关闭，启用顺序与回滚见 §9.10/§9.11。生产指纹：release `20261025T021609Z`/commit `4f40ccd`、`/healthz` v0.7.0/schema16；部署内 smoke 23/23、完整 Access smoke 31/0/1/2；D-20 Bot 连续外发 1000ms 与 DSML 原始工具调用回显修复均已包含；Tag `v0.7.0` + GitHub Release 已发布。
- **上一版本 v0.6.6（已发布：Tag `v0.6.6` + GitHub Release）**：系统提示词精简 + 群聊用户名 head + 群聊共享记忆 + 记忆两栏/迁移；schema v16（无迁移）。
  生产 release/commit/备份证据与回滚目标见 `docs/ACCEPTANCE.md`、`CHANGELOG.md` 与历史发布记录；回滚可切回 v0.6.6 release（同 schema16）。
- **更早版本**：v0.6.5/v0.6.4/v0.6.3/v0.6.2/v0.6.1/v0.6.0/v0.5.x 的部署证据、release 目录与回滚对照见 `docs/ACCEPTANCE.md`/`CHANGELOG.md`。
  历史 release 保留用于回滚；schema 无 down 迁移，回滚必须同时恢复迁移前 DB 快照（见 §11）。
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

nftables 默认策略与网段（详见 §9；`deploy/nftables.conf` 使用 TEST-NET 占位，安装前按实际替换）：默认 drop 入站；22 仅 `192.0.2.0/24` + `198.51.100.0/24`（示例占位）且新建连接限速 20/min；
25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`；80 不再放行。

## 2. 非敏感部署值与环境文件

```bash
# 只写非敏感值，不写任何密钥；实际域名/路径按 .local/DEPLOYMENT.md 填写
sudo install -o root -g root -m 0640 /dev/stdin /etc/antifieldcloud/deploy.conf <<'EOF'
APP_ORIGIN=https://app.example.com
AI_ORIGIN=https://ai.example.com
# v0.6.0 起仅用于清理旧父域 Cookie（不再设置新 Cookie）；新装可留空，生产建议保留以精确清理
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
- 可选参数：`--app-origin= --ai-origin= --cookie-domain=`（v0.6.0 起仅用于清理旧父域 Cookie）`--mc-public-address= --data-dir= --web-dist-dir= --admin-username=`。
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
  - `BOT_ENABLED=false`：总开关；**默认关闭**，完成 QQ 平台联调后再显式改为 true 并重启。
  - `BOT_SECRET_KEY`：32 字节 base64（`openssl rand -base64 32` 等价），AES-256-GCM 加密 QQ AppSecret；必须与 DB 一起备份，
    丢失后已存 AppSecret 只能重新录入。`bootstrap-env.sh --force` 复用旧值，**不要手工替换**。
  - `BOT_WEBHOOK_MAX_BODY_BYTES=262144`：Webhook 原始 body 上限（16 KiB–1 MiB）。
  - `BOT_DELIVERY_INTERVAL_SECONDS=30`（5–300）、`BOT_DELIVERY_MAX_ATTEMPTS=5`（1–20）：队列扫描与最大尝试次数。
  - `BOT_EVENT_RETENTION_DAYS=7`（1–90）：事件去重记录保留；已发送投递/发布固定 30 天清理。
  - `BOT_COMMAND_RATE_PER_MINUTE=120`（1–600，v0.5.9 放宽）：每 Bot × 用户命令限流。
  - `BOT_PUBLISH_MAX_SCHEDULED_DAYS=30`（1–365）、`BOT_MAX_BOTS=10`（1–50）。
- v0.5.1 新增 Bot AI env（`bootstrap-env.sh` 已纳管，`--force` 不会重置已有非空值；默认关闭）：
  - `BOT_AI_ENABLED=false`：普通消息 Chat 的 AI 总开关（v0.5.9 起 AI 仅 Chat）；关闭时 Chat 不调用 AI。
  - `BOT_AI_PROVIDER=`、`BOT_AI_MODEL=`：可选 OpenCode provider/model，二者同时设置才指定模型；为空用 OpenCode 默认模型。
  - `BOT_AI_TIMEOUT_SECONDS=60`（10–180）：单次 AI 请求/等待超时。
  - `BOT_AI_MAX_PROMPT_CHARS=2000`（100–8000）：提示词截断。
  - `BOT_AI_RATE_PER_HOUR=120`（1–600，v0.5.9 放宽）：每 Bot×用户每小时 AI 调用上限（仅 Chat）。
  - `BOT_AI_SESSION_RETENTION_DAYS=7`（1–90）：`bot_ai_sessions` 映射保留；v0.5.10 起长期记忆保留独立（见下），会话清理不删除远端会话。
- v0.5.2 新增 Bot Chat/记忆 env（`bootstrap-env.sh` 已纳管，`--force` 不会重置已有非空值）：
  - `BOT_CHAT_RATE_PER_MINUTE=30`（1–120，v0.5.9 放宽）：普通消息 Chat 每 Bot×用户每分钟上限；仍受 `BOT_AI_RATE_PER_HOUR` 总量约束。
  - `BOT_AI_MEMORY_MAX_CHARS=4096`（512–16384）：每 Bot×用户长期记忆摘要上限。
- v0.5.10 新增记忆保留/合并 env（`bootstrap-env.sh` 已纳管）：
  - `BOT_AI_MEMORY_RETENTION_DAYS=365`（30–3650）：fact/project/relationship 条目 TTL 天数（v0.5.11 起），独立于 7 天会话保留。
  - `BOT_AI_MEMORY_BATCH_MESSAGES=3`（1–20）：累计多少轮对话触发一次记忆抽取。
  - `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`（0 或 10–3600）：用户空闲多少秒触发记忆抽取；0 关闭空闲触发。
  - v0.5.10 同时删除 `BOT_PROXY_URL`（Pi 直连），生产 env 需删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`。
- v0.5.11 新增结构化记忆 env（`bootstrap-env.sh` 已纳管，生产需在部署前写入）：
  - `BOT_MEMORY_MAX_ITEMS=200`（20–1000）：每 Bot×用户条目容量上限；超限先淘汰低重要度非核心条目（profile/preference 受保护）。
  - `BOT_MEMORY_PROMPT_MAX_CHARS=3000`（500–8000）：召回注入字符预算。
  - `BOT_MEMORY_PROMPT_MAX_ITEMS=12`（1–50）：召回注入条数预算。
  - `BOT_MEMORY_TTL_EPISODE_DAYS=90`（1–365）：episode 条目 TTL。
  - `BOT_MEMORY_TTL_TASK_DAYS=30`（1–180）：task 条目 TTL。
  - fact/project/relationship 的 TTL 沿用 `BOT_AI_MEMORY_RETENTION_DAYS=365`；legacy fallback 上限沿用 `BOT_AI_MEMORY_MAX_CHARS`。.TrimEnd
- v0.5.4 曾新增双模式提示词 env（**v0.5.9 已删除**，`bootstrap-env.sh` 不再纳管）：
  - `BOT_AI_TASK_PROMPT`（v0.5.9 已删除）：原 `/ask` 任务提示覆盖；生产 env 需删除该行。
  - `BOT_AI_CHAT_PROMPT`（v0.5.9 已删除）：原 Chat 提示覆盖；生产 env 需删除该行。
  - v0.5.9 起 AI 提示词固定为「角色卡 + 固定安全边界 + 记忆 + 用户」，不再有 env 覆盖；固定安全边界不能通过环境变量移除；旧 `BOT_AI_SYSTEM_PROMPT` 已废弃且不再读取，部署时应删除。
- v0.5.7 新增 AI 回答/图片 env（`bootstrap-env.sh` 已纳管，`--force` 不会重置已有非空值）：
  - `BOT_AI_MAX_REPLY_CHARS=4000`（1000–12000）：AI 单次回答字符上限；QQ 适配器再按 2000 字符分段发送。
  - `BOT_AI_VISION_ENABLED=true`（v0.5.8 默认开启）：QQ 入站图片理解总开关。开启需 OpenCode 支持 prompt files 与模型支持 image 输入（生产已完成只读验证：data URL + `opencode-go/deepseek-v4.1-flash`）；
    关闭后图片降级为纯文字回答。**v0.5.8 已删除**：`BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_BYTES`、`BOT_PUBLISH_MAX_MEDIA_FILES`、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES`（`bootstrap-env.sh` 不再纳管）。
  - `BOT_AI_IMAGE_MAX_BYTES=10485760`（1–20 MiB）：单张入站图片上限；图片只放行 image mime、QQ CDN 固定域名后缀、不落盘，失败降级为纯文字。

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

### 3.0 v0.7.1 应用部署步骤（当前版本；schema 保持 v16，无迁移）

1. **本地发布前校验**（PC）：`npm run check`、`npm run build`、`node scripts/check-version.mjs`（严格模式，含 schema/OpenCode 交叉校验）、
   `node scripts/check-prod-deps.mjs`；2026-10-25 本地实测：`npm test` 491（Bot 定向 193）、`test:web` 222、服务端覆盖率 92.75/78.23/87.82、前端 52.31/47.32/45.02、bundle `index-C0QZV4hZ.js` 726.72 kB、check-version `version ok 0.7.1`、check-prod-deps 通过。工作树干净后记录 commit。
2. **部署前只读检查**：`backup.mjs --pending` 无异常、PC 最新 `.sha256` 可校验、`secretsOk=true`；`df -hT /` 余量充足（开启加密后按 2× 归档空间预留）；
   记录当前 `/healthz` 与 OpenCode 版本；`deploy/tool-versions.json` 为期望 schema/OpenCode 来源。
3. **OpenCode 2.1.4 升级（先于应用部署，按 §3.2）**：备份 v2.1.3 二进制/data/env/unit/MCP 配置 → `opencode upgrade 2.1.4` → 14 项矩阵验收 → 失败回滚；
   升级与回滚矩阵结果记为发布门禁证据。
4. **部署**：`.\scripts\deploy.ps1 -PiHost <直连 IP>`；脚本执行预检/构建/上传 tar SHA-256 校验/`npm ci --omit=dev`/迁移前 DB 快照/
   `APP_VERSION=0.7.1` 注入/切换 current/restart（失败进入回滚）/健康检查/只读 smoke；成功后写 `release.json`/`deploy-history.log`。
5. **验证**：预期 `/healthz` = `{"ok":true,"version":"0.7.1","schemaVersion":16,...}`；smoke 使用
   `.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.7.1 -ExpectedSchemaVersion 16 -ExpectedOpenCodeVersion 2.1.4`
   （带 Access token 再跑完整版）。新检查包括 OpenCode 版本/MCP 进程/`/api/mcp`/fail2ban/unit 漂移/env 漂移/加密配置/异地状态/本地任务安装标记；
   缺状态文件返回 `SKIP:` 不计入 PASS。
6. **加密/异地（默认关闭，按需）**：按 §9.10 启用备份整包加密（先私钥解密演练）、§9.11 启用异地副本；默认不启用时状态卡显示“未启用/未配置”。
7. **部署后备份与证据**：完成 `snapshot-*.tar.gz`（或 `.age` + `.meta.json`）+ 密钥包，PC 拉取/ack；回填 `docs/ACCEPTANCE.md` 待填清单、
   CHANGELOG/README/AGENTS/DEPLOY 证据；用户验收后再 Tag/GitHub Release。
8. **回滚**：schema 无迁移，切回 v0.6.6 release + 还原同版本 `APP_VERSION` 即可；若 DB 因任何原因需回退，仍使用本次部署前快照。
   OpenCode 回滚见 §3.2；备份加密回滚=关闭开关恢复明文（已生成 `.age` 保留）；异地回滚=禁用 offsite 任务。

### 3.1 历史：v0.5.11 应用部署步骤（schema v14；仅回滚/历史参考，当前不适用）

顺序固定为：**本地校验 → 备份/校验 → 生产 env 新增 5 个 `BOT_MEMORY_*` → 部署（迁移 14 + 自动迁移前 DB 快照）→ 验证 healthz 0.5.11/schema 14 与 smoke → 真实记忆验收（抽取/召回/`/memory`/管理 API）→ legacy 清理 CLI → 部署后备份与验收回填**。
v0.5.11 **schema 升到 v14**（迁移 14 新增 `bot_memory_items`/`bot_memory_state`，不可逆）；**v0.5.10 不支持 schema v14，回滚只能恢复迁移前 DB 快照**。

1. **本地与发布前校验**（PC）：
   - `npm run check`、`npm run build`；确认 `package.json` 版本 `0.5.11`，`node scripts/check-version.mjs` 通过（含 env.example/DEPLOY 标题/lock 根版本）。
   - 测试基线（Lead 实测 2026-10-23）：`npm test` **360**（v0.5.10 的 341 + 新增 19：记忆存储/抽取/检索/迁移/管理 API/`/memory` 等）、`npm run test:web` **162**（30 文件，+5）、`npm run typecheck` 通过；覆盖率 Lines **92.05%** / Branches **77.43%** / Functions **86.39%**、`npm run build` 通过。
   - 确认工作树干净；`git rev-parse --short HEAD` 记入发布记录（脏发布只允许 `-AllowDirty`，并在 `docs/ACCEPTANCE.md` 标注）。
   - 记录升级前 `/healthz`（生产为 0.5.10/schema 13），升级后应为 **0.5.11/schema 14**，便于回滚对照。
2. **备份与校验**（Pi，只读优先）：
   - `sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs --pending`：确认无异常 pending/孤儿；
     如 pending 未拉取，先在 PC 跑一次 `backup-pull.ps1` 完成 ack。
   - 确认 PC 最新应用归档 `.sha256` 可校验、密钥包 `secretsOk=true`（含 `/etc/antifieldcloud/env`）、世界备份/拉取状态新鲜；
     必要时手跑 `.\scripts\drill.ps1 -ExpectedSchemaVersion 14` 并保存报告。
   - 记录磁盘余量：`df -hT /`；迁移 14 不可逆，必须确认迁移前快照可写且可用于回滚（建议 ≥2 GiB）。
3. **生产 env 新增结构化记忆变量（v0.5.11 必须；与部署同一重启生效）**：
   ```bash
   sudo cp -a /etc/antifieldcloud/env /var/backups/antifieldcloud/env.v0510.$(date -u +%Y%m%dT%H%M%SZ)
   for kv in BOT_MEMORY_MAX_ITEMS=200 BOT_MEMORY_PROMPT_MAX_CHARS=3000 BOT_MEMORY_PROMPT_MAX_ITEMS=12 \
             BOT_MEMORY_TTL_EPISODE_DAYS=90 BOT_MEMORY_TTL_TASK_DAYS=30; do
     key=${kv%%=*}; sudo grep -q "^${key}=" /etc/antifieldcloud/env || echo "$kv" | sudo tee -a /etc/antifieldcloud/env >/dev/null
   done
   sudo grep -E '^BOT_MEMORY_(MAX_ITEMS|PROMPT_MAX_CHARS|PROMPT_MAX_ITEMS|TTL_EPISODE_DAYS|TTL_TASK_DAYS)=' /etc/antifieldcloud/env   # 200/3000/12/90/30
   ```
   - 校验 `stat -c '%a %U %G' /etc/antifieldcloud/env` 仍为 `640 root antifieldcloud`；env 备份供回滚（不提交仓库）。
   - 沿用 `BOT_AI_MEMORY_RETENTION_DAYS=365`（fact/project/relationship TTL）、`BOT_AI_MEMORY_BATCH_MESSAGES=3`、`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`、`BOT_AI_MEMORY_MAX_CHARS`（legacy fallback）。
4. **部署（迁移 14，脚本自动迁移前快照）**：
   - `.\scripts\deploy.ps1 -PiHost <直连 IP>`；脚本完成迁移前 DB 快照（`db-predeploy-*.sqlite`）、APP_VERSION 注入、schema 14 迁移、切换、健康检查与只读 smoke。
   - **迁移 14 不可逆**：记录快照路径/sha256；不要删除该快照，回滚必须用它。
5. **验证健康检查、schema 与 smoke**：
   ```bash
   curl -fsS http://127.0.0.1:3000/healthz                       # {"ok":true,"version":"0.5.11","schemaVersion":14,...}
   sudo -u antifieldcloud /usr/local/bin/node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/antifieldcloud/db.sqlite');console.log(db.prepare(\"select value from meta where key='schema_version'\").get(),db.prepare('select count(*) c from bot_memory_items').get(),db.prepare('select count(*) c from bot_memory_state').get(),db.prepare('select count(*) c from bot_ai_memories').get())"
   ```
   期望 `schemaVersion=14`、`bot_memory_items`/`bot_memory_state` 表存在（初始可为 0 行）、`bot_ai_memories` 仍保留 legacy 行。
   - `.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.5.11 -ExpectedSchemaVersion 14`（加 Access token 时附 `-AccessClientId/-AccessClientSecret`）。
6. **真实记忆验收（v0.5.11 变更点）**：
   - 多轮 Chat（≥3 条或空闲 120s）后：`bot_memory_items` 生成条目；`bot.memory.extract` 审计只含计数（upserts/deletes/skipped/pruned）；`bot_ai_memories` 不再作为主写入（仅 legacy/fallback）。
   - 召回：核心 profile/preference/task 优先 + 关键词相关层，注入预算 3000 字/12 条；命中条目 `last_used_at` 更新；`/memory off` 后无注入与抽取，`/memory on` 恢复；未迁移旧摘要 fallback 仍可注入。
   - TTL/容量：检查 `expires_at` 与 `BOT_MEMORY_MAX_ITEMS` 行为（可在测试 Bot 上验证，不要在生产压测）；敏感内容（密钥/URL/内部路径）不落库。
   - `/memory` 展示总条数/类型计数/启停/最近更新（无 key/value）；`/forget confirm` 清空 items/state/legacy 摘要与全部会话（含远端）。
   - 管理 API：用户级列表/条目元数据/单条删除/整用户删除只返回元数据，删除写审计 `bot.memory.delete_item`/`bot.memory.delete_user`。
7. **Legacy 清理（验收通过后执行一次）**：
   - 先 dry-run 核对：`sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/cleanup-legacy-memory.mjs`；
   - 再确认清理：同命令加 `--confirm`；只删除 `legacy_migrated_at` 已置位用户的 `bot_ai_memories` 行与 `DATA_DIR/bot-memory` 镜像，并写审计 `bot.memory.legacy_cleanup`；不输出正文。
   - 清理后复核 `bot_ai_memories` 剩余行（应为未迁移用户或 0），再执行部署后备份并确认 PC 拉取/密钥包 ok。
8. **部署后**：
   - 按 `docs/ACCEPTANCE.md` v0.5.11 填写部署/测试/验收证据（不要提前声明通过）。
   - PC 重装每日任务：`.\scripts\install-backup-task.ps1 -PiHost <直连 IP> -BackupRoot <目录>`，确认 `backup-task.json` 脚本 SHA 更新；手跑一次确认 `secrets=ok`。
   - 世界拉取/演练：任务参数不变；演练改用 `-ExpectedSchemaVersion 14`。
**本次部署与验收证据（2026-10-23）**：

- 最终 release `20261023T022831Z`/commit `931b10d`；同版本早前 release `20261023T021339Z`/`20261023T014328Z` 保留；`/healthz` = `{"ok":true,"version":"0.5.11","schemaVersion":14}`；部署内只读 smoke 16/16、完整 Access smoke 24/24。
- 最终迁移前快照：`/var/lib/antifieldcloud/backups/db-predeploy-20261023T022902018Z.sqlite`（sha256 `937a0bc84dc317e1e815bc480f03b8e065935bed7a1e09bf5edac6da76a98d3c`）；生产 env 5 个 `BOT_MEMORY_*`（640 root:antifieldcloud），运行配置 365/3/120/3000/12/90/30。
- 部署后备份 `snapshot-20261023T023941878Z-inc.tar.gz`（154594 bytes，sha256 `db55178851004dd80353cdbb31213679d61cfc8a0eb72050f8f70a34fe68a21f`，secrets=ok，PC 已拉取/ack）。
- 用户实发验收通过（10:39 CST）：三条 Chat → `bot.memory.extract` rounds=3 ops=2；`/memory` 成功；`/forget confirm` items=2 legacy=0 且未误删其他用户；早前 `/memory off`→Chat 无新 extract→`on`→`/forget` 亦通过；`/bots` 面板用户确认；首次短消息 ops=0 判定提示词过保守，commit `931b10d` 修正后重试 ops=2。
- Legacy 清理 dry-run/`--confirm` 均 users=0 files=0（未迁移用户 2 条未触碰）；环境事件：01:08–01:13 CST Cloudflare 边缘 7844 不可达致 tunnel 短暂中断，重启 cloudflared 恢复，公共 smoke 24/24。

**回滚**：**schema v14 不可逆且 v0.5.10 不支持 v14**；回滚必须 stop → 用迁移前 DB 快照（`db-predeploy-*.sqlite`）恢复 DB → 把 `APP_VERSION` 改回上一 release 版本 → 切回 previous release `20261022T152053Z`（v0.5.10）→ start → 健康检查；手工顺序见 §11。
**不要用未恢复快照的旧 release 启动**（schema 高于程序支持会拒绝启动）。回滚前保留当前 `bot_memory_items`/`bot_memory_state`/`bot_ai_memories` 导出便于核查；`BOT_SECRET_KEY` 不要轮换。
回滚窗口内 `BOT_ENABLED`/`BOT_AI_ENABLED` 保持 false；`BOT_AI_VISION_ENABLED` 可保持 true。fail2ban 的 nftables drop-in 与业务版本无关，回滚应用时无需删除；如需回滚该安全项见 §9.7。
## 3.2 OpenCode v2.1.4 升级与兼容性复核（本机执行，发布门禁）

本版目标 **OpenCode v2.1.4**（当前基线 v2.1.3）。2.1.4 为补丁版：MCP lifecycle 修复（避免重复 spawn/并行停止）、compaction 与 permissions 相关修补；
应用是纯 HTTP 客户端（非 SDK），预期无需业务改造，但**必须按本矩阵硬门禁验收，门禁未过不得声明兼容**，失败按回滚条件切回 v2.1.3。

```bash
# 0) 备份（root）：二进制、data、env、unit、MCP 配置（升级前必须做；现有 /var/backups/opencode 仅有旧 v2.0.32）
TS=$(date -u +%Y%m%dT%H%M%SZ); BK=/var/backups/opencode
sudo install -d -o root -g root -m 0700 "$BK"
sudo tar -C /var/lib/opencode -czf "$BK/opencode-bin-$TS.tar.gz" .opencode/bin/opencode
sudo tar -C /var/lib/opencode --exclude='.opencode/bin' -czf "$BK/opencode-data-$TS.tar.gz" .
sudo cp -a /etc/opencode/opencode.env "$BK/opencode.env.$TS"
sudo cp -a /etc/systemd/system/opencode.service "$BK/opencode.service.$TS"
sudo cp -a /var/lib/opencode/.config/opencode "$BK/opencode-config-$TS" 2>/dev/null || true
sudo cp -a /opt/antifieldcloud/current/scripts/*-mcp.mjs "$BK/" 2>/dev/null || true
echo "$TS" | sudo tee "$BK/last-upgrade-from-v2.1.3"   # 回滚标记

# 1) 升级到固定版本（不要用不带版本的 upgrade；opencode 用户 + curl 安装器）
sudo -u opencode env HOME=/var/lib/opencode \
  /var/lib/opencode/.opencode/bin/opencode upgrade 2.1.4 --method curl
sudo systemctl restart opencode
sudo -u opencode /var/lib/opencode/.opencode/bin/opencode --version   # 必须为 2.1.4
```

**升级后 14 项验证矩阵（全部 PASS 才通过；记录实际值，不在仓库写生产数值）**：

| # | 验证项 | 方法 | 期望/判据 |
|---|---|---|---|
| V1 | 版本/服务 | `opencode --version`、`systemctl is-active opencode`、`journalctl` | `2.1.4`、active、重启后无 error/warn |
| V2 | Basic 会话 API | `GET/POST/DELETE /api/session`（Basic 头，密码从 env 读取不打印） | 200 / 200+`data.id` / 204；DELETE 404 视为不存在 |
| V3 | permissions 接受与语义 | 建 deny-all 会话；再建 `[{deny-all},{allow botmsg_*},{allow searxng_*}]`；deny-all 会话要求 shell 写临时文件 | 创建 200；无 tool 段、目标文件未创建（复跑 v0.6.1 负路径）；记录 permissions 匹配语义 |
| V4 | assistant 消息/part 形状 | 生产模型 prompt “Reply OK”，`GET .../message?order=desc&limit=20&type=assistant` | `content` 含 `{type:'text',text}`（或记录实际形状）；`finish=stop`；形状变化立即评估宽松解析 |
| V5 | wait 端点 | `POST /api/experimental/session/{id}/wait` | 2xx（记录状态码/耗时）；400/404 时轮询回退仍能取到新回复 |
| V6 | 会话列表/归档 | `GET /api/session`；若支持归档则归档测试会话后再 list；`DELETE` 语义 | 记录是否默认含 archived、字段名；DELETE 行为；用于孤儿清理决策 |
| V7 | 图片 prompt files | prompt `{files:[{uri:data:image/png...}]}` | 2xx 且模型识别图片；失败时 `bot_ai_image_unsupported` 降级符合预期 |
| V8 | MCP 进程/生命周期 | `pgrep -af` 两个 MCP、`journalctl -u opencode | grep -i mcp`、重启 opencode | 每服务恰 1 进程；无重复 spawn churn；重启后正常 |
| V9 | MCP 工具可用性 | `tools/list` 或 Bot 会话调用工具 | `searxng_web_search`/`botmsg_send_message` 名称与 permissions 前缀匹配；send 回环 `{ok:true,index}` |
| V10 | 端到端 QQ Chat（真实用户，最小 3 条） | 私聊文本/图片、`/search`、`/memory` | 有回复；`bot.ai.chat`/`bot.memory.extract` 审计正常；无 `bot_ai_*` 错误事件 |
| V11 | 记忆抽取 | 触发 3 轮或空闲 120s | `bot.memory.extract` 有 rounds/ops；一次性会话被 DELETE；无残留孤儿（结合 V6） |
| V12 | 发送工具 | 私聊连续 3–5 轮 | 模型调用 `botmsg_send_message` 时收到 1–5 条；观察是否出现“工具已调用但 `bot_ai_empty_response`” |
| V13 | 搜索 MCP | `/search 关键词` 与普通问句 | 回答附“参考来源”；`bot.search` 审计只有结果数/错误码；无完整 URL |
| V14 | 资源/回滚窗口 | 磁盘、内存、24h journal、OpenCode DB 体积 | DB 体积增长正常；无 MCP 重复进程；可随时按回滚条件切回 v2.1.3 |

**回滚条件（任一即回滚 OpenCode，不改应用代码/DB）**：① 创建会话/prompt 4xx 或 wait 不可用且轮询也取不到文本；
② 连续 3 次 Chat 出现 `bot_ai_empty_response`/`bot_ai_http_error`；③ `GET /api/bots/status` 显示 `aiToolIsolation.supported=false` 且确认为 permissions 拒绝；
④ MCP 工具缺失/命名变化导致 `botmsg` 不可用且回退不满足业务；⑤ `session.list`/`DELETE` 语义变化导致误删或 404 重建失效。

**回滚动作**：`sudo systemctl stop opencode` → 用备份的 `.opencode/bin/opencode` 覆盖 / 必要时恢复 data tar 与 `opencode-config` →
`sudo systemctl start opencode` → 按 V1–V5 复验；应用侧无需回滚（无 schema 迁移）。OpenCode 原生按钮/WS 实时事件仍需浏览器复测。
备份保留到下一轮确认稳定（建议 ≥7 天）再清理。

**MCP 配置属主约束（安装脚本已修复）**：`/var/lib/opencode/.config/opencode/opencode.json` 必须由 `opencode:opencode` 拥有且 `0640`；root 写的临时文件经 `os.replace` 后若保留 root 属主，OpenCode 以 opencode 用户读不到配置，会表现为 `/api/mcp` 仅 `opencode_console`、Bot 发送工具/搜索 MCP 不加载。运行 `install-bot-tool-mcp.sh` / `install-searxng-mcp.sh` 后应 `stat -c '%a %U %G'` 校验并重启 OpenCode；脚本现已内置 `chown opencode:opencode`。MCP 为懒加载，重启后 `/api/mcp` 可能需要数秒至十余秒才显示 connected，冒烟脚本对 MCP 检查有重试。

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
# 带 Access token 的完整 smoke：-ExpectedVersion 0.7.1 -ExpectedSchemaVersion 16 -ExpectedOpenCodeVersion 2.1.4
```

验证记录（2026-10-23）：`opencode --version=v2.1.3`；Basic `GET/POST/DELETE /api/session` 200/200/204；带 deny-all `permissions` 创建会话 200；生产模型 `opencode-go/deepseek-v4.1-flash` prompt 200、wait 204、assistant content `[{type:"text",text:"OK"}]`、finish=stop；应用 `/healthz` 200、公开 ai 未登录 401；本地 `opencode-shim`/`opencode-proxy` 19 用例通过。
回滚：`sudo install -m 0755 /usr/local/bin/node.v26.11.1 /usr/local/bin/node && sudo systemctl restart antifieldcloud`，
再跑本机 healthz + smoke；旧二进制保留至下一轮确认稳定后删除。Node 更新不触碰 DB，无需 schema 回滚；若同时更新 npm/npx 才需同步 nvm 目录。

### 3.4 Windows Bot 代理隧道（v0.5.10 已移除）

v0.5.10 起 Bot 出站改为 Pi 直连，仓库已删除 `scripts/discord-tunnel.ps1`/`discord-tunnel.vbs`/`install-tunnel-task.ps1`，PC 计划任务 `AntifieldCloudDiscordTunnel` 已移除；
生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`（空值）。不需要再安装/维护任何 Windows 隧道任务；
若外网不可达，请检查 Pi 路由/DNS/出站防火墙，而不是恢复旧代理变量（新版本不再读取）。

### 3.5 SearXNG 私有搜索（v0.6.1，Bot 联网搜索）

目标：只在本机 `127.0.0.1:8888` 提供 JSON 搜索，不暴露公网；使用系统 Python venv + systemd，不引入 Docker。

```bash
# 1) 在仓库根目录执行安装脚本（Pi 上以 root）；幂等，不覆盖已有 settings.yml。
sudo bash scripts/install-searxng.sh
# 2) 验证 JSON 搜索（生产网络仅启用 Bing；Google/DuckDuckGo/Brave 会超时，不要启用）
curl -fsS --max-time 20 \
  'http://127.0.0.1:8888/search?q=AntifieldCloud&format=json&engines=bing' | head -c 500
# 3) 应用 env（/etc/antifieldcloud/env）追加/修改；然后重启应用
BOT_SEARCH_ENABLED=true
BOT_SEARCH_URL=http://127.0.0.1:8888
BOT_SEARCH_MODE=mcp
BOT_SEARCH_ENGINES=bing
# 其余 BOT_SEARCH_* 使用 deploy/env.example 默认值；bootstrap-env.sh 已纳管。
# 4) 安装 SearXNG MCP 工具并更新 OpenCode 配置（重启 opencode，不影响 Minecraft）
sudo bash scripts/install-searxng-mcp.sh
# 5) 重启应用使 Bot 会话 permissions/提示词生效
sudo systemctl restart antifieldcloud
```

- 安装内容：`/opt/searxng`（git，当前 commit 记录在安装输出）、`/opt/searxng-venv`、`/etc/searxng/settings.yml`（0600/0640 root:searxng，随机 secret）、`/etc/systemd/system/searxng.service`、用户 `searxng`；模板见 `deploy/searxng/settings.yml.example` 与 `deploy/systemd/searxng.service`。
- 网络边界：SearXNG 仅监听 loopback；`BOT_SEARCH_URL` 只接受 http/https、拒绝凭据；应用不抓取搜索结果网页，不保存查询正文；生产只启用 Bing（`BOT_SEARCH_ENGINES=bing`）。
- 验证：SearXNG `systemctl is-active searxng` = active；JSON 返回 `results` 数组；应用重启后 `/healthz` normal；QQ 发 `/search 关键词` 或“最近有什么新闻？”应有 AI 回答 + `参考来源`。
- 回滚：`sudo systemctl disable --now searxng`（或设 `BOT_SEARCH_ENABLED=false` 后重启应用）；不需要恢复 schema/DB；卸载可选删除 `/opt/searxng`、`/opt/searxng-venv`、`/etc/searxng`。
- 故障：`journalctl -u searxng -n 80 --no-pager`；若 `Permission denied /etc/searxng/settings.yml` 检查目录为 `root:searxng 0750`、文件 `0640`；若引擎全 timeout，确认 `BOT_SEARCH_ENGINES=bing` 且 `cn.bing.com` 可达；不要开启被墙引擎。

### 3.6 Bot 消息发送 MCP（v0.6.4）

```bash
# 1) 安装 MCP 服务并更新 OpenCode 配置（重启 opencode，不影响 Minecraft）
sudo bash scripts/install-bot-tool-mcp.sh
# 2) 应用 env（/etc/antifieldcloud/env）追加/修改，然后重启应用
BOT_AI_SEND_TOOL_ENABLED=true
BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS=8000
BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS=20000
sudo systemctl restart antifieldcloud
```

- 安装内容：`/opt/botmsg-mcp/bot-tool-mcp.mjs`（root:root 0755）；OpenCode `mcp.servers.botmsg`（local、`codemode=false`、`BOT_TOOL_URL=http://127.0.0.1:3000/api/bot/ai/tool/send`）；安装脚本幂等并重启 `opencode.service`。
- 应用侧 `BOT_AI_SEND_TOOL_ENABLED=true` 后新建/已有 Chat 会话会获得 `botmsg_*` 工具权限；工具回调路由只接受本轮 HMAC token，无需额外共享密钥，`BOT_SECRET_KEY` 必须存在。
- 验证：`curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/bot/ai/tool/send -H 'content-type: application/json' -d '{"turn_id":"x","turn_token":"x","text":"x"}'` 应为 `404`（无活跃回合）；OpenCode 会话工具列表应出现 `botmsg_send_message`；真实私聊消息应产生多条 QQ 消息并审计 `bot.ai.send`。
- 回滚：`BOT_AI_SEND_TOOL_ENABLED=false` 并重启应用即可恢复旧的最终文本/`NO_REPLY` 行为；如需移除 OpenCode 工具，删除 `mcp.servers.botmsg` 后重启 opencode；不需要恢复 schema/DB。
- 故障：`journalctl -u opencode -n 80 --no-pager` 查看 MCP 启动错误；`journalctl -u antifieldcloud -n 80 --no-pager | grep -E 'bot.ai|botmsg|BOT_AI_SEND'`；确认 app 监听 `127.0.0.1:3000` 且 `/api/bot/ai/tool/send` 未被 Cloudflare Access 拦截（本机 MCP 不应经公网）。

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

目标：在 Cloudflare 边缘给 `app.<domain>` 增加第二层身份校验（应用 TOTP 仍是最终认证），同时保证 Bot 回调、健康检查与公开分享不被 Access 拦截。
**Access 配置不在仓库内；未配置/漏配时表现为 Webhook 404/302、`/healthz` 302、公开分享被重定向。**

生产当前配置（2026-10-21，API 创建）：
- 主应用 `AntifieldCloud`：`app.<domain>`，One-time PIN IdP，策略 `Owner allow`（指定邮箱）+ `Smoke service token`（`non_identity`，指定 service token）。
- 4 个独立 **Bypass** 应用（各自 `Bypass Everyone`）：`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`。
- service token 名称 `smoke-readonly`，有效期 1 年；Client ID/Secret 只保存在 PC `.local/cf-access.env`（gitignored），不写仓库。
- 已实测：未登录 `/` 302 到 `*.cloudflareaccess.com`；4 个 bypass 路径返回应用状态码而非 302；带 token 访问 `/api/bots/status` 为 401；smoke 24/24。

手工重建/迁移时按以下步骤：

1. Zero Trust → Access → Applications → Add an application → Self-hosted：
   - Application name：`AntifieldCloud`；Session duration：建议 8–24h。
   - Public hostname：`app.<domain>`（路径留空）。
   - Policy：`Allow`，Include 选择本人邮箱（One-time PIN）或已配置的身份提供商；不要添加 `Everyone`/`Bypass` 到整站。
2. **先创建 4 个独立的 path 应用**（路径应用的优先级高于整站主应用）：
   - 每个应用 Domain 填 `app.<domain>/healthz`（或对应路径），Policy 选 **Bypass + Everyone**；
   - 路径分别为：`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`。
   - `/api/bot/webhook` 覆盖 QQ 官方 Bot 回调；`/s` 与 `/api/public/shares` 覆盖公开分享；`/healthz` 供 smoke/健康检查。
   - 如 PWA 冷启动/离线壳在 Access 登录前就需要加载，可再按需 bypass `/assets`、`/manifest.webmanifest`、`/sw.js`、`/offline.html`、`/icons`；
     不要把 `/api` 整体 bypass。
3. 验证（未登录浏览器/命令行）：
   ```bash
   # Webhook：应为应用的 404（BOT_ENABLED=false）或 401（验签失败），不能是 Cloudflare Access 302
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.<domain>/api/bot/webhook/x
   # 健康检查：200 JSON
   curl -sS https://app.<domain>/healthz
   # 公开分享：未知 token 应为应用 404，而不是 Access 登录页
   curl -s -o /dev/null -w '%{http_code}\n' https://app.<domain>/s/not-a-token
   # 主应用：未登录应 302 到 <team>.cloudflareaccess.com（或 Access 登录页）
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://app.<domain>/
   ```
   带 service token 访问受保护 API 应返回应用 401（不是 302），并据此跑完整 smoke。
4. 回滚：删除 path Bypass 应用或整个主 Access Application；清理浏览器 Access Cookie 后重试。回滚后 Webhook/health/分享恢复无边缘身份层，
   应用侧签名/限流仍生效。
5. 注意：Access 的 `Bypass` 只影响边缘身份校验，不改变应用会话/CSRF/签名；不要把 Access 当作应用认证替代品。
   Cloudflare 账号本身必须开启 2FA（Access 配置权限等同于入口控制权）。
6. **service token（供 smoke/CI）**：Zero Trust → Access → Service Auth → Create Service Token，绑定到主应用 `Service Auth` 策略；
   把 Client ID/Secret 通过命令行传给 smoke：
   ```powershell
   .\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.7.1 -ExpectedSchemaVersion 16 -ExpectedOpenCodeVersion 2.1.4 `
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
.\scripts\smoke.ps1 -PiHost 192.0.2.10 -AppUrl https://app.<domain> -AiUrl https://ai.<domain> `
  -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedVersion 0.7.1 -ExpectedSchemaVersion 16 -ExpectedOpenCodeVersion 2.1.4
```

配置 Cloudflare Access 后，可在同一命令追加 `-AccessClientId/-AccessClientSecret`：脚本会给公网请求附加
`CF-Access-Client-Id`/`CF-Access-Client-Secret` 头，并额外检查“带 token 到达应用但未登录 → 401”；两者必须同时提供，凭据不打印。

`smoke.ps1` 覆盖：公网健康/302/401、CSP/nosniff/referrer/HSTS、PWA（manifest/sw/offline）、公开分享页 404/410、
指标/告警/分享等 API 401、Pi 服务与 `/healthz` 版本（`-ExpectedVersion`）、内存 cgroup、nftables 规则/25575 阻断/25565 可达、
备份 pending 与 48h 状态、密钥包状态、世界备份/世界拉取/演练状态文件、已安装脚本 SHA-256 与仓库一致、
本地世界/应用归档 `.sha256` 旁文件；所有 SSH 检查带重试与硬超时。`-SkipPublic`/`-SkipLocalBackup`/`-SkipScriptHash`
用于部署后只读子集。
v0.7.0 新增只读检查（缺依赖返回 `SKIP:` 不计 PASS，可选依赖用 SoftCheck 只 WARN）：OpenCode 版本精确断言（`-ExpectedOpenCodeVersion`）、
`/api/mcp` 的 `botmsg`/`searxng` connected 状态与 MCP 进程数阈值（`-MaxMcpProcesses`）、fail2ban active/jail/bantime、systemd unit 与仓库 SHA 对比、
env 键漂移（相对 bootstrap MANAGED_KEYS）、nftables 可选 SSH 来源断言（`-ExpectedSshSources`）、备份加密配置（开关/公钥 owner/mode/格式/age/`*.plain.tmp` 残留）、
异地副本状态（ok/超期/`plaintextSkipped>0`）、本地备份旁文件与归档 SHA 实测（含 `.age` 必须带 `.meta.json`）、Windows 备份任务安装标记（版本 + 脚本 SHA）。
`-SkipOpenCode/-SkipMcp/-SkipFail2ban/-SkipUnitDrift/-SkipEnvDrift/-SkipEncryption/-SkipOffsite/-SkipLocalTaskCheck` 可按环境跳过。

Windows 备份计划任务（**管理员 PowerShell**；安装脚本会收紧 ACL 并做 Pi 可达性预检）：

```powershell
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 只预览不注册：
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -DryRun
```

手工检查：`https://app.example.com` 登录、上传/预览、Dashboard MC 状态、白名单增删、文件分享与告警卡片；
`https://ai.example.com` 登录后进入 opencode。若 opencode 仍要求输入自身密码，属于其 UI 行为，
从 Pi `sudo grep OPENCODE_PASSWORD /etc/opencode/opencode.env` 获取后输入一次（不写入前端）。

### 6.1 v0.5.11 备份/灾备/迁移

- **v0.5.11 已部署并验收通过**（schema **v14**，迁移 14 新增 `bot_memory_items`/`bot_memory_state`，不可逆；旧 `bot_ai_memories` 保留为 legacy 来源）：最终 release `20261023T022831Z`/commit `931b10d`，healthz v0.5.11/schema 14，smoke 16/16 与 24/24；env 5 个 `BOT_MEMORY_*` 就位；用户实发验收通过（10:39 CST）；legacy 清理 users=0 files=0；回滚必须恢复最终迁移前快照 + v0.5.10 release。
  回滚必须恢复迁移前快照（v0.5.10 不支持 v14）。
- （历史）**v0.5.10 已部署**（schema 保持 v13、无迁移）：生产 env 实测已清理代理变量（`HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`）并确认 `BOT_AI_MEMORY_RETENTION_DAYS=365`/`BOT_AI_MEMORY_BATCH_MESSAGES=3`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`；
  同时 PC 计划任务 `AntifieldCloudDiscordTunnel` 已移除（仓库不再含隧道脚本）；记忆摘要改为一次性会话+远端删除、更新串行、记忆 365 天/会话 7 天保留分离。回滚切回 v0.5.9 release 并恢复旧 env（如需代理链路还要取回旧隧道脚本/计划任务）。
- （历史）v0.5.9 env 迁移：命令 120/AI 120/Chat 30、删除 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT`；回滚旧值 20/10/6。
- 迁移（v0.5.8）：v0.5.8 把 schema 从 v12 升到 v13（迁移 13 = `DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡；
  迁移 5–12 结构与 QQ Bot 数据保留，`bot_targets.chat_trigger` 列保留但逻辑不再读写）。部署脚本切换前自动 `--snapshot-db`；
  **迁移前必须确认 DB 快照成功并额外备份生产 Discord Bot 数据**（DB 快照已包含，建议同时在 `/bots` 记录配置）；迁移 13 不可逆，回滚只能还原快照。
- Bot 密钥：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY`，纳管 `BOT_AI_*`、Chat/记忆键、连通性键与回答/图片键（v0.5.9 删除提示词键）；
  v0.5.8 已删除 `BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`，`BOT_AI_VISION_ENABLED` 默认 true。
  **`BOT_SECRET_KEY` 必须与 DB 一起恢复**，否则 QQ AppSecret 不可解密。首次部署后立即跑一次 `backup-secrets.sh` 并确认 PC 拉取成功。
- 启用 Bot 后：`/api/version` 返回 `botsEnabled:true` 与 `botPlatforms:["qq"]`；`/api/bots/status` 的 `keyConfigured/enabled` 均为 true；
  `POST /api/bots/:id/check` 与 `GET /api/bots/:id/events` 可读；`smoke.ps1 -ExpectedVersion 0.7.1 -ExpectedSchemaVersion 16 -ExpectedOpenCodeVersion 2.1.4` 通过（公网 Webhook 路径不应被 Access 302）。
- QQ Chat/图片：C2C 私聊直接进入 Chat，群/频道仅 @Bot；`BOT_AI_VISION_ENABLED=true` 时 `d.attachments` 图片按 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 后缀、
  image mime 白名单与 `BOT_AI_IMAGE_MAX_BYTES` 下载后交给模型；失败/关闭降级。长回复按 2000 字符分段，partial 不自动重试。
- 自助/管理：`/help`（按身份动态）、`/role`（私聊）、`/reset`、`/forget confirm` 对所有用户开放；非管理员 `/help` 不显示管理命令，`/ask` 已移除；角色/记忆管理 API 只返回元数据，删除不可撤销；诊断事件只含元数据。
- Windows 应用备份脚本：更新仓库后**重新运行 `install-backup-task.ps1`**（管理员），刷新复制的 `backup-pull.ps1`、脚本 SHA 与安装标记；
  手跑一次核对 `backup.log` 出现 `secrets=ok`，Pi `backup-pull.json` 含 `secretsOk=true`（env 内含 `BOT_SECRET_KEY`/`BOT_*`，不打印值）。
- 世界备份/拉取：`antifieldcloud-world.timer` 时刻不变（周日 12:00）；`world-pull.ps1` 参数不变，更新仓库后手跑一次确认仍能校验/ack。
- 恢复演练：`drill.ps1 -ExpectedSchemaVersion 14`（v0.5.7 为 12、v0.5.1 为 8、v0.5.0 为 7、v0.4.2 及以前为 6）；旧报告保留，不改写。
- Web 恢复：只允许导入/校验/文件级恢复到新目录（`skippedMissing` 会剔除并在结果报告）；整库恢复仍按 `docs/BACKUP.md` §8 离线执行。
- 媒体：mp4/webm/mp3/m4a/ogg/flac/wav 可内联播放；mkv/avi 等回退下载（与 Bot 无关）。
- Bot 发布：仅文本（≤2000；超过返回 400 `publish_text_too_long`，不静默截断、不再服务端分段）；不再支持媒体附件；QQ 无媒体。
- 验收：`npm run check`（测试基线 **383/176**）、`npm run build`、`npm run test:coverage`（Lines **92.39%** / Branches **77.83%** / Functions **87.14%**）、`npm run test:web:coverage`、
  `smoke.ps1 -ExpectedVersion 0.6.0 -ExpectedSchemaVersion 14`、QQ 平台联调（§9.8；C2C/群@/频道、命令、`/help`、`/memory`、Chat、图片、发布、诊断、自检、角色/记忆元数据、结构化记忆抽取/召回）、
  备份导入/校验/恢复（临时 DATA_DIR）、世界备份/PC 拉取、`drill.ps1 -ExpectedSchemaVersion 14` 演练通过；OpenCode v2.1.3 已先升级并按 §3.2 复验。
  v0.5.7 及以前已部署/smoke 24/24；**v0.5.8 已部署**（release `20261022T134852Z`/commit `96294e4`，`/healthz` v0.5.8/schema 13，smoke 16/16 与 24/24，迁移 13 后 `bots` 仅 1 行 QQ Bot），真实 QQ 消息已由用户实发验收通过（2026-10-22 21:59–22:08 CST，证据见 `docs/ACCEPTANCE.md`）。 **v0.5.9 已部署**（release `20261022T143451Z`/commit `97996dc`，`/healthz` v0.5.9/schema 13，smoke 16/16 与 24/24，env 迁移完成；**用户已实发验收通过**（2026-10-22 22:39–22:41 CST；仅非管理员 `/help` 有服务端事件证据，其余为用户确认）。
  **v0.5.10 已部署**（release `20261022T152053Z`/commit `4619c91`，`/healthz` v0.5.10/schema 13，smoke 16/16 与 24/24，env 实测与直连载通性通过、PC 计划任务已移除；用户已实发验收通过（23:26–23:29 CST，证据见 `docs/ACCEPTANCE.md`））。
  **v0.5.11 已部署并验收通过**（最终 release `20261023T022831Z`/commit `931b10d`，`/healthz` v0.5.11/schema 14，smoke 16/16 与 24/24，env 5 个 `BOT_MEMORY_*` 就位；用户实发验收通过 2026-10-23 10:39 CST；legacy 清理 users=0 files=0；回滚必须恢复最终迁移前快照）。

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
**22 仅 `192.0.2.0/24` + `198.51.100.0/24`（TEST-NET 占位，安装前替换为实际直连/校园网段），且 `ct state new` 限速 `20/minute burst 40 packets`**；
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

- **前置确认（否则会锁死 SSH）**：先确认自己当前的 SSH 来源地址在 `192.0.2.0/24` 或 `198.51.100.0/24`（示例占位；实际网段按 `.local/DEPLOYMENT.md` 替换）内；
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
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 16
# 加密归档：提供离线私钥（先解密校验 plainSha/plainSize，再复用 drill-verify 全量校验）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 16 -AgeIdentityPath "$env:USERPROFILE\.age\backup-age-identity.txt"
# 需要验证世界解包时（先确认临时盘 ≥3× 世界归档体积）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 16 -IncludeWorld
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

### 9.8 QQ 官方 Bot 平台接入（用户后台 + 应用配置）

1. **QQ 开放平台**：q.qq.com 创建机器人 → 取得 **AppID** 与 **AppSecret**；`/bots` 新建 QQ 官方 Bot，AppID 填公开配置（`config.appId`），
   AppSecret 只提交保存为密文（不回显）。**v0.5.8 起仅支持 QQ 官方 Bot**，不再提供 Telegram/Discord/Slack 入口或 Gateway 配置。
2. **回调地址**：QQ 开放平台“开发设置 → 回调地址”填 `https://app.example.com/api/bot/webhook/<botId>`；平台发送 `op=13` 校验，
   服务端用 AppSecret 派生 Ed25519 私钥返回 `{plain_token, signature}`；随后校验 `op=0` 事件签名（`X-Signature-Ed25519` + 时间戳 ±300 秒）。
3. **事件订阅**：至少订阅 `C2C_MESSAGE_CREATE`（私聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`AT_MESSAGE_CREATE`（频道）；如需全量群消息，在 QQ 后台开启“接收所有消息”并订阅 `GROUP_MESSAGE_CREATE`，目标设 `groupReplyMode=all`（实验性）；群主还需在 QQ 群设置 → 机器人 → 可获取的群聊消息范围选择“获取群内全部消息”，否则平台不会推送非 @ 消息。
4. **应用侧**：`/bots` 中 Bot 默认 `enabled=false`；先保存 AppID/AppSecret 与目标（可设静默时段），再开启 `BOT_ENABLED=true` 并重启，最后逐个 `PATCH enabled=true`。
   目标填写：C2C 用 `user_openid`、群聊用 `group_openid`、频道用 `channel_id`；C2C 命令用户另建 `kind=user` 且允许命令的目标（群聊/频道自 v0.6.3 起不执行斜杠命令）；Chat 目标勾选 `allow_chat`；群目标可选群消息模式。
   用“测试连接”发一条测试消息（20 次/小时）；配置页“检查连接”确认 QQ `access_token` 自检通过。
5. **Chat/触发**：C2C 私聊普通文本直接进入 Chat；QQ 群/频道先 @Bot，再从“最近入站目标”登记并勾选 `allow_chat`。非管理员只能 Chat，不能执行斜杠命令。
6. **图片（默认开启）**：`BOT_AI_VISION_ENABLED=true`（默认）、`BOT_AI_ENABLED=true` 且模型支持 image 输入时，QQ `d.attachments` 中 image/* 附件经
   `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 后缀白名单、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES` 下载后交给 OpenCode；不落盘、失败降级。
   如需关闭设 `BOT_AI_VISION_ENABLED=false` 并重启；图片会经 OpenCode 发给模型 provider（见 `docs/SECURITY.md`）。
7. **AI（可选）**：Bot 稳定后设 `BOT_AI_ENABLED=true`（可同时设 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`）并重启；v0.5.9 起无 `/ask`，由用户在私聊/群 @Bot 发普通消息 Chat，
   确认有文本回复且审计 `bot.ai.chat`（不含 `mode`）；再验证结构化记忆（多轮后 `bot_memory_items` 条目、`bot.memory.extract` 计数、`/memory` 展示与 off/on、`/forget confirm` 清空 items/state/legacy/会话）、角色卡与 `/reset`；真实模型/工具行为按 `docs/SECURITY.md` §4 记录。
8. **发布**：`/bots` → 投递与发布 → 填纯文本（≤2000，超长服务端分段）+ TOTP 验证码 + `PUBLISH` 二次确认；QQ 无媒体/附件。
9. **验收证据**：QQ 至少一条 C2C/群@/频道文本命令、一条 Chat、一条测试通知、一条文本发布（含长文本分段）+ 一次定时/取消 + 一次失败重试；
   一次图片识别成功与一次降级；Chat 至少一条真实模型回复；`/help` 非管理员/管理员差异与 `/ask` 被拒/管理员回帮助不调用 AI；`/reset`、`/forget confirm` 实际发送；诊断分区有事件/中文错误提示；角色与记忆分区启停/删除（仅元数据）。
   记录 `bot_deliveries` 状态与平台消息 id（不记录 AppSecret/记忆正文）。未完成联调前保持 `BOT_ENABLED=false`/`BOT_AI_ENABLED=false`；
   未配置 AI/图片时在 `docs/ACCEPTANCE.md` 标“待配置/待验证”。
   **v0.5.8 实际验收（2026-10-22 21:59–22:08 CST，通过）**：C2C 文本命令/自助命令/权限拒绝/两条文本 Chat/真实图片端到端均有生产证据（13 条入站事件全部符合预期，图片 `image/jpeg` 148563 B）；诊断/角色记忆面板与文本发布按用户确认整体通过（服务端未单独留存 UI/发布证据）。 **v0.5.9 已部署**（2026-10-22 22:35 CST，schema 保持 v13、无迁移）：release `20261022T143451Z`/commit `97996dc`；`/healthz` = `{"ok":true,"version":"0.5.9","schemaVersion":13}`，部署内只读 smoke 16/16、带 Access token 完整 smoke 24/24（首次 Access 20s 超时 1 项失败，重试全通过）；
生产 env 迁移已完成（命令 120/AI 120/Chat 30、删除 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT`、权限 640、APP_VERSION=0.5.9，原 env 备份 `/var/lib/antifieldcloud/env-backup-v058-20261022223449.bak`）；回滚切回 `20261022T134852Z` + 还原 env 备份（20/10/6）。用户已实发验收通过（2026-10-22 22:39–22:41 CST：非管理员 `/help` 有生产事件证据，其余为用户确认；22:41 原话“验收通过”）。

### 9.9 Bot 队列/发布故障排查

| 现象 | 处理 |
|---|---|
| Webhook 302 到 cloudflareaccess.com | Access 未对 `/api/bot/webhook/*` bypass（§5.2） |
| Webhook 404 | `BOT_ENABLED=false`/无 `BOT_SECRET_KEY`/Bot `enabled=false`/botId 错；看 `/api/bots/status` 与审计 `bot.webhook.rejected` |
| Webhook 401 | QQ Ed25519 签名/时间戳（±300s）或 AppSecret 不匹配；核对 QQ 开放平台回调与 Secret；`op=13` 校验需返回签名体 |
| 命令无回复 | v0.6.3 起群聊/频道命令一律忽略（`bot.command.disabled`）；C2C 需目标勾选 `allow_commands`、用户登记为 `kind=user` 且允许命令、命令未限流、平台 API 正常；看 `bot.command.denied`、`bot_deliveries.last_error` |
| `/ask` 已移除 | v0.5.9 起 `/ask` 不是有效命令：非管理员按未知命令被拒（`bot.command.denied`、无回复），管理员回全量帮助且不调用 AI；AI 请用普通消息 Chat |
| Chat AI 超时/502/504 | OpenCode 不可达、Basic 密码不一致、模型未配置或超时；`curl -u` 探测 4096，检查 `OPENCODE_PASSWORD` 与 `BOT_AI_TIMEOUT_SECONDS`；不要打印密码 |
| 发布 400/401 | 缺 `totpCode` 或 `confirmText:'PUBLISH'`、TOTP 过期/重放、目标是 user、文本超 2000 字符、定时超 30 天；v0.5.8 起无媒体字段 |
| 发布 `partial_text_sent` | 长文本部分段落已外发后失败；任务标记 `failed` 且不自动重试，避免重复外发。核对平台消息后人工重建任务 |
| Chat 无回复 | 目标未勾选 `allow_chat`、`BOT_AI_ENABLED=false`、QQ 群/频道未 @Bot、全量模式下仅@/名字未命中或模型输出 `NO_REPLY`、限流（30/min 或 120/h）；看 `bot.chat.denied`/`bot.chat`/`bot.ai.chat` 审计与 `mention_filtered`/`no_reply` 事件 |
| 群/频道不消费未 @ 的消息 | 属 QQ 平台限制：群/频道只有 @Bot 事件进入 Bot，不支持“全部消息”；C2C 私聊直接进入 |
| 图片提示暂不支持/未处理 | `BOT_AI_VISION_ENABLED=false`、附件 mime/大小/域名不合规或下载失败；看审计 `bot.ai.image`（只含 mime/大小/跳过原因）与日志（不含图片内容） |
| 检查连接失败 | 按 QQ AppID/AppSecret、Pi 直连出站网络核对（v0.5.10 起无代理隧道）；`bot_health_unsupported` 表示适配器未实现自检；结果只含脱敏项 |
| 诊断无事件/筛选报错 | `BOT_ENABLED=false`、Bot 未启用、时间窗口内无入站；`outcome` 只接受 received/ok/denied/rate_limited/ignored/error，非法值 400；事件不含正文 |
| `/reset` 或 `/forget` 无效果 | `/reset` 只清当前目标 Chat/任务会话（保留记忆）；`/forget` 必须带完整参数 `confirm`，清除该 Bot×用户长期记忆与全部会话（不删角色卡） |
| 记忆未生成/未召回 | 看 `bot.memory.extract` 审计计数与 `bot_memory_items`/`bot_memory_state` 行数；确认用户未 `/memory off`、OpenCode 可达、批处理阈值 `BOT_AI_MEMORY_BATCH_MESSAGES`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`、召回预算 `BOT_MEMORY_PROMPT_MAX_CHARS`/`BOT_MEMORY_PROMPT_MAX_ITEMS`；不要打印 key/value 正文 |
| legacy 清理未执行/残留 | v0.5.11 验收后需执行 `node scripts/cleanup-legacy-memory.mjs`（dry-run 核对）再 `--confirm`；只清理 `legacy_migrated_at` 已置位用户的 `bot_ai_memories`+镜像；看审计 `bot.memory.legacy_cleanup` |
| 回滚后启动报 schema 过高 | v0.5.10 不支持 schema v14；必须先用迁移前快照 `db-predeploy-*.sqlite` 恢复 DB，再切回 v0.5.10 release；不要只切 release |
| 树莓派重启后 Cloudflare 1033 / 公网 530 | 先 `curl -k -sS https://api.cloudflare.com/client/v4/` 看是否返回校园网认证页；若是 Portal 认证失效，在 Pi 出口完成认证（可临时 `ssh -D` 让 PC 浏览器经 Pi 出口登录），确认 TCP/UDP 7844 可达后 `systemctl reset-failed cloudflared && systemctl restart cloudflared`；本环境 2026-10-24 即此原因 |
| Cloudflare 边缘/tunnel 中断 | 查看 Cloudflare 状态与 cloudflared 日志；本例 2026-10-23 01:08–01:13 CST 边缘 7844 不可达致 tunnel 短暂中断，重启 cloudflared 后恢复（环境事件，非应用问题） |
| 连通性快照仍含设备/代理 | v0.5.10 起快照仅 `checkedAt/checking/internet/platforms`；若仍有 `deviceOnline/proxy` 说明运行的是旧版本或旧 bundle，检查 release/bundle 版本并重启 |
| PC 仍有 DiscordTunnel 计划任务 | v0.5.10 已移除隧道；`Get-ScheduledTask -TaskName AntifieldCloudDiscordTunnel` 若存在请手动删除，仓库不再包含安装脚本 |
| 通知被延后 | 目标配置了静默时段且在窗口内；属预期，`next_attempt_at` 为窗口结束；如非预期检查 `quietStartMinute/quietEndMinute` |
| 指标卡为空/0 | 窗口内无投递或 Bot 关闭；直接查 `GET /api/bots/:id/metrics?hours=24`、`bot_deliveries`/`bot_publish_jobs`；成功率只统计已尝试投递 |
| 投递 `dead` | 平台 AppSecret 失效/权限不足/被限流或出站网络失败；修复后 `POST /deliveries/:id/retry`；必要时重录 AppSecret |
| 队列不跑 | `BOT_ENABLED`/密钥、`BOT_DELIVERY_INTERVAL_SECONDS`、Bot 未启用；重启后看 `startBots` 日志 |
| `BOT_SECRET_KEY` 无效 | 必须是 base64 32 字节；`bootstrap-env.sh` 会拒绝写入并退出，恢复旧 key 或接受 QQ AppSecret 重录 |
| smoke 公网 302 到 Access | 未配置 bypass 时属预期；配置后仍 302 检查 service token 是否同时传 `-AccessClientId/-AccessClientSecret` 且未过期 |
| 迁移后非 QQ Bot 消失 | v0.5.8 迁移 13 删除 `platform <> 'qq'` 的 Bot 及级联数据，属预期；只能从迁移前 DB 快照恢复，不能通过应用恢复 |
| nftables restart 后封禁未恢复 | 确认 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` 已安装、`daemon-reload`、dbfile 存在；`journalctl -u nftables` 看 `systemd-run` 是否执行；手工 reload 不触发，需 `systemctl restart fail2ban` |
| 加密 prepare 失败（`age 不可用`/`公钥`） | `BACKUP_ARCHIVE_ENCRYPTION=true` 时失败关闭属预期：检查 `age --version`、`BACKUP_AGE_RECIPIENT_FILE` 存在/root 属主/0644/组其他不可写/单行 `age1…`；修好前不要改回明文绕过 |
| Web 对归档返回 `409 archive_encrypted` | 加密归档在 Web 不可校验/恢复：到 PC 用离线 age 私钥解密/校验（`docs/BACKUP.md` §5.1/§8.1）；不要尝试在 Pi 解密 |
| 加密归档缺 `.meta.json` | PC 拉取会跳过且不 ack：检查 Pi `backups/` 下 `<name>.meta.json` 是否存在/可读；补齐前不要 ack/删除密文 |
| 异地副本状态缺失/超期 | 默认关闭；未配置时 `offsite` 为 null 且不告警。配置后检查 PC `AntifieldCloud-Backup-Offsite` 任务 `LastTaskResult`、`backup-offsite.log`、rclone remote/凭据、`ALERT_OFFSITE_MAX_AGE_HOURS` 与 `backup-offsite-status.json` 的 `lastRunAt/error/plaintextSkipped` |
| 加密/异地状态卡显示未启用 | 正常：`BACKUP_ARCHIVE_ENCRYPTION=false`/状态文件缺失即未启用；启用步骤见 §9.10/§9.11 |

### 9.10 备份整包加密启用/回滚（v0.7.0，默认关闭）

```bash
# 1) 离线生成独立备份 age 密钥（PC 或可信离线环境；私钥 ≥2 份、禁止放 Pi）
age-keygen -o backup-age-identity.txt
grep '^# public key:' backup-age-identity.txt   # 取 age1… 公钥

# 2) Pi（root）：写入公钥并校验权限/格式
sudo install -o root -g root -m 0644 /dev/stdin /etc/antifieldcloud/backup-age.pub <<'EOF'
age1...（替换为第 1 步公钥）
EOF
sudo chmod 0644 /etc/antifieldcloud/backup-age.pub
sudo test -O /etc/antifieldcloud/backup-age.pub && ! find /etc/antifieldcloud/backup-age.pub -perm /022 -print -quit

# 3) env 开启（/etc/antifieldcloud/env 或 deploy.conf 路径；bootstrap-env.sh 已纳管）
BACKUP_ARCHIVE_ENCRYPTION=true
BACKUP_AGE_RECIPIENT_FILE=/etc/antifieldcloud/backup-age.pub

# 4) 私钥完成一次解密演练（PC：先做一次加密 prepare 并拉取，或手工加密/解密小文件验证）
#    drill.ps1 -BackupRoot <root> -AgeIdentityPath <identity> -ExpectedSchemaVersion 16
sudo systemctl restart antifieldcloud

# 5) 下一次 prepare 生成 .age；PC 拉取（会校验 .meta.json）并 ack；再跑 drill 解密校验
```

- **浏览器/Dashboard 验证**：Settings → 备份与恢复应显示“加密已启用、公钥已配置”；列表新归档带“加密归档（Web 不可校验/恢复）”；
  `GET /api/version` 的 `backupArchiveEncryption=true`、`backupAgeRecipientConfigured=true`。
- **回滚**：`BACKUP_ARCHIVE_ENCRYPTION=false` 并重启 → 下一次 prepare 恢复明文；已生成 `.age` 保留在 Pi/PC，由 PC 用私钥解密/演练；
  回滚不需要改 schema/DB。私钥丢失则已加密归档不可恢复（明确残余，见 `docs/SECURITY.md` §4）。
- **注意**：加密开启后空间预算按 2× 明文；`*.plain.tmp` 残留由启动/下次 prepare 清理（>24h）；不要手工删除 pending 密文/ sidecar。

### 9.11 异地副本启用/回滚（v0.7.0，默认关闭）

```powershell
# 1) PC 先安装/配置 rclone（脚本不创建 remote/凭据）
rclone config            # 新建 remote（如 myremote），保存凭据到当前用户配置
rclone lsd myremote:     # 验证可访问

# 2) 安装异地副本计划任务（可同时保留每日应用归档任务）
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" `
  -InstallOffsiteTask -OffsiteRemote myremote -OffsiteRemotePath AntifieldCloud/backups -OffsiteRemoteLabel myremote

# 3) 先手跑一次（dry-run 可加脚本参数）并检查状态回写与日志
Get-ScheduledTaskInfo -TaskName AntifieldCloud-Backup-Offsite
# Pi: cat /var/lib/antifieldcloud/backup-offsite-status.json
```

- 前提：本地已有加密归档（`.age` + `.meta.json` + `.sha256`）；脚本只上传 `.age`，明文计入 `plaintextSkipped` 且拒绝上传。
- 保留：链感知（最新 full + 其后全部 inc + 最近 N 天）；绝不删最新 full；删除上限与 dry-run 可用；远端只应有 `.age`/`.sha256`/`.meta.json`。
- 告警：`ALERT_OFFSITE_MAX_AGE_HOURS`（默认 48，0 关闭）与 `offsite_overdue`；状态文件缺失/未配置不告警。Dashboard 显示目标别名/计数/时间，不显示远端真实路径/凭据。
- **回滚**：`Unregister-ScheduledTask -TaskName AntifieldCloud-Backup-Offsite`（或 `install-backup-task.ps1` 重装时省略 offsite 参数）；
  已上传远端副本保留；应用归档主链路不受影响。

### 9.12 主机配置模板（deploy/host/，v0.7.0/OPS-09）

- 目录：`deploy/host/README.md`（替换/安装/回滚/安全提示）、`sshd_config.d/00-antifield-hardening.conf`、`fail2ban/jail.d/antifieldcloud.local`、
  `cloudflared.service.d/20-hardening.conf`、`journald.conf.d/60-workbench-persistent.conf`、`log2ram.conf`。
- 模板含 `<SSH_USER>` 等占位，安装时必须替换为实际值，并做 `sshd -t`、`systemctl daemon-reload`、`systemctl restart` 后验证会话/服务；
  先复制现有文件备份（`cp -a ... .bak`）。
- 重建/迁移时以模板 + 密钥包（`backup-secrets.sh --include-host-config` 打包的实际配置）对照，避免“主机重建后加固丢失”。
- 回滚：用 `.bak` 覆盖并重启对应服务；nftables/sshd 变更必须先确认 SSH 回滚通道。

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
# 优先使用 deploy.ps1 的自动回滚；手工回滚按以下顺序（schema v13 只向上）
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

- 每次部署在切换前生成 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`（0600，**保留最新 2 个**：`MAX_PREDEPLOY_SNAPSHOTS=2`，供自动回滚；明文快照属威胁模型明确豁免项，见 `docs/SECURITY.md` §4）。
- **schema 只向上（当前 v16）**（迁移 5 结构、迁移 6 孤儿 shares 修复、迁移 7 Bot 表、迁移 8 重建 Bot 表/静默列/AI 会话、
  迁移 9 `allow_chat`/`bot_ai_memories`/`bot_inbound_targets`、迁移 10 `bot_ai_sessions.mode`、迁移 11 `bot_chat_roles`、
  迁移 12 `chat_trigger`/`bot_events` 诊断列、迁移 13 删除非 QQ Bot 及级联数据、迁移 14 结构化记忆两表、迁移 15 `qq_number` 兼容列、
  迁移 16 群聊角色卡 `bot_group_roles`；**v0.7.0 无新迁移**）：迁移前会清理不可达孤儿 shares 并做 `PRAGMA foreign_key_check`，
  其它外键不一致会拒绝启动；旧代码遇到更高 schema 会拒绝启动。迁移单向、无 down；回滚旧 release 前必须恢复对应迁移前快照
  （`stop → 复制快照为 db.sqlite → 删除 -wal/-shm → 还原 APP_VERSION → 切 release → start`）。
- **v0.5.9 无迁移**：schema 保持 v13；回滚只需切回 release `20261022T134852Z`（v0.5.8）并还原旧 env 值（`BOT_COMMAND_RATE_PER_MINUTE=20`、`BOT_AI_RATE_PER_HOUR=10`、`BOT_CHAT_RATE_PER_MINUTE=6`；提示词变量可选恢复）后重启，无需还原 DB 快照（脚本仍会生成，仅保险）。
- **v0.5.8 迁移 13 不可逆**：非 QQ Bot 数据（目标/队列/事件/会话/记忆/角色卡）在迁移后从 DB 删除，应用层无恢复入口；只能还原迁移前 DB 快照。
  回滚到 v0.5.7 时须恢复迁移前快照 `db-predeploy-20261022T134921798Z.sqlite`（sha256 `fed84a0a4024ece85c4de50eabe41b20bf6a2d2821350d295d36faa1e98ec1ce`）并同步还原 `APP_VERSION`、切回 release `20261022T131813Z`；生产 Discord 数据归属见 `docs/ACCEPTANCE.md` v0.5.8 记录。
- Bot 数据回滚：`bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events`/`bot_ai_sessions`/`bot_ai_memories`/`bot_inbound_targets`/`bot_chat_roles` 随 DB 快照恢复；
  `BOT_SECRET_KEY` 不在 DB 中，必须保持与快照生成时一致的 env（否则 QQ AppSecret 不可解密）。`DATA_DIR/bot-memory` 镜像文件不由快照恢复，
  如需与 DB 摘要一致，可保留现有镜像或按保留期/人工清理；不通过 API 暴露。
  回滚窗口内保持 `BOT_ENABLED=false`/`BOT_AI_ENABLED=false`，确认稳定后再重新启用（`BOT_AI_VISION_ENABLED` 可保持默认 true）。
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
`APP_VERSION`、`docs/DEPLOY.md` 标题与 `package-lock.json` 根版本；并交叉校验 `deploy/tool-versions.json` ↔ `server/src/db.ts`
`SUPPORTED_SCHEMA_VERSION`、`docs/DEPLOY.md §3.2 OpenCode`、`docs/DEPLOY.md 当前 schema`、AGENTS/README/SECURITY/BOT/ACCEPTANCE 的
OpenCode 当前事实（已接入 CI check job）。发布前必须通过；过渡期调试可用 `CHECK_VERSION_ALLOW_STALE_TOOLS=1`，CI/发布不得使用。

其它门禁：`check-prod-deps.mjs`（裸导入边界）、PS 5.1 解析 + UTF-8 BOM（全部 `scripts/*.ps1`，含 `backup-offsite.ps1`）、
`run-tests.mjs` 覆盖率阈值（Lines 91 / Functions 85 / Branches 76）、gitleaks/shellcheck/nftables 语法。公开文档占位符扫描由 PR 审阅把关（不把真实值写入 CI 配置）。

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
| 应用了新 nftables 后 SSH 断开 | 来源网段不在 `192.0.2.0/24`/`198.51.100.0/24`（模板占位，需替换为实际网段）；用物理键鼠或已建立连接恢复 `.bak` 并 `systemctl restart nftables` |
| 旧世界 cron 与新 timer 重复备份 | `crontab -u antifield -l` 确认无 `minecraft-backups` 行；旧归档按 §14/`docs/BACKUP.md` §6.4 手动清理 |
| 部署脚本报“工作树不干净” | 先提交；确需脏发布用 `-AllowDirty` 并在验收记录标注 commit/改动 |
| 部署后 smoke 失败但服务正常 | v0.5.0 起默认门禁失败；看 FAIL 项修复后重跑 `smoke.ps1`；临时放行用 `-AllowSmokeFailure` 并记录未通过项 |
| `/healthz` 版本仍是旧版 | 检查 `/etc/antifieldcloud/env` 的 `APP_VERSION` 与 `package.json`；回滚后尤其要确认已还原上一 release 版本 |
| Bot Webhook 404 | `BOT_ENABLED=false`、缺 `BOT_SECRET_KEY`、Bot `enabled=false` 或 botId 错；先看 `/api/bots/status` 与 §9.9 |
| Bot Webhook 302 | Cloudflare Access 未 bypass `/api/bot/webhook/*`（§5.2） |
| Bot Webhook 401 | 平台签名/时间戳/Public Key/Signing Secret 不匹配；QQ 检查 AppSecret、Ed25519 头与时间戳是否在 ±300 秒 |
| QQ 回调地址校验失败 | AppSecret 错、AppID 与 Secret 不配对、请求未带 `op=13` 的 `plain_token/event_ts`；看 `bot.webhook.rejected` 与 journald（不打印 AppSecret） |
| QQ 发布会话 | QQ 仅文本、单条 ≤2000 字符（超长服务端分段）；v0.5.8 起无媒体/附件字段 |
| `/ask` 已移除 | v0.5.9 起 `/ask` 为未知命令：非管理员被拒（无回复），管理员回全量帮助、不调用 AI；Chat 问题看 `bot.chat.denied`、`BOT_AI_RATE_PER_HOUR` 与 `journalctl -u opencode` |
| 通知被静默延后 | 目标设置了 `quietStartMinute/quietEndMinute` 且当前在窗口内；通知的 `next_attempt_at` 为窗口结束，属预期 |
| 发布提示 publish_confirm_required | 请求体缺少 `confirmText:'PUBLISH'`；TOTP 不能替代该二次确认 |
| smoke Access token 无效 | 同时提供 `-AccessClientId/-AccessClientSecret`、确认 token 未过期且策略绑定 `app`；不要使用全局/宽范围 token |
| nftables restart 后封禁丢失 | drop-in 未安装/未 `daemon-reload`/dbfile 不可写；手工 reload 不触发，需 `systemctl restart fail2ban`（§9.7） |
| Bot 管理页提示缺少密钥 | `BOT_SECRET_KEY` 未写入或不是 base64 32 字节；用 `bootstrap-env.sh --force` 生成/复用后重启（不要手工替换旧 key） |
| Bot 发布 400/401 | 缺 `totpCode`、TOTP 过期/重放、目标是 user、文本超 2000 字符、定时超 30 天；见 API §14 |
| Bot Chat 无回复 | `BOT_AI_ENABLED=false`、目标未 `allow_chat`、群/频道未 @Bot、30/min 或 120/h 限流；看 `bot.chat.denied` 与审计 |
| Bot 长回复截断/重复 | QQ 单条上限 2000，最多 4 段并带续段前缀；partial 失败不自动重试，需核对平台消息后人工处理，避免重复外发 |
| Bot 图片不生效 | v0.5.8 起 `BOT_AI_VISION_ENABLED=true` 默认开启；需 `BOT_AI_ENABLED=true` 且模型支持 image、附件域名/mime/大小合规；看 `bot.ai.image` 审计（不含内容） |
| Bot `/forget` 提示用法 | 必须发送 `/forget confirm`（完整参数）；只清长期记忆与该 Bot×用户全部会话，不删除角色卡 |
| 平台连接自检失败 | 检查 QQ AppID/AppSecret、Pi 直连出站网络（v0.5.10 起无代理隧道）；`/bots`“检查连接”只显示脱敏原因 |
| Bot 投递 dead/不重试 | 平台 Token 失效/权限不足/被限流；修 Token 后 `POST /api/bots/:id/deliveries/:id/retry`；`bot_deliveries.last_error` 有短错误码 |
| SSH 仅公钥后无法登录 | 24h 回滚窗口内删除 `/etc/ssh/sshd_config.d/00-antifield-hardening.conf` → `sshd -t` → `systemctl reload ssh`；用已建立会话/物理键鼠操作（§9.7） |
| fail2ban 未封禁/启动失败 | `fail2ban-client -t` 校验配置；`journalctl -u fail2ban -n 50`；确认 nftables 后端与 `sshd` jail 已启用、`bantime=86400`；日志后端（log2ram/journald）可读 |
| nftables 重载后封禁列表清空 | fail2ban 的封禁 set 随 nftables 重建丢失：`systemctl restart fail2ban` 后 `fail2ban-client status sshd` 复核；把该步骤写进 nftables 变更清单 |

## 14. 磁盘清理与保留策略

> v0.5.8 清理只允许 **孤儿归档 / 保留期到期 / 旧 release / 过期备份** 四类；任何操作先只读确认 + 二次确认，**不删除用户文件**。
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
| 保留期到期备份 | PC `daily` >30 天、`weekly` >56 天、`secrets` >90 天；`db-predeploy-*.sqlite` 超过最新 **2** 个 | 在 PC 按目录/日期删除；Pi 只删最旧的 `db-predeploy-*` | 至少保留一份可解包副本；不删最新 full 链；不删最近迁移快照（自动回滚依赖） |
| 旧 release | 不是 `current`/`previous`，且早于两代 | `sudo rm -rf /opt/antifieldcloud/releases/<old>` | `readlink -f current/previous` 后确认 |
| 过期备份残片 | 已删除归档遗留的 `.part`/`.sha256`（无对应归档）或超 6h 的世界 `.part` | `sudo rm -f <对应残片>` | 先确认无同名正式归档；世界 `.part` 由脚本清理，手工仅限确认无人运行时 |
| 加密临时/孤儿（v0.7.0） | `*.plain.tmp` 超过 24h 且确认无 prepare 在跑；`*.part.age`/`.meta.json.part` 无对应正式归档；`*.tar.gz.age` 有密文但 DB 无行（孤儿） | `--pending` 报告的 `partials/orphans` 为准，人工确认后再删 | **孤儿密文只报告不自动删**；缺 `.meta.json` 的归档先补/查因，不直接删；pending 中的 `.age`/sidecar 一律不动 |

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
6. `metrics_samples` 30 天、`audit_log`/`alert_events` 90 天由应用自动清理；`db-predeploy-*.sqlite` 保留最新 **2** 个；不要手工删表。
7. 备份加密/异地相关目录（`backups/` 下的 `.age`/`.meta.json`/`.sha256`/`*.plain.tmp`、PC 远端副本）不在清理清单；按 `docs/BACKUP.md` §5.1/§5.2 与本节“加密临时/孤儿”行处理。
