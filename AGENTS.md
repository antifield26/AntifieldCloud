# AGENTS.md — AntifieldCloud 工程约定（后续所有 Agent 会话必读）

## 0. 项目一句话

**当前版本 v0.7.1（已部署生产，待真实群聊验收/Tag；release `20261025T031856Z`/代码提交 `d8bdfc5`；分支 `main`）**：在 Raspberry Pi 5（Debian 13，8 GB）上运行的自托管个人工作台——统一登录（密码 + TOTP）、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态/白名单、OpenCode 反代、QQ 官方机器人（单平台；AI 仅普通消息 Chat）、PWA、可观测性与主机告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。本补丁修复群聊会话归属：同一群聊目标的所有成员复用唯一 OpenCode Chat 会话（模型可见多用户历史），群内 Chat 按目标串行；私聊仍每用户独立会话；真实用户仍用于限流、记忆/审计/发送工具令牌，用户消息继续带用户名 head；启动时清理旧版分用户群映射。此前 v0.7.0 语义为**审计修复 + 备份整包加密 + 异地副本（默认关闭）**：第六轮深度审计 P0=0/P1=3/P2=26/P3=73 全部处置（P3 可修小项随本版修、架构性/已接受项写入明确残余）；备份归档可用独立 age 公钥整包加密（Web 不持私钥，`.age` 在 Web 一律 `409 archive_encrypted`）；PC 端可链感知上传密文到异地；Bot AI 工具隔离降级 fail-closed（`503 bot_ai_tool_isolation_unavailable`）；群共享记忆归属改为稳定 `member_openid`；Bot 连续外发文本最小间隔 1000ms（按 Bot/AppID 串行，D-20）；模型 DSML 原始工具调用文本不回显（只提取正文/固定兜底，审计 `bot.ai.tool_call_text`）；审计写入事务外 best-effort 并经 `/api/version.audit` 暴露失败计数。**schema 保持 v16（无迁移）**；**OpenCode v2.1.4**（已于 2026-10-25 08:21 CST 升级；升级/回滚与矩阵见 `docs/DEPLOY.md` §3.2，V1–V9/V14 通过，V10–V13 用户真实 QQ 验收通过）。产品名 `AntifieldCloud · 个人工作台`。

权威文档：
- `docs/PLAN.md`：范围、决策、阶段与验收
- `docs/API.md`：HTTP 契约（服务端/前端共同遵守）
- `docs/UI-SPEC.md`：界面与交互
- `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`
- `docs/ROADMAP.md`：路线图与当前版本边界
- `docs/AUDIT.md`：第一至第六轮审计与明确残余
- `docs/ACCEPTANCE.md`：当前版本验收与历史记录
- `deploy/tool-versions.json`：schema / OpenCode 期望版本单一来源（PC 脚本与 check-version 共用）

## 1. 语言与注释

- 代码注释、文档、提交信息、UI 文案一律中文（技术标识符除外）。
- 注释解释「当前行为/约束」，禁止写历史叙事（“之前……”“修复了……”）或轮次标记。
- 每个模块顶部用一段中文说明职责与安全边界。

## 2. 运行模型

- Node >= 26；服务端为原生 TypeScript，`node server/src/main.ts` 直接运行，**不要引入编译/打包服务端步骤**。
- 相对导入必须带 `.ts` 后缀；禁止 enum/namespace/参数属性等非可擦除语法（`erasableSyntaxOnly` 已开启）。
- 前端由 Vite 构建，产物 `web/dist`；服务端只托管静态产物，不参与前端编译。
- 依赖：服务端运行时依赖放 `dependencies`；React/Vite/ESLint 等仅构建期依赖放 `devDependencies`（Pi 上 `npm ci --omit=dev` 不安装）。
- 类型工具链（TS7 并排）：`npx tsc` 来自 `@typescript/native`（TypeScript 7.0.2）；`typescript` 包是 `@typescript/typescript6@6.0.2` 别名，仅供 typescript-eslint（8.x 尚不支持 TS7 API）。结论为暂不升级、保留双 alias；不要删除/合并这两个 alias，直到 typescript-eslint 支持 TS7.1 API。
- 不使用 Docker；Pi 上用 systemd 原生命令运行。

