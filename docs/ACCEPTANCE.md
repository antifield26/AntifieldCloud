# AntifieldCloud 验收记录

> 当前版本 v0.5.0；v0.4.2 / v0.4.1 / v0.4.0 / v0.3.2 / v0.3.1 / v0.3.0 / v0.2.2 / v0.2.1 / v0.2.0 作为历史保留。v0.1.0 的交付摘要见 CHANGELOG。
>
> v0.5.0 已于 2026-10-21 部署到生产 Pi（release `20261021T060807Z`，schema v7，smoke 23/23）；Bot 三平台真实联调与 Cloudflare Access 策略由用户在各自后台完成。

## v0.5.0（当前）

- 日期：2026-10-21（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境 + Windows 本地工作区
- 版本：`v0.5.0`
- 范围：Bot 平台（Telegram/Discord/Slack）、schema v7、Bot 凭据加密与 Webhook/命令/通知/发布安全边界、部署/回滚/SSH/Cloudflare Access/备份任务运维收口、第四轮审计与文档同步。

### 1. 交付

- **Bot 平台**：`server/src/bot/`（`crypto.ts` AES-256-GCM、`service.ts` 配置/验签/命令/通知/发布队列、三平台适配器、模板）与 `server/src/http/routes/bots.ts`、`bot-webhook.ts`；Web `/bots` 四分区页面。
- **命令**：`/help` `/status` `/backup` `/world` `/mc` `/files <关键词>`；目标 `allow_commands` + 显式 user 白名单双校验；输出清洗路径/URL、文件元数据 ≤10 条。
- **通知/发布**：告警事件按目标 `allow_notifications` 入队（`dedupe_key` 去重）；发布 TXT + 最多 1 个云端普通文件媒体（≤10 MiB）、频道/群组、TOTP 再认证、定时 ≤30 天、取消、指数退避重试/死信重投。
- **数据**：schema v7（迁移 7 新增 `bots/bot_targets/bot_deliveries/bot_publish_jobs/bot_events`；迁移 6 孤儿 shares 修复保留）；Bot 凭据只存密文；`bot_events` 7 天、已发送投递/发布 30 天清理。
- **安全**：Token 只写不读；签名 + 时间戳（±300 秒）+ 事件去重；IP 120/min、Bot 300/min、命令 20/min、发布/测试 20/h；未授权命令不执行并审计；`BOT_ENABLED=false` 时 Webhook 404、写接口 503。
- **运维**：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY`（`--force` 不轮换）；`deploy.ps1` 干净工作树门禁、回滚还原 `APP_VERSION`、smoke 失败门禁；`check-version` 覆盖 env.example/DEPLOY 标题/lock；SSH 仅公钥 `00-` drop-in + 24h 回滚 + `fail2ban` sshd jail；Cloudflare Access 策略与 bypass 文档；`backup-world.mjs` 信号时优先 `save-on`。
- **审计/文档**：`docs/AUDIT.md` 第四轮（v0.4.2 基线 P0=0/P1=0/P2=3/P3=12；Bot WIP P1=2/P2=4，已修复项带测试/命令）；README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ACCEPTANCE/AUDIT 与 `docs/BOT.md`、`deploy/env.example` 全量同步到 0.5.0。
- **测试**：新增 `server/test/bot-core.test.ts`（6）、`bot-routes.test.ts`（1）、`bot-webhook-route.test.ts`（1）、`bot-migration.test.ts`（1）与 `web/src/pages/Bots.test.tsx`（8）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm test` | **245/245 通过**（服务端 229 + 运维脚本 16；本地工作树实测，2026-10-21） |
| `npm run test:web` | **137/137 通过**（27 个测试文件；本地工作树实测） |
| `npm run typecheck` / `lint` | 通过（2026-10-21 本地工作树；TS7 native + ESLint 0 警告） |
| `npm run check` | 通过（245 服务端/脚本 + 139 前端；2026-10-21 部署前最终工作树） |
| `npm run build` | 通过（部署时构建 `web/dist`，v0.5.0） |
| 覆盖率（`test:coverage` / `test:web:coverage`） | 服务端覆盖率门禁通过；前端门禁通过（Lines 约 39%） |
| CI（main/tag） | **success**：main run `39554286586`、v0.5.0 tag run `39554290976`（8 job 全绿，2026-10-21） |
| schema | **v7**（`/healthz.schemaVersion=7`；迁移 6 保留 + 迁移 7 五张 Bot 表；`bot-migration` 测试通过） |
| 应用部署 / `/healthz` | release `20261021T060807Z`；`version=0.5.0`、`schemaVersion=7`；迁移前快照 `db-predeploy-20261021T060832328Z.sqlite`（sha256 `36ab1dd4…`） |
| `smoke.ps1 -ExpectedVersion 0.5.0 -ExpectedSchemaVersion 7` | **23 通过 / 0 失败 / 0 警告**（部署后只读 smoke 16/16；完整 smoke 含公网/CSP/PWA/备份/世界/演练） |
| Bot 关闭态 | 部署后未设 key 时 Webhook POST 返回 404、`/api/bots/status` 未登录 401；生成 32 字节 `BOT_SECRET_KEY` 后显式 `BOT_ENABLED=true` |
| Bot 三平台联调 | **待用户在平台后台录入 Token/签名密钥后完成**（Telegram/Discord/Slack 各一条命令/通知/发布；本机只验证到 mock/契约与路由） |
| 备份/世界拉取/演练 | 新密钥包 `secrets-20261021T061307Z.tar.age`（8 文件，含 env/BOT key；opencode 快照告警）；世界备份/拉取/演练状态 smoke 通过 |
| SSH 仅公钥 / Access bypass | `sshd -T` 为 `passwordauthentication no`/`permitrootlogin no`；公钥新会话与密码拒绝均实测；fail2ban sshd jail active。Cloudflare Access 策略/bypass **待用户后台配置** |

