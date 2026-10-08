# AGENTS.md — Agent 工作守则

## 1. 文档维护规则（何时更新哪个文件）

| 触发条件 | 更新文件 |
|---|---|
| 实机测量/版本变化 | `docs/RESEARCH.md`（追加日期 + 数据，旧数据保留） |
| 落地/事故/决策记录 | `CHANGELOG.md`（按时间正序追加） |
| 接口/schema/端口/目录/白名单变化 | `docs/ARCHITECTURE.md`（同 PR 内同步） |
| 里程碑目标/排期/里程碑级风险 | `docs/ROADMAP.md`（不写任务明细） |
| 任务开工/完成/阻塞/依赖/工作量/验收 | `docs/TASK-INDEX.md`（唯一任务事实源） |
| 守则本身变化 | 本文件 `AGENTS.md` |
| 对外说明变化 | `README.md` |

文档先行：`RESEARCH → ARCHITECTURE → ROADMAP → TASK-INDEX → AGENTS.md` 链条未自检通过前，不写业务代码。

**认证挂钩铁律**：全局登录 `onRequest` 必须在**全部业务路由注册之前** `addHook`（Fastify 钩子只作用于其后注册的路由）。新增 `/api/*` 后跑 `gateway/test/auth-coverage.test.ts`。

## 2. 任务状态流转

- `pending → in-progress`：开工前改 TASK-INDEX；`→ done`：验收（含实机验证）全过 + 文档同步后改；`→ blocked`：写明阻塞项与绕行方案。
- 每个任务一次会话可完成 + 独立验收；验收必须含实机步骤（命令 + 期望输出），“本地跑通”无效。
- 所有 OpenCode 调用必须经 `gateway/src/opencode/adapter.ts`；直调视为 bug，打回。

## 3. 代码与提交规范

- TypeScript 严格模式；Fastify 网关 + SolidJS 前端；`npm run typecheck && npm test` 全过才可标 done。
- 发版铁律：带 `package-lock.json`，Pi 侧 `npm ci`；`package.json` 变了必须同步 `/opt` 的 `node_modules`；判构建成功只看退出码（`echo EXIT:$?` / `$LASTEXITCODE`），禁止 `| tail` 取码、禁止只看输出文本（tsc 错误行曾被截断漏看）；`config/` 非代码文件（白名单/portal）同批发版并验存在。
- SQLite：`WAL + synchronous=NORMAL`；时序 5–10min 批量写；二进制不进库。
- 提交信息：`<任务编号> <动词> <对象>`，如 `P0-01 add gateway health endpoint`。一次提交只做一件事。
- 禁止提交：`node_modules/`、`*.db*`、`*.log`、凭据、`.env` 真值（只提交 `deploy/env.example`）。

## 4. 安全红线（违反即停止并记录）

1. 不开放任何入站端口；`opencode serve` 只绑 `127.0.0.1`，由网关代理。
2. 不将白名单外服务纳入控制；白名单变更需同步 `config/systemd-whitelist.json` + ARCHITECTURE §5。
3. 不在代码/日志/文档/测试中写入 API Key、CF 凭据、密码。凭据只存 `/etc/workbench/env`（`0400`）与 OpenCode 本地配置；日志脱敏 `password|token|key|secret`。
4. 改动存储配置（journald/log2ram/fstab/apt 大包）前，先确认 `backups` 最近一条 `status=ok`（`sqlite3 wb.db "SELECT * FROM backups ORDER BY ts DESC LIMIT 1"`）。

## 5. 构建/部署/回滚速查（实机，workbench 用户）

```bash
# 健康
curl -s http://127.0.0.1:3000/health; curl -s http://127.0.0.1:4096/global/health
ss -tlnp | grep -E '3000|4096'
# 部署网关
sudo systemctl restart workbench-gateway.service && systemctl status workbench-gateway.service --no-pager
# 部署 opencode
sudo systemctl restart opencode.service && journalctl -u opencode.service -n 30 --no-pager
# 备份与验证
sudo /opt/workbench/backup.sh && sqlite3 /var/lib/workbench/wb.db "SELECT id,ts,status FROM backups ORDER BY ts DESC LIMIT 3"
# 回滚（上一版 systemd + 代码 tag）
sudo systemctl revert workbench-gateway.service; git tag -l 'p0-*' | tail; git checkout <last-good-tag>
```
