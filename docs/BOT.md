# Bot 集成（v0.5.1）

AntifieldCloud 的 Bot 模块把运维告警、只读状态查询、AI 问答和手动/定时内容发布接到社交平台。
v0.5.1 支持 **Telegram、Discord、Slack、QQ 官方 Bot**；QQ 仅文本；OpenCode `/ask` AI 默认关闭。企业微信/钉钉/飞书与多管理员审批仍未实现。

> 安全边界：Bot Token/Secret/AppSecret 只写不读，数据库只存 AES-256-GCM 密文；Webhook 只按平台签名鉴权；
> 命令需要目标 + 用户双重白名单；发布必须 TOTP + `PUBLISH` 二次确认；通知/命令输出不包含内部路径或 URL；
> `/ask` 只对白名单用户开放且默认关闭。Bot 默认关闭（`BOT_ENABLED=false`），Webhook 关闭时返回 404。

## 1. 架构

```text
平台 ──签名 Webhook──▶ POST /api/bot/webhook/:botId
                         │ 验签/时间戳/去重 + IP 限流
                         ├─ 命令 → 用户白名单 → 只读状态 provider / OpenCode AI → 平台回复
                         ├─ 事件 → bot_events 去重
                         └─ 入站错误 → 401/404/429（不执行业务）

告警/管理 API ──▶ BotService ──▶ bot_deliveries / bot_publish_jobs
                                   │ 每 30s 队列 tick、静默延后、指数退避、死信
                                   └─ 适配器（Telegram / Discord / Slack / QQ 官方 Bot）
```

服务端模块：

- `server/src/bot/crypto.ts`：`BOT_SECRET_KEY`（32 字节 base64）加密/解密平台凭据，按 `key_version` 保存。
- `server/src/bot/adapters/{telegram,discord,slack,qq}.ts`：平台签名、命令解析、文本/媒体发送（QQ 仅文本）。
- `server/src/bot/ai.ts`：OpenCode 本地 API 客户端，提供 `/ask` 会话复用、deny-all 工具与超时/截断。
- `server/src/bot/service.ts`：CRUD、Webhook、命令、指标、静默时段、通知/发布队列、重试、清理、限流。
- `server/src/http/routes/bots.ts`：管理 API；`bot-webhook.ts`：公开回调入口。
- web `/bots`：概览、配置、目标、投递与发布四个分区；投递与发布分区含近 24 小时指标卡。

## 2. 平台接入

### Telegram

1. BotFather 创建 Bot，取得 Token；`setWebhook` 指向
   `https://app.example.com/api/bot/webhook/<botId>`，并设置随机 `secret_token`（≥16 字符）。
2. 在 `/bots` 填写 Token 与 `Webhook Secret`；平台消息需在允许的私聊/群组/频道中。
3. 命令：`/help`、`/status`、`/backup`、`/world`、`/mc`、`/files [关键词]`、`/ask <问题>`。

### Discord

1. Developer Portal 创建 Application/Bot，取得 Bot Token、Application ID、Public Key。
2. Interactions Endpoint URL 填 `https://app.example.com/api/bot/webhook/<botId>`；Discord 会以 Ed25519 签名验证。
3. `/bots` 填写 Application ID、Public Key、Token；命令通过斜杠命令注册（`/status` 等）。
4. 首次命令使用 deferred response（type 5），随后通过 interaction follow-up webhook 回复。

### Slack

1. Slack App 启用 Event Subscriptions / Slash Commands，Request URL 指向同一 Webhook；填写 Signing Secret。
2. 订阅 `message.channels`、`message.im`、`app_mention` 等事件（按需）；斜杠命令响应 URL 必须为 `hooks.slack.com`。
3. `/bots` 填写 Bot Token 与 Signing Secret；`chat.postMessage` 发文本，媒体走 `files.getUploadURLExternal` 流程。

### QQ 官方 Bot