### 3. 部署

```text
应用: v0.5.0（release /opt/antifieldcloud/releases/20261021T060807Z；迁移前快照 db-predeploy-20261021T060832328Z.sqlite）
schema: v7（迁移 6 保留 + 迁移 7 新增 5 张 bot* 表）
BOT_SECRET_KEY: bootstrap-env.sh --force 生成（32 字节 base64，不回显）；密钥包 secrets-20261021T061307Z.tar.age 已包含 env
Cloudflare Access: 待用户后台配置 app 策略 + webhook/health/分享 bypass
SSH: 仅公钥（00-antifield-hardening.conf，2026-10-21 13:49 CST 切换；24h 回滚窗口至 10-22 13:49）；fail2ban sshd jail 已启用
tag: v0.5.0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.5.0
```

### 4. 未决

- `npm run check`、`npm run build`、CI、smoke、Bot 平台联调与部署证据由主代理在部署后补齐；在此之前本文件不构成 v0.5.0 验收通过。
- Bot 适配器/队列测试为进程内 mock（T/S mock-only）；真实平台限流、签名漂移、平台 5xx 的负路径需沙箱联调。
- Cloudflare Access 策略/bypass 需用户在后台配置，应用侧无法自证；未配置时 Webhook/health/公开分享会被边缘拦截。
- SSH 24h 回滚窗口内保留旧 drop-in 备份；`fail2ban` sshd jail 已启用（nftables 后端），但 nftables 重载后需重启 fail2ban 恢复封禁；`antifield` 的 `NOPASSWD ALL` sudo 未改（残余）。
- `typescript-eslint` 仍不支持 TS7 API，`@typescript/typescript6` 双 alias 保留到其支持 TS7.1。
- Bot 单次发布最多 1 个媒体文件、命令严格只读、无平台主动拉取/长连接；`BOT_SECRET_KEY` 轮换需重录全部 Token。

## v0.4.2（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境 + Windows 本地工作区
- 版本：`v0.4.2`
- 范围：TypeScript 7 兼容性迁移；Android 指标趋势周期选择器窄屏修复；工作区清理与文档对齐；应用发布。

### 1. 交付

- **TypeScript 7**：按官方并排方案，`@typescript/native` 别名安装 TypeScript 7.0.2（提供 `tsc` 7.0.2），`typescript` 别名指向 `@typescript/typescript6@6.0.2` 供 typescript-eslint 8.71.2（尚不支持 TS7 API）；`npm ci` 可复现，typecheck/lint/test/build 全绿。
- **Android 趋势布局**：`.segmented-button` 增加 `flex: 0 0 auto` 与 `white-space: nowrap`；≤900px 时趋势卡头部纵向排列、范围选择器占满一行并横向滚动（隐藏滚动条），周期文字不再被压缩；范围切换/aria/轮询逻辑不变。
- **工作区清理**：删除生成的 `web/coverage`、`web/node_modules` 缓存、`web/.vite-temp` 等；重新构建 `web/dist`；保留 `scripts/*` 中仍在使用的稳定入口（`backup.mjs`/`provision.mjs` 被服务端与文档引用）。
- **文档对齐**：README/AGENTS/PLAN/ROADMAP/UI-SPEC/API/DEPLOY/BACKUP 版本与测试基线同步；CI 增加 `check-version.mjs`。
- 应用 v0.4.2，schema v6 不变；无服务端功能变更。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm ci --dry-run` | 通过（lockfile 与 TS alias 可复现） |
| `npx tsc --version` | **7.0.2** |
| `npm run typecheck` / `lint` | 通过（lint 使用 `typescript@6.0.2` alias） |
| `npm run check` | 通过：服务端/脚本 234、前端 129 |
| `npm run build` | 通过（web/dist 重建） |
| CI（main） | success（run `39450435315`，含 TS7/Android/清理与文档） |
| Android 真机 | CSS 修复已在 Edge headless 390×420 视口渲染验证：周期标签完整不压缩、刷新按钮换行；真实 Android 浏览器待用户复测 |
| 应用部署 | release `/opt/antifieldcloud/releases/20261020T153138Z`；healthz `0.4.2`；迁移前快照 `db-predeploy-20261020T153204366Z.sqlite`；部署后只读 smoke 15/15 |
| `smoke.ps1` | **22 通过 / 0 失败 / 0 警告**（含公网/CSP/PWA/分享/告警/服务/版本/cgroup/nftables/备份/世界/演练/脚本 hash/本地 SHA） |

### 3. 部署

```text
应用: v0.4.2（release 20261020T153138Z；迁移前快照 db-predeploy-20261020T153204366Z.sqlite）
类型工具链: tsc 7.0.2（@typescript/native）+ typescript 6.0.2 alias（typescript-eslint）
Pi: schema v6 不变；OpenCode v2.1.1 不受影响
tag: v0.4.2
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.4.2
```

### 4. 未决

- `typescript-eslint@8.71.2` 不支持 TS7 API，双 alias 需保留到其支持 TS7.1；升级 typescript-eslint 后重新评估移除 `@typescript/typescript6`。
- Android 真机验收由用户完成（本次仅代码/CSS 级修复与构建验证）。
- 工作区未删除 `scripts/backup.mjs`/`provision.mjs`：它们是服务端 `backups/service.ts`、部署/备份文档依赖的稳定入口，删除需跨域改代码，不在本维护版做破坏性清理。

### 5. 运维调整：定时任务统一 12:00（2026-10-21）

- 盘点：Pi 上无 cron（antifield/root）、无 at、无用户 timer；项目 timer 仅 `antifieldcloud-health.timer`（每 60s）与 `antifieldcloud-world.timer`。
- 调整：`antifieldcloud-world.timer` 改为 **`OnCalendar=Sun 12:00 Asia/Shanghai`**，`Persistent=true`；`antifieldcloud-world.service` 不变。
- 验证：`systemctl list-timers antifieldcloud-world.timer` 显示下次 `Sun 2026-10-25 12:00:00 CST`；timer active、`Persistent=yes`；健康探针仍约每 60s 触发。
- 例外：健康探针保持 60s（改为每日会失去监控/告警意义）；OS 维护 timer（apt-daily、logrotate、fstrim、log2ram、e2scrub、systemd-tmpfiles 等）保持发行版默认，不属于项目任务。
- Windows：`AntifieldCloud-Backup-Pull` 已是每日 12:00（另有登录后补跑）；周度 world-pull/drill 任务未安装。
- 时区/周期确认：**用户 2026-10-21 确认不改系统维护 timer、维持健康探针周期**；仅世界备份 timer 在周日 12:00。
- 回滚：`/etc/systemd/system/antifieldcloud-world.timer.bak-v042` + `systemctl daemon-reload && systemctl restart antifieldcloud-world.timer`。
- 文档：`deploy/antifieldcloud-world.timer`、README/AGENTS/ARCHITECTURE/BACKUP/DEPLOY/PLAN 已同步；CHANGELOG 记入 Unreleased。

## v0.4.1（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.4.1`
- 范围：OpenCode 服务端 v2.0.32 → v2.1.1 升级与兼容性复核；Dependabot CI action 更新；Pi legacy 世界归档清理；OpenCode Basic 密码轮换；应用版本发布。

