# CHANGELOG

> 按时间正序。实机调研与终态声明见 docs/RESEARCH.md；任务状态以 docs/TASK-INDEX.md 为准。

## 2026-10-08

- **P0-03 落地（2026-10-08）**：v2 安装首跑因 registry 瞬断失败，重试成功，`opencode v2.0.24`（binary 191M，`~/.opencode/bin`，symlink 至 `/usr/local/bin/opencode`；安装脚本尾部 PATH 探测在 nologin 用户下会卡住，已 kill，无影响）；`opencode.service` enabled+running（workbench，`127.0.0.1:4096`，basic-auth 生效：无凭据 401，有凭据 200）。关键发现：**v2 API 全面换前缀**，v1 路径（`/global/health`、`/event`、`/doc`）全部返回 SPA HTML；真实路由：健康 `GET /api/info`（`{version:"2.0.24"}`）、事件 `GET /api/event`（SSE 首帧 `server.connected`，包络 `{id,type,data{sessionID?}}`，终端类型 `session.execution.finished/session.idle/session.error`）、会话 `GET/POST /api/session`（包络 `{data}`）、下发 `POST /api/session/{id}/prompt {text}`、中断 `POST /api/session/{id}/interrupt`；OpenAPI 快照存档 `docs/opencode-openapi.json`（117 路由）。实测下发 `ping` 全链路跑通（provider 为空时默认 `exo-free`，上游 503 重试中——真实 AI 任务需用户配 Key，P0 出口前置）。serve 空载 RSS 293M，符合预算。适配器已按 v2 重写（v1 回退删除，随 binary 同退役），网关 `/api/ai/*` 经 Pi 实测往返 ok，探针会话已删。

- **P0-04 落地（2026-10-08）**：控制台只读五端点经 Pi 实测——`overview` 温度 49.1 vs `vcgencmd` 48.8（Δ0.3°C），内存/负载/diskstats/journal(8M) 一致；`logs?unit=ssh.service` 返回真实条目（workbench 已入 `systemd-journal` 组）；`apt` 首版把 `正在列表...` 计入 count=2，已修过滤（`/` 判定）复验 count=1；`metrics_ts` 批量落盘行增（ flush 间隔经 `systemctl set-environment` 临时 15s 验证后恢复默认 5min），`journal_mode=wal` + `synchronous=1(NORMAL)` 为网关连接实测值（注：synchronous 系 per-connection，空连接查出 FULL 属正常）；`node:sqlite` 内建驱动可用，无额外依赖。部署插曲：`sys.ts` 误写 `./metrics.js` 致网关 crash-loop，本地 typecheck 未拦（`tsc -p` 报了错但被 `tail` 吞掉退出码——教训：以 `npm run typecheck` 为准，不看 tail），已修复。

- **移除 dsh 及残留（2026-10-08 用户指令）**：`systemctl --user stop+disable dsh.service`（`inactive (dead)` + `disabled`），`127.0.0.1:3080` 已释放；`npm uninstall -g @deepseek-ai/dsh`（`removed 488 packages`，`npm ls -g` 仅剩 `npm+pnpm`）；用户单元文件、`~/.dsh`、`~/projects/dsh-plugin-pinas`（37M）移入退役库 `dsh/`；opencode v1 四处残留（`config 63M`、`cache 5.2M`、`share 2.5M` 含 `opencode.db`、`state 16K`）移入退役库 `opencode-v1/`，原路径确认清空；`/tmp` 内测试残留已删。`3100` 与 `3080` 均无监听，`pidsh` DNS 由用户手动清理。遗留非运行残留（`~/build/Pinas` 源码、`~/.npm/_npx` 缓存、`~/bin/fix-dsh-profile-links.sh`）保持不动。

- **备份目标确定**：PC 目录 `D:\PiBackUp`（已创建）。退役快照 5 文件已回传验证通过。每晚流水线（P0-08）拉取方式待定（PC 从 Pi 经 SFTP 拉取，避免在 Pi 存 PC 凭据）。

