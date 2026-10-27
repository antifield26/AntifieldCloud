# 路线图

## v0.8.0（生产部署与只读/API 验收已完成 2026-10-27，待 Tag/Release 收尾；Lofii Bot 只读/控制/告警对接 + `/minecraft` 合并标签；schema 保持 v17；OpenCode v2.1.4）

- **范围**：服务端轮询独立 Lofii Bot（仅 loopback `127.0.0.1:3010`，lofii-bot v0.6.0 契约 v1）的 `/status` 与 `/events/recent`，缓存快照与最近 100 条事件；`GET /api/lofii/status|history` 与 `POST /api/lofii/tasks|tasks/stop|tasks/resume|move|say`；7 种任务、4 种移动、游戏内聊天；读/控制 Token 分离，控制 Token 为空即只读。
- **告警**：上游 `alert` 事件映射为 `status='event'` 历史事件（不写 `alert_state`、不参与 firing/resolved）、游标 `meta.lofii.event_cursor`（首次/重启不重放）、复用 webhook/Bot 通知；`LOFII_ALERTS_ENABLED` 默认 true。
- **Web**：`/minecraft` 改为「服务器 / Lofii」双标签（键盘可操作、`?tab=lofii`/`#lofii` 深链）；Lofii 面板含状态/任务/移动/聊天/事件流/历史，开始/停止/恢复/发送二次确认，禁用/不可达/过期/只读分别降级；不展示 Token/地址。
- **安全/部署**：上游仅 loopback、`redirect: 'error'`、超时、2 MiB 响应上限、错误脱敏；全部接口需登录，写操作 CSRF + IP 限流（控制 20/min、聊天 10/min）；审计不含聊天正文；`LOFII_*` env、`scripts/sync-lofii-tokens.sh`、`bootstrap-env.sh`、`deploy/env.example`、`smoke.ps1 -ExpectedLofiiVersion 0.6.0`/`-SkipLofii`；schema 无迁移。
- **状态**：本地实现与门禁完成（2026-10-27：`npm run check` 通过；`npm test` **566**（565 pass、1 skip）、`test:web` **250**（47 文件）；覆盖率 93.06/78.67/88.70 与 55.48/49.91/48.45 门禁通过；build 通过）。**生产部署与只读/API 验收已完成（2026-10-27）**：release `/opt/antifieldcloud/releases/20261027T094412Z`/commit `9ae5809`，`/healthz` v0.8.0/schema17，部署内只读 smoke **26/0/0/2**、完整 Access smoke **35/0/0/2**（`-SkipLocalTaskCheck`）；lofii-bot v0.6.0 release `20261027T092737Z` 已部署且仅 loopback，`LOFII_ENABLED=true`、Token 匹配、`meta.lofii.event_cursor` 已建立；生产 API 探针 status/version/history、CSRF 403、patrol start/stop 与审计已验证。**尚未 Tag/Release（待收尾）**；生产 UI 视觉确认待用户浏览器复核；真实 Lofii 告警联动未触发（单元/集成覆盖）；Windows 每日备份任务标记待用户重装 `install-backup-task.ps1` 刷新（非失败）。

## v0.7.3（已发布：Tag `v0.7.3` + GitHub Release [AntifieldCloud v0.7.3](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.7.3)；已部署生产并完成读范围/QQ 正向验收；Bot 提示词文档化 + 按需 read；schema 保持 v17；OpenCode v2.1.4）

- **范围**：角色卡只在会话创建时发送；后续轮不再发送角色卡/记忆正文，只给角色名/条数/只读文档路径；新增 `BotContextStore`（scope 哈希目录、原子写、清理/sweep）；OpenCode 会话仅放行当前作用域 `role.md`/`memory.md` 的 `read`；`BOT_AI_CONTEXT_READ_ENABLED`（默认 false）/`BOT_CONTEXT_DIR`；权限拒绝 fail-closed；群角色变更重置共享会话；`/reset`、`/forget`、Bot/目标删除清理文档。
- **安全/部署**：生产目录 `/var/lib/antifieldcloud-context`（`antifieldcloud:opencode` 2750）；systemd `ReadWritePaths`；读范围矩阵（正向/越权/注入/群私聊隔离）作为发布门禁；上下文目录不入备份。
- **状态**：本地实现与门禁完成（`npm test` 521/1 skip、`test:web` 222、服务端覆盖率 92.93/78.37/88.55）；生产 release `20261027T060134Z`/commit `aedc3c7`（schema17；完整 Access smoke 34/0/0/2；读范围矩阵 7/7 通过；真实 QQ 私聊首轮/后续与群聊首轮通过；drill `20261027T061319Z` 通过）；文档模式已显式启用 `mcp:send:read:aad221f1`；Tag `v0.7.3` + GitHub Release 已发布，Windows 备份任务标记已刷新到 0.7.3。

## v0.7.2（已发布：Tag `v0.7.2` + GitHub Release；D-18 收口；schema v17；OpenCode v2.1.4）

- **范围**：审计失败持久化（schema v17）、Bot 记忆镜像孤儿清理、Web 导入归档 90 天保留、告警 24h 重通知、备份锁心跳、DR-1 `clockSkew`、BotService 拆分（targets/roles-admin/memory-admin）、平台/模型负路径测试；Cloudflare `ai` Access、SSH 回滚窗口清理、Windows 世界拉取任务、rclone 安装。
- **明确不改造**：单进程/HA、内存限流、同步维护、SQLite `synchronous=NORMAL`、单 SD/LUKS、NOPASSWD sudo、RCON 监听、Cloudflare 明文、真实平台负路径（只补夹具）等继续作为明确残余。
- **状态**：本地实现与门禁完成（`npm test` 497、`test:web` 222、服务端覆盖率 92.85/78.35/88.11）；生产 release `20261025T132950Z`/commit `eb74382`（schema17；部署内 smoke 24/0/1/2、完整 Access smoke **33/0/0/2**；drill `20261025T133743Z` schema17 通过）；Tag `v0.7.2` + GitHub Release 已发布；备份加密/异地副本保持关闭（用户确认不配置 remote）。

## v0.7.1（已发布：Tag `v0.7.1` + GitHub Release；群聊共享会话；schema 保持 v16；OpenCode v2.1.4）