### 1. 交付

- OpenCode 升级：`opencode upgrade --method curl`（v2.0.32 → v2.1.1）；升级前备份二进制、配置、数据到 `/var/backups/opencode/`（93 MB 二进制 tar + 2 MB 数据 tar + env/service 副本）。
- 兼容性：Basic `/api/session`、`POST /api/session`（垫片新建会话路径）、`/api/config|agent|provider`、真实 HTML 垫片注入（`data-cfasync` + `__af/oc-help.js`）、公开 `ai.*` 401、app healthz 全部正常；Web 包仍含“新建会话/New session”标记，垫片选择器匹配。
- 凭据：轮换 OpenCode Basic 密码，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env`、两个 `service.json`；重启 opencode/antifieldcloud 后 Basic 200、应用 healthz 200。
- 依赖：合并 Dependabot `actions/checkout` 4→7、`actions/setup-node` 4→7、`gitleaks/gitleaks-action` 2→3；main CI 全绿；不兼容的 TypeScript 7 major PR 已关闭。
- 清理：删除 Pi `/home/antifield/minecraft-backups` 3 个 legacy 世界归档（约 9 GiB），磁盘可用从 31 GiB 增至 **40 GiB**；新世界备份与 PC `world` 副本保留，旧 cron 保持停用。
- 应用：版本升至 0.4.1 并部署（代码无功能变更，仅版本/文档与运行环境变更）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端/脚本 234、前端 129（与 v0.4.0 相同基线） |
| CI（main/tag） | 通过（含 PR 合并后的最新 main） |
| OpenCode 版本 | `opencode v2.1.1`；`opencode.service` active，监听 127.0.0.1:4096 |
| 兼容性 API | Basic `/api/session` 200；`POST /api/session` 200（`data.id` 形状不变）；`/api/config|agent|provider` 均 200 |
| HTML/垫片 | 真实首页 6,962 B、1 个 module script；`injectOpenCodeShim` 插入 `__af/oc-help.js` + 3 个 `data-cfasync="false"`；bundle 含“新建会话/New session/新会话” |
| 公开入口 | `https://ai.antifield.work/` 401（未登录）；`https://app.antifield.work/healthz` 200 |
| 密码轮换 | env(两份) 一致、Basic 200、应用 healthz 200、代理与 dashboard 探测路径不变 |
| 旧归档清理 | `/home/antifield/minecraft-backups` 已删除；`df /` 可用 40 GiB；新 `world-backups` 与 PC 副本保留 |
| 应用部署 | release `/opt/antifieldcloud/releases/20261020T150609Z`；healthz `0.4.1`；迁移前快照 `db-predeploy-20261020T150659110Z.sqlite`；部署后只读 smoke 15/15 |
| `smoke.ps1` | **22 通过 / 0 失败 / 0 警告**（含公网/CSP/PWA/分享/告警/服务/版本/cgroup/nftables/备份/世界/演练/脚本 hash/本地 SHA）；直连 SSH/TCP 偶发瞬时超时，重试后通过 |

### 3. 部署

```text
OpenCode: v2.1.1（/var/lib/opencode/.opencode/bin/opencode）
备份: /var/backups/opencode/opencode-v2.0.32-bin-*.tar.gz、opencode-data-*.tar.gz
Pi: 旧 legacy 世界归档已清理；旧 cron 停用
应用: v0.4.1（release 20261020T150609Z；迁移前快照 db-predeploy-20261020T150659110Z.sqlite）
nftables: 22 限速调整为 20/min burst 40（兼容 smoke/备份的多次 SSH）
tag: v0.4.1
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.4.1
```

### 4. 未决

