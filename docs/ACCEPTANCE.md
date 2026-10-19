# AntifieldCloud v0.2.0 验收记录

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 Model B（8 GB）/ Debian 13 trixie / aarch64 / 64 GB SD
- 公网入口：`https://app.example.com`、`https://ai.example.com`（Cloudflare Tunnel `antifieldcloud`）
- 代码版本：`v0.2.0`（tag 指向本文件所在提交）
- 结论：**技术验收通过；用户登录/手机/PWA 验收待本人完成**

## 1. 自动化与构建

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + `node --test` + Vitest） | 通过：服务端 86/86、前端 23/23 |
| `npm run build`（Vite + PWA 资源） | 通过；产出 manifest/sw/offline/icons/assets |
| `scripts/smoke.ps1`（公网 + Pi） | 16/16 通过（含 PWA、分享、告警、cgroup、备份 pending/旁文件） |
| `npm ci --omit=dev` + `check-prod-deps.mjs` | 通过 |
| CI（shellcheck / nftables / PowerShell Parse+BOM） | 配置已加入，待推送后跑 |

## 2. 部署与数据库

- 部署 release：`/opt/antifieldcloud/releases/20261019T131401Z`；`current` 指向该版本；健康检查 v0.2.0。
- 迁移前 DB 快照：`/var/lib/antifieldcloud/backups/db-predeploy-20261019T131404874Z.sqlite`（SHA-256 已记录在部署日志）。
- schema version = **2**；新增 `notes/bookmarks/tags/FTS5`、`shares/share_sessions`、`alert_events/alert_state`、`backup_archives`。
- 原有用户/会话/文件数据保留；旧 release 可回滚（新增表 additive）。
- 发布包包含 LICENSE；`deploy.ps1` 健康检查失败自动回滚已实现。

## 3. 安全修复验证

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

## 4. Pi 系统与运维

- 一次 Pi 重启（同时 MC 重启）完成：5 个服务 active（antifieldcloud/cloudflared/minecraft/nginx/opencode）。
- memory cgroup：`/sys/fs/cgroup/cgroup.controllers` 含 `memory`；`MemoryMax=512M`、`MemoryCurrent≈158M`，限制真实生效。
- RCON：`0 位玩家在线`（重启时无人在线）；新密码写入 `server.properties` 与 env；25575 外部仍被 nftables 阻断。
- 健康探针：`antifieldcloud-health.timer` active/enabled；`/run/antifieldcloud/pi-health.json` 字段正常，欠压 sticky 位已清零。
- 安全更新：Debian trixie 安全更新已安装；`unattended-upgrades` active；`age` 1.2.1 已安装。
- Cloudflare：app/ai 302/401 正常；`mc.example.com` 未改；Cloudflare 边缘仍有 Web Analytics/Challenge 注入被严格 CSP 拦截（已知，文档记录）。
- 残留：SSH 密码登录保留、无 Cloudflare Access、单 SD 卡；cloudflared 仍未做 systemd 沙箱加固（后续）。

## 5. 备份与灾备

- 两阶段协议：手动运行新 `backup-pull.ps1`：`--prepare` full → 下载 → SHA 校验 → 原子改名 → `--ack` → 删除远端；pending=0。
- PC 目标：实际 Windows 目录（见本地 `.local/DEPLOYMENT.md`，不提交）；ACL 已收紧为当前用户 + Administrators + SYSTEM。
- Windows 任务：`AntifieldCloud-Backup-Pull` Ready；Arguments 含 `-PiHost/-PiUser/-BackupRoot`；电池不跳过；NextRunTime 2026-10-20 12:00。
- 密钥包：`backup-secrets.sh` 生成 age 加密包（env/cloudflared/MC/opencode 共 6 文件），已在 Pi 上解密验证后删除 Pi 私钥；私钥仅离线保存（本地临时副本需移出）。
- 备份状态 JSON/SHA 旁文件已更新；`smoke` 通过。
- **恢复演练已通过**：解包全量 `snapshot-20261019T130931524Z-full.tar.gz`（SHA 旁文件一致）+ 增量
  `snapshot-20261019T131311313Z-inc.tar.gz`；`PRAGMA integrity_check=ok`、schema=2、users=1；
  密钥包在同一 Pi 上用私钥解密并核对文件列表后删除 Pi 私钥。演练记录见本地 `.local/DR-DRILL.md`。
- 正式从 PC 恢复时的步骤见 `docs/BACKUP.md` §6；全量+增量命令已修正为按 manifest 选最新 DB。

## 6. 功能验收（服务端/公开端点）

- `/healthz` → `{"ok":true,"version":"0.2.0"}`（公网 + Pi）。
- PWA：`/manifest.webmanifest` 200 + `application/manifest+json`；`/sw.js` 200 + `Service-Worker-Allowed: /`；`/offline.html` 200。
- 公开分享页：`/s/<未知>`（浏览器 Accept）→ SPA HTML + `X-Robots-Tag: noindex`；API 404/410 正常。
- `/api/alerts` 未登录 401；告警服务已启动（env 未配置 webhook 时仅面板）。
- `/api/version` 登录后返回 app/ai origin、回收站天数、100 MiB 上限、分享/告警开关。
- 本地真实集成：登录 → 创建笔记 → 上传 → 创建密码分享 → 公开 metadata → unlock → 下载，全部通过。
- **待完成**：用户本人公网登录/改密/恢复码、手机 PWA 安装/拍照上传、分享手机打开、告警 webhook 实际投递。
  服务端已用真实集成脚本验证登录之外的笔记/上传/分享解锁/下载链路，以及 `/api/version`/PWA 静态端点。

## 7. 已知限制

- 分享下载次数为会话级近似；清 Cookie 可在 5 分钟会话内绕过一次计数。
- 笔记无附件/版本历史；分享不含目录。
- Cloudflare 约 100 MiB/100s 限制；大文件后续分片。
- FTS5 中文回退 LIKE。
- Cloudflare 注入与严格 CSP 的冲突需在 Cloudflare 后台关闭自动注入或接受控制台错误。
- `http-proxy` Node 26 弃用警告；Node 27 前评估替换。
- SSH 密码登录、无 Cloudflare Access、单 SD 卡未加密。

## 8. 发布

```text
tag: v0.2.0
tag message: AntifieldCloud v0.2.0
部署目录: /opt/antifieldcloud/releases/20261019T131401Z
服务: antifieldcloud.service (enabled, active, v0.2.0)
迁移前快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T131404874Z.sqlite
```
