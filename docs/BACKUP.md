# 备份与恢复

> 目标：SD 卡损坏、误删、升级失败或世界存档损坏时，能恢复 `/var/lib/antifieldcloud` 与 Minecraft 世界。
> 备份分四条链路：**应用数据归档**（DB 快照 + 文件内容；可选整包 age 加密，默认关闭）、**密钥包**（age 加密的
> env/云隧道/Minecraft 配置/opencode 数据，可选纳入主机配置）、**世界备份**（Minecraft 世界一致性 gzip 归档）与
> **异地副本**（PC 端只上传加密归档，默认关闭）。
> 归档与密钥包只允许落在 Pi 本机、PC 备份目录或离线介质，不上传公开网盘；**Web 不持任何私钥**，加密归档只能在 PC 用
> 离线私钥解密/校验/恢复；恢复演练由 `scripts/drill.ps1` 自动校验。

## 1. 策略

| 链路 | 频率/触发 | 保留 | 确认方式 |
|---|---|---|---|
| 应用数据归档 | 每日（Windows 任务触发 `--prepare`，或 Web 手动 prepare） | Pi pending 直到确认、已确认 2 个；PC daily 30 天、weekly 56 天 | PC 校验密文/明文哈希后 `--ack` 才推进游标 |
| 应用归档整包加密 | 随应用归档（`BACKUP_ARCHIVE_ENCRYPTION=true`，默认关闭） | 同应用归档；Pi 只存 `.age` 与外部 sidecar | PC 拉取 `.age` + `.meta.json`，私钥离线 |
| 密钥包 | 每日随应用拉取任务执行 `backup-secrets.sh` | Pi `KEEP=2` 滚动；PC 90 天 | PC 拉取并校验 `.sha256` + `includesOpencode` |
| 异地副本 | 每日/自定义（`AntifieldCloud-Backup-Offsite`，默认关闭） | 远端链感知保留（最新 full + 其后全部 inc + 最近 N 天） | `rclone copyto --checksum` + 远端大小校验 |
| 世界备份 | 每周日 12:00（`antifieldcloud-world.timer`，显式 Asia/Shanghai，Persistent） | Pi 最新 4 份；PC `world\` 最新 4 份 | PC `world-pull.ps1` 校验 SHA 后删除远端（ack） |
| 恢复演练 | 季度/升级前手动运行 `drill.ps1` | 报告 180 天 | 报告通过 + `drill-status.json` |

- **两阶段（应用归档）**：Pi 端 `--prepare` 生成归档并记为 `pending`；Windows 拉取并校验 SHA-256 后 `--ack` 才推进备份游标。
  PC 未确认前 Pi 不删除 pending 归档，网络/PC 故障不会造成“归档已删但未备份”的数据丢失。
- **应用归档频率**：每日一次；建议的“全量”条件为“无已确认全量或最近全量超过 7 天”，由 `--pending` 的
  `needsFull/recommendedMode` 计算，Windows 任务按推荐模式执行（错过的周日会在下一轮补做全量）。
- **增量依据**：文件内容不可变，只备份 `created_at > 上次已确认备份时间` 的新增文件；重命名/移动只改元数据，由 DB 快照覆盖。
  存在未确认 pending 时，增量起点取最新 pending 时间，避免重复打包；上次缺失（`skippedMissing`）的文件即使早于水位也强制纳入下次选择。
- **空间保护**：生成前检查剩余空间（本次估算 + 现有 pending + 仍占盘的已确认归档 + 孤儿归档 + 2 GiB），不足则返回 JSON 错误且不生成归档；
  **开启整包加密时本次估算按 2× 明文**（明文 tar 与密文峰值同时存在）+ 上述余量；世界备份按 `1.5 × 世界目录体积` 预检。
- **完整性**：归档 SHA-256 写入 DB 与 PC 的 `.sha256` 旁文件（**加密归档的 `.sha256` 始终表示密文 SHA-256**）；`--ack` 会再次校验 Pi 上文件；PC 下载后校验再原子改名。
- **整包加密（默认关闭）**：`BACKUP_ARCHIVE_ENCRYPTION=true` 时 `--prepare` 用独立备份 age 公钥生成 `*.tar.gz.age`，明文 SHA-256/大小只写归档外 sidecar 与 DB；失败关闭，绝不回退明文；私钥离线，Web 不持私钥（详见 §5.1）。
- **异地副本（默认关闭）**：PC 端 `backup-offsite.mjs/.ps1` 只上传 `.age`，链感知保留并写状态回 Pi；应用只读展示与告警（详见 §5.2）。
- **孤儿/legacy**：备份目录中无 DB 记录的归档只报告、不自动删除；无参数 legacy 入口必须显式 `--legacy`，不再隐式 ack。
  旧世界归档命名 `world-<YYYYMMDD>.tar.gz` 不匹配新的 `world-<YYYYMMDDTHHMMSSZ>.tar.gz` 规则，永远不会被自动清理。
- **Bot 密钥**：`/etc/antifieldcloud/env` 含 `BOT_SECRET_KEY`，已随密钥包加密备份；该 key 与 DB 中的 `bots` 密文必须成对恢复，
  否则 Bot Token 不可解密（只能重新录入）。`BOT_SECRET_KEY` 不在普通应用归档内，必须用密钥包（或离线副本）恢复。
  普通归档含 TOTP/会话与 Bot 密文，仍按敏感数据处理；发布媒体不会进入备份之外的新位置。
- **Bot 长期记忆/私聊角色卡**：DB `bot_ai_memories` 摘要与 `bot_chat_roles` 角色卡随数据库快照备份；`DATA_DIR/bot-memory/memory-<uuid>.md` 镜像不在应用归档内，
  但可由 DB 摘要重建，不作为恢复必需项；镜像目录不对外暴露，按保留期/人工清理。

## 2. 应用归档结构与协议

```text
# 明文（默认）
snapshot-20261019T100101239Z-full.tar.gz
├── backups/db-20261019T100101239Z.sqlite    # 一致性 DB 快照
├── backups/manifest-20261019T100101239Z.json
└── files/<xx>/<id>                           # 本次新增/全量文件内容

