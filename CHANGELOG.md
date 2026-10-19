# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-19

### Added

- 统一登录：密码（scrypt）+ TOTP 两步验证、恢复码、限流、CSRF、会话管理、审计日志。
- 云盘：目录树、拖拽/多文件上传与进度、10 GiB 配额、文件名搜索、图片/文本/Markdown/PDF 预览、
  Range 下载、回收站（30 天自动清理）、SHA-256 元数据。
- 工作台门户：主机指标（CPU/内存/温度/磁盘）、存储用量、Minecraft 状态/玩家/TPS/白名单数、
  opencode 健康、服务状态、备份状态、最近活动。
- Minecraft：SLP + RCON 只读状态；白名单增删（校验、执行后复核、审计）；不提供启停/任意命令。
- `ai.example.com`：会话校验 + Basic 注入的 opencode 反向代理（SSE/WebSocket）。
- 部署：Cloudflare Tunnel（app/ai）、systemd 服务、nftables 默认拒绝入站、release 目录与回滚脚本。
- 前端入口脚本加入 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写 `type="module"`。
- 备份：Pi 端一致性 SQLite 快照 + 全量/增量归档 + SHA-256；Windows 计划任务每日 12:00 拉取到
  `%USERPROFILE%\AntifieldCloudBackups`；恢复文档与演练步骤。
- 工程：AGENTS.md、架构/安全/部署/备份/API/UI 文档、`node --test` 测试、ESLint/tsc、CI。

### Security

- 应用仅监听 loopback；RCON 仅 loopback；25565/80 限直连/校园网段。
- 文件内容不可变；预览类型白名单；SVG/HTML/XML 强制下载；CSP/安全响应头。
- opencode 端口不对外；代理覆写客户端 Authorization/Cookie。
- 服务用户 `antifieldcloud` 无 shell/无 sudo；systemd 沙箱。

### License

- MIT（见 `LICENSE`）。

### Known limitations

- RCON 密码未轮换、SSH 密码登录保留（用户选择）；见 docs/SECURITY.md 残留风险。
- 无 Cloudflare Access、无多用户、无版本历史、无 WebDAV/同步客户端。
- 无全盘/SD 加密；备份含 TOTP secret。
