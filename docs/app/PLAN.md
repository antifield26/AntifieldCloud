# AntifieldComplexx v1.0.4 实施计划（当前状态）

本文件记录当前版本的范围、决策、非目标与回滚方式。版本演进见 `docs/app/ROADMAP.md` 与仓库根 `CHANGELOG.md`；完整验收证据见 `docs/app/ACCEPTANCE.md`；契约见 `docs/app/API.md`；界面见 `docs/app/UI-SPEC.md`。

> 项目定位：**个人综合交互平台**（统一入口整合个人数据/分享、Minecraft 与 mcbot、QQ chatbot、OpenCode AI、主机监控与备份灾备）。

## v1.0.4 当前状态（热修复，待部署）

- **版本**：**v1.0.4**（统一版本轴，待部署）；schema **v18**；OpenCode **v2.2.0**；mcbot **v1.0.4**（仅版本对齐，契约 v1）。
- **范围**：QQ Bot access_token 端点修正为 `bots.qq.com`；备份 ack 清除历史错误，Dashboard/列表忽略已 ack/已删除归档错误。
- **状态**：生产当前 v1.0.3；本地门禁通过，部署与 smoke 待执行。
- **边界**：无 schema/API/安全边界变更；不修改 Minecraft/OpenCode/frpc/SSH 配置。
- **测试基线**：`npm run check`（含 `check:docs`）通过；app **593**（592 pass、1 skip）+ web 273 + mcbot 122；`build`/`check-version`（严格 1.0.4）/`check:naming` 通过。

## v1.0.3 已部署状态（历史）

- **版本**：**v1.0.2**（统一版本轴，生产已部署）；schema **v18**；OpenCode **v2.2.0**；Node.js **v26.12.1**；mcbot **v1.0.2**（契约 v1）。
- **状态**：v1.0.2 **已部署生产（2026-10-28）**：app release `/opt/antifieldcloud/releases/20261028T085429Z`（1.0.2/schema18/OpenCode 2.2.0）、mcbot release `/opt/mcbot/releases/20261028T091246Z`（1.0.2，自主模式已启用，仅主人显式启动）；完整 Access smoke 36/0/1/2（含 Windows 任务标记 1.0.2；WARN=恢复演练 schema17）；已补发 Tag/Release `v1.0.2`。
- **测试基线**：`npm run check` 通过；app 591（590 pass）+ web 273 + mcbot 108；服务端覆盖率 93.10/78.89/88.86、前端 56.27/51.88/49.16；`build`/`check-version`（严格 1.0.2）/`check-naming` 通过。
- **迁移**：旧 env 前缀已迁移为 `CHATBOT_*`/`MCBOT_*`；上下文目录 → `/var/lib/antifieldcloud-chatbot-context`；`WEB_DIST_DIR` → `current/apps/workbench/web/dist`；DB schema v18 迁移不可逆（用快照回滚）。

## v1.0.1 范围

- 项目定位同步到运行时 UI/HTML/manifest/登录/设置/systemd 文案（“个人综合交互平台”）。
- npm workspaces 单仓库（`apps/workbench` + `apps/mcbot`），根包统一门禁与版本。
- chatbot 全量更名（模块/表/列/env/API/审计/meta）与 schema v18 迁移。
- 原 lofii-bot 全历史导入 `apps/mcbot` 并硬切换（服务/用户/路径/env/API）。
- mcbot 稳定性/AI 只读工具/守卫/护送/探索/深矿/分类存箱/自动补货与故障注入。
- 文档分区（app/mcbot/legacy）、迁移脚本、CI/命名/版本门禁。
- OpenCode 2.1.4→2.2.0 升级与兼容矩阵；版本/文档漂移修正。
- v1.0.2：mcbot AI 自主会话（OpenCode 原生 MCP 工具循环）、应用自主控制、mcbot 运维残余、Agentic 验收。

## v1.0.1 关键决策

| 项 | 决策 |
|---|---|
| 定位 | 个人综合交互平台；`workbench` 仅 Web 端技术名 |
| 架构 | npm workspaces 单仓库；双进程 workbench + mcbot，loopback HTTP 契约 v1 |
| 数据 | schema v18 一次性改名；历史迁移只追加；旧应用不可读，回滚用快照 |
| OpenCode | 2.2.0；应用使用原生 HTTP API + MCP，不使用 2.2.0 breaking 的 SDK/Action/TUI 插件面 |
| 命名 | chatbot/mcbot 硬切换，不做旧 API/env 别名 |
| 部署 | mcbot → 迁移 Apply → app → Verify/smoke；保留旧 release/env/DB 快照 |

