# 路线图

## v0.5.0（当前）

- **Bot 平台**：Telegram/Discord/Slack 适配器；签名 Webhook `/api/bot/webhook/:botId`（Telegram secret token、Discord Ed25519 + 时间戳、Slack HMAC + 时间戳、事件去重）；管理 API `/api/bots*` 与 `/bots` 页面。
- **只读命令**：`/help`、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`；目标 `allow_commands` + 显式 user 白名单双校验；输出清洗路径/URL。
- **通知与发布**：告警事件按目标 `allow_notifications` 通知；TXT + 单个云端媒体发布（≤10 MiB、频道/群组）、TOTP 再认证、定时/取消/重试/死信重投。
- **安全与数据**：Bot 凭据 AES-256-GCM（`BOT_SECRET_KEY`，只写不读）；Webhook/命令/发布限流；默认 `BOT_ENABLED=false`；schema v7（迁移 7 新增 5 张 Bot 表，迁移 6 保留）。
- **运维**：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY`；部署脚本干净工作树门禁、回滚还原 `APP_VERSION`、smoke 失败门禁；`check-version` 覆盖 env.example/DEPLOY 标题/lock；SSH 仅公钥（`00-` drop-in，24h 回滚窗口）；Cloudflare Access 策略与 bypass 文档。
- **文档**：README/AGENTS/CHANGELOG/PLAN/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ACCEPTANCE/AUDIT 全量同步；第四轮审计记录。

## v0.5.1（规划）

1. Bot 增强（按使用反馈）：更多平台（企业微信/钉钉/飞书、QQ 官方 Bot）与 AI 对话评估、多管理员审批/发布二次确认、媒体多附件（受平台限制）、Telegram/Discord 交互组件（按钮）只读动作、通知静默时段。
2. Bot 运维：命令/投递指标与 Dashboard 卡片（成功率、死信数、最近错误）、平台 Token 轮换向导（明确重录流程）、`BOT_SECRET_KEY` 轮换演练。
3. 安全收口：`fail2ban` 封禁持久化（nftables reload 后自动恢复 set）、SSH 24h 回滚窗口结束后的基线核查、Cloudflare Access service token（供 smoke 使用）。
4. 测试证据：真实平台沙箱联调记录（Telegram 测试 Bot、Discord 测试 guild、Slack 测试 workspace），补齐 Webhook 重放/限流/平台 5xx 的负路径。
5. 依赖与工具链：评估 `typescript-eslint` 支持 TS7 API 后移除 `@typescript/typescript6` 双 alias；跟进 `http-proxy` Node 27 替代。

## v0.4.2（已交付）

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
8. **Cloudflare Access 深化**：当前为 `app` 策略 + Webhook/health/公开分享 bypass（需用户后台配置）；后续可加 service token、按路径分组策略与告警。
9. **多用户与权限分离**：角色/配额/审计隔离；与“个人工作台”定位存在取舍，暂缓。
10. **SSH/sudo 加固收尾**：SSH 已仅公钥 + `fail2ban` sshd jail（24h ban）；后续收紧 `antifield` 的 `NOPASSWD ALL`、评估 fail2ban 规则与 nftables 自动协同，需用户确认后执行。

## 明确不做（至少近期）

- 多租户/SaaS 化、公开注册。
- 端到端加密同步客户端（Syncthing 式）——与 Web 云盘定位冲突。
- Minecraft 任意 RCON 控制台/插件管理。
- 服务端媒体转码/大模型推理。
- 替换现有 Minecraft/SakuraFRP/opencode 服务。
- 为分享生成服务端 zip 包（多文件逐项下载已够用）。

## 已知限制

- SSH 已仅公钥（`00-` drop-in，24h 回滚窗口），`fail2ban` 已启用 sshd jail（nftables 后端、24h ban，nftables reload 后需重启）；Pi 登录用户 `antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择），待收紧。
- RCON 仍监听所有接口，仅由 nftables 限制为 loopback；Cloudflare Access 策略/bypass 需用户后台配置，应用无法自证。
- Cloudflare 终止 TLS，可见明文；Cloudflare 约 100 MiB/100s 请求限制约束单请求上传（大文件走分片）。
- 限流为内存态，重启清零；`http-proxy` 在 Node 26 有弃用警告；scrypt 仍为 N=2^15；`typescript-eslint` 尚不支持 TS7 API，保留双 alias。
- 分享下载次数为会话级近似限制；无目录打包/公开笔记分享；多文件分享逐项下载。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练任务需用户手动安装；无异地世界副本。
- 备份无整包加密与异地副本；普通归档含 TOTP/会话明文与 Bot 密文，PC ACL 与离线介质是最后防线。
- Bot：单次发布最多 1 个媒体文件、命令严格只读、无平台主动拉取/长连接；适配器/队列测试为进程内 mock（T/S mock-only），上线前需平台沙箱联调。
- 旧世界 cron 已停用、旧 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
