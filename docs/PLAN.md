# AntifieldCloud v0.3.x 实施计划（摘要）

本文件是 v0.2.x/v0.3.x 的权威范围/决策摘要；完整交付与验收见 `docs/ACCEPTANCE.md`（当前版本在顶部）。

## v0.3.0 补充

- 深度审计修复 + 备份管理/文件级恢复 + 音视频播放 + OpenCode 无垫片门禁。
- 备份：Web 上传归档（≤100 MiB）+ 文件级恢复到新目录；整库恢复仅离线 root CLI；App + opencode 数据覆盖；手动 prepare。
- OpenCode：Cloudflare 关闭 ai 的 Rocket Loader/自动注入后 Test `attributes`/`passthrough`；失败保留最小隐藏 click 接管。
- 大文件 5 GB 分片已在 v0.3.1 落地。
- 环境开关：`BACKUP_RESTORE_ENABLED`、`OPENCODE_HTML_MODE`；migration 3。

## v0.3.1 补充

- 分片上传到 Pi，单文件 5 GB，8 MiB 分片，断点续传/配额/清理；不做对象存储。
- API：`/api/uploads` init/status/chunk/complete/abort；migration 4；前端大文件自动分片、刷新后续传；服务端会话 24h 过期。
- 已完成并发布。

## v0.2.2 补充

- 移除 v0.2.1 的自定义“新会话”可见按钮。
- 只接管 opencode 原生“新建会话”按钮（click/pointerup），不注入 UI。
- 保留 Rocket Loader opt-out 与文件列表点击修复。

## 目标

在 v0.1.0 已验收的个人工作台之上，完成一次深入审计与修复，并落地二期功能：**知识库、文件分享、PWA、监控告警**，同时把备份/部署/灾备提升到可长期运行的水平。

## 范围

### 审计修复（P0/P1）

- C1 WebSocket 畸形 Cookie DoS；改密/恢复码再认证（密码+TOTP+限流+审计）。
- trustProxy/客户端头信任边界；HSTS/AI/PDF 安全头；错误映射；上传预留/ENOSPC；tmp 清理。
- RCON 多包、超时/关闭；登录限流内存上限；CSRF Cookie 补发。
- 备份两阶段协议、ACL、恢复命令、age 密钥包、部署自动回滚、迁移前快照。
- memory cgroup 启用；Cloudflare 100 MiB 上传上限；安全更新；健康探针。
- 前端审计映射/竞态/密码策略/DOMPurify/style/上传取消/恢复码保护/next-url/域名元数据/a11y。

### 二期功能

- 知识库：Markdown 笔记 + 书签 + 标签 + 置顶 + FTS5 搜索；无附件/版本历史。
- 分享：单文件，可选密码/过期（默认 7 天，最长 30 天）/最大下载次数/吊销；公开页 noindex。
- PWA：manifest、SW（仅静态缓存）、offline、安装提示、手机拍照上传。
- 告警：磁盘/温度/内存/服务/备份超期/欠压，通用 JSON webhook，去重/冷却/恢复，面板历史与测试。

## 非目标

备份可视化管理 UI、目录分享、音视频、WebDAV、多用户、Cloudflare Access、SSH 加固、附件/版本历史、大文件分片、媒体转码。

## 关键决策

| 项 | 决策 |
|---|---|
| 单文件上限 | 100 MiB（Cloudflare Free/Pro 代理限制） |
| 分享 | 单文件；默认 168h；最长 720h；密码可选；0=不限下载（对外 null） |
| 笔记/书签 | Markdown + 标签 + 置顶 + FTS5；无附件 |
| 告警 | 通用 HTTP JSON webhook；URL/secret 仅 env；未配置时仅面板 |
| 备份 | pending 不推进游标；PC `--ack` 后才推进；未 ack 不删；age 加密密钥包 |
| 系统 | 允许一次 Pi 重启（含 MC 重启）；RCON 轮换；memory cgroup |
| 兼容 | DB migration 2 additive；允许 API/行为收紧；部署前 DB 快照 |

## 阶段

1. 基线备份/探针/任务导出。
2. P0/P1 服务端安全与正确性修复 + 测试。
3. DB migration 2 + 笔记/分享/告警后端。
4. 前端二期与审计修复 + 测试。
5. 备份/部署/CI/灾备改造 + 文档。
6. 本地 `npm run check`/build/安全回归。
7. 部署 + Pi 维护（安全更新、RCON、cgroup、health timer、一次重启）。
8. Windows 任务/ACL、备份拉取、age 密钥、webhook、PWA 验收。
9. tag/GitHub Release v0.2.2 + 验收记录。

## 验收摘要

1. `npm run check` 全绿（服务端 88、前端 23）；CI 全绿。
2. C1 不崩、改密/恢复码需 TOTP 且限流/审计；trustProxy 伪造头无效。
3. 笔记/书签 CRUD/搜索；分享密码/过期/次数/吊销/410；公开页 noindex。
4. PWA 安装/离线壳/拍照上传；SW 不缓存 API/文件。
5. 告警条件/去重/恢复/测试 webhook；面板历史。
6. 备份 pending→pull→SHA→ack；失败重试同一归档；ACL；全量+增量+secrets 恢复演练。
7. 部署失败自动回滚；迁移前快照；release 含 LICENSE。
8. Pi 重启后 5 服务 active；v0.2.2；RCON 强密码；memory cgroup 生效；smoke 16/16。
9. 用户完成公网登录与手机/PWA 验收；记录到 `docs/ACCEPTANCE.md`。

## 回滚

- 代码：`scripts/deploy.ps1` 自动切回 previous；迁移前 `db-predeploy-*.sqlite` 手动恢复。
- DB：migration 2 additive，旧 release 可启动；需要时恢复快照。
- Pi：`/boot/firmware/cmdline.txt.pre-v0.2.0`、`server.properties.pre-v0.2.0`、systemd unit 备份、
  env 备份；RCON 旧密码/旧配置可按 `.local` 备份恢复。
- Windows：`backup-task-before-v0.2.0.xml`、旧脚本副本；ACL 变更可恢复继承。
