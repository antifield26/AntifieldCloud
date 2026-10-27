# AntifieldCloud v0.8.0 实施计划（当前状态）

本文件记录当前版本的范围、决策、非目标与回滚方式。版本演进见 `docs/ROADMAP.md` 与仓库根 `CHANGELOG.md`；完整验收证据见 `docs/ACCEPTANCE.md`；契约见 `docs/API.md`；界面见 `docs/UI-SPEC.md`。

## 当前版本

- **版本**：v0.8.0；schema **v17**（无迁移）；OpenCode **v2.1.4**；Node.js **v26.12.1**。
- **状态**：**本地实现与本地门禁完成，生产部署/验收待执行**（2026-10-27）；生产当前仍为 **v0.7.3**（release `20261027T060134Z`/commit `aedc3c7`，`/healthz` v0.7.3/schema17，完整 Access smoke **34/0/0/2**，读范围矩阵 7/7、drill `20261027T061319Z` 通过、真实 QQ 私聊/群聊正向验收通过）。在 Lead 完成 v0.8.0 部署、smoke（含 `-ExpectedLofiiVersion 0.6.0` 或 `-SkipLofii`）、drill 与生产 `/api/lofii/status` 验证前，不得声明已部署/已验收。
- **发布**：v0.8.0 **尚未创建 Tag/GitHub Release**；生产部署与验收通过后由 Lead 决定。
- **测试基线（2026-10-27 本地实测）**：`npm run check` 通过；`npm test` **566**（565 pass、1 skip，server=87 + scripts=4 共 91 文件）、`npm run test:web` **250**（47 文件）；服务端覆盖率 **Lines 93.06% / Branches 78.67% / Functions 88.70%**、前端 **Lines 55.48% / Branches 49.91% / Functions 48.45%**（`test:coverage` 与 `test:web:coverage` 门禁通过）；`npm run build` 通过（`index-DHjowEA5.js` 761.09 kB）；`node scripts/check-version.mjs` 严格模式期望 `0.8.0`（生产部署前以实际运行结果为准）。

## 范围

- **只读状态**：服务端轮询独立的 Lofii Bot（仅 loopback `127.0.0.1:3010`）的 `GET /status` 与 `GET /events/recent`，缓存最新快照与最近 100 条事件（内存、newest-first）；`GET /api/lofii/status` 返回聚合快照（含 `enabled/reachable/stale/controlEnabled/alertsEnabled/eventsSupported/version/contractVersion/lastPollAt/error/status/events`）。
- **任务控制**：`POST /api/lofii/tasks`（7 种任务）、`/tasks/stop`（中断并清空队列）、`/tasks/resume`（恢复待恢复任务，可带 `taskId`）。
- **移动控制**：`POST /api/lofii/move`（home/come/follow/stop）；目标玩家来自 Lofii 在线列表，任务进行中拒绝手动移动。
- **游戏内聊天**：`POST /api/lofii/say`（只聊天、不执行命令；trim 后 1–720 字符、禁止 `/` 开头）。
- **历史**：`GET /api/lofii/history?kind=samples|alerts&from=&to=&limit=`，透传上游只读形状（kind/from/to/count/samples|alerts）。
- **告警联动**：上游 `alert` 事件映射为本应用告警事件 `status='event'`，不写 `alert_state`、不参与 firing/resolved；游标持久化在 `meta.lofii.event_cursor`；复用既有 webhook 与 Bot 通知；`LOFII_ALERTS_ENABLED` 默认 true。
- **Web**：`/minecraft` 合并为「服务器 / Lofii」两个可访问标签页（`?tab=lofii`/`#lofii` 深链、键盘方向键/Home/End）；Lofii 面板含状态/任务/移动/聊天/事件流/历史，写操作二次确认；`/api/version` 的 `lofiiEnabled`/`lofiiControlEnabled` 驱动标签与控制显隐。
- **配置/部署**：`LOFII_ENABLED`（默认 false）、`LOFII_URL`、`LOFII_READ_TOKEN`、`LOFII_CONTROL_TOKEN`、`LOFII_TIMEOUT_MS`、`LOFII_POLL_MS`、`LOFII_ALERTS_ENABLED`；新增 `scripts/sync-lofii-tokens.sh`（root 从 `/etc/lofii-bot/env` 同步 Token，`--check` 只比较）；`bootstrap-env.sh`/`deploy/env.example`/`smoke.ps1` 同步。
- **安全**：读/控制 Token 分离；上游仅 loopback + http(s)，`redirect: 'error'`、超时、2 MiB 响应上限；`/api/lofii/*` 全部需登录，写操作 + CSRF + IP 限流（控制 20/min、聊天 10/min）；审计不含聊天正文；Token/URL 不下发浏览器。
- **文档/发布**：README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/AUDIT 同步 v0.8.0；schema 与 OpenCode 工具版本不变。

