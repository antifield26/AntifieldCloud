# AGENTS.md — AntifieldCloud 工程约定（后续所有 Agent 会话必读）

## 0. 项目一句话

**当前版本 v0.6.5（已部署，待验收；Tag/Release 待发布；Bot `/role show` 角色卡详情；schema v16；OpenCode v2.1.3）**：v0.6.4 已发布（Tag/Release v0.6.4，生产 release `20261024T065245Z`/commit `63792a7`，schema 16，部署内 smoke 16/16、完整 Access smoke 24/24；校园网 Portal 认证恢复后 cloudflared active；`botmsg` MCP connected；多用户内测用户验收通过）；复核 `docs/AUDIT.md`/`docs/SECURITY.md` 已知问题/遗留事项；群聊全量非 @ 消息默认 8s/最长 20s 合并；`NO_REPLY` 升级为 `botmsg_send_message` MCP 工具（私聊/@ 每轮至少调用一次、可连续 1–5 条，全量群聊不调用即静默，漏调用有兜底）；新建 Chat/Memory 会话按「目标名称 + Chat/Memory」命名；SSO ticket 绑定 UA；schema 无迁移。**v0.6.3 已发布（Tag/Release v0.6.3；群聊独立角色卡 + 群消息模式 + 全量消息模型决策 + 群聊禁用斜杠命令；schema v16）**：v0.6.2 已发布（Tag/Release v0.6.2，生产 release `20261023T123055Z`/commit `77e42c7`，schema v15 兼容列），包含投递与发布单列、目标名称编辑、目标测试消息、入站查重。v0.6.3 生产 release `20261023T142411Z`/commit `7ac1d27`（schema 16，smoke 24/24；用户 2026-10-23 23:09 CST 验收通过；annotated Tag `v0.6.3` + GitHub Release）：每个群聊目标一张共享角色卡（管理员编辑，覆盖群成员私聊卡）；群目标 `groupReplyMode=mention|all`，全量消息由模型选择是否发送（`NO_REPLY`）；`GROUP_MESSAGE_CREATE` 需 QQ 后台开启接收所有消息；群聊/频道不再接受任何斜杠命令；schema v16 迁移 16 新增 `bot_group_roles`。

在 Raspberry Pi 5（Debian 13，8 GB）上运行的自托管个人工作台：统一登录（密码 + TOTP）、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态/白名单、opencode 反代、QQ 官方机器人（v0.5.8 起单平台；v0.5.9 起 AI 仅普通消息 Chat、自助 `/help` 动态开放；v0.5.10 记忆/会话修复并移除代理隧道依赖；v0.5.11 结构化长期记忆 + schema v14）、PWA、可观测性、主机告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。产品名 `AntifieldCloud · 个人工作台`。上一版 v0.5.11，数据库 schema **v14**（迁移 14 新增 `bot_memory_items`/`bot_memory_state`，旧 `bot_ai_memories` 保留为 legacy 来源；迁移 5–13 保留）；生产已部署 v0.5.11/schema v14（release `20261023T022831Z`，commit `931b10d`，迁移 14 不可逆；同版本早前 release `20261023T021339Z`/`20261023T014328Z` 保留；`/healthz` v0.5.11/schema 14，smoke 16/16 与 24/24；生产 env 5 个 `BOT_MEMORY_*` 就位），用户已实发验收通过（2026-10-23 10:39 CST：三条 Chat → `bot.memory.extract` rounds=3 ops=2、`/memory`、`/forget confirm` items=2 legacy=0 有服务端证据；`/bots` 面板用户确认）。v0.5.11 结构化记忆：7 类条目（profile/preference/fact/project/task/relationship/episode，唯一 `(bot,user,kind,key)`）；抽取 3 条/空闲 120s 批量 + 串行 + 一次性会话 + 严格 JSON ops + 敏感过滤 + 容量 200；TTL（资料/偏好不过期、事实/项目/关系 365、事件 90、任务 30，更新续期）；分层召回 3000 字/12 条 + legacy fallback；自助 `/memory` 与 `/memory off|on`；`/forget confirm` 清空 items/state/legacy/会话（含远端）；管理 API 只返回元数据；生产 env 新增 5 个 `BOT_MEMORY_*`；**迁移 14 不可逆，v0.5.10 不支持 v14，回滚必须恢复迁移前快照**。OpenCode 服务端 v2.1.3。

权威文档：
- `docs/PLAN.md`：范围、决策、阶段与验收
- `docs/API.md`：HTTP 契约（服务端/前端共同遵守）
- `docs/UI-SPEC.md`：界面与交互
- `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`
- `docs/ROADMAP.md`：路线图与当前版本边界
- `docs/AUDIT.md`：第一至第五轮审计（v0.2.0 / v0.3.x / v0.4.0 / v0.4.2+v0.5.0 / v0.5.11→v0.6.0）与残留
- `docs/ACCEPTANCE.md`：当前版本验收与历史记录

## 1. 语言与注释

- 代码注释、文档、提交信息、UI 文案一律中文（技术标识符除外）。
- 注释解释「当前行为/约束」，禁止写历史叙事（“之前……”“修复了……”）或轮次标记。
- 每个模块顶部用一段中文说明职责与安全边界。

## 2. 运行模型