- OpenCode UI 原生“新建会话”按钮/WS 实时事件需用户浏览器最终复测（垫片与 API 路径已验证，但无登录凭据做端到端浏览器验收）。
- OpenCode 2.1.1 发布说明未取到（GitHub API 该版本 notes 不可用），兼容性以实际接口/HTML 验证为准。
- 后续升级建议按 `docs/DEPLOY.md` 的备份/验证/回滚流程执行，并复测本表兼容项。

## v0.4.0（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.4.0`
- 范围：第三轮深度审计与 P0/P1/非破坏 P2 修复；可观测性（指标历史/筛选/备份状态）；笔记附件与版本历史；多文件打包分享；Minecraft 世界一致性备份/PC 拉取/恢复演练自动化；工程与 CI 门禁；系统加固。

### 1. 交付

- 审计：`docs/AUDIT.md` 第三轮（4 路并行只读审计 + Lead 复核）；六维评分卡；P0/P1 修复与残余风险清单。
- 数据：migration 5（`files.origin`、含 origin 唯一索引、`note_attachments`、`note_versions`、`share_items` 回填、`metrics_samples`）+ migration 6（孤儿 shares 数据修复，不改表结构）；v4→v6 迁移测试。
- 可观测性：60s 采样/30 天保留、`GET /api/metrics`（1h/6h/24h/7d/30d、≤240 点）；Dashboard 四张 SVG 趋势卡；Activity 搜索/时间范围；AlertsCard 筛选分页；备份健康卡（应用归档/密钥包/pending/acked/孤儿/世界备份/PC 拉取/演练）。
- 笔记：附件（1–5/请求、25 MiB、每笔记 100、计入配额、origin=note 隐藏）；版本历史（变更快照、保留 20、预览/恢复）。
- 分享：多文件 `POST /api/shares`（1–50 个、`itemCount/totalSizeBytes`）；公开页 items + 逐文件下载；次数按会话计；删除文件吊销整个分享。
- 世界备份：`scripts/backup-world.mjs`（save-off/save-all flush/save-on finally、tar 0/1 容忍、gzip 校验、SHA/状态、保留 4）+ weekly systemd timer；旧 cron 验收后停用，旧 9 GiB 归档保留。
- 灾备：`scripts/world-pull.ps1` 两阶段拉取（PC 保留 4）；`scripts/drill.ps1` + `drill-verify.mjs` 恢复演练（SHA/tar/DB integrity/manifest，报告 180 天）；状态文件接入 Dashboard 与告警（world/pull/drill stale）。
- 工程：版本单源（package.json，app 默认读取）；CI 覆盖 check/coverage/audit/secret-scan/shellcheck/nftables/PowerShell + Dependabot；`test:coverage`/`test:web:coverage`；部署脚本版本注入/DB 回滚/预检/smoke；PS 5.1 UTF-8 修复；bootstrap-env 保留未知键；systemd 加固；nftables 22/25565 收窄。
- 测试：服务端/脚本 **234**（服务端 218 + 运维脚本 16）、前端 **129**；`npm run check` / `npm run build` 通过。
- 文档：API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ROADMAP/PLAN/AGENTS/README/CHANGELOG 同步。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端/脚本 234/234（服务端 218 + 脚本 16）、前端 129/129 |
| `npm run build` | 通过（Vite 构建，chunk 体积警告已知） |
| 覆盖率 | 服务端 lines/functions/branches 91.7/86.7/77.4；前端 36.6/31.5/34.2（阈值 75/75/65 与 35/30/33） |
| schema | v6；v4→v6 迁移测试通过；生产启动日志 `migrated to schema v5`/`v6` |
| 部署 | 成功：`/opt/antifieldcloud/releases/20261020T135813Z`；迁移前快照 `db-predeploy-20261020T135842657Z.sqlite`；自动回滚流程已由脚本实现 |
| 生产 Health | `{"ok":true,"version":"0.4.0"}`；服务 active、`systemctl --failed` 0 |
| `smoke.ps1` | **22 通过 / 0 失败 / 0 警告**（公网/CSP/PWA/分享 404/告警 401/服务/版本/cgroup/nftables/备份/世界/演练/脚本 hash/本地 SHA） |
| 世界备份 | systemd 手动触发成功：`world-20261020T140037Z.tar.gz`，3,203,778,333 B，SHA-256 `d9e5049298ec68f9cbbae43186e6ebf02617bbd554b714a584af6609bf18b85e`；`saveOffOk/saveOnOk=true`、tar/gzip 校验通过；timer 已 enable（周日 04:00） |
| PC 世界拉取 | `world-pull.ps1` 成功：拉取 1、待拉取 0、本地保留 1、SHA 校验通过；远端已 ack 删除；`world-pull-status.json` ok=true |
| 恢复演练 | `drill.ps1 -ExpectedSchemaVersion 6 -IncludeWorld` 通过：full+inc 链 SHA/manifest、DB schema=6/integrity=ok/FK 0 违规、世界 `world/level.dat` 解包校验成功；报告 `D:\Backups\AntifieldCloud\drills\20261020T140730Z`，已回写 Pi |
| 旧 cron | 已停用（原 `minecraft-backups` 行移除，备份 `/home/antifield/crontab.bak-v040`）；旧 9 GiB 归档保留未删 |
| 系统加固 | app unit 加固后 `systemd-analyze security` ≈3.2 OK；nftables 22/25565 收窄到直连/校园网段且 22 限速，应用后新 SSH、25565、25575 行为符合预期 |
| 指标采样 | 部署后 22 条 `metrics_samples`（60s 采样运行中）；`/api/metrics` 未登录 401 |
| 功能抽查 | 自动化测试覆盖指标/附件/版本/多文件分享/备份状态；公网 UI 交互与 390px/PWA 需用户最终人工验收 |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T135813Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T135842657Z.sqlite
服务: antifieldcloud.service (active, v0.4.0)；schema v6
tag: v0.4.0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.4.0
```

### 4. 未决

- SSH/sudo 暴露面按用户选择仅文档披露（未改配置）；建议后续收敛（见 AUDIT §4）。
- 增量备份时钟水位（DR-1）、导入归档保留（DR-7）、告警未投递重试（DR-22）等列后续。
- 5 GiB 公网上传未跑满；世界备份/拉取/演练已完成首轮生产验证，后续按周/季度执行。
- Windows 周度世界拉取与演练计划任务需用户手动安装（AGENTS §9）。
- 旧 `/home/antifield/minecraft-backups` 约 9 GiB 未自动删除，确认 PC 副本后手动清理。
- 真机 390px/PWA 视觉与交互需用户最终人工验收。

## v0.3.2（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.3.2`
- 范围：旧 nginx/certbot 入口与 TLS 状态清理、服务监控收敛、workbench/piforge/旧配置清理。