# 加密（BACKUP_ARCHIVE_ENCRYPTION=true）
snapshot-20261019T100101239Z-full.tar.gz.age          # age 密文（tar.gz 整体加密）
snapshot-20261019T100101239Z-full.tar.gz.age.sha256   # 密文 SHA-256
snapshot-20261019T100101239Z-full.tar.gz.age.meta.json# 归档外明文元数据（sidecar，schema 2）
```

`manifest.json` 字段（明文归档）：`schema:1 / createdAt / mode(full|inc) / since / database / files[] / fileCount / totalBytes /
skippedMissing[] / warnings[]`。`skippedMissing` 记录“DB 有行但磁盘文件缺失”的文件 id，恢复计划会据此剔除并报告；
`warnings` 记录缺失/时钟回拨等告警。

**加密归档**：归档内 manifest 使用 `schema:2`，只保留 `schema / createdAt / mode / since / database / files[] /
fileCount / totalBytes / skippedMissing / warnings / encrypted:true / archiveFormat:"tar.gz.age"`；**明文 SHA-256 与明文大小不放进被加密的
归档内部**（否则构成自引用），改由归档外 `<name>.meta.json`（`schema:2`，字段 `name/mode/createdAt/archiveFormat/encrypted/
encryptedWith:"age"/recipient/plainSha256/plainSize/cipherSha256/cipherSize`）与 DB `backup_archives.manifest_json` 保存。
归档名唯一可信来源是后缀 `.tar.gz.age`，不新增 DB 列/表（无 schema 迁移）。

DB 表 `backup_archives` 记录：`name(PK) / mode / created_at / sha256 / size / file_count / pulled_at / acked_at /
deleted_at / origin / verified_at / manifest_json / last_error`；`origin` 区分 `pi`（Pi 生成，参与 pending/ack）与
`import`（Web 导入，不参与 ack 游标）。`backup_state.last_backup_at` 只在 `--ack` 后推进。
`restore_plans` 记录文件级恢复计划（归档链、选择、目标名、状态、操作者、过期、`skippedMissing`）。
`meta.backup_missing_files` 记录上次缺失、等待恢复后补入增量的文件 id。
**归档状态语义**：已 ack 的 Pi 归档在 PC 拉取确认后可能主动删除服务端文件；API 对这类行返回
`status=acked`、`available=false`，Dashboard 显示“已确认”而不是“文件缺失”，Backups 页恢复按钮禁用并提示“服务端副本已清理”。
只有未 ack 的 Pi 归档或缺失的导入归档才会返回 `status=missing`。

`--prepare` 先写 `snapshot-*.tar.gz.part`，tar 成功后才原子改名为正式归档；失败/超时清理本次 `.part` 与陈旧锁。
**加密路径的崩溃一致性顺序**：tar → `*.plain.tmp` → 计算 plain SHA-256/size → age 加密到 `*.part.age` → rename `.age` → 写 sidecar（temp+rename）→ unlink `.plain.tmp` → 写 DB 行；崩溃最多留下可清理临时文件或“有密文无 DB 行”的孤儿（只报告、不自动删除）。unlink 先于 DB 行以缩短明文窗口，sidecar 已先落盘，因此密文/元数据仍可诊断。加密开启时 age 缺失/公钥非法/加密失败/空间不足均在 `--prepare` 阶段失败关闭，不产生 pending、不降级明文；启动/下次 prepare 清理超过 24h 的 `*.plain.tmp` 残留。
Web `prepare` 超时由 `BACKUP_PREPARE_TIMEOUT_SEC` 控制（默认 3300 秒，允许 60–7200），与 CLI/PC 侧 55 分钟对齐，避免大归档中途被杀。
陈旧锁（`.backup.lock` 超过 1 小时）可被接管并记录 warn；ack 的归档行、游标、`meta.backup_missing_files` 与审计在同一事务内提交。

## 3. Pi 端命令（以 antifieldcloud 运行）

```bash
CLI="sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs"

$CLI --pending                    # {"ok":true,"count":..,"pending":[..],"needsFull":..,"recommendedMode":"full|inc",
                                  #  "orphans":[..],"partials":[..],"missingFiles":[..],"warnings":[..]}
$CLI --prepare --full             # 生成全量 pending 归档（不推进游标）
$CLI --prepare                    # 生成增量 pending 归档（无历史时自动全量）
$CLI --ack <name> --sha256 <hex>  # 校验后确认拉取、推进游标并清理过旧已确认归档（幂等、事务化）
$CLI --snapshot-db                # 仅做一致性 DB 快照（部署/升级前用），输出 {"ok":true,"snapshot":...}
```

- 成功输出单行 JSON；失败 `{ok:false,error}` 且退出码 1。归档权限 0640；DB 快照与清单 0600；`.backup.lock` 超过 1 小时视为陈旧并可接管（记 warn）。
- `--prepare` 额外返回 `warnings[]` 与 `skippedMissing[]`；加密开启时另返回 `encrypted:true / archiveFormat:"tar.gz.age" / metaName / plainSha256 / plainSize`。`--pending` 额外返回
  `orphans/partials/missingFiles/missingFileCount/warnings`；每个 pending 项带 `encrypted / archiveFormat / metaName / metaExists`，加密归档缺 sidecar 时在 `missingSidecars[]` 与 `warnings[]` 中提示（补齐前不得 ack/删除）。Windows 脚本用 `--no-warnings` 抑制重复提示（仍保留关键字段）。
- `--ack` 对加密归档接受 `.age` 名与密文 SHA-256（`pending[].sha256` 即密文 SHA），ack 后清理归档 + `.sha256` + `.meta.json`；`--deadline/cleanup` 不误删仍属于 pending 的 `.meta.json`。
- 上次缺失文件记录在 meta `backup_missing_files`：恢复物理文件后即使 `created_at` 早于增量水位，也会被强制纳入下一次增量并在 ack 时写回；
  这样不会因水位越过而永久漏备。
- `--ack` 只接受与 DB 记录一致的 SHA-256，且只允许游标前进（乱序 ack 安全）；ack 的归档行、游标、meta 与审计在同一事务内提交。
- 兼容入口：必须显式 `$CLI --legacy` 才执行“prepare + 立即 ack”；普通无参数运行会报错，旧脚本/任务应改用 `--prepare`/`--ack`。输出会标记 deprecated。
- 保护上限：归档内 DB 快照 ≤256 MiB、行数 ≤10 万；staging（解包临时目录）≤2 GiB 且不超过可用空间 20%；
  归档内容浏览 `GET /api/backups/archives/:name/entries` 按 IP 限流 30 次/分钟。

## 4. Windows 每日应用归档任务

```powershell
# 管理员 PowerShell；-PiHost/-BackupRoot 会显式写入任务参数（不要再依赖脚本默认占位值）
cd "$env:USERPROFILE\projects\AntifieldComplexx"
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 可选：同时安装异地副本任务（默认关闭；需先配置 rclone remote）
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" `
  -InstallOffsiteTask -OffsiteRemote myremote -OffsiteRemotePath AntifieldCloud/backups -OffsiteRemoteLabel myremote
