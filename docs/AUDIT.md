# AntifieldCloud 审计与修复记录（v0.2.0 / 第二轮 v0.3.x / 第三轮 v0.4.0 / 第四轮 v0.4.2+v0.5.0 / 第五轮 v0.5.11→v0.6.0 / 第六轮 v0.6.6→v0.7.0）

> 本文件补齐 2026-10-20 未落档的第二轮审计记录、第三轮 v0.4.0 与第四轮 v0.4.2/v0.5.0 记录；第一轮 v0.2.0 记录保留在下方。

- 日期：2026-10-19（第一轮）、2026-10-20（第二/三轮）、2026-10-21（第四轮）、2026-10-23（第五轮）
- 范围：v0.1.0 全部代码、部署脚本、备份、Pi/Cloudflare、前端与测试；第二轮覆盖 v0.2.2 基线与 v0.3.0/v0.3.1 增量；
  第三轮覆盖 v0.3.2 基线与 v0.4.0；第四轮覆盖 v0.4.2 基线与 v0.5.0 Bot 增量。
- 方法：只读静态审查 + 进程内 PoC + 只读线上检查 + 回归测试；审计阶段未修改生产。
- 结果：第一至第四轮范围内无未关闭 P0；第四轮 v0.4.2 基线 P1=0、P2=3、P3=12，Bot WIP P1=2、P2=4 均已修复；第五轮（v0.5.11→v0.6.0）P0=0、P1=1、P2=14 均已在本版修复，P3=54 记录；残余见各节“延后/残留”。

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

- Pi `antifield@192.0.2.10`，Node v26.11.1，app v0.3.2 active，schema v4，release `20261020T102328Z`，磁盘 58G/25G 用/31G 余。
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

## 第四轮（v0.4.2 基线 + v0.5.0 Bot WIP，2026-10-21）

### 0. 执行方式与记录边界

- 范围：v0.4.2 发布基线（TS7 工具链、Android 趋势布局、文档/版本基线）+ v0.5.0 Bot 增量（迁移 7、`bot/`、Webhook/管理 API、命令/通知/发布、前端 `/bots`、部署/环境/版本脚本）。
- 方式：只读静态审查（服务端/前端/运维脚本）+ 进程内 PoC（加解密、Webhook 验签/去重、未授权目标、队列状态机）+ 本地回归测试；审计期间未修改生产、未部署。
- 证据边界：Bot 适配器/队列以进程内假平台与夹具为主（无真实 Telegram/Discord/Slack 网络）；本地仅执行 `npm test` 与 `npm run test:web`，
  `npm run check`/`npm run build`/CI/部署/smoke 由主代理后续执行；本记录不替代独立第三方审计或真实平台联调。
- 记录方式：v0.4.2 与 Bot WIP 分开计数；已修复项注明「v0.5.0 修复」并给出测试/命令；未能本地复现或仅文档层面的项归入 P3。

### 1. 结论与计数

| 对象 | P0 | P1 | P2 | P3 | 状态 |
|---|---:|---:|---:|---:|---|
| v0.4.2 发布基线 | 0 | 0 | 3 | 12 | 已处置/记录；无未关闭 P0/P1 |
| v0.5.0 Bot WIP | 0 | 2 | 4 | 0 | **全部 v0.5.0 修复**（P1 2、P2 4） |

- v0.4.2 的 3 个 P2：自动回滚版本假阳性（OPS4-03）、脏工作树发布门禁缺失（OPS4-04）、测试证据 mock-only（T/S）；均在 v0.5.0 处置或明确残余。
- Bot WIP 的 2 个 P1：发布缺 TOTP 再认证（BOT-02）、通知/命令输出泄露内部路径（BOT-04）；4 个 P2：命令缺用户白名单、Webhook 重放/去重、
  关闭态入口语义、Token 暴露面（BOT-01/03/05/06）；均在 v0.5.0 修复并有回归/命令证据。

### 2. 评分卡（1–5）

| 维度 | v0.4.2 基线 | v0.5.0 修复后 | 主要依据 |
|---|---|---|---|
| 架构设计 | 4 | 4 | Bot 独立 `bot/` 模块、Webhook 独立 raw body scope、队列状态机；`http/` 路由仍偏大，module split 列后续 |
| 功能完整度 | 3 | 4 | 三平台、只读命令、通知、单媒体发布/定时/重试补齐；多附件/审批/长连接仍缺 |
| 安全设计 | 4 | 4 | AES-256-GCM、只写 Token、签名+时间戳+去重、双白名单、TOTP 发布、输出清洗、限流；Access 依赖用户后台，fail2ban 已启用 sshd jail |
| 可靠性/数据完整性 | 3 | 4 | Bot 队列重试/死信/陈旧恢复、发布取消、迁移 v7、回滚版本还原；mock-only 与平台故障未实测 |
| 测试与 CI | 4 | 4 | 245/137 本地通过，新增 Bot 单测/迁移/路由/前端；`check`/CI/覆盖率待主代理执行 |
| 可维护性/运维 | 4 | 4 | 部署/回滚/版本一致性/SSH/Access/备份任务文档收口；sudo 仍残余，fail2ban 封禁依赖 nftables set |

**综合：v0.4.2 约 3.7/5 → v0.5.0 约 4.0/5**（功能与可靠性提升；安全维度的外部依赖项未计入加分）。

### 3. v0.4.2 基线发现与处置

#### 3.1 P2（3 项，均已处置/明确残余）

| ID | 问题/影响 | 处置 | 证据 |
|---|---|---|---|
| OPS4-03 | 自动回滚只切 release/还原 DB，未还原 `/etc/antifieldcloud/env` 的 `APP_VERSION`；旧 release 可能以新版本号通过 `/healthz`，造成回滚假成功 | **v0.5.0 修复**：`deploy.ps1` 回滚前从上一 release `package.json` 读取版本，写入 env；读不到直接拒绝自动回滚 | `scripts/deploy.ps1`（Invoke-Rollback）；`docs/DEPLOY.md` §3/§11 |
| OPS4-04 | 部署未绑定 commit，脏工作树可把未完成的 v0.5.0 半成品当旧版本发布 | **v0.5.0 修复**：默认 `git status --porcelain` 非空即中止；`-AllowDirty` 显式放行并记录 | `scripts/deploy.ps1`；本机 `npm test` 245/245 |
| T/S-01 | Bot/备份 tar/告警投递等测试为进程内 mock/夹具（T/S mock-only），无真实平台/网络负路径；风险为“测试全绿但平台侧失败” | 记录为**明确残余**；文档要求部署后平台联调并保留证据，不把 mock 结果当线上通过 | `docs/ACCEPTANCE.md` v0.5.0 未决；`docs/DEPLOY.md` §9.8 |

#### 3.2 P3（12 项，均为低风险一致性/文档/CI）