### 1. 交付

- 移除 `nginx`/`nginx-common`/`certbot`/`python3-certbot*` 及 `/etc/nginx`、`/etc/letsencrypt`、`/var/www/html`、nginx 日志/状态；80 端口无监听。
- `minecraft/cloudflared/opencode` 为受监控服务；Dashboard/告警/前端状态卡同步为 3 项，避免 nginx 误报。
- nftables 移除 80 端口放行，仅保留 25565。
- 删除 workbench 用户/组/103M 旧数据、piforge subuid/gid、旧 `antifieldcloud.service.pre-*`、`cloudflared-update.*`、旧 env/RCON 备份；`.local` 清理旧脚本/全量快照/样本/历史 bundle。
- 文档/烟测脚本更新为 4 个系统服务（不含 nginx）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 150/150、前端 52/52 |
| `npm run build` | 通过 |
| 生产 Health | `{"ok":true,"version":"0.3.2"}` |
| `smoke.ps1` | 16/16（服务状态 4 项 active） |
| 旧入口 | nginx/certbot inactive/not-found；80 无监听；`/etc/nginx`、`/etc/letsencrypt` 已删除 |
| 服务监控 | minecraft/cloudflared/opencode 3 项；`systemctl --failed` 0 |
| 残留清理 | workbench/piforge/旧 unit/旧 env/RCON 已清理；`.local` 仅保留部署/演练/扫描/age 私钥 |
| 备份 | `lastPullAt=2026-10-20T04:00:08Z`，secretsOk=true |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T102328Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T102331729Z.sqlite
服务: antifieldcloud.service (active, v0.3.2)
tag: v0.3.2
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.3.2
```

### 4. 未决

- 5 GiB 真实公网上传未跑满；OpenCode 上游原生按钮仍失效，保留最小隐藏接管。
- RCON 仍监听所有接口（Paper 无 bind 配置），由 nftables 阻断非 loopback。
- age 私钥仍需用户离线化；Minecraft 世界未纳入应用备份。

## v0.3.1（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.3.1`
- 范围：5 GiB 分片上传/断点续传；配套系统加固（journald、cloudflared、nftables、rpcbind）。

### 1. 交付

- 后端：`UploadService` + `/api/uploads` init/status/chunk/complete/abort；migration 4 `upload_sessions/upload_chunks`；8 MiB 块、5 GiB 上限、24h 会话、每用户 3 并发、配额预留、乱序/幂等/哈希校验、过期清理。
- 前端：>100 MiB 自动分片，2 块并发；`localStorage` 只保存 uploadId/已收块号；刷新/断线补缺块；取消保留断点；进度/重试沿用上传面板。
- 系统：journald `Storage=persistent`（适配 log2ram 64 MiB）、cloudflared 升级 2026.10.1 + systemd 加固、nftables WiFi 源从 `/16` 收窄到实际 `/21`、rpcbind 禁用、unattended-upgrades dry-run 验证。
- 文档：API/UI/ARCH/SECURITY/DEPLOY/PLAN/ROADMAP/README/AGENTS/CHANGELOG 同步。
- 第二轮审计补档：`docs/AUDIT.md`（A2-01～A2-10，含执行边界与残留）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 150/150、前端 52/52 |
| `npm run build` | 通过 |
| 生产 Health | `{"ok":true,"version":"0.3.1"}` |
| schema | v4；`upload_sessions/upload_chunks` 存在 |
| 分片 API | 生产 12 MiB（8 MiB + 尾块）init→chunk→status→complete 成功，文件登记后删除/清空 |
| 前端 | tsc/eslint/test:web 通过；分片纯函数 4 组测试 |
| 系统 | journald persistent、cloudflared 2026.10.1 active、nft `/21`、rpcbind/111 关闭 |
| 备份 | 两阶段任务与 secrets 状态保持；v0.3.0 已验证 |
| 临时数据 | 12 MiB 测试文件已删除；app session 清理 |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T025708Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T025710864Z.sqlite
服务: antifieldcloud.service (active, v0.3.1)
tag: v0.3.1
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.3.1
```

### 4. 未决

- 5 GiB 真实公网上传未跑满（12 MiB 已实测；逻辑/上限/过期测试覆盖），Cloudflare 总时长受网络影响。
- RCON 仍监听所有接口（Paper 无 bind 配置）；已由 nftables 阻断非 loopback，保留为已知限制。
- age 私钥仍需用户移到离线介质并删除本地明文副本。
- OpenCode 无垫片：Cloudflare 规则已验证；上游原生新建按钮仍失效，保留最小隐藏接管（详见 v0.3.0 历史）。

## v0.3.0（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.3.0`
- 范围：深度审计修复、备份管理/文件级恢复、音视频播放、OpenCode 无垫片门禁；大文件分片留到 v0.3.1。

