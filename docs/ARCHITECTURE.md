# 架构设计（ARCHITECTURE）

> 约束：工作台为主体，OpenCode 经**薄适配器**接入；适配器是隔离 v2 API 变动的唯一边界。
> 安全基线见 RESEARCH §4/§8 与 AGENTS.md 红线。

## 1. 组件图与数据流

```text
[浏览器] ──https──> [Cloudflare Edge + Access] ──tunnel──> [cloudflared 127.0.0.1]
      │                                                        │
      │                                                        ▼
      │                                              [工作台网关 Fastify :3000 (127.0.0.1)]
      │                                                │  │  │  │  │
      │                    ┌───────────────────────────┘  │  │  │  └──────────┐
      │                    ▼                              ▼  ▼  ▼             ▼
      │            [OpenCode适配器]                [控制台] [效率] [流水线] [门户]
      │                    │  localhost:4096 + basic-auth（OPENCODE_SERVER_PASSWORD）
      │                    ▼
      │            [opencode serve (workbench用户)]
      │                    │
      └──── SSE/JSON ◀─────┴──── SQLite(wb.db) / OpenCode库(opencode.db) 分离 ────▶ [NAS备份 rsync→PC]
```

- 公网唯一入口：Cloudflare Tunnel + Access；Pi **零入站端口**（sshd 仅对直连链路管理，不经公网）。
- 网关是唯一对外 HTTP 服务（cloudflared `cloud.antifield.work` ingress 原指向 `:3000` 保持不变，现由网关接管；`pidsh.antifield.work` 在 P0-06 同样指向网关 `:3000`，待用户清 DNS 后下线）；`opencode serve` 只绑 `127.0.0.1:4096`，由网关代理，绝不直连浏览器（公网 `:4096` 实测 000）。**CF Access 策略需在 dashboard 侧启用（P0-06 实测当时未生效），启用前网关无自身认证。**
- ~~`pi_nas :3000` 收敛计划~~ → 已执行（2026-10-08）：`antifield-cloud.service` 已 stop+disable，`3000/3100` 已释放，数据保留于 `~/pinas`；本项目网关直接复用 `3000`（门户初期即网关自身能力，无需反代 pi_nas）。
- 时序指标（CPU/内存/温度/写入）在网关**内存聚合 5–10 min 批量落盘**，SQLite `WAL + synchronous=NORMAL`。

## 2. 模块边界与接口

| 模块 | 职责 | 对外接口（网关路由） | 数据源 |
|---|---|---|---|
| ① AI 会话中心 | OpenCode 会话/任务/项目浏览 + 下发 + 流式进度 | `GET /api/ai/health`、`GET /api/ai/sessions`、`POST /api/ai/sessions`、`POST /api/ai/sessions/:id/message`（SSE 透传）、`POST /api/ai/sessions/:id/abort` | 经适配器调 OpenCode |
| ② 树莓派控制台 | CPU/内存/温度、systemd 白名单启停、journald 日志、apt 提醒、SD 写入统计 | `GET /api/sys/overview`、`GET /api/sys/metrics?range=`、`POST /api/sys/services/:unit/:action`（白名单）、`GET /api/sys/logs?unit=&since=`、`GET /api/sys/apt`、`GET /api/sys/disk` | `/proc`、`vcgencmd`、`systemctl`、`journalctl -o json`、`apt`、`diskstats` |
| ③ 个人效率面板 | 待办/笔记/书签/文件 | `GET/POST/PATCH/DELETE /api/todos`、`/api/notes`、`/api/bookmarks`、`/api/files*` | `wb.db` |
| ④ 自动化流水线 | 定时任务/抓取/报告，可下发给 OpenCode Agent | `GET/POST /api/jobs`、`POST /api/jobs/:id/run`、`GET /api/jobs/:id/runs` | `wb.db` + cron 适配（systemd timer 二选一，P1 定） |
| ⑤ 自托管服务门户 | 配置驱动服务卡片，初期为工作台文件服务（pi_nas 已退役） | `GET /api/portal/services`（读 `portal.json`）、`GET /api/files*` | `config/portal.json` + `wb.db:files_meta` |

前端：SolidJS SPA（`web/`），Tailwind；所有 API 同源 `/api/*`，SSE 用 `EventSource`；Key 不经前端（模型 Key 只在 OpenCode 本地配置）。

## 3. OpenCode 适配器 API 定义（唯一边界）

位置：`gateway/src/opencode/adapter.ts`；禁止其他文件 `fetch('…:4096')`。

```ts
export type OpenCodeVersion = { version: string; major: 1 | 2 };
export interface SessionSummary { id: string; title: string; updatedAt: string; status?: string }
export interface SendParts { parts: Array<{ type: 'text'; text: string }>; model?: string; agent?: string }
export interface IOpenCodeAdapter {
  health(): Promise<{ healthy: boolean; version: string }>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(title?: string): Promise<SessionSummary>;
  sendMessage(sessionId: string, input: SendParts, onEvent: (ev: unknown) => void): Promise<void>; // SSE
  abortSession(sessionId: string): Promise<boolean>;
}
export function createAdapter(opts: { baseUrl: string; username: string; password: string }): IOpenCodeAdapter;
```

