# AGENTS.md — AntifieldCloud 工程约定（后续所有 Agent 会话必读）

## 0. 项目一句话

在 Raspberry Pi 5（Debian 13，8 GB）上运行的自托管个人工作台：统一登录（密码 + TOTP）、云盘、知识库、文件分享、Minecraft 状态/白名单、opencode 反代、PWA、主机告警与每日备份到 Windows PC。产品名 `AntifieldCloud · 个人工作台`。当前版本 v0.2.0。

权威文档：
- `docs/PLAN.md`：范围、决策、阶段与验收
- `docs/API.md`：HTTP 契约（服务端/前端共同遵守）
- `docs/UI-SPEC.md`：界面与交互
- `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`

## 1. 语言与注释

- 代码注释、文档、提交信息、UI 文案一律中文（技术标识符除外）。
- 注释解释「当前行为/约束」，禁止写历史叙事（“之前……”“修复了……”）或轮次标记。
- 每个模块顶部用一段中文说明职责与安全边界。

## 2. 运行模型

- Node >= 26；服务端为原生 TypeScript，`node server/src/main.ts` 直接运行，**不要引入编译/打包服务端步骤**。
- 相对导入必须带 `.ts` 后缀；禁止 enum/namespace/参数属性等非可擦除语法（`erasableSyntaxOnly` 已开启）。
- 前端由 Vite 构建，产物 `web/dist`；服务端只托管静态产物，不参与前端编译。
- 依赖：服务端运行时依赖放 `dependencies`；React/Vite/ESLint 等仅构建期依赖放 `devDependencies`（Pi 上 `npm ci --omit=dev` 不安装）。
- 不使用 Docker；Pi 上用 systemd 原生命令运行。

## 3. 命令

```bash
npm ci
npm run dev            # 本地服务端，默认 127.0.0.1:3000
npm run dev:web        # Vite :5173，/api 代理到 :3000
npm run build          # 前端构建
npm run typecheck      # server + web 两个 tsc 项目
npm run lint           # ESLint，--max-warnings=0
npm test               # node --test（scripts/run-tests.mjs 收集 server/test/**/*.test.ts）
npm run test:web       # Vitest + jsdom（web/src/**/*.test.ts(x)）
npm run check          # typecheck + lint + server test + web test，提交前必须全绿
```

测试禁止依赖真实 Minecraft、真实 opencode、真实 network；使用进程内假服务器/夹具。Windows 上无法测试的 systemd 相关用例用 `t.skip` 并在 Linux 上跑。

## 4. 目录与模块边界

```text
server/src/
  main.ts            进程入口：配置、DB、Fastify、信号退出
  config.ts          环境变量解析与校验（失败即退出）
  logger.ts          Fastify/pino 日志与脱敏
  db.ts              SQLite 打开、迁移、事务辅助
  auth/              scrypt、TOTP、会话、CSRF、限流、恢复码
  files/             存储、上传、配额、搜索、预览、回收站
  mc/                SLP、RCON、白名单
  opencode/          ai.* Host 的认证反代
  dashboard/         主机指标、服务状态、备份状态
  notes/             笔记/书签、标签、FTS5（二期）
  shares/            文件分享、密码/过期/次数/公开访问（二期）
  alerts/            告警条件/状态机/webhook（二期）
  http/              路由注册、错误处理、静态资源、安全头
  util/              通用工具（时间、路径、响应）
web/src/             React 页面与组件（只依赖 docs/API.md 的契约）
scripts/             provision.mjs、backup.mjs、run-tests.mjs、部署/备份 PowerShell
deploy/              systemd、nftables、cloudflared ingress、env 模板
```

写作用域约定：服务端改动在 `server/`，前端在 `web/`，脚本在 `scripts/`，文档在 `docs/`；跨域改动先在本文件或任务中说明。

## 5. 安全红线（不可违反）