| ID | 问题 | 处置 |
|---|---|---|
| OPS4-10 | `package-lock.json` 根版本未纳入版本一致性检查，SBOM/审计可能误读 | **v0.5.0 修复**：`check-version.mjs` 校验 `lock.version` 与 `packages[""].version` |
| DOC4-01 | `docs/AUDIT.md` 标题/权威文档索引只列第一、二轮，第三轮未进索引 | 已更新标题/索引（本轮） |
| DOC4-02 | `docs/API.md` `/healthz` 示例仍为 0.3.2，与当前版本漂移 | 已改为 0.5.0 并加版本一致性检查 |
| DOC4-03 | `docs/PLAN.md` 验收摘要停留在 0.4.0/234/129，与 v0.4.2 不符 | 已整体重写为 v0.5.x |
| DOC4-04 | `README`/`AGENTS` 测试基线 234/129，未含 Bot 新增用例 | 已更新为 245/137 |
| DOC4-05 | `docs/UI-SPEC.md` 标题 v3/2026-10-20，且缺 Bot 页面 | 已升 v4 并新增 §15 |
| DOC4-06 | `docs/ROADMAP.md` 仍把 Cloudflare Access/SSH 加固列为候选，未反映 v0.5.0 部分落地 | 已更新为 v0.5.0 当前 + v0.5.1 规划 |
| DOC4-07 | `docs/DEPLOY.md` §9.6 仍写“SSH/sudo 未改”，与仅公钥切换冲突 | 已更新并新增 §9.7 |
| DOC4-08 | `README` 部署/冒烟示例 `-ExpectedVersion 0.4.2` | 已改为 0.5.0 |
| DOC4-09 | `docs/BACKUP.md` 验证清单 0.4.2、`schema v6` 与演练命令 6 | 已改为 0.5.0/schema v7/`-ExpectedSchemaVersion 7` |
| DOC4-10 | `docs/SECURITY.md` 残留仍写“无 Cloudflare Access/SSH 密码登录保留” | 已改为 Access 需后台配置 + 仅公钥/24h 回滚 + fail2ban sshd jail |
| DOC4-11 | `deploy/env.example` 头部与 `APP_VERSION` 停留在 0.4.0，且 `check-version` 未覆盖 | **v0.5.0 修复**：env.example 升 0.5.0 并纳入 check-version（env.example/DEPLOY 标题） |

补充：`scripts/check-version.mjs` 顶部注释曾写“未接入 CI”，与 CI 实际接入不一致，已随 v0.5.0 修正并覆盖更多文件。

### 4. Bot WIP 发现与处置（v0.5.0 修复）

#### 4.1 P1（2 项）

| ID | 问题/影响 | v0.5.0 修复 | 测试/命令 |
|---|---|---|---|
| BOT-02 | 发布接口只要求会话 + CSRF，登录会话（或 XSS/CSRF 绕过）即可把云端文件外发到第三方平台；数据外发门禁缺失 | 发布必须带 `totpCode`，路由调用 `auth.confirmTotp`（复用再认证/TOTP 限流、失败审计 `reauth_bot_publish`）；缺码 `400 totp_required`、错误 `401 invalid_code`；发布/测试各 20 次/小时 | `server/test/bot-routes.test.ts`（无 TOTP 400、有效 TOTP 才建任务）、`bot-core.test.ts`；`node --test server/test/bot-routes.test.ts`；手工：不带/带 `totpCode` 调 `POST /api/bots/:id/publish` 对比 |
| BOT-04 | 通知/命令回复直接拼接 provider 数据，可能输出内部路径、SSH/HTTP URL，帮助外部推断主机布局 | `sanitizeExternalText` 将 `C:\`/`/home|/var|/etc|…` 与 `ssh://`/`http(s)://` 替换为 `[path]`/`[url]`，去控制字符、≤1500 字符；模板只输出白名单字段 | `server/test/bot-core.test.ts`（通知/命令文本）；`node --test server/test/bot-core.test.ts` |

#### 4.2 P2（4 项）

| ID | 问题/影响 | v0.5.0 修复 | 测试/命令 |
|---|---|---|---|
| BOT-01 | 命令只校验目标 `allow_commands`，频道内任意成员（含被邀请的第三方）都能执行只读命令/探测状态 | 增加显式 user 白名单：发送者必须是该 Bot 下 `kind='user'` 且 `allow_commands=1` 的目标；未授权不执行并审计 `bot.command.denied` | `server/test/bot-core.test.ts`（未授权目标/用户不执行）；`node --test server/test/bot-core.test.ts` |
| BOT-03 | Webhook 无时间戳窗口/事件去重，合法回调可被重放；重复事件会重复执行命令 | Discord/Slack 校验 ±300 秒时间戳；`bot_events` 以 `(bot_id, platform_event_id)` 主键 `INSERT OR IGNORE`，重复返回 `{ok:true,duplicate:true}`；Bot/命令/IP 分层限流 | `server/test/bot-core.test.ts`（去重/验签）、`server/test/bot-webhook-route.test.ts`；`node --test server/test/bot-core.test.ts server/test/bot-webhook-route.test.ts` |
| BOT-05 | Bot 关闭/未启用/不存在时入口语义不一致，可能暴露 Bot 是否存在或返回 5xx | `BOT_ENABLED=false`/无密钥/Bot 不存在/`enabled=false` 统一 404；管理写接口 503 `bot_disabled`/`bot_key_missing`；队列不启动 | `server/test/bot-webhook-route.test.ts`（未知 bot 404）；`node --test server/test/bot-webhook-route.test.ts` |
| BOT-06 | Token/Secret 可能进入 API 响应、日志、错误对象（含平台 URL token） | 凭据 AES-256-GCM 落库；API 只返回 `BotSummary`（无密钥）；`PATCH` Token 空值保持、其它密钥省略保持；平台错误只保留状态/短错误码、禁止重定向、响应 ≤1 MiB；日志/审计不含 Token | `server/test/bot-core.test.ts`（加解密/篡改失败、Token 不回显）；`node --test server/test/bot-core.test.ts`；`git grep -n 'BOT_SECRET_KEY' server/src` 人工复核 |

说明：本轮只记录 Bot WIP 的 6 项；Bot 功能本身的多媒体/审批/长连接等为产品边界，不计为缺陷。

### 5. 回归测试与证据

- 本地（2026-10-21，工作树）：`npm test` **245/245**（服务端 229 + 运维脚本 16）；`npm run test:web` **137/137**（27 文件）。
- Bot 专项：`node --test server/test/bot-core.test.ts server/test/bot-routes.test.ts server/test/bot-webhook-route.test.ts server/test/bot-migration.test.ts`；
  迁移覆盖 v6→v7 建表并保留迁移 6 的孤儿 shares 修复。
- 未执行/待主代理：`npm run typecheck`、`npm run lint`、`npm run check`、`npm run build`、`npm run test:coverage`、`npm run test:web:coverage`、CI、部署、`smoke.ps1`、真实平台联调。
- 证据边界：Bot 测试不访问真实平台；备份/告警/系统脚本测试仍以夹具为主；Windows systemd 用例 `t.skip` 留 Linux 执行。

### 6. 残余风险（明确）

