# AntifieldCloud v0.2.2 验收记录

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.2.2`（v0.2.1 的 UI 修正热修复）
- 范围：移除自定义新会话按钮、修复 Android 原生新建按钮无响应；保留文件列表点击与 Rocket Loader opt-out

## 1. 修复

### 移除可见按钮

- 删除 v0.2.1 注入的“＋ 新会话”浮动按钮及相关样式/文案。
- 兼容垫片不再向页面添加任何 UI 元素。

### 原生“新建会话”按钮

- 在捕获阶段接管 opencode 原生 `button[aria-label="新建会话"]`（兼容 `New session`/`新会话`）的
  `click` 与 `pointerup`；调用 opencode `POST /api/session`，跳转标准
  `/server/<base64-origin>/session/<id>`。
- 不修改 opencode 服务/数据；只对已认证 HTML 注入同源外部脚本 `/__af/oc-help.js`。
- 继续为 opencode 脚本加 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写模块脚本导致
  智能体/模型选择器不渲染。

### 文件列表

- v0.2.1 的名称列按钮修复保留：文件夹进入、文件预览。

## 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 88/88、前端 23/23 |
| `npm run build` | 通过 |
| `smoke.ps1` | 16/16 |
| 生产 Health | `{"ok":true,"version":"0.2.2"}` |
| Android/宽屏移动 UA 原生按钮 | 点击产生 `POST /api/session`；进入 `/server/.../session/ses_...`；会话内模型选择器显示；页面无自定义按钮 |
| 文件列表点击 | 通过（临时文件夹已清理） |
| CI / Release | main/tag CI success；[v0.2.2 Release](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.2) |

## 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261019T150230Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T150235470Z.sqlite
服务: antifieldcloud.service (active, v0.2.2)
tag: v0.2.2 → e4d4e8d
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.2
```

## 4. 说明

- 智能体选择器在 opencode 只有单个 primary agent（当前 build）时由原生 UI 不展示；有多个 primary
  agent 时 Rocket Loader opt-out 保证其正常渲染。
- 测试用临时 app session、opencode 会话和文件夹均已清理。
- 浏览器若仍显示旧 Service Worker/bundle，请清除站点数据或硬刷新。