- Node >= 26；服务端为原生 TypeScript，`node server/src/main.ts` 直接运行，**不要引入编译/打包服务端步骤**。
- 相对导入必须带 `.ts` 后缀；禁止 enum/namespace/参数属性等非可擦除语法（`erasableSyntaxOnly` 已开启）。
- 前端由 Vite 构建，产物 `web/dist`；服务端只托管静态产物，不参与前端编译。
- 依赖：服务端运行时依赖放 `dependencies`；React/Vite/ESLint 等仅构建期依赖放 `devDependencies`（Pi 上 `npm ci --omit=dev` 不安装）。
- 类型工具链（TS7 并排）：`npx tsc` 来自 `@typescript/native`（TypeScript 7.0.2）；`typescript` 包是 `@typescript/typescript6@6.0.2` 别名，仅供 typescript-eslint（8.x 尚不支持 TS7 API）。v0.5.1 评估结论（v0.5.2 未变）为暂不升级、保留双 alias；不要删除/合并这两个 alias，直到 typescript-eslint 支持 TS7.1 API。
- 不使用 Docker；Pi 上用 systemd 原生命令运行。

## 3. 命令

```bash
npm ci
npm run dev            # 本地服务端，默认 127.0.0.1:3000
npm run dev:web        # Vite :5173，/api 代理到 :3000
npm run build          # 前端构建
npm run typecheck      # server + web 两个 tsc 项目
npm run lint           # ESLint，--max-warnings=0
npm test               # node --test（收集 server/test/**/*.test.ts 与 scripts/test/**/*.test.mjs）
npm run test:coverage  # 服务端 + 运维脚本测试 + 覆盖率门禁（CI coverage job）
npm run test:web       # Vitest + jsdom（web/src/**/*.test.ts(x)）
npm run test:web:coverage # 前端测试 + 覆盖率门禁
npm run check          # typecheck + lint + server test + web test，提交前必须全绿
node scripts/check-version.mjs # 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS/env.example/DEPLOY 标题及 lock 根版本一致
```

当前基线（v0.5.10 实测：`npm test` 341、`npm run test:web` 157、coverage Lines 91.98% / Branches 76.92% / Functions 85.99%、build 通过）。**v0.5.11：`npm test` 360**（v0.5.10 的 341 + 新增 19：记忆存储/抽取/检索/迁移/管理 API/`/memory` 等）、`npm run test:web` **162**（30 文件，+5）。**v0.6.0（2026-10-23 本地门禁）**：`npm test` **383**（server+scripts，含 op=13/SSO/上传/备份/Bot/日志脱敏回归）、`npm run test:web` **176**（32 文件）；覆盖率 Lines **92.39%** / Branches **77.83%** / Functions **87.14%**（`npm run test:coverage` exit 0）、`npm run test:web:coverage` exit 0、`npm run build` 通过（bundle `index-D9PlQHRh.js` 680.45 kB）。**v0.6.1（2026-10-23 已发布）**：`npm test` **393**（+10 burst/搜索/MCP/会话清理/help 用例）、`npm run test:web` **177**；覆盖率 Lines **92.15%** / Branches **77.30%** / Functions **86.86%**；build bundle `index-a2xJNvfJ.js` 680.71 kB（仅服务端变更）。**v0.6.2（2026-10-23 已发布）**：`npm test` **393**、`npm run test:web` **179**；覆盖率 Lines **92.15%** / Branches **77.31%** / Functions **86.86%**；build bundle `index-BdeajuIF.js` 682.91 kB。生产 release `20261023T123055Z`/commit `77e42c7`（v0.6.2/schema 15），smoke 16/16 + 24/24，用户验收通过。**v0.6.3（2026-10-23 已发布）**：`npm test` **399**、`npm run test:web` **180**（群角色卡/群消息模式/全量事件/命令禁用）；覆盖率 Lines **92.28%** / Branches **77.42%** / Functions **87.07%**（`npm run test:coverage` exit 0）、`npm run test:web:coverage` exit 0、`npm run build` 通过（bundle `index-BHmn1DCi.js` 691.34 kB）；schema v16，生产 release `20261023T142411Z`/commit `7ac1d27`，smoke 24/24、drill schema16 通过；用户验收通过；annotated Tag `v0.6.3` + GitHub Release。**v0.6.5（已部署，待验收）**：`/role show` 对用户自定义角色卡返回完整详细文本，默认角色卡不展示内置详情；失效 AI 会话映射自动清理并重建一次，避免群聊未登记用户持续 `bot_ai_http_error`；`npm test` **410**（新增角色卡展示与失效会话重建回归）；schema 保持 v16，无迁移；生产 release `20261024T085435Z`/commit `c48ea8a`，smoke 16/16 + 24/24。**v0.6.4（已发布：Tag/Release v0.6.4；多用户内测验收通过）**：`npm test` **408**（新增消息工具/回合 token/长合并窗口/会话标题/UA 绑定/MCP 协议用例）、`npm run test:web` **180**；覆盖率 Lines **92.34%** / Branches **77.48%** / Functions **87.23%**（`npm run test:coverage` exit 0）、`npm run test:web:coverage` exit 0、build 通过（bundle `index-BHmn1DCi.js` 691.34 kB）；schema 保持 v16，无迁移。测试禁止依赖真实 Minecraft、真实 opencode、真实 network；Bot 适配器（QQ 官方 Bot、Chat、图片下载、分段/格式化/自检/诊断）与备份 tar、告警投递等同样只使用进程内假平台/夹具（不访问真实平台或模型）。Windows 上无法测试的 systemd 相关用例用 `t.skip` 并在 Linux 上跑；`scripts/test/` 覆盖世界备份与恢复演练校验脚本（纯函数/夹具，不触碰真实 Pi）。

## 4. 目录与模块边界

