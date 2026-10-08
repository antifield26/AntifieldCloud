# 里程碑规划（ROADMAP）

> 骨架：P0 地基 → P1 效率+自动化+门户 → P2 插件化深化。任务明细与状态以 `docs/TASK-INDEX.md` 为准（唯一事实源）。

## P0 — 地基：可从公网安全登录并跑通 AI + 控制台 + 备份（~12–16h 实机工作量）

目标（已按用户决策更新；原 CF Access 改为内置密码登录）：内置密码登录 → 下发真实编码任务见流式进度 → 控制台温度/负载/SD 写入 → 白名单外启停被拒 → 连续 3 晚备份成功 + 1 次恢复演练。

| 顺序 | 任务 | 依赖 | 出口标准 | 工作量 | 风险 |
|---|---|---|---|---|---|
| P0-01 | 仓库地基 + 网关/前端骨架 + 健康检查 | RESEARCH/ARCH | `GET /health` 200；`ss` 仅 127.0.0.1:3000（初版 3090，后复用 3000） | 2h | 端口冲突（先 `ss -tlnp`） |
| P0-02 | `workbench` 用户 + systemd 单元 + MemoryMax + env 凭据文件 | P0-01 | `systemctl status` 双服务 running；`ps -o user` 非 antifield/root | 1.5h | nvm PATH（用绝对路径） |
| P0-03 | OpenCode v2 安装 pin + serve 本地化 + 适配器 + 契约测试 | P0-02 | `/api/ai/health.version=2.0.24`；SSE 首帧 `server.connected`；RSS ≤1G | 2.5h | v1/v2 差异（适配器嗅探） |
| P0-04 | 控制台只读（overview/metrics/disk/logs/apt）+ 内存聚合落盘 | P0-01 | 5s 轮询；`metrics_ts` 10min 行增；温度与 `vcgencmd` 一致 ±1°C | 2.5h | PSI 缺失（已规避）；写入放大（批量） |
| P0-05 | 白名单启停 + 审计 + 403 用例 | P0-04 | 白名单内 restart ok；白名单外 403 且 `service_audit` 有行 | 1.5h | antifield 过宽（不用它） |
| P0-06 | cloudflared 切网关 + 公网链路验证（原含 CF Access，已改内置密码） | P0-01 | 公网经内置登录进工作台；`serve:4096` 公网不可达 | 1h | 边缘抖动（重试+探针） |
| P0-07 | 写入减负（SQLite WAL/NORMAL、journald volatile、log2ram、apt 提醒） | P0-06前先定备份目标 | `journalctl --disk-usage` 下降；重启不丢审计 | 2h | **备份链路未就绪则阻塞** |
| P0-08 | 每晚备份（→ PC `D:\PiBackUp`）+ 校验 + 失败告警 + 恢复演练 | P0-07 | 连续 3 晚 `backups.status=ok` + 1 次恢复演练报告 | 2h | 拉取方式（PC 从 Pi 取，避免 Pi 存 PC 凭据） |

P0 总量 15h 上下；R1（java 2.4G）与 R3（备份目标）是关键路径，建议开工即与用户确认：是否限 `minecraft Xmx`、是否停桌面、PC 备份目录。

## P1 — 效率 + 自动化 + 门户（~10–12h）

- P1-01 效率面板 CRUD（todos/notes/bookmarks/files，`files` 二进制落盘）：3h。验收：SPA 增删改查 + 重启不丢。
- P1-02 流水线（jobs + job_runs + 定时执行 + 可下发 OpenCode）：4h。验收：cron 任务按时跑 + 下发 AI 有 `job_runs` 日志。
- P1-03 门户配置化（`portal.json`，pi_nas 已退役，门户即工作台文件服务）：2h。验收：只改 json 即增卡片。
- P1-04 监控告警（tunnel/温度/内存/SD/备份失败经 jobs 告警）：2h。验收：断线/超温/备份失败 5min 内有记录。
- P1-05 下线旧 ingress（`cloud/pidsh` 直连）与 `pi_nas:3000` 公网面：1h。验收：`ss` 无 `0.0.0.0:3000`。

## P2 — 收尾（用户决策：P2-01/P2-03 不做）

- P2-01 适配器插件化：dropped。
- P2-02 指标保留策略 + 导出（30天滚动、CSV 导出）：done。
- P2-03 备份多目标（S3/USB）+ 加密：dropped。
- P2-04 审计硬化（内置认证下：登录审计 + 会话管理 + 操作归因）：done。

## P3 — 安全收口 + 可运维（评估遗留，~4–6h，建议最先做）

目标：把 2026-10-09 评估的安全缺口全部实机闭合，P0 出口日历 streak 走完。