1. **typescript-eslint TS7 alias（残余）**：`typescript` 仍为 `@typescript/typescript6@6.0.2` 别名，仅供 typescript-eslint 8.x；在其支持 TS7.1 API 前不能移除，升级时需重跑 typecheck/lint。
2. **T/S mock-only（残余）**：Bot 适配器、备份 tar、告警投递等以进程内 mock/夹具验证，真实平台/真实网络的签名漂移、限流、5xx 未覆盖；上线前必须平台联调。
3. **Cloudflare Access（用户后台）**：`app` 策略与 `/api/bot/webhook/*`、`/healthz`、`/s/*`、`/api/public/shares/*` bypass 需用户配置；应用无法自证，漏配会导致 Webhook/health/分享被 302。
4. **SSH 24h 回滚窗口（残余）**：仅公钥已切换，旧配置备份保留 24h；窗口内回滚可恢复密码登录；窗口结束前不要删除唯一可用会话。
5. **fail2ban（已启用，依赖 nftables）**：`sshd` jail 使用 nftables 后端、24h ban；`nft -f`/重启 nftables 会清空 set，
   必须随后 `systemctl restart fail2ban` 恢复已有封禁。日志后端为 log2ram/journald，需在维护窗口复核 `fail2ban-client status sshd`。
6. **BOT_SECRET_KEY 轮换（设计边界）**：轮换等于所有 Bot Token 重录；`bootstrap-env.sh --force` 复用旧值，避免误轮换。
7. **Bot 产品边界**：单次 1 个媒体、命令只读、无平台主动拉取/长连接、无多管理员审批；Access 未覆盖 `ai`。
8. **前几轮残余延续**：DR-1 增量时钟水位、DR-7 导入归档保留、DR-22 告警跨周期不重投、DR-23 锁心跳、RCON 监听 0.0.0.0、
   `antifield` `NOPASSWD ALL` sudo、单 SD/LUKS、Cloudflare 明文、限流内存态、scrypt N=2^15 等仍按 `docs/SECURITY.md` §4 管理。

### 7. 结论

- 第四轮在 v0.4.2 基线未发现 P0/P1；3 个 P2 中 2 个（回滚版本、脏发布）已在 v0.5.0 代码修复，1 个（mock-only）明确为测试证据残余；12 个 P3 已随文档/CI 收口。
- Bot WIP 的 2 个 P1、4 个 P2 全部在 v0.5.0 修复：发布 TOTP、双白名单、时间戳/去重、关闭态 404、AES-256-GCM/只写 Token、输出清洗；均有本地测试或命令证据。
- v0.5.0 的部署/CI/smoke/真实平台联调证据尚未产生；`docs/ACCEPTANCE.md` 已留「待部署后补」占位。完成前不得声明验收通过。
- 下一轮优先：真实平台联调与负路径、`typescript-eslint` TS7 迁移、fail2ban 封禁持久化/观测、sudo 收口、Access 策略自动核验、独立第三方复审。

## 第五轮（v0.5.11 基线 → v0.6.0，2026-10-23）

### 1. 范围与方法

- 基线：生产 v0.5.11 / schema v14 / OpenCode v2.1.3（v2.1.3 于本轮审计前单独升级并验证；备份/回滚证据在本地 `.local/audit/round5-opencode.md`）。
- 工作流：安全（认证/文件/分享/上传/笔记/OpenCode 代理）、数据/灾备（DB/迁移/备份/恢复/告警/指标）、Bot/AI/记忆/QQ Webhook、前端/API 契约/UI、运维（部署/smoke/文档/生产只读）。Lead 负责 OPS 流并统一 triage。
- 方法：只读静态审查 + 威胁建模 + 进程内 PoC + 生产只读命令；审计阶段不写生产、不改配置、不访问真实平台；修复阶段由 Lead 统一提交/验证。原始报告在 `.local/audit/round5-*.md`（gitignored，含细节与命令）。
- 边界：不替代第三方平台/Cloudflare 控制面验收；QQ 真实回调/模型/网络负路径仍以部署后真实验收为准；真实生产写操作仅在 Step 6 部署/验收执行。

### 2. 计数与结论

| 工作流 | P0 | P1 | P2 | P3 | 本版处置 |
|---|---:|---:|---:|---:|---|
| 安全 | 0 | 0 | 2 | 12 | P2 全部修复；P3 记录 |
| 数据/灾备 | 0 | 0 | 4 | 9 | P2 全部修复；P3 记录 |
| Bot/AI | 0 | 1 | 4 | 14 | P1/P2 全部修复；P3 记录 |
| 前端/契约 | 0 | 0 | 3 | 14 | P2 全部修复；P3 记录 |
| 运维 | 0 | 0 | 3 | 5 | P2 全部修复；P3 记录 |

- 跨工作流重复项：`A5-WEB-01 = A5-OPS-01`（世界备份 `kept` 契约）、`A5-WEB-02 = A5-OPS-02`（演练字段/schema 检查）。
- 去重后本版 **P0=0、P1=1、P2=14**；均为已修复/已闭环（P1 先于本次修复提交 `81be6e5`、`72fe7c0`；P2 见下表）。P3 共 54 项（工作流合计），记录不修（低风险/产品边界/需后续版本）。

### 3. P1/P2 发现与处置

