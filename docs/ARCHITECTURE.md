# 架构设计（ARCHITECTURE）

> 约束：工作台为主体，OpenCode 经**薄适配器**接入；适配器是隔离 v2 API 变动的唯一边界。
> 安全基线见 RESEARCH §4/§8 与 AGENTS.md 红线。
> **以本文件 + 代码为准**；与 README/TASK 冲突时先改文档再动代码。

## 1. 组件图与数据流

```text
[浏览器] ──https──> [Cloudflare Edge] ──tunnel──> [cloudflared 127.0.0.1]
      │                                                │
      │                                                ▼
      │                                      [工作台网关 Fastify :3000 (127.0.0.1)]
      │                                        │  │  │  │  │  │
      │                    ┌───────────────────┘  │  │  │  │  └────────┐
      │                    ▼                      ▼  ▼  ▼  ▼           ▼
      │            [OpenCode适配器]            [控制台][AI][效率][流水线][门户]
      │                    │  localhost:4096 + basic-auth（OPENCODE_SERVER_PASSWORD）
      │                    ▼
      │            [opencode serve (workbench用户)]
      │                    │
      └──── SSE/JSON ◀─────┴──── SQLite(wb.db) / OpenCode库(opencode.db) 分离 ──▶ [PC SFTP 拉取 D:\PiBackUp]
```

- 公网唯一入口：Cloudflare Tunnel（**仅传输**；CF Access 已弃用，认证由网关内置密码登录承担）。Pi **零入站端口**（sshd 仅对直连链路管理，不经公网）。
- 网关是唯一对外 HTTP 服务（cloudflared `cloud.antifield.work → http://localhost:3000`；旧 `pidsh` ingress 与 DNS 已下线）；`opencode serve` 只绑 `127.0.0.1:4096`，由网关代理，绝不直连浏览器（公网 `:4096` 实测不通）。
- ~~`pi_nas :3000` 收敛计划~~ → 已执行（2026-10-08）：`antifield-cloud.service` 已 stop+disable，`3000/3100` 已释放，数据保留于 `~/pinas`；本项目网关直接复用 `3000`。
- 时序指标（CPU/内存/温度/写入）在网关**内存聚合约 5 min 批量落盘**（`WB_METRICS_FLUSH_MS`），SQLite `WAL + synchronous=NORMAL`。
- 备份方向：Pi 侧 `backup.sh` 生成快照 → PC 计划任务 `pc-pull.py` 经 **SFTP 拉取**（非 Pi 推 rsync）。

## 2. 模块边界与接口

| 模块 | 职责 | 对外接口（网关路由） | 数据源 |
|---|---|---|---|
| ① AI 会话中心 | OpenCode 会话浏览/新建/删除 + 下发 + SSE 流式 | `GET /api/ai/health`、`GET/POST /api/ai/sessions`、`GET /api/ai/sessions/:id/messages`、`POST /api/ai/sessions/:id/prompt`、`GET /api/ai/sessions/:id/events`（SSE）、`POST /api/ai/sessions/:id/abort`、`DELETE /api/ai/sessions/:id` | 经适配器调 OpenCode |
| ② 树莓派控制台 | CPU/内存/温度、白名单启停、journald 日志、apt、SD 代理、watchdog | `GET /api/sys/overview`、`GET /api/sys/metrics?range=`、`GET /api/sys/metrics/export`、`GET /api/sys/disk`、`GET /api/sys/disk-health`、`GET /api/sys/logs`、`GET /api/sys/apt`、`GET /api/sys/watchdog`、`GET/POST /api/sys/services/:unit/:action` | `/proc`、`vcgencmd`、`systemctl`、`journalctl`、`apt`、`diskstats`、`df`/`du` |
| ③ 个人效率面板 | 待办/笔记/书签/文件 + 导入导出 | `GET/POST/PATCH/DELETE /api/todos`、`/api/notes`、`/api/bookmarks`、`/api/files*`；`GET /api/export`、`POST /api/import` | `wb.db` + 磁盘 blob |
| ④ 自动化流水线 | 进程内 cron 调度；shell/http/opencode 三类任务 | `GET/POST /api/jobs`、`PATCH/DELETE /api/jobs/:id`、`POST /api/jobs/:id/run`、`GET /api/jobs/:id/runs`、`GET /api/jobs-due` | `wb.db` + `gateway/src/jobs/scheduler.ts` |
| ⑤ 自托管服务门户 | 配置驱动服务卡片 | `GET /api/portal/services`（读 `portal.json`） | `config/portal.json` |
| ⑥ 全局搜索 | todos/notes/bookmarks/files_meta | `GET /api/search?q=` | `wb.db`（LIKE，无 FTS） |
| ⑦ 认证/会话 | 登录、改密、会话列表/吊销 | `/api/auth/*` | `wb.db:auth_config/sessions/auth_audit` |