## 3. 命令

```bash
npm ci
npm run dev            # 本地服务端，默认 127.0.0.1:3000
npm run dev:web        # Vite :5173，/api 代理到 :3000
npm run build          # 前端构建
npm run typecheck      # server + web 两个 tsc 项目
npm run lint           # ESLint，--max-warnings=0
npm test               # node --test（server/test/**/*.test.ts 与 scripts/test/**/*.test.mjs）
npm run test:coverage  # 服务端 + 运维脚本测试 + 覆盖率门禁（CI coverage job）
npm run test:web       # Vitest + jsdom（web/src/**/*.test.ts(x)）
npm run test:web:coverage # 前端测试 + 覆盖率门禁
npm run check          # typecheck + lint + server test + web test，提交前必须全绿
node scripts/check-version.mjs # 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS/env.example/DEPLOY、lock 根版本，并交叉校验 deploy/tool-versions.json ↔ db.ts ↔ 文档当前事实
```

当前基线（v0.7.1，2026-10-25 本地门禁）：`npm test` **491**（server+scripts，含 scripts 29；新增 v0.7.1 群会话 4 例）、`npm run test:web` **222**（44 文件）、服务端覆盖率 Lines 92.75% / Branches 78.23% / Functions 87.82%、前端覆盖率 Lines 52.31% / Branches 47.32% / Functions 45.02%、build `index-C0QZV4hZ.js` 726.72 kB；覆盖率门禁为 Lines 91 / Functions 85 / Branches 76（前端 50/45/42）。生产应用 **v0.7.1 已部署**（release `20261025T031856Z`/commit `d8bdfc5`，`/healthz` v0.7.1/schema16；部署内 smoke 23/23、完整 Access smoke 31/0/1/2；启动后生产群聊旧分用户映射已清零，部署代码探针验证同群单会话；真实双用户群聊验收待用户执行）；上一发布 v0.7.0（Tag/Release）。OpenCode v2.1.4，V1–V9/V14 通过，V10–V13 用户真实 QQ 验收通过。

测试边界：禁止依赖真实 Minecraft、真实 OpenCode、真实 network；Bot 适配器（QQ 官方 Bot、Chat、图片下载、分段/格式化/自检/诊断）、备份 tar/age、告警投递等只使用进程内假平台/夹具（不访问真实平台或模型）。Windows 上无法测试的 systemd 相关用例用 `t.skip` 并在 Linux 上跑；`scripts/test/` 覆盖世界备份、恢复演练与异地副本规划等纯函数/夹具，不触碰真实 Pi。真实 QQ/Cloudflare/模型负路径需部署后联调，不把 mock 全绿等同于线上通过。

## 4. 目录与模块边界