```text
server/src/
  main.ts            进程入口：配置、DB、Fastify、信号退出、启动指标采样
  config.ts          环境变量解析与校验（失败即退出）
  logger.ts          Fastify/pino 日志与脱敏
  db.ts              SQLite 打开、迁移（当前 schema v16）、事务辅助
  auth/              scrypt、TOTP、会话、CSRF、限流、恢复码、审计（字段截断）、Bot 发布 TOTP 再认证
  files/             存储、上传、配额、搜索、预览、回收站、files.origin 可见性
  uploads/           分片上传会话/块索引、配额预留、拼接与过期清理
  mc/                SLP、RCON、白名单
  opencode/          ai.* Host 的认证反代 + HTML 模式（shim/attributes/passthrough）+ Origin 校验
  bot/               QQ 官方 Bot 适配器、Chat AI（v0.6.3 起群聊共享角色卡 + 群消息模式 + 全量事件过滤；v0.5.9 起 AI 仅 Chat，`/ask` 与 task 提示词已移除）、结构化长期记忆（7 类条目、抽取/召回、TTL/容量、legacy fallback；`memory.ts`/`ai.ts`）、私聊角色卡、群聊角色卡（`group-roles.ts`）、出站连通性探测、AES-256-GCM 凭据、Webhook 验签/去重、命令（v0.6.3 起仅 C2C；含自助 `/reset`/`/forget confirm`）、回复管线（`text.ts` 2000 字符分段/`format.ts` QQ 纯文本/`errors.ts` 错误提示）、QQ 入站图片下载（默认开启）、连接自检、事件诊断、角色/记忆元数据管理、指标/静默、告警通知与文本发布队列/重试
  backups/           归档导入/校验、文件级恢复（skippedMissing）、世界/拉取/演练状态只读
  dashboard/         主机指标、服务状态、备份状态、Bot 开关、轻量存储用量（/api/storage）
  metrics/           60s 主机指标采样、按范围分桶聚合、30 天保留清理
  notes/             笔记/书签、标签、FTS5、附件（origin=note）、版本历史
  shares/            单文件/多文件分享、密码/过期/次数/公开逐项下载
  alerts/            告警条件/状态机/webhook（含世界备份/拉取/演练超期）与 Bot 通知入队
  http/              路由注册（含 bots.ts、bot-webhook.ts）、错误处理、静态资源、安全头、Cloudflare Access 前置说明
  util/              通用工具（时间、路径、响应、只读状态文件解析）
web/src/             React 页面与组件（只依赖 docs/API.md 的契约；/bots 管理页）
scripts/             provision/backup CLI、世界备份 backup-world.mjs、drill-verify.mjs、
                     world-pull.ps1、drill.ps1、部署/冒烟 PowerShell、bootstrap-env.sh、check-version.mjs、cleanup-legacy-memory.mjs（v0.5.11 legacy 清理；代理隧道脚本 v0.5.10 已删除）
scripts/test/        运维脚本单元测试（node --test .test.mjs）
deploy/              systemd（应用/健康探针/世界备份 timer）、nftables、cloudflared ingress、env 模板
```

写作用域约定：服务端改动在 `server/`，前端在 `web/`，脚本在 `scripts/`，文档在 `docs/`；跨域改动先在本文件或任务中说明。

## 5. 安全红线（不可违反）

1. 应用 API 不提供任意 Minecraft RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
   `scripts/backup-world.mjs` 是唯一例外：以 root 由 `antifieldcloud-world.timer` 调用，只执行固定的
   `save-off` / `save-all flush` / `save-on`（`save-on` 放在 finally），应用 API 不可触达该能力。
2. 文件访问只经 DB id，不接受客户端路径；文件内容不可变；禁止覆盖上传。
3. 所有非 GET `/api` 校验 CSRF；Cookie `HttpOnly + Secure + SameSite=Lax`（仅 loopback HTTP 例外）。
4. 密码/TOTP/opencode 密码与任何平台/Bot 凭据不得进仓库、日志、错误响应、前端 bundle。
5. 预览仅白名单类型内联；SVG/HTML/XML 强制下载；文本预览上限 1 MiB。
6. 代理只允许固定上游 `http://127.0.0.1:4096`，客户端 `Authorization` 必须被覆盖；HTTP/WS 均校验 `Origin`。
7. 不修改现有 Minecraft/opencode/frpc/SSH 配置；不重启 Minecraft（除非用户明确授权并已备份）；nginx/certbot 旧入口已移除，不再作为监控项。
8. 部署、备份脚本必须幂等、可重试；失败要留下可诊断日志，不得静默吞错。
9. 世界备份/拉取/演练状态文件由 root/PC 脚本写入，应用只读；状态文件不得包含密钥或路径敏感信息。
10. Bot 凭据（QQ AppSecret）只写不读，数据库只存 AES-256-GCM 密文；
    Webhook 只以 QQ Ed25519 签名/时间戳（含 op=13 回调校验）鉴权；v0.6.3 起除 C2C 私聊外（群聊/频道）不执行任何斜杠命令；C2C 命令除自助命令（`/help`、`/memory`、`/role` 仅私聊、`/reset`、`/forget confirm`）外，需目标 `allow_commands` + 显式 user 白名单；
    发布必须 TOTP 再认证；通知/命令输出不得包含内部路径、URL 或密钥；`BOT_ENABLED=false` 时 Webhook 返回 404。

## 6. 数据库与数据