### 1. 交付

- 审计修复：备份 SSH/SCP 硬超时与 secrets 独立状态；回收站分享 410；分享审计节流/密码≥8/备注私有/token 日志脱敏/GC；告警 unknown 降级与 90 天保留；legacy 无参备份显式化；孤儿归档可观测；备份空间纳入已确认/孤儿。
- 备份管理：`migration 3`（`backup_archives` 扩展 + `restore_plans`）；Web 列表、手动 prepare、归档导入/校验、文件级恢复到新目录（TOTP + `RESTORE`）；整库恢复仅离线 CLI；密钥包纳入 opencode DB/config 一致性快照。
- 媒体：`previewKind` 增加 audio/video，白名单 mp4/webm/mp3/m4a/ogg/flac/wav；CSP `media-src 'self'`；Range/HEAD/416；不转码。
- OpenCode：`OPENCODE_HTML_MODE=shim|attributes|passthrough`；默认 shim（无可见自定义按钮）；无垫片验证需 Cloudflare 关闭 ai 的 Rocket Loader/自动注入（待用户操作）。
- 文档/状态：API/UI/ARCH/SECURITY/DEPLOY/BACKUP/PLAN/ROADMAP/README/AGENTS/CHANGELOG 同步；`.local/preflight` ACL 收紧。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 140/140、前端 48/48 |
| `npm run build` | 通过（Vite 构建；仅 chunk 体积警告） |
| `smoke.ps1` | 16/16 |
| 生产 Health | `{"ok":true,"version":"0.3.0"}` |
| schema | v3；`restore_plans` 存在；部署前 DB 快照已生成 |
| 备份 | 手动 prepare 生成 full pending；PC 新脚本拉取 + ack + secrets=ok；PC secrets 含 opencode（约 1.3 MB）；`--no-warnings` 修复 PowerShell 5.1 JSON 解析 |
| 媒体 | 生产上传 mp3 → `previewKind=audio`、`inlineAllowed=true`；`?inline=1` 为 inline，Range 返回 206；测试文件已删除 |
| 文件列表 | 名称列点击修复保留（v0.2.1） |
| OpenCode | Cloudflare Configuration Rule 已生效：passthrough HTML 的 `type="module"` 未被改写；attributes/passthrough 无 JS 时选择器资源可加载，但原生“新建会话”按钮仍无 `POST`（上游缺陷）。已回退 shim，隐藏 click/pointerup 接管可用，页面无可见自定义按钮 |
| 临时数据 | 临时 app session、媒体测试文件已清理；pending 备份已拉取/确认 |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T012822Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T012824807Z.sqlite
服务: antifieldcloud.service (active, v0.3.0)
tag: v0.3.0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.3.0
```

### 4. 未决

- OpenCode 无垫片尝试：Cloudflare 关闭 Rocket Loader 后，无 JS 的 attributes/passthrough 仍无法触发原生新建会话（上游按钮缺陷）；按约定保留最小隐藏 click 接管，无可见按钮。后续上游修复/升级再复测。
- 系统级加固（journald persistent/RTC、cloudflared 升级、nft 收窄/rpcbind/RCON bind）逐项确认后执行。
- Minecraft 世界未纳入备份；大文件 5 GB 分片在 v0.3.1。
- age 私钥仍需用户移到离线介质并删除本地明文副本。

## v0.2.2（历史）

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.2.2`（v0.2.1 的 UI 修正热修复）
- 范围：移除自定义新会话按钮、修复 Android 原生新建按钮无响应；保留文件列表点击与 Rocket Loader opt-out

### 1. 修复

### 移除可见按钮

- 删除 v0.2.1 注入的“＋ 新会话”浮动按钮及相关样式/文案。
- 兼容垫片不再向页面添加任何 UI 元素。

### 原生“新建会话”按钮

- 在捕获阶段接管 opencode 原生 `button[aria-label="新建会话"]`（兼容 `New session`/`新会话`）的
  `click` 与 `pointerup`；调用 opencode `POST /api/session`，跳转标准
  `/server/<base64-origin>/session/<id>`。
- 不修改 opencode 服务/数据；只对已认证 HTML 注入同源外部脚本 `/__af/oc-help.js`。
- 继续为 opencode 脚本加 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写模块脚本导致
  智能体/模型选择器不渲染。

### 文件列表

- v0.2.1 的名称列按钮修复保留：文件夹进入、文件预览。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 88/88、前端 23/23 |
| `npm run build` | 通过 |
| `smoke.ps1` | 16/16 |
| 生产 Health | `{"ok":true,"version":"0.2.2"}` |
| Android/宽屏移动 UA 原生按钮 | 点击产生 `POST /api/session`；进入 `/server/.../session/ses_...`；会话内模型选择器显示；页面无自定义按钮 |
| 文件列表点击 | 通过（临时文件夹已清理） |
| CI / Release | main/tag CI success；[v0.2.2 Release](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.2) |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261019T150230Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T150235470Z.sqlite
服务: antifieldcloud.service (active, v0.2.2)
tag: v0.2.2 → e4d4e8d
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.2
```

### 4. 说明

- 智能体选择器在 opencode 只有单个 primary agent（当前 build）时由原生 UI 不展示；有多个 primary
  agent 时 Rocket Loader opt-out 保证其正常渲染。
- 测试用临时 app session、opencode 会话和文件夹均已清理。
- 浏览器若仍显示旧 Service Worker/bundle，请清除站点数据或硬刷新。

## v0.2.1（历史，已被 v0.2.2 取代）

> **已被 v0.2.2 取代**：v0.2.1 注入的可见“＋ 新会话”按钮已在 v0.2.2 移除，改为只接管原生按钮。
> 本段保留为历史记录；当前验收见本文件顶部 v0.2.2。

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.2.1`
- 范围：v0.2.0 已知问题修复（文件列表点击、OpenCode Web 移动端/选择器）

