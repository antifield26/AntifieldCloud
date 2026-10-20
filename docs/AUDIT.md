# AntifieldCloud 审计与修复记录（v0.2.0 / 第二轮 v0.3.x）

> 本文件补齐 2026-10-20 未落档的第二轮审计记录；第一轮 v0.2.0 记录保留在下方。

- 日期：2026-10-19（第一轮）、2026-10-20（第二轮）
- 范围：v0.1.0 全部代码、部署脚本、备份、Pi/Cloudflare、前端与测试；第二轮覆盖 v0.2.2 基线与 v0.3.0/v0.3.1 增量
- 方法：只读静态审查 + 进程内 PoC + 只读线上检查 + 回归测试；审计阶段未修改生产。
- 结果：第一轮 P0/P1 已修复；第二轮审计范围内无未关闭 P0/P1，残留见各节“延后/残留”。

## 第一轮（v0.2.0，2026-10-19）

### 1. 审计发现与处置

#### 安全/可靠性（P0）

| 发现 | 影响 | 处置 |
|---|---|---|
| 未认证 WebSocket upgrade + 畸形 `Cookie` 可触发 `URIError` 打死进程 | 远程整站 DoS | Cookie 安全解码；upgrade 全 try/catch；`uncaughtException` 兜底；回归测试 |
| 改密/恢复码接口无再认证限流、无失败审计 | 会话泄露后可爆破密码/永久接管 | 要求当前密码 + TOTP；IP/全局/TOTP 限流；失败审计；恒定延迟 |
| 备份在 PC 拉取前推进游标，scp 失败可删唯一增量 | 备份链断档/丢文件 | 两阶段 `--prepare/--pending/--ack`；未 ack 不删；PC 重试同一归档 |
| 备份目录 ACL 继承 Authenticated Users/Users | 本机账户可读 TOTP secret/文件 | 安装脚本 `icacls` 收紧为当前用户+Administrators+SYSTEM |
| 恢复命令多源 `cp db-*.sqlite` 必失败 | 灾备不可执行 | 文档改为按 manifest 选最新 DB；补演练模板 |
| env/隧道凭证不在备份 | SD 损坏后不可重建 | age 加密密钥包 + 离线私钥 + 恢复文档 |
| 部署无自动回滚、迁移前无 DB 快照 | 坏 release/迁移不可恢复 | 健康失败自动切回；切换前 `--snapshot-db`；保护 current/previous |
| `cgroup_disable=memory` 使 `MemoryMax=512M` 无效 | 资源限制虚假/ OOM 风险 | 追加 `cgroup_enable=memory` 并重启验证，`MemoryCurrent` 已生效 |
| Cloudflare 约 100MB 请求体 vs 2GiB 声明 | 大文件公网必失败 | 统一 100 MiB；文档/前端/验收更新；大文件列入后续 |
| 备份任务重装漏传 `-PiHost` | 重装后备份指向示例地址 | 任务参数显式传 `-PiHost/-PiUser/-BackupRoot` |

#### 安全/正确性（P1）

- `trustProxy:true` + 直接信任转发头：改为 `trustProxy:false`，仅 loopback 对端采信 Cloudflare 头；
  `X-Forwarded-Host` 不参与安全判断；限流/审计/Cookie/CSRF 统一 `requestMeta`。
- RCON 只读首包，大响应截断：循环读取多包、1MiB 上限、超时/关闭不挂起。
- 并发上传可临时突破配额/磁盘、ENOSPC 误映射：全局预留、statfs 余量、507、tmp 清理。
- 错误处理回显内部 message/路径：FST/4xx 白名单、通用文案；ENOSPC 映射。
- 登录限流 Map 无上限：容量上限/LRU/过期清理；TOTP 全局限流。
- CSRF Cookie 丢失后写操作永久失败：`/api/auth/me` 自动轮换补发。
- HSTS/AI/PDF 安全头缺失：补齐；HSTS 不带 includeSubDomains。
- 审计动作名与前端映射不一致、Activity 过滤失效：统一真实 action；服务端筛选/分页。
- Files/Trash 请求竞态：AbortController/requestId；上传取消/超时。
- 改密前端 8 位 vs 后端 12 位：统一 12；TOTP 字段。
- Markdown 可注入 style（CSS injection）：DOMPurify 禁 style 标签/属性。
- 恢复码弹窗误关即丢、next-url loopback 过宽、域名硬编码、Minecraft 刷新无 force、
  回收站/上传上限未下发、429 details 未解析、a11y 缺口：逐项修复。