- **移除 opencode v1**：`npm uninstall -g opencode-ai`（nvm node v26.7.0），`removed 2 packages`，`which opencode` 已无结果；`@deepseek-ai/dsh`、`pnpm`、`npm` 保留。`~/.config/opencode`、`~/.local/share/opencode/opencode.db`、`~/.cache/opencode/models.json` 暂留待 v2 迁移评估（P0-03 处理）。此后 v1 serve 实测数据（RSS 343M）仅作预算参考。

- **停用 pinas/Antifield Cloud v1.12.0**：`sudo systemctl stop + disable antifield-cloud.service`，实测 `Active: inactive (dead)`、`is-enabled: disabled`、`ss` 中 `3000/3100` 已释放（`PORTS_FREED`）。数据目录 `~/pinas` 原样保留（`cloud_disk.db`、`uploads/`、`backups/`、二进制）；退役快照存 `/home/antifield/retire-backup-20261008/`（`.env`、`VERSION`、`auth` 备份、`sha256`、表清单）并已回传 PC `D:\PiBackUp\retire-20261008/`。`3000` 端口即日起由本项目网关复用。其他服务（minecraft/mc-server/cloudflared/nginx/lightdm/ssh/frpc）实测仍 `active (running)`，桌面栈未动。

- **P0-02 落地（2026-10-08）**：新建系统用户 `workbench`（uid 997，nologin）；`/home/antifield` 为 0700，改实体复制 `/usr/local/bin/node`（148M，0755；node 升级时重拷）；网关部署于 `/opt/workbench/gateway`，`/etc/workbench/env`（0400，含生成的 `OPENCODE_SERVER_PASSWORD`）就绪；`workbench-gateway.service` enabled+running（RSS 75M，`MemoryMax=350M`）。

- **P0-05 落地（2026-10-08）**：`POST /api/sys/services/:unit/:action` 经 Pi 实测——白名单内 `restart opencode` 200（服务 12:12:44 重起）；网关自重启客户端掉线（HTTP 000，符合预期并已在代码注释）后 3s 内 `/health` 恢复；白名单外 `stop minecraft`/`restart nginx`/`status minecraft` 全部 403 且 `service_audit` 有 `allowed=0` 行。特权链：`workbench` 经 `/etc/sudoers.d/workbench-systemctl`（root:root 0440，visudo 通过）免密仅 3 条 restart；首部署 `cp -a` 留下 antifield 属主致 sudo 告警，已 `chown 0:0` 修复。关键坑：systemd `NoNewPrivileges=true` 会禁掉 sudo 提权致 502，已从网关单元移除（sudoers 精确条目才是真实边界，见 ARCH §5）；预置的 `/etc/sudoers.d/010_antifield-nopasswd` 模式 644（应 0440）系历史遗留，未动。

- **P0-06 落地（2026-10-08）**：网关占位首页 `/` 上线；`config.yml` 备份后 `pidsh→:3100` 改 `:3000`（`cloud` 免改），经网关自身 API `restart cloudflared`（200），tunnel QUIC 重连成功；本机公网实测 `https://cloud.antifield.work/health → 200`（CF RAY 头正常）、`pidsh` 同样 200、`https://cloud.antifield.work:4096 → 000`（无 ingress，符合零暴露）。**缺口：CF Access 策略未生效（当前公网直通 200，无登录挑战），需用户在 Cloudflare dashboard 为 `cloud/pidsh` 主机名启用 Access，启用后复验命令：`curl -sI https://cloud.antifield.work/` 应 302 到 `*.cloudflareaccess.com`。** 在 Access 启用前，网关无自身认证，公网可直达 API——P0 出口前必须补上。

- **P0-08 落地（2026-10-08，备份链路 ok → P0-07 解锁）**：Pi 侧 `backup.sh`（workbench 身份，`sqlite .backup` 双库 + config 打包 + env + sha256 + `backups` 行，>7d 修剪）由 `workbench-backup.timer` 每日 02:30 触发；手动连跑 3 轮（`SNAPSHOT_OK`×3，每份 6.4M，`backups` 3 行 ok）；恢复演练 `restore-drill.sh` 在最新快照上 sha 全过、`integrity_check` 双 ok、行数可读（`metrics_ts=17` 等），演练目录已清；PC 侧 `scripts/pc-pull.py`（SFTP 拉取 + sha256 全文件校验 + `manifest.log`）首跑因 `env` 600 无权 FAIL，改 `setfacl u:antifield:r`（单文件读 ACL，不动属主/大权限）后 3 快照×4 文件全对 `PULL_OK`；`manifest.log` 保留 FAIL+OK 两行备查；Windows 计划任务 `PiBackUp-Nightly` 每日 03:00 已注册。注意：v2 数据在 `/home/workbench/.local/share/opencode`（6.1M），`/var/lib/workbench/opencode` 为空目录——备份取前者。“连续 3 晚”以 3 轮手动 + 双定时器延续覆盖，日历 streak 由 manifest 累积，P0 出口复核。