1. 在 QQ 开放平台（q.qq.com）创建机器人，取得 **AppID** 与 **AppSecret**；AppID 填公开配置，AppSecret 填“Token/AppSecret”字段（只存密文）。
2. “开发设置 → 回调地址”填 `https://app.example.com/api/bot/webhook/<botId>`；平台会发送 `op=13` 校验，服务端用 AppSecret 派生 Ed25519 私钥返回 `{plain_token, signature}`。
3. 事件订阅按场景勾选 `C2C_MESSAGE_CREATE`（私聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`AT_MESSAGE_CREATE`（频道）。
4. 目标登记：C2C 填 `user_openid`，群聊填 `group_openid`，频道填 `channel_id`；命令用户另建 `kind=user` 且允许命令的目标。
5. 仅文本：单条 ≤2000 字符；被动回复带入站 `msg_id`，主动通知/发布不带 `msg_id`；**不支持媒体**（发布带媒体返回 400）。
6. QQ 真实回调需用户后台配置；未配置前只能做进程内契约测试。

## 3. 权限模型

- **命令目标**：`bot_targets` 中 `allow_commands=1` 的频道/群组/私聊。
- **用户白名单**：发送者必须是 `kind='user'` 且 `allow_commands=1` 的目标；频道里的普通成员即使目标开启命令也无法执行。
- 只有管理员能在 `/bots` 添加目标/开启权限；Bot 命令本身不提供 RCON、启停、封禁、OP 或任意 shell。
- **发布**：仅管理员手动/定时创建；必须提供 6 位 TOTP（`totpCode`）与 `confirmText: "PUBLISH"`，不能仅靠会话 + CSRF 外发文件。
- 发布媒体仅限活动、`origin='user'`、≤10 MiB 的单个文件；不含外部 URL 抓取；QQ 平台无媒体。
- **AI `/ask`**：需 `BOT_AI_ENABLED=true`；仅命令白名单用户；提示词 ≤`BOT_AI_MAX_PROMPT_CHARS`；按 `botId:userId` 每小时限流；新建 OpenCode 会话使用 deny-all 工具权限；若 OpenCode 明确 400 拒绝 `permissions`，降级为默认权限并在日志标注“未隔离”。

## 4. 队列与失败处理

- 通知/命令回复/发布统一入队，`dedupe_key` 保证同一事件/目标只投递一次。
- 静默时段：目标设置 `quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地分钟 0–1439，成对设置、不能相同）后，窗口内新通知的 `next_attempt_at` 延后到窗口结束；跨午夜按 start > end 处理；通知不丢弃。
- 30 秒 tick，指数退避（30s 起，≤1h），达到 `BOT_DELIVERY_MAX_ATTEMPTS`（默认 5）进入 `failed/dead`。
- 进程重启后，`sending` 超过 10 分钟的记录自动回队；`assembling` 等异常由各模块维护清理。
- 事件保留 `BOT_EVENT_RETENTION_DAYS`（默认 7 天）；AI 会话映射按 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7 天）清理；已发送投递/发布 30 天后清理；`failed/dead` 保留供人工重投，不自动删除。
- 指标：`GET /api/bots/:id/metrics?hours=24`（1–720 小时）返回投递/发布/事件统计、成功率、最近错误与最近发送；`/bots` 页面展示近 24 小时卡。

## 5. 配置

见 `deploy/env.example` 的 `BOT_*` 段与 `docs/DEPLOY.md` §3.1：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOT_ENABLED` | `false` | 总开关；完成平台联调后再显式开启 |
| `BOT_SECRET_KEY` | 由 `bootstrap-env.sh` 生成 | 32 字节 base64；必须与 DB 一起备份 |
| `BOT_WEBHOOK_MAX_BODY_BYTES` | `262144` | Webhook body 上限 |
| `BOT_DELIVERY_INTERVAL_SECONDS` | `30` | 队列轮询间隔 |
| `BOT_DELIVERY_MAX_ATTEMPTS` | `5` | 最大尝试次数 |
| `BOT_EVENT_RETENTION_DAYS` | `7` | 入站事件保留 |
| `BOT_COMMAND_RATE_PER_MINUTE` | `20` | 每用户命令限流 |
| `BOT_PUBLISH_MAX_MEDIA_BYTES` | `10485760` | 发布媒体上限 |
| `BOT_PUBLISH_MAX_SCHEDULED_DAYS` | `30` | 定时发布最远天数 |
| `BOT_MAX_BOTS` | `10` | Bot 数量上限 |
| `BOT_AI_ENABLED` | `false` | `/ask` 总开关；默认关闭 |
| `BOT_AI_PROVIDER` | 空 | 可选 OpenCode provider；与 `BOT_AI_MODEL` 同时设置才指定模型 |
| `BOT_AI_MODEL` | 空 | 可选模型 ID；为空使用 OpenCode 默认模型 |
| `BOT_AI_TIMEOUT_SECONDS` | `60` | AI 超时（10–180 秒） |
| `BOT_AI_MAX_PROMPT_CHARS` | `2000` | 提示词截断（100–8000） |
| `BOT_AI_RATE_PER_HOUR` | `10` | 每 Bot×用户每小时 AI 调用上限（1–120） |
| `BOT_AI_SESSION_RETENTION_DAYS` | `7` | AI 会话映射保留天数（1–90） |

