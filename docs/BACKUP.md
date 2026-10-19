# 备份与恢复（v0.2.x 两阶段协议）

> 目标：SD 卡损坏、误删、升级失败时，能恢复 `/var/lib/antifieldcloud` 的文件与 SQLite 元数据。
> 备份分两种：**数据归档**（DB 快照 + 文件内容，明文，含 TOTP/会话）与**密钥包**（age 加密的 env/云隧道/Minecraft 配置）。
> 归档与密钥包都只允许落在本机或离线介质，不上传公开网盘。

## 1. 策略

- **两阶段**：Pi 端 `--prepare` 生成归档并记为 `pending`；Windows 拉取并校验 SHA-256 后 `--ack` 才推进备份游标。
  PC 未确认前 Pi 不删除 pending 归档，网络/PC 故障不会造成“归档已删但未备份”的数据丢失。
- **频率**：每日一次；建议的“全量”条件为“无已确认全量或最近全量超过 7 天”，由 `--pending` 的
  `needsFull/recommendedMode` 计算，Windows 任务按推荐模式执行（错过的周日会在下一轮补做全量）。
- **增量依据**：文件内容不可变，只备份 `created_at > 上次已确认备份时间` 的新增文件；重命名/移动只改元数据，
  由 DB 快照覆盖。存在未确认 pending 时，增量起点取最新 pending 时间，避免重复打包。
- **保留**：Pi 上 pending 归档一直保留到确认；已确认归档最多 2 个（拉取成功后由 Windows 删除，CLI 兜底清理）。
  PC 保留 30 个 daily 日期目录 + 8 个 weekly 日期目录；密钥包保留 90 天。
- **空间保护**：生成前检查剩余空间（本次估算 + 现有 pending 大小 + 2 GiB），不足则返回 JSON 错误且不生成归档。
- **完整性**：归档 SHA-256 写入 DB 与 PC 的 `.sha256` 旁文件；`--ack` 会再次校验 Pi 上文件；PC 下载后校验后再原子改名。
- **密钥**：归档包含 DB（TOTP secret、会话、恢复码哈希）与文件内容，落盘权限 0640；密钥包使用 age 加密，
  私钥只保存在离线介质。

## 2. 归档结构与协议

```text
snapshot-20261019T100101239Z-full.tar.gz
├── backups/db-20261019T100101239Z.sqlite    # 一致性 DB 快照
├── backups/manifest-20261019T100101239Z.json
└── files/<xx>/<id>                           # 本次新增/全量文件内容
```

`manifest.json` 字段：`schema / createdAt / mode(full|inc) / since / database / files[] / fileCount / totalBytes`。

DB 表 `backup_archives`（迁移 2）记录：`name(PK) / mode / created_at / sha256 / size / file_count / pulled_at / acked_at / deleted_at`。
`backup_state.last_backup_at` 只在 `--ack` 后推进，兼容 v0.1 已有行；v0.2.0 首次拉取会因无已确认全量自动做全量。

## 3. Pi 端命令（以 antifieldcloud 运行）

```bash
CLI="sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/backup.mjs"

$CLI --pending                    # {"ok":true,"count":..,"pending":[..],"needsFull":..,"recommendedMode":"full|inc"}
$CLI --prepare --full             # 生成全量 pending 归档（不推进游标）
$CLI --prepare                    # 生成增量 pending 归档（无历史时自动全量）
$CLI --ack <name> --sha256 <hex>  # 校验后确认拉取、推进游标并清理过旧已确认归档（幂等）
$CLI --snapshot-db                # 仅做一致性 DB 快照（部署/升级前用），输出 {"ok":true,"snapshot":...}
```

- 成功输出单行 JSON；失败 `{ok:false,error}` 且退出码 1。归档权限 0640；DB 快照与清单 0600；`.backup.lock` 超过 1 小时视为陈旧。
- `--ack` 只接受与 DB 记录一致的 SHA-256，且只允许游标前进（乱序 ack 安全）。
- 兼容入口：无参数运行等价于“prepare + 立即 ack”，仅保留给旧脚本/测试，Windows 拉取任务不再使用。

## 4. Windows 计划任务

```powershell
# 管理员 PowerShell；-PiHost/-BackupRoot 会显式写入任务参数（不要再依赖脚本默认占位值）
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
```

- 任务名 `AntifieldCloud-Backup-Pull`；每日 `12:00` + 登录后 10 分钟补跑；电池供电时也运行；仅当前用户登录时运行。
- 安装脚本会：复制 `backup-pull.ps1` 到 `%LOCALAPPDATA%\AntifieldCloud\`；用 `icacls` 把备份目录 ACL 收紧为
  **当前用户 + Administrators + SYSTEM**；安装前做 `PiHost:22` 可达性预检；`-DryRun` 只打印计划不注册任务。
- 拉取流程：`--pending` →（无 pending 才 `--prepare`）→ `.part` 下载 → SHA-256 校验 → 原子改名 → 写
  `<archive>.sha256` → `--ack` → 删除 Pi 归档；失败保留 pending，下一轮重试同一归档，不重复生成。
- 日志：`%LOCALAPPDATA%\AntifieldCloud\backup.log`（超过 1 MiB 自动轮转为 `backup.log.1`）。
- 状态：成功拉取后写 `/var/lib/antifieldcloud/backup-pull.json`，面板“备份”卡片超过 48h 显示红色告警。
- 旧任务 `PiBackUp-Nightly` 保持原样，不修改。

## 5. 密钥包（age 加密）

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

- 打包内容：`/etc/antifieldcloud/env`、`/etc/cloudflared/config.yml`、`/etc/cloudflared/cert.pem`、
  `/etc/cloudflared/<tunnel-uuid>.json`、`/home/antifield/minecraft-server/server.properties`、
  `/etc/opencode/opencode.env`。
- 输出：`/var/lib/antifieldcloud/backups/secrets/secrets-<UTC>.tar.age` + `.sha256`；目录 root:antifield 2750，文件 0640。
- Windows 任务会自动拉取到 `$BackupRoot\secrets\<日期>\` 并写 `.sha256`；Pi 保留最近 2 份，PC 保留 90 天。
- 未安装 age/未配置公钥时只记录警告，不影响文件归档备份。

## 6. 恢复（实际命令）

> 恢复前先停止应用；恢复期间不要上传文件。先在临时目录解压、校验，再替换生产数据。

1. **在 PC 上校验归档完整性**（PowerShell）：

```powershell
$root = "$env:USERPROFILE\AntifieldCloudBackups"
$latest = Get-ChildItem $root\weekly -Recurse -Filter *.tar.gz | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$expected = (Get-Content "$($latest.FullName).sha256").Split(' ')[0]
if ((Get-FileHash -Algorithm SHA256 $latest.FullName).Hash.ToLower() -ne $expected) { throw "归档校验失败" }
```

2. **把“最近一次全量 + 其后的全部增量”上传到 Pi**（按文件名时间排序）：

```powershell
# PC 上（把 <full>、<inc...> 换成实际文件名）
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