```text
server/src/
  main.ts            进程入口：配置、DB、Fastify、信号退出、启动指标采样
  config.ts          环境变量解析与校验（非法值/不安全组合失败即退出）
  logger.ts          Fastify/pino 日志与脱敏
  db.ts              SQLite 打开、迁移（当前 schema v16）、事务辅助
  auth/              scrypt、TOTP、会话、CSRF、限流、恢复码、审计（字段截断 + 失败诊断）、Bot 发布 TOTP 再认证
  files/             存储、上传、配额、搜索、预览、回收站、files.origin 可见性、物理孤儿回收
  uploads/           分片上传会话/块索引、配额预留、拼接、过期与终态清理
  mc/                SLP、RCON、白名单
  opencode/          ai.* Host 的认证反代 + HTML 模式 + Origin 校验 + AI 主机限流/审计去重
  bot/               QQ 官方 Bot 适配器、Chat AI、结构化长期记忆、私聊/群聊角色卡、连通性、
                     凭据 AES-256-GCM、Webhook 验签/去重、命令、回复管线、图片下载、自检、告警/发布队列；
                     群聊共享唯一 OpenCode Chat 会话（合成键 __group__，按目标串行），私聊每用户独立会话；
                     外发文本按 Bot/AppID 以 1000ms 最小间隔串行（分段/发送工具/兜底/队列统一）；
                     原始 DSML 工具调用文本只提取正文或固定兜底，不回显协议标记。
                     行为保持拆分：inbound.ts（入站验签/限流/命令与 Chat 分发）、chat.ts（Chat 回合/工具缓冲/记忆触发）、
                     diagnostics.ts（事件/入站目标/指标/最近错误）、queue.ts（投递/发布状态机），
                     BotService 保留 facade/依赖装配
  backups/           归档导入/校验、文件级恢复（skippedMissing）、Web 对加密归档的 409 边界、状态只读
  dashboard/         主机指标、服务状态、备份状态（含加密/异地）、Bot 开关、轻量存储用量
  metrics/           60s 主机指标采样、按范围分桶聚合、30 天保留清理
  notes/             笔记/书签、标签、FTS5、附件（origin=note）、版本历史
  shares/            单文件/多文件分享、密码/过期/次数/原子计数、公开逐项下载、吊销
  alerts/            告警条件/状态机/webhook（含世界备份/拉取/演练/异地超期）与 Bot 通知入队
  cli/               backup.mjs 对应 CLI（backup.ts）与 backup-encryption.ts（age 加密/公钥/sidecar）
  http/              路由注册、错误处理、静态资源、安全头、requestMeta 信任模型、Cloudflare Access 说明
  util/              通用工具（时间、路径、响应、只读状态文件解析 + 64 KiB 上限）
web/src/             React 页面与组件（只依赖 docs/API.md 的契约；/bots 管理页；加密/异地状态卡）
scripts/             provision/backup CLI、世界备份 backup-world.mjs、恢复演练 drill.ps1/drill-verify.mjs、
                     world-pull.ps1、backup-pull.ps1、backup-offsite.mjs/.ps1、部署/冒烟 PowerShell、
                     bootstrap-env.sh、backup-secrets.sh、check-version.mjs、check-prod-deps.mjs
scripts/test/        运维脚本单元测试（node --test .test.mjs）
deploy/              systemd（应用/健康探针/世界备份 timer）、nftables 模板（TEST-NET 占位）、
                     cloudflared ingress、env 模板、host/ 主机配置模板、tool-versions.json
```

写作用域约定：服务端改动在 `server/`，前端在 `web/`，脚本/部署在 `scripts/`、`deploy/`，文档在 `docs/` 与根 README/AGENTS/CHANGELOG；跨域改动先在本文件或任务中说明。

## 5. 安全红线（不可违反）

1. 应用 API 不提供任意 Minecraft RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
   `scripts/backup-world.mjs` 是唯一例外：以 root 由 `antifieldcloud-world.timer` 调用，只执行固定的
   `save-off` / `save-all flush` / `save-on`（`save-on` 放在 finally），应用 API 不可触达该能力。
2. 文件访问只经 DB id，不接受客户端路径；文件内容不可变；禁止覆盖上传。
3. 所有非 GET `/api` 校验 CSRF；Cookie `HttpOnly + Secure + SameSite=Lax`（仅 loopback HTTP 例外）。
4. 密码/TOTP/OpenCode 密码与任何平台/Bot 凭据、age 私钥不得进仓库、日志、错误响应、前端 bundle。
5. 预览仅白名单类型内联；SVG/HTML/XML 强制下载；文本预览上限 1 MiB。
6. 代理只允许固定 loopback 上游（`OPENCODE_URL` 启动校验，非 loopback 拒绝启动），客户端 `Authorization` 必须被覆盖；HTTP/WS 均校验 `Origin`。
7. 不修改现有 Minecraft/OpenCode/frpc/SSH 配置；不重启 Minecraft（除非用户明确授权并已备份）；nginx/certbot 旧入口已移除，不再作为监控项。
8. 部署、备份脚本必须幂等、可重试；失败要留下可诊断日志，不得静默吞错。
9. 世界备份/拉取/演练/异地状态文件由 root/PC 脚本写入，应用只读；状态文件不得包含密钥、远端真实路径或凭据；应用读取有 64 KiB 上限并降级 null。
10. Bot 凭据（QQ AppSecret）只写不读，数据库只存 AES-256-GCM 密文；
    Webhook 只以 QQ Ed25519 签名/时间戳（含 op=13 回调校验）鉴权；群聊/频道不执行任何斜杠命令；C2C 命令除自助命令（`/help`、`/memory`、`/role` 仅私聊、`/reset`、`/forget confirm`）外，需目标 `allow_commands` + 显式 user 白名单；
    发布必须 TOTP 再认证；通知/命令输出不得包含内部路径、URL 或密钥；`BOT_ENABLED=false` 时 Webhook 返回 404。
