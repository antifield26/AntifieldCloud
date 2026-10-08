# AntifieldCloud — Pi 5 个人工作台 + 树莓派控制台

Web 工作台（SPA）+ 工作台网关（Fastify）+ OpenCode v2（薄适配器接入）。
公网仅经 Cloudflare Tunnel + Access；Pi 零入站；`opencode serve` 只绑 localhost。

```text
浏览器 → CF Access → cloudflared → 网关 :3090 → [AI|控制台|效率|流水线|门户]
                                            └→ 适配器 → opencode :4096 (localhost)
```

## 快速开始（实机）

```bash
git clone <repo> && cd AntifieldCloud
# 按 deploy/env.example 建 /etc/workbench/env（含 OPENCODE_SERVER_PASSWORD）
sudo systemctl enable --now workbench-gateway.service opencode.service
curl -s http://127.0.0.1:3090/health
```

## 文档索引

- `docs/RESEARCH.md` — 实机调研报告（6 项实测 + 风险）
- `docs/ARCHITECTURE.md` — 组件/接口/适配器/schema/安全/目录
- `docs/ROADMAP.md` — P0/P1/P2 里程碑
- `docs/TASK-INDEX.md` — 唯一任务事实源
- `AGENTS.md` — 工作守则与安全红线

## 当前状态

- P0 代码任务：`P0-01…P0-08 done`；备份目标 `D:\PiBackUp`。P0 出口待办：CF Access 策略（用户 dashboard）、3 晚 streak（日历累积中）。
- P1 代码全清（`P1-01`~`P1-06`）。P0 出口待办：CF Access 策略（用户 dashboard）、3 晚 streak（日历累积中）。P2 按需排。
- 网关复用 `127.0.0.1:3000`（`cloud.antifield.work` ingress 免改）；`pidsh→:3100` 待 P0-06 重定向。
- 实机基线（2026-10-08）：Pi5 8G / Debian13 / SD 64G（58% 已用）/ Node v26.7.0 / opencode 1.18.29（P0 升 v2 2.0.24）/ cloudflared 2026.8.1 / serve 空载 RSS 343M。