| ID | 级别 | 问题/影响 | 处置与证据 |
|---|---|---|---|
| A5-BOT-01 | P1 | QQ `op=13` 回调校验可把任意事件 JSON 当 `plain_token` 换取 Ed25519 签名，进而伪造任意 `op=0` 事件（伪造命令/身份） | 严格 `plain_token ^[A-Za-z0-9_-]{1,128}$`、`event_ts ^\d{1,12}$`，否则 400；webhook botId 日志脱敏；PoC 修复后 `challenge.kind=rejected`、伪造事件不再解析；提交 `81be6e5`/`72fe7c0`；新增回归 + op=13 成功审计 `bot.webhook.challenge` |
| A5-SEC-01 | P2 | app/ai 共用 `Domain=.父域` 会话 Cookie；任一子域/兄弟域攻击面可影响会话，ai 借用 app 凭据 | app 改 host-only Cookie；ai 改用 app 签发 60s 一次性 ticket（`GET /api/auth/ai-ticket` → `/__af/sso/<ticket>`）设置自己的 host-only 会话；登录/退出清理旧父域 Cookie；测试覆盖一次性/过期/错误 origin/开放重定向/无 Domain |
| A5-SEC-02 | P2 | 全局 `application/octet-stream` 8 MiB 解析器在鉴权/Origin 前缓冲大 body，公开 unlock 也可触发 | 全局回落 1 MiB；8 MiB+64 KiB raw body 只在 uploads 独立 scope；新增非分片/分片回归；PoC 2 MiB→413 |
| A5-DATA-01 | P2 | opencode DB 快照因临时父目录 0700 root 对 opencode 不可遍历而静默缺失；PC `secretsOk=true` 掩盖 | 独立 0711 快照父目录 + opencode 可写预检；快照失败硬失败（不生成半成品），传播 `secretsOk=false`；生产证据确认旧包仅 4011 B |
| A5-DATA-02 | P2 | 多 pending 顺序 ack 用本归档 `skippedMissing` 覆盖 meta，丢失历史缺失强制重查集合 | ack 合并：覆盖移除、仍存在文件行保留、manifest 缺失保守保留；新增多 pending 端到端与行删除测试 |
| A5-DATA-03 | P2 | 恢复解包预算信任归档 DB `files.size`，可先解包超预算内容再失败 | 解包前 `measureContents()` 按 tar 实际 size 测量，再 staging/配额/落盘预检；超限 507 且不建目标；新增声明 1 字节/实际 20 MiB 与注入上限测试 |
| A5-DATA-04 | P2 | legacy 抽取 `ops=0` 也置 `legacy_migrated_at`，fallback 停止注入，旧摘要可能被后续清理 | 仅 `upserts>0` 才标记迁移；ops=0 保留 fallback 继续迁移；新增 ops=0/下一批 upsert 测试 |
| A5-BOT-02 | P2 | wait 不可用轮询回退返回上一轮旧 assistant 回答，多轮答非所问/记忆写入旧回答 | 发送 prompt 前建立 assistant 消息基线（id/time.created），wait/轮询只接受基线外新回答；重启首次复用先读存量消息；多轮/回退/重启用例 |
| A5-BOT-03 | P2 | 记忆敏感过滤覆盖不足且 key/legacy 未过滤；密码/token/URL/内部路径可落库并进入提示词 | 扩展自然语言密钥/token 前缀/URL/IP/内部路径/UNC/提示结构标记过滤，key/value/legacy 均过滤；读取侧排除旧敏感条目；6 PoC 样本 + 正常偏好不误杀 |
| A5-BOT-04 | P2 | AI 工具隔离降级仅在日志，无状态/告警；v2.1.3 仅验证 permissions 接受，未验证工具实际被拒 | `toolIsolation()` + `GET /api/bots/status.aiToolIsolation` + 审计 `bot.ai.permissions_fallback`；`/bots` 概览 warning；SECURITY/BOT 记录“接受≠已证明拦截”残余 |
| A5-BOT-05 | P2 | 发布路由 `slice(2000)` 静默截断，用户以为全文已发 | 路由不截断；service 超长返回 `400 publish_text_too_long`；2000 可入队/2001 拒绝测试 |
| A5-WEB-01/OPS-01 | P2 | 前端把世界备份 `kept`（归档名数组）当数字展示；世界/PC 状态字段缺失 | `kept: string[]` + `keptCount`，文案注明“上次运行保留、PC ack 后远端删除”；类型/渲染/测试更新 |
| A5-WEB-02/OPS-02 | P2 | 演练状态按不存在的 `reportPath/dbIntegrity` 展示；smoke 不校验 drill schema | 改用 `report/latestDb/schemaVersion/worldChecked`，旧字段仅兼容回退；smoke 对 schema 不一致 WARN 并提示重跑 |
| A5-WEB-03 | P2 | 恢复 `skippedMissing` 未展示，用户可能误判完整恢复 | 计划/结果补字段；完成面板显示缺失数量/ID，成功提示不再误报完整恢复；组件测试 |
| A5-OPS-03 | P2 | 文档版本/字段漂移（OpenCode 2.1.2、schema 14、smoke 13、API 字段/限流、DEPLOY §3.3 陈旧、保留语义矛盾等） | 统一同步 README/AGENTS/API/UI-SPEC/DEPLOY/SECURITY/BACKUP/BOT/CHANGELOG/ACCEPTANCE/PLAN/ROADMAP；`check-version` 通过 |

### 4. P3 汇总（记录，不本版修）

- 安全 12 项：app 写请求可省略 Origin、上传间隔/时间侧信道、公开分享 token 统计 oracle、bare `Origin: null`、备份 TOTP 失败审计、SSO 未绑定 IP/UA、`__Host-` 前缀未采用、旧 Cookie 过渡、AI proxy 响应头透传、分享密码强度/迁移、日志 query 残留、CI 权限/供应链加固。
- 数据/灾备 9 项：大归档 entries 浏览 507、恢复计划早期快照尺寸检查、导入归档保留策略、告警跨周期不重投、锁心跳、增量时钟水位、状态文件大小上限之外的字段校验、legacy 镜像清理、备份状态历史回填。
- Bot/AI 14 项：op=13 失败审计字段、消息基线失败边界、旧敏感行仍在 DB、permissions 降级进程级一条审计、多 Bot 状态归属、QQ 平台限流/签名漂移、图片 prompt 文件长期兼容、shim 原生按钮复验、长回复 msg_seq、CF-IP 信任边界、reserved marker、死信 TTL、事件诊断保留、`/ask` 残留文案。
- 前端/契约 14 项：映射/错误文案细节、BotMetrics 成功率语义、发布文本长度展示、Settings 告警配置、Shares 分页、文件内容/预览契约、空态/重试、PWA 缓存、窄屏表格、无障碍焦点、API 类型可空性、旧字段兼容、UI 文案、前端测试盲区。
- 运维 5 项：smoke world 归档存在性/schema 匹配、drill 结果解析、CI 缓存/权限、备份脚本 Bash 可移植性、生产日志保留。
- 明细与逐项证据见 `.local/audit/round5-{security,data,bot,web,ops}.md`；P3 不阻塞 v0.6.0，但若后续变更触及同模块应优先回看。

### 5. 回归与验证证据

- 本地门禁（2026-10-23，`release/v0.6.0` 工作树）：`npm run check` 通过；`npm test` **383 pass / 0 fail**（server+scripts）、`npm run test:web` **176 pass / 0 fail**（32 文件）；服务端覆盖率 Lines **92.39%** / Branches **77.83%** / Functions **87.14%**（`npm run test:coverage` exit 0）、`npm run test:web:coverage` exit 0；`npm run build` 通过（bundle `index-D9PlQHRh.js` 680.45 kB）；`node scripts/check-version.mjs` 通过。
- 针对性批次：安全/SSO/上传 17 pass；备份/恢复 52 pass；Bot 135 pass；前端 176 pass；全新测试文件 `uploads-hardening`、`RestoreWizard`、`Login` 等。
- PoC：op=13 预言机修复前可伪造命令、修复后 400/拒绝；A5-SEC-02 2 MiB octet-stream 修复前进入 handler、修复后 413；SSO 全链路/一次性/开放重定向用例；备份 ack 多 pending 端到端；恢复 1 字节声明/20 MiB 实际预算。
- 生产只读：OpenCode v2.1.3 版本/API/model 验证；服务 active、无 warning；备份 pending=0、PC 拉取正常；`secrets-tmp` 0700 root 与旧密钥包 4011 B 证实 A5-DATA-01；未在审计阶段修改生产。
- 证据边界：mock-only（QQ/模型/网络）；真实 QQ/Cloudflare/浏览器 SSO 验收已在 Step 6 由用户确认通过（最终 release `20261023T053539Z`/commit `6349617`，smoke 24/24、0 警告；用户确认验收通过）；mock-only 边界仍适用于平台限流/签名漂移等负路径。

