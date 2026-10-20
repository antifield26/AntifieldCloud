# AntifieldCloud UI 规范（v2，2026-10-19）

## 1. 定位与基调

- 产品名：**AntifieldCloud · 个人工作台**；中文界面；暗色科技感。
- 关键词：安静、克制、信息密度适中、像可靠的个人基础设施，而不是花哨仪表盘。
- 参考感觉：Linear / Vercel 的暗色面板 + 家用 NAS 的亲和力；不使用外部字体、图片或 CDN。
- 目标设备：PC 浏览器（主）、手机（390 px 宽可用）、Pi 本机 Chromium。

## 2. 视觉系统

CSS 变量（`web/src/styles/tokens.css`）：

```css
:root {
  --bg: #0a0e14;
  --bg-elevated: #0f151d;
  --surface: #121a24;
  --surface-hover: #17212d;
  --border: #1f2b3a;
  --border-strong: #2b3b4f;
  --text: #e6edf3;
  --text-muted: #93a4b8;
  --text-dim: #6b7d92;
  --accent: #22d3ee;
  --accent-strong: #06b6d4;
  --accent-soft: rgba(34, 211, 238, 0.12);
  --success: #34d399;
  --warning: #fbbf24;
  --danger: #f87171;
  --radius: 14px;
  --radius-sm: 9px;
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  --font: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
}
```

- 背景 `--bg`；卡片 `--surface` + 1px `--border`；强调色 cyan 仅用于主按钮、选中态、进度、关键数字。
- 圆角 14/9；卡片内边距 20；桌面内容最大宽度 1320；栅格间距 16/20。
- 字号：正文 14；辅助 12.5；标题 20/16；大数字 28–34（等宽数字）。
- 图标：`lucide-react`，18–20 px，颜色随文本；不使用彩色 emoji。
- 动效：150–200 ms ease；只做 opacity/transform；尊重 `prefers-reduced-motion`。
- Logo：方形渐变（cyan→blue）+ `AC` 字母；登录页与侧栏使用。

## 3. 布局

**桌面（≥ 1024 px）**
- 左侧固定侧栏 232 px：Logo/产品名；导航（工作台、文件、回收站、Minecraft、活动）；底部用户菜单（用户名、设置、退出）。
- 主区：顶部页头（标题 + 右侧操作），内容区滚动。
- 最大宽度 1320，居中，左右 28 px。

**平板/手机（< 900 px）**
- 顶部栏：Logo + 当前页标题 + 用户菜单；抽屉式导航。
- 底部固定 Tab（工作台/文件/Minecraft/更多）可选；保证安全区 padding。
- 表格转卡片列表；操作按钮收进 `…` 菜单；上传按钮悬浮（FAB）或工具栏主按钮。

## 4. 页面

### 4.1 登录 `/login`

- 居中卡片（最大 420 px），暗色，顶部 Logo + “AntifieldCloud · 个人工作台”。
- 两步：
  1. 用户名（默认预填 `antifield`，可改）+ 密码；主按钮“下一步”。
  2. 6 位 TOTP 输入（大号等宽、自动聚焦）；主按钮“登录”；次链接“使用恢复码”。
- 恢复码模式：输入恢复码；链接“返回验证码”。
- 错误：卡片内红色提示；429 显示“尝试过多，请 X 分钟后再试”；401 统一“用户名或密码错误 / 验证码无效”。
- 成功：跳转 `next`（仅允许 app/ai 本站 URL）或 `/`。
- 底部小字：“仅限本人使用 · 所有操作均记录审计”。

### 4.2 工作台 `/`

- 页头：“工作台”，右侧显示当前时间/刷新按钮；数据 10 s 轮询（页面隐藏时暂停）。
- 顶部 4 个指标卡（2×2 移动端）：
  1. 主机：CPU %、负载、温度、内存条；温度 > 75 ℃ 变黄，> 85 ℃ 变红。
  2. 存储：配额已用/总量、进度条、文件数、回收站占用；> 90% 黄色。
  3. Minecraft：在线/离线徽章、版本、在线/上限、TPS、白名单数；离线或 RCON 降级时显示原因。
  4. 备份：最近拉取时间、大小、状态；> 48 h 红色“备份已过期”。