### 1. 修复内容

### 文件页列表视图

- 名称列由静态 `div` 改为可访问的 `<button>`；文件夹点击进入，文件点击预览。
- 桌面表格与移动卡片共用；操作列仍是独立按钮，不触发误进目录。
- 保留网格视图原有行为。
- 生产验证：临时创建文件夹 `v021-click-test`，桌面列表点击名称后 URL 变为
  `/files?parent=<id>`；测试后已移入回收站并彻底删除。

### OpenCode Web

- **Rocket Loader 根因**：Cloudflare 把 opencode 的 `type="module"` 改写成随机 type 并延迟执行，
  导致智能体/模型选择器与新建按钮失效。
- 代理注入 HTML 时为 opencode 所有脚本加 `data-cfasync="false"`，并注入同源外部兼容脚本
  `/__af/oc-help.js`（不违反 opencode CSP `script-src 'self'`）。
- 移动端（含 Android UA）显示“＋ 新会话”浮动按钮；调用 opencode `POST /api/session` 后跳转标准
  `/server/<base64-origin>/session/<id>`。
- 桌面端“新建会话”按钮由捕获阶段接管，修复点击无响应。
- 生产验证（Android UA、390×844、临时 session，测试后删除）：
  - 首页出现“＋ 新会话”；
  - 点击后 URL 进入 `/server/.../session/ses_...`；
  - 会话输入框出现模型选择器 “MiniMax M3.1 Flash Free”；
  - 测试 session 已删除，临时 app session 已从 DB 删除。
- 说明：智能体选择器只在 opencode 存在多个 primary agent 时由原生 UI 展示；当前配置的 primary
  agent 为 build，其他为 subagent。本次修复保证有可选智能体时不再被 Rocket Loader 隐藏。

### 2. 自动化与冒烟

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + node:test + Vitest） | 通过；服务端 88/88、前端 23/23 |
| `npm run build` | 通过；PWA 静态资源完整 |
| `scripts/smoke.ps1`（公网 + Pi） | 16/16 通过 |
| `GET https://app.antifield.work/healthz` | `{"ok":true,"version":"0.2.1"}` |
| 生产文件列表点击 | 通过（临时文件夹，已清理） |
| 生产 OpenCode Android UA | 通过（临时 session，已清理） |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261019T143637Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T143640775Z.sqlite
服务: antifieldcloud.service (active, v0.2.1)
tag: v0.2.1 → 57cb8d0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.1
```

### 4. 注意

- 生产测试使用的临时 app session 已删除；临时文件夹已彻底删除；测试 opencode 会话已删除。
- 若浏览器仍加载旧 Service Worker/旧 bundle，请 Ctrl+F5 或清除站点数据后刷新。
- Cloudflare 仍会注入 Web Analytics/Challenge 脚本，严格 CSP 下可能控制台报错；不影响本次修复。
- 大文件仍受 Cloudflare 约 100 MiB/100s 限制；SSH 密码登录、无 Cloudflare Access 等 v0.2.0 残留不变。

## v0.2.0（历史）

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 Model B（8 GB）/ Debian 13 trixie / aarch64 / 64 GB SD
- 公网入口：`https://app.example.com`、`https://ai.example.com`（Cloudflare Tunnel `antifieldcloud`）
- 代码版本：`v0.2.0`（tag 指向本文件所在提交）
- 结论：**技术验收通过；用户登录/手机/PWA 验收待本人完成**

### 1. 自动化与构建

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + `node --test` + Vitest） | 通过：服务端 86/86、前端 23/23 |
| `npm run build`（Vite + PWA 资源） | 通过；产出 manifest/sw/offline/icons/assets |
| `scripts/smoke.ps1`（公网 + Pi） | 16/16 通过（含 PWA、分享、告警、cgroup、备份 pending/旁文件） |
| `npm ci --omit=dev` + `check-prod-deps.mjs` | 通过 |
| CI（shellcheck / nftables / PowerShell Parse+BOM） | 配置已加入，待推送后跑 |

### 2. 部署与数据库

- 部署 release：`/opt/antifieldcloud/releases/20261019T131401Z`；`current` 指向该版本；健康检查 v0.2.0。
- 迁移前 DB 快照：`/var/lib/antifieldcloud/backups/db-predeploy-20261019T131404874Z.sqlite`（SHA-256 已记录在部署日志）。
- schema version = **2**；新增 `notes/bookmarks/tags/FTS5`、`shares/share_sessions`、`alert_events/alert_state`、`backup_archives`。
- 原有用户/会话/文件数据保留；旧 release 可回滚（新增表 additive）。
- 发布包包含 LICENSE；`deploy.ps1` 健康检查失败自动回滚已实现。

### 3. 安全修复验证

