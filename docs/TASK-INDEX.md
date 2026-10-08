# 任务索引（TASK-INDEX）

> 本文件是项目**唯一任务事实源**（状态、依赖、工作量、验收、关联代码）。
> 里程碑目标与排期原则见 `docs/ROADMAP.md`（不写任务明细）。
> 状态：`pending / in-progress / done / blocked / dropped`。
> 完成任务后立即更新本表；验收必须含实机验证步骤。

| 编号 | 标题 | 里程碑 | 状态 | 依赖 | 工作量 | 验收标准 | 关联文档/代码 |
|---|---|---|---|---|---|---|---|
| RES-01 | 实机环境调研 + RESEARCH.md | P0前置 | done | — | 2h | 6 项实测/待测齐备；无凭据落文档；磁盘/内存/服务基线可复现 | `docs/RESEARCH.md` |
| ARC-01 | 架构设计 ARCHITECTURE.md | P0前置 | done | RES-01 | 2h | 组件/接口/适配器/schema/安全/目录齐备 | `docs/ARCHITECTURE.md` |
| ROA-01 | 里程碑 ROADMAP.md | P0前置 | done | RES-01, ARC-01 | 0.5h | P0/P1/P2 目标、排期、风险齐备 | `docs/ROADMAP.md` |
| RET-01 | 停用 pinas（释放 3000） | P0前置 | done | — | 0.5h | `inactive (dead)` + `disabled` + `ss` 无 3000/3100；`~/pinas` 数据保留；快照回传 `D:\PiBackUp\retire-20261008` | `docs/RESEARCH.md §9` |
| RET-02 | 移除 opencode v1 | P0前置 | done | — | 0.5h | `which opencode` 无结果；dsh/pnpm 保留；auth 已备份 | — |
| RET-03 | 移除 dsh + 清理 opencode v1/dsh 残留 | P0前置 | done | RET-02 | 1h | dsh user 单元 disabled，3080/3100 无监听；`npm ls -g` 仅 npm+pnpm；残留移入退役库 | `docs/RESEARCH.md §9` |
| P0-01 | 仓库地基 + 网关/前端骨架 + 健康检查 | P0 | done | ROA-01 | 2h | 实机 `GET /health` 200；`ss` 确认仅 localhost:3000 | `gateway/src/index.ts`、`web/src/App.tsx`、`deploy/workbench-gateway.service` |
| P0-02 | workbench 用户 + 网关 systemd + MemoryMax + env | P0 | done | P0-01 | 1.5h | 网关 `active (running)`，进程用户 workbench，RSS 75M；`MemoryMax=350M`；`/etc/workbench/env` 0400 | `deploy/*.service`、`deploy/env.example`、`docs/ARCHITECTURE.md §5` |
| P0-03 | OpenCode v2 pin + serve 本地化 + 适配器 + 契约测试 | P0 | done | P0-02 | 2.5h | `/api/ai/health.version=2.0.24`；会话创建/列表往返 ok；serve RSS 293M | `gateway/src/opencode/adapter.ts`、`gateway/test/opencode.contract.test.ts` |
| P0-04 | 控制台只读 + 内存聚合落盘 | P0 | done | P0-01 | 2.5h | 温度与 `vcgencmd` Δ≤1°C；`metrics_ts` 落盘行增，WAL+NORMAL | `gateway/src/routes/sys.ts`、`gateway/src/sys/metrics.ts` |
| P0-05 | 白名单启停 + 审计 | P0 | done | P0-04 | 1.5h | 白名单内 restart 200；白名单外 403 且 `service_audit.allowed=0` | `config/systemd-whitelist.json`、`gateway/src/sys/services.ts` |
| P0-06 | cloudflared 切网关 + 公网链路 | P0 | done | P0-01 | 1h | 公网经内置登录进工作台；`:4096` 公网不可达 | `/etc/cloudflared/config.yml`、`deploy/healthcheck.sh` |
| P0-07 | 写入减负（WAL/journald/log2ram） | P0 | done | P0-08 | 2h | journald volatile 生效；log2ram 128M 接管 `/var/log`；全服务 running | `deploy/*`、`docs/RESEARCH.md §2` |
| P0-08 | 每晚备份 → D:\PiBackUp + 校验 + 告警 + 恢复演练 | P0 | done | — | 2h | Pi 快照×3 + PC 拉取 sha 全对 + 演练 ok；timer 02:30 + PC 03:00 | `deploy/backup.sh`、`scripts/restore-drill.sh`、`scripts/pc-pull.py` |
| P1-01 | 效率面板 API（todos/notes/bookmarks/files） | P1 | done | P0-01 | 3h | curl 四类 CRUD 全过；重启不丢；二进制落盘 | `gateway/src/routes/efficiency.ts` |
| P1-02 | 流水线 jobs + 下发 OpenCode | P1 | done | P0-03 | 4h | cron 按时触发；AI 下发进 `job_runs` | `gateway/src/routes/jobs.ts`、`gateway/src/jobs/scheduler.ts` |
| P1-03 | 门户配置化 | P1 | done | P0-01 | 2h | 只改 json 即增卡片（免重启）；仅 `127.0.0.1:3000` | `config/portal.json` |
| P1-04 | 监控告警（watchdog） | P1 | done | P0-04, P1-02 | 2h | 五项全绿；压阈值 2min 内 alert 落 `job_runs` | `gateway/src/sys/watchdog.ts` |
| P1-05 | 下线旧 ingress | P1 | done | P0-06 | 1h | pidsh 公网 000（DNS 已清）；cloud 200 | cloudflared 配置 |
| P1-06 | SPA 五页（控制台/AI/效率/流水线/门户） | P1 | done | P1-01..03 | 3h | 新包公网 200；AI 经网关建会/下发/出真实回复 | `web/` |
| AUTH-01 | 内置密码认证（替代 CF Access） | P1 | done | P0-06 | 2h | 未登录 401；登录置 HttpOnly cookie；登出 401 | `gateway/src/auth/*` |
| AUTH-02 | 口令改存 `AUTH_LOGIN_PASSWORD` | P1 | done | AUTH-01 | 1h | 口令只认 env；密封文件/DB 哈希残留已清 | `gateway/src/auth/*`、`deploy/env.example` |
| P2-01 | 适配器插件化 + LSP 按需 | P2 | dropped | — | — | 用户决策不做（v2 自带管理） | `gateway/src/opencode/*` |
| P2-02 | 指标保留 + 导出 | P2 | done | P0-04 | 2h | 30 天滚动；CSV 线上导出；未登录 401 | `GET /api/sys/metrics/export` |
| P2-03 | 备份多目标 + 加密 | P2 | dropped | — | — | 用户决策不做（Pi→PC + 7 天滚动已够） | `deploy/backup.sh` |
| P2-04 | 审计硬化（登录/会话/归因） | P2 | done | AUTH-02 | 2h | `auth_audit` 有行；会话列表/吊销可用；`actor=ses:…` | `gateway/src/routes/auth.ts` |
| SEC-01 | 修复认证覆盖面（AI 路由绕过） | 安全修复 | done | — | 1h | 无 cookie 业务 `/api/*`（含 `/api/ai/*`）→ 401；回归测试锁住 | `gateway/src/app.ts`、`gateway/test/auth-coverage.test.ts` |
| SEC-02 | 口令常数时间比较 + 弃 `auth_config` | 安全修复 | done | — | 0.5h | 同长缓冲 `timingSafeEqual`；schema 无 `auth_config` | `gateway/src/auth/password.ts`、`gateway/src/db.ts`、`gateway/test/password.test.ts` |
| SEC-03 | 备份 env 脱敏 + pc-pull host key | 安全修复 | done | — | 0.5h | 备份 `env` 口令 `__REDACTED__`；`RejectPolicy` + known_hosts | `deploy/backup.sh`、`scripts/pc-pull.py` |