```

- 任务名 `AntifieldCloud-Backup-Pull`；每日 `12:00` + 登录后补跑；电池供电时也运行；仅当前用户登录时运行。`-InstallOffsiteTask` 另建 `AntifieldCloud-Backup-Offsite`（默认每日 13:00、6h 超时、IgnoreNew）。
- **更新仓库后必须重装任务**：`install-backup-task.ps1` 会把最新 `backup-pull.ps1` 复制到 `%LOCALAPPDATA%\AntifieldCloud\` 并更新
  `backup-task.json` 的脚本 SHA/参数；重装后手跑一次，确认日志 `secrets=ok`、Pi `backup-pull.json` 的 `secretsOk=true`
  （密钥包内含 `BOT_SECRET_KEY`，脚本不打印值），且 archive/SHA 校验通过。
- 安装脚本会：复制 `backup-pull.ps1` 到 `%LOCALAPPDATA%\AntifieldCloud\`；用 `icacls` 把备份目录 ACL 收紧为
  **当前用户 + Administrators + SYSTEM**（逐项校验，非白名单主体即失败）；安装前做 `PiHost:22` 可达性预检；
  回读校验任务参数并写安装标记 `backup-task.json`（版本/脚本 SHA/参数）；`-DryRun` 只打印计划不注册任务。
- 拉取流程：`--pending` →（无 pending 才 `--prepare`）→ `.part` 下载 → 密文 SHA-256 校验 → 原子改名 → 写
  `<archive>.sha256` →（加密归档：先拉 `<archive>.meta.json` 并校验 schema/name/mode/archiveFormat/encrypted/encryptedWith/recipient/plainSha256/plainSize/cipherSha256/cipherSize 与 pending 一致）→ `--ack` → 删除 Pi 归档、`.sha256` 与 `.meta.json`；失败保留 pending，下一轮重试同一归档，不重复生成；
  同轮已 ack 的归档跳过。**缺/非法 `.meta.json` 的加密归档按项跳过（不 ack、不删远端、`sidecarMissing` 记录），其余归档继续**；单个归档下载/SHA 失败仍中止本轮（避免错误 ack）。
- `-AgeIdentityPath`（可选）：对加密归档用 `age -d -i` 解密到临时文件，校验 `plainSha256/plainSize` 后立即删除临时明文；私钥路径与明文内容不写日志/状态。未提供则只做密文校验，状态 `plainVerified=null`。
- 所有 SSH/SCP 有硬超时（`Start-Process` + `taskkill /T /F`），secrets 拉取独立 try；`backup-pull.json` 分开记录
  `secretsAttempted/secretsOk/lastSecretsAt/secretsLastError/secretsArchiveName/secretsIncludesOpencode/includesHostConfig`，
  加密状态另记 `encrypted/plainVerified`；secrets 失败 `ok=false` 且退出码 1。
- 状态 JSON 在重试循环外一次性写入：写失败只记错误、不触发再次 prepare（避免重复归档）。
- PC 保留：`daily` 目录按时间保留 30 天、`weekly` 保留 56 天（8 周）、`secrets` 保留 90 天；日志
  `%LOCALAPPDATA%\AntifieldCloud\backup.log`（超过 1 MiB 自动轮转为 `backup.log.1`）。
- 状态：成功拉取后写 `/var/lib/antifieldcloud/backup-pull.json`，面板“备份”卡与告警读取；文件成功但密钥包失败会显示异常。
- 旧任务 `PiBackUp-Nightly` 保持原样，不修改。

## 5. 密钥包与备份整包加密（age；整包加密默认关闭）

Pi 上安装 `age`，离线生成密钥对（私钥不要放 Pi/仓库）：

```bash
# 在 PC/离线环境（或 Pi 上生成后立刻把私钥移走）
age-keygen -o age-secrets.txt         # 文件内含私钥；妥善离线保存
grep '^# public key:' age-secrets.txt # 取 age1... 公钥
```

```bash
# Pi（root）：写入公钥、安装 age、生成密钥包
sudo apt-get install -y age
sudo install -o root -g root -m 0644 /dev/stdin /etc/antifieldcloud/secrets-age.pub <<'EOF'
age1...（替换为你的公钥）
EOF
sudo bash /opt/antifieldcloud/current/scripts/backup-secrets.sh
```

- 打包内容：`/etc/antifieldcloud/env`（含 `BOT_SECRET_KEY` 与 `BOT_*`）、`/etc/cloudflared/config.yml`、`/etc/cloudflared/cert.pem`、
  `/etc/cloudflared/<tunnel-uuid>.json`、`/home/antifield/minecraft-server/server.properties`、
  `/etc/opencode/opencode.env`、opencode `opencode.json`/`service.json` 及 opencode SQLite 一致性快照。
- 明文只在 0700 临时目录：优先 `/run/antifieldcloud/secrets-tmp`（tmpfs，重启即清），不可用时回退 `/tmp`；
  启动前清理上次残留，退出路径 trap 清理，不留下未加密产物。
- opencode DB 快照必须成功：临时快照父目录使用独立 0711 目录（默认 `/run/antifieldcloud/secrets-tmp-opencode`），
  快照子目录 0700 归 opencode；失败（目录不可遍历/不可写、node:sqlite 失败）直接使脚本失败退出，
  **不生成半成品密钥包**并由备份拉取状态置 `secretsOk=false`，避免“只 warning、PC 仍显示成功”的静默漏备。
- 脚本校验 age 公钥 root 属主/不可组写；不输出密码/密钥。
- 输出：`/var/lib/antifieldcloud/backups/secrets/secrets-<UTC>.tar.age` + `.sha256`；目录 root:antifield 2750，文件 0640。
- **保留**：Pi 端 `SECRETS_KEEP`/默认 `KEEP=2` 滚动保留最新 2 份；Windows 任务拉到本地后**不再立即删除远端密钥包**
  （PC 失败时可复用同一份）；PC 保留 90 天。
- 未安装 age/未配置公钥时只记录警告，不影响文件归档备份；但 secrets 状态会显示失败/未尝试。
- **主机配置可选打包**：`backup-secrets.sh --include-host-config` 会把 `deploy.conf`、`/etc/nftables.conf`、
  sshd drop-in、fail2ban jail、cloudflared/journald/nftables drop-in、应用 units、log2ram 配置中存在的文件一并打入密钥包，
  输出 `includesHostConfig`/`hostConfigFileCount`；模板与重建清单见 `deploy/host/README.md`。
- **`includesOpencode` 硬校验**：已安装 opencode（存在 opencode 用户或数据目录）但 DB 快照缺失/Node 不可执行时，
  `backup-secrets.sh` 直接失败、不生成“缺 opencode DB 的成功密钥包”；PC 拉取校验 `meta.includesOpencode`，否则 `secretsOk=false`。

### 5.1 备份整包加密（独立 age 密钥，默认关闭）

- **目标**：应用归档落地即密文，避免 PC 备份目录/Pi 介质泄露直接暴露 TOTP secret、Bot 密文与文件内容。
  默认关闭（`BACKUP_ARCHIVE_ENCRYPTION=false`）；与 `secrets-age` **使用独立密钥对**，互不复用。
- **密钥**：Pi 只存公钥 `/etc/antifieldcloud/backup-age.pub`（root 属主、组/其他不可写、单行 `age1…`、≤4 KiB；
  启动时校验属主/权限/格式）；私钥离线保存 ≥2 份，**禁止放 Pi/仓库/PC 备份目录**。启用前必须用私钥完成一次
  `age -d` 解密 + 一次 `drill.ps1 -AgeIdentityPath` 演练，否则可能出现“备份成功但永不可恢复”。
- **命名与元数据**：`snapshot-<stamp>[-n]-(full|inc).tar.gz.age`；sidecar `<name>.meta.json`（schema 2）；
  `.sha256` 始终是**密文** SHA-256；`recipient`/`encryptedWith` 写入 sidecar、DB `manifest_json` 与 API 元数据（公钥非秘密），
  便于密钥轮换时识别不同公钥的归档。
- **失败关闭**：加密开启时 age 缺失/不可执行、公钥非法、加密失败、密文为空、空间不足（按 2× 明文）→ `--prepare` 失败，
  不产生 pending、不留明文最终归档、**不得降级明文**。临时明文使用 `*.plain.tmp`，密文+sidecar 落盘后立即删除；
  启动/每次 prepare 清理超过 24h 的残留。
- **空间**：峰值 ≈ 明文 tar + 密文 ≈ 2× 本次估算；预算 = 2× 估算 + pending + acked 未清理 + 孤儿 + 2 GiB 保留。
- **Web 边界**：应用不持私钥。`verify/import/entries/restore-plan/executeRestore` 对 `.age` 在归档名校验之前返回
  `409 archive_encrypted`（加密归档是预期状态，不写 `last_error`）；自动恢复目标选择跳过加密归档；Web UI 禁用对应按钮并展示
  “加密归档（Web 不可校验/恢复）”。整库恢复同样只能 PC 解密后走 §8.1。
- **启用顺序**（默认全关，可逐步回滚）：离线生成备份 age 密钥 → Pi 写公钥 → 私钥完成一次解密/演练 →
  `BACKUP_ARCHIVE_ENCRYPTION=true` 并重启 → 下一次 prepare 生成 `.age` → PC 拉取 + `--ack` → drill 解密校验 → 再配置异地副本。
  **回滚**：关闭开关恢复明文；已生成的 `.age` 保留（PC 侧解密/演练），不要在 Pi 上尝试解密。
- **环境变量**：`BACKUP_ARCHIVE_ENCRYPTION`、`BACKUP_AGE_RECIPIENT_FILE`（`bootstrap-env.sh` 已纳管）；测试夹具可用
  `BACKUP_AGE_FAKE=1`/`BACKUP_SKIP_KEY_OWNER_CHECK=1`（仅本地夹具，生产禁用）。

### 5.2 异地副本（PC 端 rclone，默认关闭）

- **组成**：`scripts/backup-offsite.mjs`（纯逻辑 + CLI，链规划/保留/校验）+ `backup-offsite.ps1`（计划任务入口，硬超时、
  日志轮转、状态回写）+ `install-backup-task.ps1 -InstallOffsiteTask`（安装 `AntifieldCloud-Backup-Offsite`）。
- **只上传密文**：只选择 `.tar.gz.age`；明文归档拒绝上传并计入 `plaintextSkipped`；要求 `.sha256` 与 `.meta.json` 存在且
  本地密文 SHA 与 sidecar/pending 一致，否则跳过并记录 `failed`。
- **链感知保留**：先规划“最新 full + 其后全部 inc”，再叠加最近 N 天窗口；**绝不删除最新 full**；删除有上限（`--max-delete`）
  且默认 dry-run 可先演练；不做纯 `--min-age` 删除（可能删掉最新 full）。
- **上传与校验**：`rclone copyto --checksum` 上传归档 + `.sha256` + `.meta.json`，用 `rclone size` 校验远端大小；
  remote/remotePath/name 做白名单校验，`execFile` 无 shell；脚本不创建 rclone remote/凭据。
- **状态与告警**：状态 JSON 写 Pi `/var/lib/antifieldcloud/backup-offsite-status.json`（0644，随机 /tmp 名后 `sudo install`），
  字段 `lastRunAt/ok/remoteLabel/uploaded/skipped/failed/bytes/keptRemote/plaintextSkipped/error`；不含远端真实路径/URL/凭据。
  Dashboard `backup.offsite` 只读展示；`offsite_overdue` 告警阈值 `ALERT_OFFSITE_MAX_AGE_HOURS`（默认 48，0 关闭；
  状态文件缺失/未配置不进入条件列表，避免误报）。
- **回滚**：禁用/卸载异地任务即可；已上传副本保留，不影响应用归档主链路。

## 6. 世界备份（Minecraft 世界一致性归档）

Minecraft 世界不在应用数据归档内，由 root 定时器独立备份；旧 `minecraft-backups` cron 已在验收后停用。

### 6.1 Pi 端定时器与脚本

```bash
# 安装/更新 unit 与 timer（root）
sudo install -m 0644 deploy/antifieldcloud-world.service deploy/antifieldcloud-world.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antifieldcloud-world.timer
systemctl list-timers antifieldcloud-world.timer
sudo systemctl start antifieldcloud-world.service    # 手动跑一次验证
cat /var/lib/antifieldcloud/world-backup-status.json
```

- `scripts/backup-world.mjs`（root）读取 `/etc/antifieldcloud/env`、`server.properties` 的 RCON/路径配置；
  预检世界目录、备份目录可写、磁盘余量（1.5× 世界体积）。
- 一致性流程：RCON `save-off` → `save-all flush`（180s 超时、失败重试一次）→ `tar -czf .part`（排除 `session.lock`）
  → gzip 完整性校验 → SHA-256 → 原子改名 `world-<UTC>.tar.gz`；**`save-on` 在 finally 中重试 3 次**，失败时状态 `ok=false`。
- 权限：归档与 `.sha256` 为 0640，属主 `antifieldcloud:antifield`（PC 用户 `antifield` 同组可 scp）；目录 0770（脚本显式 chown，不使用 setgid，避免 systemd `RestrictSUIDSGID` 拒绝）。
- 保留：Pi 侧最多保留最新 4 份（`WORLD_BACKUP_KEEP` 可调）；只删除匹配 `world-<YYYYMMDDTHHMMSSZ>.tar.gz` 的归档与旁文件，
  旧 legacy 命名文件不动；崩溃遗留超过 6 小时的 `.part` 会被清理。PC 拉取校验并 ack 后会删除远端归档，因此 Pi 的 4 份是
  “拉取前暂存”，不是长期异地副本；PC `world\` 才是长期保留（最新 4 份）。
- 状态：写 `/var/lib/antifieldcloud/world-backup-status.json`（0644，原子 rename），字段含
  `lastRunAt/ok/archiveName/sizeBytes/sha256/durationMs/kept/keptCount/error/message/errors/warnings/saveOffOk/saveOnOk/worldBytes`；
  `kept` 是归档名数组，份数看 `keptCount`，且是上次运行时的快照（PC ack 删除后不会实时回写）。
- 失败模式：Minecraft 未运行/RCON 不可达时备份失败并写状态；服务器 `save-off` 期间脚本崩溃时，`save-on` 会重试，
  仍失败则需手动在控制台执行 `save-on`（状态 JSON 会明确提示）。
- 旧世界 cron：验收后从 `antifield` 的 `crontab` 移除 `minecraft-backups` 行；旧归档约 9 GiB 不自动删除，
  按 §6.4 手动清理（清理前确认 PC 有副本）。

### 6.2 Windows 周度世界拉取（用户手动安装任务）

```powershell
# 管理员 PowerShell；参数按实际直连地址/备份根目录填写（脚本在仓库 scripts/ 下，也可自行复制到固定路径）
cd "$env:USERPROFILE\projects\AntifieldComplexx"
.\scripts\world-pull.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"

