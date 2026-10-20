# 路线图

## v0.3.1（当前）

- 5 GB 级大文件分片/断点续传上传到 Pi；8 MiB 分片、配额预留、过期清理、前端续传；不做对象存储。
- migration 4：`upload_sessions` / `upload_chunks`。

## v0.3.0

- 深度审计修复：备份脚本硬超时/secrets 状态、回收站分享 410、分享审计节流/密码/日志、告警 unknown/保留、备份孤儿/legacy。
- 备份管理：Web 列表/手动 prepare/导入校验/文件级恢复到新目录；整库恢复仅离线 CLI；App + opencode 数据覆盖。
- 音视频播放：白名单容器 Range 播放，不转码。
- OpenCode：`shim|attributes|passthrough` 模式；Cloudflare 关闭 Rocket Loader 后验证无垫片，失败保留最小隐藏接管。
- 文档/迁移 3/运维 runbook。

## v0.2.2

- 移除 v0.2.1 的可见“＋ 新会话”浮动按钮。
- 捕获原生“新建会话”按钮（click/pointerup），修复 Android/宽屏移动浏览器无响应。
- 保留 Rocket Loader opt-out 与文件列表点击修复。

## v0.2.1

- 文件页列表名称列可点击进入文件夹/预览文件。
- 首次加入 OpenCode 兼容垫片（含可见“＋ 新会话”按钮）；该按钮已被 v0.2.2 移除。

## v0.2.0

- **审计修复**：C1 WebSocket 畸形 Cookie DoS、改密/恢复码再认证与限流、trustProxy 收紧、
  RCON 多包、上传预留/ENOSPC、HSTS/安全头、备份两阶段协议、部署自动回滚、迁移前快照、
  memory cgroup、100 MiB 上传上限；详见 `docs/AUDIT.md`。
- 知识库：Markdown 笔记 + 书签 + 标签 + 置顶 + FTS5 搜索。
- 文件分享：单文件、可选密码/过期/最大下载次数/吊销、公开页 noindex、限流与审计。
- PWA：可安装、离线壳、手机拍照上传；不缓存 API/文件。
- 监控告警：磁盘/温度/服务/备份/欠压，通用 JSON webhook，面板历史与测试。
- 备份/灾备：PC 确认后推进游标、未拉取不删除、SHA 旁文件、ACL、age 加密密钥包、恢复演练。
- 运维：健康探针 timer、`unattended-upgrades`、RCON 轮换、一次 Pi 重启完成加固。

## 下一批候选（按价值排序）

1. **备份可视化管理 / 恢复向导**：面板列归档、手动触发、从归档恢复；当前只有状态/告警与 CLI。
2. **音视频在线播放**：Range + 封面；不做 Pi 重型转码。
3. **WebDAV / rclone**：只读优先，读写需处理锁/并发/配额。
4. **Minecraft 启停/日志**：窄权限 helper、固定命令、二次确认；需系统级改动。
5. **Cloudflare Access 第二层**：身份策略叠加应用 TOTP。
6. **SSD 迁移**：USB/NVMe HAT，迁移数据与备份临时目录。
7. **笔记增强**：附件/图片、版本历史、知识库分享（工作量大）。
8. **多用户与权限**：角色/配额/审计隔离；不建议近期。
9. **大文件分片/对象存储**：绕开 Cloudflare 100 MiB/100s 限制。
10. **可观测性**：指标历史、更多告警通道（企业微信/钉钉/邮件）、日志聚合。

## 明确不做（至少近期）

- 多租户/SaaS 化、公开注册。
- 端到端加密同步客户端（Syncthing 式）——与 Web 云盘定位冲突。
- Minecraft 任意 RCON 控制台/插件管理。
- 在 Pi 上跑重型媒体转码/大模型推理。
- 替换现有 Minecraft/SakuraFRP/opencode 服务。

## 已知限制

- SD 卡单盘、无 RAID；每日备份依赖 PC 与直连网线。
- SSH 密码登录保留、无 Cloudflare Access（用户选择）。
- 分享下载次数为会话级近似限制；无目录分享。
- 笔记无附件/版本历史；FTS5 中文回退 LIKE。
- Cloudflare 约 100 MiB 请求体与 100s 超时；大文件需后续分片。
- 单进程；限流状态重启即清空。
- 备份包含 TOTP secret；age 私钥由用户离线保存，丢失则密钥包不可恢复。
- `http-proxy` 在 Node 26 有弃用警告，Node 27 前需评估替换。
