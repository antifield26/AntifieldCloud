# 路线图

## v0.4.2（当前）

- TypeScript 6.0.3 → **7.0.2**（官方并排方案：`@typescript/native` 提供 `tsc`；`typescript` 别名到 `@typescript/typescript6@6.0.2` 供 typescript-eslint）；typecheck/lint/test/build/npm ci 全绿。
- 修复 Android 窄屏指标趋势周期选择器压缩文字：按钮不收缩、标签不换行、范围选择器横向滚动。
- 工作区清理（生成物/缓存）与文档/版本/测试基线对齐；CI 增加 `check-version`。

## v0.4.1（已交付）

- OpenCode v2.0.32 → **v2.1.1** 升级；兼容性复核：Basic `/api/session`、`POST /api/session`（垫片新建会话）、垫片注入、`/api/*` 探测、公开 `ai.*` 入口。
- OpenCode Basic 密码轮换，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env` 与 service.json。
- Dependabot：actions/checkout 4→7、actions/setup-node 4→7、gitleaks-action 2→3；TypeScript 7 major 暂缓。
- 清理 Pi legacy 世界归档约 9 GiB；旧 cron 保持停用；应用 0.4.1（schema v6 不变）。

## v0.4.0（已交付）

- **可观测性**：主机指标 60s 采样/30 天保留、1h/6h/24h/7d/30d 范围查询、Dashboard 四张 SVG 趋势卡、Activity 关键词/时间范围、Alerts 筛选分页、`/api/storage`。
- **笔记增强**：附件（1–5/请求、25 MiB、每笔记 100、计入配额、`origin=note` 隔离）与版本历史（保留 20、查看/恢复）。
- **多文件分享**：1–50 个文件、`itemCount/totalSizeBytes`、公开逐项下载、按分享会话计数、删除即吊销；仍不生成服务端 zip。
- **世界备份与灾备**：`antifieldcloud-world.timer` 周度一致性备份（保留 4 份）、Windows `world-pull` 两阶段拉取（失败不 ack）、`drill` 自动恢复演练（报告 180 天）、三类状态文件与超期告警、密钥包 `KEEP=2`/tmpfs。
- **备份链路完善**：`skippedMissing/warnings`、prepare 超时对齐、ack 事务、恢复 origin 过滤、快照/staging 上限、归档浏览限流。
- **加固**：systemd capability/设备/内核面收紧、nftables 收窄 22/25565/25575、opencode Origin 校验、审计截断、CI coverage/audit/secret-scan/dependabot。
- **文档**：全量同步并收敛审计 OP-19/WE-24 漂移；新增 `check-version.mjs`。

## 下一批候选（按价值排序）

1. **整包加密 + 异地副本**：普通归档仍含 TOTP/会话明文；优先评估 age/restic 整包加密、VPS/对象存储异地副本与生命周期。
2. **目录/打包分享**：目录选择、流式 zip（不落盘）、分享内相对路径；需处理配额、次数与 tar 安全。
3. **笔记公开分享**：只读 token + 密码/过期，沿用分享限流与 noindex；需先定义 Markdown/附件外链的泄漏边界。
4. **WebDAV / rclone（只读优先）**：读写需处理锁/并发/配额；复用现有 DB id 与不可变语义。
5. **可观测性扩展**：更多告警通道（企业微信/钉钉/邮件）、日志聚合/检索、外部 uptime 监控；指标长期降采样。
6. **Minecraft 启停/日志**：窄权限 helper、固定命令白名单、二次确认与审计；需系统级改动与用户授权。
7. **SSD 迁移 + LUKS**：USB/NVMe HAT，迁移数据/备份临时目录并做全盘加密。
8. **Cloudflare Access 第二层**：身份策略叠加应用 TOTP。
9. **多用户与权限分离**：角色/配额/审计隔离；与“个人工作台”定位存在取舍，暂缓。
10. **SSH/sudo 加固**：改仅公钥、收紧 `antifield` 的 `NOPASSWD ALL`、加 fail2ban；需用户确认后执行。

## 明确不做（至少近期）

- 多租户/SaaS 化、公开注册。
- 端到端加密同步客户端（Syncthing 式）——与 Web 云盘定位冲突。
- Minecraft 任意 RCON 控制台/插件管理。
- 服务端媒体转码/大模型推理。
- 替换现有 Minecraft/SakuraFRP/opencode 服务。
- 为分享生成服务端 zip 包（多文件逐项下载已够用）。

## 已知限制

- SSH 密码登录保留；Pi 登录用户 `antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择），待加固。
- RCON 仍监听所有接口，仅由 nftables 限制为 loopback；无 Cloudflare Access；单 SD、无全盘加密。
- Cloudflare 终止 TLS，可见明文；Cloudflare 约 100 MiB/100s 请求限制约束单请求上传（大文件走分片）。
- 限流为内存态，重启清零；`http-proxy` 在 Node 26 有弃用警告；scrypt 仍为 N=2^15。
- 分享下载次数为会话级近似限制；无目录打包/公开笔记分享；多文件分享逐项下载。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练任务需用户手动安装；无异地世界副本。
- 备份无整包加密与异地副本；普通归档含 TOTP/会话明文，PC ACL 与离线介质是最后防线。
- 旧世界 cron 已停用、旧 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