### 6. 残余风险（明确）

1. **host-only/SSO 过渡**：旧父域 Cookie 在登录/退出及每次 `/api/auth/me` 响应清理，长期不重登录的浏览器最多 7 天内仍可能发送旧 Cookie；未采用 `__Host-` 前缀；SSO ticket 未绑定 IP/UA（一次性/60s/aiOrigin/no-store/no-referrer）。发布说明提示清理站点 Cookie。
2. **BOT-04 工具拦截已做生产只读负路径（v0.6.1）**：deny-all 会话中要求 shell 写 `/tmp`，模型返回 `TOOLS_UNAVAILABLE`、无 `tool` 内容段、目标文件未创建；降级审计/状态仍保留。模型行为非强保证，仍不得把 Chat 当强沙箱。
3. **记忆过滤是启发式**：新格式密钥可能漏过；旧版本已落库敏感行仍存在 DB，读取侧已不注入/不迁移，可用 `/forget`/管理删除/后续 CLI 清理。
4. **密钥包硬失败语义**：opencode 快照瞬时失败会跳过当天密钥包（旧包保留、次日重试）；如希望保留部分包需改备份拉取状态模型（P3）。
5. **恢复性能**：measureContents 多一次只读解压，大归档恢复耗时增加约一次解压时间；换预算可信。
6. **既有残余**：单管理员、`antifield` NOPASSWD sudo、RCON 监听 0.0.0.0、单 SD/LUKS、Cloudflare 明文、mock-only 平台路径等按 `docs/SECURITY.md` §4 管理。
7. **验收状态**：本地门禁完成；生产已部署最终 release `20261023T053539Z`/commit `6349617`（healthz v0.6.0/schema14、smoke 16/16 与 24/24、drill schema14、备份/密钥包拉取、用户验收通过）；Tag/GitHub Release 见发布记录。

### 7. 结论

- 第五轮去重后 P0=0、P1=1、P2=14；P1/P2 均在本版修复并有回归/PoC 证据；P3 54 项记录不修。
- 审计未发现新的未关闭 P0/P1；无 schema 迁移（保持 v14）；OpenCode 已先升级 v2.1.3。
- 本版为质量/安全加固 Minor，不是第三方独立审计；生产最终结论以 Step 6 部署、smoke、用户验收与发布证据为准：最终 release `20261023T053539Z`/commit `6349617`，smoke 24/24、0 警告，用户确认验收通过。
- 用户追加：默认 `lofii` 角色卡简化为名字 + 用户指定对话风格（不注入详细人设），`/role set` 个人卡仍可覆盖；最终部署已包含（commit `6349617`）。

## 第五轮补丁（v0.6.1，2026-10-23）

- **已知问题**：Dashboard 备份状态显示“应用归档文件缺失”。根因：PC ack 删除服务端归档文件后，`toArchiveItem` 先按文件存在性标记 `missing`，优先级高于 `acked`。
- **修复**：acked 优先返回 `acked`；新增 `available: boolean` 表示服务端文件是否存在；Dashboard 显示“已确认”；Backups 页显示“副本已清理”、恢复按钮禁用并提示；`isArchiveRestorable` 要求 `available !== false`；API 文档 v13。
- **残余处理**：`/api/auth/me` 增加旧父域 Cookie 清理；生产 deny-all 工具隔离负路径验证通过（无 tool 段、无文件创建）。仍保留 `__Host-` 前缀、SSO ticket IP/UA 绑定、记忆过滤启发式等后续项。
- 证据：服务端 `backups-import-verify`/`http-hardening` 用例、前端 `backups`/`BackupStatusCard` 用例；原始记录见 `.local/audit/round6-residuals.md`。
- **部署与复核（2026-10-23）**：release `20261023T063020Z`/commit `23d5ec4`；healthz v0.6.1/schema14；smoke 16/16 与 24/24（0 警告）；生产 25 个 acked 归档（文件均已被 PC 清理）复核显示已确认，用户刷新 Dashboard/备份页确认不再误报；部署后备份/密钥包拉取（168622 B / secretsOk=true）。

## v0.6.4 已知问题与遗留事项复核（2026-10-24）

### 范围与结论

- 复核对象：v0.6.0 §6 残余风险、v0.6.1 补丁残余、v0.6.3 全量群消息平台配置问题，以及 `docs/ROADMAP.md` 未完成的 P3/历史欠项。
- 结论：未发现新的未关闭 P0/P1；v0.6.4 不新增 schema 迁移（保持 v16）。本轮关闭 5 项可安全收敛的问题，其余按下表明确保留并记录理由。
- 测试边界不变：QQ 适配器、OpenCode、Cloudflare 等平台路径仍以进程内夹具/mock 为主，真实平台负路径需部署后联调；不把 mock 全绿等同于线上通过。

### 本轮处理

| 项目 | 来源 | 处置 |
| --- | --- | --- |
| 全量群消息已开启但非 @ 消息无响应 | v0.6.3 验收发现 | 根因在 QQ 平台侧：需同时开启“接收所有消息”、订阅 `GROUP_MESSAGE_CREATE`、群主设置“获取群内全部消息”；v0.6.3 已补 UI/文档提示，v0.6.4 复核确认生产可用，非代码缺陷 |
| `NO_REPLY` 文本哨兵脆弱 | v0.6.3 设计 | 升级为 `botmsg_send_message` 工具：模型不调用工具即不发送；私聊/@ 必须至少调用一次，漏调用时服务端兜底发送最终文本并审计 `bot.ai.send_fallback`；未启用工具的部署保留旧 `NO_REPLY` 兼容路径 |
| 全量群聊逐条调用模型成本高 | v0.6.4 需求 | 新增 `BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS=8000`/`BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS=20000`，仅对非 @ 全量消息延长合并；@/名字命中仍走默认窗口 |
| 新会话标题不可管理 | v0.6.4 需求 | 新建 Chat/Memory 会话命名为「目标名称 Chat/Memory」；已有会话不重命名；C2C 未登记用户回退入站用户名/短 ID |
| SSO ticket 未绑定客户端 | v0.6.1 残余 | 绑定 User-Agent SHA-256 摘要（可选；签发/消费不一致即失败并一次性销毁）；IP 不绑定，原因是移动网络切换与 Cloudflare 边缘出口 IP 可能变化，绑定会导致正常 SSO 失败；仍保留一次性/60s/aiOrigin/no-store |
| 记忆敏感过滤启发式 | v0.6.1 残余 | 新增 Google `AIza`、GitLab `glpat-`、npm token、Stripe `sk_live_`、AWS secret key、Azure `AccountKey`、带凭据的数据库 URL 模式；仍为启发式，读取侧继续过滤旧条目 |
| Bot 工具隔离可验证性 | v0.6.0 残余 | 发送工具只放行 `botmsg_*`，搜索只放行 `searxng_*`，其余 deny；工具调用必须携带本轮 HMAC token，单轮最多 5 条、3 分钟过期；permissions 降级仍通过 `aiToolIsolation` 暴露 |

