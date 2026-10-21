# Bot 集成（v0.5.0）

AntifieldCloud 的 Bot 模块把运维告警、只读状态查询和手动/定时内容发布接到主流社交平台。
v0.5.0 支持 **Telegram、Discord、Slack**；企业微信/钉钉/飞书、QQ 官方 Bot 与 AI 对话属于 v0.5.1 规划。

> 安全边界：Bot Token/Secret 只写不读，数据库只存 AES-256-GCM 密文；Webhook 只按平台签名鉴权；
> 命令需要目标 + 用户双重白名单；发布必须 TOTP 再认证；通知/命令输出不包含内部路径或 URL。
> Bot 默认关闭（`BOT_ENABLED=false`），Webhook 在关闭时返回 404。

## 1. 架构

```text
平台 ──签名 Webhook──▶ POST /api/bot/webhook/:botId
                         │ 验签/时间戳/去重 + IP 限流
                         ├─ 命令 → 用户白名单 → 只读状态 provider → 平台回复
                         ├─ 事件 → bot_events 去重
                         └─ 入站错误 → 401/404/429（不执行业务）

告警/管理 API ──▶ BotService ──▶ bot_deliveries / bot_publish_jobs
                                   │ 每 30s 队列 tick、指数退避、死信
                                   └─ 适配器（Telegram Bot API / Discord / Slack Web API）
```

服务端模块：

- `server/src/bot/crypto.ts`：`BOT_SECRET_KEY`（32 字节 base64）加密/解密平台凭据，按 `key_version` 保存。
- `server/src/bot/adapters/{telegram,discord,slack}.ts`：平台签名、命令解析、文本/媒体发送。
- `server/src/bot/service.ts`：CRUD、Webhook、命令、通知/发布队列、重试、清理、限流。
- `server/src/http/routes/bots.ts`：管理 API；`bot-webhook.ts`：公开回调入口。
- web `/bots`：概览、配置、目标、投递与发布四个分区。

## 2. 平台接入

### Telegram

1. BotFather 创建 Bot，取得 Token；`setWebhook` 指向
   `https://app.example.com/api/bot/webhook/<botId>`，并设置随机 `secret_token`（≥16 字符）。
2. 在 `/bots` 填写 Token 与 `Webhook Secret`；平台消息需在允许的私聊/群组/频道中。
3. 命令：`/help`、`/status`、`/backup`、`/world`、`/mc`、`/files [关键词]`。

### Discord

1. Developer Portal 创建 Application/Bot，取得 Bot Token、Application ID、Public Key。
2. Interactions Endpoint URL 填 `https://app.example.com/api/bot/webhook/<botId>`；Discord 会以 Ed25519 签名验证。
3. `/bots` 填写 Application ID、Public Key、Token；命令通过斜杠命令注册（`/status` 等）。
4. 首次命令使用 deferred response（type 5），随后通过 interaction follow-up webhook 回复。

### Slack

1. Slack App 启用 Event Subscriptions / Slash Commands，Request URL 指向同一 Webhook；填写 Signing Secret。
2. 订阅 `message.channels`、`message.im`、`app_mention` 等事件（按需）；斜杠命令响应 URL 必须为 `hooks.slack.com`。
3. `/bots` 填写 Bot Token 与 Signing Secret；`chat.postMessage` 发文本，媒体走 `files.getUploadURLExternal` 流程。

## 3. 权限模型

- **命令目标**：`bot_targets` 中 `allow_commands=1` 的频道/群组/私聊。
- **用户白名单**：发送者必须是 `kind='user'` 且 `allow_commands=1` 的目标；频道里的普通成员即使目标开启命令也无法执行。
- 只有管理员能在 `/bots` 添加目标/开启权限；Bot 命令本身不提供 RCON、启停、封禁、OP 或任意 shell。
- **发布**：仅管理员手动/定时创建；必须提供 6 位 TOTP（`totpCode`），不能仅靠会话 + CSRF 外发文件。
- 发布媒体仅限活动、`origin='user'`、≤10 MiB 的单个文件；不含外部 URL 抓取。

## 4. 队列与失败处理

- 通知/命令回复/发布统一入队，`dedupe_key` 保证同一事件/目标只投递一次。
- 30 秒 tick，指数退避（30s 起，≤1h），达到 `BOT_DELIVERY_MAX_ATTEMPTS`（默认 5）进入 `failed/dead`。
- 进程重启后，`sending` 超过 10 分钟的记录自动回队；`assembling` 等异常由各模块维护清理。
- 事件保留 `BOT_EVENT_RETENTION_DAYS`（默认 7 天）；已发送投递/发布 30 天后清理；`failed/dead` 保留供人工重投，不自动删除。

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

`BOT_SECRET_KEY` 丢失或轮换会导致已存 Token 无法解密；必须重新录入所有 Bot Token。不要把它写入仓库/前端/日志。

## 6. 测试与验收边界

- 适配器/验签/队列/命令白名单/发布 TOTP 均有进程内测试（不访问真实平台）。
- Telegram/Slack 以 mock/fixture 覆盖；Discord Ed25519 使用本地密钥对；真实平台联调由用户在各自后台完成。
- 手工验收：创建 Bot → 测试连接 → 添加目标 → 允许命令 + 用户白名单 → 发 `/status` → 创建发布任务并输入 TOTP → 平台收到消息。
- 发布前请确认 Cloudflare Access 对 `/api/bot/webhook/*` 做 bypass，见 `docs/DEPLOY.md` §5.2。
