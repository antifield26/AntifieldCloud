# 实机调研报告（RESEARCH）

> 实测优先：本文件所有“已实测”结论均来自 2026-10-08 对实机 `RPI5` 的 SSH 实测。
> 未能实测的项明确标注为【待实测】，不以假设代替。
> 安全要求：本文档不记录任何密码、Token、API Key、私钥。凭据只存于实机受限文件与 OpenCode 本地配置。

- 实机：Raspberry Pi 5 Model B Rev 1.0，`aarch64`，Cortex-A76 x4
- 系统：Debian 13.7 (trixie)，内核 `6.18.50+rpt-rpi-2712`
- 连接方式：RJ45 直连 PC，链路本地地址 `169.254.77.10/16`（PC 侧 `169.254.77.203`），SSH 22 通；出网经 `wlan0`（`172.23.95.98/21`，网关 `172.23.88.1`）
- 实测时间：2026-10-08 11:14–11:16 CST（`up 2:18–2:20`），`load average 0.01–0.23`，基本空载
- 本地复核机：Windows + Node v26.10.0；实机 Node 见下文

## 1. OpenCode v2 安装与兼容性【部分实测，其余待实测】

### 1.1 已实测（v1 现状，可作为 v2 前置参考）

| 项 | 实测结果 |
|---|---|
| 正确安装入口（v1） | `curl -fsSL https://opencode.ai/install \| bash`（文档站实测）。旧地址 `/install.sh` 返回 404，属预期，不再使用 |
| v2 安装入口 | `https://opencode.ai/v2/install` 可达，脚本头正常返回；npm 包 `@opencode/cli-linux-arm64` 存在，`latest=2.0.24`，说明 **v2 已提供 linux-arm64** |
| 实机已装版本 | `opencode 1.18.29`，经 nvm Node `v26.7.0` 下的 npm 包 `opencode-ai` 安装，`which opencode → ~/.nvm/versions/node/v26.7.0/bin/opencode`（symlink 到 `../lib/node_modules/opencode-ai/bin/opencode.exe`）。上游最新 v1 为 `v1.18.35`（2026-10-06），实机落后 6 天 |
| Node | nvm 提供 `v26.7.0`（`npm 12.0.2`，实测输出值），`ls ~/.nvm/versions/node/` 仅此一版；系统 PATH 无 node（`which node` 失败），systemd 单必须用绝对路径或 `Environment` 注入 |
| Bun | 未安装（`which bun` 失败，`~/.bun` 不存在） |
| 配置现状 | `~/.config/opencode/opencode.jsonc` 仅含 `$schema`；plugin `@opencode-ai/plugin 1.18.22`；`~/.local/share/opencode/auth.json` 键为 `["opencode","opencode-go"]`（未展开值）；`opencode.db 2.3M + WAL 4.0M + shm 32K`，表含 `session/message/part/project/workspace/todo/permission/event` 等；`~/.cache/opencode/models.json 4.4M` |
| `opencode serve` 实测 | `opencode serve --port 4099 --hostname 127.0.0.1` 启动成功，日志 `listening on http://127.0.0.1:4099`；`GET /global/health → {"healthy":true,"version":"1.18.29"}`；`GET /event` 与 `GET /global/event` 均 returns SSE 首帧 `server.connected`；未设 `OPENCODE_SERVER_PASSWORD` 时打印 `server is unsecured` 警告 |
| 内存占用实测 | serve 进程 `RSS 351616 kB ≈ 343 MB`，`Threads 12`，`VSZ 74 GB`（虚拟保留，忽略）。结论：**空载 0.34 GB，符合预算 0.5–1 GB 下限**，但真实任务 + LSP 时会涨，需复测 |

### 1.2 待实测（v2，必须在 P0 完成前补）

- [ ] 在实机用 `https://opencode.ai/v2/install` 安装 v2（含 `--version 2.0.24`  pin），记录 ARM64 二进制体积、启动时间
- [ ] v2 `serve` 同端口复测：`/global/health`、`/event` SSE、`/doc` OpenAPI 可达性，空载 RSS 与连续 30 min RSS 曲线
- [ ] Node 26 下 `@opencode-ai/sdk` / 薄适配器 `fetch + EventSource` 连通性（含 `OPENCODE_SERVER_PASSWORD` basic-auth）
- [ ] v1（1.18.29）与 v2（2.0.24）API 差异点清单（至少确认 `/global/event` vs `/event`、`prompt_async`、`session/:id/permissions` 行为）

### 1.3 结论与对策