- 第二行：
  - Minecraft 详情卡：玩家名列表（空态“暂无玩家在线”）、TPS、服务状态、公共地址复制按钮、“管理白名单”链接。
  - 快捷入口卡：AI 工作区（`https://ai.example.com`）、RPi Connect、Minecraft 地址（复制）、云盘（本页）。
  - 服务状态卡：minecraft/cloudflared/opencode 三个圆点 + 状态文字。
- 第三行：最近活动（审计 8 条，图标 + 动作 + 目标 + 相对时间）。
- 所有卡片有 loading 骨架；错误时卡片内“加载失败 + 重试”。

### 4.3 文件 `/files`

- 页头：“文件”；右侧“上传文件”（主按钮）+ “新建文件夹”。
- 顶部：面包屑（可点击）；搜索框（300 ms 防抖，结果模式显示“搜索结果 / 清除”）；视图切换（列表/网格）。
- 配额条：已用/10 GiB + 回收站占用；接近上限变黄/红。
- 列表列：名称（图标+名称+预览标记）、大小、修改时间、操作（预览/下载/重命名/移动/删除）。
- 网格：文件卡片，图片显示缩略图（`/content?inline=1`），其他显示类型图标。
- 拖拽：整页 dropzone 高亮“松开上传到当前目录”；多文件；上传面板显示每个文件进度/成功/失败/重试。
- 新建文件夹：内联输入或 Modal；重命名 Modal；移动 Modal（目录树选择）。
- 删除确认 Modal（目录提示递归）；成功 Toast。
- 空态：图标 + “这个文件夹还是空的” + 上传按钮。
- 预览：
  - 图片：Modal 大图，Esc 关闭，下载按钮。
  - PDF：Modal 内 iframe（`/content?inline=1`），高度 80vh。
  - 文本/Markdown/代码：Modal 内等宽滚动区域；Markdown 用 marked + DOMPurify 渲染；显示“已截断”提示；复制/下载。
  - 不支持：显示文件信息 + 下载按钮。
- 错误：401 跳登录；409/413/429/507 用 Toast 说明。

### 4.4 回收站 `/trash`

- 页头：“回收站”；右侧“清空回收站”（危险按钮 + 二次确认）。
- 列表：名称、原路径、大小、删除时间、操作（恢复/彻底删除）。
- 说明文字：“回收站中的文件仍占用配额；30 天后自动清理。”
- 空态：“回收站是空的”。

### 4.5 Minecraft `/minecraft`

- 顶部状态卡：在线/离线、版本、MOTD、在线人数、TPS、服务状态、公共地址（复制）；RCON 降级时黄色提示。
- 玩家列表：在线玩家名（头像用首字母圆形）。
- 白名单管理：
  - 输入玩家名 + “添加”；校验 `^[A-Za-z0-9_]{3,16}$`；成功后列表刷新 + Toast。
  - 表格：玩家名、添加时间（若可得）、移除按钮（确认）。
  - 说明：“白名单修改立即生效；不支持启停服务器或任意命令。”
- 只读提示：本页不提供服务器启停/控制台。

### 4.6 活动 `/activity`

- 页头：“活动”；筛选下拉（全部/登录/文件/白名单）；表格：时间、动作（中文）、目标、IP、详情。
- 分页 50；空态。

### 4.7 设置 `/settings`

- 账号：用户名（只读）、修改密码（当前/新/确认）、重新生成恢复码（需密码，结果仅展示一次，提供复制/下载）。
- 会话：当前会话信息；`退出全部会话`（危险确认）。
- 关于：版本、部署环境（Pi 5 / Debian 13）、链接到文档（仓库内路径不可点则显示文本）。
- 安全说明：TOTP、备份含敏感数据、Cloudflare 可见明文。

## 5. 组件与状态