前端：SolidJS SPA（`web/`），Tailwind v4；所有 API 同源 `/api/*`，SSE 用 `EventSource`；模型 Key 不经前端（只在 OpenCode 本地配置）。

## 3. OpenCode 适配器 API 定义（唯一边界）

位置：`gateway/src/opencode/adapter.ts`；禁止其他文件 `fetch('…:4096')`（`watchdog.serveHealthy` 的 `/api/info` 探活除外，属监控不属业务代理）。

```ts
export interface OpenCodeVersion { healthy: boolean; version: string }
export interface SessionSummary { id: string; title: string; updatedAt: string; status?: string }
export interface SendParts { parts: Array<{ type: 'text'; text: string }>; model?: string; agent?: string }
export interface IOpenCodeAdapter {
  health(): Promise<OpenCodeVersion>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(title?: string, model?: string, agent?: string): Promise<SessionSummary>;
  deleteSession(sessionId: string): Promise<boolean>;
  promptOnly(sessionId: string, text: string): Promise<unknown>;
  subscribe(sessionId: string, onEvent: (ev: { type?: string; data?: { sessionID?: string } }) => void): Promise<() => void>;
  sendMessage(sessionId: string, input: SendParts, onEvent: (ev: unknown) => void): Promise<void>;
  messages(sessionId: string): Promise<unknown>;
  abortSession(sessionId: string): Promise<boolean>;
}
export function createAdapter(opts: { baseUrl: string; username: string; password: string; fetchImpl?: typeof fetch }): IOpenCodeAdapter;
```

- 实现：`baseUrl=http://127.0.0.1:4096`，basic-auth（`OPENCODE_SERVER_USERNAME/PASSWORD` 环境变量，systemd `EnvironmentFile=/etc/workbench/env`，`0400 workbench:workbench`）。
- 路由映射（v2.0.24 实测，OpenAPI 快照 `docs/opencode-openapi.json`）：健康 `GET /api/info`；事件 `GET /api/event`（SSE，包络 `{id,type,data{sessionID?}}`）；会话 `GET/POST /api/session`、`GET/PATCH/DELETE /api/session/{id}`（包络 `{data}`）；下发 `POST /api/session/{id}/prompt {text}`；消息 `GET /api/session/{id}/message`；中断 `POST /api/session/{id}/interrupt`。**v1 路径（`/global/health`、`/event`、`/doc`）在 v2 返回 SPA HTML，不可用；v1 回退已随 v1 卸载删除。**
- 错误语义（与代码一致）：401/403→网关抛错并映射 502（`opencode auth failed`）；非 2xx→502；`session.error`→`sendMessage` reject。**SSE 无自动指数退避重连**——`subscribe`/`openStream` 在 10min 空闲或客户端断开时取消；前端 `EventSource` 断线由浏览器/页面自行重连。
- **model/agent 无服务端白名单**：接口可选传入并透传 OpenCode；当前 AI 路由仅用 `title`/`text`。若未来 UI 暴露 model/agent，须另开任务做白名单校验（勿默认已有 400 过滤）。
- 契约测试：`gateway/test/opencode.contract.test.ts` 对 v2 `GET /api/info`、`GET/POST /api/session`、`POST /api/session/:id/prompt`、`GET /api/session/:id/message`、`GET /api/event`（mock SSE）测试；v1 路径不在矩阵内。

## 4. 数据库 schema（`wb.db`，与 `opencode.db` 物理分离）