## 关键决策

| 项 | 当前决策 |
|---|---|
| 对接方式 | 服务端低频轮询 `/status` + `/events/recent`，不消费 SSE、不让浏览器直连 Lofii；默认 `LOFII_POLL_MS=5000`（2000–60000） |
| 上游契约 | lofii-bot **v0.6.0+**、`contractVersion=1`；`/events/recent` 404（旧版）只置 `eventsSupported=false`，`/status` 继续可用 |
| Token | 读 Token 用于 `/status`、`/history`、`/say`；控制 Token 只用于 `/task/*` 与 `/move`；控制 Token 为空 = 只读，控制接口 503 `lofii_control_disabled` |
| 网络边界 | `LOFII_URL` 启用时必须 loopback + http(s)；客户端 `redirect: 'error'`，网络错误/超时统一 `lofii_unavailable`，错误文本脱敏 |
| 告警语义 | 外部事件 `status='event'`，不写 `alert_state`、不产生 firing/resolved；Level：已知 5 类映射固定 severity，未知类型 `error→critical` 否则 warning；event 名 `lofii_<type>`（未知 `lofii_alert`） |
| 告警游标 | `meta.lofii.event_cursor={bootId,lastEventId,lastTs}`；首次/无游标/`bootId` 变化只建基线不重放；之后只处理游标之后事件；`LOFII_ALERTS_ENABLED=false` 仍推进游标 |
| 数据/隐私 | 聊天与事件只进内存缓存（最多 100 条），不落库、不写日志；`/say` 审计只记字符数；历史透传只读 |
| Web | `/minecraft` 合并双标签；Lofii 未启用不显示标签；禁用/不可达/过期/控制未启用分别有降级文案；不展示 Token/地址/内部路径 |
| schema | 保持 **v17**，无迁移；仅新增 `meta` 键（`lofii.event_cursor`），不新增表/列 |
| 默认状态 | `LOFII_ENABLED=false`、读/控制 Token 为空；升级/回滚不影响既有功能 |
| 部署顺序 | 先部署 lofii-bot v0.6.0（仅 loopback）→ root 同步 Token → 设 `LOFII_ENABLED=true` → 重启应用 → 验证 `/api/lofii/status` 与 smoke |
| 回滚 | `LOFII_ENABLED=false` + 重启即回到 v0.7.3 行为；可保留/清空 Token 与 `meta.lofii.event_cursor`；无 schema/DB 回滚 |

## 架构与数据流

```text
浏览器 /minecraft?tab=lofii
  └─ GET /api/lofii/status（5s 轮询） / history / POST tasks|move|say
       └─ 应用（127.0.0.1:3000，登录 + CSRF + 限流）
            ├─ LofiiService：单飞轮询 /status + /events/recent → 内存快照/事件缓存
            ├─ 告警游标 meta.lofii.event_cursor → AlertService.recordExternal(status='event')
            └─ LofiiClient（读/控制 Token、redirect:error、2.5s 超时、2 MiB 上限）
                 └─ HTTP → lofii-bot（127.0.0.1:3010，Minecraft 附属服务，仅 loopback）
```

- 轮询成功：更新 `statusSnapshot`、`version`、`contractVersion`、事件缓存；失败：只更新 `reachable/stale/error`，保留旧数据。
- 事件合并：按 `id` 去重、newest-first、最多 100 条；`/events/recent` 404 时 `eventsSupported=false`。
- 告警：`advanceCursor` 过滤 `type='alert'` → `mapLofiiAlert`（清洗 details 深度/键数/数组/字符串长度）→ `recordExternal`（异步 webhook + Bot 通知）。
- 控制：成功即 `refresh()` 拉一次最新状态；`/say` 使用读 Token，只读模式下仍可用。

## 阶段