- `Button`（primary/secondary/ghost/danger，loading/disabled）
- `Card`（title/actions/body，loading skeleton）
- `Stat`（label/value/unit/hint/tone）
- `Badge`（success/warning/danger/muted）
- `Modal`（焦点陷阱、Esc、遮罩）
- `Toast`（成功/错误/信息，4 s 自动消失，可手动关闭）
- `ConfirmDialog`
- `EmptyState`
- `ProgressBar`（上传/配额）
- `Table`（移动端卡片化）
- `Skeleton`
- `CopyButton`（复制成功反馈）
- `FileIcon`（按 mime 扩展名）
- `RelativeTime`（“3 分钟前”，title 显示绝对时间）
- 所有异步操作有 loading；按钮提交期间禁用；网络错误统一 Toast。

## 6. 文案与本地化

- 全部中文；技术名词保留英文（TOTP、RCON、TPS、SHA-256、opencode）。
- 语气简洁、陈述式；不卖萌、不感叹号堆叠。
- 时间：`Asia/Shanghai`，绝对时间 `YYYY-MM-DD HH:mm`；相对时间用于列表。
- 空态/错误文案必须给出下一步动作（重试/返回/上传）。

## 7. 可访问性

- 键盘可达；Modal 焦点陷阱；Esc 关闭。
- 对比度 ≥ WCAG AA；焦点环 `outline: 2px solid var(--accent)`。
- 图标按钮有 `aria-label`；表单 label 关联；错误用 `role="alert"`。
- 不用颜色作为唯一状态信号（徽章带文字）。

## 8. 前端工程

- React 19 + TypeScript + Vite；`react-router-dom` 路由；无 UI 框架、无 Tailwind；手写 CSS（tokens + 页面/组件样式）。
- 图标 `lucide-react`；Markdown `marked` + `dompurify`。
- API 客户端：`fetch` + `credentials: 'include'`；自动附带 `X-CSRF-Token`；`401` 统一跳登录；`/api/auth/me` 启动时恢复会话。
- 上传：`XMLHttpRequest` 以获得进度；并发 2；失败可重试。
- 目录结构：
  ```text
  web/src/
    main.tsx  App.tsx  api/client.ts  api/types.ts
    auth/AuthContext.tsx
    components/  pages/  styles/
  ```
- 构建必须通过 `tsc -p web/tsconfig.json` 与 `npm run build`；产物 `web/dist`。
- 不引入运行时外部资源（字体/图标 CDN/图片）。

## 9. 验收（界面）

- 390 px 与 1440 px 下无横向滚动；导航可用。
- 登录两步、错误提示、恢复码可用。
- 上传进度、预览三种类型、搜索、回收站恢复可完成。
- Dashboard 数据/降级状态/刷新正常；白名单增删有反馈。
- 键盘可完成登录、打开弹窗、关闭弹窗。

## 10. v0.2.x 新增界面

### 知识库 `/knowledge`

- 主导航新增“知识库”；顶部 Tabs“笔记/书签”；搜索框 + 标签筛选 + 置顶/分页。
- 笔记：左侧列表面板，右侧标题 + Markdown 编辑/预览切换 + 标签 + 置顶 + 保存/删除；移动端上下堆叠。
- 书签：卡片/列表；新建/编辑弹窗含 URL/标题/描述/标签/置顶；外链新窗口打开并带 noopener。
- 空态/骨架/错误重试；Markdown 只读预览，禁止 style/script/iframe。

### 文件分享

- Files 行操作“分享”打开 ShareDialog：密码（可选，≥4）、有效期（默认 7 天/最长 30 天）、最大下载次数（留空=不限）、备注。
- 创建成功只展示一次链接 + 复制按钮；关闭前提示“链接只显示一次”。
- `/shares` 管理页：文件名、状态、过期/次数、创建时间、吊销；不展示 token。
- `/s/:token` 公开页：独立布局、无登录导航、noindex；文件名/大小/过期/次数/密码输入/下载；410 显示具体失效原因，404 显示不存在。

### PWA / 手机

- `manifest.webmanifest` + 图标；安装提示在 Settings/About 与底部；可关闭并记忆。
- Service Worker 只缓存静态壳/资源/offline/manifest/图标；绝不缓存 `/api/*`、`/s/*`、文件内容。
- Files 增加“拍照上传”（`accept=image/* capture=environment`）；390px 无横向滚动。