11. 备份整包加密：Pi 只读取独立 backup age 公钥（root 属主、组/其他不可写、`age1` 格式）；私钥离线 ≥2 份，应用/CLI 永不读取；**失败关闭**——age 缺失/公钥非法/加密失败/空间不足时 prepare 失败，不产生 pending、不降级明文；明文 tar 只允许短暂使用 `*.plain.tmp` 并在密文+sidecar 落盘后立即删除；空间按 2× 明文预算；明文 SHA-256/大小必须放归档外 sidecar 与 DB `manifest_json`（归档内 manifest 不得自引用）。
12. Web 不持备份私钥：`verify/import/entries/restore-plan/executeRestore` 在归档名合法化后、读取/解包前对 `.age` 返回 `409 archive_encrypted`，恢复目标自动跳过加密归档；加密归档只能由 PC/离线私钥解密、校验与恢复。
13. 异地副本只上传 `.age`（拒绝明文），链感知保留且绝不删除最新 full；状态只写别名/计数/时间，不写远端路径/URL/凭据；未配置（状态文件缺失）不得产生超期告警。
14. Bot AI 工具隔离 fail-closed：OpenCode 拒绝 `permissions` 时不得以默认权限继续对话；启用发送工具且隔离不可用时新 Chat 返回 `503 bot_ai_tool_isolation_unavailable` 并回固定提示、写审计/状态；10 分钟重试窗口到点放行重试，上游恢复后自动恢复。
15. 审计写入不得静默失败也不得回滚已完成的业务状态：非安全审计事务外 best-effort，失败计数 + 最近错误暴露到 `/api/version.audit`；安全关键审计逐条记录；公开下载计数保持在事务内。

## 6. 数据库与数据

- schema 迁移集中在 `server/src/db.ts` 的 `MIGRATIONS`，启动时按 `meta.schema_version` 顺序执行；迁移只追加，当前 schema **v16**。
  **本版无 schema 迁移**：加密归档通过归档名后缀 `.tar.gz.age` + `manifest_json`（含 `encrypted:true`）识别，不新增列/表；群共享记忆归属迁移复用现有 `bot_memory_items` 行（一次性 meta 标记 `bot_group_memory_owner_migrated_v1`），不改表结构。
  数据库 schema 高于程序支持版本时拒绝启动。
- 时间统一存 ISO 8601 UTC 字符串；展示用 `Asia/Shanghai`。
- 文件物理路径 `DATA_DIR/files/<id 前两位>/<id>`；上传先写 `DATA_DIR/tmp/` 再原子 rename；物理孤儿回收只删除超期且 DB 无行的 id 形状文件。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站与笔记附件），上限 10 GiB；`fileCount` 只统计 `origin='user'`。
- `files.origin`：`user`（普通云盘）/`note`（笔记附件，不出现在列表/搜索/回收站）/`system`（保留）。
- `bots`：平台（仅 `qq`）/名称/启用/公开配置 + `secret_ciphertext/secret_iv/secret_tag/key_version`；`bot_targets` 唯一 `(bot_id, external_id)`，
  `allow_commands`/`allow_notifications` 默认关闭/开启、`allow_chat` 默认关闭（与命令权限独立），静默时段 `quiet_start_minute`/`quiet_end_minute`（0–1439，成对设置）；
  `chat_trigger` 复用为群消息模式（mention/all，默认 mention）；`bot_deliveries` 队列（`dedupe_key` 唯一）、`bot_publish_jobs` 仅文本发布（`media_file_ids_json` 写空）、
  `bot_events` 按 `(bot_id, platform_event_id)` 去重，记录 event_kind/outcome/detail/target_external_id/user_id/updated_at 供诊断（不存正文；outcome ∈ received/ok/denied/rate_limited/ignored/error）、`bot_ai_sessions` 按 `(bot_id,target_external_id,user_id,mode)` 复用 AI 会话（mode 只写 chat，列保留）、
  `bot_ai_memories` 为 legacy 滚动摘要（`summary_session_id` 保留列；仅作迁移来源/未迁移 fallback，镜像 `DATA_DIR/bot-memory/memory-<uuid>.md`）；
  `bot_memory_items` 按 `(bot_id,user_id,kind,mem_key)` 唯一保存结构化记忆（群 scope 为 `group:<targetExternalId>`，群 key 前缀为稳定 `<member_openid>:`，显示名只存 value；无法映射的旧键加 `legacy:`）、`bot_memory_state` 按 `(bot_id,user_id)` 保存 `memory_enabled` 与 `legacy_migrated_at`；
  `bot_group_roles` 按 `target_id` 保存群聊目标共享角色卡（名字 1–32、正文 1–1000，可停用；FK 级联删除）；
  `bot_inbound_targets` 按 `(bot_id,target_external_id,user_id)` 记录最近入站目标/用户名/类型/时间（不存正文）。QQ AppSecret 不落在日志/API 响应。