以 `gateway/src/db.ts` 为准：

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE todos(id TEXT PRIMARY KEY, title TEXT NOT NULL, done INT DEFAULT 0, due_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at TEXT);
CREATE TABLE bookmarks(id TEXT PRIMARY KEY, title TEXT, url TEXT NOT NULL, created_at TEXT, tags TEXT DEFAULT '');
CREATE TABLE files_meta(id TEXT PRIMARY KEY, name TEXT, path TEXT, size INT, updated_at TEXT); -- 二进制存盘，不进库
CREATE TABLE metrics_ts(ts INT, cpu REAL, mem_used INT, mem_total INT, temp_c REAL, disk_written_kb INT);
CREATE INDEX idx_metrics_ts ON metrics_ts(ts);
CREATE TABLE jobs(id TEXT PRIMARY KEY, name TEXT, cron TEXT, kind TEXT, payload TEXT, enabled INT, last_run TEXT, last_status TEXT);
CREATE TABLE job_runs(id TEXT PRIMARY KEY, job_id TEXT, started_at TEXT, finished_at TEXT, status TEXT, log TEXT);
CREATE TABLE service_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, unit TEXT, action TEXT, allowed INT, reason TEXT);
CREATE TABLE backups(id TEXT PRIMARY KEY, ts TEXT, target TEXT, bytes INT, sha256 TEXT, status TEXT, log TEXT);
CREATE TABLE sessions(id TEXT PRIMARY KEY, expires_at INT); -- 迁移追加 created_at INT
CREATE TABLE auth_config(key TEXT PRIMARY KEY, value TEXT); -- 存 admin_hash（scrypt），不存明文
CREATE TABLE auth_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, result TEXT, note TEXT);
CREATE TABLE api_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, actor TEXT, method TEXT, path TEXT, status INT, ms INT);
CREATE INDEX idx_api_audit_ts ON api_audit(ts);
-- MIGRATIONS: ALTER TABLE sessions ADD COLUMN created_at INT;
--             ALTER TABLE bookmarks ADD COLUMN tags TEXT DEFAULT '';
```

- **口令位置（终态）**：网页登录口令 scrypt 哈希在 `auth_config.admin_hash`；OpenCode basic-auth 口令在 `/etc/workbench/env` 的 `OPENCODE_SERVER_PASSWORD`。`AUTH_LOGIN_PASSWORD` **已废除**（见 AUTH-02→AUTH-03）。
- 备份对象：`wb.db`（`.backup`）+ OpenCode `opencode.db`（`.backup`，源路径 `/home/workbench/.local/share/opencode`）+ `config/*` 打包 + `env` 脱敏副本；>7 天快照修剪。
- 校验：`sha256sums.txt`；PC 侧 `pc-pull.py` 逐文件校验；失败写 `backups.status` / manifest。
- 凭据：备份内 `env` 将 `OPENCODE_SERVER_PASSWORD` 等写 `__REDACTED__`；恢复后须人工重写口令再 `restart`。登录口令哈希随 `wb.db` 备份，明文永不进备份。

## 5. 安全模型

- 认证链：`浏览器 → 内置密码登录（scrypt 哈希存 wb.db:auth_config，会话 cookie HttpOnly/Lax，绝对上限 7d）→ cloudflared → 网关`（tunnel 只做传输，Pi 仍零入站）。改密 = 网页页眉「改密」（`setHash` 清全部会话）；初始口令见 Pi 密封文件（改密自动删）。登录≈workbench 单用户语义：不做多用户/RBAC（`WB_SESSION_SLIDING=0` 可关滑动续期）。
- 覆盖面：全局 `onRequest` 钩子必须在**全部业务路由注册之前**挂载（Fastify 钩子只作用于其后注册的路由）。`registerAuthRoutes` 在钩子**之前**注册，故 `/api/auth/*` 由路由内自检：
  - 开放：`/api/auth/status`、`/api/auth/login`、`/health`、SPA 静态资源。
  - 自检会话：`/api/auth/logout`、`/api/auth/password`、`/api/auth/sessions*`。
  - 钩子强制会话：`/api/ai/*`、`/api/sys/*`、`/api/todos|notes|bookmarks|files*`、`/api/search`、`/api/export`、`/api/import`、`/api/jobs*`、`/api/portal/*`。
  - 回归：`gateway/test/auth-coverage.test.ts`（抽样锁业务面 401；新增 `/api/*` 后应补进该列表）。
- 用户隔离：`workbench` 系统用户（`nologin`）运行网关 + `opencode serve`；`antifield` 的 NOPASSWD ALL 保持不动但**网关永不使用该身份**。
- 权限语义：登录会话 ≈ `workbench` 身份（可经流水线 **shell 任务执行任意 argv**、经白名单 sudo restart 服务）。单用户工作台可接受；若引入多用户/分享，须先拆权限。
- 特权执行：网关以 `workbench` 身份直调只读动作；`restart` 走 `sudo -n /bin/systemctl restart <unit>`，由 `/etc/sudoers.d/workbench-systemctl`（`deploy/sudoers-workbench`，root:root 0440）限定到 3 条精确命令。网关单元**不设** `NoNewPrivileges`（否则 sudo 提权被禁；边界由 sudoers 保证）。
- 白名单（与 `config/systemd-whitelist.json` 一致）：
  - `cloudflared.service`：`restart` + `status`
  - `workbench-gateway.service`：`restart` + `status`
  - `opencode.service`：`restart` + `status`
  - `nginx.service`：`status` only
  - `antifield-cloud.service` 已退役，不在白名单。白名单外 `POST /api/sys/services/*` 一律 `403 + service_audit.allowed=0`。
  - 可选只读监控槽 `WB_EXTRA_UNITS`（默认 `minecraft.service,mc-server.service`）只读状态/RSS，**永不启停**。
- 审计：
  - `service_audit`：启停/拒绝；`actor=ses:<cookie前缀8>`
  - `auth_audit`：登录 ok/fail/locked（不记口令）
  - `api_audit`：请求元数据（ts/actor/method/path/status/ms），query 丢弃、id 段收敛为 `:id`，60s 批量 + 30 天裁剪
  - `job_runs`：任务/watchdog/drill
  - 日志脱敏：`password|token|secret|api_key` 等赋值右侧截断；webhook URL 只记 host。
- 会话：绝对上限 7d（`created_at` 起算，NULL 老行强制失败）；滑动续期剩 <24h 时延到 `min(now+30d, created+7d)`。cookie `maxAge` 现为 30d（**大于**服务端 7d 上限，浏览器侧可残留无效 cookie；已知不一致，待收口为 7d）。
- 红线（AGENTS.md 强制）：零入站端口；`serve` 只绑 localhost；Key 不进代码/日志/文档；动存储配置前备份链路必须 `status=ok`。

## 6. 目录结构（与仓库一致，2026-10 扫描）

```text
AntifieldCloud/
  AGENTS.md  README.md  LICENSE  CHANGELOG.md  .gitignore
  docs/{RESEARCH,ARCHITECTURE,ROADMAP,TASK-INDEX}.md  docs/opencode-openapi.json
  config/{portal.json,systemd-whitelist.json}
  gateway/
    package.json  package-lock.json  tsconfig.json  tsconfig.build.json
    src/
      index.ts  app.ts  db.ts
      auth/password.ts
      opencode/adapter.ts
      jobs/scheduler.ts
      routes/{ai,auth,efficiency,impexp,jobs,portal,search,services,sys}.ts
      sys/{apiaudit,logs,metrics,services,watchdog}.ts
    test/{apiaudit,auth,auth-coverage,efficiency,impexp,jobs,metrics,
          opencode.contract,password,portal,search,services,sys,watchdog}.ts
         helper.ts
  web/
    package.json  package-lock.json  tsconfig.json  vite.config.ts  index.html
    src/{index.tsx,App.tsx,api.ts,chart.tsx,md.tsx,index.css}
    src/pages/{Ai,Console,Efficiency,Jobs,Login,Portal}.tsx
  deploy/
    workbench-gateway.service  opencode.service
    workbench-backup.{service,timer}  workbench-drill.{service,timer}
    backup.sh  drill-weekly.sh  healthcheck.sh
    env.example  sudoers-workbench  journald-volatile.conf
  scripts/{pc-pull.py,restore-drill.sh}
```

- 端口锁死：网关 `127.0.0.1:3000`；OpenCode `127.0.0.1:4096`。
- 资源上限：`workbench-gateway.service MemoryMax=350M`；`opencode.service MemoryMax=1G`；`Restart=on-failure`。
- 发版：带 `package-lock.json`，Pi 侧 `npm ci`；`config/` 非代码文件同批发版。