- 安装方式：v1/v2 的 ARM64 均可用，官方脚本 + npm 双通道；**P0 锁定 v2 `2.0.24`，保留 v1 1.18.29 作回退**，适配器做版本嗅探（`/global/health.version`）
- Node 26：与已装 opencode 1.18.29 共存实测通过；v2 的 npm 元数据显示 `_nodeVersion 26.4.0`，同代兼容，**无需双轨降级**，但网关 `package.json engines` 仍 pin `node >=26`
- serve 必须：`--hostname 127.0.0.1` + `OPENCODE_SERVER_PASSWORD` + 网关代理，绝不直接暴露；以独立低权限用户运行（见 §4）

## 2. SD 卡基线【已实测快照，24h 待测】

| 项 | 实测结果 |
|---|---|
| 型号/容量 | `mmcblk0 59.5G`，`name SR64G`，`manfid 0x000003`（SanDisk），`oemid 0x5344`，`hwrev 0x8`，`fwrev 0x6`，`date 04/2024`，`CID 0353445352363447…`，`type SD`。p1 512M vfat `/boot/firmware`，p2 59G ext4 `/`（`noatime`） |
| 健康接口 | **无**：`/sys/block/mmcblk0/device/life_time`、`pre_eol_info` 不存在；`smartctl`、`tune2fs`、`blockdev` 未安装；`ext_csd` debugfs 不存在。SD 卡无法像 eMMC 读寿命，只能用写入量 + 定期 `fsck` + 备份恢复演练间接保障 |
| 空间 | `df` 根分区 `58G / 32G 已用 / 24G 可用（58%）`；`du` 大头：`/home 23G`（`minecraft-backups 12G` + `minecraft-server 4.6G`）、`/usr 5.2G`、`/var 3.5G`、`/opt 719M`（含 `jdk-25`）。`pi_nas` 相关仅 `~/pinas 64M`（`uploads 40M` + `backups 1.7M`）+ `cloud_disk.db 224K` |
| 写入快照 | boot 后 ~2.3h：`mmcblk0` 读 21470→54707 次 / 写 10449→10597 次，写扇区 `531225→534642`（`×512B ≈ 272→274 MB`）。折算 **~50–120 MB/h，即 ~1.2–2.8 GB/天**（含 minecraft + journal + minecraft 日志）。两次采样间隔 2 min 增量 1.75 MB，量级一致 |
| 现有减负 | `/tmp tmpfs 4.0G` 已挂载（已用 432K）；`/run tmpfs`；`zram 2G swap`（未用）；`fstab` 仅 `noatime`，无 `commit=`、无 `log2ram`；`journald.conf` 全注释（默认 `Storage=auto`），但实测 `/var/log/journal` 为空、`journalctl --disk-usage` 仅 8M 且运行时日志在 `/run/log/journal/<machine-id>` —— 实际近似 volatile，原因待查（可能镜像默认清理），**不可依赖，需显式配置 `Storage=volatile` + `RuntimeMaxUse` 后复验** |
| 工具缺失 | `iostat`、`swapon`、`zramctl`、`avahi-browse`、`showmount`、`smbclient` 均未安装或不在 PATH，P0 按需 `apt install`（先确认 24G 空余 + 备份链路，见风险 R3） |

结论：单卡 64G 无冗余、已用 58%、日写 GB 级；**写入减负与备份是 P0 最高优先级**，24h 定量（`diskstats` 采样 + `journalctl --disk-usage` + `du /var/log`）列为 P0-T 验收前置。

## 3. cloudflared【已实测】

| 项 | 实测结果 |
|---|---|
| 版本/路径 | `cloudflared version 2026.8.1 (built 2026-08-13)`，`/usr/local/bin/cloudflared`（`/usr/bin` 为同体），service `enabled + active (running)` 自 2026-10-07 23:28，`--no-autoupdate --config /etc/cloudflared/config.yml tunnel run` |
| 配置（已脱敏） | `protocol: http2`；`credentials-file /etc/cloudflared/b6683fba-….json`（0400）；ingress：`cloud.antifield.work → http://localhost:3000`、`pidsh.antifield.work → http://localhost:3100`、`mc.antifield.work → tcp://localhost:25565`、兜底 `404`。工作台域名需新增 ingress（P0 任务） |
| 稳定性 | `journalctl -u cloudflared -n 30` 可见 08:57–09:15 多次 `edge closed / dial tcp …:7844 i/o timeout` 后 `Retrying in 1–4s` 并恢复。结论：**抖动自愈，但需监控**（P1 自动化：tunnel 健康探针 + 断线告警） |
| CF Access | Pi 侧无 Access 配置（符合预期，Access 在 Cloudflare  dashboard 侧）。【待实测】公网经 Access 登录工作台全链路（P0 出口标准第一项） |