### 明确保留（不本版处理）

1. **`__Host-` Cookie 前缀**：需要同时迁移 Cookie 名、前端读取、SSO 代理与回滚路径；且本地 loopback HTTP 开发环境没有 Secure 上下文，直接加前缀会影响开发登录。当前 host-only + 清理旧父域 Cookie 已覆盖主要跨子域风险，下一版本单独评估。
2. **SSO ticket IP 绑定**：见上，UA 已绑定；IP 在移动网络/Cloudflare 边缘场景不稳定，强行绑定会破坏正常登录，记录为已评估不采用。
3. **SSH/sudo、RCON 监听、单 SD/LUKS、Cloudflare 明文、mock-only 平台负路径**：按 `docs/SECURITY.md` §4 既有残余管理，用户已选择仅文档披露/接受。
4. **DR-1 增量水位、DR-7 导入归档保留、DR-22 告警跨周期重投、DR-23 锁心跳、DR-17 listTrash 性能等 P3**：本次未触及对应模块，不扩大 v0.6.4 范围；若后续改动备份/告警模块优先回看。
5. **工具调用模型行为非强保证**：私聊/@ 的兜底保证“有回复”，但不保证模型一定调用工具；生产验收应观察 `bot.ai.send`/`bot.ai.send_fallback` 审计与真实 QQ 消息。

## 第六轮（v0.6.6 基线 → v0.7.0，2026-10-24）

### 0. 执行方式与记录边界

- 基线：**v0.6.6 / schema v16 / OpenCode v2.1.3**；分支 `release/v0.7.0`（`b5264b4`，工作树干净）。
- 方法：逐文件通读（不抽样）+ 不变量目录 + 对抗性假设与 PoC + 失败注入/并发推演 + 合成数据基准 + 生产只读核验；审计阶段**未修改任何 tracked 文件、未写生产、未访问真实 QQ/Cloudflare/模型**。
- 边界：OpenCode 2.1.4 真实语义、archived 行为与 MCP elicitation 需升级后验证；未在 Pi 上做规模压测（基准在 PC）；未做真实浏览器 E2E/视觉验收；未运行在线 `npm audit`/OSV（依赖结论为静态版本核对）；多用户/权限分离不在本版范围。
- 详细分报告与 PoC 为本地 gitignored 证据（`.local/audit/v070-*.md`、`.local/audit/poc/`），本文件只记录计数、结论、处置与明确残余。

### 1. 范围与方法

- 范围：服务端 77 文件 / 22,172 行、前端 136 文件 / 31,197 行、脚本/部署/CI/文档全量；五个并行审计流（安全、数据/灾备、Bot/AI、前端/契约、运维/供应链）+ Lead 架构/运行时流与综合。
- 每流产出：finding 台账（ID/级别/证据 file:line/复现/影响/修复选项/置信度）、不变量目录、横切主题、未验证项；Lead 合并去重后形成 Gate-1 决策（D-01…D-19）。
- 生产只读事实（审计时）：DB 1.4 MiB（WAL 4.1 MiB）、files 2、notes 0、sessions 3、audit 632、metrics 3619、bot_events 204、backups 59 行；服务全 active、无 failed unit、无 24h warning；`age 1.2.1` 与公钥可读；OpenCode v2.1.3、5 个会话、MCP 每服务 1 进程（日志有多次 spawn）。探测确认 `ai.<domain>` 未受 Cloudflare Access 保护（根路径 401 而非 Access 302），`app.<domain>` 302、`/healthz` 200。

### 2. 计数与结论

| 流 | P0 | P1 | P2 | P3 | 说明 |
|---|---:|---:|---:|---:|---|
| A 架构/运行时（Lead） | 0 | 0 | 3 | 13 | 基准：100k files usage 80ms；2000 回收站同步清理 1.06s；无循环依赖、事务无 await |
| B 安全 | 0 | 0 | 2→1* | 13 | *SEC-10 经生产确认后升级 P1；核心控制无绕过 |
| C 数据/灾备 | 0 | 0 | 4 | 10 | 24 条不变量：18 成立/5 部分/1 不成立；加密设计 2 处阻断 |
| D 前端/契约 | 0 | 1 | 4 | 18 | 契约漂移 16 条；Web 覆盖率 47.8% |
| E Bot/AI | 0 | 0 | 5 | 11 | 5 个 P2 均为可复现实现/设计缺陷；2.1.4 兼容有门禁 |
| F 运维/供应链 | 0 | 1 | 9 | 11 | 文档漂移跨 10 文件；env/部署/密钥包缺口 |
| **去重后** | **0** | **3** | **26** | **73** | 合并：ARCH-04=BOT-16、OPS-14=DATA-05、OPS-15=ARCH-08 |

- 合计 **102 条唯一 finding**（另有 5 条低风险观察未计入）；去重后 P0=0、P1=3、P2=26、P3=73。
- 总体判断：核心安全控制（认证/scrypt/TOTP/Cookie/SSO/CSRF/文件与分享隔离/tar 校验/Bot 签名/密钥加密/日志脱敏/systemd 加固）质量高，未发现 P0 或 P1 绕过；主要问题集中在**长任务超时与状态丢失、公开面写放大/限流信任、工具隔离永久降级、群共享记忆归属、拉取/恢复的容错与并发、备份加密设计缺口、文档/版本漂移**。
- 最重要的 5 个结论：① 备份/恢复 UI 20s 统一超时 vs prepare 3300s，误报失败/结果丢失；② OpenCode 2.1.4 不能按旧文档直接升，缺 MCP lifecycle/compaction/permissions/密钥包/Bot 回归门禁；③ AI 主机公网可达且 SSO 失败写审计无认证限流（写放大）；④ 加密设计稿有 `plainSha256` 自引用与“不留明文”/2× 空间未闭环 2 个阻断级缺陷，修正后可行；⑤ 4 个数据 P2 与 2 个 Bot 线上 P2 可在无 schema 迁移下低风险修复。

### 3. P1 详情与处置

| ID | 问题/影响 | 处置与证据 |
|---|---|---|
| A7-WEB-01 | 备份/恢复长任务共用 20s 客户端超时：UI 误报失败、服务端继续、重试 409/410、恢复结果无入口 | 长任务端点显式超时（prepare 3300s、verify/entries/restore-plan/execute 600s），超时文案说明“服务端可能仍在执行”；恢复计划持久化 + 轮询结果；新增前端测试 |
| A7-OPS-01 | OpenCode 2.1.4 升级/回滚程序与验证门禁不完整（未固定版本、无 MCP/compaction/permissions/密钥包/Bot 回归判据） | `docs/DEPLOY.md` §3.2 固定 `opencode upgrade 2.1.4`；补二进制/data/env/unit/MCP 配置备份、14 项矩阵与回滚；`smoke.ps1` 增加 OpenCode/MCP 只读检查；真实升级在发布门禁执行 |
| A7-SEC-10 | AI 主机 `/__af/sso/*` 鉴权前无限流且每失败写 audit_log；生产确认 `ai` 主机未受 Access 保护 → 无认证写放大/磁盘耗尽 | proxy 层按 IP 限流（SSO 60/min、匿名 120/min），`auth.sso_ai`/`opencode_origin_rejected` 审计按 action+IP 60s 去重（容量上限 4096）；建议用户后续在 Cloudflare 后台给 `ai` 加 Access/WAF |

