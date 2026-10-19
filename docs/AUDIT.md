# AntifieldCloud 审计与修复记录（v0.2.0）

- 日期：2026-10-19
- 范围：v0.1.0 全部代码、部署脚本、备份、Pi/Cloudflare、前端与测试
- 方法：只读静态审查 + 进程内 PoC + 只读线上检查 + 回归测试；审计阶段未修改生产。
- 结果：所有 P0/P1 已修复；剩余项见“延后/残留”。

## 1. 审计发现与处置

### 安全/可靠性（P0）

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

### 安全/正确性（P1）

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
