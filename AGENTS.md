# AGENTS.md — AntifieldCloud 工程约定（后续所有 Agent 会话必读）

## 0. 项目一句话

在 Raspberry Pi 5（Debian 13，8 GB）上运行的自托管个人工作台：统一登录（密码 + TOTP）、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态/白名单、opencode 反代、PWA、可观测性、主机告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。产品名 `AntifieldCloud · 个人工作台`。当前版本 v0.4.2，数据库 schema v6（迁移 5 为结构变更，迁移 6 为孤儿分享数据修复，不改变表结构）；OpenCode 服务端 v2.1.1。

权威文档：
- `docs/PLAN.md`：范围、决策、阶段与验收
- `docs/API.md`：HTTP 契约（服务端/前端共同遵守）
- `docs/UI-SPEC.md`：界面与交互
- `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`
- `docs/ROADMAP.md`：路线图与当前版本边界
- `docs/AUDIT.md`：第一轮 v0.2.0 + 第二轮 v0.3.x 审计与残留
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
- 类型工具链（TS7 并排）：`npx tsc` 来自 `@typescript/native`（TypeScript 7.0.2）；`typescript` 包是 `@typescript/typescript6@6.0.2` 别名，仅供 typescript-eslint（8.x 尚不支持 TS7 API）。不要删除/合并这两个 alias，直到 typescript-eslint 支持 TS7.1 API。
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
node scripts/check-version.mjs # 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS 的版本一致
```

当前基线：`npm test` 234 项通过（服务端 218 + 运维脚本 16），`npm run test:web` 129 项通过。测试禁止依赖真实 Minecraft、真实 opencode、真实 network；使用进程内假服务器/夹具。Windows 上无法测试的 systemd 相关用例用 `t.skip` 并在 Linux 上跑；`scripts/test/` 覆盖世界备份与恢复演练校验脚本（纯函数/夹具，不触碰真实 Pi）。

## 4. 目录与模块边界

```text
server/src/
  main.ts            进程入口：配置、DB、Fastify、信号退出、启动指标采样
  config.ts          环境变量解析与校验（失败即退出）
  logger.ts          Fastify/pino 日志与脱敏
  db.ts              SQLite 打开、迁移（当前 schema v6）、事务辅助
  auth/              scrypt、TOTP、会话、CSRF、限流、恢复码、审计（字段截断）
  files/             存储、上传、配额、搜索、预览、回收站、files.origin 可见性
  uploads/           分片上传会话/块索引、配额预留、拼接与过期清理
  mc/                SLP、RCON、白名单
  opencode/          ai.* Host 的认证反代 + HTML 模式（shim/attributes/passthrough）+ Origin 校验
  backups/           归档导入/校验、文件级恢复（skippedMissing）、世界/拉取/演练状态只读
  dashboard/         主机指标、服务状态、备份状态、轻量存储用量（/api/storage）
  metrics/           60s 主机指标采样、按范围分桶聚合、30 天保留清理
  notes/             笔记/书签、标签、FTS5、附件（origin=note）、版本历史
  shares/            单文件/多文件分享、密码/过期/次数/公开逐项下载
  alerts/            告警条件/状态机/webhook（含世界备份/拉取/演练超期）
  http/              路由注册、错误处理、静态资源、安全头
  util/              通用工具（时间、路径、响应、只读状态文件解析）
web/src/             React 页面与组件（只依赖 docs/API.md 的契约）
scripts/             provision/backup CLI、世界备份 backup-world.mjs、drill-verify.mjs、
                     world-pull.ps1、drill.ps1、部署/冒烟 PowerShell、check-version.mjs
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

## 6. 数据库与数据

- schema 迁移集中在 `server/src/db.ts` 的 `MIGRATIONS`，启动时按 `meta.schema_version` 顺序执行；迁移只追加，
  当前 schema v6（迁移 5：`files.origin`、唯一索引含 origin、`note_attachments`/`note_versions`/`share_items`/`metrics_samples`；
  迁移 6：删除孤儿 shares 并回填 `share_items`，不改表结构）。数据库 schema 高于程序支持版本时拒绝启动。
- 时间统一存 ISO 8601 UTC 字符串；展示用 `Asia/Shanghai`。
- 文件物理路径 `DATA_DIR/files/<id 前两位>/<id>`；上传先写 `DATA_DIR/tmp/` 再原子 rename。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站与笔记附件），上限 10 GiB；`fileCount` 只统计 `origin='user'`。
- `files.origin`：`user`（普通云盘）/`note`（笔记附件，不出现在列表/搜索/回收站）/`system`（保留）。
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
- Pi 上 Node 为 `/usr/local/bin/node`（v26.11.1，世界可执行）；npm 指向 `/home/antifield/.nvm`，部署时以 root 使用。
- opencode：`127.0.0.1:4096`，服务端 **v2.1.1**（2026-10-20 由 v2.0.32 升级；升级/回滚见 `docs/DEPLOY.md`），Basic 用户名 `opencode`，密码来自 `/etc/opencode/opencode.env` 的 `OPENCODE_PASSWORD`（应用 env 同名键必须同步；轮换后重启 opencode 与 antifieldcloud）。
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
- Windows 世界拉取（`scripts/world-pull.ps1`，周度）与恢复演练（`scripts/drill.ps1`）计划任务由用户手动安装；
  `install-backup-task.ps1` 只安装每日应用归档拉取任务。
- Cloudflare：zone `example.com`；tunnel 名称 `pi`；`mc.example.com` CNAME 到 SakuraFRP，**不要改**；
  `app/ai` 的 DNS 由用户手动添加；严格 CSP 会拦截 Web Analytics/Challenge 注入，需后台关闭自动注入或接受报错。
- 旧项目 PiForge 的残留（sudoers 注释、禁用的计划任务）保持原样，不继承、不清理。
- 公开仓库中的域名/IP/备份路径均为示例值；本机实际部署信息见 `.local/DEPLOYMENT.md`（gitignored，不提交）。

## 9. 用户手动步骤（Agent 不得代替）

1. Cloudflare 后台添加 `app`/`ai` CNAME（已由用户完成）。
2. 交互式运行 provisioning，设置密码、扫描 TOTP、保存恢复码。
3. 安装/重装 Windows 每日应用归档计划任务（`install-backup-task.ps1`，需管理员 PowerShell）。
4. 离线保存 age 私钥；把 `ALERT_WEBHOOK_URL` 写入 env 后重启应用。
5. 手动安装 Windows 周度世界拉取任务（调用 `scripts/world-pull.ps1`，`-PiHost/-BackupRoot`）与恢复演练任务/手跑
   （`scripts/drill.ps1`，建议季度或升级前）；确认直连网线可通。
6. 应用新 nftables 规则前，确认当前 SSH 来源在 `169.254.77.0/24` 或 `172.23.88.0/21` 内（否则会锁死）；
   保留物理键鼠/已建立 SSH 作为回滚通道。
7. 旧 `minecraft-backups` cron 已停用、legacy 归档已清理；如后续手工重建 cron 或旧目录，按 `docs/DEPLOY.md` 处理并再次确认迁移。
8. 最终公网/手机/PWA 验收；完成正式恢复演练并记录到 `docs/BACKUP.md` §7 与 `docs/ACCEPTANCE.md`。