### 4. P2 处置（26）

全部 P2 在本版处置；无 schema 迁移。

- **架构**：ARCH-04 关停前有限等待 Bot 在途回复/工具缓冲/投递排空（最多 15s，超时 warn）；**ARCH-05（D-17）** 审计统一事务外 best-effort，失败计数/最近错误经 `/api/version.audit` 暴露；**ARCH-01 记录不拆**——按 D-16 做行为保持的模块抽取（`bot/inbound.ts`、`bot/diagnostics.ts`、队列/串行逻辑、`BotService` facade），3195 行巨型模块的进一步拆分排后续版本。
- **安全**：SEC-11/D-12 工具隔离 fail-closed（10 分钟重试窗口；启用发送工具且隔离不可用时新 Chat `503 bot_ai_tool_isolation_unavailable` + 固定提示 + 审计/状态；上游恢复自动恢复）；信任头（SEC-05/07/08/12/13）统一 `requestMeta`/代理 loopback Host 判定/Webhook 未验签桶分离；SEC-02/03/04/06/09/14/15 按报告修或明确残余（见本文件 §9）。
- **数据**：DATA-01 拉取分项容错（缺/非法 sidecar 跳过不 ack，其余继续）；DATA-02 并发同索引分片幂等返回、不删共享块；DATA-03 启动/维护清理陈旧 `restore.lock`；DATA-04 分享下载原子计数；DATA-07/08/09/10/11/12/14 分别修分享列表计数、目录深度、唯一名并发、物理孤儿回收、verify 失败清状态、purge 分享吊销兜底、列表 N+1。
- **Bot**：BOT-01 孤儿清理限定旧默认标题；BOT-02 混批任一 @ 即非静默；BOT-03/D-13 群记忆 key 改稳定 `member_openid` + 一次性迁移（无法映射标 `legacy:`）+ `/forget` 清本人群条目；BOT-04 回合异常补发已缓冲工具消息并审计 `partialTurn`；BOT-05 `/search` 复用会话串行锁。
- **前端**：WEB-02 prepare warnings/skippedMissing 类型化与展示；WEB-03 断点命中 completed 消费 `fileId`；WEB-04 恢复计划持久化 + 轮询；WEB-05 补测试并逐步提高阈值（本版门禁 Lines 91 / Functions 85 / Branches 76）。
- **运维**：OPS-02 restart 失败进入回滚 + 快照 SHA 校验；OPS-03 密钥包 `includesOpencode` 硬失败 + PC 校验；OPS-04 env 补键/`--prune-unknown`/模板默认；OPS-05 文档全量同步；OPS-06 加密+异地运维面并入特性；OPS-07 真实域名/网段占位符化；OPS-08 smoke `SKIP`/`SoftCheck` + OpenCode/MCP/fail2ban/unit/env/加密/异地/任务标记检查；OPS-09 `deploy/host/` 模板 + 密钥包可选打包；OPS-10 `deploy/tool-versions.json` + check-version 交叉校验。
- 证据：各流新增/更新测试（`backup-encryption*`、`audit-policy`、`config-validation`、`bot-v070`、`files-guards`、`status-file`、`backup-service-hardening`、前端 `client.backups`/`useBackups`/`RestoreWizard-v07`/`backup-status-v07` 等）；逐条证据见本地分报告与 `v070-findings.md`。

### 5. P3 处置与明确残余（73）

- **随本版修的小项**：ARCH-08/10/13（配置默认与非法值拒绝启动、`/healthz` 增 `db/pendingBackups`、`/api/version` 诊断、可选早鉴权）、ARCH-04 相关关闭排空、SEC-02/03/05/07/08/12（publish/备份审计 IP 与限流、Webhook 限流桶、代理 loopback Host、SSO 审计去重）、SEC-13（unlock 失败审计入既有审计面）、BOT-06/07/08/11/12/13/15（群记忆清空取消在途、lastError 派生、Webhook 限流顺序、turn token HMAC 绑定目标/用户、permissions 判定收紧、burst.clear 竞态、名称词边界）、DATA-05/06/07/08/09/10/11/12/13/14、WEB-06…23 中可安全收敛项（truncated/审计中文/ConfirmDialog 焦点/version 重试/hash 崩溃/PWA 更新提示/轮询静默/Settings 告警字段等）、OPS-11…21（MCP lifecycle、世界拉取重试、drill 链连续、状态路径脱敏、安装脚本原子性、release 元数据、覆盖率门禁、backup-pull 卫生、Windows 任务标记）。
- **明确残余（D-18：架构性/已接受，不本版强行改造；在 ARCHITECTURE §11、SECURITY §4、BACKUP §11 保留说明）**：
  1. 单进程单点、同步维护任务可能短暂阻塞、`synchronous=NORMAL` 不抗突然断电最后写入；内存态限流/诊断在重启后清零。
  2. 平台适配与模型路径 mock-only；真实 QQ/Cloudflare/模型负路径需部署后联调。
  3. 物理孤儿文件只回收“超期且 DB 无行且 id 形状”文件，不含导入/笔记异常路径；审计失败计数不持久化。
  4. 备份加密的 SIGKILL/断电/ENOSPC 残余窗口（`*.plain.tmp` 最长 24h；孤儿密文只报告不自动删）；预部署 DB 快照继续明文 0600、保留 2 份（自动回滚需要）。
  5. 异地副本依赖用户配置 rclone 与 PC 在线，单一远端、非多副本；私钥/远端凭据丢失不可恢复。
  6. `__Host-` Cookie 前缀、SSO ticket IP 绑定、scrypt N 提升、`http-proxy` 替换、Cloudflare 明文、单 SD/LUKS、`antifield` NOPASSWD sudo、RCON 监听 0.0.0.0、mock-only 平台负路径等既有项按 SECURITY §4 管理。
  7. `BotService` 进一步拆分（ARCH-01 剩余部分）、迁移校验和、内存态统一上限、`Intl` 开销等 P3 记录项未在本版改造。
- 明细与逐项理由见本地分报告 `v070-*.md` §P3 与 `v070-findings.md`。

### 6. 特性设计评审：备份整包加密 + 异地副本