| 顺序 | 任务 | 依赖 | 出口标准 | 工作量 | 风险 |
|---|---|---|---|---|---|
| SEC-04 | 强口令 + 部署 SEC-01..03 到 Pi | 本机修复已完成 | 16+ 位随机口令入 `/etc/workbench/env`；公网未登录 `GET /api/ai/sessions` → 401；登录后 AI 可用；备份 `env` 见 `__REDACTED__`；pc-pull 首连 pin host key 后 `PULL_OK` | 1.5h | 口令换后旧会话仍有效（可清 `sessions` 表） |
| P0-STREAK | 连续 3 晚备份日历 streak | SEC-04 | `manifest.log` 连续 3 个自然日 `OK`；README 出口改为完成态 | 0.5h | timer/PC 任务失败要当天修 |
| P3-01 | 网关请求审计（脱敏） | SEC-04 | 登录后 API 写 `api_audit`（path/method/status/actor，无 body）；30 天滚动 | 2h | 写放大（批量/采样） |
| P3-02 | 会话与敏感操作加固 | SEC-04 | 会话绝对超时 7d + 滑动续期可关；shell job / service restart 前端二次确认；`auth_audit` 记敏感操作 | 2h | 勿做成多用户系统 |
| P3-03 | 备份演练自动化 | P0-STREAK | `restore-drill` 纳入周任务或 watchdog 检查 14 天内有 DRILL_OK | 1h | 演练目录勿留敏感 |

## P4 — 通用工作台（效率 + AI 使用面，~10–12h）

目标：从「能用的 CRUD」变成「每天愿意打开的个人工作台」。

- P4-01 AI 会话体验：SSE 真流式到前端（现为轮询）、多会话切换、中断/重试、token 用量展示：4h。验收：公网下发任务实时出字，可 abort。
- P4-02 效率面板升级：笔记 Markdown 预览、待办到期提醒（经 jobs）、书签标签与搜索、文件缩略/预览：3h。验收：日常记一条笔记/待办 ≤3 次点击。
- P4-03 全局搜索：todos/notes/bookmarks/files_meta 一次检索（SQLite FTS5 或 LIKE）：2h。验收：关键字 200ms 内出结果。
- P4-04 导入导出：效率数据 JSON/CSV 导出 + 导入；与备份策略衔接：2h。验收：导出→清库→导入可还原。
- P4-05 移动端可用性：SPA 小屏布局、触控目标、登录页无横向滚动：1.5h。验收：手机浏览器完成登录→记待办→看温度。

## P5 — 树莓派控制台（观测 + 运维面，~8–10h）

目标：控制台从「看一眼」变成「能判断、能处置、能追溯」。

- P5-01 指标可视化：24h/7d 温度/CPU/内存/写入折线（已有 metrics_ts + CSV）：2.5h。验收：曲线与 `vcgencmd`/`free` 抽样一致。
- P5-02 SD/磁盘健康代理：写入速率、剩余寿命粗估（按日写量）、大目录 TOP、log2ram/journald 水位：2h。验收：超阈值进 watchdog 告警。
- P5-03 日志查看器：unit 过滤 + 级别 + 时间范围 + 脱敏高亮 + 一键复制：2h。验收：排一次 opencode 失败不进 SSH。
- P5-04 可选服务监控槽：minecraft/mc-server 只读状态 + 温度/内存关联（默认不入启停白名单）：1.5h。验收：R1 内存占用在 overview 可见。
- P5-05 告警通道外送：watchdog → ntfy/邮件/webhook（经 jobs kind=http，不新增特权）：2h。验收：模拟超温 5min 内手机可收到。

## P6 — 自动化与门户（可选深化，~6–8h）

- P6-01 任务模板库：备份校验、周报摘要、AI 文献/代码整理等预置 job：2h。
- P6-02 门户反代卡片：`portal.json` 支持 path 前缀反代（仍经网关鉴权），替代裸链接：2h。**红线：不引入新入站端口。**
- P6-03 周报生成：metrics + job_runs + 审计摘要，定时推送到笔记或告警通道：2h。
- P6-04 插件化仪表盘（卡片布局自定义）：2h。仅当 P4/P5 用出真需求再做。

## 建议排期原则

1. **先 P3 后功能**：安全收口未实机闭合前，不扩公网能力面。
2. **P4 与 P5 可并行**（不同会话/owner），但共享 `/api/*` 时先合并再开分支。
3. **P6 默认不做**，等 P4/P5 用两周后按痛点勾选。
4. 每任务仍遵守：一次会话可完成 + 实机验收 + 同步 TASK-INDEX/ARCH/CHANGELOG。

## 跨里程碑原则

- 每个任务一次会话可完成 + 独立验收（含**实机验证步骤**，“本地跑通”不算完成）。
- 完成即更新 TASK-INDEX；ARCHITECTURE 变更同步更新 `docs/opencode-openapi.json` 快照。