# 手动创建周任务（示例：每周日 12:00；路径按实际安装位置替换）
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\<user>\projects\AntifieldComplexx\scripts\world-pull.ps1" -PiHost 192.0.2.10 -BackupRoot "%USERPROFILE%\AntifieldCloudBackups"'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 12:00
Register-ScheduledTask -TaskName "AntifieldCloud-World-Pull" -Action $action -Trigger $trigger -Description "AntifieldComplexx 世界备份周度拉取"
```

- `install-backup-task.ps1` **只安装每日应用归档任务**，不会创建世界拉取/演练任务；世界任务由用户手动安装（建议使用仓库路径或复制脚本后固定路径）。

- 两阶段：查询远端 `world-backups` 与 `world-backup-status.json` → 逐个 scp 到 `.part` → 与远端 `.sha256` 比对
  → 原子改名 → 写本地 `.sha256` → 删除远端归档/旁文件（ack）；**校验失败不 ack、不动远端**，退出码 1。
  ack 删除远端是设计语义；Pi 因此只做暂存，长期副本在 PC `world\`。
- 本地保留最新 4 份（只删 `world-<UTC>.tar.gz` 匹配名及孤儿旁文件）；日志
  `%LOCALAPPDATA%\AntifieldCloud\world-pull.log`（>1 MiB 轮转）。
- 状态：写远端 `/var/lib/antifieldcloud/world-pull-status.json`（0644，`sudo install`），字段含
  `lastPullAt/ok/archiveName/archiveNames/pulledCount/sizeBytes/kept/keptCount/pendingRemaining/lastBackupAt/lastBackupOk/error/warnings`；
  `kept` 是本地归档名数组，份数看 `keptCount`。
- 所有 ssh/scp 有硬超时并杀进程树；UTF-8 输出编码统一；`-NoStatusWrite` 可跳过状态写入；失败也会尽量写 `ok=false`。

### 6.3 磁盘与一致性注意

- Pi 世界约 4.1 GiB；`save-off` 窗口内 Minecraft 不落盘，gzip 打包在 Pi 上可能持续数分钟——定时器放在周日 12:00，
  不与玩家高峰重叠。脚本预检要求可用空间 ≥1.5× 世界体积；Pi 需要容纳拉取前的暂存归档，PC 拉取 ack 后会释放，
  仍需定期 `df -h` 确认。
- 世界归档是 tar.gz，恢复前必须停 Minecraft 或先 `save-off`，避免运行中的世界文件与归档混写。
- 世界备份不包含 Paper 配置/插件数据；这些仍由密钥包与应用数据归档覆盖。

### 6.4 旧 cron 迁移与旧归档手动清理

```bash
# 1) 查看并移除旧世界备份 cron 行（保留其它行）
crontab -u antifield -l | grep -v 'minecraft-backups' | crontab -u antifield -
crontab -u antifield -l        # 确认已无 minecraft-backups 行