- 审计只记录元数据，不记录文件内容、密码、TOTP、Cookie、Authorization；单条 actor≤64、target≤256、detail≤4 KiB。

## 7. 完成定义（DoD）

- `npm run check` 全绿；新增逻辑有对应测试（成功 + 失败路径）。
- CI 的 coverage、audit、secret-scan、依赖边界检查全绿；`npm run build` 通过。
- API 变更同步更新 `docs/API.md`；界面变更同步 `docs/UI-SPEC.md`。
- 无密钥/个人数据进入仓库；`.env` 与 `data/` 被忽略；公开文档不得写入真实域名/网段（用 `app.<domain>`/`ai.<domain>`/`mc.<domain>` 与 TEST-NET 占位）。
- 部署相关改动同步 `docs/DEPLOY.md` 并说明回滚；备份/灾备改动同步 `docs/BACKUP.md`。
- 提交信息使用 Conventional Commits（`feat:`/`fix:`/`docs:`/`test:`/`chore:`/`deploy:`）。
- 每个阶段结束给出「产出摘要 + 未决问题 + 验证证据」。

## 8. 已知环境事实（不要重复踩坑）

- Pi：`antifield@192.0.2.10` 直连（TEST-NET 占位；实际值见 `.local/DEPLOYMENT.md`）；WiFi 示例 `198.51.100.10` 与 PC 不通（AP 隔离）；直连 SSH 偶发超时，脚本需重试。
- 校园网有 Portal 认证（占位 `https://portal.<domain>`；实际端点见 `.local`）；树莓派重启后认证可能失效，表现为 Cloudflare 7844 出站阻断、tunnel 1033/公网 530；需从 Pi 出口重新完成认证，再 `systemctl reset-failed cloudflared && systemctl restart cloudflared`。
- Pi 上 Node 为 `/usr/local/bin/node`（v26.12.1，世界可执行；旧二进制保留 `/usr/local/bin/node.v26.11.1`）；npm 指向 `/home/antifield/.nvm`（12.2.0），部署时以 root 使用。
- OpenCode v2.1.4（本版目标；升级/回滚/14 项矩阵见 `docs/DEPLOY.md` §3.2；升级前必须备份 v2.1.3 二进制/data/env/unit/MCP 配置）：`127.0.0.1:4096`，Basic 用户名 `opencode`，密码来自 `/etc/opencode/opencode.env` 的 `OPENCODE_PASSWORD`（应用 env 同名键必须同步；轮换后重启 OpenCode 与 antifieldcloud）。
- Minecraft：Paper 26.1.2，RCON `127.0.0.1:25575`，密码在 `server.properties`（32 位随机），服务器语言中文，输出含 `§` 颜色码需剥离；RCON 仍监听所有接口，nftables 仅放行 loopback。
- Pi 已启用 memory cgroup；`antifieldcloud-health.timer` 每 60s 写 `/run/antifieldcloud/pi-health.json`；`age` 与（启用异地副本时）`rclone` 已安装；`unattended-upgrades` 已安装。
- 备份：应用归档为两阶段 pending/ack（未确认不删）；PC 任务参数为实际 `-PiHost/-BackupRoot`，ACL 收紧；密钥包 Pi 端 `KEEP=2` 滚动保留，PC 不再立即删除远端密钥包。
- 备份整包加密（默认关闭）：`BACKUP_ARCHIVE_ENCRYPTION=false`、`BACKUP_AGE_RECIPIENT_FILE=/etc/antifieldcloud/backup-age.pub`（root 属主 0644、组/其他不可写、单行 `age1…`）、`BACKUP_OFFSITE_STATUS_FILE=/var/lib/antifieldcloud/backup-offsite-status.json`、`ALERT_OFFSITE_MAX_AGE_HOURS=48`；该密钥对独立于 `secrets-age`，私钥离线 ≥2 份，禁止放 Pi。
- 加密归档命名 `snapshot-<stamp>[-n]-(full|inc).tar.gz.age`，外部 sidecar `<name>.meta.json`（schema 2：plainSha256/plainSize/cipherSha256/cipherSize/recipient/…），`.sha256` 始终表示密文 SHA-256；临时明文 `*.plain.tmp` 崩溃后由下次 prepare 清理 >24h 残留。
- 异地副本（默认关闭，PC 端）：`scripts/backup-offsite.mjs` + `.ps1` 由 `install-backup-task.ps1 -InstallOffsiteTask` 安装为 `AntifieldCloud-Backup-Offsite`（默认每日 13:00、6h 超时、IgnoreNew）；需用户先配置 rclone remote/凭据；只上传 `.age`，链感知保留（最新 full + 其后全部 inc + 最近 N 天）。
- 世界备份：`antifieldcloud-world.timer` 每周日 12:00（显式 Asia/Shanghai，`Persistent=true`）以 root 执行 `scripts/backup-world.mjs`，归档到 `/var/lib/antifieldcloud/world-backups`、保留 4 份；Minecraft 世界约 4.1 GiB，周备份耗时与磁盘余量按 1.5× 世界体积预留。
- 定时策略：仅项目世界备份 timer 统一到周日 12:00；健康探针保持 60s；系统维护 timer（apt/logrotate/fstrim 等）保持发行版默认。
- 备份/灾备状态文件由脚本写入、应用只读：`/var/lib/antifieldcloud/world-backup-status.json`、`world-pull-status.json`、`drill-status.json`、`backup-offsite-status.json`（0644）；Dashboard/Settings 与告警读取。
- systemd 加固：`antifieldcloud.service` 已加 `CapabilityBoundingSet=`（空）、`RestrictAddressFamilies`、`PrivateDevices`、`ProtectClock/Hostname/KernelLogs`、`RestrictSUIDSGID/Realtime` 等；`antifieldcloud-world.service` 同样加固并有 `flock`、4h 超时。
- nftables：默认拒绝入站；22 仅 `192.0.2.0/24` + `198.51.100.0/24`（TEST-NET 占位，安装前替换为实际直连/校园网段）且新建连接限速 20/min；25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`。**改 22 网段前先确认当前 SSH 来源在允许集合内**。
- SSH 仅公钥：`/etc/ssh/sshd_config.d/00-` drop-in 先于其它配置生效（禁用密码/键盘交互，保留公钥）；旧配置备份保留 **24h 回滚窗口**，回滚见 `docs/DEPLOY.md` §9.7；`fail2ban` 已安装并启用 `sshd` jail（nftables 后端，24h ban），dbfile 持久化；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后异步重启 fail2ban 恢复封禁 set。**手工 `systemctl reload nftables` 不触发该 drop-in，仍需 `systemctl restart fail2ban`**。主机级配置模板见 `deploy/host/`（sshd/fail2ban/cloudflared/journald/log2ram），`backup-secrets.sh --include-host-config` 可纳入密钥包。
- Bot 环境变量：`BOT_ENABLED`（默认 **false**）、`BOT_SECRET_KEY`（32 字节 base64，`bootstrap-env.sh` 仅在缺失时生成，`--force` 复用旧值）；`BOT_WEBHOOK_MAX_BODY_BYTES=262144`、`BOT_DELIVERY_INTERVAL_SECONDS=30`、`BOT_DELIVERY_MAX_ATTEMPTS=5`、`BOT_EVENT_RETENTION_DAYS=7`、`BOT_COMMAND_RATE_PER_MINUTE=120`、`BOT_PUBLISH_MAX_SCHEDULED_DAYS=30`、`BOT_MAX_BOTS=10`。
  AI：`BOT_AI_ENABLED=false`、`BOT_AI_PROVIDER=`、`BOT_AI_MODEL=`、`BOT_AI_TIMEOUT_SECONDS=60`、`BOT_AI_MAX_PROMPT_CHARS=2000`、`BOT_AI_RATE_PER_HOUR=120`、`BOT_AI_SESSION_RETENTION_DAYS=7`、`BOT_AI_MAX_REPLY_CHARS=4000`、`BOT_AI_VISION_ENABLED=true`、`BOT_AI_IMAGE_MAX_BYTES=10485760`、`BOT_AI_MEMORY_MAX_CHARS=4096`、`BOT_AI_MEMORY_RETENTION_DAYS=365`、`BOT_AI_MEMORY_BATCH_MESSAGES=3`、`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`；
  Chat/记忆：`BOT_CHAT_RATE_PER_MINUTE=30`、`BOT_MEMORY_MAX_ITEMS=200`、`BOT_MEMORY_PROMPT_MAX_CHARS=3000`、`BOT_MEMORY_PROMPT_MAX_ITEMS=12`、`BOT_MEMORY_TTL_EPISODE_DAYS=90`、`BOT_MEMORY_TTL_TASK_DAYS=30`；
  连通性：`BOT_CONNECTIVITY_ENABLED=true`、`BOT_CONNECTIVITY_INTERVAL_SECONDS=60`、`BOT_CONNECTIVITY_TIMEOUT_SECONDS=8`；
  群聊：`BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS=8000`、`BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS=20000`、`BOT_AI_SEND_TOOL_ENABLED=false`（启用前安装 `botmsg` MCP）；
  **连续外发：生产固定 1000ms 最小间隔（按 Bot/AppID 串行，代码内 `DEFAULT_SEND_INTERVAL_MS`；无 env 开关；测试注入 0）。**
  搜索：`BOT_SEARCH_ENABLED/URL/AUTO/MODE/MAX_RESULTS/TIMEOUT_SECONDS/MAX_SNIPPET_CHARS/LANGUAGE/SAFESEARCH/ENGINES/RATE_PER_HOUR`（`BOT_SEARCH_MODE` 仅 mcp/prefetch，非法值拒绝启动）。
  上述键均纳入 `bootstrap-env.sh` MANAGED_KEYS；生产 env 的废弃键清理用 `--force --prune-unknown`（先 `cp -a` 备份）。`BOT_SECRET_KEY` 与 DB 必须一起备份；丢失后已存 QQ AppSecret 只能重新录入。
- Bot 公开入口：`POST /api/bot/webhook/:botId`（无 session/CSRF，按平台签名鉴权）；Cloudflare Access 必须对 `/api/bot/webhook/*`、`/healthz`、`/s/*`、`/api/public/shares/*` 做 bypass，否则平台回调/健康检查/公开分享会被边缘拦截。`BOT_ENABLED=false` 时该路径返回 404。
- Bot 平台注册（QQ 开放平台）与 Cloudflare Access 策略均由用户在各自后台完成，Agent 不代替；仅 QQ 官方 Bot。
- 测试证据边界：平台适配/Chat/记忆/图片/自检/诊断/备份 tar/告警投递以进程内 mock/夹具为主，未做真实 QQ 平台限流/签名漂移/故障负路径；真实 QQ 消息验收记录见 `docs/ACCEPTANCE.md`。
- Windows 世界拉取（`scripts/world-pull.ps1`，周度）、恢复演练（`scripts/drill.ps1`）与异地副本任务由用户手动安装/配置；`install-backup-task.ps1` 安装每日应用归档拉取任务（可选 offsite）。
- Cloudflare：zone 使用占位 `example.com`；tunnel 名称 `pi`；`mc.<domain>` CNAME 到 SakuraFRP，**不要改**；`app/ai` 的 DNS 由用户手动添加；Access 主应用 + 4 个 bypass + service token 已在生产配置（见 `docs/DEPLOY.md` §5.2），service token 只保存在 gitignored `.local/cf-access.env`；严格 CSP 会拦截 Web Analytics/Challenge 注入，需后台关闭自动注入或接受报错。生产探测确认 `ai` 主机未受 Access 保护，应用侧已加未认证限流与审计去重，建议后续在 Cloudflare 后台补 Access/WAF。
- 旧项目 PiForge 的残留（sudoers 注释、禁用的计划任务）保持原样，不继承、不清理。
- 公开仓库中的域名/IP/网段/备份路径均为示例/占位值；本机实际部署信息见 `.local/DEPLOYMENT.md`（gitignored，不提交）。

## 9. 用户手动步骤（Agent 不得代替）

1. Cloudflare 后台添加 `app`/`ai` CNAME（已由用户完成）。
2. 交互式运行 provisioning，设置密码、扫描 TOTP、保存恢复码。
3. 安装/重装 Windows 每日应用归档计划任务（`install-backup-task.ps1`，需管理员 PowerShell）；仓库更新后必须重装一次，刷新复制的 `backup-pull.ps1`、脚本 SHA 与安装标记。
4. 离线保存 age 私钥（密钥包与备份整包加密各一套，互不复用）；把 `ALERT_WEBHOOK_URL` 写入 env 后重启应用。
5. 手动安装 Windows 周度世界拉取任务（`scripts/world-pull.ps1`，`-PiHost/-BackupRoot`）与恢复演练任务/手跑（`scripts/drill.ps1`，建议季度或升级前；schema 期望值默认来自 `deploy/tool-versions.json`）；确认直连网线可通。
6. 应用新 nftables 规则前，确认当前 SSH 来源在允许网段内（模板为 TEST-NET 占位，先替换为实际网段，否则会锁死）；保留物理键鼠/已建立 SSH 作为回滚通道。
7. 备份整包加密启用（默认关闭）：离线生成独立 age 密钥 → Pi 写公钥（root、组/其他不可写）→ 用私钥完成一次 `age -d` 解密与 `drill.ps1 -AgeIdentityPath` 演练 → 设 `BACKUP_ARCHIVE_ENCRYPTION=true` 并重启 → 下一次 prepare 生成 `.age` → PC 拉取/ack → 再演练。回滚：关开关恢复明文，已生成 `.age` 保留（仅 PC 可解密）。
8. 异地副本启用（默认关闭）：PC 安装配置 rclone remote/凭据 → `install-backup-task.ps1 -InstallOffsiteTask -OffsiteRemote …` → 手跑一次确认状态 JSON 回写与 `plaintextSkipped=0` → 确认告警阈值 `ALERT_OFFSITE_MAX_AGE_HOURS`。
9. Cloudflare Access：已通过 API 配置主应用（One-time PIN + Owner allow + Service Auth）与 4 个 bypass；service token 存放在 PC `.local/cf-access.env`（gitignored）。轮换 service token 后同步该文件，并用 `smoke.ps1 -AccessClientId/-AccessClientSecret` 重跑；配置用高权限 API Token 完成后应 Revoke。
10. Bot 平台后台注册（QQ 官方 Bot，用户在 q.qq.com 完成，Agent 不代替）：创建机器人取得 AppID/AppSecret → 在 `/bots` 新建 QQ Bot 录入 → 回调地址填 `https://app.<domain>/api/bot/webhook/<botId>` 并处理 `op=13` 校验 → 订阅 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`/`AT_MESSAGE_CREATE` → 登记目标 → 开启 `BOT_ENABLED=true` 并重启。图片理解需 `BOT_AI_ENABLED=true` 且模型支持 image。
11. 最终公网/手机/PWA 验收；完成正式恢复演练并记录到 `docs/BACKUP.md` §7 与 `docs/ACCEPTANCE.md`。
12. SSH 仅公钥切换后保留 **24h 回滚窗口**：确认新会话/自动化脚本（smoke、备份、世界拉取）均能公钥登录后，再按 `docs/DEPLOY.md` §9.7 结束回滚窗口。