- **范围**：同一群聊目标的所有成员复用唯一 OpenCode Chat 会话，模型可见群内多用户历史；群内 Chat 批次/命令按目标串行，避免并发写同一会话；私聊保持每用户独立会话；真实用户仍用于限流、记忆/审计/发送工具令牌。
- **兼容**：首次使用群共享会话时清理旧版按用户拆分的群会话映射并尽力删除远端旧会话；无 schema 迁移。
- **状态**：本地实现与测试完成；已部署生产 release `20261025T031856Z`/commit `d8bdfc5`（部署内 smoke 23/23、完整 Access smoke 33/0/0/2；启动后旧分用户群映射清零；真实 Bot Test 群两个成员进入同一共享会话，用户确认验收通过）；Tag `v0.7.1` + GitHub Release 已发布；废弃 env 键已清理，Windows 任务标记 0.7.1/脚本 SHA 一致并手动运行成功。

## v0.7.0（已发布：Tag `v0.7.0` + GitHub Release；审计修复 + 备份整包加密 + 异地副本默认关闭；schema 保持 v16；OpenCode v2.1.4）

- **范围**：第六轮深度审计全部处置（P0=0/P1=3/P2=26/P3=73；P1/P2 全修，P3 可修小项随版修、架构性/已接受项写明确残余）；备份归档可选独立 age 整包加密（Web 不持私钥、`.age` 在 Web 一律 `409 archive_encrypted`、失败关闭、2× 空间、sidecar 元数据外置）；PC 端异地副本（只上传 `.age`、链感知保留、状态回写 Pi + `offsite_overdue` 告警）；Bot 工具隔离 fail-closed、群共享记忆归属 `member_openid`、D-16 行为保持重构；审计策略 best-effort（D-17）；真实域名/网段占位符化（OPS-07）；主机配置模板（OPS-09）；OpenCode 2.1.4 升级/回滚门禁。
- **明确不做/记录**：`BotService` 进一步拆分（ARCH-01 剩余）、单进程/`synchronous=NORMAL`、平台 mock-only 负路径、`__Host-`/SSO IP 绑定/scrypt/`http-proxy` 等既有 P3（见 `docs/AUDIT.md` 第六轮 §5/§9 与 `docs/SECURITY.md` §4）。
- **状态**：本地实现、门禁与文档同步完成；**生产应用已部署 v0.7.0**（最终 release `20261025T021609Z`/commit `4f40ccd`，`/healthz` v0.7.0/schema16；部署内 smoke 23/23、完整 Access smoke 31/0/1/2；D-20 连续外发 1000ms 与 DSML 原始工具调用回显修复均已部署，生产探针验证）；OpenCode v2.1.4（V1–V9/V14 通过，V10–V13 由用户真实 QQ 验收）；**Tag `v0.7.0` + GitHub Release 已发布**（2026-10-25 用户验收通过）。schema v16 无迁移；加密/异地默认关闭，启用顺序与回滚见 `docs/BACKUP.md` §5.1/§5.2、`docs/DEPLOY.md`。

## v0.6.6（已发布：Tag `v0.6.6` + GitHub Release；系统提示词精简 + 群聊用户名 head + 群聊共享记忆 + 记忆两栏/迁移；schema 保持 v16）

- **范围**：精简 Bot 系统提示词与发送工具说明；群聊用户消息加 `<用户名>：` head；群聊提示词声明所处环境，未 @ 消息默认沉默、不要求每轮调用发送工具；群聊使用独立共享记忆（`<用户名>：<记忆>`），成员用户级记忆不进入群聊；群聊抽取按发言用户归属；`/bots` 长期记忆分用户记忆/群聊记忆两栏并迁移现有群聊参与者记忆。
- **状态**：生产 release `20261024T100522Z`/commit `1f6980e`（v0.6.6/schema16，部署内 smoke 16/16、完整 Access smoke 24/24）；annotated Tag `v0.6.6` + GitHub Release [AntifieldCloud v0.6.6](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.6.6)。

## v0.6.5（已发布：Tag `v0.6.5` + GitHub Release；生产 release `20261024T085435Z`/commit `c48ea8a`；Bot `/role show` 角色卡详情；schema 保持 v16）

- **范围**：`/role show` 在用户设置过私聊角色卡时展示完整角色设定文本；默认角色卡 `lofii` 只返回名称，不展示内置详情；失效 AI 会话映射自动清理并重建一次，避免群聊未登记用户持续 `bot_ai_http_error`。
- **状态**：生产 release `20261024T085435Z`/commit `c48ea8a`（v0.6.5/schema16，部署内 smoke 16/16、完整 Access smoke 24/24）；已发布 annotated Tag `v0.6.5` + GitHub Release。

## v0.6.4（已发布：Tag/Release v0.6.4；多用户内测验收通过；已知问题复核 + 消息发送工具 + 全量群聊合并 + 会话命名；schema 保持 v16）

- **范围**：复核并处理项目记录的已知问题和遗留事项；群聊全量消息延长连续消息合并等待；`NO_REPLY` 升级为 `botmsg_send_message` 工具（私聊/@ 每轮至少调用一次，全量群聊不调用即静默）；新建 Chat/Memory 会话按目标名称命名。
- **决策**：工具经 OpenCode MCP 回调本机应用，`BOT_SECRET_KEY` HMAC 的 turn token 鉴权，缓冲后统一发送；全量群聊非 @ 默认 8s/20s 合并；SSO ticket 绑定 UA、记忆过滤补充模式；`__Host-` Cookie 与 SSH/sudo 等列为明确保留。
- **状态**：已发布生产 release `20261024T065245Z`/commit `63792a7`（v0.6.4/schema16，部署内 smoke 16/16、完整 Access smoke 24/24；`/help` 仅命令列表；校园网 Portal 认证恢复后 cloudflared active；`botmsg` MCP connected）；多用户内测用户验收通过（2026-10-24）；annotated Tag `v0.6.4` + GitHub Release [AntifieldCloud v0.6.4](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.6.4)。

## v0.6.3（已发布：Tag/Release v0.6.3；群聊独立角色卡 + 群消息模式 + 全量消息 + 群聊禁用命令；schema v16）

- **范围**：群聊目标独立共享角色卡；“仅 @/名字提及”（默认）与“全部消息由模型决定”（实验性）两种群消息模式；`GROUP_MESSAGE_CREATE` 全量事件与 `NO_REPLY` 静默；群聊/频道禁用斜杠命令。
- **决策**：每群一张共享卡；群聊+频道都禁用命令；全量消息需 QQ 后台开启“接收所有消息”、订阅 `GROUP_MESSAGE_CREATE`，群主将机器人可获取消息范围设为“获取群内全部消息”，模型输出 `NO_REPLY` 不发送。
- **状态**：已发布，生产 release `20261023T142411Z`/commit `7ac1d27`；smoke 24/24、drill schema16 通过；用户 2026-10-23 23:09 CST 验收通过。