## 4. 控制台数据源【已实测】

| 数据源 | 实测行为 | 网关采集方式（ARCHITECTURE 细化） |
|---|---|---|
| `/proc`（stat/meminfo/loadavg/diskstats） | 全部可读，`vmstat 1 3` 正常，CPU 99% idle | 轮询 5s，内存聚合（见存储策略） |
| 温度/频率 | `vcgencmd measure_temp 47.2°C`、`thermal_zone0 47400` 一致；`get_throttled 0x0`；`measure_clock arm 1.6 GHz`；`get_mem arm 1016M gpu 8M`；`version 2025/05/08` | 轮询 5s，`vcgencmd` 失败时回退 `thermal_zone0` |
| systemd 启停 | `busctl --system list` 正常；`systemctl show -p Names,LoadState,ActiveState,SubState` 正常；`antifield` 当前 `(ALL:ALL) ALL + NOPASSWD: ALL`（**过宽，P0 必须收敛**：新建 `workbench` 低权限用户，仅对白名单服务 `systemctl start/stop/restart` 免密，其余一律拒绝并审计） | 网关以 `workbench` 身份 `systemctl --no-ask-password <verb> <unit>`，白名单外直接 403（不透传 systemd） |
| journald 查询 | `journalctl -o json -n 2`、`-u ssh -n 5`、`--list-boots` 均正常；`systemd-analyze cat-config` 可用 | `journalctl -o json --since` 增量拉取，网关侧做级别过滤与脱敏 |
| PSI | `/proc/pressure/*` 不存在（内核未开），`exit 1` | 架构中标记为可选，不依赖 |

## 5. NAS 与备份【已实测：无外部 NAS】

- 外部 NAS：**不存在**。`/mnt` 空、`/media` 仅空目录、`fstab` 无 cifs/nfs、`mount` 无网络盘、`/etc/samba` 不存在、`smbclient/showmount` 未安装、`rsync 3.5.0` 唯一可用。`avahi` 仅 mDNS 栈，无浏览工具。
- 实际“NAS”即本机服务：`antifield-cloud.service`（`pi_nas v1.12.0`，Rust 单 binary 7.3M，`WorkingDirectory ~/pinas`，`Restart=on-failure`），监听 `0.0.0.0:3000`（网盘）+ `127.0.0.1:3100`（dsh 反代）+ `dsh web 127.0.0.1:3080 --trusted-host pidsh.antifield.work`。DB `cloud_disk.db`（含 `files/users/shares/todos/links` 等表，WAL 已 checkpoint，`wal 0`）。`backups/` 有 `cloud_disk_backup_20261007_*.db`（服务自带日备，但**同卡**）。
- 晚间窗口：默认路由 `wlan0` 到网关 `172.23.88.1` ping `4.1–4.6 ms`，0 丢包；`registry.npmjs.org` 与 `api.github.com` 出网正常。局域网备份带宽实测方法已具备，目标缺失。
- 结论：设计中的“每晚推送 NAS”**当前无异地目标，等于同卡拷贝**。P0 必须先定目标（二选一）：(a) PC 侧目录经 `rsync over SSH` 拉取（RJ45 直连 `169.254.77.203`，带宽最高，最推荐）；(b) 另购 USB/NVMe 或远端 S3。**在备份链路可用前，不动 `journald/log2ram/fstab`（安全红线）**。

## 6. 系统资源与内存预算校准【已实测】

| 进程（RSS 降序） | 实测 | 预算对照 |
|---|---|---|
| `java PaperMC 26.1.2`（`-Xms2G -Xmx4G`） | `RSS 2.47G`，占 `29.9%` | 预算外巨兽。P0 不动业务，但必须 `-Xmx` 下调或错峰，否则 OpenCode+LSP+网关无空间 |
| 桌面栈（labwc/Xwayland/fcitx/wf-panel/pcmanfm/wayvnc/portal） | 合计约 `0.5G` | headless 场景可整体停用，释放 0.5G（P0 可选任务，需用户确认是否保留桌面） |
| `dsh web`（node v26.7.0） | `RSS 140M` | 参考：网关 Fastify 目标 ≤300M 合理 |
| `mc-server`（Rust） | `RSS 85M` | 良好 |
| `cloudflared` | `RSS 39M`，`Tasks 10` | 良好 |
| `pi_nas` | `RSS 32M`，`Tasks 9` | 良好（初期门户复用它，不另起服务） |
| 系统空余 | `MemAvailable 4.7G`，`swap 2G` 未用，`zram zstd` | OpenCode serve 空载 0.34G + 网关 0.3G + LSP 0.5–1G 按需，理论可容；但与 java 2.4G 同机需设 `MemoryMax` + 告警水位 |