## P3 — 安全收口 + 可运维（进行中池）

| 编号 | 标题 | 状态 | 依赖 | 工作量 | 验收标准（实机） | 风险/备注 | 关联 |
|---|---|---|---|---|---|---|---|
| SEC-04 | 强口令 + 部署 SEC-01..03 复验 | done | SEC-01..03 | 1.5h | ① Pi `/etc/workbench/env` 换 16+ 位随机口令并 `restart workbench-gateway`；② 公网未登录 `GET /api/ai/sessions` → 401；③ 登录后 `/api/ai/health` 200/502；④ 手动 `backup.sh` 后备份 `env` 为 `__REDACTED__`；⑤ pc-pull 在 known_hosts 已 pin 时 `PULL_OK` | 换密后旧会话仍活，可 `DELETE FROM sessions`；口令不进仓库/日志 | `/etc/workbench/env`、公网 curl |
| P0-STREAK | 连续3次备份成功（去日历化） | done | SEC-04 | 0.5h | 3 轮手动快照 ok + PC 拉取 sha 全对 + 演练 ok；定时延续按新窗口运行 | 窗口外 23:00-08:00 不跑任务 | \manifest.log\、deploy/workbench-backup.timer |
| P3-01 | 网关请求审计（脱敏） | done | SEC-04 | 2h | 新表 `api_audit(ts,actor,method,path,status,ms)`；登录后 API 写入且**不含** body/query 敏感值；30 天滚动裁剪有单测；未登录 401 不写或写 `actor=anon` 仅 fail | 写放大 → 批量/采样；path 脱敏（id 收敛） | `gateway/src/db.ts`、`gateway/src/app.ts`、`gateway/test/` |
| P3-02 | 会话与敏感操作加固 | done | SEC-04, P2-04 | 2h | 会话绝对超时 7d（创建时间起算）+ 可关滑动续期；shell job 执行 / service restart 前端二次确认；上述操作记 `auth_audit` 或 `api_audit` | **勿做成多用户/RBAC**；登录≈workbench 语义写进 ARCH | `gateway/src/auth/password.ts`、`web/src/pages/*` |
| P3-03 | 备份演练自动化 | done | P0-STREAK | 1h | `restore-drill.sh` 可周跑（job 或 timer）；watchdog 检查 14 天内存在 `DRILL_OK` 记录；演练目录用后即删 | 演练目录勿留敏感；失败进告警 | `scripts/restore-drill.sh`、`gateway/src/sys/watchdog.ts` |