- 结论：初稿有条件可行，但需修正 2 个阻断级缺陷后实施。
- **B1（阻断）**：`plainSha256/plainSize` 不能放在被它描述的明文归档内部（manifest 在归档内，循环定义）→ 改为归档外 sidecar（Pi `<archive>.meta.json`）+ `backup_archives.manifest_json`；归档内 manifest 只保留 `schema:2/encrypted/archiveFormat`；`drill-verify.mjs` 与应用侧都接受 manifest schema `1|2`。
- **B2（阻断）**：“失败关闭、不留明文”无法对抗 SIGKILL/断电/ENOSPC；空间峰值≈2× → 专用 `*.plain.tmp` 命名 + 启动/超时/失败扫描清理（>24h）+ 2× 预算 + 残余文档化。
- **B3（必须）**：启用前用私钥完成一次 `age -d` + drill；私钥离线 ≥2 份；`encryptedWith`/recipient 入 sidecar/DB/API 元数据支持轮换；独立于 `secrets-age`。
- **M1–M10**：全链路后缀/命名正则（应用 `ARCHIVE_NAME_PATTERN`、PC `backup-pull.ps1`、CLI 孤儿正则、drill 过滤/解析）；`.age` 的 verify/import/entries/plan/execute 在归档名合法化后、读取/解包前返回 `archive_encrypted` 并关闭 Web 恢复入口；失败关闭不降级明文；PC `age` 安装/私钥/临时明文；drill 解密；offsite 只上传 `.age` + **链感知保留**（不能纯 `--min-age`，否则可能删最新 full）+ 上传后校验 + rclone 凭据/版本控制；`offsite_overdue` 告警处理 unknown/disabled 防误报；预部署快照决策；旧明文/密钥包/世界备份边界与回滚矩阵。
- 产品取舍（用户 Gate-1 确认）：加密后 Web 校验/恢复关闭（依赖 PC/离线私钥）；预部署 DB 快照继续明文（自动回滚需要）；备份 age 密钥独立不复用 `secrets-age`；offsite 不纳入密钥包、世界备份默认不加密/不异地；私钥离线介质 + PC drill。
- 实现顺序：B1/B2/B3 + M1/M2/M4/M5/M6 最小闭环（Pi 生成 `.age`、PC 拉取/ack、drill 解密、Web 明确拒绝）→ M7/M8（offsite/告警）→ M3/M9/M10（API/UI/文档/迁移），每步保持开关可回滚。

### 7. OpenCode v2.1.4 兼容结论

- 兼容（有条件，非阻断）：应用是纯 HTTP 客户端（非 SDK），依赖 5 个端点与 assistant content 形状；2.1.3 已验证 `[{type:'text',text}]`、permissions 200、wait 204；2.1.4 为补丁版，MCP lifecycle 修复是收益（2.1.3 生产日志多次 spawn）。
- 硬门禁：升级后先验 assistant 消息/part 形状与 `type=assistant` 过滤、permissions 仍接受且 deny-all 负路径无 tool、wait 可用/回退、`GET /api/session` 是否含 archived 及 DELETE 语义、MCP 每服务恰 1 进程/无重复 spawn/`tools/list` 稳定/`botmsg` 与 `searxng` 名称与 permissions 匹配、后台 compaction 摘要不被当本轮回复；Bot 真实回归在应用部署后做。
- 先决：升级前必须备份 v2.1.3 二进制 + data + env + unit + MCP 配置（现有 `/var/backups/opencode` 只有旧二进制）；失败回滚（必要时恢复 data tar）。升级步骤与 14 项矩阵见 `docs/DEPLOY.md` §3.2。

### 8. 修复批次与验证证据

- 批次：A 发布门禁（WEB-01/OPS-01/SEC-10、OPS-08/10、WEB 定向测试）→ B 安全与一致性（SEC-11、信任头簇、ARCH-04、BOT-02/04/05、DATA-02/03/04）→ C DR 与 UX（DATA-01、WEB-02/03/04、OPS-02/03/04、BOT-01）→ D 特性（加密核心 + 异地副本，默认关闭）→ E 文档与卫生（OPS-05/07/09、版本 0.7.0）。
- 本地门禁（v0.7.0 发布门禁，2026-10-25 实测通过）：`npm run check`、`npm test` **482**、`npm run test:web` **222**（44 文件）、`npm run test:coverage`（Lines 92.63% / Branches 78.16% / Functions 87.77%）、`npm run test:web:coverage`（Lines 52.31% / Branches 47.32% / Functions 45.02%）、`npm run build`（`index-DoPUAny6.js` 726.64 kB）、`node scripts/check-version.mjs`（严格 `version ok 0.7.0`）、PS 5.1 解析/BOM（7/7）、`check-prod-deps`、`scripts/test` 29 pass、`git grep` 占位符扫描；**生产已部署 v0.7.0**（release `20261025T010620Z`/commit `5c31162`）：部署内 smoke 23/23、完整 Access smoke 31/0/1/2；Tag 与真实 QQ 联调待用户验收。D-20 连续外发 1000ms 间隔为部署后追加项，门禁/部署记录见 `docs/ACCEPTANCE.md`。
- 生产验证：部署、smoke（含加密/异地只读检查）、OpenCode 2.1.4 升级矩阵、drill、PC 拉取/ack、用户验收均为发布后执行；本文件不以 mock 全绿代替。
- 证据边界：与第五轮一致——平台/模型/网络负路径仍需真实环境；PoC 只证明本地可复现。

### 9. 残余风险（明确）

1. **AI 主机边缘暴露**：应用侧已限流/去重，但 `ai` 主机未受 Access/WAF 保护（用户后台项）；边缘限流配置未验证；公网匿名请求仍可消耗一定资源。
2. **工具隔离 fail-closed 的产品代价**：隔离不可用时 Chat 暂停（503 + 固定提示），直到重试窗口恢复或重启；模型/上游异常期间 Bot 可用性下降属预期取舍。
3. **审计 best-effort**：非安全审计在 DB 故障时丢失，只留进程内计数；进程重启清零；安全关键审计仍可能因同一故障失败（可见但可能丢失）。
4. **备份加密残余**：明文临时文件窗口、2× 空间峰值、孤儿密文人工核对、私钥丢失不可恢复、Pi 不持私钥意味着 Web 不能恢复加密归档；预部署快照仍明文。
5. **异地副本残余**：默认关闭；单远端、依赖 PC 与 rclone；状态文件可被 PC 端伪造（管理员信任边界内），告警只反映状态文件；未配置时不告警。
6. **群记忆迁移**：无法映射归属的旧键保留 `legacy:` 且不参与按成员删除；同名用户历史覆盖无法自动还原。
7. **既有残余**：单管理员、sudo/RCON/单 SD/Cloudflare 明文、mock-only 平台负路径、限流内存态、`http-proxy` 弃用等按 `docs/SECURITY.md` §4 管理。

### 10. 结论

- 第六轮去重后 **P0=0、P1=3、P2=26、P3=73**；P1/P2 全部在本版处置，P3 可修小项随版修、架构性/已接受项写入明确残余（不删除、不静默）。
- 无 schema 迁移（保持 **v16**）；OpenCode 已按 §7 矩阵在生产只读升级 **v2.1.4**（V1–V9/V14 通过，V10–V13 待应用部署后真实 QQ 联调）。
- 本版为审计修复 + 灾备特性 Minor，不是第三方独立审计；生产结论以发布门禁、部署、smoke、升级矩阵、drill 与用户验收为准。