- 实现：`baseUrl=http://127.0.0.1:4096`，basic-auth（`OPENCODE_SERVER_USERNAME/PASSWORD` 环境变量，systemd `EnvironmentFile=/etc/workbench/env`，`0400 workbench:workbench`）。
- 路由映射（v2.0.24 实测，OpenAPI 快照 `docs/opencode-openapi.json`）：健康 `GET /api/info`；事件 `GET /api/event`（SSE）；会话 `GET/POST /api/session`（包络 `{data}`）；下发 `POST /api/session/{id}/prompt {text}`；中断 `POST /api/session/{id}/interrupt`。注意 v1 路径（`/global/health`、`/event`、`/doc`）在 v2 返回 SPA HTML，不可用。
- 错误语义：401/403→网关 502 + 告警（凭据错）；SSE 断流→指数退避重连（最大 30s）；非白名单 model/agent→网关 400（不透传）。
- 契约测试：`gateway/test/opencode.contract.test.ts` 对 `GET /global/health`、`POST /session`、`POST /session/:id/message`（mock SSE）做版本矩阵测试。

## 4. 数据库 schema（`wb.db`，与 `opencode.db` 物理分离）

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE todos(id TEXT PK, title TEXT NOT NULL, done INT DEFAULT 0, due_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE notes(id TEXT PK, title TEXT, body TEXT, updated_at TEXT);
CREATE TABLE bookmarks(id TEXT PK, title TEXT, url TEXT NOT NULL, created_at TEXT);
CREATE TABLE files_meta(id TEXT PK, name TEXT, path TEXT, size INT, updated_at TEXT); -- 二进制存盘，不进库
CREATE TABLE metrics_ts(ts INT, cpu REAL, mem_used INT, mem_total INT, temp_c REAL, disk_written_kb INT); -- 5–10min 一行，保留 30 天
CREATE TABLE jobs(id TEXT PK, name TEXT, cron TEXT, kind TEXT, payload TEXT, enabled INT, last_run TEXT, last_status TEXT);
CREATE TABLE job_runs(id TEXT PK, job_id TEXT, started_at TEXT, finished_at TEXT, status TEXT, log TEXT);
CREATE TABLE service_audit(id INTEGER PK AUTOINCREMENT, ts TEXT, actor TEXT, unit TEXT, action TEXT, allowed INT, reason TEXT);
CREATE TABLE backups(id TEXT PK, ts TEXT, target TEXT, bytes INT, sha256 TEXT, status TEXT, log TEXT);
```

- 备份对象：`wb.db*` + `config/*` + OpenCode 工作区（路径 P0 定，默认 `~/projects/workbench-*`，**不含** `opencode.db-WAL` 热文件，停服或 checkpoint 后拷贝）。
- 校验：每次备份写 `sha256`，失败写 `backups.status=failed` 并经流水线告警。

## 5. 安全模型

- 认证链：`浏览器 → CF Access（邮箱/OTP）→ cloudflared → 网关`；网关再做 `HttpOnly Secure SameSite=Lax` 会话 cookie（P0 最小：信任 Access 头 + 本地会话；P1 加 OIDC JWT 校验，密钥放 `/etc/workbench/`）。
- 用户隔离：新增 `workbench` 系统用户（`nologin` + `StrictModes`），运行网关 + `opencode serve`；`antifield` 的 NOPASSWD ALL 保持不动但**网关永不使用该身份**。
- 特权执行：网关以 `workbench` 身份直调只读动作；`restart` 走 `sudo -n /bin/systemctl restart <unit>`，由 `/etc/sudoers.d/workbench-systemctl`（`deploy/sudoers-workbench`，root:root 0440）限定到 3 条精确命令。网关单元**不设** `NoNewPrivileges`（否则 sudo 提权被禁；边界由 sudoers 保证）。
- 白名单（初始，P0 可改，改动需更新本节 + TASK-INDEX）：`cloudflared.service`（restart only）、`workbench-gateway.service`、`opencode.service`、`nginx.service`（status only）。`antifield-cloud.service` 已退役（2026-10-08 stop+disable），不在白名单。白名单外 `POST /api/sys/services/*` 一律 `403 + service_audit.allowed=0`。
- 审计：所有启停 + 备份 + AI 下发写入 `service_audit` / `job_runs`；日志脱敏（`password|token|key|secret` 正则）。
- 红线（AGENTS.md 强制）：零入站端口；`serve` 只绑 localhost；Key 不进代码/日志/文档；动存储配置前备份链路必须 `status=ok`。

## 6. 目录结构（P0 落地）

```text
AntifieldCloud/
  AGENTS.md  README.md  docs/{RESEARCH,ARCHITECTURE,ROADMAP,TASK-INDEX}.md
  config/portal.json  config/systemd-whitelist.json
  gateway/{src/{index.ts,routes/{ai,sys,efficiency,jobs,portal}.ts,opencode/adapter.ts,sys/{metrics.ts,services.ts,logs.ts},db.ts},test/,package.json,tsconfig.json}
  web/{src/{App.tsx,pages/{Ai,Sys,Efficiency,Jobs,Portal}.tsx},package.json}
  deploy/{workbench-gateway.service,opencode.service,env.example,backup.sh,healthcheck.sh}
  scripts/{metrics-sample.sh, backup-verify.sh}
```

- 端口锁死：网关 `127.0.0.1:3000`（复用原 pi_nas 端口，`cloud.antifield.work` ingress 无需改动）；OpenCode `127.0.0.1:4096`；`pidsh` ingress 在 P0-06 重定向，P1 下线旧直连。
- 资源上限：`workbench-gateway.service MemoryMax=350M`；`opencode.service MemoryMax=1G`；`Restart=on-failure`。