基线命令（P0 网关照抄）：`free`、`cat /proc/{meminfo,loadavg,stat}`、`vcgencmd`、`cat /proc/diskstats`、`journalctl --disk-usage`、`ss -tlnp`。

## 7. 兼容性问题与对策汇总

| # | 问题 | 对策（已落实到 ROADMAP/TASK-INDEX） |
|---|---|---|
| C1 | `install.sh` 404，易误用旧文档 | 统一用 `/install`（v1）与 `/v2/install`（v2）；ARCHITECTURE  pin 版本号 |
| C2 | 系统 PATH 无 node，nvm  only | 网关 systemd 使用绝对路径 `/home/workbench/.nvm/versions/node/v26.7.0/bin/node` 或将 node 链接到 `/usr/local/bin`（P0-T 显式任务） |
| C3 | SD 无寿命 telemetry | 用写入量代测 + 每晚备份 + 季度恢复演练；文档明确“无 `life_time` 即结论” |
| C4 | v1 与 v2 API 并存（`/event` vs `/global/event` 等） | 适配器做 `GET /global/health.version` 嗅探 + OpenAPI `/doc` 校验，v1 作回退 |
| C5 | journald 看似 volatile 但配置缺失 | P0 显式写 `Storage=volatile + RuntimeMaxUse=32M`（备份链路就绪后），并复验 `journalctl --disk-usage` |
| C6 | `pi_nas:3000` 监听 `0.0.0.0`，与“只绑 localhost”冲突 | P0 改为 `127.0.0.1:3000` 由网关统一代理，cloudflared ingress 指向网关端口（单入口） |

## 8. 风险清单（含缓解）

| ID | 风险 | 等级 | 缓解（Owner：Agent，验收见 TASK-INDEX） |
|---|---|---|---|
| R1 | Java PaperMC 常驻 2.4G，挤占 AI/网关内存，8G 预算失守 | 高 | P0：`MemoryMax` + 温度/内存告警；P1：将 `minecraft.service` 纳入白名单受控启停（默认不动，先监控）；备选停桌面栈释放 0.5G（需用户确认） |
| R2 | SD 单盘 58% 已用，日写 1–3G，无寿命读数，掉盘即全丢 | 高 | P0：写入减负（WAL+NORMAL、5–10min 批量落盘、log2ram、journald volatile、/tmp tmpfs 已有）；连续 3 晚备份 + 1 次恢复演练为 P0 出口 |
| R3 | 无外部备份目标，同卡备份等于无备份 | 高 | 目标已定：PC 目录 `D:\PiBackUp`（2026-10-08 用户确认）；退役快照已回传 `D:\PiBackUp\retire-20261008`；每晚流水线待 P0-08 落地；**目标就绪前不动存储配置**；备份含校验（sha256）+ 失败告警 |
| R4 | `antifield` 拥有 NOPASSWD ALL，网关越权风险 | 高 | 新建 `workbench` 低权限用户；sudoers 仅白名单动词；白名单外 403 + 审计表；AGENTS.md 红线 |
| R5 | cloudflared 边缘抖动（`7844 timeout`） | 中 | 网关 `/health` 探针 + tunnel 重连告警；CF Access 全链路实测纳入 P0 出口 |
| R6 | v1/v2 双版本漂移，适配器被击穿 | 中 | 适配器为唯一边界，pin 版本 + OpenAPI 快照 + 契约测试；任何直调 OpenCode 视为 bug |
| R7 | 桌面/minecraft/FRP（`frpc-minecraft` 出站隧道）等存量服务与新网关端口冲突 | 中 | `ss -tlnp` 基线已锁：22/80/3000/3100/3080/25565/25575/25599/111/20241；新网关固定 `127.0.0.1:3090`（暂定），nginx 只做本机反代，cloudflared 单 ingress 指向网关 |
| R8 | 出网经 wlan，受限网络下 npm/GitHub 超时 | 低 | 已验证出网正常；P0 构建产物 pin lockfile，失败重试 + 镜像源预案 |