- 备份任务电池跳过、漏周日全量、半成品/SHA、非幂等重试、bootstrap 重置域名、路径文档矛盾：
  修复并更新 `docs/BACKUP.md`/`docs/DEPLOY.md`。
- 安全更新缺失、cloudflared 沙箱/版本、rpcbind、nftables 范围、CI 不覆盖运维资产：
  已安装安全更新/`unattended-upgrades`；其余见残留。
- `http-proxy` Node 26 弃用警告、scrypt N=2^15、Cookie 父域共享、host-only 改造：
  记录为后续，不在 v0.2.0 破坏性改动。

## 2. 回归测试

- 服务端：86 个 `node:test`（认证/限流/CSRF/上传/RCON 多包/分享/笔记/告警/备份/代理）。
- 前端：23 个 Vitest（next-url、审计映射、错误解析、上传取消/超时、Markdown 净化）。
- 新增关键用例：C1 畸形 Cookie、account reauth、trustProxy、requestMeta、RCON multipacket、
  files resilience、notes、shares、alerts、HTTP hardening。
- `npm run check` 全绿；`npm run build` 成功。

## 3. 线上验证

- Pi 重启后 5 服务 active；v0.2.0；schema 2；RCON 新密码可用。
- memory cgroup 生效；health probe 写入欠压/温度/风扇 JSON。
- `smoke.ps1` 16/16；公网 PWA/分享/告警端点正常。
- 备份两阶段手动全流程通过；ACL/任务参数更新；密钥包生成/解密验证。
- 待用户完成：公网登录/改密、手机 PWA、分享手机打开、webhook 实际投递、正式恢复演练。

## 4. 延后/残留

- 分享下载次数为会话级近似；目录分享、笔记附件/版本历史、音视频、WebDAV、多用户、Cloudflare Access 不做。
- SSH 密码登录保留（用户选择）；cloudflared systemd 沙箱/版本升级后续。
- Cloudflare 注入与严格 CSP 冲突需后台关闭自动注入或接受控制台错误。
- Node 27 前评估 `http-proxy` 替换；scrypt 升级需要密码哈希版本迁移。
- 单 SD 卡、无全盘加密；备份依赖 PC 与直连网线。

## 第二轮（v0.2.2 → v0.3.x，2026-10-20）

### 0. 执行方式与记录边界

- 目标：在 v0.2.0 首轮审计之后，对 v0.2.2 生产基线与 v0.3.0 增量做第二轮只读审计，覆盖服务端、前端、备份脚本、部署与 Pi/Cloudflare。
- 方式：并行只读审计（server/web/ops 三个方向）+ Lead 集成复核 + 本地 PoC/回归测试 + 生产只读检查；审计阶段未修改生产。
- 记录边界：部分审计子代理在交付最终报告前异常退出；本记录以实际任务范围、代码 diff、测试结果和生产证据为准，**不替代**独立第三方审计。后续如需第三方结论，应重新执行一次独立复审。
- 证据提交：`9ed8d3d`（v0.3.0）、`4f26019`（v0.3.1）；验收见 `docs/ACCEPTANCE.md`；发布 v0.3.0/v0.3.1。

### 1. 审计范围

- 服务端：备份管理/文件级恢复、分享/回收站、告警状态机、上传配额与错误映射、日志脱敏、OpenCode 代理。
- 前端：备份/恢复向导、媒体预览、分享弹窗/公开页、审计动作映射、PWA 缓存、上传取消/超时，以及 v0.3.1 分片续传。
- 运维：两阶段备份链、Windows 拉取脚本、age 密钥包、systemd/nftables/cloudflared、RTC/日志持久化、Cloudflare 注入与 OpenCode HTML 模式。
- 数据：schema v2→v3→v4 的追加迁移、tar 不可信输入、恢复链与不覆盖语义。