## v0.6.2（已发布：Tag/Release v0.6.2；目标名称编辑 + 测试消息辨识 + 入站查重 + 投递与发布单列）

- **范围**：Bot“投递与发布”主网格双列改单列；目标名内联编辑；目标行“测试”按钮向指定目标发送测试消息；最近入站目标按已配置 externalId 查重隐藏。
- **决策**：手填 QQ 号/群号功能回滚；schema v15 的 `qq_number` 列保留为兼容列（API/发送不使用）；迁移不可逆，回滚需迁移前快照。
- **状态**：生产 release `20261023T123055Z`/commit `77e42c7`，smoke 16/16 + 24/24，用户验收通过并发布。

## v0.6.1（已发布：Tag/Release v0.6.1；Bot 连续消息 + SearXNG MCP 联网搜索 + 备份状态 hotfix）

- **发布状态**：annotated Tag `v0.6.1` + GitHub Release；生产最终 release `20261023T094819Z`/commit `ceb2e8f`（v0.6.1/schema 14），用户 2026-10-23 17:32 CST 实发复测通过、17:56 CST 确认 `/help` 简化并发布。
- **连续消息**：同一 Bot×目标×用户 burst 合并 + 同会话串行；Webhook 立即 ack、最终只回复一次；默认窗口 3000ms/最长 10000ms/上限 10 条；`/reset`/`/forget` 清缓冲；不同会话并行。
- **联网搜索**：自建/私有 SearXNG（loopback JSON API）+ OpenCode MCP 工具 `searxng_web_search`（codemode=false）稳定自动触发；`/search` 命令服务端强制预取；Bot 会话仅放行 `searxng_*`，其余工具 deny；结果标题/摘要/域名注入提示词，回答末尾附来源；不抓网页、不记录查询正文；失败降级、限流、不可信外部资料边界；`prefetch` 关键词模式保留为回退；配置 `BOT_SEARCH_*`。
- **备份状态 hotfix（预部署）**：acked 归档 `status=acked` + `available=false`，Dashboard/备份页不再误报文件缺失；`/api/auth/me` 补清旧父域 Cookie；生产 25 个 acked 归档与用户复核通过。
- **数据/版本**：schema v14 无迁移；新增配置无 schema；本地/CI 门禁、SearXNG 生产只读验证、smoke 24/24 与真实 QQ 用户验收均已完成；待用户确认后 Tag/Release。

## v0.6.0（已部署并验收通过；质量/安全加固，schema 保持 v14 + OpenCode v2.1.3）

- **定位**：Minor 版本的质量/安全加固，不新增功能主线；第五轮多切入点审计的 P0–P2 全部修复，P3 记录。
- **安全/认证**：QQ op=13 严格校验 + 审计（P1）；app/ai host-only Cookie + 一次性 AI SSO ticket（不再父域共享）；app API/公开 unlock Origin 只信 app（+ loopback）；公开端点大 body 收口；SSO ticket 日志脱敏。
- **数据/灾备**：密钥包 opencode 快照硬失败；多 pending ack 缺失集合合并；恢复按 tar 实测字节预检；legacy ops=0 不误标；世界备份 `kept/keptCount`、演练真实字段/schema 检查、恢复 `skippedMissing` 展示。
- **Bot**：wait 回退只取本轮新回答；记忆 key/value/legacy 敏感过滤；发布 >2000 明确 400；工具隔离降级可审计/可查（`aiToolIsolation`）；op=13 成功审计。
- **OpenCode**：v2.1.2 → **v2.1.3**（先升级并验证，v0.6.0 部署不重复操作）。
- **版本/数据**：version 0.6.0，schema **v14**（无迁移）；`deploy.ps1` 期望 schema 14；回滚可切回 v0.5.11（同 schema，建议清理站点 Cookie）。
- **状态**：`npm run check` 通过；`npm test` **383**、`npm run test:web` **176**（32 文件）；服务端覆盖率 Lines **92.39%** / Branches **77.83%** / Functions **87.14%**、build 通过；已部署最终 release `20261023T053539Z`/commit `6349617`（healthz v0.6.0/schema14，smoke 16/16 与 24/24、drill schema14、备份/密钥包已拉取、用户验收通过）；Tag/GitHub Release 见发布记录。
- **下一版**：企业微信/钉钉/飞书、多管理员审批（范围待用户确认）。

## v0.5.11（历史，已部署并验收通过；用户实发 2026-10-23 10:39 CST；结构化记忆系统 + schema v14）

- **结构化长期记忆**：7 类条目（profile/preference/fact/project/task/relationship/episode），字段 key/value/confidence/importance/source/时间/expires_at，唯一键 `(bot,user,kind,key)`；迁移 14 新增 `bot_memory_items`/`bot_memory_state`，旧 `bot_ai_memories` 保留为 legacy 来源。
- **抽取**：3 条/空闲 120s 批处理 + 同用户串行；一次性 OpenCode 会话（用后删除）；严格 JSON operations（upsert/delete，最多 20 条）；服务端敏感过滤/容量清理（200 条）；TTL：profile/preference 不过期、fact/project 365、episode 90、task 30，更新续期；审计 `bot.memory.extract` 只计数。
- **召回**：核心 profile/preference/task 优先，其余按关键词 + 重要度/时效；预算 3000 字/12 条；`/memory off` 无注入；未迁移旧摘要 fallback 注入。
- **自助/管理**：`/memory`（计数/类型/启停/最近更新，不含 key/value；`off|on`）；`/forget confirm` 清空 items/state/legacy/会话；管理 API 用户级/条目元数据/单条删除/整用户删除（绝不返回 key/value）。
- **Legacy**：旧摘要一次性 LLM 转换后标记；验收后 `node scripts/cleanup-legacy-memory.mjs`（默认 dry-run，`--confirm` 删除已迁移用户旧摘要行+镜像）。
- **版本/数据**：version 0.5.11，schema **v14**（迁移 14，不可逆；v0.5.10 不支持 v14，回滚必须恢复迁移前快照）；`deploy.ps1` 期望 schema 14；生产 env 新增 5 个 `BOT_MEMORY_*`。
- **状态**：已部署 v0.5.11/schema v14（最终 release `20261023T022831Z`/commit `931b10d`，迁移 14 不可逆；早前同版本 release `20261023T021339Z`/`20261023T014328Z` 保留；healthz v0.5.11/schema 14，smoke 16/16 与 24/24；env 5 个 `BOT_MEMORY_*`、运行配置 365/3/120/3000/12/90/30）；**用户实发验收通过**（2026-10-23 10:39 CST：三条 Chat → `bot.memory.extract` rounds=3 ops=2、`/memory`、`/forget confirm` items=2 legacy=0；早前 off/on 与面板用户确认；legacy 清理 users=0 files=0）；测试基线 `npm test` **360**（341+19）、`npm run test:web` **162**（30 文件，+5）；覆盖率 Lines **92.05%** / Branches **77.43%** / Functions **86.39%**、`npm run build` 通过。
- **下一版**：企业微信/钉钉/飞书、多管理员审批（范围待用户确认）。