- **P0-07 落地（2026-10-08，P0 代码任务清零）**：journald 切 `Storage=volatile + RuntimeMaxUse=64M`（drop-in 修后 `restart systemd-journald`，持久路径 `/var/log/journal` 已空，运行时日志上限 64M；另有一处 `ForwardToSyslog=yes` 覆盖（非我方文件），但无 rsyslog，`/var/log/syslog` 不存在，无影响）；`apt install log2ram 1.7.2`（trixie/main），128M tmpfs 接管 `/var/log`（已用 3%），`logger` 写测经 journal 可查；7 个关键服务全 running。tmpfs 预算更新：`/tmp 4G + /var/log 128M`。验收说明：`journalctl --disk-usage` 即时仍 8M（运行时旧日志，自然轮转至上限内），持久写入已归零才是本次收益。

- **重启验证通过（2026-10-08 13:06-13:09）**：`sudo reboot` 后 60s SSH 恢复（新 boot，旧日志 volatile 已清）；9 服务全 `active (running)`（gateway/opencode/cloudflared/minecraft/mc-server/nginx/lightdm/ssh/frpc）；网关 `/health`、`/api/ai/health(2.0.24)`、`overview(cpu 0.8%)` 全 200；log2ram 已挂载、持久 journal 为空、备份 timer 待触发（次日 02:30）；公网 `cloud/health` 重启后复验 200。

- **opencode 二进制移机（2026-10-08 13:18，用户报 Pi 终端找不到 opencode）**：根因 `/home/workbench` 700 + symlink 穿 700 目录，antifield 无权执行。已迁至 `/opt/opencode/bin/opencode`（root:root 0755），symlink 重指，antifield 直调 `opencode v2.0.24` 成功；`opencode.service` 重起正常、网关代理 healthy；workbench 家中 199M 原件已删（省 SD）。Pi 终端新开即有 `opencode`（旧终端需 `hash -r`）。待用户在 Pi 终端执行 `opencode auth login` 完成模型账户配对后，验证 `/api/provider` connected 并下发首个真实编码任务（P0 出口核心项）。

- **首个真实 AI 任务成功（2026-10-08 13:35，P0 出口核心项）**：用户完成 `opencode auth login`（antifield 身份）后，发现 serve（workbench 身份）`provider/model` 为空——诊断为凭据存于 antifield 库（`credential` 1 行）而 serve 读 workbench 库（0 行）。经 SQL 跨库复制凭据行（值不落地日志）+ `POST /api/credential/{id}/activate`（204）后，provider 出现 `opencode-go`/`opencode Zen`，模型可见。下发建文件探针任务，全流式时间线完整（inbox→execution→step→tool.called→tool.success→text.delta→step.ended→**execution.succeeded**），产物 `P0-EXIT-PROBE.md` 内容精确；探针文件与会话已删。适配器终端事件集补 `succeeded/failed` 并同步部署。结论：**serve 必须与登录身份同库——后续登录请用 `sudo -u workbench opencode auth login`，或走本次迁移流程**。

- **SSH 22 间歇性不通（2026-10-08，多次）**：现象 ping 通/80 通/公网业务全正常、唯 22 SYN 无回；重启后复发，用户侧 `sshd active+listening`、无防火墙（iptables/nft 未装）、日志可见我方连接曾 `Accepted publickey`。结论：Pi 侧服务正常，疑直连链路/网卡 TCP 偶发；公网链路始终 200。部署改重试+`npm ci` 固化后一次通过。