1. 不提供任意 Minecraft RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
2. 文件访问只经 DB id，不接受客户端路径；文件内容不可变；禁止覆盖上传。
3. 所有非 GET `/api` 校验 CSRF；Cookie `HttpOnly + Secure + SameSite=Lax`（仅 loopback HTTP 例外）。
4. 密码/TOTP/隧道凭据/opencode 密码不得进仓库、日志、错误响应、前端 bundle。
5. 预览仅白名单类型内联；SVG/HTML/XML 强制下载；文本预览上限 1 MiB。
6. 代理只允许固定上游 `http://127.0.0.1:4096`，客户端 `Authorization` 必须被覆盖。
7. 不修改现有 Minecraft/opencode/nginx/frpc/SSH 配置；不重启 Minecraft（除非用户明确授权并已备份）；不清理 PiForge 残留。
8. 部署、备份脚本必须幂等、可重试；失败要留下可诊断日志，不得静默吞错。

## 6. 数据库与数据

- schema 迁移集中在 `server/src/db/migrations.ts`（或同目录迁移文件），启动时按 `meta.schema_version` 顺序执行。
- 时间统一存 ISO 8601 UTC 字符串；展示用 `Asia/Shanghai`。
- 文件物理路径 `DATA_DIR/files/<id 前两位>/<id>`；上传先写 `DATA_DIR/tmp/` 再原子 rename。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站），上限 10 GiB。
- 审计只记录元数据，不记录文件内容、密码、TOTP、Cookie、Authorization。

## 7. 完成定义（DoD）

- `npm run check` 全绿；新增逻辑有对应测试（成功 + 失败路径）。
- API 变更同步更新 `docs/API.md`；界面变更同步 `docs/UI-SPEC.md`。
- 无密钥/个人数据进入仓库；`.env` 与 `data/` 被忽略。
- 部署相关改动同步 `docs/DEPLOY.md`，并说明回滚。
- 提交信息使用 Conventional Commits（`feat:`/`fix:`/`docs:`/`test:`/`chore:`/`deploy:`）。
- 每个阶段结束给出「产出摘要 + 未决问题 + 验证证据」。

## 8. 已知环境事实（不要重复踩坑）

- Pi：`antifield@192.0.2.10` 直连；WiFi 198.51.100.10 与 PC 不通（AP 隔离）；直连 SSH 偶发超时，脚本需重试。
- Pi 上 Node 为 `/usr/local/bin/node`（v26.11.1，世界可执行）；npm 指向 `/home/antifield/.nvm`，部署时以 root 使用。
- opencode：`127.0.0.1:4096`，Basic 用户名 `opencode`，密码来自 `/etc/opencode/opencode.env` 的 `OPENCODE_PASSWORD`。
- Minecraft：Paper 26.1.2，RCON `127.0.0.1:25575`，密码在 `server.properties`（v0.2.0 已轮换为 32 位随机），
  服务器语言中文，输出含 `§` 颜色码需剥离；RCON 仍监听所有接口，nftables 仅放行 loopback。
- Pi 已启用 memory cgroup（`cgroup.controllers` 含 `memory`）；`antifieldcloud-health.timer` 每 60s 写
  `/run/antifieldcloud/pi-health.json`；`age` 与 `unattended-upgrades` 已安装。
- 备份已改为两阶段 pending/ack（未确认不删）；Windows 任务参数为实际 `-PiHost/-BackupRoot`，ACL 收紧。
- Cloudflare：zone `example.com`；tunnel `antifieldcloud`；`mc.example.com` CNAME 到 SakuraFRP，**不要改**；
  `app/ai` 的 DNS 由用户手动添加；严格 CSP 会拦截 Web Analytics/Challenge 注入，需后台关闭自动注入或接受报错。
- 旧项目 PiForge 的残留（sudoers 注释、禁用的计划任务）保持原样，不继承、不清理。
- 公开仓库中的域名/IP/备份路径均为示例值；本机实际部署信息见 `.local/DEPLOYMENT.md`（gitignored，不提交）。

## 9. 用户手动步骤（Agent 不得代替）

1. Cloudflare 后台添加 `app`/`ai` CNAME（已由用户完成）。
2. 交互式运行 provisioning，设置密码、扫描 TOTP、保存恢复码。
3. 安装/重装 Windows 备份计划任务（已用管理员 PowerShell 完成）。
4. 离线保存 age 私钥；把 `ALERT_WEBHOOK_URL` 写入 env 后重启应用。
5. 最终公网/手机/PWA 验收；完成正式恢复演练并记录。