### 告警

- Dashboard“告警”卡片：当前 active 条件、最近历史、webhook 状态、严重度中文标签。
- Settings“监控告警”：只读阈值/检查间隔/webhook 是否配置/最近评估；“测试 Webhook”按钮（POST /api/alerts/test）。
- 未配置 webhook 时仍显示面板告警，不阻塞。

## 11. v0.2.x 交互修复

- Activity 使用服务端 action 精确筛选/分页；审计动作中文名与真实 action 对齐。
- Files/搜索/Trash 请求可取消，旧响应不会覆盖新目录。
- 上传逐文件取消/超时（15 分钟）/卸载 abort；恢复码弹窗复制/下载前禁止误关。
- 改密/恢复码表单含 TOTP；密码 ≥12；429 显示 `details.retryAfterSec`。
- `/api/version` 元数据驱动域名、回收站天数、上传上限、功能开关。
- a11y：移动抽屉焦点陷阱、Dropdown 方向键、FormField aria-required、ConfirmDialog describedby、NotFound 标题。
- OpenCode Web（v0.2.2）：不展示自定义“新会话”按钮；代理只接管原生按钮 click/pointerup，并 opt-out Rocket Loader 改写模块脚本。

## 12. v0.3.0 新增界面

### 备份与恢复

- Dashboard 备份卡：最近拉取、待确认归档、密钥包状态、异常提示与“管理备份”。
- Settings“备份与恢复”：归档列表（模式/时间/大小/SHA 前缀/状态/来源）、刷新、上传（≤100 MiB，TOTP）、校验、恢复入口。
- 恢复向导三步：选择归档/文件 → 校验摘要 → TOTP + typed confirmation（`RESTORE`）→ 结果；执行中锁 Esc/遮罩、失败可重试；仅恢复到新目录，不覆盖。
- 危险操作默认焦点“取消”；TOTP `autocomplete=one-time-code`；390px 卡片化/全屏向导、footer sticky。

### 音视频播放

- Files 预览新增原生 `<video controls playsInline preload=metadata>` / `<audio controls>`，`/content?inline=1`；支持 Range/seek。
- 不支持格式/mkv/avi 回退下载；错误区分格式、网络、415/416；不缓存媒体、不做转码、不引入外部播放器。
- 移动端视频 16:9，播放器原生控件；表格/卡片仍可下载。

### OpenCode 兼容

- `OPENCODE_HTML_MODE`：`shim`（默认）、`attributes`（只 opt-out Rocket Loader）、`passthrough`（无垫片，需 Cloudflare 关闭注入）。
- 无垫片验证通过后不再注入任何脚本；失败时只保留最小隐藏 click/pointerup 接管，不添加可见按钮。
- 代理返回 `x-af-oc-mode` 诊断头；Cloudflare 后台规则见 DEPLOY。

### 分享/PWA

- 公开分享不展示“仅自己可见”备注；一次性 URL 创建成功后禁止误关。
- PWA 缓存名随构建版本更新并清理旧缓存；SW 仍不缓存 API/媒体/文件内容。

## 13. v0.3.1 大文件分片上传

- `/api/version` 的 `chunkedUploadEnabled/chunkSizeBytes/chunkMaxFileBytes` 驱动前端；未下发时保持单请求上传。
- 文件大小 > `maxUploadBytes`（普通 multipart 上限）且 ≤ 5 GiB 时自动走分片，块默认 8 MiB，每文件独立队列任务。
- 上传面板复用现有进度/取消/重试：显示总进度百分比；断点记录只存 uploadId/已收块号到 localStorage，不缓存文件内容。
- 刷新/断线后同一文件（名称+大小+lastModified+目录）自动查询服务端状态并只补缺块；服务端会话过期则重新 init。
- 取消保留断点供重试；服务端 24h 后清理会话与临时块。390px 面板不横向滚动。
- 单请求仍受 100 MiB/Cloudflare 代理限制；分片块 8 MiB 远低于限制，5 GiB 文件约 640 块。
