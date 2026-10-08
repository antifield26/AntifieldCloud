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
# 按 deploy/env.example 建 /etc/workbench/env（含 OPENCODE_SERVER_PASSWORD、AUTH_LOGIN_PASSWORD）
sudo systemctl enable --now workbench-gateway.service opencode.service
curl -s http://127.0.0.1:3000/health
```

## 文档索引

- `docs/RESEARCH.md` — 实机调研报告 + 现状勘误
- `CHANGELOG.md` — 变更记录（时间正序）
- `docs/ARCHITECTURE.md` — 组件/接口/适配器/schema/安全/目录
- `docs/ROADMAP.md` — P0/P1/P2 里程碑
- `docs/TASK-INDEX.md` — 唯一任务事实源
- `AGENTS.md` — 工作守则与安全红线

## 当前状态

- P0 代码任务：`P0-01…P0-08 done`；备份目标 `D:\PiBackUp`。P0 出口剩余：3 晚 streak（日历累积中）。
- P1/P2 代码全清（`P1-01`~`P1-06`、`AUTH-01/02`、`P2-02`/`P2-04`；`P2-01`/`P2-03` dropped）。
- 网关 `127.0.0.1:3000`（`cloud.antifield.work`）；旧 `pidsh` ingress 已下线，DNS 已清。
- 实机基线（2026-10-08）：Pi5 8G / Debian13 / SD 64G / Node v26.7.0 / opencode v2.0.24（serve 空载 RSS ~300M）/ cloudflared 2026.8.1。