**P3 出口**：公网业务 API 未登录不可达；强口令生效；请求/敏感操作可追溯；连续3次备份 + 演练可被机器检出。

## P4 — 通用工作台（效率 + AI 使用面）

| 编号 | 标题 | 状态 | 依赖 | 工作量 | 验收标准（实机） | 风险/备注 | 关联 |
|---|---|---|---|---|---|---|---|
| P4-01 | AI 会话体验：SSE 真流式 + 多会话 | done | SEC-04, P1-06 | 4h | ① 网关 SSE 透传到前端（替代纯轮询）；② 会话列表可切换/新建/删除；③ 下发任务实时出字（text.delta）；④ 中断 abort 后 UI 状态正确；⑤ 展示 token/耗时（若 API 提供，否则显示耗时）；⑥ 公网实机走通 | 适配器仍是唯一 OpenCode 边界；SSE 断线重连不丢会话上下文提示 | `web/src/pages/Ai.tsx`、`gateway/src/routes/ai.ts`、`gateway/src/opencode/adapter.ts` |
| P4-02 | 效率面板升级（笔记/待办/书签/文件） | done | P1-01 | 3h | ① 笔记 Markdown 预览（安全渲染，禁 script）；② 待办到期提醒经 jobs/watchdog 落记录；③ 书签标签 + 按标签筛；④ 文件上传列表显示大小/时间，文本可预览；⑤ 记一条笔记或待办 ≤3 次点击 | XSS：Markdown 渲染须消毒；文件预览不做 HTML 内嵌执行 | `web/src/pages/Efficiency.tsx`、`gateway/src/routes/efficiency.ts` |
| P4-03 | 全局搜索 | done | P4-02 | 2h | `GET /api/search?q=` 检索 todos/notes/bookmarks/files_meta；前端顶栏入口；关键字命中列表可跳转；P95 响应 ≤200ms（本机千条级） | FTS5 或 LIKE 二选一，先 LIKE 足够则不引入 FTS 迁移 | `gateway/src/routes/efficiency.ts` 或新 `routes/search.ts`、`web/src/App.tsx` |
| P4-04 | 导入导出 | pending | P4-02 | 2h | ① 导出 JSON（四类）+ CSV（todos/notes）；② 导入 JSON 可合并或替换（参数指定）；③ 实机：导出→删测试行→导入还原；④ 导出走已鉴权 API，文件名含日期 | 大 body 限长；导入校验字段类型 | `gateway/src/routes/efficiency.ts`、`web/src/pages/Efficiency.tsx` |
| P4-05 | 移动端可用性 | pending | P4-01, P4-02 | 1.5h | 手机浏览器：登录 → 记待办 → 看温度全链路；无横向滚动；触控目标 ≥44px；导航可折叠 | 只做响应式，不做原生 App/PWA 安装 | `web/src/index.css`、`web/src/App.tsx`、各 `pages/*` |

**P4 出口**：日常记事/搜东西/AI 任务在桌面和手机都顺手；数据可完整导出迁移。

## P5 — 树莓派控制台（观测 + 运维面）