### 2. 发现与处置

| ID | 级别 | 发现/影响 | 处置 | 证据 |
|---|---|---|---|---|
| A2-01 | P0 可靠性 | 备份任务 SSH 在直连抖动时可能无限挂起；secrets 失败被文件归档成功掩盖 | 每条 SSH/SCP 硬超时、`ssh -n`、远端 `timeout`；`secretsOk/lastSecretsError` 独立状态；失败可告警 | `scripts/backup-pull.ps1`、`server/src/dashboard/service.ts`、`server/test/alerts.test.ts`；H1 任务实测 |
| A2-02 | P0 完整性 | legacy 无参备份可能隐式 ack/推进游标；孤儿归档与磁盘占用不可见 | 必须显式 `--legacy`；pending/孤儿/已确认归档空间统一报告，不自动删敏感归档 | `server/src/cli/backup.ts`、`server/test/backup-cli.test.ts` |
| A2-03 | P1 凭证 | 密钥包未覆盖 opencode DB/config；明文临时目录/公钥权限校验不足 | opencode 一致性 DB 快照 + config 入 age 包；0700 临时目录、公钥属主/权限、trap 清理 | `scripts/backup-secrets.sh`；生产密钥包 1.3 MB 含 opencode |
| A2-04 | P0 安全 | 文件删除/移入回收站后，旧分享仍可下载 | 分享读取校验 `files.deleted_at` 返回 410；删除事务内吊销分享；失败路径测试 | `server/src/shares/service.ts`、`server/src/http/routes/shares.ts`、`server/test/share-v03-fixes.test.ts` |
| A2-05 | P1 安全/审计 | 分享下载审计可被放大；公开备注泄露；token 进入日志 URL；密码下限过低；过期/吊销行无 GC | 审计按 share/会话/IP/时间窗节流；公开不返回 note；日志脱敏 `/s/`/公开分享路径；密码≥8；GC/分页 | `server/src/logger.ts`、`server/src/http/routes/shares.ts`、`server/test/logger-v03-redaction.test.ts` |
| A2-06 | P1 可靠性 | 告警数据源 unknown/stale 反复触发；事件与状态非原子；无保留策略；密钥包失败无告警 | unknown 连续评估后降级/恢复；事件+状态事务化；90 天保留；新增 secrets 条件（共 9 条） | `server/src/alerts/service.ts`、`server/test/alert-v03-resilience.test.ts` |
| A2-07 | P1 安全 | Web 导入归档是不可信 tar；恢复可能覆盖生产文件 | 文件名白名单、流式 SHA、拒绝路径穿越/链接/设备/超大条目；恢复仅到新目录、不覆盖、TOTP + `RESTORE`、30 分钟计划过期 | `server/src/backups/tar.ts`、`server/src/backups/service.ts`、`server/test/backups-*.test.ts` |
| A2-08 | P1 功能/安全 | 音视频内联缺 CSP/Range 白名单；shim 无垫片边界不清 | 白名单容器、`media-src 'self'`、Range/HEAD/416、不转码；新增 `shim/attributes/passthrough`，Cloudflare 规则后实测 | `server/src/files/mime.ts`、`server/src/app.ts`、`server/src/opencode/proxy.ts`；生产 mp3 实测 |
| A2-09 | P1 运维 | journald volatile、cloudflared 旧版且无沙箱、nft WiFi 源 `/16`、rpcbind 0.0.0.0、RTC 无电池 | persistent journald（log2ram 64M）、cloudflared 2026.10.1 + drop-in、nft 收窄 `/21`、rpcbind 禁用、fake-hwclock 启用；RCON bind 无上游配置，保留 nft drop | `docs/DEPLOY.md` §9.1；生产 systemd/nft/端口检查 |
| A2-10 | P1 功能/安全 | 100 MiB 单请求无法承载 5 GiB 文件；分片需防越界/重复/配额穿透 | 新 `uploads/` 服务与 migration 4；8 MiB 块、服务端校验序号/大小/哈希、配额预留、24h 过期、3 并发、complete 拼接后走同一登记 | `server/src/uploads/service.ts`、`server/src/http/routes/uploads.ts`、`server/test/uploads-*.test.ts`；生产 12 MiB 实测 |