## 附：实测命令索引（复现用，不含凭据）
- `uname -a; cat /etc/os-release; lscpu; free -h; uptime; ps aux --sort=-%mem | head`
- `vcgencmd measure_temp; vcgencmd get_throttled; vcgencmd measure_clock arm; cat /sys/class/thermal/thermal_zone*/temp`
- `lsblk -o NAME,MODEL,SIZE,TYPE,MOUNTPOINT,FSTYPE; df -hT; cat /etc/fstab; cat /sys/block/mmcblk0/device/{name,manfid,oemid,hwrev,fwrev,serial,date,type,cid}`
- `cat /proc/diskstats | grep mmcblk0; journalctl --disk-usage; journalctl -o json -n 2`
- `cloudflared --version; systemctl status cloudflared; cat /etc/cloudflared/config.yml`（token 脱敏）
- `ss -tlnp; ip -brief addr; ip route`
- `export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh; node --version; opencode --version; opencode serve --port 4099 --hostname 127.0.0.1 & curl -s http://127.0.0.1:4099/global/health; curl -sN http://127.0.0.1:4099/event | head -c 500`

## 9. 变更日志（2026-10-08 用户指令执行记录）

- **P2-04 落地（2026-10-08）**：登录 fail/ok 记 `auth_audit`（不记口令）；`GET/DELETE /api/auth/sessions`（id 前缀吊销）；`service_audit.actor` 从 `local` 改为 `ses:<会话前缀>`，线上越权行归因成功。本地 32/32。

- **P2-02 落地（2026-10-08）**：`GET /api/sys/metrics/export?range=`（1h/24h/7d）吐 CSV，线上导出真实行、未登录 401；30 天滚动由 flush 裁剪 + 单测覆盖。本地 31/31。

- **AUTH-02 落地（2026-10-08，用户决策：口令只存 `.env` 的 `AUTH_LOGIN_PASSWORD`）**：删 DB 哈希/密封文件/改密端点，登录只认 env（timingSafeEqual，<8 位视为未配置）。线上实测 401/401/200 全对，旧密封与 `auth_config` 已清。教训×2：① 部署用了相对路径 `cp -a dist`（第二段命令 cwd 是 $HOME）致旧代码继续跑——一律绝对路径；② 拼接 shell 传密码时变量展开掉致空值——敏感值一律 `printf+单引号` 直写。口令已生成并设入 env，PC 临时脚本用后即删。

- **AUTH-01 落地（2026-10-08，用户决策：内置密码替代 CF Access，tunnel 保留做传输）**：scrypt 哈希入库 + `wb_session`（HttpOnly/Lax/30d）+ 全局失败退避（tunnel 后同源 IP，限流按全局计数）；首启生成随机口令，密封文件 `/var/lib/workbench/initial-password`（0400，改密自动删）；前端未认证只显登录页。线上实测：无 cookie 401、密封登录 200、登出后 401、sessions 已清零待用户首登。旧测试全量补登录（helper），本地 28/28。CF Access 不再需要（关闭 P0 缺口项）。

- **P1-06b 落地（2026-10-08，P1 代码全清）**：AI/效率/流水线/门户四页 + 网关 `promptOnly/messages` 接口；新包（24K JS）公网 200；AI 全链经网关验证（建会→下发→轮询出 assistant 真实回复→清会话）。SSH 中途 6 连超时后自恢复（直连链路老毛病，公网一直 200）。

- **P1-06a 落地（2026-10-08）**：SolidJS+Vite+Tailwindv4 脚手架 + 控制台页（温度/CPU/内存/SD/告警/白名单重启），网关 `@fastify/static` 同源托管 `/opt/workbench/web/dist`，公网 `/` 200。教训：① `package.json` 加依赖后必须同步 `/opt` 的 `node_modules`（漏同步致 `ERR_MODULE_NOT_FOUND` crash-loop，已补铁律）；② 本地 typecheck 长期“假绿”——输出截断漏看了 TS6059（rootDir），改双 tsconfig（`build` 专用 `tsconfig.build.json`）+ 只看退出码；③ TS7 顶层 await 解析异常，入口改 `.then` 写法。

- **P1-05 落地（2026-10-08）**：`pidsh` ingress 已删（有备份），现仅 `cloud→:3000` + `mc→tcp:25565` + 404；公网 `cloud` 200、`pidsh` 000。事故：删 ingress 的行跳逻辑多吃了一行（吞掉 mc hostname），cloudflared crash-loop 约 1 分钟，经网关 API 重启恢复。教训：改 cloudflared 配置必须先 `cloudflared --config <f> tunnel ingress validate`（或至少重启后 15s 内查 `journalctl` 无 ERR），再验公网。

- **P1-04 落地（2026-10-08）**：看门狗五项（tunnel/temp/mem/backup/opencode）60s 一检，异常记 `job_runs(job_id=watchdog)`，`/api/sys/watchdog` 可查。Pi 实测全绿（backup 2.1h）；`WB_TEMP_ALERT_C=0` 压阈值 2 分钟内落 2 条 alert 行，阈值已恢复、网关 healthy。本地 25/25。

