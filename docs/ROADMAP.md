# 里程碑规划（ROADMAP）

> 骨架：P0 地基 → P1 效率+自动化+门户 → P2 插件化深化。任务明细与状态以 `docs/TASK-INDEX.md` 为准（唯一事实源）。

## P0 — 地基：可从公网安全登录并跑通 AI + 控制台 + 备份（~12–16h 实机工作量）

目标：满足“P0 出口标准”（README/启动提示词）：CF Access 登录 → 下发真实编码任务见流式进度 → 控制台温度/负载/SD 写入 → 白名单外启停被拒 → 连续 3 晚备份成功 + 1 次恢复演练。

| 顺序 | 任务 | 依赖 | 出口标准 | 工作量 | 风险 |
|---|---|---|---|---|---|
| P0-01 | 仓库地基 + 网关/前端骨架 + 健康检查 | RESEARCH/ARCH | `GET /health` 200；`ss` 仅 127.0.0.1:3090 | 2h | 端口冲突（先 `ss -tlnp`） |
| P0-02 | `workbench` 用户 + systemd 单元 + MemoryMax + env 凭据文件 | P0-01 | `systemctl status` 双服务 running；`ps -o user` 非 antifield/root | 1.5h | nvm PATH（用绝对路径） |
| P0-03 | OpenCode v2 安装 pin + serve 本地化 + 适配器 + 契约测试 | P0-02 | `/api/ai/health.version=2.0.24`；SSE 首帧 `server.connected`；RSS ≤1G | 2.5h | v1/v2 差异（适配器嗅探） |
| P0-04 | 控制台只读（overview/metrics/disk/logs/apt）+ 内存聚合落盘 | P0-01 | 5s 轮询；`metrics_ts` 10min 行增；温度与 `vcgencmd` 一致 ±1°C | 2.5h | PSI 缺失（已规避）；写入放大（批量） |
| P0-05 | 白名单启停 + 审计 + 403 用例 | P0-04 | 白名单内 restart ok；白名单外 403 且 `service_audit` 有行 | 1.5h | antifield 过宽（不用它） |
| P0-06 | cloudflared 单 ingress 切网关 + CF Access 全链路验证 | P0-01 | 公网经 Access 进工作台；`serve:4096` 公网不可达 | 1h | 边缘抖动（重试+探针） |
| P0-07 | 写入减负（SQLite WAL/NORMAL、journald volatile、log2ram、apt 提醒） | P0-06前先定备份目标 | `journalctl --disk-usage` 下降；重启不丢审计 | 2h | **备份链路未就绪则阻塞** |
| P0-08 | 每晚备份（→ PC `D:\PiBackUp`）+ 校验 + 失败告警 + 恢复演练 | P0-07 | 连续 3 晚 `backups.status=ok` + 1 次恢复演练报告 | 2h | 拉取方式（PC 从 Pi 取，避免 Pi 存 PC 凭据） |

P0 总量 15h 上下；R1（java 2.4G）与 R3（备份目标）是关键路径，建议开工即与用户确认：是否限 `minecraft Xmx`、是否停桌面、PC 备份目录。

## P1 — 效率 + 自动化 + 门户（~10–12h）

- P1-01 效率面板 CRUD（todos/notes/bookmarks/files，`files` 二进制落盘）：3h。验收：SPA 增删改查 + 重启不丢。
- P1-02 流水线（jobs + job_runs + 定时执行 + 可下发 OpenCode）：4h。验收：cron 任务按时跑 + 下发 AI 有 `job_runs` 日志。
- P1-03 门户配置化（`portal.json` + NAS 反代 `127.0.0.1:3000`）：2h。验收：只改 json 即增卡片；NAS 经网关访问。
- P1-04 监控告警（tunnel/温度/内存/SD/备份失败经 jobs 告警）：2h。验收：断线/超温/备份失败 5min 内有记录。
- P1-05 下线旧 ingress（`cloud/pidsh` 直连）与 `pi_nas:3000` 公网面：1h。验收：`ss` 无 `0.0.0.0:3000`。

## P2 — 插件化深化（~8–10h，按需排）

- P2-01 适配器插件化（多 Agent/多模型路由、LSP 按需启动 0.5–1G 预算）：3h。
- P2-02 指标保留策略 + 导出（30天滚动、CSV 导出）：2h。
- P2-03 备份多目标（S3/USB）+ 加密：3h。
- P2-04 审计与 Access JWT 校验硬化：2h。

## 跨里程碑原则

- 每个任务一次会话可完成 + 独立验收（含**实机验证步骤**，“本地跑通”不算完成）。
- 完成即更新 TASK-INDEX；ARCHITECTURE 变更同步更新 `docs/opencode-openapi.json` 快照。