### 3. 回归测试与线上证据

- v0.3.0：服务端 140/140、前端 48/48；v0.3.1：服务端 150/150、前端 52/52；`npm run build` 通过，CI main/tag 均 success。
- `smoke.ps1` 16/16；生产 v0.3.1、schema v4；备份 pending/ack、媒体 inline/Range、12 MiB 分片 API 实测。
- OpenCode 无垫片：Cloudflare 关闭 `ai` Rocket Loader 后，passthrough HTML 模块脚本未被改写；但无 JS 的 attributes/passthrough 仍无法触发上游原生新建会话，按约定保留最小隐藏 click 接管（无可见按钮），记录在 `docs/ACCEPTANCE.md` 与 v0.3.0 Release。
- 密钥包、备份链、告警状态、分享 410、分片哈希/断点/过期均有对应自动化测试；真实敏感数据未进入测试。

### 4. 残留与延后

- OpenCode 原生“新建会话”按钮缺陷仍在上游；升级后需复测，若上游修复则删除隐藏接管。
- RCON 仍监听所有接口（Paper 无 bind 配置），仅由 nftables 阻断非 loopback。
- age 私钥需用户移到离线介质并删除本地副本；这是用户手动步骤，Agent 不代替。
- Minecraft 世界未纳入备份；5 GiB 仅做逻辑/上限/12 MiB 实测，未跑满公网带宽。
- Cloudflare Web Analytics 自动注入未关闭时仍会被严格 CSP 拦截；不影响功能。
- 单 SD 卡/无全盘加密、单管理员、无限流持久化等既有风险保留。
- v0.3.2 已关闭旧入口/旧 TLS 残留：nginx/certbot 及 `/etc/nginx`、`/etc/letsencrypt`、80 端口移除；服务监控降为 minecraft/cloudflared/opencode。

### 5. 结论

- 第二轮审计范围内未发现未关闭的 P0/P1；A2-01/A2-04 属最高风险项，已修复并有回归测试。
- 备份链、分享撤销、告警状态、tar 恢复、分片上传是后续回归重点；每次部署后跑 `npm run check` + `smoke.ps1`。
- 本轮审计记录为**补档**，不能替代独立第三方审计；下一轮应在发布前保留各审计子任务的最终报告原文。

## 第三轮（v0.3.2 → v0.4.0，2026-10-20）

### 0. 执行方式与记录边界

- 范围：v0.3.2 基线 + v0.4.0 增量（迁移 5 结构变更 + 迁移 6 孤儿分享数据修复、笔记附件/版本、多文件分享、指标、世界备份/演练、状态 API）。
- 方式：4 个独立子审计员并行只读审计（服务端安全、服务端数据/可靠性、前端/契约、运维/CI/脚本），Lead 做架构复核、修复排期与最终集成；审计阶段未修改生产，Pi 仅执行只读命令。
- 证据：静态审查 + 进程内 PoC + 既有测试；修复以 `npm run check`、新增回归测试、迁移测试与生产验收为准。
- 边界：审计期间工作树被 v0.4.0 实现并发修改，部分发现基于中间快照；最终修复后由 Lead 对 P0/P1 做定向复核。本记录不替代独立第三方渗透测试。

### 1. 评分卡（1–5）

| 维度 | v0.3.2 基线 | v0.4.0 修复后 | 主要依据 |
|---|---|---|---|
| 架构设计 | 4 | 4 | 模块边界清晰；新增 metrics/状态文件为独立模块；backups/alerts 仍偏大，module split 列后续 |
| 功能完整度 | 3 | 4 | 指标历史/筛选、笔记附件/版本、多文件分享、世界备份/演练补齐；目录分享/笔记公开分享仍缺 |
| 安全设计 | 4 | 4 | 认证/CSRF/路径/tar 扎实；修复审计日志膨胀、限流锁死、AI 反代 Origin、快照行数/staging 上限；SSH/sudo 暴露面按用户选择仅披露 |
| 可靠性/数据完整性 | 3 | 4 | 上传耐久性、备份 pending origin、ack 事务、链解析、恢复 origin/空间、状态可见性修复；DR-1 时钟水位、导入归档保留、告警重投仍残留 |
| 测试与 CI | 3 | 4 | 服务端 214、前端 129、脚本 16；新增覆盖率门禁、`npm audit`、gitleaks、Dependabot、systemd/nftables/PowerShell 检查 |
| 可维护性/运维 | 3 | 4 | 版本单源、部署回滚还原 DB、UTF-8 修复、smoke 版本断言、systemd 加固、nftables 收窄、文档漂移修正 |