# 2) 确认 PC 上已有世界副本（world\ 下至少 1 份 world-*.tar.gz）后，清理旧归档
du -sh /home/antifield/minecraft-backups 2>/dev/null || true
sudo ls -lh /home/antifield/minecraft-backups | head
# 确认无误后按日期/大小逐个删除（示例；不要在生产高峰操作）
sudo rm -f /home/antifield/minecraft-backups/world-YYYYMMDD.tar.gz
# 或清理整个旧目录（确认 PC 已有副本且无其它依赖后）
sudo rm -rf /home/antifield/minecraft-backups
```

- 旧归档约 9 GiB，脚本与定时器都不会自动删除；删除前必须确认 PC 世界副本可解包（可用 `tar -tzf` 抽查）。
- 不要删除 `/var/lib/antifieldcloud/world-backups` 下新命名归档（由保留策略管理）；legacy 文件可手工清理。

## 7. 恢复演练（自动化 + 记录）

演练校验 PC 上已拉取的真实归档，只读、不修改/删除归档；建议每季度或升级前执行一次。

```powershell
# 应用归档链 + DB + manifest + 可选世界归档
cd "$env:USERPROFILE\projects\AntifieldComplexx"
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 14
# 需要解包验证世界（先确认临时盘 ≥3× 世界归档体积）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 14 -IncludeWorld
# 将 ASCII 状态回写 Pi（可选；默认不写）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -PiHost 192.0.2.10
```

- 检查项：最新 full + 其后全部 inc、每份 `.sha256` 旁文件与 SHA-256、tar 条目安全（拒绝绝对路径/`..`/反斜杠/控制字符/
  符号链接/设备/白名单前缀）、解包后最新 `db-*.sqlite` 的 `PRAGMA integrity_check`/`foreign_key_check`/`meta.schema_version`、
  manifest `schema/mode/fileCount/totalBytes/since` 与实际内容一致；`-IncludeWorld` 额外校验世界归档 SHA/条目/`world/level.dat`。
- 输出：`%BackupRoot%\drills\<UTC>\report.json` 与 `report.md`；日志 `%LOCALAPPDATA%\AntifieldCloud\drill.log`；
  报告保留 180 天（`-KeepDays` 可调）；任何错误退出码 1。
- 可选写回 `/var/lib/antifieldcloud/drill-status.json`（0644），字段
  `lastRunAt/ok/report/fullArchive/incCount/latestDb/schemaVersion/worldArchive/worldChecked/error/warnings`；
  Dashboard 与 `drill_stale` 告警读取。未安装/未运行时状态为 unknown，不误报“已通过”。
- 手工演练记录表（每次演练后补充；自动化报告路径一并记录）：

| 日期 | 操作人 | 全量归档 | 增量数量 | 最新 DB schema | 世界归档 | 结果 | 报告/备注 |
|---|---|---|---|---|---|---|---|
| 2026-10-25 | 自动演练 | snapshot-20261025T133725908Z-full.tar.gz | 0 | 17 | 通过 | 通过 | drill 报告 `20261025T133743Z`；链连续性/SHA/解包/DB integrity/FK/schema |
| 2026-10-27 | 自动演练 | snapshot-20261025T133725908Z-full.tar.gz | 5 | 17 | 通过 | 通过 | drill 报告 `20261027T061319Z`；首次 `20261027T061021Z` 因 drill-verify 未返回 `details.since` 误报断链，修复后本报告通过；链连续性/SHA/解包/DB integrity/FK/schema/世界归档 |
|  |  |  |  |  |  |  | （下一次演练填写） |

- 未填写记录的“演练通过”声明无效；报告文件与 `.local/DR-DRILL.md` 作为证据保存。

## 8. 恢复（实际命令）

> 恢复前先停止应用；恢复期间不要上传文件。先在临时目录解压、校验，再替换生产数据。
> 应用归档恢复需要约“选择字节 ×2 + 256 MiB”的额外空间（解包 + 落盘），并受 staging 2 GiB/20% 限制。

### 8.1 应用数据（整库离线恢复）

1. **在 PC 上校验归档完整性**（PowerShell）：

```powershell
$root = "$env:USERPROFILE\AntifieldCloudBackups"
$latest = Get-ChildItem $root\weekly -Recurse -Filter *.tar.gz | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$expected = (Get-Content "$($latest.FullName).sha256").Split(' ')[0]
if ((Get-FileHash -Algorithm SHA256 $latest.FullName).Hash.ToLower() -ne $expected) { throw "归档校验失败" }
```

2. **把“最近一次全量 + 其后的全部增量”上传到 Pi**（按文件名时间排序）：

```powershell
scp "$env:USERPROFILE\AntifieldCloudBackups\weekly\<日期>\<full>.tar.gz" antifield@192.0.2.10:/tmp/
scp "$env:USERPROFILE\AntifieldCloudBackups\daily\<日期>\<inc>.tar.gz" antifield@192.0.2.10:/tmp/
```

3. **Pi 上解包并选择最新 DB**：

```bash
sudo systemctl stop antifieldcloud
RESTORE=/tmp/antifieldcloud-restore
rm -rf "$RESTORE" && mkdir -p "$RESTORE"
tar -xzf /tmp/<full>.tar.gz -C "$RESTORE"
for f in /tmp/<inc1>.tar.gz /tmp/<inc2>.tar.gz; do tar -xzf "$f" -C "$RESTORE"; done

