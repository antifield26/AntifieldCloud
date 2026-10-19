# AntifieldCloud · 个人工作台

面向 Raspberry Pi 5（8 GB，Debian 13）的自托管个人工作台：统一登录、云盘、Minecraft 状态与白名单管理、opencode AI 工作区入口、主机概览与每日备份。

> 状态：v0.1.0 开发中。部署、验收与用户手动步骤见 `docs/DEPLOY.md`，备份与恢复见 `docs/BACKUP.md`。

## 技术栈

- 服务端：Node.js >= 26（原生 TypeScript，无编译步骤）+ Fastify + `node:sqlite`
- 前端：React 19 + TypeScript + Vite，中文暗色界面
- 部署：Cloudflare Tunnel（`app.example.com` / `ai.example.com`）+ systemd + nftables
- 测试：`node --test`，ESLint，`tsc --noEmit`

## 常用命令

```powershell
npm ci
npm run dev          # 服务端（Node 原生 TS）
npm run dev:web      # Vite 开发服务器 :5173
npm run build        # 构建前端到 web/dist
npm run check        # typecheck + lint + test
npm run provision    # 初始化管理员/TOTP（在 Pi 上以 antifieldcloud 运行）
npm run backup       # 生成备份归档（在 Pi 上以 antifieldcloud 运行）
```

## 目录

```text
server/    Fastify 服务端（src + test）
web/       React 前端（Vite 根目录）
scripts/   provisioning、备份、部署、冒烟脚本
deploy/    systemd / nftables / cloudflared 配置模板
docs/      架构、安全、部署、备份、API、UI 规范
```

## 安全与边界

- 单管理员，密码（scrypt）+ TOTP 两步验证；所有写操作校验 CSRF。
- 文件内容不可变，逻辑目录存 SQLite；配额 10 GiB（含回收站）。
- Minecraft 仅状态查询与白名单增删；不提供任意 RCON 命令、不做启停。
- opencode 仅通过 `ai.example.com` 反代访问，端口 4096 不对外。
- 任何密钥只存放在 `/etc/antifieldcloud/env`（0600/0640）或本机 `.env`，不进仓库、不进日志。
- Cloudflare 终止 TLS，Cloudflare 可见明文；备份包含 TOTP secret，需妥善保管。

详细设计与验收标准见 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`；
v0.1.0 验收记录见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## License

MIT © 2026 Antifield。详见 [LICENSE](LICENSE)。

> 仓库中的域名、IP 与备份路径均为示例值（`example.com`、`192.0.2.x`、`%USERPROFILE%`）；
> 实际部署通过 `/etc/antifieldcloud/env`、`-PiHost`、`-BackupRoot` 等参数覆盖。