**综合：v0.3.2 约 3.2/5 → v0.4.0 约 4.0/5**（运维审计基线 3/5、数据 2.5/5、前端 3/5、安全 3.5/5；均为各自维度的独立评分）。

### 2. 发现汇总与处置

#### 2.1 运维/CI/脚本（OP-01～OP-25）

| 级别 | 代表问题 | 处置 |
|---|---|---|
| P0 | `antifield` 拥有 `(ALL) NOPASSWD: ALL`、SSH 密码登录、22 全源放行 | **按用户选择仅文档披露**（不改 SSH/sudo）；SECURITY/DEPLOY 记录为残余风险与收敛建议 |
| P0 | 旧世界 cron 无 `save-off/save-all`、`tar && mv` 在 tar 退出 1 时静默不产出、失败累积 3.2GB tmp | 新增 root 世界备份脚本（固定 RCON save-off/save-all flush/save-on finally、tar 0/1 容忍、gzip 校验、SHA/状态、保留 4、空间预检）；验收后停用旧 cron |
| P1 | `bootstrap-env.sh --force` 丢未知键（含恢复开关/webhook/新键） | 已修：保留未知键、补 v0.4.0 键、删除 0.2.0 兜底 |
| P1 | 版本 5 处重复、deploy 不注入/不校验 `APP_VERSION` | 已修：package.json 单源；deploy 注入并断言 `/healthz.version` |
| P1 | 自动回滚不还原迁移前 DB 快照 | 已修：stop→还原快照（含 -wal/-shm）→切 release→start；无快照拒绝自动回滚 |
| P1 | PS 5.1 按 GBK 解码 UTF-8 导致备份 3 连败 | 已修：所有 ps1 设置 UTF-8 输出编码、`--no-warnings`、ASCII 状态码、剥非 ASCII 兜底 |
| P1/P2 | 备份状态写失败触发整轮重试→重复 prepare；secrets 立即删远端；icacls 未校验；job 超时不杀进程树 | 已修：状态写 finally/幂等、重试跳过已 ack、secrets KEEP=2、icacls 全 ACE+版本标记、Start-Process/taskkill 杀进程树 |
| P2 | systemd 加固缺口、nftables 22 全源/25565 link-local 过宽、journald 仅当前 boot、smoke 不校验版本/secrets/世界状态 | 已修：app/world unit 加固；nftables 22 与 25565 收窄到直连/校园网并限速；smoke 增加版本/systemctl/secrets/world/drill/脚本 hash；journald 列后续 |
| P2 | CI 缺覆盖率/依赖审计/密钥扫描/Dependabot、无 timeout/concurrency | 已修（见 2.5） |
| P3 | 旧 9GB 归档、孤儿归档权限、`check-prod-deps` 不启动、npm 指向 nvm 等 | 记录；孤儿归档人工清理；npm 预检与文档提示已加，nvm 清理禁止项入 DEPLOY |

#### 2.2 服务端安全（SA-01～SA-16）