# 关键：全量+增量叠加后会有多个 db-*.sqlite，必须按时间取最新一个
LATEST_DB=$(ls -1t "$RESTORE"/backups/db-*.sqlite | head -n 1)
test -n "$LATEST_DB" || { echo "找不到 DB 快照"; exit 1; }
echo "使用 DB 快照：$LATEST_DB"

# 替换数据（保留旧数据以便回退）
sudo mv /var/lib/antifieldcloud /var/lib/antifieldcloud.before-restore
sudo install -d -o antifieldcloud -g antifield -m 0750 /var/lib/antifieldcloud
sudo install -d -o antifieldcloud -g antifieldcloud -m 0700 /var/lib/antifieldcloud/files /var/lib/antifieldcloud/tmp
sudo install -d -o antifieldcloud -g antifield -m 2770 /var/lib/antifieldcloud/backups
# v0.7.3：上下文文档目录（派生数据，不进入备份；缺失时应用启用文档模式会启动失败）
sudo install -d -o antifieldcloud -g opencode -m 2750 /var/lib/antifieldcloud-context
sudo cp "$LATEST_DB" /var/lib/antifieldcloud/db.sqlite
if [ -d "$RESTORE/files" ]; then
  sudo cp -a "$RESTORE/files/." /var/lib/antifieldcloud/files/
