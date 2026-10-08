# AntifieldCloud — Pi 5 个人工作台 + 树莓派控制台

Web 工作台（SPA）+ 工作台网关（Fastify）+ OpenCode v2（薄适配器接入）。
公网经 Cloudflare Tunnel（只做传输）+ 内置密码登录；Pi 零入站；`opencode serve` 只绑 localhost。

```text
浏览器 → 内置登录 → cloudflared → 网关 :3000 → [AI|控制台|效率|流水线|门户]
                                            └→ 适配器 → opencode :4096 (localhost)
```

## 快速开始（实机）

```bash
git clone <repo> && cd AntifieldCloud
# 按 deploy/env.example 建 /etc/workbench/env（含 OPENCODE_SERVER_PASSWORD；
# 网页登录口令不进 env，scrypt 哈希存 wb.db:auth_config）
sudo systemctl enable --now workbench-gateway.service opencode.service
curl -s http://127.0.0.1:3000/health
```

改密：网页页眉「改密」或 `POST /api/auth/password`（登录态）；首启随机口令写密封文件，改密后自动删。

## 文档索引

- `docs/RESEARCH.md` — 实机调研报告 + 现状勘误
- `CHANGELOG.md` — 变更记录（时间正序）
- `docs/ARCHITECTURE.md` — 组件/接口/适配器/schema/安全/目录
- `docs/ROADMAP.md` — 里程碑目标与风险
- `docs/TASK-INDEX.md` — 唯一任务事实源
- `AGENTS.md` — 工作守则与安全红线

## 当前状态

- **P0–P5 代码与出口任务基本全清**（`P2-01`/`P2-03` dropped；`P5-01` 曲线已落地）。
- 安全修复 SEC-01..04 已落并部署（AI 路由认证覆盖、口令常数时间比较、备份脱敏、强口令轮换）。
- 口令模型（终态）：网页登录口令 scrypt 哈希存 `wb.db:auth_config`；OpenCode basic-auth 口令在 `/etc/workbench/env`。
- 备份目标 `D:\PiBackUp`（PC SFTP 拉取 + sha256）；恢复演练周跑，watchdog 检 14 天内 `DRILL_OK`。
- 网关 `127.0.0.1:3000`（`cloud.antifield.work`）；旧 `pidsh` ingress 已下线，DNS 已清。
- 实机基线（2026-10-08）：Pi5 8G / Debian13 / SD 64G / Node v26.7.0 / opencode v2.0.24（serve 空载 RSS ~300M）/ cloudflared 2026.8.1。
- 下一里程碑待规划（P6 已 drop）；持续风险见 `docs/ROADMAP.md`。