4. **恢复密钥包**（需要离线 age 私钥；解密在可信机器上做）：

```powershell
# PC 上
age -d -i age-secrets.txt -o secrets.tar "$env:USERPROFILE\AntifieldCloudBackups\secrets\<日期>\secrets-<UTC>.tar.age"
tar -xzf secrets.tar -C "$env:TEMP\antifieldcloud-secrets"
# 核对 .sha256 后，把 /etc/antifieldcloud/env、/etc/cloudflared/*、server.properties、opencode env 按原权限放回
```

5. **验证清单**：
   1. `/healthz` 返回 `{"ok":true,...}`，服务 active；
   2. 登录成功（TOTP 仍有效，因为 DB 快照含用户与 TOTP secret）；恢复码可用；
   3. 文件列表数量、随机抽样文件的 SHA-256 与 API `GET /api/files/:id` 的 `sha256` 字段一致；
   4. 图片/文本/PDF 预览正常，回收站内容与备份时一致；
   5. 白名单列表与备份时一致（RCON 可用时）；
   6. 备份 pending/状态正常（`backup.mjs --pending`、`/var/lib/antifieldcloud/backup-pull.json`）；
   7. 确认无误后再删除 `/var/lib/antifieldcloud.before-restore`。

> 数据库迁移只向上、无 down 迁移：若回滚到旧 release，务必同时恢复升级前的 `--snapshot-db` 快照
> （部署脚本在切换前生成，路径 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`）。

## 7. 演练记录（每季度或升级前填写）

| 日期 | 操作人 | 全量归档 | 增量数量 | 抽样 SHA-256 | 结果 | 备注 |
|---|---|---|---|---|---|---|
| 2026-10-19 | （首次部署验收） | snapshot-…-full.tar.gz | 2 | 与 DB/PC 一致 | 通过 | v0.2.x 两阶段协议；全量+增量+密钥包已按 §6 解包验证 |

- 演练内容：按 §6 解包最新全量 + 增量到临时目录，核对 `manifest.fileCount` 与 `files/` 数量一致；
  抽查 3 个文件 SHA-256；用 `age -d` 解密一次密钥包并核对 `.sha256`；记录到本表并同步 CHANGELOG。
- 未填写记录的“演练通过”声明无效；当前 v0.2.x 记录见 `docs/ACCEPTANCE.md` 与 `.local/DR-DRILL.md`。

## 8. 安全

- 归档含 DB（用户、TOTP secret、会话、文件元数据）与文件内容；Pi 上 0640，PC 目录 ACL 收紧到当前用户 +
  Administrators + SYSTEM，不要上传公开网盘。
- `/etc/antifieldcloud/env` 不以明文形式进入普通归档；密钥包用 age 加密，私钥离线保存（丢失私钥=无法恢复密钥包）。
- 恢复后建议：设置页“退出全部会话”、重新生成恢复码；怀疑泄露时按 docs/SECURITY.md §5 轮换 RCON/opencode 密码。
- 备份 CLI/任务日志不得输出密码、TOTP、CSRF/Cookie；`--ack` 只记录归档名与 SHA。

## 9. 故障排查

| 现象 | 处理 |
|---|---|
| `--pending` 报 `no such table: backup_archives` | Pi 未跑迁移 2：重启一次服务或先升级部署，确认代码/DB 已是 v0.2.0 |
| pending 一直不减少 | PC 下载失败：看 `backup.log`；确认直连/SSH；保留 pending 是预期行为，不要手工删 DB 行 |
| `--ack` 报 SHA 不匹配 | 归档损坏/被替换；对比 PC `.sha256`，从 PC 副本重新确认或重新 `--prepare --full` |
| `磁盘空间不足` | 先完成 pending 拉取；清理旧 release/日志；空间预算含 pending+2 GiB |
| 密钥备份报 `age 未安装/缺少公钥` | 按 §5 安装 age 并写入 `/etc/antifieldcloud/secrets-age.pub`；不影响普通归档 |
| 备份面板超 48h 红色 | 检查计划任务 LastTaskResult、`backup.log`、Pi 直连与 pending 状态 |
| 恢复后登录异常 | 确认恢复的是最新 DB、`/etc/antifieldcloud/env` 的域名与 APP_ORIGIN/COOKIE_DOMAIN 一致；必要时 `bootstrap-env.sh --force`（会沿用现有非敏感值） |