## v0.8.1 历史范围（保留）

> 以下自“v0.8.1 历史内容”起均为 v0.8.1 及更早的计划与验收记录，不再代表当前版本；v1.0.0 当前事实以 README/AGENTS/ROADMAP/CHANGELOG/DEPLOY/ACCEPTANCE 为准。
### v0.8.1 历史内容

- **修复 SEC6-01（P1）/say 分块命令注入**：`POST /api/mcbot/say` 现在**必须启用控制 Token**（只读模式 `503 lofii_control_disabled`）；拒绝**任意位置 ASCII `/`**（含填充 240 字符后放在切分第二行的命令）与 C0 控制字符/DEL；上游 mcbot v0.6.1 的 `splitOutgoing` 逐行把行首 `/` 中和为全角 `／`（防御纵深，新增 239/240/255/480 边界测试）。
- **修复 SEC6-02/03/04（P2/P3）**：`mapmcbotAlert` 与前端标签查表改为 own-property（避免 `__proto__`/`constructor` 命中原型链）；`sanitizeDetails` 跳过原型键；`/history` 校验 `kind`/数组/行形状并只透传对象行；`mcbotClient` 响应改为**流式** 2 MiB 上限（不再先 `arrayBuffer()` 后检查）；Token 脱敏大小写不敏感；事件缓存增加 512 KiB 总字节上限；上游轮询 `recent` 改为 200 条。
- **修复 ARCH/DBG 健壮性**：前端 `safemcbotStatus` 归一化缺失嵌套段；`/status` 可达但 `events`/游标失败时显示可见警告；`eventsSupported` 对 `undefined` 正确回退；`mcbotPanel.load` 请求序号 + Abort 防旧响应覆盖；`mapmcbotAlert` 5 种已知类型/未知类型均安全；上游 5xx 的明确业务码 `task_disabled`/`control_disabled`/`history_disabled` 保留为 `lofii_*`；告警写入失败时游标停在上一条已处理事件并在下一轮重试；`taskId` 拒绝纯空白/控制字符/内部空白；`MCBOT_URL` 拒绝 userinfo/路径/查询/片段；`sync-mcbot-tokens.sh` 改为同目录临时文件 + `mv` 原子替换。
- **版本/文档**：AntifieldComplexx 0.8.1（`package.json`/lock/`deploy/env.example`）；README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/AUDIT 同步；schema/OpenCode 工具版本不变。
- **明确残余（本轮不修）**：告警事件无幂等键（schema v18 下一 minor）；告警风暴并发 webhook/Bot 上限；mcbot 进程未纳入 `service_down` 监控/metrics；`/status`/`history` 的 `lastError` 原样透传（admin-only）；`MCBOT_URL` 允许任意 loopback 端口；`stop()` 不取消在途轮询；真实 mcbot 告警未触发；**v0.8.1 已发布 Tag+Release**。详见 `docs/app/AUDIT.md` v0.8.0 Minor 补审计节。

### v0.8.1 关键决策

| 项 | 当前决策 |
|---|---|
| 对接方式 | 服务端低频轮询 `/status` + `/events/recent?limit=200`，不消费 SSE、不让浏览器直连 mcbot；默认 `MCBOT_POLL_MS=5000`（2000–60000） |
| 上游契约 | mcbot **v0.6.1**（最低 v0.6.0）、`contractVersion=1`；`/events/recent` 404（旧版）只置 `eventsSupported=false`，`/status` 继续可用 |
| Token | 读 Token 用于 `/status`、`/events/recent`、`/history`；控制 Token 用于 `/task/*`、`/move`、`/say`；控制 Token 为空 = 只读，控制接口与 `/say` 均 503 `lofii_control_disabled` |
| 聊天安全 | `/say` 只聊天、不执行命令：任意 ASCII `/` 拒绝、C0 控制字符/DEL 拒绝、720 字符上限；上游逐行中和 `/` 为防御纵深；审计只记字符数 |
| 网络边界 | `MCBOT_URL` 启用时必须 loopback + http(s) 且仅根地址（拒绝 userinfo/路径/查询/片段）；客户端 `redirect:'error'`、流式 2 MiB 上限、超时统一 `lofii_unavailable`，错误文本大小写不敏感脱敏 |
| 告警语义 | 外部事件 `status='event'`，不写 `alert_state`、不产生 firing/resolved；已知 5 类映射固定 severity，未知类型 `error→critical` 否则 warning；event 名 `lofii_<type>`（未知 `lofii_alert`） |
| 告警游标 | `meta.lofii.event_cursor={bootId,lastEventId,lastTs}`；首次/无游标/`bootId` 变化只建基线不重放；告警写入失败停游标并在下一轮重试；`MCBOT_ALERTS_ENABLED=false` 仍推进游标 |
| 数据/隐私 | 聊天与事件只进内存缓存（最多 100 条且 ≤512 KiB），不落库、不写日志；`/say` 审计只记字符数；历史校验形状后透传只读对象行 |
| Web | `/minecraft` 合并双标签；mcbot 未启用不显示标签；禁用/不可达/过期/部分失败/控制未启用分别有降级文案；状态归一化、轮询防竞态；不展示 Token/地址/内部路径 |
| schema | 保持 **v17**，无迁移；仅 `meta` 键 `lofii.event_cursor` |
| 默认状态 | `MCBOT_ENABLED=false`、读/控制 Token 为空；升级/回滚不影响既有功能 |
| 部署顺序 | 先升级 mcbot 到 v0.6.1（仅 loopback）→ root 同步 Token、核对 `--check` → 部署 AntifieldComplexx 0.8.1 → `MCBOT_ENABLED=true` 重启 → `/api/mcbot/status`、`/say` 只读 503、任意 `/` 400 与 smoke（`-ExpectedMcbotVersion 0.6.1`）验证 |
| 回滚 | `MCBOT_ENABLED=false` + 重启即停用 mcbot；版本回退上一 release；schema 不变、无 DB 回滚 |