| 编号 | 标题 | 状态 | 依赖 | 工作量 | 验收标准（实机） | 风险/备注 | 关联 |
|---|---|---|---|---|---|---|---|
| P5-01 | 指标可视化（24h/7d 曲线） | pending | P0-04, P2-02 | 2.5h | 温度/CPU/内存/写入四线；范围切换 24h/7d；抽样点与 `vcgencmd`/`free`/diskstats 误差在展示精度内；无数据段不连假线 | 前端轻量 canvas/SVG 即可，不引重型图表库（除非必要） | `web/src/pages/Console.tsx`、`gateway/src/routes/sys.ts` |
| P5-02 | SD/磁盘健康代理 | pending | P0-07, P5-01 | 2h | 展示：根分区剩余、近 24h 写入速率、按日写量粗估可用天数、`/var/log`+journald 水位、大目录 TOP5；超阈值进 watchdog 告警 | SD 无 `life_time`，只能代理指标；阈值走 env 可调 | `gateway/src/sys/metrics.ts`、`gateway/src/sys/watchdog.ts` |
| P5-03 | 日志查看器 | pending | P0-04 | 2h | unit 过滤 + 时间范围 + 条数上限；级别着色；`password|token|key|secret` 脱敏高亮；一键复制；实机排一次 opencode 失败不进 SSH | 勿整段回显超大 journal；路径/unit 白名单或校验防注入 | `gateway/src/sys/logs.ts`、`web/src/pages/Console.tsx` |
| P5-04 | 可选服务监控槽 | pending | P5-01 | 1.5h | minecraft/mc-server（或 env 指定 unit）只读状态 + 近期内存/温度关联展示；**默认不入启停白名单**；overview 可见 RSS | 应对 R1 内存挤占；启停若要做须另开任务并改 ARCH §5 + sudoers | `config/systemd-whitelist.json`（只读不改）、`gateway/src/routes/sys.ts` |
| P5-05 | 告警通道外送 | pending | P1-04, P5-02 | 2h | 配置 webhook/ntfy URL（env 或 config，URL 不进日志明文可选脱敏）；watchdog 告警经 `kind=http` 外送；模拟超温 5min 内手机收到 | 不新增系统特权；失败重试有限次并记 `job_runs` | `gateway/src/sys/watchdog.ts`、`gateway/src/jobs/scheduler.ts`、`deploy/env.example` |

**P5 出口**：趋势可看、SD 风险有数、排障可不进 SSH、异常能推到手机。

## P6 — 自动化与门户（可选，默认暂缓）

> 启用条件：P4/P5 实际使用痛点命中下列任务。未启用前保持 `pending`，不排期。

| 编号 | 标题 | 状态 | 依赖 | 工作量 | 验收标准（实机） | 风险/备注 | 关联 |
|---|---|---|---|---|---|---|---|
| P6-01 | 任务模板库 | pending | P1-02 | 2h | 预置模板 ≥3（备份校验、周报摘要、AI 整理）；一键创建 job；模板进 `config/` 可版本管理 | 模板 payload 仍走 `validateJob` | `config/`、`gateway/src/routes/jobs.ts` |
| P6-02 | 门户反代卡片 | pending | P1-03, SEC-04 | 2h | `portal.json` 支持 `pathPrefix` 反代到 localhost 服务；卡片经网关鉴权后可打开；**零新入站端口** | SSRF/开放代理：仅允许配置里声明的 localhost 上游 | `config/portal.json`、`gateway/src/routes/portal.ts` |
| P6-03 | 周报生成 | pending | P5-01, P5-05 | 2h | 汇总 metrics + `job_runs` + 审计摘要；定时写入笔记或推告警通道；实机触发一周报可读 | 摘要脱敏；篇幅可控 | `gateway/src/jobs/`、`gateway/src/routes/efficiency.ts` |
| P6-04 | 插件化仪表盘 | pending | P4-05, P5-01 | 2h | 卡片布局可配置（顺序/显隐）并持久化；重载不丢 | 仅当 P4/P5 用出真需求再做 | `web/src/pages/*` |

**P6 出口**（若做）：重复运维动作模板化，常用入口在门户/仪表盘一屏可达。

## 流转规则

- `pending → in-progress`：开工前改本表；`→ done`：验收（含实机）全过 + 文档同步后改；`→ blocked`：写明阻塞项与绕行；`→ dropped`：写明用户决策原因。
- 每任务一次会话可完成 + 独立验收；“本地跑通”无效。
- 里程碑目标/排期/里程碑级风险 → 只改 `docs/ROADMAP.md`；任务状态/依赖/工作量/验收 → 只改本文件。
- P0 出口（历史）：内置登录 → AI 下发 → 温度/负载/写入可见 → 白名单外被拒 → 3 晚备份 + 恢复演练（代码项 done，日历 streak 见 `P0-STREAK`）。