1. **契约与配置**（完成）：确认 lofii-bot v0.6.0 `/status`、`/events/recent`、`/history`、控制接口与错误码；`server/src/config.ts` 增加 `LOFII_*` 校验与默认值。
2. **服务端对接**（完成）：`server/src/lofii/client.ts`（Token/超时/重定向/错误映射/响应上限）、`service.ts`（轮询/缓存/stale/游标/告警映射/控制代理）、`http/routes/lofii.ts`（GET/POST、CSRF、限流、审计、参数白名单）。
3. **告警联动**（完成）：`alerts/service.ts` 的 `recordExternal` 写入 `status='event'`，异步 webhook/Bot 通知，不写 `alert_state`。
4. **Web**（完成）：`/minecraft` 双标签 + `LofiiPanel`（状态/任务/移动/聊天/事件/历史）、`AlertsCard` `event` 状态与 `lofii_*` 事件标签、`MetaContext` 消费 `lofiiEnabled/lofiiControlEnabled`。
5. **运维/安全**（完成）：`bootstrap-env.sh`、`deploy/env.example`、`sync-lofii-tokens.sh`、`smoke.ps1` Lofii 检查、systemd 独立服务前置说明。
6. **文档与验收**（完成本地部分）：本文件、README/AGENTS/CHANGELOG/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/AUDIT；生产部署/验收待 Lead 执行。

## 验收

- **本地（已完成）**：`npm run check` 通过；`npm test` 566（565 pass、1 skip）、`npm run test:web` 250（47 文件）；服务端覆盖率 93.06/78.67/88.70、前端 55.48/49.91/48.45（门禁通过）；`npm run build` 通过；`check-version` 严格模式通过（见 `docs/ACCEPTANCE.md` v0.8.0 节）。
- **生产（待执行，不得提前声明）**：
  1. Lead 部署 v0.8.0（schema v17 无迁移），`/healthz` 断言 `version=0.8.0`、`schemaVersion=17`。
  2. lofii-bot v0.6.0 已运行且仅 loopback；root 执行 `scripts/sync-lofii-tokens.sh`（先 `--check` 确认一致），再设 `LOFII_ENABLED=true` 重启。
  3. `GET /api/lofii/status` 登录后返回 `enabled=true/reachable=true/eventsSupported=true`；不可达/禁用/只读分支分别验证。
  4. `smoke.ps1 -ExpectedVersion 0.8.0 -ExpectedSchemaVersion 17 -ExpectedOpenCodeVersion 2.1.4 -ExpectedLofiiVersion 0.6.0`（未启用 Lofii 时 `-SkipLofii`）。
  5. 面板只读验证 + 任务/移动/聊天二次确认；不展示 Token/URL；告警历史出现 `status='event'`。
  6. 部署后备份、drill 与生产只读证据回填 `docs/ACCEPTANCE.md` 后，才声明验收通过。

## 非目标（本版不做）

- 不消费 Lofii SSE `/events`，不做浏览器直连/长连接面板。
- 不通过 `/say` 执行任何命令（含 `/` 开头内容一律拒绝）。
- 不把 Lofii 告警接入 firing/resolved 状态机，不实现恢复通知/冷却（上游负责）。
- 不持久化聊天/事件正文，不提供事件搜索/导出/长期历史。
- 不管理 lofii-bot 生命周期、不读取其 RCON/OpenCode 密钥、不修改其配置。
- 不支持多 Lofii 实例、多 Minecraft 服务器或多用户权限分离。
- 不把 Lofii 暴露到公网或 Cloudflare；不修改 nftables 对 3010 的 loopback 约束。

## 回滚

- **功能级**：`LOFII_ENABLED=false`（可选清空读/控制 Token）+ 重启；应用回到 v0.7.3 行为，`meta.lofii.event_cursor` 可保留（再次启用时按现存游标续接，或删除该 meta 键重建基线）；无 schema/DB 变更。
- **版本级**：`deploy.ps1` 回退上一 release；schema 仍 v17；旧版本忽略新增 `LOFII_*` env 与 `meta.lofii.event_cursor`。
- **控制面回滚**：清空 `LOFII_CONTROL_TOKEN` + 重启即变只读（`/say` 只读仍可用）；如需完全停止对 Lofii 的调用，设 `LOFII_ENABLED=false`。
- **数据**：本版不新增业务表/列；告警事件行（`status='event'`）按既有 90 天保留策略清理，不需要单独回滚。