### v0.8.1 架构与数据流

```text
浏览器 /minecraft?tab=lofii
  └─ GET /api/mcbot/status（5s 轮询） / history / POST tasks|move|say
       └─ 应用（127.0.0.1:3000，登录 + CSRF + 限流 + 控制 Token）
            ├─ mcbotService：单飞轮询 /status + /events/recent?limit=200 → 内存快照/事件缓存（≤100 条/≤512 KiB）
            ├─ 告警游标 meta.lofii.event_cursor → AlertService.recordExternal(status='event')；失败停游标重试
            └─ mcbotClient（读/控制 Token、redirect:error、2.5s 超时、流式 2 MiB 上限、大小写不敏感脱敏）
                 └─ HTTP → mcbot（127.0.0.1:3010，Minecraft 附属服务，仅 loopback）
```

- 轮询成功：更新 `statusSnapshot`、`version`、`contractVersion`、事件缓存；失败：只更新 `reachable/stale/error`，保留旧数据；`reachable=true` 且 `error≠null` 时前端显示部分失败警告。
- 事件合并：按 `id` 去重、newest-first、最多 100 条且序列化总字节 ≤512 KiB；`/events/recent` 404 时 `eventsSupported=false`。
- 告警：`advanceCursor` 过滤 `type='alert'` → `mapmcbotAlert`（own-property 查表，清洗 details 深度/键数/数组/字符串长度并跳过原型键）→ `recordExternal`（异步 webhook + Bot 通知）；写入失败停在上一条已处理事件并在下一轮重试。
- 控制：成功即 `refresh()` 拉一次最新状态；`/say` 使用控制 Token，只读模式 503。

### v0.8.1 阶段

1. **安全审计与修复**（完成）：三轨审计（架构对抗/安全/Debug）发现 P0=0；P1=1（`/say` 分块命令注入）已修复；P2=2（原型链/形状 + 面板崩溃）已修复；P3 多数加固已修复，残余见 AUDIT。
2. **服务端加固**（完成）：`client.ts`（流式 2 MiB、5xx 稳定码、大小写不敏感脱敏、history 形状）、`service.ts`（512 KiB 缓存、poll 200、游标失败重试、原型键清洗）、`routes/lofii.ts`（`/say` 控制 Token + 任意 `/` + C0、taskId 校验）、`config.ts`（`MCBOT_URL` 根地址限制）、`sync-mcbot-tokens.sh`（同目录临时文件 + `mv`）。
3. **Web 加固**（完成）：`safemcbotStatus`、`eventsSupported` 回退、部分失败警告、请求序号 + Abort、own-property 标签查表、`/say` 任意 `/` 拒绝、历史形状错误可见。
4. **上游 mcbot v0.6.1**（完成，另行提交）：`splitOutgoing` 逐行中和行首 `/`，新增 239/240/255/480 边界测试。
5. **测试/门禁**（完成）：`npm run check`、`test:coverage`、`test:web:coverage`、`build`、`check-version`（0.8.1）通过；新增/扩展 mcbot 回归测试。
6. **文档与验收**（完成）：本文件、README/AGENTS/CHANGELOG/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/AUDIT；生产部署、smoke、已认证 API 与安全回归已由 Lead 在 0.8.1 上执行并回填。

