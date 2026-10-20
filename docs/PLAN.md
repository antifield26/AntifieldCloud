# AntifieldCloud v0.4.x 实施计划（摘要）

本文件是 v0.4.x 的权威范围/决策摘要；完整交付与验收见 `docs/ACCEPTANCE.md`，界面见 `docs/UI-SPEC.md`，契约见 `docs/API.md`。

## 目标

在 v0.3.x 已交付的云盘/知识库/分享/告警/备份/分片上传基础上，完成 v0.4.0：**可观测性与备份可视化、笔记附件与版本、多文件分享、Minecraft 世界一致性备份与 PC 拉取、恢复演练自动化、系统与网络安全加固**，并把文档与审计发现的漂移全部收敛到当前行为。

## 范围

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

- `scripts/backup-world.mjs` + `antifieldcloud-world.service/.timer`：周日 04:00 一致性 gzip 归档，保留 4 份，gzip/SHA 校验，状态 JSON，`save-on` 放 finally。
- `scripts/world-pull.ps1`：Windows 周度两阶段拉取（`.part` → SHA → 原子改名 → 远端 ack），失败保留远端不 ack，本地保留 4 份。
- `scripts/drill.ps1` + `drill-verify.mjs`：full+inc 链、sidecar SHA、tar 安全、DB integrity/FK/schema、manifest 校验，报告保留 180 天，可选世界解包验证。
- 状态文件 `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读），新增三类超期告警。
- 备份链路完善：pending 只算 `origin='pi'`、`skippedMissing/warnings`、prepare 超时对齐、`--ack` 事务、恢复 origin 过滤、快照行数/staging 上限、entries 限流、密钥包 tmpfs 与 `KEEP=2`。

### 系统与网络加固

- `antifieldcloud.service` capability/设备/时钟/主机名/内核日志/特殊权限收紧；世界备份 unit 独立加固。
- nftables 收窄：22 与 25565 仅实际直连/校园网段（22 新建连接限速 5/min），25575 仅 loopback，DHCP 绑物理网卡；80 不再放行。
- 登录/TOTP 全局限流调整（loopback 免占全局桶）；审计字段截断；opencode HTTP/WS Origin 校验。
- 部署脚本：APP_VERSION 注入与 `/healthz` 版本断言、磁盘/tar SHA/npm 预检、回滚先还原迁移前 DB 快照、部署后只读 smoke。

### 文档与审计收口

- 同步 README/CHANGELOG/AGENTS/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ROADMAP/PLAN/UI-SPEC，修正过期测试数字、服务监控数量、nftables 网段、隧道名、备份保留语义、分享密码规则、上传总进度等漂移（审计 OP-19/WE-24）。
- `scripts/check-version.mjs` 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS 版本一致。

## 阶段

1. 基线确认：现有部署/备份状态与审计待办（OP/WE）分拣。
2. 服务端：schema v6（迁移 5 结构 + 迁移 6 数据修复）、files.origin、笔记附件/版本、多文件分享、指标采样与查询、备份状态 API、告警扩展、审计截断、Origin 校验。
3. 前端：趋势卡、Activity/Alerts 筛选、笔记附件/版本、多选分享、公开多文件页、备份健康卡、上传“放弃并清理”。
4. 运维：世界备份 unit/timer、world-pull、drill、状态文件、nftables/systemd 加固、部署/冒烟脚本、CI（coverage/audit/secret-scan/dependabot）。
5. 文档与版本一致性：全部文档同步、`node scripts/check-version.mjs`、CHANGELOG。
6. 本地验证：`npm run check`、`npm run build`、`npm run test:coverage`、`npm run test:web:coverage`。
7. 部署与验收：PC 部署、迁移前快照、nftables/systemd/世界 timer 应用、冒烟、公网/手机/PWA、世界备份首次执行与 PC 拉取、恢复演练。

## 验收摘要

1. `npm run check` 全绿（`npm test` 234：服务端 218 + 脚本 16；前端 129）；`npm run build` 通过；覆盖率/audit/secret-scan CI 通过。
2. 版本一致：`/healthz`、`/api/version`、`package.json`、README、CHANGELOG、AGENTS 均为 0.4.0；schema v6。
3. 指标：`/api/metrics` 各范围可用、空数据降级、未登录 401；Dashboard 四卡、Activity/Alerts 筛选分页正常。
4. 笔记：附件 1–5/25 MiB/100 限额与配额；`origin=note` 不出现在文件列表/搜索/回收站；版本保留 20、恢复前快照、跨笔记 404。
5. 分享：`POST /api/shares` 1–50、去重/目录/回收站/附件拒绝；公开逐项下载、`share_item_not_found`/`share_gone`、多文件旧 `/content` 409；删除文件吊销整个分享。
6. 备份：应用归档两阶段/密钥包/导入恢复 `skippedMissing`；世界备份 timer 生成并保留 4 份；PC 拉取校验后 ack、失败不 ack；演练报告通过。
7. 加固：nftables 22/25565 仅允许网段（22 限速）、25575 仅 loopback、DHCP 绑网卡；systemd 加固生效；opencode 非法 Origin 403。
8. 部署：APP_VERSION 注入、`/healthz.version` 断言、失败回滚（含 DB 快照）可执行；部署后 smoke 通过。
9. 用户完成公网/手机/PWA 验收、世界拉取/演练任务安装与正式演练，并记录到 `docs/ACCEPTANCE.md`。

## 关键决策

| 项 | 决策 |
|---|---|
| schema | v6：迁移 5 为结构变更，迁移 6 为孤儿分享数据修复（不改变表结构）；只向上、无 down |
| 单文件上限 | 普通上传 100 MiB（Cloudflare Free/Pro 限制）；分片 5 GiB/8 MiB 块 |
| 配额 | 10 GiB（含回收站与笔记附件）；`fileCount` 只统计 `origin='user'` |
| 笔记附件 | 单文件 25 MiB、每笔记 100、每请求 1–5；`origin='note'` 隔离 |
| 版本历史 | 标题/正文/标签变化时快照，保留 20 |
| 分享 | 单文件兼容 + 多文件 1–50；密码新建 ≥8；默认 7 天/最长 30 天；0=不限次数；不生成 zip |
| 世界备份 | root 脚本固定 RCON 命令；周日 04:00；保留 4 份；PC 校验后 ack |
| 演练 | 自动化脚本季度/升级前执行；报告 180 天；世界解包需显式 `-IncludeWorld` |
| 系统 | 允许一次 Pi 重启；nftables 网段按实际直连/校园网段填写；SSH/sudo 不改（用户选择） |
| 兼容 | 旧单文件分享、旧归档（无 origin 列按 user/pi 处理）、旧 legacy 世界归档不动 |

## 非目标（v0.4.x 不做）

目录打包分享、笔记公开分享、整包加密归档、异地副本/对象存储、WebDAV/rclone、Minecraft 启停/控制台、多用户与权限分离、SSD/LUKS 迁移、Cloudflare Access、SSH/sudo 加固（用户选择保留现状）。

## 回滚

- 代码：`scripts/deploy.ps1` 停止服务并还原迁移前 DB 快照后切回 previous；无快照时拒绝自动回滚并打印手工步骤。
- DB：schema v6 只向上；回滚旧 release 前必须恢复 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`。
- 系统：nftables 恢复 `/etc/nftables.conf.bak` 后 `systemctl restart nftables`；systemd unit 恢复旧文件后 `daemon-reload` + 重启。
- 世界备份：`systemctl disable --now antifieldcloud-world.timer` 并移除 unit；旧 cron 未恢复前不重新启用。
- Windows：`Unregister-ScheduledTask` 世界拉取/演练任务；每日应用备份任务可用 `install-backup-task.ps1` 重装。