- schema 迁移集中在 `server/src/db.ts` 的 `MIGRATIONS`，启动时按 `meta.schema_version` 顺序执行；迁移只追加，
  当前 schema **v16**（迁移 5：`files.origin`、唯一索引含 origin、`note_attachments`/`note_versions`/`share_items`/`metrics_samples`；
  迁移 6：删除孤儿 shares 并回填 `share_items`，不改表结构；迁移 7：新增 `bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events`；
  迁移 8：重建 Bot 表把 `bots.platform` CHECK 扩到 `qq`，`bot_targets` 增加 `quiet_start_minute`/`quiet_end_minute`，新增 `bot_ai_sessions`；
  迁移 9：`bot_targets.allow_chat`（默认 0）、`bot_ai_memories`（DB 摘要权威 + `summary_session_id`）、`bot_inbound_targets`（最近入站目标）；
  迁移 10：重建 `bot_ai_sessions`，主键加入 `mode`（chat/task，v0.5.9 起只写 `chat`，列保留）；
  迁移 11：新增 `bot_chat_roles` 私聊角色卡（每 Bot×用户一张，名字 1–32、设定 1–1000，可停用）；
  迁移 12：`bot_targets.chat_trigger`（mention/all，默认 mention）与 `bot_events` 的 event_kind/outcome/detail/target_external_id/user_id/updated_at 诊断列；
  迁移 13：`DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡（迁移不可逆，只能靠迁移前 DB 快照恢复）；
  迁移 14：新增 `bot_memory_items`（结构化记忆条目：7 类 kind、key/value、confidence/importance/source、时间戳、`expires_at`，唯一 `(bot_id,user_id,kind,mem_key)`）与 `bot_memory_state`（每用户启停 + legacy 迁移标记）；旧 `bot_ai_memories` 保留为 legacy 迁移来源，验收后 CLI 清理；迁移不可逆，只能靠迁移前 DB 快照恢复；
  迁移 15：`bot_targets.qq_number TEXT`（可空兼容列；手填号码功能已回滚，API/发送不使用；迁移不可逆，只能靠迁移前 DB 快照恢复）；
  迁移 16：新增 `bot_group_roles`（群聊目标共享角色卡，target_id FK 级联；目标群消息模式复用 `bot_targets.chat_trigger`，默认 mention；迁移不可逆，只能靠迁移前 DB 快照恢复）；
  Bot 凭据只存密文）。数据库 schema 高于程序支持版本时拒绝启动。
- 时间统一存 ISO 8601 UTC 字符串；展示用 `Asia/Shanghai`。
- 文件物理路径 `DATA_DIR/files/<id 前两位>/<id>`；上传先写 `DATA_DIR/tmp/` 再原子 rename。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站与笔记附件），上限 10 GiB；`fileCount` 只统计 `origin='user'`。
- `files.origin`：`user`（普通云盘）/`note`（笔记附件，不出现在列表/搜索/回收站）/`system`（保留）。
- `bots`：平台（v0.5.8 起仅 `qq`）/名称/启用/公开配置 + `secret_ciphertext/secret_iv/secret_tag/key_version`；`bot_targets` 唯一 `(bot_id, external_id)`，
  `allow_commands`/`allow_notifications` 默认关闭/开启、`allow_chat` 默认关闭（与命令权限独立），静默时段 `quiet_start_minute`/`quiet_end_minute`（0–1439，成对设置）；
  `chat_trigger` 复用为群消息模式（v0.6.3：mention/all，默认 mention）；`bot_deliveries` 队列（`dedupe_key` 唯一）、`bot_publish_jobs` 仅文本发布（`media_file_ids_json` 写空）、
  `bot_events` 按 `(bot_id, platform_event_id)` 去重，记录 event_kind/outcome/detail/target_external_id/user_id/updated_at 供诊断（不存正文；outcome ∈ received/ok/denied/rate_limited/ignored/error）、`bot_ai_sessions` 按 `(bot_id,target_external_id,user_id,mode)` 复用 AI 会话（v0.5.9 起 mode 只写 chat，列保留）、
  `bot_ai_memories` 为 legacy 滚动摘要（`summary_session_id` 保留列；v0.5.11 起仅作迁移来源/未迁移 fallback，镜像 `DATA_DIR/bot-memory/memory-<uuid>.md`）；
  `bot_memory_items` 按 `(bot_id,user_id,kind,mem_key)` 唯一保存结构化记忆，`bot_memory_state` 按 `(bot_id,user_id)` 保存 `memory_enabled` 与 `legacy_migrated_at`；
  `bot_group_roles` 按 `target_id` 保存群聊目标共享角色卡（名字 1–32、正文 1–1000，可停用；FK 级联删除）；
  `bot_inbound_targets` 按 `(bot_id,target_external_id,user_id)` 记录最近入站目标/用户名/类型/时间（不存正文）。QQ AppSecret 不落在日志/API 响应。
- 审计只记录元数据，不记录文件内容、密码、TOTP、Cookie、Authorization；单条 actor≤64、target≤256、detail≤4 KiB。

## 7. 完成定义（DoD）

- `npm run check` 全绿；新增逻辑有对应测试（成功 + 失败路径）。
- CI 的 coverage（`npm run test:coverage` / `npm run test:web:coverage`）、audit、secret-scan、依赖边界检查全绿。
- API 变更同步更新 `docs/API.md`；界面变更同步 `docs/UI-SPEC.md`。
- 无密钥/个人数据进入仓库；`.env` 与 `data/` 被忽略。
- 部署相关改动同步 `docs/DEPLOY.md`，并说明回滚。
- 提交信息使用 Conventional Commits（`feat:`/`fix:`/`docs:`/`test:`/`chore:`/`deploy:`）。
- 每个阶段结束给出「产出摘要 + 未决问题 + 验证证据」。

## 8. 已知环境事实（不要重复踩坑）

- Pi：`antifield@192.0.2.10` 直连；WiFi 198.51.100.10 与 PC 不通（AP 隔离）；直连 SSH 偶发超时，脚本需重试。
- 校园网 `WIRELESS-NCEPU` 有 Portal 认证（`https://a.ncepu.edu.cn`）；树莓派重启后认证可能失效，表现为 Cloudflare 7844 出站阻断、tunnel 1033/公网 530；需从 Pi 出口重新完成认证，再 `systemctl reset-failed cloudflared && systemctl restart cloudflared`。
- Pi 上 Node 为 `/usr/local/bin/node`（v26.12.1，世界可执行；v0.5.2 安全更新，旧二进制保留 `/usr/local/bin/node.v26.11.1`）；npm 指向 `/home/antifield/.nvm`（12.2.0），部署时以 root 使用。
- opencode：`127.0.0.1:4096`，服务端 **v2.1.3**（2026-10-23 由 v2.1.2 升级；升级/回滚见 `docs/DEPLOY.md`），Basic 用户名 `opencode`，密码来自 `/etc/opencode/opencode.env` 的 `OPENCODE_PASSWORD`（应用 env 同名键必须同步；轮换后重启 opencode 与 antifieldcloud）。
- Minecraft：Paper 26.1.2，RCON `127.0.0.1:25575`，密码在 `server.properties`（v0.2.0 已轮换为 32 位随机），
  服务器语言中文，输出含 `§` 颜色码需剥离；RCON 仍监听所有接口，nftables 仅放行 loopback。
