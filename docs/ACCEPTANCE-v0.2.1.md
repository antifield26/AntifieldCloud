# AntifieldCloud v0.2.1 验收记录

> **已被 v0.2.2 取代**：v0.2.1 注入的可见“＋ 新会话”按钮已在 v0.2.2 移除，改为只接管原生按钮。
> 本文件保留为历史记录；当前验收见 `docs/ACCEPTANCE-v0.2.2.md`。

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.2.1`
- 范围：v0.2.0 已知问题修复（文件列表点击、OpenCode Web 移动端/选择器）

## 1. 修复内容

### 文件页列表视图

- 名称列由静态 `div` 改为可访问的 `<button>`；文件夹点击进入，文件点击预览。
- 桌面表格与移动卡片共用；操作列仍是独立按钮，不触发误进目录。
- 保留网格视图原有行为。
- 生产验证：临时创建文件夹 `v021-click-test`，桌面列表点击名称后 URL 变为
  `/files?parent=<id>`；测试后已移入回收站并彻底删除。

### OpenCode Web

- **Rocket Loader 根因**：Cloudflare 把 opencode 的 `type="module"` 改写成随机 type 并延迟执行，
  导致智能体/模型选择器与新建按钮失效。
- 代理注入 HTML 时为 opencode 所有脚本加 `data-cfasync="false"`，并注入同源外部兼容脚本
  `/__af/oc-help.js`（不违反 opencode CSP `script-src 'self'`）。
- 移动端（含 Android UA）显示“＋ 新会话”浮动按钮；调用 opencode `POST /api/session` 后跳转标准
  `/server/<base64-origin>/session/<id>`。
- 桌面端“新建会话”按钮由捕获阶段接管，修复点击无响应。
- 生产验证（Android UA、390×844、临时 session，测试后删除）：
  - 首页出现“＋ 新会话”；
  - 点击后 URL 进入 `/server/.../session/ses_...`；
  - 会话输入框出现模型选择器 “MiniMax M3.1 Flash Free”；
  - 测试 session 已删除，临时 app session 已从 DB 删除。
- 说明：智能体选择器只在 opencode 存在多个 primary agent 时由原生 UI 展示；当前配置的 primary
  agent 为 build，其他为 subagent。本次修复保证有可选智能体时不再被 Rocket Loader 隐藏。

## 2. 自动化与冒烟

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + node:test + Vitest） | 通过；服务端 88/88、前端 23/23 |
| `npm run build` | 通过；PWA 静态资源完整 |
| `scripts/smoke.ps1`（公网 + Pi） | 16/16 通过 |
| `GET https://app.antifield.work/healthz` | `{"ok":true,"version":"0.2.1"}` |
| 生产文件列表点击 | 通过（临时文件夹，已清理） |
| 生产 OpenCode Android UA | 通过（临时 session，已清理） |

## 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261019T143637Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T143640775Z.sqlite
服务: antifieldcloud.service (active, v0.2.1)
tag: v0.2.1 → 57cb8d0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.1
```

## 4. 注意

- 生产测试使用的临时 app session 已删除；临时文件夹已彻底删除；测试 opencode 会话已删除。
- 若浏览器仍加载旧 Service Worker/旧 bundle，请 Ctrl+F5 或清除站点数据后刷新。
- Cloudflare 仍会注入 Web Analytics/Challenge 脚本，严格 CSP 下可能控制台报错；不影响本次修复。
- 大文件仍受 Cloudflare 约 100 MiB/100s 限制；SSH 密码登录、无 Cloudflare Access 等 v0.2.0 残留不变。
