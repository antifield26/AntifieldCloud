# AntifieldCloud v0.1.0 验收记录

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 Model B（8 GB）/ Debian 13 trixie / aarch64 / 64 GB SD
- 公网入口：`https://app.example.com`、`https://ai.example.com`（Cloudflare Tunnel `antifieldcloud`）
- 代码版本：`v0.1.0`（tag 指向本文件所在提交）
- 结论：**验收通过**

## 1. 自动化检查

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + `node --test`） | 通过，31/31 测试 |
| `npm run build`（Vite） | 通过，`web/dist` 产出 |
| `scripts/smoke.ps1`（公网 + Pi） | 9/9 通过 |
| systemd 崩溃自动重启（`kill -9` MainPID） | 通过，新 PID 拉起 |
| nftables 重启后规则保持 | 通过；外部 25575 阻断，22/25565 正常 |
| 备份恢复演练（全量 + 增量解包） | 通过；DB 用户 `antifield`、schema v1 完整 |

## 2. 生产验证（部署实例）

- 登录页（公网 HTTPS）经 Edge 无头渲染成功；入口脚本 `data-cfasync="false"`，Cloudflare Rocket Loader 未改写 `type="module"`。
- 使用一次性内部会话验证生产接口（验证后删除会话、purge 测试文件；当前会话 0 条遗留）：
  - `/api/auth/me`、`/api/dashboard` 200；MC 在线、opencode 可达；
  - 上传 → Range 下载 → 文本预览 → 回收站 → 彻底删除；
  - `ai.example.com` HTML 200、`/api/session` 200（Basic 注入成功）。
- 管理员 `antifield` 由本人完成密码 + TOTP 登录；审计记录 `action=login, target=totp`，会话已建立。
- 未重启 Minecraft、未修改 RCON 密码、未修改 SSH 认证；现有 `mc.example.com`（SakuraFRP）未改动。

## 3. 备份

- Windows 计划任务：`AntifieldCloud-Backup-Pull`，每日 **12:00** + 登录后 10 分钟补跑，状态 Ready。
- 手动触发一次成功：`LastTaskResult = 0`；下次运行 2026-10-20 12:00。
- 目标目录：`%USERPROFILE%\AntifieldCloudBackups`（daily/weekly）；归档 SHA-256 校验通过。
- 旧任务 `PiBackUp-Nightly` 保持原样。

## 4. 已知限制与残留风险

- RCON 密码未轮换（仅 loopback 可达）；SSH 密码登录保留（用户选择）。
- 无 Cloudflare Access；Cloudflare 可见明文；单管理员。
- SD 卡单盘、无全盘加密；备份含 TOTP secret，PC 端目录安全是最后防线。
- 无分享链接/音视频/在线编辑/WebDAV/同步客户端/版本历史。
- opencode 升级后需复测代理认证行为。

详见 [SECURITY.md](SECURITY.md) 与 [ROADMAP.md](ROADMAP.md)。

## 5. 发布

```text
tag: v0.1.0
tag message: AntifieldCloud v0.1.0
部署目录: /opt/antifieldcloud/releases/<UTC>
服务: antifieldcloud.service (enabled, active)
```