## v0.5.10（历史，已部署并验收通过；用户实发 2026-10-22 23:26–23:29 CST；v0.5.11 起升级 schema v14）

- **记忆与会话修复**：摘要会话一次性（新建远端会话并在 `finally` 删除，不再保存 `summary_session_id`，列保留兼容）；记忆更新按 Bot×用户串行队列避免并发覆盖；
  合并策略=累计 `BOT_AI_MEMORY_BATCH_MESSAGES=3` 条或空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120` 触发，审计 `bot.ai.memory` 增加 `rounds`；
  `/reset`、`/forget confirm`、角色卡变更（含管理员删除角色）尽力删除远端会话与旧摘要会话。
- **保留期分离**：AI 会话 7 天（`BOT_AI_SESSION_RETENTION_DAYS`）与长期记忆 `BOT_AI_MEMORY_RETENTION_DAYS=365`（30–3650）独立。
- **移除代理隧道依赖**：删除 `scripts/discord-tunnel.ps1/.vbs`、`scripts/install-tunnel-task.ps1` 与 PC 计划任务 `AntifieldCloudDiscordTunnel`；删除 `BOT_PROXY_URL`；
  生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`（空值）；连通性仅探测外网 + QQ 平台（Pi 直连），快照去掉 `deviceOnline`/`proxy`。
- **数据/部署**：version 0.5.10，schema 保持 v13（无迁移）；`deploy.ps1` 无需改；回滚切回 v0.5.9 release 并恢复 env（含代理变量与旧隧道脚本/计划任务，如需）。
- **状态**：已部署 v0.5.10/schema v13（2026-10-22 23:20–23:23 CST，release `20261022T152053Z`/commit `4619c91`，无迁移；上一 release `20261022T143451Z` 保留；`/healthz` v0.5.10/schema 13，smoke 16/16 与 24/24；env 实测 3 记忆变量就位、代理变量/`BOT_PROXY_URL` 均无；无代理直连 QQ `checkBot` ok、连通性日志仅 internet/QQ；PC 隧道任务/进程已移除、无 18090 监听；bundle `index-Bx6EBCIp.js` 含“Pi 直连”，不含“代理端口/设备在线”）；
  本地测试基线（Lead 实测）`npm test` **341**（v0.5.9 的 333 + 新增 8 个 v0.5.10 用例）、`npm run test:web` 157（30 文件）、`npm run typecheck` 通过；覆盖率 Lines **91.98%** / Branches **76.92%** / Functions **85.99%**、build 通过；**用户已实发验收通过**（2026-10-22 23:26–23:29 CST：合并摘要 rounds=3、远端会话删除 404 两例、图片 145172 B 有服务端证据；`/bots` 卡片用户确认）。
- **下一版**：v0.6 候选（企业微信/钉钉/飞书、多管理员审批），范围待用户确认。

## v0.5.9（历史，已部署并验收通过；用户实发 2026-10-22 22:39–22:41 CST；v0.5.10 起移除代理隧道依赖）

- **移除 `/ask`**：`BOT_COMMANDS` 删除 `ask`（现为 `/help /status /backup /world /mc /files /role /reset /forget`）；`/ask` 作为未知命令——非管理员被拒（无回复），管理员回全量帮助、不调用 AI；
  斜杠命令不再触发 AI。
- **AI 仅普通消息 Chat**：提示词固定为「角色卡（个人卡或 lofii）+ 固定只读安全边界 + 长期记忆 + 用户」，`BotAiMode`/task 提示词与 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 移除；
  `bot_ai_sessions.mode` 列保留只写 `chat`；`/reset` 与角色卡变更清理该范围全部会话映射；审计 `bot.ai.chat` 不再记录 `mode`。
- **限速宽松档**：`BOT_CHAT_RATE_PER_MINUTE=30`（1–120）、`BOT_AI_RATE_PER_HOUR=120`（1–600）、`BOT_COMMAND_RATE_PER_MINUTE=120`（1–600）。
- **`/help` 自助且动态**：对所有用户开放；非管理员仅 `/help /role /reset /forget confirm` + Chat 说明（不暴露管理命令），管理员全量（无 `/ask`）；未知命令按身份回帮助/被拒。
- **数据/部署**：version 0.5.9，schema 保持 v13（无迁移）；`deploy.ps1` 期望 schema 13；生产需 env 迁移（限速值 + 删除两个提示词变量）后重启；回滚还原旧 env 值/旧 release。
- **状态**：已部署 v0.5.9/schema v13（2026-10-22 22:35 CST，release `20261022T143451Z`/commit `97996dc`，无迁移；上一 release `20261022T134852Z`（v0.5.8）保留；`/healthz` v0.5.9/schema 13，smoke 16/16 与 24/24；生产 env 迁移完成：命令 120/AI 120/Chat 30、提示词变量已删除）；
  本地测试基线（Lead 实测 2026-10-22）`npm test` 333（server + 脚本，较 v0.5.8 少 4 个已移除用例）、`npm run test:web` 157（30 文件）、`check`/coverage（Lines 91.77% / Branches 76.98% / Functions 85.96%）/build 通过；**用户已实发验收通过**（2026-10-22 22:39–22:41 CST；非管理员 `/help` 有服务端事件证据，其余为用户确认；证据见 `docs/ACCEPTANCE.md`）。
- **下一版**：v0.6 候选（企业微信/钉钉/飞书、多管理员审批、QQ 平台更多能力），范围待用户确认。
## v0.5.8（历史，已部署并验收通过；QQ 单平台 + 图片默认开启 + schema v13；v0.5.9 起移除 /ask）

- **平台收敛**：Bot 仅支持 QQ 官方 Bot；删除 Telegram/Discord/Slack 适配器、Discord Gateway、只读按钮、媒体/多附件发布、目标 `chatTrigger`、Telegram HTML/引用/线程；
  删除 env `BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_*`；schema v13（迁移 13）删除非 QQ Bot 及其级联数据（**生产 Discord Bot 数据迁移前已备份**，迁移不可逆）。
