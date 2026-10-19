# AntifieldCloud v0.1.0 实施计划（摘要）

完整版计划以会话审批稿为准；本文件是仓库内的权威范围/决策摘要。

## 目标

Pi 5 上的个人工作台：统一登录（密码 + TOTP）、云盘（上传/预览/搜索/回收站/配额）、门户（主机指标/MC 状态/opencode/备份状态）、MC 白名单管理、opencode 统一登录反代、每日备份到 Windows PC。

## 范围

- 云盘：图片/文本/Markdown/PDF 预览；拖拽多文件上传+进度；文件名搜索；回收站；10 GiB 配额。
- Minecraft：只读状态（在线/版本/玩家/TPS/白名单数/服务状态）+ 白名单增删；**不做**启停、任意命令、封禁、OP、踢人。
- opencode：`ai.example.com` 反代，应用会话校验后注入 Basic 认证；不做 iframe/自定义 AI 面板。
- 门户：主机指标、存储、服务状态、备份状态、最近活动、快捷入口。
- 认证：单管理员；scrypt + TOTP；恢复码；限流；CSRF；会话 7 天。
- 备份：Pi 端增量/周全量归档；Windows 每日 12:00 拉取到 `%USERPROFILE%\AntifieldCloudBackups`；恢复演练。
- 加固：nftables 默认拒绝入站，RCON 仅本机；不改 RCON 密码、不重启 MC、不改 SSH 认证。

## 非目标

分享链接、音视频播放、在线编辑、版本历史、WebDAV/同步客户端、PWA、多用户、MC 启停/控制台、Cloudflare Access、SSD 迁移、Pi kiosk、清理 PiForge。

## 关键决策

| 项 | 决策 |
|---|---|
| 域名 | `app.example.com`（应用）+ `ai.example.com`（opencode 反代），Cloudflare Tunnel `antifieldcloud` |
| 同源策略 | 单 Node 进程按 Host 分流；会话 Cookie `Domain=.example.com` |
| 数据 | SQLite（`node:sqlite`）+ 不可变文件内容；配额 10 GiB |
| 部署 | `/opt/antifieldcloud/releases/<ts>` + `current` 符号链接；systemd `antifieldcloud` 用户 |
| 运行时 | 系统 `/usr/local/bin/node` v26.11.1；服务端原生 TS；前端 PC 构建 |
| Pi 系统 | nftables；不重启 MC；不改 RCON/SSH；旧 PiForge 残留不动 |
| DNS | 用户手动添加 CNAME（tunnel token 非账号证书，CLI 无 DNS 权限） |
| 备份 | 每日增量、周日全量；PC 12:00 + 登录补跑；D 盘保留 30 daily + 8 weekly |

## 阶段

- P0 脚手架与工程规范
- P1 服务端核心（config/db/auth/provision）
- P2 云盘
- P3 门户/MC/opencode 反代
- P4 前端
- P5 Pi 部署 + nftables + cloudflared
- P6 备份 + 恢复演练
- P7 DNS/公网验收 + 用户 provisioning
- P8 文档/最终检查/tag v0.1.0

## 验收摘要

1. 公网 HTTPS 登录（密码+TOTP），错误限流；恢复码可用。
2. 上传（含中文名/大文件）→ 图片/文本/PDF 预览 → 搜索 → 回收站恢复；配额正确；SVG/HTML 只能下载。
3. Dashboard 显示 MC 在线/玩家/TPS/白名单；白名单增删复核；非法名拒绝。
4. `ai.example.com` 登录后免二次登录进入 opencode（兜底见 docs/DEPLOY.md）。
5. Windows 备份任务生成 D: 归档；恢复演练通过；超 48 h 告警。
6. nftables 后外部 25575 不可达、22/25565 正常；应用崩溃自恢复；RSS < 300 MB。
7. `npm run check` 全绿；无密钥入库。