| 审计项 | 验证 |
|---|---|
| C1 畸形 Cookie WebSocket DoS | 回归测试通过；进程不退出；AI HTTP 畸形 Cookie 返回 401 |
| H1 改密/恢复码再认证 | 需要 TOTP；IP 5/15min + 全局/TOTP 限流；失败审计；前端 TOTP 表单 |
| trustProxy | 非 loopback 对端忽略转发头；X-Forwarded-Host 不参与安全判断 |
| RCON | 密码已轮换为 32 位随机；`list` 成功；多包/超时测试通过 |
| 上传/磁盘 | 全局预留、100 MiB 上限、ENOSPC→507、tmp 清理；单元/集成测试通过 |
| 安全头 | HSTS、CSP（含 manifest/worker）、nosniff/referrer、AI 302/401 头、PDF XFO/CSP |
| 分享 | token 只存 SHA-256、密码 scrypt、过期/次数/吊销 410、Origin/限流、软删除同步吊销 |
| 审计/UI | 真实 action 映射、Activity 服务端筛选、Files/Trash 竞态修复、Markdown 禁 style |

### 4. Pi 系统与运维

- 一次 Pi 重启（同时 MC 重启）完成：5 个服务 active（antifieldcloud/cloudflared/minecraft/nginx/opencode）。
- memory cgroup：`/sys/fs/cgroup/cgroup.controllers` 含 `memory`；`MemoryMax=512M`、`MemoryCurrent≈158M`，限制真实生效。
- RCON：`0 位玩家在线`（重启时无人在线）；新密码写入 `server.properties` 与 env；25575 外部仍被 nftables 阻断。
- 健康探针：`antifieldcloud-health.timer` active/enabled；`/run/antifieldcloud/pi-health.json` 字段正常，欠压 sticky 位已清零。
- 安全更新：Debian trixie 安全更新已安装；`unattended-upgrades` active；`age` 1.2.1 已安装。
- Cloudflare：app/ai 302/401 正常；`mc.example.com` 未改；Cloudflare 边缘仍有 Web Analytics/Challenge 注入被严格 CSP 拦截（已知，文档记录）。
- 残留：SSH 密码登录保留、无 Cloudflare Access、单 SD 卡；cloudflared 仍未做 systemd 沙箱加固（后续）。

### 5. 备份与灾备

- 两阶段协议：手动运行新 `backup-pull.ps1`：`--prepare` full → 下载 → SHA 校验 → 原子改名 → `--ack` → 删除远端；pending=0。
- PC 目标：实际 Windows 目录（见本地 `.local/DEPLOYMENT.md`，不提交）；ACL 已收紧为当前用户 + Administrators + SYSTEM。
- Windows 任务：`AntifieldCloud-Backup-Pull` Ready；Arguments 含 `-PiHost/-PiUser/-BackupRoot`；电池不跳过；NextRunTime 2026-10-20 12:00。
- 密钥包：`backup-secrets.sh` 生成 age 加密包（env/cloudflared/MC/opencode 共 6 文件），已在 Pi 上解密验证后删除 Pi 私钥；私钥仅离线保存（本地临时副本需移出）。
- 备份状态 JSON/SHA 旁文件已更新；`smoke` 通过。
- **恢复演练已通过**：解包全量 `snapshot-20261019T130931524Z-full.tar.gz`（SHA 旁文件一致）+ 增量
  `snapshot-20261019T131311313Z-inc.tar.gz`；`PRAGMA integrity_check=ok`、schema=2、users=1；
  密钥包在同一 Pi 上用私钥解密并核对文件列表后删除 Pi 私钥。演练记录见本地 `.local/DR-DRILL.md`。
- 正式从 PC 恢复时的步骤见 `docs/BACKUP.md` §6；全量+增量命令已修正为按 manifest 选最新 DB。

### 6. 功能验收（服务端/公开端点）

- `/healthz` → `{"ok":true,"version":"0.2.0"}`（公网 + Pi）。
- PWA：`/manifest.webmanifest` 200 + `application/manifest+json`；`/sw.js` 200 + `Service-Worker-Allowed: /`；`/offline.html` 200。
- 公开分享页：`/s/<未知>`（浏览器 Accept）→ SPA HTML + `X-Robots-Tag: noindex`；API 404/410 正常。
- `/api/alerts` 未登录 401；告警服务已启动（env 未配置 webhook 时仅面板）。
- `/api/version` 登录后返回 app/ai origin、回收站天数、100 MiB 上限、分享/告警开关。
- 本地真实集成：登录 → 创建笔记 → 上传 → 创建密码分享 → 公开 metadata → unlock → 下载，全部通过。
- **待完成**：用户本人公网登录/改密/恢复码、手机 PWA 安装/拍照上传、分享手机打开、告警 webhook 实际投递。
  服务端已用真实集成脚本验证登录之外的笔记/上传/分享解锁/下载链路，以及 `/api/version`/PWA 静态端点。

### 7. 已知限制

- 分享下载次数为会话级近似；清 Cookie 可在 5 分钟会话内绕过一次计数。
- 笔记无附件/版本历史；分享不含目录。
- Cloudflare 约 100 MiB/100s 限制；大文件后续分片。
- FTS5 中文回退 LIKE。
- Cloudflare 注入与严格 CSP 的冲突需在 Cloudflare 后台关闭自动注入或接受控制台错误。
- `http-proxy` Node 26 弃用警告；Node 27 前评估替换。
- SSH 密码登录、无 Cloudflare Access、单 SD 卡未加密。

### 8. 发布

```text
tag: v0.2.0
tag message: AntifieldCloud v0.2.0
部署目录: /opt/antifieldcloud/releases/20261019T131401Z
服务: antifieldcloud.service (enabled, active, v0.2.0)
迁移前快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T131404874Z.sqlite
```
