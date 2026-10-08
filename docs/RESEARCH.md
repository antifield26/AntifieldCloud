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
| R2 | SD 单盘 58% 已用，日写 1–3G，无寿命读数，掉盘即全丢 | 高 | P0：写入减负（WAL+NORMAL、5–10min 批量落盘、log2ram、journald volatile、/tmp tmpfs 已有）；连续3次备份成功 + 1 次恢复演练为 P0 出口 |
| R3 | 无外部备份目标，同卡备份等于无备份 | 高 | 目标已定：PC 目录 `D:\PiBackUp`（2026-10-08 用户确认）；退役快照已回传 `D:\PiBackUp\retire-20261008`；每晚流水线待 P0-08 落地；**目标就绪前不动存储配置**；备份含校验（sha256）+ 失败告警 |
| R4 | `antifield` 拥有 NOPASSWD ALL，网关越权风险 | 高 | 新建 `workbench` 低权限用户；sudoers 仅白名单动词；白名单外 403 + 审计表；AGENTS.md 红线 |
| R5 | cloudflared 边缘抖动（`7844 timeout`） | 中 | 网关 `/health` 探针 + 看门狗 tunnel 检查 + 重连（`restart cloudflared` 白名单内） |
| R6 | v1/v2 双版本漂移，适配器被击穿 | 中 | 适配器为唯一边界，pin 版本 + OpenAPI 快照 + 契约测试；任何直调 OpenCode 视为 bug |
| R7 | 桌面/minecraft/FRP（`frpc-minecraft` 出站隧道）等存量服务与新网关端口冲突 | 中 | 端口终态：网关 `127.0.0.1:3000`、opencode `127.0.0.1:4096`；`ss` 无 `0.0.0.0:3000` 已验；nginx 只做本机默认页 |
| R8 | 出网经 wlan，受限网络下 npm/GitHub 超时 | 低 | 已验证出网正常；P0 构建产物 pin lockfile，失败重试 + 镜像源预案 |

## 附：实测命令索引（复现用，不含凭据）
- `uname -a; cat /etc/os-release; lscpu; free -h; uptime; ps aux --sort=-%mem | head`
- `vcgencmd measure_temp; vcgencmd get_throttled; vcgencmd measure_clock arm; cat /sys/class/thermal/thermal_zone*/temp`
- `lsblk -o NAME,MODEL,SIZE,TYPE,MOUNTPOINT,FSTYPE; df -hT; cat /etc/fstab; cat /sys/block/mmcblk0/device/{name,manfid,oemid,hwrev,fwrev,serial,date,type,cid}`
- `cat /proc/diskstats | grep mmcblk0; journalctl --disk-usage; journalctl -o json -n 2`
- `cloudflared --version; systemctl status cloudflared; cat /etc/cloudflared/config.yml`（token 脱敏）
- `ss -tlnp; ip -brief addr; ip route`
- `export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh; node --version; opencode --version; opencode serve --port 4099 --hostname 127.0.0.1 & curl -s http://127.0.0.1:4099/global/health; curl -sN http://127.0.0.1:4099/event | head -c 500`

## 9. 变更日志

已拆分至根目录 [CHANGELOG.md](../CHANGELOG.md)，按时间正序记录。

## 10. 现状勘误（终态声明，§1–§8 中被后续决策推翻的行以此处为准）

| 旧结论位置 | 现状 |
|---|---|
| §1 v1 安装/Node 双轨、`opencode 1.18.29` | v1 已卸载，v2.0.24 在 `/opt/opencode/bin` 全局可用；Node 26 单轨 |
| §3 cloudflared ingress（pidsh→3100）、CF Access 待测 | pidsh ingress 与 DNS 已下线；CF Access 弃用，改内置密码登录 |
| §4 pi_nas/dsh 运行态、`pi_nas:3000` 收敛计划 | 两者皆已退役；网关直占 `127.0.0.1:3000` |
| §5 外部 NAS 缺失 | 已定 PC `D:\PiBackUp`，定时拉取运行中 |
| §6 内存预算（dsh 140M 等） | dsh 已删；serve v2 空载 ~300M；网关 ~75M |
| R3/R5/R7 缓解措施中的 Access/3090 引用 | 见本表与 ARCH §5（sudoers 精确条目为特权边界） |