`BOT_SECRET_KEY` 丢失或轮换会导致已存 Token/AppSecret 无法解密；必须重新录入所有 Bot 凭据。不要把它写入仓库/前端/日志。
`bootstrap-env.sh` 已纳管 7 项 `BOT_AI_*`；`--force` 不会重置已有非空值。

## 6. 网络出站（Discord/Telegram/QQ/OpenCode）

Pi 所在网络可能无法直连 `discord.com` / `api.telegram.org` / `bots.qq.com` / `api.sgroup.qq.com`（Slack 通常可达）。应用使用 Node 全局 `fetch`，支持 Node 26 的环境代理：

```bash
# /etc/antifieldcloud/env（可选；代理必须从 Pi 可达）
HTTPS_PROXY=http://127.0.0.1:18090
HTTP_PROXY=http://127.0.0.1:18090
NO_PROXY=127.0.0.1,localhost,::1
NODE_USE_ENV_PROXY=1
```

`127.0.0.1:18090` 可由 SSH 反向隧道或本机代理提供。修改后重启 `antifieldcloud` 并验证：

```bash
curl -sS -m 10 -x "$HTTPS_PROXY" -o /dev/null -w '%{http_code}\n' https://discord.com/api/v10/gateway
curl -sS -m 10 -x "$HTTPS_PROXY" -o /dev/null -w '%{http_code}\n' https://bots.qq.com/app/getAppAccessToken
sudo journalctl -u antifieldcloud -n 50 --no-pager | grep -i bot
```

没有可用出站代理时，Discord/Telegram/QQ 的回复、通知和发布都会失败（Webhook 入站仍可到达）；Slack 不受影响。
`/ask` 只访问 `OPENCODE_URL`（默认 `http://127.0.0.1:4096`），不走外部代理；不要修改固定上游。不要把代理凭据写入仓库；本机部署信息放在 gitignored 的 `.local/DEPLOYMENT.md`。

## 7. 测试与验收边界

- 适配器/验签/队列/命令白名单/发布 TOTP+PUBLISH/AI 均有进程内测试（不访问真实平台/模型）。
- v0.5.1 新增：`bot-qq.test.ts`（8）、`bot-ai.test.ts`（9）、`bot-v051.test.ts`（3，含静默/指标/QQ/`/ask`）；`bot-migration.test.ts` 覆盖 v6→v8（含 `qq` CHECK、静默列与 `bot_ai_sessions`）。
- Telegram/Slack 以 mock/fixture 覆盖；Discord Ed25519 使用本地密钥对；QQ 使用固定 AppSecret 派生密钥对；AI 使用假 OpenCode HTTP 服务。
- 真实平台：Discord 联调已于 2026-10-21 通过（Interactions Endpoint、6 个斜杠命令、`/status`、测试通知）；Telegram/Slack 仍为 mock 契约；QQ 真实回调待用户后台配置；AI 真实模型待部署后验证。
- 手工验收：创建 Bot → 测试连接 → 添加目标（可设静默）→ 允许命令 + 用户白名单 → 发 `/status`/`/ask` → 创建发布任务并输入 TOTP + `PUBLISH` → 平台收到消息。
- 发布前请确认 Cloudflare Access 对 `/api/bot/webhook/*` 做 bypass，见 `docs/DEPLOY.md` §5.2。