- Pi 已启用 memory cgroup（`cgroup.controllers` 含 `memory`）；`antifieldcloud-health.timer` 每 60s 写
  `/run/antifieldcloud/pi-health.json`；`age` 与 `unattended-upgrades` 已安装。
- 备份：应用归档为两阶段 pending/ack（未确认不删）；Windows 任务参数为实际 `-PiHost/-BackupRoot`，ACL 收紧；
  密钥包 Pi 端 `KEEP=2` 滚动保留，PC 不再立即删除远端密钥包。
- 世界备份：`antifieldcloud-world.timer` 每周日 12:00（显式 Asia/Shanghai，`Persistent=true`）以 root 执行 `scripts/backup-world.mjs`，
  归档到 `/var/lib/antifieldcloud/world-backups`、保留 4 份；Minecraft 世界约 4.1 GiB，周备份耗时与磁盘余量需按 1.5× 世界体积预留。
  旧的 `minecraft-backups` cron 已停用；旧约 9 GiB legacy 归档已于 v0.4.1 清理（`/home/antifield/minecraft-backups` 已删除），新归档由 PC 侧 `world` 目录保留。
- 定时策略（2026-10-21 用户确认）：仅项目世界备份 timer 统一到周日 12:00；健康探针保持 60s；系统维护 timer（apt/logrotate/fstrim 等）保持发行版默认，不再做“全部定时任务统一”调整。
- 备份/灾备状态文件由脚本写入、应用只读：`/var/lib/antifieldcloud/world-backup-status.json`、
  `world-pull-status.json`、`drill-status.json`（0644）；Dashboard/Settings 与告警读取。
- systemd 加固：`antifieldcloud.service` 已加 `CapabilityBoundingSet=`（空）、`RestrictAddressFamilies`、
  `PrivateDevices`、`ProtectClock/Hostname/KernelLogs`、`RestrictSUIDSGID/Realtime` 等；`antifieldcloud-world.service`
  同样加固并有 `flock`、4h 超时。
- nftables：默认拒绝入站；22 仅 `169.254.77.0/24` + `172.23.88.0/21` 且新建连接限速 20/min；
  25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`。**改 22 网段前先确认当前 SSH 来源在允许集合内**。
- SSH 仅公钥：`/etc/ssh/sshd_config.d/00-` drop-in 先于其它配置生效（禁用密码/键盘交互，保留公钥）；旧配置备份保留 **24h 回滚窗口**，
  回滚见 `docs/DEPLOY.md` §9.7；`fail2ban` 已安装并启用 `sshd` jail（nftables 后端，24h ban），dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；
  `deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后以 `systemd-run --collect --on-active=3` 异步重启 fail2ban 恢复封禁 set。
  **手工 `systemctl reload nftables` 不触发该 drop-in，仍需 `systemctl restart fail2ban`**。