- **QQ 单平台能力保留**：QQ 官方 Bot 接入、命令（含 `/role`/`/reset`/`/forget confirm`）、C2C/群@/频道 Chat、长期记忆、私聊角色卡、事件诊断、
  平台连接自检、角色/记忆元数据管理、文本发布（TOTP + `PUBLISH`，≤2000 分段）。
- **QQ 入站图片默认开启**：`BOT_AI_VISION_ENABLED=true`；`d.attachments` 图片经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 后缀白名单、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、
  内存不落盘下载后交给 AI；失败/关闭降级；图片会经 OpenCode 交给模型 provider（SECURITY 明示）。
- **API/UI 收敛**：`BotPlatform` 仅 `qq`；无 `gateway`/`chatTrigger`/`mediaFileIds`；删除媒体与触发方式错误码；Web `/bots` 去 Gateway/媒体/触发方式，保留 6 分区。
- **数据/部署**：schema v13；`deploy.ps1` 部署后 smoke 期望 schema 13；迁移前必须备份 Discord 数据 + DB 快照；回滚只能还原快照。
- **状态**：已部署 v0.5.8/schema v13（2026-10-22，release `20261022T134852Z`/commit `96294e4`；上一 release `20261022T131813Z`（v0.5.7）保留；`/healthz` v0.5.8/schema 13；部署内只读 smoke 16/16、带 Access token 完整 smoke 24/24；迁移 13 后 `bots` 仅 1 行 QQ Bot、原 Discord 数据 0 行、QQ 数据保留）；
  本地测试基线（Lead 全量实测 2026-10-22）`npm test` 337（服务端 321 + 脚本 16）、`npm run test:web` 157（30 文件），`npm run check`/coverage/build 通过；**真实 QQ 消息已由用户实发验收通过**（2026-10-22 21:59–22:08 CST，13 条入站事件符合预期、图片端到端通过；证据见 `docs/ACCEPTANCE.md`）。
- **下一版**：v0.5.9/v0.6 候选（企业微信/钉钉/飞书、多管理员审批、QQ 平台更多能力），具体范围待用户确认。

## v0.5.7（历史，已部署；真实平台实发待补；v0.5.8 起移除多平台能力，v0.5.9 起移除 /ask 与 task 双模式）

- **群聊触发方式**：目标级 `chatTrigger`（`mention` 默认 / `all`）；QQ 群/频道仅 @，`all` 返回 `chat_trigger_unsupported`；
  `all` 需平台前置（Telegram 关 privacy mode、Discord 开启 Message Content Intent、Slack 订阅 `message.channels`）；未授权 message 触发静默忽略。
- **回复形态**：长回复按平台上限分段（Telegram 4096 / Discord 2000 / Slack 4000 / QQ 2000，最多 4 段、续段前缀、超限截断、Telegram HTML 安全分段）；
  Markdown 平台化（Telegram HTML / Discord / Slack mrkdwn / QQ 纯文本）；群/频道引用原消息或留线程，私聊不引用，失败降级；partial 不自动重试。
- **图片理解（默认关闭）**：Telegram/Discord/Slack 入站图片（固定域名、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、不落盘）交 OpenCode prompt files；
  失败/关闭降级；QQ 不支持；生产只读验证 OpenCode prompt files data URL + `opencode-go/deepseek-v4.1-flash` 支持 image。
- **自助命令**：`/reset`（重置当前目标 Chat/任务会话，保留记忆）、`/forget confirm`（清长期记忆+镜像+该 Bot×用户全部会话），对所有用户开放；`/help` 更新。
- **诊断与自检**：`POST /api/bots/:id/check`（Telegram getMe+getWebhookInfo / Discord `/users/@me` / Slack auth.test / QQ access_token，脱敏）；
  `GET /api/bots/:id/events`（元数据，无正文；outcome received/ok/denied/rate_limited/ignored/error）；deliveries/publish/metrics 的 `lastErrorHint`。
- **角色/记忆管理**：`GET/PATCH/DELETE /api/bots/:id/roles…`、`GET/DELETE /api/bots/:id/memories…`（仅元数据、可启停/删除；删除角色清 chat 会话、删除记忆清 DB+镜像）。
- **Web `/bots`**：6 分区（概览/配置/目标/投递与发布/角色与记忆/诊断）、“检查连接”、目标触发方式、新面板只显示元数据；窄屏表格容器内横向滚动。
- **数据/部署**：schema v12（迁移 12：`bot_targets.chat_trigger` + `bot_events` 诊断列/索引）；新 env `BOT_AI_MAX_REPLY_CHARS`/`BOT_AI_VISION_ENABLED`/`BOT_AI_IMAGE_MAX_BYTES`；
  `deploy.ps1` smoke 期望 schema 12；迁移单向，回滚需迁移前 DB 快照。
- **状态**：本地 `npm test` 387、`npm run test:web` 157（30 文件）、`node scripts/check-version.mjs` 通过；生产已部署 v0.5.7/schema v12（当前 release `20261022T131813Z`，commit `2f429be`，含 `lastErrorHint` 错误码识别修复；部署内 smoke 16/16、完整 smoke 24/24；第二次迁移前快照 `db-predeploy-20261022T131844841Z.sqlite`；迁移 11→12、Gateway 与连接自检通过；生产只读复验 lastErrorHint/服务层/前端产物通过）；真实平台消息级联调待用户实发（Discord 尚缺 `/role` `/reset` `/forget` 注册；证据待在 `docs/ACCEPTANCE.md` 回填）。
- **下一版**：v0.5.8 候选（企业微信/钉钉/飞书、多管理员审批、Slack 按钮等），具体范围待用户确认。

## v0.5.6（历史，已部署）

- **默认角色 lofii**：内置猫系轻松伙伴，私聊/群聊普通对话默认使用；个人 `/role` 只覆盖私聊，`off` 回落到 lofii。
- **全用户语气**：`/role` 文案只写当前角色与用法，不注入默认角色个性或技术术语；群内 `/role` 只给友好提示。
- **状态**：本地测试 324/141；生产 release `20261022T114546Z`/schema v11、smoke 24/24，私聊/群聊 lofii 与简洁 `/role` 文案已实发确认。
- **下一版**：v0.5.7 群聊触发/引用/长回复分段/图片理解/诊断与管理（已实现，待部署）；企业平台顺延。
## v0.5.5（历史，已部署）