| 级别 | 问题 | 处置 |
|---|---|---|
| P2 | 未认证审计日志膨胀（username 无长度、audit 行可达 1MiB） | 已修：username≤64、audit actor≤64/target≤256/detail≤4KiB、列表返回再截断；测试覆盖 |
| P2 | 全局密码/TOTP 限流可被单 IP 占满锁死管理员 | 已修：全局阈值 60/h、120/h，loopback 不占桶；每 IP 仍 5/15min；残余分布式限流风险记录 |
| P2 | 恶意归档 SQLite 无行数上限、entries 无限流、staging 绕过磁盘预检 | 已修：fast snapshot 100k 行上限、DB 大小上限、entries 30/min、staging ≤2GiB/20%、实际 stat 磁盘预检；超限 422/429/507 |
| P2 | AI 反代缺 Origin/WS Origin，兄弟子域 Cookie 可跨站 | 已修：ai HTTP/WS 校验 Origin（loopback 开发例外），非法 403+审计；长期 host-only Cookie/签名票据列后续 |
| P3 | 分享解锁 oracle、备份 TOTP 失败无审计、OPENCODE_URL/COOKIE_DOMAIN 校验、XFF 透传、空 Host、状态文件无大小上限 | 部分修（状态文件 64KiB 上限/字段白名单、错误文案脱敏）；其余记录 |

#### 2.3 服务端数据/可靠性（DR-1～DR-25）

| 级别 | 问题 | 处置 |
|---|---|---|
| P1 | 备份 pending 混入 Web 导入归档→每日备份卡死/增量漏文件 | 已修：CLI/dashboard/alerts 统一 `origin='pi'`；测试导入后 pending=0 |
| P1 | 分片上传 parent 判断 `folder`≠`dir`，无法传入目录 | 已修 + 目录用例 |
| P1 | 上传先 DB 后落盘、无 fsync，断电出现“有行无文件”并卡死备份 | 已修：temp fsync→rename→父目录 fsync→提交 DB；备份预检跳过缺失并记 skippedMissing |
| P1 | skippedMissing 未阻止水位、恢复不消费 | 已修（第三批）：meta 记录缺失文件、恢复纳入/报告，游标不越过 |
| P2 | Web prepare 10min 超时/陈旧锁、ack 非事务、tar 残片、导入无保留 | 主要已修（prepare 超时可配、锁 stale 接管、ack 事务、残片清理）；导入归档删除/保留列后续 |
| P2 | registerUpload TOCTOU 并发同名/父目录回收站、上传会话过期/双重释放、缺块重传 | 已修：事务内重算/重校验、过期检查、release 只对预留、缺块 stat 修复 |
| P2 | 恢复链混 origin、prune 误删唯一 full、恢复 origin 未过滤、2× 磁盘 | 已修：链按来源解析、保留 full、恢复排除 note/system、2× 空间预检 |
| P2 | 迁移回填 FK 孤儿、schema_version 超前静默启动、维护任务串行、emptyTrash 嵌套 | 已修：`WHERE EXISTS` 回填 + foreign_key_check、超前版本拒绝启动、维护任务独立 try、notFound 视为已删 |
| P2 | 分享下载计数在流发送前消耗 | 已修：流成功完成后再计数/审计 |
| P2/P3 | 增量时钟回拨水位（DR-1）、导入归档无删除/保留（DR-7）、告警未投递重试（DR-22）、锁心跳（DR-23）、origin 扩展/旧 release 回滚（DR-25）、listTrash N+1（DR-17）、chunk 目录孤儿（DR-24） | 部分修复/记录；见 §4 残余 |

#### 2.4 前端/契约/可维护性（WE-01～WE-24）

| 级别 | 问题 | 处置 |
|---|---|---|
| P1 | metrics 测试与实现 0 语义冲突；多文件分享 API 先行但公开页单文件 | 已修：测试统一；公开页多文件清单+逐项下载、Shares itemCount |
| P2 | totalSizeBytes 缺失、审计动作映射漂移、嵌套 Modal 焦点陷阱、备份状态 UI 空白、分片会话无法放弃、Files 用 dashboard 取配额、RelativeTime 每行定时器/Dashboard 1s 重渲染、附件单请求无逐项进度 | 全部已修（totalSizeBytes、audit 映射、Modal 栈、BackupStatusCard、放弃并清理、/api/storage、共享时钟+memo、逐文件附件上传） |
| P3 | eslint react-hooks/jsx-a11y、深链滚动、分享分页、fetch 超时/竞态、分片幂等、bundle lazy、外链图片 CSP、错误码映射、UI-SPEC 漂移 | 部分修（外链图片占位、错误码、UI-SPEC 同步）；其余记录 |

#### 2.5 测试与 CI 基线