fi
sudo chown -R antifieldcloud:antifieldcloud /var/lib/antifieldcloud
sudo chmod 0640 /var/lib/antifieldcloud/db.sqlite
sudo rm -f /var/lib/antifieldcloud/db.sqlite-wal /var/lib/antifieldcloud/db.sqlite-shm

# 启动并验证
sudo systemctl start antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

- `files/` 包含 `origin='note'` 的笔记附件物理内容；恢复整库时一并还原，DB 中的 `note_attachments` 决定其可见性。
  Web 文件级恢复只把 `origin='user'` 的文件恢复到新目录，不会把笔记附件放进云盘。
- 若归档 manifest 标记了 `skippedMissing`，对应文件内容不在归档中；恢复后这些文件仍缺失，下一次增量会尝试补入。

### 8.2 世界数据（手动恢复）

```bash
# 1) 选择最新世界归档并校验（PC 或 Pi 上；PC 副本在 $BackupRoot\world\）
sha256sum -c world-<UTC>.tar.gz.sha256
# 2) 停服（或先 RCON save-off；推荐停服，避免运行中写世界）
sudo systemctl stop minecraft
# 3) 备份当前世界目录
sudo mv /home/antifield/minecraft-server/world /home/antifield/minecraft-server/world.before-restore
# 4) 解包（归档内为 world/ 目录）
sudo tar -xzf world-<UTC>.tar.gz -C /home/antifield/minecraft-server
sudo chown -R antifield:antifield /home/antifield/minecraft-server/world
# 5) 启动并确认玩家/区块正常；确认无误后再删除 world.before-restore
sudo systemctl start minecraft
```

- 世界归档一般含 `session.lock` 之外的完整世界；恢复后首次启动 Paper 会重建锁文件。
- 旧 legacy `world-<YYYYMMDD>.tar.gz` 归档结构相同，可按同样步骤恢复（先校验 SHA/可解包）。

### 8.3 密钥包（需要离线 age 私钥）

```powershell
# PC 上
age -d -i age-secrets.txt -o secrets.tar "$env:USERPROFILE\AntifieldCloudBackups\secrets\<日期>\secrets-<UTC>.tar.age"
tar -xzf secrets.tar -C "$env:TEMP\antifieldcloud-secrets"
# 核对 .sha256 后，把 /etc/antifieldcloud/env、/etc/cloudflared/*、server.properties、opencode env 按原权限放回
```

- 解密在可信机器上做；恢复后检查 `/etc/antifieldcloud/env` 的域名/APP_ORIGIN/COOKIE_DOMAIN 与实际一致（COOKIE_DOMAIN 自 仅用于清理旧父域 Cookie，不再设置新 Cookie）。
- 密钥包不含普通文件内容；文件恢复走 §8.1，世界走 §8.2。

### 8.4 验证清单

1. `/healthz` 返回 `{"ok":true,"version":"0.5.8","schemaVersion":13,...}`，服务 active；`/api/version` 登录后版本一致且 `botsEnabled` 与 env 一致。
2. 登录成功（TOTP 仍有效，因为 DB 快照含用户与 TOTP secret）；恢复码可用。
3. 文件列表数量、随机抽样文件的 SHA-256 与 API `GET /api/files/:id` 的 `sha256` 字段一致；笔记附件可见。
4. 图片/文本/PDF/预览正常，回收站内容与备份时一致；多文件分享/笔记版本可打开。
5. 白名单列表与备份时一致（RCON 可用时）；世界恢复后玩家可进入。
6. 备份 pending/状态正常（`backup.mjs --pending`、`backup-pull.json`、世界/拉取/演练状态文件）。
7. Bot：`/api/bots/status` 可读；若恢复了 Bot，确认 `BOT_SECRET_KEY` 与 DB 快照成对、`/api/bots` 能解密显示 Bot（不显示 Token）；
   `BOT_ENABLED=false` 时 Webhook 仍 404。
8. 确认无误后再删除 `/var/lib/antifieldcloud.before-restore` 与 `world.before-restore`。