- **私聊角色卡**：`/role` 对全部平台私聊用户开放；每 Bot×用户一张“名字+设定”卡；`set/show/off/on/delete`；仅私聊 Chat 使用，安全边界与共享记忆保留；变更重置 Chat 会话。
- **权限边界**：仅 `/role` 绕过命令白名单；其他命令仍按目标+用户白名单；私聊 Chat 授权不变（QQ C2C 沿用 v0.5.4）。
- **schema v11**：新增 `bot_chat_roles`；Discord DM `isDirect` 修正；Discord/Slack 命令文本上限 2048。
- **状态**：本地测试 324/141；已部署 release `20261022T104834Z`/schema v11，smoke 24/24，私聊 `/role` 已实发确认。
- **下一版**：v0.5.6 默认角色 lofii 与全用户友好文案；多管理员/审批仍不做。

## v0.5.4（历史，已部署；`/ask`/task 双模式自 v0.5.9 起移除）

- **双模式提示词**：`/ask` 任务导向、Chat 对话导向；`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 覆盖，固定安全边界始终追加；旧 `BOT_AI_SYSTEM_PROMPT` 废弃。
- **会话/记忆**：schema v10 `bot_ai_sessions.mode`；旧会话归 chat，`/ask` 新 task；共享长期记忆；审计 mode。
- **QQ C2C**：QQ 私聊任意用户可 Chat，群/频道与其他平台仍按目标登记；命令仍白名单。
- **状态**：本地测试 324/141；已部署 release `20261022T085120Z`/schema v10，smoke 24/24；QQ C2C 管理员/非管理员均实发确认。
- **下一版**：v0.5.5 私聊角色卡；多管理员/审批仍不做。

## v0.5.3（历史，已部署）

- **Bot 出站连通性**：代理端口 TCP 存活 → 外网 → Discord/Telegram/Slack/QQ 平台 API 三层探测；默认 60s；`GET /api/bots/connectivity`、`POST /api/bots/connectivity/check`；`/bots` 出站网络卡片显示设备在线/代理端口/外网/平台延迟。
- **自动重连**：网络恢复后 `DiscordGatewayManager.wake()` 跳过退避立即重连，并触发投递/发布队列扫描；Windows `discord-tunnel.ps1` 先探测 PC 代理 10090 再建 SSH，计划任务登录启动、异常重启。
- **QQ 群排查**：QQ 未知事件/空正文带 detail，审计 `bot.event.ignored`（仅事件类型）；群事件需要开放平台订阅 `GROUP_AT_MESSAGE_CREATE`、Bot 入群 @ 与目标登记。当前生产 QQ 群无目标/无入站事件，C2C 正常。
- **OpenCode v2.1.2**：生产已升级（v2.1.1 → v2.1.2），备份与回滚步骤见 `docs/DEPLOY.md` §3.2。
- **状态**：本地测试/检查通过；生产已部署 v0.5.3/schema v9（release `20261022T065126Z`，commit `df06383`），smoke 24/24，Gateway 已连接；出站连通性断开/恢复实测通过；OpenCode v2.1.2；QQ 群目标已登记并确认 @Bot AI 回复。
- **下一版**：v0.5.4 企业微信/钉钉/飞书；多管理员/审批仍不做。

## v0.5.2（历史，已部署）

- **Bot Chat**：普通消息（非斜杠）在目标 `allow_chat=1` 时进入 AI Chat；群/频道仅 @Bot 或回复 Bot，私聊全部；Telegram/Slack/QQ Webhook 与 Discord Gateway 支持；非管理员只能 Chat，管理员斜杠命令仍由 `allow_commands` 目标 + user 白名单双校验；Chat 只读，不占写操作。
- **长期记忆**：每 Bot×用户一份，DB `bot_ai_memories` 摘要为权威（`summary_session_id`）+ `DATA_DIR/bot-memory/memory-<uuid>.md` 镜像（0700/0600）；每轮滚动摘要；摘要失败保留旧摘要；不通过 API/UI 暴露；系统提示内置，`BOT_AI_SYSTEM_PROMPT` 覆盖；不额外占对话轮次或 AI 每小时配额。
- **多附件发布**：最多 5 个、单 10 MiB、总 50 MiB；Telegram 全图片 media group/混合逐文件、Discord 单次 multipart、Slack 逐文件；QQ 仅文本；`partial_media_sent` 不自动重试。
- **只读按钮**：Telegram/Discord `/status`、`/help` 刷新/帮助按钮；需目标 `allow_commands` + user 白名单；无写操作；Slack/QQ 不做。
- **Discord Gateway**：Node 内置 WebSocket；`intents=37377`（含 `MESSAGE_CONTENT`）；需 Developer Portal 开启 intent；HELLO/IDENTIFY/RESUME、心跳、RECONNECT/INVALID_SESSION、指数退避与致命关闭码；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；状态显示。
- **数据/管理面**：schema v9（迁移 9：`allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）；目标 `allowChat`、最近入站目标 `GET /api/bots/:id/inbound-targets` 与 `/bots` 登记、发布媒体多选、Gateway 状态。
- **env**：`BOT_CHAT_RATE_PER_MINUTE=6`、`BOT_AI_MEMORY_MAX_CHARS=4096`、`BOT_AI_SYSTEM_PROMPT=`、`BOT_DISCORD_GATEWAY_ENABLED=false`、`BOT_PUBLISH_MAX_MEDIA_FILES=5`、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`；已有 `BOT_AI_RATE_PER_HOUR=10`。
- **状态**：本地 `npm test` 293（服务端 277 + 脚本 16）、`npm run test:web` 140（28 文件）、`npm run check` 通过；生产已部署 v0.5.2/schema v9（release `20261021T114908Z`），带 Access token 的完整 smoke 24/24，Discord Gateway 已连接，Discord DM、Discord #general @Bot、QQ C2C 普通消息 Chat 已实发确认；多附件/按钮待补充验证。

### v0.5.2 部署后待办

1. PC 部署前生成迁移前 DB 快照，迁移 v8→v9；`/healthz` 断言 `version=0.5.2`、`schemaVersion=9`；smoke 用 `-ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9`。
2. Discord Developer Portal 开启 **Message Content Intent**；按需设 `BOT_DISCORD_GATEWAY_ENABLED=true`，确认 `BotSummary.gateway.state=connected`，验证私聊/@/回复进入 Chat、普通频道消息不消费。
3. Telegram 群关闭 privacy mode（或只回复 Bot）；Slack/QQ 真实 Chat 联调；在 `/bots` 给目标勾选 `allow_chat` 并从“最近入站目标”登记。
4. 多附件真实平台外发（5 个/10 MiB/50 MiB）与失败/partial 场景；确认不自动重试导致重复外发。
5. 记忆文件权限/位置与摘要失败保留旧摘要；验证 `DATA_DIR/bot-memory` 不通过 Web 暴露、重启后仍能读取；真实模型多轮对话。
6. 按 `docs/ACCEPTANCE.md` v0.5.2 填写证据后再标记通过；生产部署前不得宣称已验收。

## 企业平台（未排期，原 v0.5.3 规划）

- **企业微信/钉钉/飞书**：新增平台适配器、回调验签/加解密、目标与消息发送；仍需各平台后台注册与真实联调。
- 多管理员/审批流、QQ 媒体、Slack 按钮不在 v0.5.3 承诺范围（单管理员/企业平台优先）。

## v0.5.1（已交付；`/ask`/task 双模式自 v0.5.9 起移除）

- **QQ 官方 Bot**：`server/src/bot/adapters/qq.ts`；AppID + AppSecret（密文）；op=13 Ed25519 回调地址校验、op=0 事件验签、`{opcode:12}` 确认；C2C/群@/频道文本命令与通知；仅文本（≤2000 字符），不支持媒体。生产回调已配置，C2C `/help` 回复已实测。
- **OpenCode AI `/ask`**：`server/src/bot/ai.ts`；`BOT_AI_*` 默认关闭；仅命令白名单用户；按用户每小时限流；会话复用（`bot_ai_sessions`）；新建会话 deny-all 工具权限（OpenCode 明确 400 拒绝时才降级并标注“未隔离”）；生产已启用 `opencode-go/deepseek-v4.1-flash` 并验证真实回复。
- **Bot 运维**：`GET /api/bots/:id/metrics?hours=24` 指标卡；目标静默时段（0–1439，成对设置，通知延后）；发布 `confirmText:'PUBLISH'` 二次确认（TOTP 仍必填）。
- **数据**：schema v8（迁移 8 重建 Bot 表扩展 `qq`、增加静默列、新增 `bot_ai_sessions`；迁移 6/7 保留）。
- **安全收口**：fail2ban dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后异步重启 fail2ban 恢复封禁 set；`smoke.ps1` 支持 `-AccessClientId/-AccessClientSecret`。
- **工具链**：typescript-eslint 8.x 仍不支持 TS7 API，本轮结论为暂不升级、保留双 alias。
- **状态**：本地 `npm test` 265（服务端 249 + 脚本 16）、`npm run test:web` 139、`npm run check` 通过；生产已部署 v0.5.1/schema v8（release `20261021T091001Z`），smoke 23/23；Discord + QQ 命令、AI 真实模型、fail2ban 持久化已验证。

## v0.5.0（已交付）

- **Bot 平台**：Telegram/Discord/Slack 适配器；签名 Webhook `/api/bot/webhook/:botId`（Telegram secret token、Discord Ed25519 + 时间戳、Slack HMAC + 时间戳、事件去重）；管理 API `/api/bots*` 与 `/bots` 页面。
- **只读命令**：`/help`、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`；目标 `allow_commands` + 显式 user 白名单双校验；输出清洗路径/URL。
- **通知与发布**：告警事件按目标 `allow_notifications` 通知；TXT + 单个云端媒体发布（≤10 MiB、频道/群组）、TOTP 再认证、定时/取消/重试/死信重投。
- **安全与数据**：Bot 凭据 AES-256-GCM（`BOT_SECRET_KEY`，只写不读）；Webhook/命令/发布限流；默认 `BOT_ENABLED=false`；schema v7（迁移 7 新增 5 张 Bot 表，迁移 6 保留）。
- **运维**：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY`；部署脚本干净工作树门禁、回滚还原 `APP_VERSION`、smoke 失败门禁；`check-version` 覆盖 env.example/DEPLOY 标题/lock；SSH 仅公钥（`00-` drop-in，24h 回滚窗口）；Cloudflare Access 策略与 bypass 文档。
- **文档**：README/AGENTS/CHANGELOG/PLAN/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ACCEPTANCE/AUDIT 全量同步；第四轮审计记录。

## v0.4.2（已交付）

- TypeScript 6.0.3 → **7.0.2**（官方并排方案：`@typescript/native` 提供 `tsc`；`typescript` 别名到 `@typescript/typescript6@6.0.2` 供 typescript-eslint）；typecheck/lint/test/build/npm ci 全绿。
- 修复 Android 窄屏指标趋势周期选择器压缩文字：按钮不收缩、标签不换行、范围选择器横向滚动。
- 工作区清理（生成物/缓存）与文档/版本/测试基线对齐；CI 增加 `check-version`。

## v0.4.1（已交付）

- OpenCode v2.0.32 → **v2.1.1** 升级；兼容性复核：Basic `/api/session`、`POST /api/session`（垫片新建会话）、垫片注入、`/api/*` 探测、公开 `ai.*` 入口。
- OpenCode Basic 密码轮换，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env` 与 service.json。
- Dependabot：actions/checkout 4→7、actions/setup-node 4→7、gitleaks-action 2→3；TypeScript 7 major 暂缓。
- 清理 Pi legacy 世界归档约 9 GiB；旧 cron 保持停用；应用 0.4.1（schema v6 不变）。

## v0.4.0（已交付）

- **可观测性**：主机指标 60s 采样/30 天保留、1h/6h/24h/7d/30d 范围查询、Dashboard 四张 SVG 趋势卡、Activity 关键词/时间范围、Alerts 筛选分页、`/api/storage`。
- **笔记增强**：附件（1–5/请求、25 MiB、每笔记 100、计入配额、`origin=note` 隔离）与版本历史（保留 20、查看/恢复）。
- **多文件分享**：1–50 个文件、`itemCount/totalSizeBytes`、公开逐项下载、按分享会话计数、删除即吊销；仍不生成服务端 zip。
- **世界备份与灾备**：`antifieldcloud-world.timer` 周度一致性备份（保留 4 份）、Windows `world-pull` 两阶段拉取（失败不 ack）、`drill` 自动恢复演练（报告 180 天）、三类状态文件与超期告警、密钥包 `KEEP=2`/tmpfs。
- **备份链路完善**：`skippedMissing/warnings`、prepare 超时对齐、ack 事务、恢复 origin 过滤、快照/staging 上限、归档浏览限流。
- **加固**：systemd capability/设备/内核面收紧、nftables 收窄 22/25565/25575、opencode Origin 校验、审计截断、CI coverage/audit/secret-scan/dependabot。
- **文档**：全量同步并收敛审计 OP-19/WE-24 漂移；新增 `check-version.mjs`。

## 下一批候选（按价值排序）

1. **更多 Bot 平台**：企业微信/钉钉/飞书（原 v0.5.4 计划，未排期；需各自回调签名/加解密与媒体模型）；QQ 媒体能力待平台开放后再评估。
2. **Bot 多人审批/发布复核**：在单管理员 TOTP + `PUBLISH` 之外增加第二人复核或延时窗口；需先定义多管理员模型。
3. **Slack 按钮**：Slack interactivity 与 `response_url`/`trigger_id` 语义，补齐与 Telegram/Discord 一致的只读按钮。
4. **备份/灾备增强**：整包加密与异地副本已于 v0.7.0 实现（默认关闭），后续仅做启用/演练与多远端评估，不再作为未实现候选。
5. **目录/打包分享**：目录选择、流式 zip（不落盘）、分享内相对路径；需处理配额、次数与 tar 安全。
6. **笔记公开分享**：只读 token + 密码/过期，沿用分享限流与 noindex；需先定义 Markdown/附件外链的泄漏边界。
7. **WebDAV / rclone（只读优先）**：读写需处理锁/并发/配额；复用现有 DB id 与不可变语义。
8. **可观测性扩展**：更多告警通道（企业微信/钉钉/邮件）、日志聚合/检索、外部 uptime 监控；指标长期降采样。
9. **Minecraft 启停/日志**：窄权限 helper、固定命令白名单、二次确认与审计；需系统级改动与用户授权。
10. **SSD 迁移 + LUKS**：USB/NVMe HAT，迁移数据/备份临时目录并做全盘加密。
11. **SSH/sudo 加固收尾**：SSH 已仅公钥 + `fail2ban` sshd jail（24h ban，已持久化）；后续收紧 `antifield` 的 `NOPASSWD ALL`，需用户确认后执行。

## 明确不做（至少近期）

- 多租户/SaaS 化、公开注册。
- 端到端加密同步客户端（Syncthing 式）——与 Web 云盘定位冲突。
- Minecraft 任意 RCON 控制台/插件管理。
- 服务端媒体转码/大模型推理。
- 替换现有 Minecraft/SakuraFRP/opencode 服务。
- 为分享生成服务端 zip 包（多文件逐项下载已够用）。
- Slack/QQ 按钮（v0.5.2 明确不做）。
- QQ 媒体与多管理员审批（v0.5.2 明确不做）。

## 已知限制

- v0.5.9 已部署（2026-10-22 22:35 CST）：移除 `/ask`（AI 仅 Chat）、限速放宽（Chat 30/min、AI 120/h、命令 120/min）、`/help` 动态开放；schema 保持 v13（无迁移），生产 env 迁移已完成（限速 120/120/30、提示词变量删除）；用户已实发验收通过（2026-10-22 22:39–22:41 CST；仅非管理员 `/help` 有服务端事件证据，其余为用户确认）。
- v0.5.8 已部署（2026-10-22）并验收通过：平台收敛为 QQ 单平台、schema v13（迁移 13 删除非 QQ Bot 及级联数据，迁移前快照可回滚）；真实 QQ 消息/图片识别/自助命令已由用户实发验收通过。
- v0.5.8 起仅 QQ 官方 Bot：QQ 仅文本、无媒体/附件/按钮/引用；群/频道只有 @Bot 事件（平台限制，无“全部消息”）；C2C 私聊直接进入 Chat；QQ 平台故障时无备用平台。
- v0.5.8 图片理解默认开启且需模型支持 image 输入；图片会经 OpenCode 交给模型 provider；生产只读验证过 `opencode-go/deepseek-v4.1-flash` 支持 image，真实图片识别质量/失败路径待在部署后验收。
- 回复分段最多 4 段，超长内容会截断并标记；partial 失败不自动重试，需人工核对后处理。
- v0.5.7 及以前的多平台能力（Telegram/Discord/Slack、Discord Gateway、按钮、媒体发布、chatTrigger、引用/线程）已自 v0.5.8 起移除，历史验收记录保留但不再是当前能力。
- v0.5.2 多附件部分成功不自动重试（标记 `partial_media_sent`），需人工确认并重建；单次最多 5 个、单 10 MiB、总 50 MiB。
- 记忆只保留摘要，不保存逐条对话；不提供导出页面，但用户可 `/forget confirm`、管理员可在“角色与记忆”删除；删除 Bot 时 DB 记忆行级联删除，`DATA_DIR/bot-memory` 镜像需按保留期/人工清理。
- 企业微信/钉钉/飞书未实现（未排期）；多管理员审批未实现；QQ 媒体未实现；Slack/QQ 按钮未实现。
- QQ 官方 Bot 仅文本、不支持媒体/图片；真实回调需用户后台配置；群/频道目标仍需真实场景补充。
- `/ask` 与 Chat 依赖 OpenCode 本地 API 与已配置模型；默认关闭，v0.5.1 生产已验证 `/ask`；deny-all 工具在 OpenCode 明确拒绝 `permissions` 时会降级并在日志标注未隔离。
- Cloudflare Access 策略/bypass 与 service token 需用户后台配置，应用无法自证；smoke 的 Access token 仅用于测试，不替代应用认证。
- `fail2ban` 封禁已由 dbfile 持久化，nftables 启动后由 drop-in 异步重启恢复；手工 `systemctl reload nftables` 不触发，需手动 `systemctl restart fail2ban`。
- SSH 已仅公钥（`00-` drop-in，24h 回滚窗口），`fail2ban` sshd jail（nftables 后端、24h ban）；Pi 登录用户 `antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择），待收紧。
- RCON 仍监听所有接口，仅由 nftables 限制为 loopback；Cloudflare 终止 TLS，可见明文；Cloudflare 约 100 MiB/100s 请求限制约束单请求上传（大文件走分片）。
- 限流为内存态，重启清零；`http-proxy` 在 Node 26 有弃用警告；scrypt 仍为 N=2^15；`typescript-eslint` 尚不支持 TS7 API，保留双 alias。
- 分享下载次数为会话级近似限制；无目录打包/公开笔记分享；多文件分享逐项下载。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练任务需用户手动安装；无异地世界副本。
- 备份整包加密与异地副本已实现但默认关闭；普通归档含 TOTP/会话明文与 Bot 密文，PC ACL 与离线介质是最后防线。
- v0.7.3 文档模式默认关闭：需 OpenCode v2.1.4 读范围矩阵通过后启用；首轮角色卡仍存在于 OpenCode 会话历史，后续请求不再发送正文；群共享记忆在群内可见为既有语义。
- Bot：命令严格只读、无平台主动拉取（Discord Gateway 除外）；适配器/AI 测试为进程内 mock，上线前需平台沙箱/真实模型联调。
- 旧世界 cron 已停用、旧 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