- Bot 环境变量：`BOT_ENABLED`（默认 **false**）、`BOT_SECRET_KEY`（32 字节 base64，`bootstrap-env.sh` 仅在缺失时生成，`--force` 复用旧值）；
  `BOT_WEBHOOK_MAX_BODY_BYTES=262144`、`BOT_DELIVERY_INTERVAL_SECONDS=30`、`BOT_DELIVERY_MAX_ATTEMPTS=5`、`BOT_EVENT_RETENTION_DAYS=7`、
  `BOT_COMMAND_RATE_PER_MINUTE=120`（v0.5.9 放宽；范围 1–600）、`BOT_PUBLISH_MAX_SCHEDULED_DAYS=30`、`BOT_MAX_BOTS=10`。
  v0.5.1 新增 AI（OpenCode 本地 API，默认关闭）：`BOT_AI_ENABLED=false`、`BOT_AI_PROVIDER=`、`BOT_AI_MODEL=`、`BOT_AI_TIMEOUT_SECONDS=60`、
  `BOT_AI_MAX_PROMPT_CHARS=2000`、`BOT_AI_RATE_PER_HOUR=120`（v0.5.9 放宽；范围 1–600）、`BOT_AI_SESSION_RETENTION_DAYS=7`；`bootstrap-env.sh` 已纳管这 7 项。
  v0.5.2 新增：`BOT_CHAT_RATE_PER_MINUTE`（v0.5.9 默认 **30**，范围 1–120；Chat 每 Bot×用户每分钟）、`BOT_AI_MEMORY_MAX_CHARS=4096`（记忆摘要上限 512–16384）。
  v0.5.4 曾新增 `BOT_AI_TASK_PROMPT=`/`BOT_AI_CHAT_PROMPT=`；**v0.5.9 已删除**（AI 仅 Chat，固定为角色卡 + 安全边界 + 记忆 + 用户；`bootstrap-env.sh` 不再纳管）；旧 `BOT_AI_SYSTEM_PROMPT` 已废弃，不再读取。
  v0.5.3 新增：`BOT_CONNECTIVITY_ENABLED=true`、`BOT_CONNECTIVITY_INTERVAL_SECONDS=60`、`BOT_CONNECTIVITY_TIMEOUT_SECONDS=8`；`bootstrap-env.sh` 已纳管。`BOT_PROXY_URL` 曾用于代理探测，**v0.5.10 已删除**（Pi 直连，连通性仅外网+QQ 平台；生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`）。
  v0.5.9 变更：`/ask` 与 task 模式移除、`/help` 对所有用户开放（非管理员仅公开命令 + Chat 说明）、限速默认放宽（Chat 30/min、AI 120/h、命令 120/min）；生产 env 已于 2026-10-22 迁移（120/120/30、提示词变量删除）。
  v0.5.10 新增：`BOT_AI_MEMORY_RETENTION_DAYS=365`（30–3650，独立于 7 天会话保留）、`BOT_AI_MEMORY_BATCH_MESSAGES=3`（1–20）、`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`（0 或 10–3600，0 关闭空闲触发）；`bootstrap-env.sh` 已纳管。
  v0.5.11 新增：`BOT_MEMORY_MAX_ITEMS=200`（20–1000）、`BOT_MEMORY_PROMPT_MAX_CHARS=3000`（500–8000）、`BOT_MEMORY_PROMPT_MAX_ITEMS=12`（1–50）、`BOT_MEMORY_TTL_EPISODE_DAYS=90`（1–365）、`BOT_MEMORY_TTL_TASK_DAYS=30`（1–180）；`bootstrap-env.sh` 已纳管。fact/project/relationship TTL 沿用 `BOT_AI_MEMORY_RETENTION_DAYS`（365），legacy fallback 上限沿用 `BOT_AI_MEMORY_MAX_CHARS`。
  v0.5.7 新增：`BOT_AI_MAX_REPLY_CHARS=4000`（AI 回答上限，1000–12000）、`BOT_AI_VISION_ENABLED=true`（v0.5.8 默认开启；图片理解总开关）、
  `BOT_AI_IMAGE_MAX_BYTES=10485760`（单张入站图片上限，1–20 MiB）；`bootstrap-env.sh` 已纳管这 3 项。图片理解需 OpenCode prompt files
  与支持 image 输入的模型；生产已只读验证 `opencode-go/deepseek-v4.1-flash` 支持 image。
  v0.6.4 新增：`BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS=8000`（0–30000）、`BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS=20000`（1000–60000）、`BOT_AI_SEND_TOOL_ENABLED=false`（启用前安装 `botmsg` MCP）；`bootstrap-env.sh` 已纳管。
  **v0.5.8 已删除**：`BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`；`bootstrap-env.sh` 不再纳管。
  `BOT_SECRET_KEY` 与 DB 必须一起备份；丢失后已存 QQ AppSecret 只能重新录入。
- Bot 公开入口：`POST /api/bot/webhook/:botId`（无 session/CSRF，按平台签名鉴权）；Cloudflare Access 必须对
  `/api/bot/webhook/*`、`/healthz`、`/s/*`、`/api/public/shares/*` 做 bypass，否则平台回调/健康检查/公开分享会被边缘拦截。
  `BOT_ENABLED=false` 时该路径返回 404。
- Bot 平台注册（QQ 开放平台）与 Cloudflare Access 策略均由用户在各自后台完成，Agent 不代替；v0.5.8 起仅 QQ 官方 Bot。
  v0.5.1 生产已配置 QQ 官方 Bot 与 OpenCode 真实模型（`opencode-go/deepseek-v4.1-flash`）并已验证命令/Chat 回复（v0.5.9 起 AI 仅 Chat）；Cloudflare Access 主应用 + 4 个 bypass + service token 已配置并通过带 token 的 smoke。
  v0.5.2 已部署 v0.5.2/schema v9；v0.5.3 已部署 release `20261022T065126Z`/schema v9；v0.5.4 已部署 release `20261022T085120Z`/schema v10；v0.5.5 私聊角色卡 `/role` 已上线并由用户实发确认；v0.5.6 内置默认角色 lofii 与简洁 `/role` 文案已上线；v0.5.7 已部署 release `20261022T131813Z`/schema v12（commit `2f429be`，含 `lastErrorHint` 错误码识别修复）。
  **v0.5.8 已部署**（2026-10-22，schema v13）：release `20261022T134852Z`/commit `96294e4`，`/healthz` version 0.5.8/schemaVersion 13，部署内只读 smoke 16/16、带 Access token 完整 smoke 24/24；迁移 13 后 `bots` 仅 1 行 QQ Bot，原 Discord Bot `853f85e6…` 在目标/队列/事件/会话/记忆/角色/入站表均 0 行；QQ 数据保留；图片默认开启（`botAiVisionEnabled=true`），连通性仅 `qq`，新进程无 Discord Gateway；真实 QQ 消息已由用户实发验收通过（2026-10-22 21:59–22:08 CST：/reset、/forget confirm、/role、/help、文本 Chat、图片 148563 B jpeg 端到端均有生产证据；用户 22:10 CST 确认“验收通过”）。
  **v0.5.9 已部署**（2026-10-22 22:35 CST，schema v13、无迁移）：release `20261022T143451Z`/commit `97996dc`，`/healthz` version 0.5.9/schemaVersion 13，smoke 16/16 与 24/24；生产 env 迁移实测（命令 120/AI 120/Chat 30、提示词变量计数 0、权限 640、APP_VERSION=0.5.9）；运行时 `botChatRatePerMinute=30`/`botAiRatePerHour=120`/`botCommandRatePerMinute=120`/`botAiVisionEnabled=true`/`botAiEnabled=true`；前端 `/`、`/bots` 200（bundle `index-CFrhFtH2.js` 644849 bytes，含“每分钟 30 次”与“AI 对话由普通消息 Chat 承担”，不含 `/ask`）；用户已实发验收通过（2026-10-22 22:39–22:41 CST：非管理员 `/help` 有生产事件证据，其余为用户口头确认）；回滚切回 `20261022T134852Z` + 还原 env 备份（20/10/6）。
  **v0.5.10 已部署**（2026-10-22 23:20–23:23 CST，schema v13、无迁移）：release `20261022T152053Z`/commit `4619c91`，`/healthz` version 0.5.10/schemaVersion 13，smoke 16/16 与 24/24；迁移前快照 `db-predeploy-20261022T152150860Z.sqlite`（sha256 `3e48eb33…7078e6`）；
  生产 env 实测（`BOT_AI_MEMORY_RETENTION_DAYS=365`/`BOT_AI_MEMORY_BATCH_MESSAGES=3`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`，代理变量与 `BOT_PROXY_URL` 均无，运行时 365/3/120/7，config 无 proxy 字段）；无代理环境 QQ `checkBot` ok、启动日志 detail 仅 `internet:true, platforms:["qq"]`；
  PC 隧道任务/进程已移除、PC/Pi 无 18090 监听；前端 `/`、`/bots` 200（bundle `index-Bx6EBCIp.js` 644262 bytes，含“Pi 直连”，不含“代理端口/设备在线”）；部署后备份 `snapshot-20261022T152331855Z-inc.tar.gz`（132980 bytes，sha256 `c53e4ab2…66d42c`）+ 密钥包 secrets=ok；用户已实发验收通过（2026-10-22 23:26–23:29 CST：合并摘要 rounds=3、远端会话删除 404 两例、图片 145172 B 有服务端证据；`/bots` 卡片为用户确认）；回滚切回 `20261022T143451Z` 并恢复 env（含代理变量/旧隧道脚本）后重启。
  **v0.5.11 已部署并验收通过**（2026-10-23，schema **v14**、迁移 14 不可逆）：最终 release `20261023T022831Z`/commit `931b10d`（早前同版本 release `20261023T021339Z`/`20261023T014328Z` 保留），`/healthz` version 0.5.11/schemaVersion 14，部署 smoke 16/16、完整 Access smoke 24/24；迁移前快照 `/var/lib/antifieldcloud/backups/db-predeploy-20261023T022902018Z.sqlite`（sha256 `937a0bc8…76a98d3c`）；
  生产 env 5 个 `BOT_MEMORY_*`（640 root:antifieldcloud），运行配置 365/3/120/3000/12/90/30；部署后备份 `snapshot-20261023T023941878Z-inc.tar.gz`（154594 bytes，sha256 `db551788…fe68a21f`，secrets=ok）；用户实发验收通过（2026-10-23 10:39 CST：三条 Chat → `bot.memory.extract` rounds=3 ops=2、`/memory` 成功、`/forget confirm` items=2 legacy=0 且未误删其他用户；早前 `/memory off`→Chat 无新 extract→`on`→`/forget` 亦通过；`/bots` 面板用户确认）；首次短消息抽取 ops=0 判定提示词过保守，已由 commit `931b10d` 修正后重试得到 ops=2；
  legacy 清理 dry-run/`--confirm` 均 users=0 files=0（未迁移用户 2 条未触碰）；回滚必须恢复最终迁移前快照 + 切回 `20261022T152053Z`（v0.5.10，不支持 v14）；本地提交 `0b1dd03`/`dc912bb`/`a62eb34`/`931b10d`；已推送 main `c16a39b`、annotated Tag `v0.5.11`、GitHub Release [AntifieldCloud v0.5.11](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.5.11)（Latest，2026-10-23 10:46 CST）。
  QQ 群/频道仅 @Bot 事件进入、C2C 私聊直接进入；QQ C2C 无需登记即可 Chat，但命令仍需白名单；`/help`、`/memory`、`/role`、`/reset`、`/forget confirm` 对全部私聊/群聊用户开放（自助命令不要求目标或用户白名单）。
- **v0.6.0 已部署并验收通过**（2026-10-23，schema 保持 v14、无迁移；最终 release `20261023T053539Z`/commit `6349617`，前两次同版本部署 `20261023T052315Z`/`20261023T045613Z` 保留）：`/healthz` v0.6.0/schema 14；部署 smoke 16/16、完整 Access smoke 24/24（0 警告）；drill `20261023T050104Z` schema14 通过；最终迁移前快照 `db-predeploy-20261023T053611142Z.sqlite`（sha256 `8a96fe8e…76e445`）；部署后备份 `snapshot-20261023T053645712Z-inc.tar.gz`（163398 bytes，sha256 `da0a75c1…f0d7faf8`，PC ack）+ 密钥包 `secrets-20261023T053647Z.tar.age`（1477127 bytes，含 opencode DB，secretsOk=true；A5-DATA-01 生产复验）；用户确认验收通过。默认 `lofii` 只保留名字与用户指定对话风格，`/role set` 个人卡可覆盖。已推送 main、annotated Tag `v0.6.0`、GitHub Release [AntifieldCloud v0.6.0](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.6.0)（Latest，2026-10-23 13:51 CST）。
- **v0.6.1 已发布（Tag/Release v0.6.1）**（2026-10-23）：生产最终 release `20261023T094819Z`/commit `ceb2e8f`（v0.6.1/schema 14）；`/healthz` v0.6.1/schema 14，部署 smoke 16/16、完整 Access smoke 24/24（0 警告）；迁移前快照 `db-predeploy-20261023T094851198Z.sqlite`；启动清理 11 个孤儿 OpenCode 会话；部署后备份 `snapshot-20261023T094939126Z-inc.tar.gz`（181678 bytes，sha256 `6c6916e7…3c94655b`，PC ack）+ 密钥包 `secrets-20261023T094940Z.tar.age`（secretsOk=true）；用户 2026-10-23 17:32 CST 实发复测通过、17:56 CST 确认 `/help` 简化并发布；annotated Tag `v0.6.1` + GitHub Release。
- 测试证据边界：QQ Bot 适配器、Chat/记忆、AI 对话、图片下载、自检/诊断、备份 tar、告警投递等以进程内 mock/夹具为主（mock-only），
  未做真实 QQ 平台限流/签名漂移/故障等负路径验收；真实 QQ 消息已于 2026-10-22 21:59–22:08 CST 实发验收通过（13 条入站事件、图片端到端），证据见 `docs/ACCEPTANCE.md`。
- Windows 世界拉取（`scripts/world-pull.ps1`，周度）与恢复演练（`scripts/drill.ps1`）计划任务由用户手动安装；
  `install-backup-task.ps1` 只安装每日应用归档拉取任务。
- Cloudflare：zone `example.com`；tunnel 名称 `pi`；`mc.example.com` CNAME 到 SakuraFRP，**不要改**；
  `app/ai` 的 DNS 由用户手动添加；Access 主应用 + 4 个 bypass + service token 已在生产配置（见 `docs/DEPLOY.md` §5.2），
  service token 只保存在 gitignored 的 `.local/cf-access.env`；严格 CSP 会拦截 Web Analytics/Challenge 注入，需后台关闭自动注入或接受报错。
- 旧项目 PiForge 的残留（sudoers 注释、禁用的计划任务）保持原样，不继承、不清理。
- 公开仓库中的域名/IP/备份路径均为示例值；本机实际部署信息见 `.local/DEPLOYMENT.md`（gitignored，不提交）。

## 9. 用户手动步骤（Agent 不得代替）

1. Cloudflare 后台添加 `app`/`ai` CNAME（已由用户完成）。
2. 交互式运行 provisioning，设置密码、扫描 TOTP、保存恢复码。
3. 安装/重装 Windows 每日应用归档计划任务（`install-backup-task.ps1`，需管理员 PowerShell）；
   v0.5.2 更新仓库后必须重装一次，刷新复制的 `backup-pull.ps1`、脚本 SHA 与安装标记。
4. 离线保存 age 私钥；把 `ALERT_WEBHOOK_URL` 写入 env 后重启应用。
5. 手动安装 Windows 周度世界拉取任务（调用 `scripts/world-pull.ps1`，`-PiHost/-BackupRoot`）与恢复演练任务/手跑
   （`scripts/drill.ps1 -ExpectedSchemaVersion 16`，建议季度或升级前）；确认直连网线可通。
6. 应用新 nftables 规则前，确认当前 SSH 来源在 `169.254.77.0/24` 或 `172.23.88.0/21` 内（否则会锁死）；
   保留物理键鼠/已建立 SSH 作为回滚通道。
7. 旧 `minecraft-backups` cron 已停用、legacy 归档已清理；如后续手工重建 cron 或旧目录，按 `docs/DEPLOY.md` 处理并再次确认迁移。
8. 最终公网/手机/PWA 验收；完成正式恢复演练并记录到 `docs/BACKUP.md` §7 与 `docs/ACCEPTANCE.md`。
9. Cloudflare Access：已通过 API 配置主应用（One-time PIN + Owner allow + Service Auth）与 4 个 bypass（`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`）；service token 存放在 PC `.local/cf-access.env`（gitignored）。后续轮换 service token 后同步该文件，并用 `smoke.ps1 -AccessClientId/-AccessClientSecret` 重跑；配置用高权限 API Token 完成后应 Revoke。
10. Bot 平台后台注册（v0.5.8 起仅 QQ 官方 Bot，用户在 q.qq.com 完成，Agent 不代替）：创建机器人取得 AppID/AppSecret →
    在 `/bots` 新建 QQ Bot 录入 AppID 与 AppSecret → 回调地址填 `https://app.<域名>/api/bot/webhook/<botId>` 并处理 `op=13` 校验 →
    订阅 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`/`AT_MESSAGE_CREATE` → 登记目标（user_openid/group_openid/channel_id），
    命令用户另建 `kind=user` 且允许命令的目标，Chat 目标勾选 `allow_chat` → 开启 `BOT_ENABLED=true` 并重启。
    v0.5.8 部署前必须先备份生产 Discord Bot 数据（DB 快照覆盖；迁移 13 会删除非 QQ Bot 及级联数据，不可逆）。
    v0.5.8 起图片理解默认开启：需 `BOT_AI_ENABLED=true` 且模型支持 image 输入；QQ 入站图片经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 域名后缀、
    image mime 白名单与 `BOT_AI_IMAGE_MAX_BYTES` 下载后交给 OpenCode；图片会发给模型 provider（见 `docs/SECURITY.md`），可设 `BOT_AI_VISION_ENABLED=false` 关闭。
    v0.5.9 起无 `/ask`：普通消息 Chat 在已部署环境配置 `BOT_AI_ENABLED=true`（可选 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`）并验证真实模型回复；QQ 无平台侧命令注册。
11. Windows Bot 代理隧道任务 **v0.5.10 起已移除**：仓库删除 `discord-tunnel.ps1/.vbs`、`install-tunnel-task.ps1`，PC 计划任务 `AntifieldCloudDiscordTunnel` 已移除；Bot 出站改为 Pi 直连，生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`（空值）。
12. SSH 仅公钥切换后保留 **24h 回滚窗口**：期间保留旧 drop-in 备份与一个已建立的 SSH 会话；确认新会话/自动化脚本
    （smoke、备份、世界拉取）均能公钥登录后，再按 `docs/DEPLOY.md` §9.7 结束回滚窗口。