- **P1-01 落地（2026-10-08）**：效率 API 四类全通（todos PATCH done、notes、bookmarks 拒 ftp、files 上传/下载/删除/404/空体400/穿越收敛）；重启后行数与 blob 都在，二进制落盘 `/var/lib/workbench/files`（库中仅元数据），探针已清。教训：① 无 lockfile 部署致 Pi/本地依赖漂移（Pi tsc 报 `SQLInputValue`/`unknown` 错而本地过）——此后发版必带 `package-lock.json` + Pi 侧 `npm ci`；② 部署脚本以 `tail` 取退出码会吞掉 tsc 失败（重犯），一律 `> log 2>&1; echo EXIT:$?`。

- **P1-02 落地（2026-10-08）**：流水线三类任务经 Pi 实测——shell 手动 `done`；`*/cron * * * * *` 3 分钟连触发 3 次全 done；opencode 下发 `done`（session 创建 + 全事件流进 `job_runs.log`）；探针 jobs 已删。教训：`node:sqlite` 新版类型不许 `.all() as JobRow[]`（TS2352），改逐字段映射；以及 tsx 跑测试不做类型检查——此前“本地过、Pi 挂”的真正原因是漏跑了本地 typecheck，已与发版铁律对齐（此后每次先 typecheck 后 test）。

- **P1-03 落地（2026-10-08）**：门户端点按请求读配置，Pi 实测改 json 即 1→2 卡（免重启，已还原）；`ss` 确认仅 `127.0.0.1:3000`。过程缺口：`portal.json` 从 P0-05 起就没部署到 Pi（只布了白名单），端点首验 500——教训：发版清单须含 `config/` 非代码文件，已补 AGENTS 发版铁律。

- **P1-04 落地（2026-10-08）**：看门狗五项（tunnel/temp/mem/backup/opencode）60s 一检，异常记 `job_runs(job_id=watchdog)`，`/api/sys/watchdog` 可查。Pi 实测全绿（backup 2.1h）；`WB_TEMP_ALERT_C=0` 压阈值 2 分钟内落 2 条 alert 行，阈值已恢复、网关 healthy。本地 25/25。

- **P1-05 落地（2026-10-08）**：`pidsh` ingress 已删（有备份），现仅 `cloud→:3000` + `mc→tcp:25565` + 404；公网 `cloud` 200、`pidsh` 000。事故：删 ingress 的行跳逻辑多吃了一行（吞掉 mc hostname），cloudflared crash-loop 约 1 分钟，经网关 API 重启恢复。教训：改 cloudflared 配置必须先 `cloudflared --config <f> tunnel ingress validate`（或至少重启后 15s 内查 `journalctl` 无 ERR），再验公网。

- **P1-06a 落地（2026-10-08）**：SolidJS+Vite+Tailwindv4 脚手架 + 控制台页（温度/CPU/内存/SD/告警/白名单重启），网关 `@fastify/static` 同源托管 `/opt/workbench/web/dist`，公网 `/` 200。教训：① `package.json` 加依赖后必须同步 `/opt` 的 `node_modules`（漏同步致 `ERR_MODULE_NOT_FOUND` crash-loop，已补铁律）；② 本地 typecheck 长期“假绿”——输出截断漏看了 TS6059（rootDir），改双 tsconfig（`build` 专用 `tsconfig.build.json`）+ 只看退出码；③ TS7 顶层 await 解析异常，入口改 `.then` 写法。

- **P1-06b 落地（2026-10-08，P1 代码全清）**：AI/效率/流水线/门户四页 + 网关 `promptOnly/messages` 接口；新包（24K JS）公网 200；AI 全链经网关验证（建会→下发→轮询出 assistant 真实回复→清会话）。SSH 中途 6 连超时后自恢复（直连链路老毛病，公网一直 200）。

- **AUTH-01 落地（2026-10-08，用户决策：内置密码替代 CF Access，tunnel 保留做传输）**：scrypt 哈希入库 + `wb_session`（HttpOnly/Lax/30d）+ 全局失败退避（tunnel 后同源 IP，限流按全局计数）；首启生成随机口令，密封文件 `/var/lib/workbench/initial-password`（0400，改密自动删）；前端未认证只显登录页。线上实测：无 cookie 401、密封登录 200、登出后 401、sessions 已清零待用户首登。旧测试全量补登录（helper），本地 28/28。CF Access 不再需要（关闭 P0 缺口项）。