- **P1-03 落地（2026-10-08）**：门户端点按请求读配置，Pi 实测改 json 即 1→2 卡（免重启，已还原）；`ss` 确认仅 `127.0.0.1:3000`。过程缺口：`portal.json` 从 P0-05 起就没部署到 Pi（只布了白名单），端点首验 500——教训：发版清单须含 `config/` 非代码文件，已补 AGENTS 发版铁律。

- **P1-02 落地（2026-10-08）**：流水线三类任务经 Pi 实测——shell 手动 `done`；`*/cron * * * * *` 3 分钟连触发 3 次全 done；opencode 下发 `done`（session 创建 + 全事件流进 `job_runs.log`）；探针 jobs 已删。教训：`node:sqlite` 新版类型不许 `.all() as JobRow[]`（TS2352），改逐字段映射；以及 tsx 跑测试不做类型检查——此前“本地过、Pi 挂”的真正原因是漏跑了本地 typecheck，已与发版铁律对齐（此后每次先 typecheck 后 test）。

- **P1-01 落地（2026-10-08）**：效率 API 四类全通（todos PATCH done、notes、bookmarks 拒 ftp、files 上传/下载/删除/404/空体400/穿越收敛）；重启后行数与 blob 都在，二进制落盘 `/var/lib/workbench/files`（库中仅元数据），探针已清。教训：① 无 lockfile 部署致 Pi/本地依赖漂移（Pi tsc 报 `SQLInputValue`/`unknown` 错而本地过）——此后发版必带 `package-lock.json` + Pi 侧 `npm ci`；② 部署脚本以 `tail` 取退出码会吞掉 tsc 失败（重犯），一律 `> log 2>&1; echo EXIT:$?`。
- **SSH 22 间歇性不通（2026-10-08，多次）**：现象 ping 通/80 通/公网业务全正常、唯 22 SYN 无回；重启后复发，用户侧 `sshd active+listening`、无防火墙（iptables/nft 未装）、日志可见我方连接曾 `Accepted publickey`。结论：Pi 侧服务正常，疑直连链路/网卡 TCP 偶发；公网链路始终 200。部署改重试+`npm ci` 固化后一次通过。

- **首个真实 AI 任务成功（2026-10-08 13:35，P0 出口核心项）**：用户完成 `opencode auth login`（antifield 身份）后，发现 serve（workbench 身份）`provider/model` 为空——诊断为凭据存于 antifield 库（`credential` 1 行）而 serve 读 workbench 库（0 行）。经 SQL 跨库复制凭据行（值不落地日志）+ `POST /api/credential/{id}/activate`（204）后，provider 出现 `opencode-go`/`opencode Zen`，模型可见。下发建文件探针任务，全流式时间线完整（inbox→execution→step→tool.called→tool.success→text.delta→step.ended→**execution.succeeded**），产物 `P0-EXIT-PROBE.md` 内容精确；探针文件与会话已删。适配器终端事件集补 `succeeded/failed` 并同步部署。结论：**serve 必须与登录身份同库——后续登录请用 `sudo -u workbench opencode auth login`，或走本次迁移流程**。

- **opencode 二进制移机（2026-10-08 13:18，用户报 Pi 终端找不到 opencode）**：根因 `/home/workbench` 700 + symlink 穿 700 目录，antifield 无权执行。已迁至 `/opt/opencode/bin/opencode`（root:root 0755），symlink 重指，antifield 直调 `opencode v2.0.24` 成功；`opencode.service` 重起正常、网关代理 healthy；workbench 家中 199M 原件已删（省 SD）。Pi 终端新开即有 `opencode`（旧终端需 `hash -r`）。待用户在 Pi 终端执行 `opencode auth login` 完成模型账户配对后，验证 `/api/provider` connected 并下发首个真实编码任务（P0 出口核心项）。

- **重启验证通过（2026-10-08 13:06-13:09）**：`sudo reboot` 后 60s SSH 恢复（新 boot，旧日志 volatile 已清）；9 服务全 `active (running)`（gateway/opencode/cloudflared/minecraft/mc-server/nginx/lightdm/ssh/frpc）；网关 `/health`、`/api/ai/health(2.0.24)`、`overview(cpu 0.8%)` 全 200；log2ram 已挂载、持久 journal 为空、备份 timer 待触发（次日 02:30）；公网 `cloud/health` 重启后复验 200。