### v0.8.1 验收

- **本地（v0.8.1 已完成）**：`npm run check` 通过；`npm test` 572（571 pass、1 skip）、`npm run test:web` 256（48 文件）；服务端覆盖率 93.04/78.77/88.67、前端 55.83/51.29/48.66（门禁通过）；`npm run build` 通过；`check-version` 严格模式通过；`/say` 回归覆盖只读 503、任意 `/`、C0、240 字符切分边界（见 `docs/app/ACCEPTANCE.md` v0.8.1 节）。
- **生产（v0.8.1 已实测，2026-10-27）**：
  1. 应用部署 release `/opt/antifieldcloud/releases/20261027T113055Z`/commit `5405a8d`，`/healthz` v0.8.1/schema17（uptime/DB ok）；迁移前快照 `db-predeploy-20261027T113130633Z.sqlite`（sha256 `d16e15c3…1bd991a`）；上一生产 v0.8.0 保留为回滚点。
  2. 部署内只读 smoke **26/0/0/2**；完整 Access smoke **36/0/0/2**（**含本地任务标记检查，无 `-SkipLocalTaskCheck`**；期望 0.8.1/schema17/OpenCode 2.1.4/mcbot 0.6.1；此前两次失败为 Cloudflare 隧道瞬断，恢复后全绿）。
  3. mcbot v0.6.1（release `20261027T111640Z`/commit `a0a28da`）仅 loopback，Token `--check` read/control 均 match；`meta.lofii.event_cursor` 已更新。
  4. 已认证 API：`/api/version` 200（v0.8.1、lofii 两开关 true）；`/api/mcbot/status` 200（enabled/reachable/control/eventsSupported=true，version 0.6.1/contract 1）；`/say` 240 填充+`/op` 400、C0 400；临时会话已删（0）；审计无 `lofii.say`、`alert_events` `lofii_*` 仍 0；journal 无 error/0 条 64hex、env 0640、`systemctl --failed` 空。
  5. **UI 未在 v0.8.1 重新截图**（v0.8.0 视觉确认仍有效）；只读 `/say` 503 仅单测/集成覆盖（生产控制 Token 已配置，未改配置实测）。
- **生产边界（不得写成已完成）**：真实 mcbot 告警未触发（单元/集成覆盖，`alert_events` 暂无 `lofii_*`）；**v0.8.0 已发布 Tag+Release**（Tag `v0.8.0`→commit `c5ec851`，publishedAt `2026-10-27T12:02:45Z`）；**v0.8.1 已发布 Tag+Release**（Tag `v0.8.1`，GitHub Release 2026-10-27）。

### v0.8.1 非目标

- 不消费 mcbot SSE `/events`，不做浏览器直连/长连接面板。
- 不通过 `/say` 执行任何命令（任意 ASCII `/` 一律拒绝）。
- 不把 mcbot 告警接入 firing/resolved 状态机，不实现恢复通知/冷却（上游负责）；不新增告警幂等键（schema v18 下一 minor）。
- 不持久化聊天/事件正文，不提供事件搜索/导出/长期历史。
- 不管理 mcbot 生命周期、不读取其 RCON/OpenCode 密钥、不修改其配置；不把 mcbot 进程纳入 `service_down`（列残余）。
- 不支持多 mcbot 实例、多 Minecraft 服务器或多用户权限分离。
- 不把 mcbot 暴露到公网或 Cloudflare；不修改 nftables 对 3010 的 loopback 约束。

### v0.8.1 回滚

- **功能级**：`MCBOT_ENABLED=false`（可选清空读/控制 Token）+ 重启；应用回到仅 v0.8.1 其它行为，`meta.lofii.event_cursor` 可保留（再次启用时按现存游标续接，或删除该 meta 键重建基线）；无 schema/DB 变更。
- **控制面回滚**：清空 `MCBOT_CONTROL_TOKEN` + 重启即变只读（`/say` 也随之为 503）；如需完全停止对 mcbot 的调用，设 `MCBOT_ENABLED=false`。
- **版本级**：`deploy.ps1` 回退上一 release（v0.8.0）；schema 仍 v17；旧版本忽略新增 `MCBOT_*` env 与 `meta.lofii.event_cursor`。
- **数据**：本版不新增业务表/列；告警事件行（`status='event'`）按既有 90 天保留策略清理，不需要单独回滚。
