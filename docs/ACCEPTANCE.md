# AntifieldCloud 验收记录

> 当前版本 v0.3.1；v0.3.0 / v0.2.2 / v0.2.1 / v0.2.0 作为历史保留。v0.1.0 的交付摘要见 CHANGELOG。

## v0.3.1（当前）

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