- **AUTH-02 落地（2026-10-08，用户决策：口令只存 `.env` 的 `AUTH_LOGIN_PASSWORD`）**：删 DB 哈希/密封文件/改密端点，登录只认 env（timingSafeEqual，<8 位视为未配置）。线上实测 401/401/200 全对，旧密封与 `auth_config` 已清。教训×2：① 部署用了相对路径 `cp -a dist`（第二段命令 cwd 是 $HOME）致旧代码继续跑——一律绝对路径；② 拼接 shell 传密码时变量展开掉致空值——敏感值一律 `printf+单引号` 直写。口令已生成并设入 env，PC 临时脚本用后即删。

- **P2-02 落地（2026-10-08）**：`GET /api/sys/metrics/export?range=`（1h/24h/7d）吐 CSV，线上导出真实行、未登录 401；30 天滚动由 flush 裁剪 + 单测覆盖。本地 31/31。

- **P2-04 落地（2026-10-08）**：登录 fail/ok 记 `auth_audit`（不记口令）；`GET/DELETE /api/auth/sessions`（id 前缀吊销）；`service_audit.actor` 从 `local` 改为 `ses:<会话前缀>`，线上越权行归因成功。本地 32/32。

- **口令切换用户值（2026-10-08，用户选 A）**：Pi `/etc/workbench/env` 改用户口令并重启，实测裸值 200。细节：用户 `.env` 值为引号包裹形式，按 dotenv 惯例剥引号后生效（带引号视为错误口令 401）；旧生成口令已失效。公开文档不记录口令值。

## 2026-10-09

- **SEC-01 修复认证覆盖面（评估高危项）**：`registerAiRoutes` 原注册在全局 `onRequest` 登录钩子**之前**——Fastify 钩子只作用于其后注册的路由，导致 `/api/ai/*` 可无 cookie 调用。已移到钩子之后；新增 `gateway/test/auth-coverage.test.ts` 锁定业务 API 无 cookie → 401。**须部署到 Pi 后实机复验**。
- **SEC-02 口令比较与 schema 清理**：`verifyPassword` 同长缓冲 + `timingSafeEqual`，消除长度旁路；删除 `auth_config` 残留建表。新增 `gateway/test/password.test.ts`。
- **SEC-03 备份凭据脱敏 + 拉取端 host key**：`backup.sh` 备份 `env` 将口令置 `__REDACTED__`（真值只留 Pi `/etc/workbench/env`）；`pc-pull.py` 改 `RejectPolicy` + known_hosts。ARCHITECTURE §4/§5 同步。
- **评估遗留**：① 公网登录口令强度不足，换 16+ 位随机（SEC-04）；② 部署后实机复验；③ P0「连续 3 晚」备份日历 streak 待 timer 走完。

- **文档职责切分（2026-10-09）**：TASK-INDEX 扩为唯一任务事实源（P4-01…P6-04 逐条含依赖/工作量/实机验收/风险）；ROADMAP 精简为里程碑目标、顺序、总量与里程碑级风险，不再重复任务表。AGENTS 文档维护表已对齐。

- **SEC-04 落地**：Pi \/etc/workbench/env\ 换 20 位随机强口令并重启，旧会话已清；复验未登录 \/api/ai/sessions\ 401、登录后 \/api/ai/health\ 2.0.24、旧口令 401；手动 \ackup.sh\ 快照 ok（env 双口令均为 \__REDACTED__\）；PC \pull.py\（known_hosts pin）\PULL_OK\。公开文档不记录口令值。

- **P3-01 落地**：API 请求审计（\pi_audit\）：只记元数据，query 丢弃、id 段收敛，60s 批量落盘 + 30 天裁剪；未登录 401 记 \ctor=anon\。线上实测归因与脱敏全对。本地 42/42。

- **P3-02 落地**：会话 7d 绝对上限（NULL 老行强制重登）+ 滑动续期（剩<24h 延至 min(+30d,创建+7d)，\WB_SESSION_SLIDING=0\ 可关）+ hook 内 touch；shell job 执行与 service restart 前端二次确认；登录≈workbench 单用户语义进 ARCH。线上新会话 200，旧 NULL 行清零。本地 43/43。