- **P0-07 落地（2026-10-08，P0 代码任务清零）**：journald 切 `Storage=volatile + RuntimeMaxUse=64M`（drop-in 修后 `restart systemd-journald`，持久路径 `/var/log/journal` 已空，运行时日志上限 64M；另有一处 `ForwardToSyslog=yes` 覆盖（非我方文件），但无 rsyslog，`/var/log/syslog` 不存在，无影响）；`apt install log2ram 1.7.2`（trixie/main），128M tmpfs 接管 `/var/log`（已用 3%），`logger` 写测经 journal 可查；7 个关键服务全 running。tmpfs 预算更新：`/tmp 4G + /var/log 128M`。验收说明：`journalctl --disk-usage` 即时仍 8M（运行时旧日志，自然轮转至上限内），持久写入已归零才是本次收益。

- **P0-08 落地（2026-10-08，备份链路 ok → P0-07 解锁）**：Pi 侧 `backup.sh`（workbench 身份，`sqlite .backup` 双库 + config 打包 + env + sha256 + `backups` 行，>7d 修剪）由 `workbench-backup.timer` 每日 02:30 触发；手动连跑 3 轮（`SNAPSHOT_OK`×3，每份 6.4M，`backups` 3 行 ok）；恢复演练 `restore-drill.sh` 在最新快照上 sha 全过、`integrity_check` 双 ok、行数可读（`metrics_ts=17` 等），演练目录已清；PC 侧 `scripts/pc-pull.py`（SFTP 拉取 + sha256 全文件校验 + `manifest.log`）首跑因 `env` 600 无权 FAIL，改 `setfacl u:antifield:r`（单文件读 ACL，不动属主/大权限）后 3 快照×4 文件全对 `PULL_OK`；`manifest.log` 保留 FAIL+OK 两行备查；Windows 计划任务 `PiBackUp-Nightly` 每日 03:00 已注册。注意：v2 数据在 `/home/workbench/.local/share/opencode`（6.1M），`/var/lib/workbench/opencode` 为空目录——备份取前者。“连续 3 晚”以 3 轮手动 + 双定时器延续覆盖，日历 streak 由 manifest 累积，P0 出口复核。

- **P0-06 落地（2026-10-08）**：网关占位首页 `/` 上线；`config.yml` 备份后 `pidsh→:3100` 改 `:3000`（`cloud` 免改），经网关自身 API `restart cloudflared`（200），tunnel QUIC 重连成功；本机公网实测 `https://cloud.antifield.work/health → 200`（CF RAY 头正常）、`pidsh` 同样 200、`https://cloud.antifield.work:4096 → 000`（无 ingress，符合零暴露）。**缺口：CF Access 策略未生效（当前公网直通 200，无登录挑战），需用户在 Cloudflare dashboard 为 `cloud/pidsh` 主机名启用 Access，启用后复验命令：`curl -sI https://cloud.antifield.work/` 应 302 到 `*.cloudflareaccess.com`。** 在 Access 启用前，网关无自身认证，公网可直达 API——P0 出口前必须补上。

- **P0-05 落地（2026-10-08）**：`POST /api/sys/services/:unit/:action` 经 Pi 实测——白名单内 `restart opencode` 200（服务 12:12:44 重起）；网关自重启客户端掉线（HTTP 000，符合预期并已在代码注释）后 3s 内 `/health` 恢复；白名单外 `stop minecraft`/`restart nginx`/`status minecraft` 全部 403 且 `service_audit` 有 `allowed=0` 行。特权链：`workbench` 经 `/etc/sudoers.d/workbench-systemctl`（root:root 0440，visudo 通过）免密仅 3 条 restart；首部署 `cp -a` 留下 antifield 属主致 sudo 告警，已 `chown 0:0` 修复。关键坑：systemd `NoNewPrivileges=true` 会禁掉 sudo 提权致 502，已从网关单元移除（sudoers 精确条目才是真实边界，见 ARCH §5）；预置的 `/etc/sudoers.d/010_antifield-nopasswd` 模式 644（应 0440）系历史遗留，未动。

- **P0-02 落地（2026-10-08）**：新建系统用户 `workbench`（uid 997，nologin）；`/home/antifield` 为 0700，改实体复制 `/usr/local/bin/node`（148M，0755；node 升级时重拷）；网关部署于 `/opt/workbench/gateway`，`/etc/workbench/env`（0400，含生成的 `OPENCODE_SERVER_PASSWORD`）就绪；`workbench-gateway.service` enabled+running（RSS 75M，`MemoryMax=350M`）。

