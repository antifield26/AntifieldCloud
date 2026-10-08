# 任务索引（TASK-INDEX）

> 本文件是项目**唯一任务事实源**。状态：`pending / in-progress / done / blocked`。
> 完成任务后立即更新本表；验收必须含实机验证步骤。

| 编号 | 标题 | 里程碑 | 状态 | 验收标准（摘） | 关联文档/代码 |
|---|---|---|---|---|---|
| RES-01 | 实机环境调研 + RESEARCH.md | P0前置 | done | 6 项实测/待测齐备；无凭据落文档；磁盘/内存/服务基线可复现 | `docs/RESEARCH.md` |
| ARC-01 | 架构设计 ARCHITECTURE.md | P0前置 | done | 组件/接口/适配器/schema/安全/目录齐备 | `docs/ARCHITECTURE.md` |
| ROA-01 | 里程碑 ROADMAP.md | P0前置 | done | P0/P1/P2 目标依赖出口工作量风险齐备 | `docs/ROADMAP.md` |
| P0-01 | 仓库地基 + 网关/前端骨架 + 健康检查 | P0 | done | 实机 `GET 127.0.0.1:3090/health` 200（后按用户指令默认端口改为 3000）；`ss` 确认仅 localhost 监听 | `gateway/src/index.ts`、`web/src/App.tsx`、`deploy/workbench-gateway.service` |
| RET-01 | 停用 pinas（释放 3000） | P0前置 | done | `inactive (dead)` + `disabled` + `ss` 无 3000/3100；`~/pinas` 数据保留；快照回传 `D:\PiBackUp\retire-20261008`；其他服务 running | `docs/RESEARCH.md §9` |
| RET-02 | 移除 opencode v1 | P0前置 | done | `which opencode` 无结果；dsh/pnpm 保留；auth 已备份 |
| RET-03 | 移除 dsh + 清理 opencode v1/dsh 残留 | P0前置 | done | dsh user 单元 disabled，3080/3100 无监听；`npm ls -g` 仅 npm+pnpm；残留移入退役库，原路径清空；其他服务 running | `docs/RESEARCH.md §9` | `docs/RESEARCH.md §9` |
| P0-02 | workbench 用户 + 网关 systemd + MemoryMax + env | P0 | done | 网关 `active (running)`，进程用户 workbench，RSS 75M；`GET 127.0.0.1:3000/health` 200；`MemoryMax=350M`；`/etc/workbench/env` 0400；opencode.service 已部署未启用（待 P0-03） | `deploy/*.service`、`deploy/env.example`、`docs/ARCHITECTURE.md §5` |
| P0-03 | OpenCode v2 pin 安装 + 本地 serve + 适配器 + 契约测试 | P0 | done | 网关 `/api/ai/health.version=2.0.24`；会话创建/列表经网关往返 ok；serve RSS 293M；opencode.service enabled+running（workbench） | `gateway/src/opencode/adapter.ts`、`gateway/test/opencode.contract.test.ts` |
| P0-04 | 控制台只读 + 内存聚合落盘 | P0 | done | 网关温度 49.1 vs `vcgencmd` 48.8（Δ0.3）；`metrics_ts` 落盘行增，WAL+NORMAL；ssh 日志/apt/磁盘均实测 | `gateway/src/routes/sys.ts`、`gateway/src/sys/metrics.ts` |
| P0-05 | 白名单启停 + 审计 | P0 | done | 白名单内 restart 200（opencode 已重起）+ 自重启后 /health 恢复；白名单外 3 例 403 且审计 `allowed=0` | `config/systemd-whitelist.json`、`gateway/src/sys/services.ts` |
| P0-06 | cloudflared 切网关 + 公网链路 | P0 | done | 双域名公网 200（`cloud`+`pidsh`→网关）；`:4096` 公网 000；`cloud` ingress 免改，`pidsh` 重定向；tunnel QUIC 重连 | `/etc/cloudflared/config.yml`（实机）、`deploy/healthcheck.sh` |
| P0-07 | 写入减负（WAL/journald/log2ram） | P0 | done | journald volatile 生效（持久路径空）；log2ram 128M 接管 /var/log；全服务 running | `deploy/*`、`docs/RESEARCH.md §2` |
| P0-08 | 每晚备份 → D:\PiBackUp + 校验 + 告警 + 恢复演练 | P0 | done | Pi 快照×3 + PC 拉取 sha 全对 + 演练 ok；timer 每日 02:30 + PC 任务每日 03:00；`backups` 3 行 ok | `deploy/backup.sh`、`scripts/backup-verify.sh` |
| P1-01 | 效率面板 API（todos/notes/bookmarks/files） | P1 | done | curl 四类增删改查全过；重启后行数/blob 都在；二进制落盘（库中仅元数据）；探针已清（SPA 页面见 P1-06） | `gateway/src/routes/efficiency.ts` |
| P1-02 | 流水线 jobs + 下发 OpenCode | P1 | done | shell 手动 done；`* * * * *` 3 分钟连触发；AI 下发 done（session+全事件进 `job_runs`）；探针已清 | `gateway/src/routes/jobs.ts` |
| P1-03 | 门户配置化（工作台文件服务） | P1 | done | 只改 json 即 1→2 卡（免重启），已还原；仅 `127.0.0.1:3000` 监听 | `config/portal.json` |
| P1-04 | 监控告警 | P1 | done | 五项全绿；压阈值 2 分钟内 2 条 alert 落 `job_runs`；阈值已恢复 | `gateway/src/sys/watchdog.ts` + jobs |
| P1-05 | 下线旧 ingress | P1 | done | pidsh 公网 000（DNS 已清）；cloud 200；配置仅 cloud+mc+404 | cloudflared 配置 |
| P1-06 | SPA 五页（控制台/AI/效率/流水线/门户） | P1 | done | 新包公网 200；AI 经网关建会/下发/轮询出真实回复；探针已清 | `web/` |
| AUTH-01 | 内置密码认证（替代 CF Access） | P1 | done | 未登录 401；密封口令登录置 HttpOnly cookie；登出后 401；改密删密封文件（本地已测，线上待用户首登改密） | `gateway/src/auth/*` |
| P2-01 | 适配器插件化 + LSP 按需 | P2 | pending | 多模型路由；LSP RSS 预算内 | `gateway/src/opencode/*` |
| P2-02 | 指标保留 + 导出 | P2 | pending | 30天滚动；CSV 导出可用 | `wb.db`、`/api/sys/metrics` |
| P2-03 | 备份多目标 + 加密 | P2 | pending | S3/USB 二选一 ok；加密恢复 ok | `deploy/backup.sh` |
| P2-04 | 审计 + Access JWT 硬化 | P2 | pending | JWT 校验；越权 403 | `gateway/src/index.ts` |

## 流转规则

- `pending → in-progress`：开工时改；`→ done`：验收全过 + 文档同步后改；`→ blocked`：注明阻塞项（如 `P0-07 blocked by P0-08`）并记风险。
- P0 出口（与启动提示词一致）：Access 登录 → AI 下发流式 → 温度/负载/写入可见 → 白名单外被拒 → 3 晚备份 ok + 恢复演练。