- `npm run check`：服务端/脚本 234（服务端 218 + 脚本 16）、前端 129，全绿；`npm run build` 通过。
- 新增 `npm run test:coverage`（服务端 lines 75/functions 75/branches 65）与 `test:web:coverage`（35/30/33），当前实测服务端 91.7/86.7/77.4、前端 36.6/31.5/34.2。
- CI：check、coverage、prod-dependencies、audit（`npm audit --omit=dev --audit-level=high`）、secret-scan（gitleaks）、shellcheck、nftables、PowerShell BOM/语法；新增 Dependabot（npm + actions，月度）、concurrency/timeout。
- 迁移测试：v4→v6（v5 结构 + v6 孤儿 shares 数据修复；origin 默认 user、索引含 origin、share_items 回填、新表存在、v4 数据不丢）。

### 3. 生产只读事实（审计证据摘要）

- Pi `antifield@169.254.77.10`，Node v26.11.1，app v0.3.2 active，schema v4，release `20261020T102328Z`，磁盘 58G/25G 用/31G 余。
- 世界 4.1 GiB（压缩约 3.0 GiB）；旧 cron 每日 23:00 无 save-off，保留约 3 份/9 GiB；RCON 25575 loopback 可达。
- `antifield` sudo NOPASSWD ALL、SSH 密码登录、22 全源；nftables 生产 22 全源、25565 限 link-local/校园 `/21`。
- 应用数据 `/var/lib/antifieldcloud` 0750 antifieldcloud:antifield；`backups` 2770；`backup-pull.json` 正常，`secretsOk=true`；PC `D:\Backups\AntifieldCloud` 有 daily/weekly/secrets + `.sha256`。
- Windows 任务 `AntifieldCloud-Backup-Pull` Ready，LastResult=0；备份日志含 09:21–09:23 UTF-8 解码失败记录（已在 v0.4.0 修复）。

### 4. 残余风险（明确本轮不修/后续）

1. **SSH/sudo 暴露面（OP-01）**：`antifield` NOPASSWD ALL + 密码登录 + 22 全源。用户选择仅文档披露；建议后续收敛 sudo allowlist、公钥登录、fail2ban。nftables 已收窄 22 与 25565 来源。
2. **RCON 仍监听 0.0.0.0**：Paper 无 bind 配置，仅 nftables 阻断非 loopback。
3. **备份增量时钟水位（DR-1）**：`created_at` 回拨/同毫秒可能漏备；依赖 NTP + 每周 full；未引入独立 backed_up 标记。
4. **导入归档保留（DR-7）**：Web 导入归档无删除/自动保留策略，需人工清理；空间预算未纳入 imports。
5. **告警未投递重试（DR-22）**：webhook 投递失败/进程崩溃后不自动重投，只有事件记录。
6. **备份锁心跳（DR-23）**：长备份 >1h 的理论接管窗口，当前 Pi 上 5 GiB 备份通常低于阈值。
7. **旧 release 回滚 v5 库（DR-19/DR-25）**：现在 schema 超前会拒绝启动；回滚必须用迁移前 DB 快照（deploy 已自动化）。
8. **AI 代理 Origin 已校验，但 Cookie 仍为父域共享**；长期改 host-only Cookie / AI 签名票据。
9. **单 SD 卡、无全盘加密、Cloudflare 可见明文、备份归档含 TOTP、限流内存态、http-proxy 弃用、scrypt N=2^15** 等既有风险保留。
10. **本审计非第三方独立审计**；发布前建议保留各子审计原文并做一次外部复审。

### 5. 结论

- 第三轮范围内未发现未关闭的 P0；v0.4.0 修复了 2 个 P0（世界备份静默失败链、运维权限面记录/缓解）、多个 P1（备份 pending/增量、上传耐久性、env 重建、版本单源、回滚 DB、PS 编码）与大部分 P2。
- 新增功能（指标/附件/版本/多文件分享/世界备份/演练）均有成功+失败路径测试与生产验收证据（见 `docs/ACCEPTANCE.md`）。
- 后续轮次优先：DR-1 增量水位、导入归档保留、告警重投、listTrash 性能、SSH/sudo 收敛、独立第三方复审。