- **停用 pinas/Antifield Cloud v1.12.0**：`sudo systemctl stop + disable antifield-cloud.service`，实测 `Active: inactive (dead)`、`is-enabled: disabled`、`ss` 中 `3000/3100` 已释放（`PORTS_FREED`）。数据目录 `~/pinas` 原样保留（`cloud_disk.db`、`uploads/`、`backups/`、二进制）；退役快照存 `/home/antifield/retire-backup-20261008/`（`.env`、`VERSION`、`auth` 备份、`sha256`、表清单）并已回传 PC `D:\PiBackUp\retire-20261008/`。`3000` 端口即日起由本项目网关复用。其他服务（minecraft/mc-server/cloudflared/nginx/lightdm/ssh/frpc）实测仍 `active (running)`，桌面栈未动。
- **移除 opencode v1**：`npm uninstall -g opencode-ai`（nvm node v26.7.0），`removed 2 packages`，`which opencode` 已无结果；`@deepseek-ai/dsh`、`pnpm`、`npm` 保留。`~/.config/opencode`、`~/.local/share/opencode/opencode.db`、`~/.cache/opencode/models.json` 暂留待 v2 迁移评估（P0-03 处理）。此后 v1 serve 实测数据（RSS 343M）仅作预算参考。
- **备份目标确定**：PC 目录 `D:\PiBackUp`（已创建）。退役快照 5 文件已回传验证通过。每晚流水线（P0-08）拉取方式待定（PC 从 Pi 经 SFTP 拉取，避免在 Pi 存 PC 凭据）。
- **移除 dsh 及残留（2026-10-08 用户指令）**：`systemctl --user stop+disable dsh.service`（`inactive (dead)` + `disabled`），`127.0.0.1:3080` 已释放；`npm uninstall -g @deepseek-ai/dsh`（`removed 488 packages`，`npm ls -g` 仅剩 `npm+pnpm`）；用户单元文件、`~/.dsh`、`~/projects/dsh-plugin-pinas`（37M）移入退役库 `dsh/`；opencode v1 四处残留（`config 63M`、`cache 5.2M`、`share 2.5M` 含 `opencode.db`、`state 16K`）移入退役库 `opencode-v1/`，原路径确认清空；`/tmp` 内测试残留已删。`3100` 与 `3080` 均无监听，`pidsh` DNS 由用户手动清理。遗留非运行残留（`~/build/Pinas` 源码、`~/.npm/_npx` 缓存、`~/bin/fix-dsh-profile-links.sh`）保持不动。
- **P0-04 落地（2026-10-08）**：控制台只读五端点经 Pi 实测——`overview` 温度 49.1 vs `vcgencmd` 48.8（Δ0.3°C），内存/负载/diskstats/journal(8M) 一致；`logs?unit=ssh.service` 返回真实条目（workbench 已入 `systemd-journal` 组）；`apt` 首版把 `正在列表...` 计入 count=2，已修过滤（`/` 判定）复验 count=1；`metrics_ts` 批量落盘行增（ flush 间隔经 `systemctl set-environment` 临时 15s 验证后恢复默认 5min），`journal_mode=wal` + `synchronous=1(NORMAL)` 为网关连接实测值（注：synchronous 系 per-connection，空连接查出 FULL 属正常）；`node:sqlite` 内建驱动可用，无额外依赖。部署插曲：`sys.ts` 误写 `./metrics.js` 致网关 crash-loop，本地 typecheck 未拦（`tsc -p` 报了错但被 `tail` 吞掉退出码——教训：以 `npm run typecheck` 为准，不看 tail），已修复。
- **P0-03 落地（2026-10-08）**：v2 安装首跑因 registry 瞬断失败，重试成功，`opencode v2.0.24`（binary 191M，`~/.opencode/bin`，symlink 至 `/usr/local/bin/opencode`；安装脚本尾部 PATH 探测在 nologin 用户下会卡住，已 kill，无影响）；`opencode.service` enabled+running（workbench，`127.0.0.1:4096`，basic-auth 生效：无凭据 401，有凭据 200）。关键发现：**v2 API 全面换前缀**，v1 路径（`/global/health`、`/event`、`/doc`）全部返回 SPA HTML；真实路由：健康 `GET /api/info`（`{version:"2.0.24"}`）、事件 `GET /api/event`（SSE 首帧 `server.connected`，包络 `{id,type,data{sessionID?}}`，终端类型 `session.execution.finished/session.idle/session.error`）、会话 `GET/POST /api/session`（包络 `{data}`）、下发 `POST /api/session/{id}/prompt {text}`、中断 `POST /api/session/{id}/interrupt`；OpenAPI 快照存档 `docs/opencode-openapi.json`（117 路由）。实测下发 `ping` 全链路跑通（provider 为空时默认 `exo-free`，上游 503 重试中——真实 AI 任务需用户配 Key，P0 出口前置）。serve 空载 RSS 293M，符合预算。适配器已按 v2 重写（v1 回退删除，随 binary 同退役），网关 `/api/ai/*` 经 Pi 实测往返 ok，探针会话已删。