> 数据库迁移只向上、无 down 迁移：若回滚到旧 release，务必同时恢复升级前的 `--snapshot-db` 快照
> （部署脚本在切换前生成，路径 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`）。
> schema v13 高于旧程序支持版本时旧程序会拒绝启动，必须先还原快照。

## 9. Web 文件级恢复（不替换运行中的 DB）

Web 只做**文件级恢复**，不替换运行中的 DB 与 `files/`：

1. Settings → 备份与恢复 → 上传归档（≤100 MiB；需要 TOTP）或 scp 到 `DATA_DIR/backups/imports/` 后刷新；
2. 校验归档（流式 SHA-256 + tar 安全扫描）；
3. 恢复向导选择 full+inc 链和文件/目录 → TOTP + 输入 `RESTORE` → 计划 30 分钟有效；
4. 执行后只新建“恢复-<时间>”文件夹，使用新文件 ID，不覆盖原数据；失败会清理未完成内容；
5. `skippedMissing` 文件会从选择中剔除：计划返回 `skippedMissing` 列表；若所选全部缺失返回 400 `invalid_selection`；
   否则其余文件正常恢复，执行结果同样包含 `skippedMissing`（不整体失败）；
6. 整库恢复仍走 §8.1 的离线 root 流程，Web 不提供。

信任边界：归档含 TOTP/会话，导入需要管理员 TOTP；tar 仍按不可信输入处理，不提供归档下载；恢复计划单并发、30 分钟过期；
归档链只在同来源（Pi / Web 导入）内解析，避免跨来源拼出错误父子关系；归档浏览/导入/计划/执行均有独立限流。

## 10. 故障排查

| 现象 | 处理 |
|---|---|
| `--pending` 报 `no such table: backup_archives` | Pi 未跑迁移：重启一次服务或先升级部署；确认代码/schema 为当前 v17 |
| pending 一直不减少 | PC 下载失败：看 `backup.log`；确认直连/SSH；保留 pending 是预期行为，不要手工删 DB 行 |
| `--ack` 报 SHA 不匹配 | 归档损坏/被替换；对比 PC `.sha256`，从 PC 副本重新确认或重新 `--prepare --full` |
| `磁盘空间不足` | 先完成 pending 拉取；清理旧 release/日志；空间预算含 pending+已确认+孤儿+2 GiB；世界备份另需 1.5× 世界体积 |
| `skippedMissing` 非空 | DB 有行但文件缺失（断电/误删）。备份继续、manifest 记录；恢复该文件后下一次增量自动补入；查 `warnings` |
| 密钥备份报 `age 未安装/缺少公钥` | 按 §5 安装 age 并写公钥；文件归档仍可成功，但 `secretsOk` 会为 false，属预期可见状态 |
| `opencode_snapshot_failed` / `opencode 快照目录不可写` | opencode 用户无法访问临时父目录或 DB：检查 `/run/antifieldcloud/secrets-tmp-opencode`（0711）与 `/var/lib/opencode` 权限；密钥包按失败处理（不会生成半成品），修复后重跑 |
| 备份面板超 48h 红色 | 检查计划任务 LastTaskResult、`backup.log`、Pi 直连与 pending 状态 |
| 世界备份状态 ok=false | 看 `/var/lib/antifieldcloud/world-backup-status.json` 的 `error/message`；常见为 RCON 不可达、磁盘不足、save-all 超时；修复后 `sudo systemctl start antifieldcloud-world.service` 重跑 |
| 世界备份超 8 天告警 | timer 未启用/未安装/上次失败；`systemctl list-timers`、`journalctl -u antifieldcloud-world`、smoke 世界状态检查 |
| 世界拉取状态超期/失败 | 检查 Windows 周任务、`world-pull.log`、直连与 Pi 上 `world-backups` 是否有归档；失败不会 ack，可重跑 |
| 世界归档 SHA 不一致 | 归档损坏/下载不完整；删除本地 `.part`/坏归档后重跑 `world-pull.ps1`；不要删除远端归档 |
| 恢复演练报告失败 | 看 `report.json` 的 `errors`：sidecar/链缺失、tar 不安全条目、DB integrity/FK/schema、manifest 不一致；先修备份再演练 |
| 演练状态 unknown | 从未运行或未指定 `-PiHost` 回写；运行 `drill.ps1 -PiHost ...` 或接受 unknown（不误报通过） |
| PC 有旧世界归档占空间 | 旧 cron 已停用；按 §6.4 手动清理，保留至少一份可解包副本 |
| 恢复后登录异常 | 确认恢复的是最新 DB、`/etc/antifieldcloud/env` 的域名与 APP_ORIGIN 一致；COOKIE_DOMAIN 自 仅用于清理旧父域 Cookie，必要时 `bootstrap-env.sh --force`（会沿用现有非敏感值） |
| 恢复后 Bot 显示 `bot_key_missing`/密文不可解密 | `BOT_SECRET_KEY` 与 DB 快照不匹配：从同批密钥包恢复 env，或接受重新录入 Bot Token；不要重置 key 后保留旧 `bots` 行 |
| 密钥包过大/失败但文件归档成功 | 看 `secretsLastError`；`BOT_SECRET_KEY` 在 env 内，env 不可读会导致密钥包失败；修复 `/etc/antifieldcloud/env` 权限 0640 root:antifieldcloud |

## 11. 覆盖、残余风险与限制

- **已覆盖**：应用数据归档（DB + 普通文件）、密钥包（env/cloudflared/Minecraft 配置/opencode env + opencode DB/config 一致性快照，
  env 含 `BOT_SECRET_KEY`）、Minecraft 世界一致性归档（Pi 拉取前暂存最多 4 份、PC ack 删除远端；PC `world\` 长期保留 4 份）、自动化恢复演练；
  可选整包 age 加密与 PC 端异地副本（默认关闭）。
- **未覆盖**：Minecraft 插件/Paper 配置（由密钥包/应用归档部分覆盖）、对象存储；普通归档仍含 TOTP/会话明文与 Bot 凭据密文，
  PC ACL/离线介质是最后防线；age 私钥或 `BOT_SECRET_KEY` 丢失分别导致密钥包/Bot Token 不可恢复。
- **v0.7.3 Bot 上下文文档不进入备份**：`/var/lib/antifieldcloud-context` 为派生数据（角色卡/记忆权威在 DB 与角色卡表），
  不在 `DATA_DIR` 下、不被应用归档 tar 包含；恢复后首轮 Chat 自动重建。该目录含个人记忆文本，权限 0640/0750，不随备份扩散。
- **导入归档保留**：`BACKUP_IMPORT_RETENTION_DAYS`（默认 90，0=永久）控制 Web 导入归档保留；维护任务清理超期
  `origin='import'` 归档（跳过活动恢复计划引用），并清理无 DB 记录的超期导入文件。
- 浏览器导入上限 100 MiB；更大归档用 scp 到 inbox，备份归档导入独立于文件分片上传。
- 世界备份依赖 Minecraft 运行与 RCON；Windows 世界拉取周任务已安装并手动验证；恢复演练保持手动/季度，异地副本保持关闭。
- 恢复演练记录见 §7 与 `.local/DR-DRILL.md`；每次升级前重新演练。

### 本轮明确不修 / 已知残留（DR 系列）

- **DR-1（时钟回拨/同毫秒）**：增量依赖 `created_at > 上次水位`；系统时钟回拨或同一毫秒内的写入仍可能漏备。
  `--prepare` 会对“文件 `created_at` 晚于当前时间/水位倒退”写 `warnings` 与 `clockSkew` 状态，但不会自动修正；依赖 NTP 正常 + 每周全量兜底。
- **DR-7（导入归档无删除/保留策略）**：已由 `BACKUP_IMPORT_RETENTION_DAYS` 控制；活动恢复计划引用的归档不会删除。
- **DR-22（告警跨周期不重投）**：持续 firing 按 `ALERT_REPEAT_HOURS`（默认 24，0=关闭）重发 webhook，状态仍为 firing。
- **DR-23（锁心跳）**：`.backup.lock` 持有期间每 30s 刷新 mtime，超过 1 小时才按陈旧锁接管。
